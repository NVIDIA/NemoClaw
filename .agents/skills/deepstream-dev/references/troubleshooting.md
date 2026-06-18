# DeepStream Common Errors and Troubleshooting Guide

## Overview

This document provides a quick reference for common errors encountered when developing DeepStream applications, along with their causes and solutions.

---

## Python API Errors

### Error: `RuntimeError: Probe failure` when attaching `measure_fps_probe`

**Symptom**: Pipeline crashes with `RuntimeError: Probe failure` and message `unable to add probe fps-probe`.

**Cause**: The built-in `measure_fps_probe` cannot be attached to sink elements (`nveglglessink`, `nv3dsink`, `filesink`). It can only be attached to processing elements that have both sink and src pads.

**Wrong Code**:
```python
pipeline.attach("sink", "measure_fps_probe", "fps-probe")  # ❌ CRASH - sink has no src pad
```

**Solution**:
```python
# Attach to a processing element instead
pipeline.attach("pgie", "measure_fps_probe", "fps-probe")   # ✅ Works
pipeline.attach("osd", "measure_fps_probe", "fps-probe")     # ✅ Works
```

---

### Error: `TypeError: object of type 'iterator' has no len()`

**Symptom**: Crash when trying to get length of metadata items.

**Cause**: `frame_meta.object_items`, `frame_meta.tensor_items`, and `frame_meta.user_items` return **iterators**, not lists.

**Wrong Code**:
```python
count = len(frame_meta.object_items)  # ❌ CRASH
```

**Solution**:
```python
# Count by iterating
obj_count = 0
for obj in frame_meta.object_items:
    obj_count += 1
    process(obj)

# Or convert to list first (if needed)
objects = list(frame_meta.object_items)
count = len(objects)
```

---

### Error: `pad template "sink_X" not found`

**Symptom**: Pipeline fails to link elements with error about missing pad.

**Cause**: Using literal pad names like `"sink_0"` instead of pad template `"sink_%u"`.

**Wrong Code**:
```python
pipeline.link((f"decoder{i}", "mux"), ("", f"sink_{i}"))  # ❌ FAILS
pipeline.link((f"decoder{i}", "mux"), ("", "sink_0"))     # ❌ FAILS
```

**Solution**:
```python
# Use pad template - GStreamer auto-assigns sink_0, sink_1, etc.
pipeline.link((f"decoder{i}", "mux"), ("", "sink_%u"))  # ✅ CORRECT
```

---

### Error: Data not reaching downstream (Queue appears empty)

**Symptom**: 
- Pipeline runs without errors
- No data reaches Kafka, VLM, or other downstream processing
- Statistics show 0 batches/messages processed

**Cause**: Using `queue.Queue` with `multiprocessing.Process`.

**Wrong Code**:
```python
from multiprocessing import Process
from queue import Queue  # ❌ Wrong queue type

class Processor:
    def __init__(self):
        self.batch_queue = Queue()  # Won't work across processes!
    
    def start(self):
        process = Process(target=self._run, args=(self.batch_queue,))
        process.start()  # Data put in child process never reaches parent
```

**Solution**:
```python
# Option 1: Use multiprocessing.Queue for processes
from multiprocessing import Process, Queue as MPQueue

class Processor:
    def __init__(self):
        self.batch_queue = MPQueue()  # ✅ Works across processes

# Option 2: Use threading instead
import threading
from queue import Queue

class Processor:
    def __init__(self):
        self.batch_queue = Queue()  # ✅ OK for threads
    
    def start(self):
        thread = threading.Thread(target=self._run, args=(self.batch_queue,))
        thread.start()  # Works because threads share memory
```

---

### Error: `ModuleNotFoundError: No module named 'pyservicemaker'` inside virtual environment

**Symptom**: Application crashes on import when run inside a Python virtual environment:
```
from pyservicemaker import Pipeline, Probe, BatchMetadataOperator
ModuleNotFoundError: No module named 'pyservicemaker'
```

**Cause**: `pyservicemaker` is installed system-wide but a standard `python3 -m venv` does **not** inherit system packages. Any DeepStream app run inside such a venv cannot find `pyservicemaker`.

