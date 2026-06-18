# DeepStream Service Maker for Python (pyservicemaker) API Reference

## Introduction

The DeepStream Service Maker provides a high-level Python API (`pyservicemaker`) for building DeepStream applications. It abstracts away the complexity of GStreamer C API and provides a more intuitive, Pythonic interface for constructing video analytics pipelines.

## Installation

The pyservicemaker package is installed as part of DeepStream SDK:
```bash
pip install /opt/nvidia/deepstream/deepstream/service-maker/python/pyservicemaker*.whl pyyaml
```

**Inside a virtual environment**: `pyservicemaker` is installed system-wide but is NOT accessible from a standard venv. If the application uses a virtual environment, you must install it inside the venv:
```bash
python3 -m venv venv
source venv/bin/activate
pip install /opt/nvidia/deepstream/deepstream/service-maker/python/pyservicemaker*.whl pyyaml
```

## Two API Approaches

Service Maker provides two APIs for building pipelines:

1. **Pipeline API**: Low-level, element-by-element pipeline construction
2. **Flow API**: High-level, declarative pipeline construction

---

## Pipeline API

The Pipeline API provides fine-grained control over pipeline construction, similar to GStreamer C API but with Python syntax.

### Core Classes

#### Pipeline
Main class for creating and managing DeepStream pipelines.

**Constructor**:
```python
from pyservicemaker import Pipeline

# Create empty pipeline
pipeline = Pipeline("pipeline-name")

# Create pipeline from YAML config
pipeline = Pipeline("pipeline-name", "/path/to/config.yml")
```

**Methods**:

##### `add(element_type, name, properties=None)`
Add a GStreamer element to the pipeline.

**Parameters**:
- `element_type` (str): GStreamer element factory name (e.g., "nvinfer", "nvstreammux")
- `name` (str): Unique name for the element
- `properties` (dict, optional): Element properties as key-value pairs

**Returns**: Pipeline instance (for method chaining)

**Example**:
```python
pipeline.add("filesrc", "src", {"location": "/path/to/video.h264"})
pipeline.add("h264parse", "parser")
pipeline.add("nvv4l2decoder", "decoder")
pipeline.add("nvstreammux", "mux", {"batch-size": 1, "width": 1920, "height": 1080})
pipeline.add("nvinfer", "infer", {"config-file-path": "/path/to/config.yml"})
```

##### `link(*element_names)`
Link elements in sequence. Elements are connected in the order specified.

**Parameters**:
- `*element_names`: Variable number of element names or tuples for request pads

**Returns**: Pipeline instance (for method chaining)

**Example**:
```python
# Simple linear linking
pipeline.link("src", "parser", "decoder", "mux", "infer", "sink")

# Linking with request pads (for nvstreammux)
pipeline.link(("decoder", "mux"), ("", "sink_%u"))
# This connects decoder src pad to mux sink_0 pad
```

**Request Pad Linking**:
For elements with dynamic pads (like nvstreammux), use tuple syntax:
```python
# Format: (source_element, sink_element), (source_pad, sink_pad_template)
pipeline.link(("decoder1", "mux"), ("", "sink_%u"))  # Connects to sink_0
pipeline.link(("decoder2", "mux"), ("", "sink_%u"))  # Connects to sink_1
```

**CRITICAL: Always use "sink_%u" pad template, NOT "sink_0", "sink_1", or f"sink_{i}"**
- `"sink_%u"` is a GStreamer pad template that automatically assigns sink pads (sink_0, sink_1, sink_2, etc.)
- Using literal pad names like `"sink_0"` or `f"sink_{i}"` will FAIL because these pads don't exist until requested
- The `%u` format specifier tells GStreamer to automatically assign the next available sink pad index

**Examples with different source types**:
```python
# With nvv4l2decoder (decoded video source)
pipeline.link((f"decoder{i}", "mux"), ("", "sink_%u"))  # CORRECT

# With nvurisrcbin (RTSP/file source with dynamic pads)
pipeline.link((f"src{i}", "mux"), ("", "sink_%u"))  # CORRECT - nvurisrcbin has dynamic src pad

# WRONG - DO NOT USE:
pipeline.link((f"src{i}", "mux"), ("", f"sink_{i}"))  # INCORRECT - will fail!
pipeline.link((f"src{i}", "mux"), ("", "sink_0"))     # INCORRECT - pad doesn't exist!
```

##### `attach(target, what, name='', tips='', properties=None)`
Attach a probe (or other custom object) to a named element in the pipeline.

**Parameters**:
- `target` (str): Name of the pipeline element to attach to
- `what`: Probe instance or name of a built-in probe module (e.g. `"measure_fps_probe"`)
- `name` (str, optional): Name for the probe. Not needed when `what` is an explicitly created Probe object.
- `tips` (str, optional): Extra information for the custom object
- `properties` (dict, optional): Properties to set on the object. Not applicable for explicitly created Probe objects.

**CRITICAL**: The parameter is **`name`**, NOT `probe_name`. Using `probe_name` will raise `TypeError`.

**Returns**: Pipeline instance (for method chaining)

**Example**:
```python
from pyservicemaker import Probe, BatchMetadataOperator

class MyProbe(BatchMetadataOperator):
    def handle_metadata(self, batch_meta):
        # Process metadata
        pass

pipeline.attach("infer", Probe("my-probe", MyProbe()))
# Or attach built-in probe by module name, giving it a name
pipeline.attach("infer", "measure_fps_probe", name="fps-probe")
```

##### `start()`
Start the pipeline (set to PLAYING state).

**Returns**: Pipeline instance (for method chaining)

**Example**:
```python
pipeline.start()
```

##### `wait()`
Wait for pipeline to finish (blocking call until EOS or error).

**Returns**: None

**Example**:
```python
pipeline.start().wait()
```

##### `set(properties)`
Set properties on an element (when element is accessed via indexing).

**Parameters**:
- `properties` (dict): Properties to set

**Example**:
```python
pipeline["infer"].set({"batch-size": 4})
```

##### Element Access via Indexing
Access elements by name to get/set properties:

```python
# Get element
infer_element = pipeline["infer"]

# Set properties
pipeline["infer"].set({"batch-size": 4})

# Get properties
batch_size = pipeline["infer"].get("batch-size")
```

### Complete Pipeline API Example

```python
from pyservicemaker import Pipeline, Probe, BatchMetadataOperator
import platform

PIPELINE_NAME = "my-pipeline"
CONFIG_FILE = "/path/to/inference_config.txt"  # Must be INI-style text format, NOT YAML
VIDEO_FILE = "/path/to/video.h264"

class ObjectCounter(BatchMetadataOperator):
    def handle_metadata(self, batch_meta):
        for frame_meta in batch_meta.frame_items:
            # IMPORTANT: object_items returns an ITERATOR, not a list
            # You cannot use len() directly - iterate and count instead
            obj_count = 0
            for obj in frame_meta.object_items:
                obj_count += 1
            print(f"Frame {frame_meta.frame_number}: {obj_count} objects")

# Create pipeline
pipeline = (Pipeline(PIPELINE_NAME)
    .add("filesrc", "src", {"location": VIDEO_FILE})
    .add("h264parse", "parser")
    .add("nvv4l2decoder", "decoder")
    .add("nvstreammux", "mux", {
        "batch-size": 1,
        "width": 1920,
        "height": 1080
    })
    .add("nvinfer", "infer", {"config-file-path": CONFIG_FILE})
    .add("nvosdbin", "osd")
    .add("nv3dsink" if platform.processor() == "aarch64" else "nveglglessink", "sink")
    .link("src", "parser", "decoder")
    .link(("decoder", "mux"), ("", "sink_%u"))
    .link("mux", "infer", "osd", "sink")
    .attach("infer", Probe("counter", ObjectCounter()))
    .start()
    .wait())
```

---

## Flow API

The Flow API provides a high-level, declarative interface for common pipeline patterns.

### Core Classes

