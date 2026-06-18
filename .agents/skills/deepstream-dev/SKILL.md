---
name: deepstream-dev
description: NVIDIA DeepStream SDK 9.0 development with Python pyservicemaker API. Use when building video analytics pipelines, GStreamer-based video processing, TensorRT inference integration, object detection/tracking, or Kafka/message broker integration.
owner: NVIDIA CORPORATION
service: deepstream
version: 1.1.0
reviewed: 2026-04-24
license: CC-BY-4.0 AND Apache-2.0
---

# DeepStream Development Skill

When this skill is active, **ALWAYS read the relevant reference documents** before generating code. Do NOT rely on memory - the reference documents contain critical details about exact property names, correct API usage, and common pitfalls.

## SDK and Architecture Quick Reference

### DeepStream SDK 9.0 Version Requirements

- **GStreamer**: 1.24.2
- **NVIDIA Driver**: 590+
- **CUDA**: 13.1
- **TensorRT**: 10.14.1.48
- **Platforms**: Ubuntu 24.04 (x86_64 and ARM64/Jetson)

### Typical Pipeline Flow

```
Source → Stream Muxer → Inference → [Tracker] → OSD → Renderer
```
Components in `[brackets]` are **optional** -- only add them when the user explicitly requests them.

| Stage | Role | Key Element(s) | Required? |
|-------|------|-----------------|-----------|
| Source | Input from files, RTSP, cameras | `nvurisrcbin` (preferred), `nvmultiurisrcbin`, `filesrc` | Yes |
| Stream Muxer | Batches streams for inference | `nvstreammux` | Yes |
| Inference | TensorRT model execution | `nvinfer`, `nvinferserver` | Yes |
| Tracker | Multi-object tracking across frames | `nvtracker` | **Only if requested** |
| OSD | Draws bounding boxes, labels, overlays | `nvosdbin` | Yes (for visualization) |
| Renderer | Display or save output | `nveglglessink`, `nv3dsink`, `filesink` | Yes |

### Memory Model

DeepStream uses NVIDIA Video Memory Manager (NVMM) for zero-copy GPU buffer transfers. Caps strings use `memory:NVMM` to indicate GPU memory (e.g., `video/x-raw(memory:NVMM), format=NV12`).

## Critical Rules

1. **Only Add Requested Components**: Do NOT add pipeline elements the user did not ask for.
   - **Tracker (`nvtracker`)**: Only add when the user explicitly requests tracking or object IDs across frames
   - **Secondary GIEs**: Only add when the user requests classification or attribute extraction
   - **Analytics (`nvdsanalytics`)**: Only add when the user requests line crossing, ROI counting, etc.
   - **Message broker (`nvmsgbroker`/`nvmsgconv`)**: Only add when the user requests Kafka/cloud messaging
   - When in doubt, build the **minimal working pipeline** and let the user ask for additions

2. **Default to `nvurisrcbin` for Sources**: When the user says "camera", "stream", "video", or provides a file path:
   - Always use `nvurisrcbin` -- it handles RTSP, HTTP, and local files (`file://`) transparently
   - Only use `filesrc` + `qtdemux` + parser when the user explicitly needs raw file source control
   - For RTSP/live sources, also set `live-source=1` on `nvstreammux` and `sync=0` on the sink
   - Convert local paths to URI: `"file://" + os.path.abspath(path)`

3. **Metadata Iteration**: Use `.frame_items` and `.object_items` (returns iterators, NOT lists)
   - NEVER use `len()` on these - iterate to count
   - Iterator can only be consumed once

4. **Request Pad Syntax**: Use `"sink_%u"` template, NEVER literal pad names
   ```python
   pipeline.link(("decoder", "mux"), ("", "sink_%u"))  # CORRECT
   # pipeline.link(("decoder", "mux"), ("", "sink_0"))  # WRONG - will fail
   ```

5. **Platform Detection for Sinks**:
   ```python
   import platform
   sink_type = "nv3dsink" if platform.processor() == "aarch64" else "nveglglessink"
   ```

6. **Buffer Cloning**: Always clone buffers for async processing
   ```python
   tensor = buffer.extract(0).clone()  # CRITICAL
   ```