**Solution**: Install `pyservicemaker` (and its `pyyaml` dependency) inside the virtual environment:
```bash
source venv/bin/activate
pip install /opt/nvidia/deepstream/deepstream/service-maker/python/pyservicemaker*.whl pyyaml
```

> **Note for generated READMEs**: When generating setup instructions that create a virtual environment, always include the `pyservicemaker` install step in the venv setup so users don't hit this error.

---

## Configuration Errors

### Error: `Configuration file parsing failed`

**Symptom**: nvinfer fails to load configuration file.

**Common Causes**:

1. **Wrong section name in YAML**:
```yaml
# ❌ WRONG
model:
  onnx-file: /path/to/model.onnx

# ✅ CORRECT
property:
  onnx-file: /path/to/model.onnx
```

2. **Mixing YAML/INI syntax**:
```yaml
# ❌ WRONG (INI syntax in .yml file)
[property]
onnx-file=/path/to/model.onnx

# ✅ CORRECT (YAML syntax)
property:
  onnx-file: /path/to/model.onnx
```

3. **Missing indentation in YAML**:
```yaml
# ❌ WRONG
property:
gpu-id: 0

# ✅ CORRECT
property:
  gpu-id: 0
```

---

### Error: `Model file not found`

**Symptom**: nvinfer cannot find model file.

**Solution**: Verify paths exist and use absolute paths:
```python
import os

# Verify path exists
model_path = "/opt/nvidia/deepstream/deepstream/samples/models/Primary_Detector/resnet18_trafficcamnet_pruned.onnx"
if not os.path.exists(model_path):
    print(f"Model not found: {model_path}")
```

**DeepStream 9.0 Model Locations**:
```
/opt/nvidia/deepstream/deepstream/samples/models/
├── Primary_Detector/
│   └── resnet18_trafficcamnet_pruned.onnx
├── Secondary_VehicleMake/
│   └── resnet18_vehiclemakenet_pruned.onnx
└── Secondary_VehicleTypes/
    └── resnet18_vehicletypenet_pruned.onnx
```

---

### Error: `num-detected-classes mismatch`

**Symptom**: Incorrect detection results or crashes.

**Cause**: `num-detected-classes` doesn't match model output.

**Solution**: Check your model's output and set correctly:
```yaml
property:
  num-detected-classes: 4  # Must match model
  labelfile-path: /path/to/labels.txt  # Should have 4 lines
```

---

## Pipeline Errors

### Error: `Element could not be created`

**Symptom**: Pipeline fails to create GStreamer element.

**Common Causes**:

1. **Missing plugin**: Element not installed
```bash
# Check if element exists
gst-inspect-1.0 nvinfer
```

2. **Wrong element name**:
```python
# ❌ Wrong
pipeline.add("nvv4ldecoder", "decoder")  # Typo

# ✅ Correct
pipeline.add("nvv4l2decoder", "decoder")
```

3. **Missing DeepStream libraries**:
```bash
# Set library path
export LD_LIBRARY_PATH=/opt/nvidia/deepstream/deepstream/lib:$LD_LIBRARY_PATH
```

---

### Error: `Failed to open low-level lib` (Tracker)

**Symptom**: Tracker fails to initialize with error:
```
gstnvtracker: Failed to open low-level lib at /opt/nvidia/deepstream/deepstream/lib/libnvds_nvmultiobjecttracker.so
dlopen error: libmosquitto.so.1: cannot open shared object file: No such file or directory
gstnvtracker: Failed to initialize low level lib.
```

**Cause**: The tracker library requires `libmosquitto` (MQTT client library) as a dependency.

**Solution**: Install the mosquitto library:
```bash
# Ubuntu/Debian
sudo apt-get update
sudo apt-get install -y libmosquitto1

# RHEL/CentOS
sudo yum install mosquitto
```

> **Important**: `libmosquitto1` is the client *library* only. If you also need to run an MQTT broker locally (e.g., `mosquitto &`) or use CLI tools like `mosquitto_sub` / `mosquitto_pub` for testing, you must install **separate** packages:
> ```bash
> sudo apt-get install -y mosquitto           # broker daemon
> sudo apt-get install -y mosquitto-clients   # CLI tools (mosquitto_pub, mosquitto_sub)
> ```