#### Flow
High-level API for building pipelines using method chaining.

**Constructor**:
```python
from pyservicemaker import Flow, Pipeline

pipeline = Pipeline("pipeline-name")
flow = Flow(pipeline)
```

**Methods**:

##### `batch_capture(sources, record_config=None, **kwargs)`
Configure batch capture from multiple sources.

**Parameters**:
- `sources` (list): List of source file paths or URIs
- `record_config` (class RecordConfig): Optional smart recording (see full table in **`record_config` details** section below). If **`None`**, no smart recording is configured on sources. 
- `kwargs` (dict): Optional overrides merged into mux and/or source properties (see **`kwargs` dict details** section below). 

**`record_config` details**:
RecordConfig instance should be constructed as description in **`record_config` Construction examples** section. The following RecordConfig fields can be used to configure smart recording.
| Field | Type | Default | Used when | Meaning |
|-------|------|---------|-----------|---------|
| **`recording_type`** | **str** | **`"local"`** | Always | **`"local"`** or **`"cloud"`** (case-insensitive check in validation). |
| **`proto_lib`** | **Optional[str]** | **`None`** | **`recording_type == "cloud"`** (required) | Path to the protocol library (e.g. Kafka proto **`libnvds_kafka_proto.so`**). Set on the smart-recording controller as **`proto-lib`**. |
| **`conn_str`** | **Optional[str]** | **`None`** | Cloud (required) | Broker connection string (e.g. **`"localhost;9092"`**). Property **`conn-str`**. |
| **`msgconv_config_file`** | **Optional[str]** | **`None`** | Cloud (required) | Message converter config file path. Property **`msgconv-config-file`**. |
| **`proto_config_file`** | **Optional[str]** | **`None`** | Cloud (required) | Protocol adaptor config file path. Property **`proto-config-file`**. |
| **`topic_list`** | **Optional[str]** | **`None`** | Cloud (required) | Comma-separated topic list. Property **`topic-list`**. |
| **`rec_cache`** | **int** | **20** | **`record_config` is set** | Maps to **`smart-rec-cache`** on each source (cache size in seconds). |
| **`rec_container`** | **int** | **0** | **`record_config` is set** | Maps to **`smart-rec-container`** (**0**: MP4, **1**: MKV). |
| **`rec_dir_path`** | **str** | **`"."`** | **`record_config` is set** | Maps to **`smart-rec-dir-path`** (output directory for recordings). |
| **`rec_mode`** | **int** | **0** | **`record_config` is set** | Maps to **`smart-rec-mode`**. Docstring: **0** both, **1** video-only, **2** audio-only. |

**`record_config` Construction examples**:
```python
from pyservicemaker import RecordConfig

# Local smart recording (minimal)
rec_local = RecordConfig()  # recording_type defaults to "local"

# Local with explicit paths and cache
rec_local = RecordConfig(
    recording_type="local",
    rec_cache=20,
    rec_container=0,
    rec_dir_path="/data/recordings",
    rec_mode=0,
)

# Cloud smart recording (all cloud fields required)
rec_cloud = RecordConfig(
    recording_type="cloud",
    proto_lib="/path/to/broker_library.so",
    conn_str="localhost;9092",
    msgconv_config_file="/path/to/dstest5_msgconv_sample_config.txt",
    proto_config_file="/path/to/cfg_kafka.txt",
    topic_list="sr-test",
    rec_cache=20,
    rec_dir_path=".",
    rec_mode=0,
)
```

**`kwargs` dict details**:
Any matching **hyphenated** name in the merged **`kwargs`** dict overrides the default value of the corresponding property, the following keys are supported:
- `gpu_id` (int): Used as the `gpu-id` property of **`nvstreammux`** and as `gpu-id` on each **`nvurisrcbin`**.
- `width` (int): Used as the `width` property of **`nvstreammux`**, default value is 1920.
- `height` (int): Used as the `height` property of **`nvstreammux`**, default value is 1080.
- `batch_size` (int): Used as the `batch-size` property of **`nvstreammux`**, default value is the number of URIs (if non-empty).
- `batched_push_timeout` (int): Used as the `batched-push-timeout` property of **`nvstreammux`**, default value is 33000.
- `buffer_pool_size` (int): Used as the `buffer-pool-size` property of **`nvstreammux`**, default value is 4.
- `drop_pipeline_eos` (bool): Used as the `drop-pipeline-eos` property of **`nvstreammux`**, default value is False.
- `live_source` (bool): Used as the `live-source` property of **`nvstreammux`**, default value is False.
- `file_loop`(bool): Used as the `file-loop` property of **`nvstreammux`**, default value is False.

**Returns**: Flow instance (for method chaining)

**Example**:
```python
flow.batch_capture([
    "/path/to/video1.h264",
    "/path/to/video2.h264",
    "rtsp://camera-ip/stream"
])

# Mux resolution and batching setting
flow.batch_capture(uris, width=1280, height=720, batch_size=4)

# GPU and file loop for file sources
flow.batch_capture(uris, gpu_id=0, file_loop=True)

# Combine with YAML: kwargs override missing keys from source-config.properties
flow.batch_capture("/path/to/sources.yaml", width=1920, height=1080, live_source=True)
```
**Important**:
`batch_capture` function sets the nvstreammux batch-size according to the input stream number by default, it is not necessary to set 'batch-size' with `batch_capture` unless you want to support dynamic source adding/removing.


##### `infer(config_file_path, with_triton, **kwargs)`
Add inference stage to the pipeline.

**Parameters**:
- `config_file_path` (str): Path to inference configuration file
- `with_triton` (bool): If **`False`** (default), adds **`nvinfer`**. If **`True`**, adds **`nvinferserver`** for Triton-based inference.
- `kwargs` (dict): Optional properties passed to gst-nvinfer or gst-nvinferserver plugin of DeepStream. Underscores in keyword names are converted to hyphens for GStreamer properties (e.g. **`batch_size`** → **`batch-size`**). Common overrides include **`batch_size`**, **`unique_id`**, **`model_engine_file`**, **`gpu_id`**, and other keys supported by **nvinfer** / **nvinferserver** for your install.

**Returns**: Flow instance (for method chaining)

**Notes**: For multiple streams inferencing case, `batch_size` property should be set as the same value as the stream number.

**Examples**:
```python
flow.infer("/path/to/pgie_config.yml")

#set nvinfer/nvinferserver properties with Flow.infer function
flow.infer("/path/to/pgie_config.yml",unique_id=5, batch_size=4)
```

##### `track(**kwargs)`
Add tracker for object tracking. Must be used after primary inference.

**Parameters**:
The following keyword arguments(kwargs) are passed to **nvtrack** as properties.
| Property            | Type | Description |
|---------------------|------|-------------|
| **`ll_config_file`** | str  | Path to the low-level tracker config file (e.g. NvDCF, NvSORT, IOU). |
| **`ll_lib_file`**    | str  | Path to the tracker library (e.g. `libnvds_nvmultiobjecttracker.so`). |
| **`gpu_id`**         | int  | GPU device id (default 0). |

**Notes**:
Example tracker configs (paths may vary by installation):
- NvDCF (performance): `config_tracker_NvDCF_perf.yml`
- NvDCF (accuracy): `config_tracker_NvDCF_accuracy.yml`
- NvSORT: `config_tracker_NvSORT.yml`
- IOU: `config_tracker_IOU.yml`
- NvDeepSORT: `config_tracker_NvDeepSORT.yml`

**Example**:
```python
flow = flow.track(ll_config_file=config_tracker_NvDCF_perf.yml, ll_lib_file=libnvds_nvmultiobjecttracker.so)
```

##### `analyze(config_file_path,**kwargs)`
Add analytics for region-of-interest (ROI), line-crossing, overcrowding and direction analytics. The result will be output as AnalyticsFrameMeta in frame meta and AnalyticsObjInfo in object meta.