7. **Queue Types**:
   - `queue.Queue` → Use with `threading.Thread`
   - `multiprocessing.Queue` → Use with `multiprocessing.Process`
   - Using wrong type causes silent data loss!

8. **nvinfer Config Format**:
   - YAML: Use `property:` section (NOT `model:`), `key: value` with space after colon
   - INI: Use `[property]` section, `key=value` with equals sign
   - Section MUST be named `property`

9. **nvmsgbroker is a SINK**: Cannot have downstream elements - use `tee` to split pipeline

10. **ALL Sinks Need async=0 for Tee Splits or Dynamic Sources**: CRITICAL for state transitions
    ```python
    # When using tee splits OR dynamic sources, ALL sinks MUST have async=0
    pipeline.add("nveglglessink", "sink", {
        "sync": 0, "qos": 0,
        "async": 0  # CRITICAL - prevents state transition deadlock
    })
    ```
    **Symptom if missing**: Pipeline stays in PAUSED state, no video displays.

11. **Built-in Probe Attachment**: `measure_fps_probe` can only be attached to processing elements (e.g., `nvinfer`, `nvosdbin`), **NOT** to sink elements. Attaching to a sink raises `RuntimeError: Probe failure`.

12. **Dynamic ONNX Models Require `infer-dims`**: When the ONNX model has dynamic input shapes (e.g., exported with `dynamic=True` in Ultralytics YOLO, or with dynamic batch/height/width axes), you **MUST** add `infer-dims=C;H;W` to the nvinfer config. Without it, TensorRT sees `-1` for dynamic dimensions and fails with `setDimensions: Error Code 3`. Common values:
    - YOLO models (640 input): `infer-dims=3;640;640`
    - Models with 416 input: `infer-dims=3;416;416`
    - Models with 1280 input: `infer-dims=3;1280;1280`