---

### Error: `Command 'mosquitto' not found`

**Symptom**: Running `mosquitto &` to start a local MQTT broker fails:
```
Command 'mosquitto' not found, but can be installed with:
apt install mosquitto
```

**Cause**: The `mosquitto` broker package is separate from `libmosquitto1` (client library). Installing `libmosquitto1` does NOT install the broker.

**Solution**:
```bash
sudo apt-get install -y mosquitto mosquitto-clients
```

---

### Error: `Linking failed between elements`

**Symptom**: Elements cannot be linked.

**Common Causes**:

1. **Incompatible caps**: Format mismatch between elements
```python
# Add videoconvert if formats don't match
pipeline.add("nvvideoconvert", "convert")
pipeline.link("element1", "convert", "element2")
```

2. **Wrong pad names**:
```python
# ❌ Wrong
pipeline.link(("src", "mux"), ("video", "sink"))

# ✅ Correct - check actual pad names
pipeline.link(("src", "mux"), ("", "sink_%u"))
```

---

### Error: `Pipeline stalled` or `No frames received`

**Symptom**: Pipeline starts but no output appears.

**Common Causes**:

1. **Missing queue elements**:
```python
# Add queues after tee
pipeline.add("tee", "tee")
pipeline.add("queue", "queue1")
pipeline.add("queue", "queue2")
pipeline.link(("tee", "queue1"), ("src_%u", ""))
pipeline.link(("tee", "queue2"), ("src_%u", ""))
```

2. **Sync issues with live sources**:
```python
# Disable sync for live streams
pipeline.add("nveglglessink", "sink", {"sync": 0})

# Set live-source on muxer
pipeline.add("nvstreammux", "mux", {"live-source": 1})
```

3. **appsink not emitting signals**:
```python
# Enable signal emission
pipeline.add("appsink", "sink", {"emit-signals": True, "sync": False})
```

---

### Error: `Resource busy` or `Device not found`

**Symptom**: GPU or video device unavailable.

**Solutions**:

1. **Check GPU availability**:
```bash
nvidia-smi
```

2. **Verify correct GPU ID**:
```yaml
property:
  gpu-id: 0  # Use correct GPU ID
```

3. **Check decoder device**:
```bash
ls /dev/nvidia*
```

---

## Memory Errors

### Error: `CUDA out of memory`

**Symptom**: Application crashes with memory error.

**Solutions**:

1. **Reduce batch size**:
```python
pipeline.add("nvstreammux", "mux", {"batch-size": 2})  # Reduce from 8
```

2. **Reduce resolution**:
```python
pipeline.add("nvstreammux", "mux", {
    "batch-size": 4,
    "width": 1280,   # Reduce from 1920
    "height": 720    # Reduce from 1080
})
```

3. **Use FP16 instead of FP32**:
```yaml
property:
  network-mode: 2  # FP16
```

4. **Monitor GPU memory**:
```bash
watch -n 1 nvidia-smi
```

---

### Error: `Buffer corruption` or `Segmentation fault`

**Symptom**: Random crashes when processing buffers.

**Cause**: Not cloning buffer tensors before async processing.

**Wrong Code**:
```python
def consume(self, buffer):
    tensor = buffer.extract(0)  # ❌ Direct use
    # Tensor may be reused/freed by pipeline
```

**Solution**:
```python
def consume(self, buffer):
    tensor = buffer.extract(0).clone()  # ✅ Clone first
    # Now safe for async processing
```

---

## Inference Errors

### Error: `setDimensions` fails with dynamic ONNX model (negative dimensions)

**Symptom**: TensorRT engine build fails immediately with repeated `setDimensions` errors:
```
ERROR: [TRT]: IOptimizationProfile::setDimensions: Error Code 3: API Usage Error
  (Parameter check failed, condition: std::all_of(dims.d, dims.d + dims.nbDims,
  [](int32_t x) noexcept { return x >= 0; }))
ERROR: ../nvdsinfer/nvdsinfer_model_builder.cpp:1263 Explicit config dims is invalid
ERROR: ../nvdsinfer/nvdsinfer_model_builder.cpp:906 Failed to configure builder options
ERROR: ../nvdsinfer/nvdsinfer_model_builder.cpp:595 failed to build trt engine.
```