**Parameters**:
- `config_file_path` (str): Path to analytics configuration file
- `kwargs` (dict): Optional properties passed to gst-nvdsanalytics plugin of DeepStream

**Notes**:
analytics MUST follow tracker to work properly.

**Example**:
```python
from pyservicemaker import Pipeline, Flow, BatchMetadataOperator, Probe, RenderMode

PGIE_CONFIG = "/path/to/config_infer_primary.yml"
TRACKER_LL_CONFIG = "/path/to/config_tracker_NvDCF_perf.yml"
TRACKER_LL_LIB = "/path/to/libnvds_nvmultiobjecttracker.so"
ANALYTICS_CONFIG = "/path/to/config_analytics.txt"  # nvdsanalytics config
SOURCE = "/path/to/source_list.yaml"

class AnalyticsProbe(BatchMetadataOperator):
    def handle_metadata(self, batch_meta):
        for frame_meta in batch_meta.frame_items:
            # Frame-level analytics (ROI counts, line-cross counts)
            for user_meta in frame_meta.nvdsanalytics_frame_items:
                afm = user_meta.as_nvdsanalytics_frame()
                if afm:
                    print(f"Frame {frame_meta.frame_number}: unique_id={afm.unique_id} "
                          f"obj_in_roi_cnt={afm.obj_in_roi_cnt} obj_lc_curr_cnt={afm.obj_lc_curr_cnt} "
                          f"obj_cnt={afm.obj_cnt} oc_status={afm.oc_status}")

            # Object-level analytics (which ROI/line each object is in)
            for obj_meta in frame_meta.object_items:
                for user_meta in obj_meta.nvdsanalytics_obj_items:
                    aoi = user_meta.as_nvdsanalytics_obj()
                    if aoi:
                        print(f"  object_id={obj_meta.object_id} roi_status={aoi.roi_status} "
                              f"lc_status={aoi.lc_status} dir_status={aoi.dir_status} obj_status={aoi.obj_status}")

pipeline = Pipeline("analytics-demo")
flow = Flow(pipeline).batch_capture(SOURCE, width=1920, height=1080)
flow = flow.infer(PGIE_CONFIG)
flow = flow.track(ll_config_file=TRACKER_LL_CONFIG, ll_lib_file=TRACKER_LL_LIB)
flow = flow.analyze(ANALYTICS_CONFIG)
flow = flow.attach(what=Probe("analytics_probe", AnalyticsProbe()))
flow = flow.render(RenderMode.DISCARD, sync=False)
flow()
```

##### `attach(what, name='', tips='', properties=None)`
Attach a probe to the current flow.

**Parameters**:
- `what`: Probe instance or element name
- `name` (str, optional): Name for the probe. Not applicable when `what` is an explicitly created Probe object.
- `tips` (str, optional): Extra information for the custom object
- `properties` (dict, optional): Properties to set on the object.

**Returns**: Flow instance (for method chaining)

**Example**:
```python
from pyservicemaker import Probe
# Attach a custom probe (name is embedded in the Probe object)
flow.attach(Probe("my-probe", MyProbe()))

# Attach built-in probe by module name and name the probe by 'name'
flow = flow.attach(
            what="measure_fps_probe",
            name="fps_probe"
        )
```

##### `render()`
Add rendering stage to the pipeline.

**Returns**: Flow instance (for method chaining)

**Example**:
```python
flow.render()
```

##### `__call__()` (Invocation)
Execute the pipeline (start and wait).

**Example**:
```python
flow()  # Starts and waits for completion
```

### Complete Flow API Example

```python
from pyservicemaker import Pipeline, Flow, Probe, BatchMetadataOperator

class ObjectCounter(BatchMetadataOperator):
    def handle_metadata(self, batch_meta):
        for frame_meta in batch_meta.frame_items:
            # IMPORTANT: object_items is an ITERATOR - cannot use len()
            obj_count = 0
            for obj in frame_meta.object_items:
                obj_count += 1
            print(f"Frame {frame_meta.frame_number}: {obj_count} objects")

def main():
    pipeline = Pipeline("my-pipeline")
    flow = Flow(pipeline)
    
    flow.batch_capture(["/path/to/video.h264"]) \
        .infer("/path/to/inference_config.txt") \  # Must be INI-style text format
        .attach(Probe("counter", ObjectCounter())) \
        .render()()
    
if __name__ == "__main__":
    main()
```

---

## Metadata API

### CRITICAL: Iterator Handling

**⚠️ WARNING**: Properties like `frame_meta.object_items`, `frame_meta.tensor_items`, and `frame_meta.user_items` return **ITERATORS**, not lists!

**Common Mistakes to Avoid**:
```python
# ❌ WRONG - Will crash with "TypeError: object of type 'iterator' has no len()"
count = len(frame_meta.object_items)

# ❌ WRONG - Iterator can only be consumed once
for obj in frame_meta.object_items:
    process(obj)
for obj in frame_meta.object_items:  # This loop will be empty!
    do_something(obj)
```

**Correct Patterns**:
```python
# ✅ CORRECT - Count by iterating
obj_count = 0
for obj in frame_meta.object_items:
    obj_count += 1
    process(obj)

# ✅ CORRECT - If you need to iterate multiple times, convert to list first
# (only if you actually need multiple iterations)
object_list = list(frame_meta.object_items)
count = len(object_list)
for obj in object_list:
    process(obj)
```

---

### BatchMetadataOperator
Base class for implementing custom metadata processing.

**Methods**:

##### `handle_metadata(batch_meta)`
Override this method to process batch metadata.

**Parameters**:
- `batch_meta`: BatchMetadata object containing frame and object metadata

**Example**:
```python
class MyOperator(BatchMetadataOperator):
    def handle_metadata(self, batch_meta):
        for frame_meta in batch_meta.frame_items:
            # Process each frame
            # NOTE: object_items is an ITERATOR, not a list!
            for object_meta in frame_meta.object_items:
                # Process each object
                pass
```

### BatchMetadata Object

**Properties**:
- `frame_items`: List of FrameMetadata objects
- Methods for acquiring metadata objects

**Methods**:
- `acquire_object_meta()`: Create new object metadata
- `acquire_display_meta()`: Create new display metadata
- `acquire_user_meta()`: Create new user metadata
- `acquire_event_message_meta()`: Create new `EventMessageUserMetadata` for nvmsgconv (see EventMessageUserMetadata section below)

### FrameMetadata Object

**Properties**:
- `frame_number`: Frame number (int)
- `pad_index`: Source pad index (int)
- `batch_id`: Location of frame in the batch (int)
- `source_id`: Source ID of the frame, e.g., camera ID (int)
- `source_width`: Width of the frame at input to streammux (int)
- `source_height`: Height of the frame at input to streammux (int)
- `pipeline_width`: Width of the frame at output of streammux (int)
- `pipeline_height`: Height of the frame at output of streammux (int)
- `buffer_pts`: Presentation timestamp (PTS) of the frame in nanoseconds (int)
- `ntp_timestamp`: NTP timestamp of the frame (int)
- `object_items`: **ITERATOR** of ObjectMetadata objects (NOT a list - cannot use `len()`)
- `tensor_items`: **ITERATOR** of TensorOutputUserMetadata objects (NOT a list - cannot use `len()`)
- `segmentation_items`: **ITERATOR** of SegmentationUserMetadata objects (NOT a list - cannot use `len()`)
- `nvdsanalytics_frame_items`: **ITERATOR** of AnalyticsFrameMeta objects (NOT a list - cannot use `len()`)
**⚠️ IMPORTANT**: The `*_items` properties return iterators that can only be consumed once. See "CRITICAL: Iterator Handling" section above.

**⚠️ NOTE**: There is no `timestamp` property. Use `buffer_pts` for PTS timestamp or `ntp_timestamp` for NTP timestamp.

**Methods**:
- `append(meta)`: Add metadata to frame

### ObjectMetadata Object

