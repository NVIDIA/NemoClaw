# DeepStream GStreamer Plugins Overview

## Introduction

DeepStream provides a comprehensive set of custom GStreamer plugins optimized for NVIDIA GPUs. These plugins handle video decoding, inference, tracking, visualization, and various other video analytics tasks. Understanding these plugins is crucial for building effective DeepStream applications.

## Plugin Categories

### Source Plugins
Plugins that generate or capture video data from various sources.

### Processing Plugins
Plugins that transform, analyze, or process video data.

### Sink Plugins
Plugins that output video to displays, files, or network destinations.

---

## Source Plugins

### nvv4l2decoder
**Purpose**: Hardware-accelerated video decoder using NVIDIA V4L2 API (from nvvideo4linux2 plugin)

**Key Properties**:
- `capture-io-mode`: Capture I/O mode for the sink pad (`auto`, `mmap`, `dmabuf-import`)
- `output-io-mode`: Output I/O mode for the src pad (`auto`, `mmap`, `dmabuf-import`)
- `cudadec-memtype`: CUDA buffer memory type (`memtype_device`, `memtype_pinned`, `memtype_unified`)
- `gpu-id`: GPU device ID used for decoding
- `drop-frame-interval`: Interval for dropping frames (0 keeps all frames)
- `num-extra-surfaces`: Additional decode surfaces to allocate
- `disable-dpb`: Disable DPB buffers to reduce latency
- `low-latency-mode`: Enable low-latency decoding for I/IPPP streams
- `skip-frames`: Frame skipping policy (`decode_all`, `decode_non_ref`, `decode_key`)
- `device`: Decoder device path (read-only, default `/dev/nvidia0`)

**Usage**:
```bash
nvv4l2decoder output-io-mode=0 drop-frame-interval=0
```

**Common Pipeline Pattern**:
```
h264parse ! nvv4l2decoder ! ...
```

**Output Format**:
- Outputs `video/x-raw(memory:NVMM)` - GPU memory format
- This is already in NVMM format, so NO nvvideoconvert is needed before nvstreammux

**Notes**:
- Essential for GPU-accelerated pipelines
- Supports H.264, H.265, VP8, VP9 codecs with zero-copy memory transfers
- Output is already in NVMM memory, compatible with nvstreammux and other DeepStream plugins

---

### nvurisrcbin
**Purpose**: Source bin for handling URI-based sources (files, RTSP, HTTP)