**Cause**: The ONNX model has **dynamic input shapes** (e.g., exported with `dynamic=True` in Ultralytics, or with dynamic batch/height/width axes). Dynamic dimensions are stored as symbolic names in the ONNX file, which TensorRT reads as `-1`. Without `infer-dims`, nvinfer passes these `-1` values to TensorRT's `setDimensions`, which requires all dimensions to be >= 0.

This is extremely common with models from Ultralytics (YOLO), HuggingFace, and other frameworks that default to dynamic exports.

**Diagnosis** — check if your ONNX model has dynamic dimensions:
```bash
python -c "
import onnx
m = onnx.load('model.onnx')
for inp in m.graph.input:
    dims = []
    for d in inp.type.tensor_type.shape.dim:
        dims.append(d.dim_param if d.dim_param else d.dim_value)
    print(f'{inp.name}: {dims}')
"
# If output shows symbolic names like 'batch', 'height', 'width' → dynamic model
# If output shows integers like [1, 3, 640, 640] → static model (infer-dims not needed)
```

**Solution**: Add `infer-dims` to the nvinfer config with the concrete C;H;W dimensions:

```yaml
# YAML format
property:
  onnx-file: model.onnx
  infer-dims: 3;640;640  # C;H;W — concrete dimensions for the dynamic input
```

```ini
# INI format
[property]
onnx-file=model.onnx
infer-dims=3;640;640
```

> **Note**: The batch dimension is handled by `batch-size` — `infer-dims` only specifies C;H;W. Delete any stale `.engine` files after adding `infer-dims` so TensorRT rebuilds the engine with the correct optimization profile.

---

### Error: `TensorRT engine build failed` (general)

**Symptom**: First-time model loading takes long then fails.

**Solutions**:

1. **Check for dynamic ONNX dimensions first** (see `setDimensions` error above)

2. **Check ONNX model compatibility**:
```bash
# Verify ONNX model
python -c "import onnx; onnx.checker.check_model('model.onnx')"
```

3. **Provide pre-built engine file**:
```yaml
property:
  model-engine-file: /path/to/model.engine
```

4. **Check CUDA/TensorRT versions**:
```bash
# Engine must match installed TensorRT version
nvcc --version
dpkg -l | grep tensorrt
```

---

### Error: `Output layer not found`

**Symptom**: Custom postprocessing can't find expected output layers.

**Solution**: List actual output layers:
```python
def handle_metadata(self, batch_meta):
    for frame_meta in batch_meta.frame_items:
        for tensor_meta in frame_meta.tensor_items:
            layers = tensor_meta.as_tensor_output().get_layers()
            print(f"Available layers: {list(layers.keys())}")
            # Use actual layer names
```

---

### Error: `Secondary GIE not processing`

**Symptom**: Secondary inference not running on detected objects.

**Causes and Solutions**:

1. **Wrong process-mode**:
```yaml
property:
  process-mode: 2  # Must be 2 for secondary
```

2. **Wrong operate-on-gie-id**:
```yaml
property:
  process-mode: 2
  operate-on-gie-id: 1  # Must match primary GIE unique-id
```

3. **Wrong operate-on-class-ids**:
```yaml
property:
  process-mode: 2
  operate-on-gie-id: 1
  operate-on-class-ids: 0  # Must match class IDs from primary
```

---

## Display Errors

### Error: `Could not open display`

**Symptom**: Rendering fails on headless systems.

**Solution**: Use fakesink for headless operation:
```python
# Check if display is available
import os
if "DISPLAY" not in os.environ:
    pipeline.add("fakesink", "sink")
else:
    pipeline.add("nveglglessink", "sink")
```

Or use file output:
```python
pipeline.add("nvvideoconvert", "convert")
pipeline.add("nvv4l2h264enc", "encoder")
pipeline.add("h264parse", "parser")
pipeline.add("mp4mux", "mux")
pipeline.add("filesink", "sink", {"location": "output.mp4"})
```