**Properties**:
- `class_id`: Class ID (int)
- `confidence`: Confidence score (float)
- `object_id`: Unique tracking ID assigned by tracker (int). Value is `0xFFFFFFFFFFFFFFFF` (UNTRACKED_OBJECT_ID) if object has not been tracked.
- `tracker_confidence`: Confidence value from tracker (float). Set to -0.1 for KLT and IOU trackers.
- `rect_params`: Rectangle parameters object
  - `left`: Left coordinate (float)
  - `top`: Top coordinate (float)
  - `width`: Width (float)
  - `height`: Height (float)
  - `border_width`: Border width (int)
  - `border_color`: Border color (Color object)
- `label`: String describing the object class
- `text_params`: Text parameters for OSD display (NvOSD_TextParams)
- `mask_params`: Mask parameters for object overlay (NvOSD_MaskParams)
- `classifier_items`: **ITERATOR** of ClassifierMetadata objects. (NOT a list - cannot use `len()`)
- `tensor_items`: **ITERATOR** of TensorOutputUserMetadata objects. (NOT a list - cannot use `len()`)
- `nvdsanalytics_obj_items`: **ITERATOR** of AnalyticsObjInfo objects. (NOT a list - cannot use `len()`)

**Note**: The attribute is `object_id`, NOT `tracking_id`. This is the unique ID assigned by the tracker to track objects across frames.

### RectParams Object

**Properties**:
- `left`, `top`, `width`, `height`: Coordinates and dimensions
- `border_width`: Border width
- `border_color`: Border color (Color object)

### TensorOutputUserMetadata Object

**Methods**:
- `as_tensor_output()`: Get tensor output object
  - `get_layers()`: Get output layers dictionary

**Example**:
```python
for user_meta in frame_meta.tensor_items:
    tensor_output = user_meta.as_tensor_output()
    layers = tensor_output.get_layers()
    # layers is a dict: {"layer_name": tensor, ...}
```

### SegmentationUserMetadata Object

**Properties**:
- `unique_id`: Unique id of the component that generates the segmentation output.
- `classes`: Number of classes in the segmentation output. |
- `width`, `height`: Width and height of the segmentation mask array.
- `class_map`: Class map array of the segmentation output; shape `(height, width)`, dtype int. Each pixel holds the class index.
- `class_probabilities_map`: Class probabilities map array; shape `(height, width, classes)`, dtype float. Optional; may be empty if not produced by the model.

**Example**:
```python
from pyservicemaker import Pipeline, Flow, BatchMetadataOperator

class MyOperator(BatchMetadataOperator):
    def handle_metadata(self, batch_meta):
        for frame_meta in batch_meta.frame_items:
            # frame_meta is FrameMetadata
            for user_meta in frame_meta.segmentation_items:
                # user_meta is UserMetadata (segmentation type)
                seg_meta = user_meta.as_segmentation()
                if seg_meta:  # cast is valid when meta type matches
                    # Use SegmentationUserMetadata attributes
                    print("unique_id:", seg_meta.unique_id)
                    print("classes:", seg_meta.classes)
                    print("width:", seg_meta.width, "height:", seg_meta.height)
                    # class_map: (height, width) int array
                    print("class_map shape:", seg_meta.class_map.shape)
                    # class_probabilities_map: (height, width, classes) float array, if present
                    if seg_meta.class_probabilities_map.size > 0:
                        print("class_probabilities_map shape:", seg_meta.class_probabilities_map.shape)
```

### AnalyticsFrameMeta object

**Properties**:
- `oc_status`: Map of overcrowding status per ROI (key = ROI label). Type: dict[str, bool]
- `obj_in_roi_cnt`: Map of count of valid objects in each ROI (key = ROI label). Type: dict[str, int] 
- `obj_lc_curr_cnt`: Map of line-crossing count in the current frame per line (key = line/ROI label). Type: dict[str, int]              |  |
- `obj_lc_cum_cnt`: Map of cumulative line-crossing count per line (key = line/ROI label). Type: dict[str, int]
- `unique_id`: Unique identifier for the nvdsanalytics instance.
- `obj_cnt`: Map of object count per class ID (key = class ID). Type: dict[int, int]

**Example**:
```python
from pyservicemaker import Pipeline, Flow, BatchMetadataOperator

class MyOperator(BatchMetadataOperator):
    def handle_metadata(self, batch_meta):
        for frame_meta in batch_meta.frame_items:
            # frame_meta is FrameMetadata
            for user_meta in frame_meta.nvdsanalytics_frame_items:
                # user_meta is UserMetadata (nvdsanalytics frame type)
                analytics_frame_meta = user_meta.as_nvdsanalytics_frame()
                if analytics_frame_meta:  # cast is valid when meta type matches
                    # Use AnalyticsFrameMeta attributes
                    print("Frame {0} component id: {1}".format(analytics_frame_meta.unique_id))
                    print("Frame {0} overcrowding status: {1}".format(frame_meta.frame_number, analytics_frame_meta.oc_status))
                    print("Frame {0} object in ROI count: {1}".format(frame_meta.frame_number, analytics_frame_meta.obj_in_roi_cnt))
                    print("Frame {0} object line crossing current count: {1}".format(frame_meta.frame_number, analytics_frame_meta.obj_lc_curr_cnt))
                    print("Frame {0} object line crossing cumulative count: {1}".format(frame_meta.frame_number, analytics_frame_meta.obj_lc_cum_cnt))
                    print("Frame {0} object count: {1}".format(frame_meta.frame_number,, analytics_frame_meta.obj_cnt))
```

### AnalyticsObjInfo object

**Properties**:
- `roi_status`: Array of ROI labels in which this object is present. Type: list[str].
- `oc_status`: Array of OverCrowding labels in which this object is present. Type: list[str].
- `lc_status`: Array of line-crossing labels which this object has crossed. Type: list[str].
- `dir_status`: Direction string for the tracked object.
- `unique_id`: Unique identifier for the nvdsanalytics instance.
- `obj_status`: Status string for the tracked object.

**Note**: AnalyticsObjInfo is stored as **user metadata** on the object. **ObjectMetadata** exposes an iterator **`nvdsanalytics_obj_items`** over user metadata of type **NVDS_USER_OBJ_META_NVDSANALYTICS**; each element is a **UserMetadata** instance, which you cast to **AnalyticsObjInfo** using **`as_nvdsanalytics_obj()`**.

**Example**:
```python
from pyservicemaker import Pipeline, Flow, BatchMetadataOperator

class MyOperator(BatchMetadataOperator):
    def handle_metadata(self, batch_meta):
        for frame_meta in batch_meta.frame_items:
            for obj_meta in frame_meta.object_items:
                # obj_meta is ObjectMetadata
                for user_meta in obj_meta.nvdsanalytics_obj_items:
                    # user_meta is UserMetadata (nvdsanalytics object type)
                    analytics_obj = user_meta.as_nvdsanalytics_obj()
                    if analytics_obj:  # cast is valid when meta type matches
                        # Use AnalyticsObjInfo attributes
                        print("Object {0} ROI status: {1}".format(object_meta.object_id, analytics_obj.roi_status))
                        print("Object {0} overcrowding status: {1}".format(object_meta.object_id, analytics_obj.oc_status))
                        print("Object {0} line crossing status: {1}".format(obj_meta.object_id, analytics_obj.lc_status))
                        print("Object {0} moving in direction: {1}".format(obj_meta.object_id, analytics_obj.dir_status))
                        print("Object {0} unique ID: {1}".format(object_meta.object_id, analytics_obj.unique_id))
                        print("Object {0} status: {1}".format(object_meta.object_id, analytics_obj.obj_status))
```

### ClassifierMetadata object

**Properties**:
- `n_labels`: Number of output labels of the classifier.
- `unique_component_id`: Unique id of the component that generates the classifier metadata.

**Methods**:
- `get_n_label(n)`: Returns the nth label of the classifier (0-based index `n`).