**Key Properties**:
- `uri`: Source URI (file://, rtsp://, http://, etc.)
- `num-buffers`: Number of buffers to process
- `drop-on-latency`: Drop frames on latency

**Usage**:
```bash
nvurisrcbin uri=file:///path/to/video.mp4
```

**Common Pipeline Pattern**:
```
nvurisrcbin uri=rtsp://camera-ip/stream ! ...
```

**Notes**:
- Automatically handles demuxing and parsing for multiple protocols and formats

---

### nvmultiurisrcbin
**Purpose**: Source bin with built-in REST API server for dynamic multi-stream management

**Key Properties**:
| Property | Type | Description |
|----------|------|-------------|
| `uri-list` | string | Comma-separated list of initial URIs |
| `sensor-id-list` | string | Comma-separated sensor IDs (maps 1:1 with uri-list) |
| `sensor-name-list` | string | Comma-separated sensor names |
| `ip-address` | string | REST API server IP (default: localhost) |
| `port` | int | REST API server port (default: 9000, 0 to disable) |
| `max-batch-size` | int | Maximum number of sources |
| `batched-push-timeout` | int | Timeout in microseconds to push batch |
| `live-source` | int | Set to 1 for live/dynamic sources (REQUIRED) |
| `drop-pipeline-eos` | int | Set to 1 to keep pipeline alive when sources removed |
| `async-handling` | int | Set to 1 for async state changes |
| `select-rtp-protocol` | int | 0=UDP+TCP auto, 4=TCP only |
| `latency` | int | Jitterbuffer size in ms for RTSP |

**Built-in REST API Endpoints**:
- `POST /api/v1/stream/add` - Add a stream dynamically
- `POST /api/v1/stream/remove` - Remove a stream
- `GET /api/v1/stream/get-stream-info` - Get current streams

**Usage**:
```python
# Pipeline with built-in REST server on port 9000
pipeline.add("nvmultiurisrcbin", "src", {
    "port": 9000,
    "max-batch-size": 16,
    "live-source": 1,
    "drop-pipeline-eos": 1,
    "async-handling": 1,
})
# REST API automatically available at http://localhost:9000/api/v1/
```

**⚠️ CRITICAL for Dynamic Sources**:
When using dynamic source addition, the sink element MUST have `async=0`:
```python
pipeline.add("nveglglessink", "sink", {
    "sync": 0,
    "qos": 0,
    "async": 0  # CRITICAL - prevents state transition deadlock
})
```

**Notes**:
- Integrates nvds_rest_server, nvurisrcbin, and nvstreammux in one bin
- Do NOT implement custom Flask/FastAPI server - use built-in REST API
- See `rest_api_dynamic.md` for complete REST API documentation

---

### nvdsdynamicsrcbin
**Purpose**: Source bin for programmatically adding and removing file/URI-based video sources at runtime. Unlike `nvmultiurisrcbin` (REST API / config-driven), `nvdsdynamicsrcbin` is controlled entirely through code using `SourceManager`.

**CRITICAL**: `nvdsdynamicsrcbin` does **not** manage sources on its own. You **must** use `SourceManager` from `pyservicemaker._pydeepstream.signal` to add, remove, and terminate sources. Without `SourceManager`, the bin has no way to receive source URIs.

**Key Properties**:
| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `gpu-id` | uint | 0 | GPU Device ID to use for decoding |
| `message-forward` | bool | False | Forward all children messages to the pipeline bus (required for EOS detection) |
| `async-handling` | bool | False | Handle asynchronous state changes internally |
| `current-file` | string (read-only) | null | Currently processing file path |
| `current-id` | int (read-only) | -1 | ID of the chunk currently being processed |

**Element Actions** (triggered via `SourceManager`):
| Action | Description |
|--------|-------------|
| `add-source` | Add a new file/URI source to the bin |
| `remove-source` | Remove a source by its unique ID |
| `terminate` | Signal no more sources will be added; sends EOS after all finish |

**Internal Children**: Contains `parsebin`, `queue_parsebin`, and `decoder` — it automatically parses and decodes the added sources.

---

### v4l2src
**Purpose**: Video4Linux2 source for USB cameras

**Key Properties**:
- `device`: Device path (e.g., `/dev/video0`)
- `io-mode`: I/O mode
- `do-timestamp`: Enable timestamping

**Usage**:
```bash
v4l2src device=/dev/video0 ! ...
```

**Notes**:
- Standard GStreamer plugin for USB webcams, may require format conversion

---

### nvarguscamerasrc
**Purpose**: NVIDIA camera source for Jetson CSI cameras

**Key Properties**:
- `sensor-id`: Sensor ID (0, 1, etc.)
- `sensor-mode`: Sensor mode
- `wbmode`: White balance mode
- `exposuretimerange`: Exposure time range
- `gainrange`: Gain range

**Usage**:
```bash
nvarguscamerasrc sensor-id=0 ! ...
```

**Notes**:
- Jetson-specific plugin optimized for CSI cameras with hardware-accelerated capture

---

## Processing Plugins

### nvstreammux
**Purpose**: Batches multiple video streams into a single batch for efficient inference

**IMPORTANT**: There are TWO versions of nvstreammux:
- **OLD nvstreammux**: Default, uses GObject properties for configuration
- **NEW nvstreammux**: Enabled with `USE_NEW_NVSTREAMMUX=yes`, uses config file for advanced settings

**Key Properties (NEW nvstreammux - RECOMMENDED)**:
- `batch-size`: Maximum number of buffers in a batch
- `batched-push-timeout`: Timeout for batching in microseconds (default: 33000)
- `config-file-path`: Path to configuration file for advanced settings
- `num-surfaces-per-frame`: Number of surfaces per frame
- `attach-sys-ts`: Attach system timestamp as NTP timestamp (boolean)
- `max-latency`: Maximum latency in live mode (nanoseconds)
- `sync-inputs`: Force synchronization of input frames (boolean)
- `frame-num-reset-on-eos`: Reset frame numbers on EOS (boolean)
- `frame-num-reset-on-stream-reset`: Reset frame numbers on stream reset (boolean)
- `frame-duration`: Duration of input frames in milliseconds for NTP correction
- `drop-pipeline-eos`: Don't propagate EOS downstream when all pads are at EOS (boolean)

**Key Properties (OLD nvstreammux - Legacy)**:
- `batch-size`: Number of streams to batch
- `width`: Output batch width
- `height`: Output batch height
- `gpu-id`: GPU ID for processing
- `batched-push-timeout`: Timeout for batching (microseconds)
- `enable-padding`: Enable padding for different resolutions
- `nvbuf-memory-type`: Memory type (0=default, 1=NVMM, 2=unified)

**Usage**:
```bash
nvstreammux name=m batch-size=4 width=1920 height=1080
```

**Common Pipeline Pattern**:
```
source1 ! m.sink_0 source2 ! m.sink_1 nvstreammux name=m batch-size=2 ! ...
```

**Notes**:
- **Critical plugin** for multi-stream applications
- **NEW nvstreammux** (recommended): More flexible, uses config file for width/height/memory-type settings
- **OLD nvstreammux**: Uses GObject properties for width/height, may be deprecated in future
- To use NEW version: Set environment variable `USE_NEW_NVSTREAMMUX=yes` before running pipeline
- Batch size should match number of input streams
- NEW version infers output resolution from downstream elements or uses config file

---

### nvstreamdemux
**Purpose**: Demultiplexes batched streams back to individual streams

**Key Properties**:
- `name`: Element name (required for pad access)

**Usage**:
```bash
nvstreamdemux name=d
```

**Common Pipeline Pattern**:
```
nvstreammux name=m ! ... ! nvstreamdemux name=d d.src_0 ! ... d.src_1 ! ...
```

**Notes**:
- Used after processing batched streams
- Provides separate source pads for each stream
- Essential for per-stream rendering or processing

---

### nvinfer
**Purpose**: TensorRT-based inference engine for deep learning models

**Key Properties**:
- `config-file-path`: Path to inference configuration file (supports **both** INI-style text format and YAML format)
- `batch-size`: Batch size for inference
- `gpu-id`: GPU ID for inference
- `unique-id`: Unique identifier for this inference instance
- `process-mode`: Infer processing mode (primary or secondary)
- `interval`: Number of consecutive batches to skip for inference
- `infer-on-gie-id`: Infer on metadata from GIE with this unique ID (-1 for all)
- `infer-on-class-ids`: Operate on objects with specified class IDs
- `filter-out-class-ids`: Ignore metadata for objects of specified class IDs
- `model-engine-file`: Path to pre-generated TensorRT engine file
- `output-tensor-meta`: Output raw tensor metadata (0=no, 1=yes)
- `output-instance-mask`: Output instance mask in metadata (0=no, 1=yes)
- `input-tensor-meta`: Use tensor metadata from upstream (0=no, 1=yes)
- `clip-object-outside-roi`: Clip object bbox outside ROI from nvdspreprocess
- `crop-objects-to-roi-boundary`: Crop object bbox to ROI boundary
- `raw-output-file-write`: Write raw inference output to file
- `raw-output-generated-callback`: Callback for raw output
- `raw-output-generated-userdata`: Userdata for raw output callback

**Configuration File Structure**:

nvinfer supports **two configuration formats**:

### Format 1: YAML Format (Recommended)

```yaml
# Example: pgie_config.yml (Primary detector using ResNet18)
property:
  gpu-id: 0
  net-scale-factor: 0.00392156862745098
  # Use ResNet18 TrafficCamNet model from DeepStream samples
  onnx-file: /opt/nvidia/deepstream/deepstream/samples/models/Primary_Detector/resnet18_trafficcamnet_pruned.onnx
  labelfile-path: /opt/nvidia/deepstream/deepstream/samples/models/Primary_Detector/labels.txt
  batch-size: 1
  process-mode: 1
  model-color-format: 0
  # 0=FP32, 1=INT8, 2=FP16
  network-mode: 2
  num-detected-classes: 4
  interval: 0
  gie-unique-id: 1
  # 1=DBSCAN, 2=NMS, 3=DBSCAN+NMS, 4=None
  cluster-mode: 2

class-attrs-all:
  topk: 20
  nms-iou-threshold: 0.5
  pre-cluster-threshold: 0.2
```

### Format 2: INI-style Text Format

```ini
# Example: pgie_config.txt (Primary detector using ResNet18)
[property]
gpu-id=0
net-scale-factor=0.00392156862745098
onnx-file=/opt/nvidia/deepstream/deepstream/samples/models/Primary_Detector/resnet18_trafficcamnet_pruned.onnx
labelfile-path=/opt/nvidia/deepstream/deepstream/samples/models/Primary_Detector/labels.txt
batch-size=1
process-mode=1
model-color-format=0
network-mode=2
num-detected-classes=4
interval=0
gie-unique-id=1
cluster-mode=2

[class-attrs-all]
topk=20
nms-iou-threshold=0.5
pre-cluster-threshold=0.2
```

**Key Differences**:
| Aspect | YAML Format | INI Format |
|--------|-------------|------------|
| File extension | `.yml` or `.yaml` | `.txt` |
| Section headers | `property:` (no brackets) | `[property]` (with brackets) |
| Key-value separator | `: ` (colon + space) | `=` (equals) |
| Indentation | Required for nested values | Not used |

**Usage**:
```bash
nvinfer config-file-path=/path/to/config.yml batch-size=4
```

**Common Pipeline Pattern**:
```
nvstreammux ! nvinfer config-file-path=pgie_config.txt ! ...
```

**Notes**:
- **Primary inference engine** for object detection/classification
- Supports TensorRT engines (.trt), ONNX models, and custom networks
- Can be used as Primary GIE (PGIE) or Secondary GIE (SGIE)
- Multiple instances can be cascaded for complex models
- `output-tensor-meta=1` enables custom postprocessing
- `input-tensor-meta=1` uses preprocessed tensors from nvdspreprocess
- **Note**: `enable-dbscan` is DEPRECATED and is a config file parameter, not a GObject property

---

### nvinferserver
**Purpose**: Inference using Triton Inference Server backend

**Key Properties**:
- `config-file-path`: Path to Triton configuration file
- `gpu-id`: GPU ID
- `unique-id`: Unique identifier
- `output-tensor-meta`: Output tensor metadata

**Usage**:
```bash
nvinferserver config-file-path=/path/to/triton_config.txt
```

**Notes**:
- Alternative to nvinfer for Triton-based inference
- Supports remote inference servers
- Better for scalable deployments
- Requires Triton Inference Server setup

---

### nvdspreprocess
**Purpose**: Custom preprocessing plugin for region-of-interest (ROI) preprocessing

**Key Properties**:
- `config-file`: Path to preprocessing configuration file
- `gpu-id`: GPU ID

**Configuration File Structure**:
```yaml
preprocess-config:
  - preprocess-group:
      target-unique-ids: [1]
      roi-params-src: [0]
      process-on-roi: 1
      network-input-shape: [1, 3, 544, 960]
      tensor-format: 0  # 0=NCHW, 1=NHWC
      maintain-aspect-ratio: 0
      custom-transform-function: "custom_transform"
      custom-tensor-prep-function: "custom_tensor_prep"
```

**Usage**:
```bash
nvdspreprocess config-file=/path/to/preprocess_config.yml
```

**Common Pipeline Pattern**:
```
nvstreammux ! nvdspreprocess config-file=preprocess.yml ! nvinfer input-tensor-meta=1 ! ...
```

**Notes**:
- Enables custom preprocessing before inference
- Processes ROIs or full frames
- Outputs tensor metadata for nvinfer
- Custom preprocessing library and functions are specified in the **config file**, not as GObject properties
- Optimal performance: batch-size should match total units in config

---

### nvdspostprocess
**Purpose**: Custom postprocessing plugin for parsing model outputs

**Key Properties**:
- `postprocesslib-name`: Path to postprocessing library (.so)
- `postprocesslib-config-file`: Path to postprocessing configuration file
- `gpu-id`: GPU ID

**Configuration File Structure** (YAML):
```yaml
postprocess-config:
  - postprocess-group:
      target-unique-ids: [1]
      custom-parse-function: "custom_parse"
      custom-bbox-parse-function: "custom_bbox_parse"
      output-format: 0  # 0=object detection, 1=classification
```

**Usage**:
```bash
nvdspostprocess postprocesslib-name=./libpostprocess.so postprocesslib-config-file=config.yml
```

**Common Pipeline Pattern**:
```
nvinfer output-tensor-meta=1 ! nvdspostprocess postprocesslib-name=... ! ...
```

**Notes**:
- Parses raw tensor outputs from nvinfer
- Requires nvinfer with output-tensor-meta=1
- Supports custom parsing functions
- Used for models not supported by nvinfer's built-in parsers

---

### nvtracker
**Purpose**: Multi-object tracker for tracking objects across frames

**Key Properties**:
- `ll-lib-file`: Path to low-level tracker library (.so)
- `ll-config-file`: Path to tracker configuration file
- `tracker-width`: Tracker input width
- `tracker-height`: Tracker input height
- `gpu-id`: GPU ID
- `input-tensor-meta`: Use tensor metadata (0=no, 1=yes)
- `tensor-meta-gie-id`: GIE ID for tensor metadata (used with input-tensor-meta)
- `display-tracking-id`: Display tracking ID in object text
- `tracking-id-reset-mode`: Tracking ID reset mode on stream reset/EOS
- `tracking-surface-type`: Selective tracking surface type
- `user-meta-pool-size`: Tracker user metadata buffer pool size
- `sub-batches`: Configuration of sub-batches for parallel processing
- `sub-batch-err-recovery-trial-cnt`: Max trials to reinitialize tracker on error

**Configuration File Structure**:
```yaml
tracker:
  ll-lib-file: /path/to/libnvds_nvmultiobjecttracker.so
  ll-config-file: /path/to/tracker_config.yml
  enable-batch-process: 1
  enable-past-frame: 1
  tracker-width: 1920
  tracker-height: 1080
```

**Usage**:
```bash
nvtracker ll-lib-file=/path/to/libnvds_nvmultiobjecttracker.so ll-config-file=/path/to/config.yml
```

**Common Pipeline Pattern**:
```
nvinfer ! nvtracker ll-lib-file=... ! ...
```

**Notes**:
- Tracks objects across video frames
- Assigns unique tracking IDs to objects
- Supports multiple tracking algorithms
- Requires object metadata from inference engine
- Tracker dimensions should match preprocess/infer dimensions when using input-tensor-meta=1

---

### nvdsosd (nvosdbin)
**Purpose**: On-Screen Display element (`nvdsosd`) and DeepStream convenience bin (`nvosdbin`) for drawing bounding boxes, labels, masks, and clocks

**Key Properties**:
- `gpu-id`: GPU ID to render on
- `process-mode`: Rendering backend (0=CPU, 1=GPU)
- `display-text`: Enable text overlay (boolean)
- `display-bbox`: Enable bounding box display (boolean)
- `display-mask`: Enable instance mask display (boolean)
- `display-clock`: Enable clock display (boolean)
- `clock-font`: Font for clock text
- `clock-font-size`: Font size for clock
- `x-clock-offset`: X offset for clock position
- `y-clock-offset`: Y offset for clock position
- `clock-color`: Clock color (RGBA as uint)
- `blur-bbox`: Enable bbox blurring (boolean)
- `blur-on-gie-class-ids`: Blur bboxes for specific GIE unique ID and class ID

**Note**: Text and bbox styling properties (like colors, borders) are controlled through object metadata, not as GObject properties on the plugin itself.

**Usage**:
```bash
nvdsosd display-text=1 display-bbox=1
```

**Common Pipeline Pattern**:
```
nvtracker ! nvdsosd ! ...
```

**Notes**:
- Use `nvdsosd` for the raw transform element
- Supports tracking ID display, text overlays, and optional blur/clocks
- Keeps surfaces in NVMM for zero-copy rendering on GPU
- Object-specific styling (text colors, bbox colors, etc.) is set through NvDsMeta object metadata, not plugin properties

---

### nvmultistreamtiler
**Purpose**: Tiles multiple video streams into a single output frame

**Key Properties**:
- `width`: Output width
- `height`: Output height
- `rows`: Number of rows in tile layout
- `columns`: Number of columns in tile layout
- `gpu-id`: GPU ID
- `show-source`: Show source index (0=no, 1=yes)

**Usage**:
```bash
nvmultistreamtiler width=1920 height=1080 rows=2 columns=2
```

**Common Pipeline Pattern**:
```
nvstreamdemux name=d d.src_0 ! ... d.src_1 ! ... ! nvmultistreamtiler ! ...
```

**Notes**:
- Combines multiple streams into a grid layout, useful for multi-stream visualization

---

### nvvideoconvert
**Purpose**: Video format converter (color space conversion, scaling)

**Key Properties**:
- `gpu-id`: GPU ID
- `nvbuf-memory-type`: Memory type
- `src-crop`: Source crop rectangle
- `dest-crop`: Destination crop rectangle

**Usage**:
```bash
nvvideoconvert gpu-id=0
```

**Common Pipeline Pattern**:
```
nvdsosd ! nvvideoconvert ! nveglglessink
```

**Notes**:
- GPU-accelerated color format conversion (NV12, RGBA, etc.), often needed before rendering sinks

---

### nvdsanalytics
**Purpose**: Video analytics plugin for motion detection, line crossing, etc.

**Key Properties**:
- `config-file`: Path to analytics configuration file
- `enable`: Enable analytics (0=no, 1=yes)
- `gpu-id`: GPU ID

**Configuration File Parameters**:
The config file **must** include a **property** group/section. Other groups define per-stream ROI, line-crossing, overcrowding, and direction rules. Stream index is given by the numeric suffix in the group name (e.g. `roi-filtering-stream-0` for stream 0).
- `property`: General group; Mandatory.
  - `config-width`,`config-height`:  Reference resolution width and height for analytics coordinate scaling.
  - `enable`: Whether analytics is enabled (aligned with the element **enable** property).
  - `display-font-size`: Optional; OSD font size.
  - `osd-mode`: Optional; 0, 1, or 2. 0 = OSD off, 1 = labels only, 2 = full (default).
  - `obj-cnt-win-in-ms`: Optional; object-count time window in milliseconds; range 1–1000000000.
  - `display-obj-cnt`: Optional; whether to show per-class object counts on OSD.
- `roi-filtering-stream-<stream_id>`: ROI Filtering group per stream
  - `enable`: Enable ROI filtering for this stream.
  - `class-id`: Class IDs to include in ROI analytics (semicolon-separated integer list).
  - `inverse-roi`: Whether treat as “outside ROI” for counting/filtering.
  - `roi-<label>`: ROI coordinations in polygon vertices: `x1;y1;x2;y2;...` (even number of integers). `<label>` is a custom name for the specified ROIs.
- `overcrowding-stream-<stream_id>`: Overcrowding object count and duration in ROIs per stream.
  - `enable`: Enable overcrowding analysis for this stream.
  - `class-id`:  Class IDs to count for overcrowding in integer list.
  - `object-threshold`: Object count threshold for overcrowding.
  - `time-threshold`: Duration threshold in milliseconds.
  - `roi-<label>`: Polygon vertices for the overcrowding region: `x1;y1;x2;y2;...`. `<label>` is a custom name for the specified ROIs.
- `line-crossing-stream-<stream_id>`: Line Crossing object count per stream.
  - `enable`: Enable line-crossing counting for this stream.
  - `extended`: Whether to use extended line-crossing logic. 
  - `class-id`: Class IDs to count for line crossing in integer list.
  - `line-crossing-<label>`: **8 integers:** direction vector (x1,y1,x2,y2) then line (x1,y1,x2,y2). Coordinates relative to config-width/config-height. `<label>` is a custom name for the specified lines.
  - `mode`: Detection strictness options: `strict`, `balanced`, or `loose`.
- `direction-detection-stream-<stream_id>`: Defines reference direction vectors for judging object movement direction per stream.
   - `enable`: Enable direction detection for this stream.
   - `class-id`: Class IDs of the objects which need direction detection.
   - `direction-<label>`: **8 integers:** direction vector (x1,y1,x2,y2) then line (x1,y1,x2,y2). `<label>` is a custom name for the specified directions.
   - `mode`: Direction detection mode options: `strict`, `balanced`, or `loose`.

**Notes**:
**<stream_id>** should be the stream id which be compatible for the source id identified by the nvstreammux sink pad id.
Each **roi-<label>** defines one ROI; multiple ROIs per stream are allowed.
Each **line-crossing-<label>** defines one line; multiple lines per stream are allowed.
Each **direction-<label>** defines one reference direction; multiple directions per stream are allowed.

**Configuration File Samples**:
There are two formats configuration files: .txt and .yml.
- YAML format:
```yaml
property:
  enable: 1
  config-width: 1920
  config-height: 1080
  display-font-size: 12
  osd-mode: 2
roi-filtering-stream-0:
  enable: 1
  class-id: -1
  roi-DOOR: 256;639;675;83;876;224;926;482;866;741
overcrowding-stream-0:
  enable: 1
  class-id: 1;2
  object-threshold: 1000
  roi-ENTRANCE: 282;347;987;843
line-crossing-stream-0:
  enable: 1
  line-crossing-Exit: 789;672;1084;900;851;773;1203;732
  class-id: 0
  mode: loose
direction-detection-stream-0:
  enable: 1
  direction-South: 284;840;360;662
  class-id: 0
```
- TXT format:
```txt
[property]
enable=1
config-width=1920
config-height=1080
osd-mode=2
display-font-size=12

[roi-filtering-stream-0]
enable=1
roi-RF=256;639;675;83;876;224;926;482;866;741
inverse-roi=0
class-id=-1

[overcrowding-stream-1]
enable=1
roi-OC=282;347;987;843
object-threshold=3
class-id=-1

[line-crossing-stream-0]
enable=1
line-crossing-Exit=789;672;1084;900;851;773;1203;732
class-id=0
mode=loose

[direction-detection-stream-0]
enable=1
direction-South=284;840;360;662
class-id=0
```

**Usage**:
```bash
nvdsanalytics config-file=/path/to/analytics_config.yml
```

**Notes**:
- Performs motion, line crossing, intrusion, and loitering detection; requires configuration file

---

### nvmsgbroker
**Purpose**: Message broker plugin for sending metadata to cloud services

**IMPORTANT**: `nvmsgbroker` is a **SINK component** that terminates the pipeline branch. It cannot have downstream components. If you need both message broker output and display, use `tee` to split the pipeline.

**Key Properties**:
- `proto-lib`: Path to protocol library (.so)
- `conn-str`: Connection string
- `config-file`: Configuration file path
- `topic`: Topic name (for Kafka/MQTT)
- `sync`: Synchronous mode (0=async, 1=sync)

**Usage**:
```bash
nvmsgbroker proto-lib=/path/to/libnvds_kafka_proto.so conn-str=localhost:9092 topic=analytics
```

**Pipeline Patterns**:
```bash
# Headless (Kafka only)
tracker ! nvmsgconv ! nvmsgbroker

# With display (use tee)
tracker ! tee name=t
t. ! queue ! nvmsgconv ! nvmsgbroker
t. ! queue ! tiler ! osd ! converter ! sink
```

**Notes**:
- **SINK component**: Terminates pipeline branch, cannot have downstream elements
- Sends metadata to cloud services
- Supports Kafka, MQTT, Azure, Redis, AMQP
- Requires protocol-specific library
- Can send object metadata, frame metadata, etc.
- For pipelines requiring both Kafka and display, use `tee` to create separate branches

---

### nvmsgconv
**Purpose**: Message converter plugin for transforming metadata formats

**Key Properties**:
- `msg2p-lib`: Payload generation library path with absolute path
- `payload-type`: Payload type (0=deepstream, 1=custom, etc.)
- `msg2p-newapi`: Use new API which supports multiple payloads (boolean)
- `frame-interval`: Interval for frame-level metadata generation
- `debug-payload-dir`: Directory to dump generated payloads for debugging

**Usage**:
```bash
nvmsgconv config-file=/path/to/msgconv_config.txt
```

**Notes**:
- Converts metadata to different formats
- Used before nvmsgbroker
- Supports custom schemas

---

## Sink Plugins

### nveglglessink
**Purpose**: EGL/GLES-based video renderer for x86_64 platforms

**Key Properties**:
- `sync`: Synchronize to display refresh (0=no, 1=yes)
- `window-x`: Window X position
- `window-y`: Window Y position
- `window-width`: Window width
- `window-height`: Window height
- `display-id`: Display ID

**Usage**:
```bash
nveglglessink sync=1
```

**Notes**:
- For x86_64 desktop/server platforms with hardware-accelerated rendering

---

### nv3dsink
**Purpose**: 3D video renderer for Jetson platforms

**Key Properties**:
- `sync`: Synchronize to display refresh
- `window-x`: Window X position
- `window-y`: Window Y position
- `window-width`: Window width
- `window-height`: Window height

**Usage**:
```bash
nv3dsink sync=1
```

**Notes**:
- For ARM64/Jetson platforms with hardware-accelerated rendering

---

### nvvideoconvert + filesink
**Purpose**: Save processed video to file

**Usage**:
```bash
nvvideoconvert ! x264enc ! mp4mux ! filesink location=output.mp4
```

**Notes**:
- Requires encoding before saving
- Can use hardware encoders (nvv4l2h264enc, nvv4l2h265enc)

---

## Standard GStreamer Plugins Used in DeepStream

### h264parse / h265parse
**Purpose**: Parse H.264/H.265 video streams

**Usage**:
```bash
h264parse
```

### queue
**Purpose**: Buffer management and synchronization

**Key Properties**:
- `max-size-buffers`: Maximum buffer size
- `max-size-time`: Maximum time-based size
- `leaky`: Leaky queue mode

**Usage**:
```bash
queue max-size-buffers=200
```

### tee
**Purpose**: Split pipeline into multiple branches

**Usage**:
```bash
tee name=t t. ! queue ! ... t. ! queue ! ...
```

---

## Plugin Selection Guidelines

### For Video Sources:
- **Files**: `nvurisrcbin` or `filesrc` + `qtdemux` + `h264parse`
- **RTSP Streams**: `nvurisrcbin` with `rtsp://` URI
- **Dynamic sources (REST API)**: `nvmultiurisrcbin` — config/REST-driven multi-stream
- **Dynamic sources (programmatic)**: `nvdsdynamicsrcbin` + `SourceManager` — script-driven add/remove
- **USB Cameras**: `v4l2src`
- **Jetson CSI Cameras**: `nvarguscamerasrc`

### For Decoding:
- **Always use**: `nvv4l2decoder` for hardware acceleration
- **Avoid**: Software decoders (avdec_h264, etc.) for performance

### For Multi-Stream:
- **Always use**: `nvstreammux` to batch streams
- **Batch size**: Match number of input streams
- **Use**: `nvstreamdemux` after processing to split streams

### For Inference:
- **Primary**: `nvinfer` for TensorRT-based inference
- **Alternative**: `nvinferserver` for Triton-based inference
- **Custom preprocessing**: `nvdspreprocess` before inference
- **Custom postprocessing**: `nvdspostprocess` after inference

### For Tracking:
- **Use**: `nvtracker` after primary inference
- **Configure**: Tracker dimensions to match inference input

### For Visualization:
- **Use**: `nvdsosd` for drawing bounding boxes and labels
- **Use**: `nvmultistreamtiler` for multi-stream display
- **Use**: `nvvideoconvert` before rendering sinks

### For Rendering:
- **x86_64**: `nveglglessink`
- **Jetson**: `nv3dsink`
- **File output**: `nvvideoconvert` + encoder + `filesink`

---

## Common Pipeline Patterns

### Single Stream with Detection:
```
filesrc ! h264parse ! nvv4l2decoder ! nvstreammux batch-size=1 ! 
nvinfer config-file-path=pgie.yml ! nvtracker ! nvdsosd ! 
nvvideoconvert ! nveglglessink
```

### Multi-Stream with Detection:
```
stream1 ! m.sink_0 stream2 ! m.sink_1 
nvstreammux name=m batch-size=2 ! nvinfer ! nvtracker ! 
nvstreamdemux name=d d.src_0 ! nvdsosd ! sink1 d.src_1 ! nvdsosd ! sink2
```

### Cascaded Inference (Primary + Secondary):
```
nvstreammux ! nvinfer config-file-path=pgie_config.txt ! 
nvinfer config-file-path=sgie1_config.txt ! nvinfer config-file-path=sgie2_config.txt ! 
nvtracker ! nvdsosd ! sink
```

### Custom Preprocessing + Inference:
```
nvstreammux ! nvdspreprocess config-file=preprocess_config.txt ! 
nvinfer input-tensor-meta=1 config-file-path=infer_config.txt ! 
nvdspostprocess postprocesslib-name=... ! nvdsosd ! sink
```

### Multi-Stream with Analytics and Cloud:
```
streams ! nvstreammux ! nvinfer ! nvtracker ! nvdsanalytics ! 
nvmsgconv ! nvmsgbroker proto-lib=... conn-str=... ! 
nvstreamdemux ! nvdsosd ! sink
```

---

## Performance Optimization Tips

1. **Batch Size**: Use appropriate batch sizes (typically 1-8) based on GPU memory
2. **Resolution**: Match stream resolution to model input requirements
3. **Memory Type**: Use NVMM memory (`nvbuf-memory-type=1`) for zero-copy
4. **Inference Precision**: Use FP16 or INT8 for better performance
5. **Pipeline Parallelism**: Run multiple pipelines on different GPUs
6. **Buffer Management**: Configure queue sizes appropriately
7. **Tracker Configuration**: Match tracker dimensions to inference dimensions

---

## Error Handling and Debugging

1. **Check Plugin Availability**: Use `gst-inspect-1.0 nvinfer` to verify plugins
2. **Enable Debugging**: Set `GST_DEBUG=3` for verbose logging
3. **Check Metadata**: Use probes to inspect metadata at pipeline points
4. **Memory Issues**: Monitor GPU memory usage with `nvidia-smi`
5. **Pipeline State**: Check pipeline state transitions (NULL → READY → PLAYING)

---

This comprehensive overview should help you understand and use DeepStream plugins effectively in your applications.