---

### Error: `Platform not supported`

**Symptom**: Sink element fails on Jetson or x86.

**Solution**: Use platform-specific sink:
```python
import platform

if platform.processor() == "aarch64":
    # Jetson
    pipeline.add("nv3dsink", "sink")
else:
    # x86
    pipeline.add("nveglglessink", "sink")
```

---

## Kafka/Message Broker Errors

### Error: `unable to open shared library` / `Failed to start` (missing librdkafka)

**Symptom**: Any pipeline using `nvmsgbroker` with the Kafka protocol adapter fails at startup:
```
WARN nvmsgbroker gstnvmsgbroker.cpp:404:legacy_gst_nvmsgbroker_start:<msgbroker> error: unable to open shared library
WARN basesink gstbasesink.c:5906:gst_base_sink_change_state:<msgbroker> error: Failed to start
Unable to set the pipeline to the playing state.
```

**Cause**: DeepStream's Kafka protocol adapter (`libnvds_kafka_proto.so`) dynamically links against `librdkafka.so.1`, which is **NOT** bundled with the DeepStream SDK and not installed by default.

**Diagnosis**:
```bash
ldd /opt/nvidia/deepstream/deepstream/lib/libnvds_kafka_proto.so | grep "not found"
# Output: librdkafka.so.1 => not found
```

**Solution**:
```bash
sudo apt-get install -y librdkafka-dev
```

> **Note**: This is different from the "unable to connect to broker library" error below, which is caused by wrong connection string format. This error is about a missing system library.

---

### Error: `unable to connect to broker library` / `Failed to start`

**Symptom**: Pipeline fails with error:
```
WARN nvmsgbroker: error: unable to connect to broker library
WARN basesink: error: Failed to start
Unable to set the pipeline to the playing state.
```

**Cause**: Wrong connection string format. DeepStream uses **semicolon (`;`)** separator, NOT colon (`:`).

**Wrong Code**:
```python
# ❌ WRONG - colon separator
pipeline.add("nvmsgbroker", "msgbroker", {
    "conn-str": "localhost:9092",  # Wrong!
    # ...
})
```

**Solution**:
```python
# ✅ CORRECT - semicolon separator
pipeline.add("nvmsgbroker", "msgbroker", {
    "conn-str": "localhost;9092",  # Correct: use semicolon
    # ...
})
```

---

### Error: No messages reaching Kafka (pipeline runs but no output)

**Symptom**: 
- Pipeline runs without errors
- Kafka consumer receives no messages
- No error in logs

**Cause**: `nvmsgconv` requires `NvDsEventMsgMeta` by default (`msg2p-newapi=0`), which is **NOT automatically generated** by inference or tracker plugins. Without either (a) setting `msg2p-newapi: True` or (b) attaching a probe that generates `EventMessageUserMetadata`, nvmsgconv silently produces zero messages.

**Wrong Code**:
```python
# ❌ Without msg2p-newapi AND without EventMessageUserMetadata probe,
# nvmsgconv has no input and produces no messages!
pipeline.add("nvmsgconv", "msgconv", {
    "config": msgconv_config,
    "payload-type": 0
})
```

**Solution A** (simple): Set `msg2p-newapi: True` to use the new API that reads directly from `NvDsObjectMeta`:
```python
# ✅ CORRECT - msg2p-newapi reads from NvDsObjectMeta directly
pipeline.add("nvmsgconv", "msgconv", {
    "config": msgconv_config,
    "payload-type": 0,
    "msg2p-newapi": True,  # CRITICAL: Enables direct object metadata reading
    "frame-interval": 30   # Send message every 30 frames
})
```