**Example**:
```python
from pyservicemaker import Pipeline, Flow, BatchMetadataOperator

class MyOperator(BatchMetadataOperator):
    def handle_metadata(self, batch_meta):
        for frame_meta in batch_meta.frame_items:
            for obj_meta in frame_meta.object_items:
                for classifier_meta in obj_meta.classifier_items:
                    # classifier_meta is ClassifierMetadata
                    print("n_labels:", classifier_meta.n_labels)
                    print("unique_component_id:", classifier_meta.unique_component_id)
                    for i in range(classifier_meta.n_labels):
                        label = classifier_meta.get_n_label(i)
                        print(f"  label[{i}]:", label)
```

---

## OSD (On-Screen Display) API

### osd Module

Provides classes for creating OSD elements.

#### Text
Text display element.

**Properties**:
- `display_text`: Text content (bytes)
- `x_offset`: X position (int)
- `y_offset`: Y position (int)
- `font`: Font object
- `set_bg_color`: Enable background color (bool)
- `bg_color`: Background color (Color object)

#### Font
Font specification.

**Properties**:
- `name`: Font family (FontFamily enum)
- `size`: Font size (int)
- `color`: Font color (Color object)

#### FontFamily Enum
- `Serif`
- `Sans`
- `Mono`

#### Color
Color specification (RGBA).

**Properties**:
- Red, Green, Blue, Alpha values (0.0 to 1.0)

**Constructor**:
```python
color = osd.Color(1.0, 0.0, 0.0, 1.0)  # Red, fully opaque
```

### DisplayMeta Object

**Methods**:
- `add_text(text)`: Add text element
- `add_rect(rect)`: Add rectangle element
- `add_line(line)`: Add line element
- `add_circle(circle)`: Add circle element

### Example: Adding Text Overlay

```python
from pyservicemaker import osd

display_meta = batch_meta.acquire_display_meta()
text = osd.Text()
text.display_text = b"Object Count: 5"
text.x_offset = 10
text.y_offset = 12
text.font.name = osd.FontFamily.Serif
text.font.size = 12
text.font.color = osd.Color(1.0, 1.0, 1.0, 1.0)
text.set_bg_color = True
text.bg_color = osd.Color(0.0, 0.0, 0.0, 1.0)
display_meta.add_text(text)
frame_meta.append(display_meta)
```

---

## Postprocessing API

### postprocessing Module

Provides classes for custom postprocessing.

#### ObjectDetectorOutputConverter
Base class for converting tensor outputs to object detections.

**Methods**:

##### `__call__(output_layers)`
Convert tensor outputs to list of bounding boxes.

**Parameters**:
- `output_layers` (dict): Dictionary of layer names to tensors

**Returns**: List of bounding boxes `[class_id, confidence, x1, y1, x2, y2]`

**Example**:
```python
from pyservicemaker import postprocessing
import torch

class MyConverter(postprocessing.ObjectDetectorOutputConverter):
    def __call__(self, output_layers):
        outputs = []
        bbox_tensor = output_layers.get('bbox_layer')
        conf_tensor = output_layers.get('conf_layer')
        
        if bbox_tensor and conf_tensor:
            # Convert DLPack tensors to PyTorch
            bbox = torch.utils.dlpack.from_dlpack(bbox_tensor)
            conf = torch.utils.dlpack.from_dlpack(conf_tensor)
            
            # Process and convert to format: [class_id, confidence, x1, y1, x2, y2]
            # ... processing logic ...
            
        return outputs
```

**Usage**:
```python
converter = MyConverter()
objects = converter(output_layers)
# objects is list of [class_id, confidence, x1, y1, x2, y2]
```

---

## Probe API

### Probe Class

Wrapper for attaching callback functions to pipeline elements.

**Constructor** (two overloads):
```python
from pyservicemaker import Probe

# Overload 1: Metadata-level probe (most common)
probe = Probe("probe-name", BatchMetadataOperator())

# Overload 2: Buffer-level probe (for raw buffer access)
probe = Probe("probe-name", BufferOperator())
```

**Parameters**:
- `name` (str): Name of the probe
- `operator`: `BatchMetadataOperator` instance **or** `BufferOperator` instance

**Built-in Probes**:
- `"measure_fps_probe"`: Measures FPS
- `"measure_latency_probe"`: Measures latency
- `"add_message_meta_probe"`: Automatically generates `EventMessageUserMetadata` (NvDsEventMsgMeta) from object metadata for downstream `nvmsgconv` consumption. Use this when `msg2p-newapi=0` and you don't need custom control over sensor mappings.

**Example**:
```python
# Custom probe
probe = Probe("my-probe", MyOperator())

# Built-in probe
pipeline.attach("infer", "measure_fps_probe", "fps-probe")

# Built-in message meta probe (for Kafka with msg2p-newapi=0)
pipeline.attach("osd", "add_message_meta_probe", "metadata generator")
```

### BufferOperator Class

Low-level probe interface for accessing raw `Buffer` objects flowing through a pad. Use `BufferOperator` instead of `BatchMetadataOperator` when you need to inspect or count raw buffers that do NOT carry batch metadata — e.g., on the `src` pad of `nvdsdynamicsrcbin` (before any `nvstreammux`).

**Methods to Override**:

##### `handle_buffer(buffer)`
Called for every buffer that passes through the probed pad.

**Parameters**:
- `buffer` (Buffer): The buffer flowing through the pad

**Returns**: `bool` — `True` to pass the buffer downstream (keep), `False` to drop it.

**Buffer Object Properties/Methods** (available inside `handle_buffer`):
- `buffer.timestamp` (int): PTS timestamp of the buffer
- `buffer.get_chunk_id(batch_id)` (int): Chunk/source ID assigned by `nvdsdynamicsrcbin`. Always 0 for `uridecodebin`.
- `buffer.extract(batch_id)` → `Tensor`: Extract frame data as a tensor

**Example**:
```python
from pyservicemaker import Pipeline, Probe, BufferOperator

class MyBufferProbe(BufferOperator):
    def __init__(self):
        super().__init__()
        self.count = 0

    def handle_buffer(self, buffer):
        self.count += 1
        print(f"Buffer #{self.count}  ts={buffer.timestamp}")
        return True

probe = MyBufferProbe()
pipeline.attach("dynamicsrcbin", Probe("buf-probe", probe), tips="src")
```

---

## EventMessageUserMetadata

`EventMessageUserMetadata` wraps `NvDsEventMsgMeta` and is **required** by `nvmsgconv` when `msg2p-newapi` is `0` (the default / legacy API). Without it, nvmsgconv silently produces zero messages.

It is acquired from the `BatchMetadata` pool and must be populated and appended to the corresponding `FrameMetadata`.

### Acquiring and Generating Event Message Metadata

```python
event_msg = batch_meta.acquire_event_message_meta()  # Acquire from pool
event_msg.generate(object_meta, frame_meta, sensor_id, uri, labels)  # Populate
frame_meta.append(event_msg)  # Attach to frame
```

**Parameters for `generate()`**:
- `object_meta` (ObjectMetadata): The detected object to create a message for
- `frame_meta` (FrameMetadata): The frame containing the object
- `sensor_id` (str): Camera/sensor identifier string (e.g., `"Camera1"`)
- `uri` (str): Source URI of the stream (e.g., `"file:///path/to/video.mp4"`)
- `labels` (list[str]): List of class label strings matching class IDs (e.g., `["person", "bag", "face"]`)

### Two Approaches

#### Approach 1: Built-in Probe (Simple)

Use the built-in `"add_message_meta_probe"` -- no custom Python class needed:

```python
# Attach AFTER inference/tracker, BEFORE nvmsgconv
pipeline.attach("osd", "add_message_meta_probe", "metadata generator")
```

Reference: `deepstream_test4_app` sample
(`/opt/nvidia/deepstream/deepstream/service-maker/sources/apps/python/pipeline_api/deepstream_test4_app/deepstream_test4.py`)