13. **Ultralytics YOLO Output Format Depends on Model Generation** — newer models (v10+/v26+) output post-NMS results; older models (v8/v11) output raw pre-NMS tensors. The custom parser and `cluster-mode` **must** match the actual output:

   | Model generation | Output tensor shape | Fields | `cluster-mode` |
   |------------------|--------------------|---------------------------------|----------------|
   | v8 / v11 | `[batch, 84, 8400]` | `[features(4+80), anchors]` — raw cx/cy/w/h + class scores, no NMS | `2` (NMS) |
   | v10 / v26+ | `[batch, 300, 6]` | `[max_det, (x1,y1,x2,y2,conf,cls)]` — already post-NMS, pixel coords | `4` (none) |

   **How to identify at runtime**: log `inferDims.d[0]` and `inferDims.d[1]` inside the custom parser.
   - `d={84, 8400}` → pre-NMS (v8/v11 style)
   - `d={300, 6}` → post-NMS (v10/v26+ style)

   **Symptom of mismatch**: If `cluster-mode: 2` is used with a post-NMS `[N, 6]` output, bounding boxes appear shifted by 45° or 135° from the actual objects (DeepStream's NMS incorrectly re-processes already-final coordinates).
   If you see tilted or rotated boxes, also check the OBB / `rotation_angle` note in `references/nvinfer_config.md`: for non-OBB models, value-initialize `NvDsInferObjectDetectionInfo` with `obj{}` and keep `rotation_angle = 0`; plain `NvDsInferObjectDetectionInfo obj;` leaves fields uninitialized.

14. **Virtual Environment Must Include pyservicemaker**: `pyservicemaker` is installed system-wide but is NOT accessible from a standard Python virtual environment. When a task requires a venv (e.g., for model download/conversion pip dependencies), **always install `pyservicemaker` and `pyyaml` inside the venv**. The venv setup in generated code and README must always include:
    ```bash
    python3 -m venv venv
    source venv/bin/activate
    pip install /opt/nvidia/deepstream/deepstream/service-maker/python/pyservicemaker*.whl pyyaml
    pip install -r requirements.txt  # other dependencies
    ```
    **Symptom if missing**: `ModuleNotFoundError: No module named 'pyservicemaker'` when running the app inside the venv.

## Key Paths (DeepStream 9.0)

- Models: `/opt/nvidia/deepstream/deepstream/samples/models/`
- Primary Detector: `/opt/nvidia/deepstream/deepstream/samples/models/Primary_Detector/resnet18_trafficcamnet_pruned.onnx`
- Tracker lib: `/opt/nvidia/deepstream/deepstream/lib/libnvds_nvmultiobjecttracker.so`
- Kafka lib: `/opt/nvidia/deepstream/deepstream/lib/libnvds_kafka_proto.so`
- Sample configs: `/opt/nvidia/deepstream/deepstream/samples/configs/deepstream-app/`

## Reference Documents

**IMPORTANT**: Always read these documents for complete details. Do NOT generate code from memory.

| Document | Use When |
|----------|----------|
| [references/gstreamer_plugins.md](references/gstreamer_plugins.md) | Looking up plugin properties, ALL properties listed |
| [references/service_maker_api.md](references/service_maker_api.md) | Using Pipeline/Flow API, metadata access, probes, EventMessageUserMetadata |
| [references/use_cases_pipelines.md](references/use_cases_pipelines.md) | Building pipelines: simple playback, multi-inference, cascaded GIE |
| [references/kafka_messaging.md](references/kafka_messaging.md) | Kafka/message broker setup, nvmsgconv/nvmsgbroker config, msg2p-newapi |
| [references/best_practices.md](references/best_practices.md) | Design patterns, common pitfalls, anti-patterns |
| [references/buffer_apis.md](references/buffer_apis.md) | BufferProvider/Feeder (injection), BufferRetriever/Receiver (extraction) |
| [references/media_extractor_advanced.md](references/media_extractor_advanced.md) | MediaExtractor, MediaChunk, FrameSampler |
| [references/utilities_config.md](references/utilities_config.md) | PerfMonitor, EngineFileMonitor, SourceConfig, SensorInfo, SmartRecordConfig |
| [references/nvinfer_config.md](references/nvinfer_config.md) | nvinfer config file format, ALL parameters |
| [references/tracker_config.md](references/tracker_config.md) | nvtracker config, NvDCF/IOU/DeepSORT/NvSORT |
| [references/troubleshooting.md](references/troubleshooting.md) | Error messages and solutions |
| [references/rest_api_dynamic.md](references/rest_api_dynamic.md) | REST API, dynamic source add/remove, nvmultiurisrcbin |
| [references/metamux_config.md](references/metamux_config.md) | nvdsmetamux config, parallel multi-model inference, metadata merging, source ID filtering |
| [references/docker_containers.md](references/docker_containers.md) | Docker images, Dockerfile examples, pyservicemaker install, container run commands |

## Quick Error Reference

| Error | Solution |
|-------|----------|
| `iterator has no len()` | Iterate to count, don't use `len()` |
| `pad template not found` | Use `"sink_%u"` not `"sink_0"` |
| Queue data loss | Use `multiprocessing.Queue` with `Process` |
| Config parse failed | Use `property:` not `model:` in YAML |
| `is-classifier` deprecation warning | Use `network-type: 1` instead of `is-classifier: 1` for classifiers; omit both for detectors |
| `min-boxes` unknown key warning | Use `minBoxes` (camelCase) in `class-attrs-*` sections, not `min-boxes` |
| Secondary GIE inactive | Set `process-mode: 2`, check `operate-on-gie-id` |
| Tee/dynamic source stuck PAUSED | Set `async: 0` on **ALL** sink elements |
| RTSP no data/reconnecting | Test URL with ffplay, check credentials |
| `RuntimeError: Probe failure` | `measure_fps_probe` cannot attach to sink elements; use `nvinfer` or `nvosdbin` instead |
| `setDimensions` negative dims / engine build failed | Add `infer-dims=C;H;W` for dynamic ONNX models (e.g., `infer-dims=3;640;640`) |
| `No module named 'pyservicemaker'` in venv | `pip install /opt/nvidia/deepstream/deepstream/service-maker/python/pyservicemaker*.whl pyyaml` inside the venv |
| `AttributeError: object has no attribute 'obj_label'` | Use `obj_meta.label` not `obj_meta.obj_label` in pyservicemaker (C API name differs from Python binding) |

<!-- Signing refresh marker.  -->