**Solution B** (legacy): Keep `msg2p-newapi: 0` and attach a probe to generate `EventMessageUserMetadata`:
```python
# Option B1: Use built-in probe (simplest)
pipeline.attach("osd", "add_message_meta_probe", "metadata generator")

# Option B2: Custom EventMessageGenerator (for multi-camera / custom sensor mappings)
from pyservicemaker import Probe, BatchMetadataOperator

class EventMessageGenerator(BatchMetadataOperator):
    def __init__(self, sensor_map, labels):
        super().__init__()
        self._sensor_map = sensor_map
        self._labels = labels

    def handle_metadata(self, batch_meta, frame_interval=1):
        for frame_meta in batch_meta.frame_items:
            for object_meta in frame_meta.object_items:
                event_msg = batch_meta.acquire_event_message_meta()
                if event_msg:
                    source_id = frame_meta.source_id
                    sensor_info = self._sensor_map.get(source_id)
                    sensor_id = sensor_info.sensor_id if sensor_info else "N/A"
                    uri = sensor_info.uri if sensor_info else "N/A"
                    event_msg.generate(object_meta, frame_meta, sensor_id, uri, self._labels)
                    frame_meta.append(event_msg)

# Attach UPSTREAM of nvmsgconv
pipeline.attach("tracker", Probe("event_msg_gen", EventMessageGenerator(sensor_map, labels)))
```

**Reference samples**:
- Built-in probe: `/opt/nvidia/deepstream/deepstream/service-maker/sources/apps/python/pipeline_api/deepstream_test4_app/deepstream_test4.py`
- Custom generator: `/opt/nvidia/deepstream/deepstream/service-maker/sources/apps/python/pipeline_api/deepstream_test5_app/deepstream_test5.py`

---

### Error: `nvmsgbroker: Failed to send message`

**Symptom**: Messages not reaching Kafka.

**Solutions**:

1. **Check connection string format** (semicolon, not colon):
```python
pipeline.add("nvmsgbroker", "msgbroker", {
    "conn-str": "localhost;9092",  # Use semicolon separator!
    # ...
})
```

2. **Verify Kafka is running**:
```bash
# Check Kafka
kafka-topics.sh --list --bootstrap-server localhost:9092
```

3. **Check protocol library path**:
```python
pipeline.add("nvmsgbroker", "msgbroker", {
    "proto-lib": "/opt/nvidia/deepstream/deepstream/lib/libnvds_kafka_proto.so",
    # ...
})
```

---

### Error: `nvmsgbroker cannot have downstream elements`

**Symptom**: Pipeline fails when linking elements after nvmsgbroker.

**Cause**: nvmsgbroker is a **sink** element.

**Wrong Code**:
```python
# ❌ Wrong - msgbroker is a sink
pipeline.link("tracker", "msgconv", "msgbroker", "osd", "sink")
```

**Solution**: Use tee to split pipeline:
```python
# ✅ Correct - use tee to split
pipeline.add("tee", "tee")
pipeline.add("queue", "queue_msg")
pipeline.add("queue", "queue_video")

pipeline.link("tracker", "tee")
pipeline.link(("tee", "queue_msg"), ("src_%u", ""))
pipeline.link("queue_msg", "msgconv", "msgbroker")
pipeline.link(("tee", "queue_video"), ("src_%u", ""))
pipeline.link("queue_video", "osd", "sink")
```

---

## Debugging Tips

### Enable GStreamer Debug Output

```bash
# Basic debugging
export GST_DEBUG=3

# Plugin-specific debugging
export GST_DEBUG=nvinfer:5,nvstreammux:4

# Write to file
export GST_DEBUG_FILE=debug.log
```

### Debug Levels

| Level | Name | Description |
|-------|------|-------------|
| 0 | NONE | No output |
| 1 | ERROR | Errors only |
| 2 | WARNING | Warnings and errors |
| 3 | INFO | Informational messages |
| 4 | DEBUG | Debug messages |
| 5 | LOG | All log messages |

### Check Plugin Availability

```bash
# List all DeepStream plugins
gst-inspect-1.0 | grep nv

# Check specific plugin
gst-inspect-1.0 nvinfer
gst-inspect-1.0 nvstreammux
gst-inspect-1.0 nvtracker
```

### Pipeline Visualization

```bash
# Generate pipeline graph
export GST_DEBUG_DUMP_DOT_DIR=/tmp/dots
# Run pipeline, then:
dot -Tpng /tmp/dots/*.dot > pipeline.png
```

---

## Quick Reference: Error → Solution