#### Approach 2: Custom EventMessageGenerator (Full Control)

For multi-camera pipelines where you need control over sensor mappings:

```python
from pyservicemaker import Pipeline, Probe, BatchMetadataOperator, SensorInfo

class EventMessageGenerator(BatchMetadataOperator):
    """Generate EventMessageUserMetadata for downstream nvmsgconv."""

    def __init__(self, sensor_map, labels):
        super().__init__()
        self._sensor_map = sensor_map  # dict: source_id -> SensorInfo or str
        self._labels = labels          # list of class label strings

    def handle_metadata(self, batch_meta, frame_interval=1):
        for frame_meta in batch_meta.frame_items:
            frame_num = frame_meta.frame_number
            for object_meta in frame_meta.object_items:
                if not (frame_num % frame_interval):
                    event_msg = batch_meta.acquire_event_message_meta()
                    if event_msg:
                        source_id = frame_meta.source_id
                        sensor_info = self._sensor_map.get(source_id)
                        sensor_id = sensor_info.sensor_id if sensor_info else "N/A"
                        uri = sensor_info.uri if sensor_info else "N/A"
                        event_msg.generate(
                            object_meta, frame_meta, sensor_id, uri, self._labels
                        )
                        frame_meta.append(event_msg)

# Attach probe upstream of nvmsgconv
labels = ["car", "bicycle", "person", "roadsign"]
sensor_map = {0: SensorInfo(sensor_id="Camera1", sensor_name="cam1", uri="file:///video1.mp4")}
pipeline.attach("tracker", Probe("event_msg_gen", EventMessageGenerator(sensor_map, labels)))
```

Reference: `deepstream_test5_app` sample
(`/opt/nvidia/deepstream/deepstream/service-maker/sources/apps/python/pipeline_api/deepstream_test5_app/deepstream_test5.py`)

### SensorInfo Class

Used to map source IDs to sensor metadata for `EventMessageGenerator`:

```python
from pyservicemaker import SensorInfo

sensor_info = SensorInfo(
    sensor_id="Camera1",       # Unique sensor identifier string
    sensor_name="front_cam",   # Human-readable name
    uri="rtsp://host/stream1"  # Source URI
)
```

---

## YAML Configuration Support

Pipelines can be created from YAML configuration files (for pipeline structure definition):

```python
pipeline = Pipeline("pipeline-name", "/path/to/pipeline_config.yml")
```

**Note**: This YAML config is for **pipeline structure** (elements, links, probes). The nvinfer `config-file-path` can point to either a YAML file (`.yml`) or INI-style text file (`.txt`) - both formats are supported.

### YAML Structure Example (Pipeline Definition)

```yaml
pipeline:
  name: my-pipeline
  elements:
    - name: src
      type: filesrc
      properties:
        location: /path/to/video.h264
    
    - name: parser
      type: h264parse
    
    - name: decoder
      type: nvv4l2decoder
    
    - name: mux
      type: nvstreammux
      properties:
        batch-size: 1
        width: 1920
        height: 1080
    
    - name: infer
      type: nvinfer
      properties:
        # nvinfer supports both YAML (.yml) and INI-style (.txt) config formats
        config-file-path: /path/to/pgie_config.yml
    
    - name: osd
      type: nvosdbin
    
    - name: sink
      type: nveglglessink
  
  links:
    - [src, parser, decoder]
    - [decoder, mux]
    - [mux, infer, osd, sink]
  
  probes:
    - element: infer
      probe-name: my-probe
      probe-type: custom
      operator: MyOperator
```

### nvinfer Configuration (Both Formats Supported)

The `config-file-path` for nvinfer supports **both YAML and INI-style text formats**:

**YAML Format** (`.yml`) - Recommended:
```yaml
# pgie_config.yml - YAML format for nvinfer
property:
  gpu-id: 0
  net-scale-factor: 0.00392156862745098
  onnx-file: /opt/nvidia/deepstream/deepstream/samples/models/Primary_Detector/resnet18_trafficcamnet_pruned.onnx
  labelfile-path: /opt/nvidia/deepstream/deepstream/samples/models/Primary_Detector/labels.txt
  batch-size: 1
  process-mode: 1
  model-color-format: 0
  network-mode: 2
  num-detected-classes: 4
  cluster-mode: 2

class-attrs-all:
  topk: 20
  pre-cluster-threshold: 0.2
```

**INI-style Format** (`.txt`):
```ini
# pgie_config.txt - INI-style format for nvinfer
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
cluster-mode=2

[class-attrs-all]
topk=20
pre-cluster-threshold=0.2
```

---

## Common Patterns and Examples

### Pattern 1: Single Stream with Detection

```python
from pyservicemaker import Pipeline, Probe, BatchMetadataOperator
import platform

def single_stream_detection(video_path, config_path):
    pipeline = (Pipeline("single-stream")
        .add("filesrc", "src", {"location": video_path})
        .add("h264parse", "parser")
        .add("nvv4l2decoder", "decoder")
        .add("nvstreammux", "mux", {"batch-size": 1, "width": 1920, "height": 1080})
        .add("nvinfer", "infer", {"config-file-path": config_path})
        .add("nvosdbin", "osd")
        .add("nv3dsink" if platform.processor() == "aarch64" else "nveglglessink", "sink")
        .link("src", "parser", "decoder")
        .link(("decoder", "mux"), ("", "sink_%u"))
        .link("mux", "infer", "osd", "sink")
        .start()
        .wait())
```

### Pattern 2: Multi-Stream with Detection

**Pattern 2a: Multi-Stream from Files**
```python
def multi_stream_detection(video_paths, config_path):
    pipeline = Pipeline("multi-stream")
    
    # Add sources
    for i, path in enumerate(video_paths):
        pipeline.add("filesrc", f"src{i}", {"location": path})
        pipeline.add("h264parse", f"parser{i}")
        pipeline.add("nvv4l2decoder", f"decoder{i}")
    
    # Add muxer
    pipeline.add("nvstreammux", "mux", {
        "batch-size": len(video_paths),
        "width": 1920,
        "height": 1080
    })
    
    # Add processing elements
    pipeline.add("nvinfer", "infer", {"config-file-path": config_path})
    pipeline.add("nvosdbin", "osd")
    pipeline.add("nveglglessink", "sink")
    
    # Link sources to muxer
    for i in range(len(video_paths)):
        pipeline.link(f"src{i}", f"parser{i}", f"decoder{i}")
        pipeline.link((f"decoder{i}", "mux"), ("", "sink_%u"))  # CRITICAL: Use "sink_%u", NOT f"sink_{i}"
    
    # Link processing chain
    pipeline.link("mux", "infer", "osd", "sink")
    pipeline.start().wait()
```

**Pattern 2b: Multi-Stream RTSP with nvurisrcbin**
```python
def multi_rtsp_stream_detection(rtsp_urls, config_path):
    """
    Process multiple RTSP streams using nvurisrcbin.
    
    Args:
        rtsp_urls: List of RTSP stream URLs (e.g., ["rtsp://...", "rtsp://..."])
        config_path: Path to inference config file
    """
    pipeline = Pipeline("multi-rtsp-stream")
    
    # Add RTSP sources with nvurisrcbin (auto-detects codec and creates dynamic pads)
    for i, url in enumerate(rtsp_urls):
        pipeline.add("nvurisrcbin", f"src{i}", {"uri": url})
    
    # Add muxer for batching
    pipeline.add("nvstreammux", "mux", {
        "batch-size": len(rtsp_urls),
        "width": 1920,
        "height": 1080,
        "batched-push-timeout": 40000,
        "live-source": 1  # Important for RTSP streams
    })
    
    # Add processing elements
    pipeline.add("nvinfer", "infer", {"config-file-path": config_path, "batch-size": len(rtsp_urls)})
    pipeline.add("nvmultistreamtiler", "tiler", {"rows": 2, "columns": 2})
    pipeline.add("nvosdbin", "osd")
    pipeline.add("nveglglessink", "sink")
    
    # Link sources to muxer - CRITICAL: Use "sink_%u" pad template, NOT f"sink_{i}"
    for i in range(len(rtsp_urls)):
        # nvurisrcbin has dynamic src pad, so link directly to mux sink pad template
        pipeline.link((f"src{i}", "mux"), ("", "sink_%u"))  # CORRECT - pad template auto-assigns sink_0, sink_1, etc.
        # WRONG: pipeline.link((f"src{i}", "mux"), ("", f"sink_{i}"))  # This will FAIL!
    
    # Link processing chain
    pipeline.link("mux", "infer", "tiler", "osd", "sink")
    pipeline.start().wait()
```

### Pattern 3: Custom Metadata Processing

```python
class CustomProcessor(BatchMetadataOperator):
    def handle_metadata(self, batch_meta):
        for frame_meta in batch_meta.frame_items:
            # Count objects by class
            class_counts = {}
            for obj in frame_meta.object_items:
                class_id = obj.class_id
                class_counts[class_id] = class_counts.get(class_id, 0) + 1
            
            # Add text overlay
            display_meta = batch_meta.acquire_display_meta()
            text = osd.Text()
            text.display_text = f"Objects: {sum(class_counts.values())}".encode('ascii')
            text.x_offset = 10
            text.y_offset = 10
            text.font.name = osd.FontFamily.Serif
            text.font.size = 12
            text.font.color = osd.Color(1.0, 1.0, 1.0, 1.0)
            display_meta.add_text(text)
            frame_meta.append(display_meta)

# Attach probe
pipeline.attach("infer", Probe("processor", CustomProcessor()))
```

### Pattern 4: Tensor-Based Custom Postprocessing

```python
class TensorConverter(postprocessing.ObjectDetectorOutputConverter):
    def __call__(self, output_layers):
        outputs = []
        # Extract tensors
        bbox_layer = output_layers.get('bbox')
        conf_layer = output_layers.get('conf')
        
        if bbox_layer and conf_layer:
            import torch
            bbox = torch.utils.dlpack.from_dlpack(bbox_layer)
            conf = torch.utils.dlpack.from_dlpack(conf_layer)
            
            # Process tensors and convert to [class_id, conf, x1, y1, x2, y2]
            # ... processing logic ...
            
        return outputs

class TensorProcessor(BatchMetadataOperator):
    def __init__(self):
        super().__init__()
        self._converter = TensorConverter()
    
    def handle_metadata(self, batch_meta):
        for frame_meta in batch_meta.frame_items:
            for tensor_meta in frame_meta.tensor_items:
                output_layers = tensor_meta.as_tensor_output().get_layers()
                objects = self._converter(output_layers)
                
                # Create object metadata
                for obj in objects:
                    obj_meta = batch_meta.acquire_object_meta()
                    obj_meta.class_id = obj[0]
                    obj_meta.confidence = obj[1]
                    obj_meta.rect_params.left = obj[2]
                    obj_meta.rect_params.top = obj[3]
                    obj_meta.rect_params.width = obj[4] - obj[2]
                    obj_meta.rect_params.height = obj[5] - obj[3]
                    frame_meta.append(obj_meta)

# Enable tensor output in nvinfer
pipeline["infer"].set({"output-tensor-meta": 1})
pipeline.attach("infer", Probe("tensor-processor", TensorProcessor()))
```

### Pattern 5: Cloud Integration (Kafka)

```python
from kafka import KafkaProducer
import json

class KafkaSender(BatchMetadataOperator):
    def __init__(self, kafka_config):
        super().__init__()
        self.producer = KafkaProducer(
            bootstrap_servers=kafka_config['servers'],
            value_serializer=lambda v: json.dumps(v).encode('utf-8')
        )
        self.topic = kafka_config['topic']
    
    def handle_metadata(self, batch_meta):
        for frame_meta in batch_meta.frame_items:
            objects = [
                {
                    "class_id": obj.class_id,
                    "confidence": obj.confidence,
                    "bbox": {
                        "left": obj.rect_params.left,
                        "top": obj.rect_params.top,
                        "width": obj.rect_params.width,
                        "height": obj.rect_params.height
                    },
                    "object_id": obj.object_id  # Tracking ID assigned by tracker
                }
                for obj in frame_meta.object_items
            ]
            
            message = {
                "frame_number": frame_meta.frame_number,
                "source_id": frame_meta.source_id,
                "buffer_pts": frame_meta.buffer_pts,  # PTS timestamp in nanoseconds
                "objects": objects
            }
            
            self.producer.send(topic=self.topic, value=message)
    
    def __del__(self):
        if hasattr(self, 'producer'):
            self.producer.flush()
            self.producer.close()

# Usage
kafka_config = {
    "servers": "localhost:9092",
    "topic": "analytics"
}
pipeline.attach("infer", Probe("kafka-sender", KafkaSender(kafka_config)))
```

---

## Best Practices

1. **Use Pipeline API for fine-grained control**, Flow API for rapid prototyping
2. **Always use hardware-accelerated decoders** (nvv4l2decoder)
3. **Configure appropriate batch sizes** for your use case
4. **Use probes for custom processing** instead of modifying plugins
5. **Handle KeyboardInterrupt** properly (use multiprocessing.Process)
6. **Flush and close Kafka producers** in cleanup methods
7. **Use tensor metadata** for custom postprocessing when needed
8. **Match tracker dimensions** to inference input dimensions
9. **Use YAML configs** for complex pipelines to improve maintainability
10. **Monitor GPU memory** when processing multiple streams
11. **Use correct Queue types for inter-process/thread communication**:
    - `queue.Queue` → Use with `threading.Thread` (same process)
    - `multiprocessing.Queue` → Use with `multiprocessing.Process` (cross-process)
    - Using `queue.Queue` with `multiprocessing.Process` will silently lose data!

---

## Error Handling

```python
from multiprocessing import Process
import sys

def run_pipeline():
    try:
        pipeline.start().wait()
    except Exception as e:
        print(f"Pipeline error: {e}")
        sys.exit(1)

if __name__ == "__main__":
    process = Process(target=run_pipeline)
    try:
        process.start()
        process.join()
    except KeyboardInterrupt:
        print("\nInterrupted. Terminating...")
        process.terminate()
        process.join()
```

---

## Pipeline State and Message Handling API

### Pipeline States

DeepStream pipelines follow GStreamer state transitions:

| State | Description |
|-------|-------------|
| `PipelineState.NULL` | Initial state, no resources allocated |
| `PipelineState.READY` | Resources allocated, not processing |
| `PipelineState.PAUSED` | Paused, ready to play |
| `PipelineState.PLAYING` | Processing data |

### Pipeline Methods for State Management

#### `prepare(message_handler)`
Prepare the pipeline for activation with a message handler.

**Parameters**:
- `message_handler` (callable): Function to receive pipeline messages

**Returns**: Pipeline instance (for method chaining)

**Example**:
```python
def on_message(message):
    if isinstance(message, StateTransitionMessage):
        print(f"State changed to: {message.new_state}")
    elif isinstance(message, DynamicSourceMessage):
        print(f"Source event: {message.source_id}")

pipeline.prepare(on_message)
```

#### `activate()`
Activate the pipeline (set to PLAYING state).

**Returns**: Pipeline instance (for method chaining)

#### `deactivate()`
Deactivate the pipeline (set to NULL state).

**Returns**: Pipeline instance (for method chaining)

#### `wait()`
Wait for the pipeline to complete (blocking).

**Returns**: None

### Message Types

#### StateTransitionMessage
Indicates a pipeline state change.

**Properties**:
- `origin` (str): Element name that changed state
- `old_state` (PipelineState): Previous state
- `new_state` (PipelineState): New state