| Error | Quick Fix |
|-------|-----------|
| `iterator has no len()` | Iterate to count, don't use `len()` |
| `pad template not found` | Use `"sink_%u"` not `"sink_0"` |
| Queue data loss | Use `multiprocessing.Queue` with `Process` |
| Config parse failed | Use `property:` not `model:` in YAML |
| `is-classifier` deprecation warning | Use `network-type: 1` instead of `is-classifier: 1`; omit both for detectors |
| `min-boxes` unknown key warning | Use `minBoxes` (camelCase), not `min-boxes` |
| `setDimensions` negative dims / engine build failed | Add `infer-dims=C;H;W` for dynamic ONNX models (e.g., `infer-dims=3;640;640`) |
| Model not found | Use absolute paths, verify file exists |
| Element not created | Check plugin name, set `LD_LIBRARY_PATH` |
| Link failed | Add `nvvideoconvert` for format conversion |
| Pipeline stalled | Add queues, check sync settings |
| CUDA OOM | Reduce batch size, use FP16 |
| Buffer corruption | Clone tensors before async use |
| Secondary GIE inactive | Set `process-mode: 2`, check `operate-on-gie-id` |
| No display | Use `fakesink` for headless |
| Kafka connection failed | Use `localhost;9092` (semicolon, not colon) |
| Kafka no messages | Set `msg2p-newapi: True`, OR attach `EventMessageUserMetadata` probe (see Kafka section) |
| msgbroker downstream | Use `tee` to split pipeline |
| Dynamic source stuck in PAUSED | Set `async: 0` on sink element |
| No data from RTSP | Test URL with ffplay, check credentials |
| `No module named 'pyservicemaker'` in venv | `pip install /opt/nvidia/deepstream/deepstream/service-maker/python/pyservicemaker*.whl pyyaml` inside the venv |

---

## Dynamic Source Management Errors

### Error: Stream added but stuck in PAUSED state

**Symptom**: REST API returns success, `DynamicSourceMessage` received, but video doesn't display. Elements stay in PAUSED state.

```
[Pipeline] src -> READY
[Pipeline] src -> PAUSED
# Never transitions to PLAYING
```

**Cause**: Missing `async=0` on sink element. The sink waits for preroll (first buffer) before allowing state transitions, creating a deadlock.

**Solution**:
```python
# ✅ CORRECT - async=0 is CRITICAL for dynamic sources
pipeline.add("nveglglessink", "sink", {
    "sync": 0,
    "qos": 0,
    "async": 0  # This is the fix
})

# ❌ WRONG - Will cause state transition deadlock
pipeline.add("nveglglessink", "sink", {"sync": 0})
```

---

### Error: No data from source, reconnection attempts

**Symptom**:
```
WARNING from dsnvurisrcbin0: No data from source since last 10 sec. Trying reconnection
Could not send message. (Received end-of-file)
```

**Cause**: RTSP connection issue - invalid URL, authentication required, or network problem.

**Solutions**:
1. Test RTSP URL directly:
```bash
ffplay "rtsp://camera-ip/stream"
```

2. Include credentials in URL:
```
rtsp://username:password@camera-ip/stream
```

3. Try TCP-only mode:
```python
"select-rtp-protocol": 4  # TCP only instead of auto
```

---

### Anti-Pattern: Custom REST Server for Stream Management

**❌ WRONG**: Implementing a separate Flask/FastAPI server for stream management.

```python
# Don't do this - adds complexity and potential bugs
from flask import Flask
app = Flask(__name__)

@app.route('/add-camera')
def add_camera():
    # Custom implementation
```

**✅ CORRECT**: Use nvmultiurisrcbin's built-in REST server.

```python
pipeline.add("nvmultiurisrcbin", "src", {
    "port": 9000,  # Built-in REST API at http://localhost:9000/api/v1/
    # ...
})
```

See `rest_api_dynamic.md` for complete REST API documentation.

---

## Related Documentation

- **GStreamer Plugins Overview**: `gstreamer_plugins.md`
- **Service Maker Python API**: `service_maker_api.md`
- **Best Practices**: `best_practices.md`
- **nvinfer Configuration**: `nvinfer_config.md`
- **Tracker Configuration**: `tracker_config.md`