**Example**:
```python
from pyservicemaker import StateTransitionMessage, PipelineState

def on_message(message):
    if isinstance(message, StateTransitionMessage):
        if message.new_state == PipelineState.PLAYING:
            print(f"Element {message.origin} is now playing")
        elif message.new_state == PipelineState.NULL:
            print(f"Element {message.origin} stopped")
```

#### DynamicSourceMessage
Indicates a dynamic source change (add/remove).

**Properties**:
- `source_id` (int): Unique source identifier
- `source_added` (bool): True if added, False if removed
- `sensor_id` (str): Sensor identifier
- `sensor_name` (str): Human-readable sensor name
- `uri` (str): Source URI (for added sources)

**Example**:
```python
from pyservicemaker import DynamicSourceMessage

sensor_map = {}

def on_message(message):
    if isinstance(message, DynamicSourceMessage):
        if message.source_added:
            sensor_map[message.source_id] = {
                "sensor_id": message.sensor_id,
                "sensor_name": message.sensor_name,
                "uri": message.uri
            }
            print(f"Added source: {message.sensor_name}")
        else:
            if message.source_id in sensor_map:
                del sensor_map[message.source_id]
            print(f"Removed source: {message.source_id}")
```

### Complete Message Handling Example

```python
from pyservicemaker import (
    Pipeline, PipelineState, StateTransitionMessage,
    DynamicSourceMessage, SensorInfo, utils
)

def run_pipeline_with_messages(config_file):
    """Pipeline with comprehensive message handling"""
    pipeline = Pipeline("message-aware-pipeline", config_file=config_file)
    
    # Track sources
    active_sources = {}
    
    # Performance monitor
    perf_monitor = utils.PerfMonitor(
        batch_size=4,
        interval=5,
        source_type="nvmultiurisrcbin"
    )
    perf_monitor.apply(pipeline["tiler"], "sink")
    
    def handle_message(message):
        """Handle pipeline messages"""
        if isinstance(message, StateTransitionMessage):
            # Handle state transitions
            if message.new_state == PipelineState.PLAYING:
                if message.origin == "sink":
                    print("Pipeline fully started")
            elif message.new_state == PipelineState.NULL:
                print(f"Element {message.origin} stopped")
        
        elif isinstance(message, DynamicSourceMessage):
            # Handle dynamic source changes
            source_id = message.source_id
            
            if message.source_added:
                # Track new source
                active_sources[source_id] = SensorInfo(
                    sensor_id=message.sensor_id,
                    sensor_name=message.sensor_name,
                    uri=message.uri
                )
                
                # Add to performance monitor
                perf_monitor.add_stream(
                    source_id=source_id,
                    uri=message.uri,
                    sensor_id=message.sensor_id,
                    sensor_name=message.sensor_name
                )
                
                print(f"Source added: {message.sensor_name} ({message.uri})")
            else:
                # Remove source
                if source_id in active_sources:
                    del active_sources[source_id]
                perf_monitor.remove_stream(source_id)
                print(f"Source removed: {source_id}")
    
    # Prepare with message handler
    pipeline.prepare(handle_message)
    
    # Activate and wait
    pipeline.activate()
    pipeline.wait()

# Run
run_pipeline_with_messages("pipeline_config.yaml")
```

---

## Signal Handling API

### Signal Module

The `signal` module provides classes for custom signal handling.

#### Emitter Class
Base class for signal emitters.

**Methods**:
- `attach(signal_name, element)`: Attach signal to element
- `set(properties)`: Set properties on the emitter

#### Handler Class
Base class for signal handlers.

### Smart Recording Signals

Smart recording uses signals for start/stop events.

**Signal Names**:
- `"start-sr"`: Start smart recording
- `"stop-sr"`: Stop smart recording
- `"sr-done"`: Recording complete

**Example**:
```python
from pyservicemaker import Pipeline, CommonFactory

pipeline = Pipeline("smart-recording")
# ... build pipeline ...

# Create smart recording controller
sr_controller = CommonFactory.create("smart_recording_action", "sr_controller")

if sr_controller:
    sr_controller.set({
        "proto-lib": "/opt/nvidia/deepstream/deepstream/lib/libnvds_kafka_proto.so",
        "conn-str": "localhost;9092",
        "topic-list": "sr-events"
    })
    
    # Attach signals to source element
    sr_controller.attach("start-sr", pipeline["src"])
    sr_controller.attach("stop-sr", pipeline["src"])
    
    # Attach signal handler for completion
    pipeline.attach("src", "smart_recording_signal", "sr", "sr-done")
```

---

## Dynamic Source Management

### nvmultiurisrcbin Properties

For dynamic source management, use `nvmultiurisrcbin`:

| Property | Type | Description |
|----------|------|-------------|
| `uri-list` | string | Comma-separated initial URIs |
| `sensor-id-list` | string | Comma-separated sensor IDs |
| `sensor-name-list` | string | Comma-separated sensor names |
| `max-batch-size` | int | Maximum number of sources |

### Adding/Removing Sources Dynamically

Sources are added/removed via REST API or programmatically through source management APIs.

```python
from pyservicemaker import Pipeline, SourceConfig, SensorInfo

# Load initial sources from config
source_config = SourceConfig()
source_config.load("sources.yaml")

# Create pipeline
pipeline = Pipeline("dynamic-sources", config_file="pipeline.yaml")

# Initial sensors
for i, sensor in enumerate(source_config.sensor_list):
    print(f"Initial source {i}: {sensor.sensor_name}")

# Handle dynamic changes via message handler
def on_message(message):
    if isinstance(message, DynamicSourceMessage):
        if message.source_added:
            print(f"New source: {message.sensor_name}")
        else:
            print(f"Source removed: {message.source_id}")

pipeline.prepare(on_message)
pipeline.activate()
pipeline.wait()
```

---

## SourceManager API (nvdsdynamicsrcbin)

`SourceManager` is a `SignalEmitter` that dynamically adds and removes sources on `nvdsdynamicsrcbin` at runtime. Unlike `nvmultiurisrcbin` (which uses REST API / config-based management), `SourceManager` gives direct programmatic control over individual file/URI sources through signal actions.

### Import

```python
from pyservicemaker._pydeepstream.signal import SourceManager
```

### Class: SourceManager

Inherits from `signal.Emitter` → `Object`.

**Constructor**:
```python
source_mgr = SourceManager("source_manager")
```

**Parameters**:
- `name` (str): Name of the SourceManager instance

### Methods

#### `attach(action_name, element)`
Attach the SourceManager to a pipeline element for a given action. Must be called for each action before using it.

**Supported actions**:
- `"add-source"` — enables `add_source()`
- `"remove-source"` — enables `remove_source()`
- `"terminate"` — enables `terminate()`

**Parameters**:
- `action_name` (str): One of `"add-source"`, `"remove-source"`, `"terminate"`
- `element`: The pipeline element (Node) to attach to — must be an `nvdsdynamicsrcbin`

**Example**:
```python
dsb_node = pipeline["dynamicsrcbin"]
source_mgr.attach("add-source", dsb_node)
source_mgr.attach("remove-source", dsb_node)
source_mgr.attach("terminate", dsb_node)
```

#### `add_source(source_name)`
Add a source (file path or URI) to the `nvdsdynamicsrcbin`.

**Parameters**:
- `source_name` (str): File path or URI of the source to add

**Returns**: `int` — a unique source ID (>= 0), or `-1` if the add failed

**Example**:
```python
sid = source_mgr.add_source("/path/to/video.h264")
if sid < 0:
    print("Failed to add source")
```

#### `remove_source(source_id)`
Remove a previously added source by its ID.

**Parameters**:
- `source_id` (int): The unique ID returned by `add_source()`

**Example**:
```python
source_mgr.remove_source(sid)
```

#### `terminate()`
Signal that no more sources will be added. After all currently queued sources finish processing, an EOS (End of Stream) is sent downstream.

**Example**:
```python
source_mgr.terminate()
```

---

This comprehensive API reference should help you build DeepStream applications using the Python Service Maker API effectively.

