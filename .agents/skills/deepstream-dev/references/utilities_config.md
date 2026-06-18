# Utilities and Configuration Classes

## Overview

The `pyservicemaker` module and its `utils` submodule provide a collection of utility classes for monitoring, configuration management, and helper patterns used in DeepStream application development. This document covers:

- **Part 1 -- Performance Monitoring Utilities**: Real-time FPS measurement, stream-level performance tracking, dynamic source monitoring, and model engine file hot-swapping via `PerfMonitor` and `EngineFileMonitor`.
- **Part 2 -- Configuration and Helper Classes**: Source configuration management (`SourceConfig`, `SensorInfo`, `CameraInfo`), smart recording configuration (`SmartRecordConfig`), custom postprocessing interfaces (`PostProcessing`, `ObjectDetectorOutputConverter`), and factory-based plugin creation (`CommonFactory`).

---

# Part 1: Performance Monitoring Utilities

The `pyservicemaker.utils` module provides utilities for monitoring pipeline performance and managing model engine files. These utilities are essential for:
- Real-time FPS (Frames Per Second) measurement
- Stream-level performance tracking
- Dynamic source monitoring
- Model engine file hot-swapping (On-The-Fly updates)
- Production deployment monitoring

## Core Classes

### PerfMonitor

A performance monitoring utility that tracks FPS and throughput for DeepStream pipelines.

**Constructor**:
```python
from pyservicemaker import utils

perf_monitor = utils.PerfMonitor(
    batch_size=4,              # Number of streams in batch
    interval=1,                # Measurement interval in seconds
    source_type="nvurisrcbin", # Source element type name
    show_name=True             # Show stream names in output
)
```

**Parameters**:
- `batch_size` (int): Number of streams in the pipeline batch
- `interval` (int): Performance measurement interval in seconds
- `source_type` (str): Type name of the source bin (e.g., "nvurisrcbin", "nvmultiurisrcbin")
- `show_name` (bool): Whether to show stream names in performance logs (default: True)

**Methods**:

#### `apply(element, pad_name)`
Attach the performance monitor to a pipeline element.

**Parameters**:
- `element`: Pipeline element to monitor (typically tiler or sink)
- `pad_name` (str): Name of the pad to monitor (typically "sink")

**Example**:
```python
perf_monitor.apply(pipeline["tiler"], "sink")
```

#### `add_stream(source_id, uri, sensor_id, sensor_name)`
Add a new stream to monitor (for dynamic sources).

**Parameters**:
- `source_id` (int): Unique source ID
- `uri` (str): Stream URI
- `sensor_id` (str): Sensor identifier
- `sensor_name` (str): Sensor name

#### `remove_stream(source_id)`
Remove a stream from monitoring.

**Parameters**:
- `source_id` (int): Source ID to remove

#### `pause()`
Pause performance monitoring.

#### `resume()`
Resume performance monitoring.

### EngineFileMonitor

Monitors TensorRT engine files and triggers On-The-Fly (OTF) model updates when files change.

**Constructor**:
```python
from pyservicemaker import utils

engine_monitor = utils.EngineFileMonitor(
    infer_element,           # nvinfer element
    engine_file_path         # Path to engine file to monitor
)
```

**Parameters**:
- `infer_element`: The `nvinfer` element to update when engine file changes
- `engine_file_path` (str): Path to the TensorRT engine file to monitor

**Properties**:
- `started` (bool): Whether the monitor has been started

**Methods**:

#### `start()`
Start monitoring the engine file for changes.

**Returns**: bool (True if started successfully)

#### `stop()`
Stop monitoring the engine file.

**Returns**: bool (True if stopped successfully)

## Performance Monitoring Usage Patterns

### Pattern 1: Basic FPS Monitoring

Monitor FPS for a single-stream pipeline.

```python
from pyservicemaker import Pipeline, utils
import platform

def pipeline_with_fps_monitoring(video_uri, config_path):
    """Pipeline with FPS monitoring"""
    pipeline = Pipeline("fps-monitored-pipeline")

    # Build pipeline
    pipeline.add("nvurisrcbin", "src", {"uri": video_uri})
    pipeline.add("nvstreammux", "mux", {"batch-size": 1, "width": 1920, "height": 1080})
    pipeline.add("nvinfer", "infer", {"config-file-path": config_path})
    pipeline.add("nvmultistreamtiler", "tiler", {"rows": 1, "columns": 1})
    pipeline.add("nvosdbin", "osd")

    sink_type = "nv3dsink" if platform.processor() == "aarch64" else "nveglglessink"
    pipeline.add(sink_type, "sink")

    # Link elements
    pipeline.link(("src", "mux"), ("", "sink_%u"))
    pipeline.link("mux", "infer", "tiler", "osd", "sink")

    # Create and apply performance monitor
    perf_monitor = utils.PerfMonitor(
        batch_size=1,
        interval=1,  # Report every second
        source_type="nvurisrcbin",
        show_name=True
    )

    # Apply to tiler's sink pad
    perf_monitor.apply(pipeline["tiler"], "sink")

    # Start pipeline
    pipeline.start().wait()

# Run with FPS monitoring
pipeline_with_fps_monitoring(
    "file:///path/to/video.mp4",
    "/path/to/config.yml"
)
```

**Output Example**:
```
**PERF: FPS 0 (Avg) 29.87
**PERF: FPS 0 (Avg) 30.02
**PERF: FPS 0 (Avg) 29.95
```

### Pattern 2: Multi-Stream FPS Monitoring

Monitor FPS for multiple streams with names.

```python
from pyservicemaker import Pipeline, utils
import platform

def multi_stream_fps_monitoring(stream_uris, config_path):
    """Monitor FPS for multiple streams"""
    pipeline = Pipeline("multi-stream-fps")

    # Add sources
    for i, uri in enumerate(stream_uris):
        pipeline.add("nvurisrcbin", f"src{i}", {"uri": uri})

    # Add muxer
    pipeline.add("nvstreammux", "mux", {
        "batch-size": len(stream_uris),
        "width": 1920,
        "height": 1080
    })

    # Add processing
    pipeline.add("nvinfer", "infer", {"config-file-path": config_path})
    pipeline.add("nvmultistreamtiler", "tiler", {
        "rows": 2,
        "columns": 2,
        "width": 1920,
        "height": 1080
    })
    pipeline.add("nvosdbin", "osd")

    sink_type = "nv3dsink" if platform.processor() == "aarch64" else "nveglglessink"
    pipeline.add(sink_type, "sink")

    # Link sources
    for i in range(len(stream_uris)):
        pipeline.link((f"src{i}", "mux"), ("", "sink_%u"))

    pipeline.link("mux", "infer", "tiler", "osd", "sink")

    # Create performance monitor
    perf_monitor = utils.PerfMonitor(
        batch_size=len(stream_uris),
        interval=2,  # Report every 2 seconds
        source_type="nvurisrcbin",
        show_name=True  # Show stream names
    )

    # Apply monitor
    perf_monitor.apply(pipeline["tiler"], "sink")

    # Start pipeline
    pipeline.start().wait()

# Monitor 4 streams
streams = [
    "file:///path/to/video1.mp4",
    "file:///path/to/video2.mp4",
    "rtsp://camera1/stream",
    "rtsp://camera2/stream"
]
multi_stream_fps_monitoring(streams, "/path/to/config.yml")
```

**Output Example**:
```
**PERF: FPS 0 (Avg) 29.87
**PERF: FPS 1 (Avg) 29.92
**PERF: FPS 2 (Avg) 30.15
**PERF: FPS 3 (Avg) 29.78
```

### Pattern 3: Dynamic Source Monitoring

Monitor performance with dynamically added/removed sources.

```python
from pyservicemaker import (
    Pipeline, PipelineState, StateTransitionMessage,
    DynamicSourceMessage, utils, SensorInfo
)

def dynamic_source_fps_monitoring(initial_sources, config_path):
    """Monitor FPS with dynamic source addition/removal"""
    pipeline = Pipeline("dynamic-fps-monitoring", config_file=config_path)

    # Sensor map to track sources
    sensor_map = {}

    # Initialize with static sources
    for i, source in enumerate(initial_sources):
        sensor_map[i] = SensorInfo(
            sensor_id=f"sensor_{i}",
            sensor_name=f"Camera {i}",
            uri=source
        )

    # Create performance monitor
    perf_monitor = utils.PerfMonitor(
        batch_size=len(initial_sources),
        interval=1,
        source_type="nvmultiurisrcbin",
        show_name=True
    )

    # Apply to tiler
    perf_monitor.apply(pipeline["tiler"], "sink")

    # Message handler for dynamic sources
    def on_message(message):
        if isinstance(message, DynamicSourceMessage):
            source_id = message.source_id

            if message.source_added:
                # Add new stream to monitoring
                sensor_map[source_id] = SensorInfo(
                    sensor_id=message.sensor_id,
                    sensor_name=message.sensor_name,
                    uri=message.uri
                )

                perf_monitor.add_stream(
                    source_id=source_id,
                    sensor_id=message.sensor_id,
                    sensor_name=message.sensor_name,
                    uri=message.uri
                )

                print(f"Added stream {source_id}: {message.sensor_name}")
            else:
                # Remove stream from monitoring
                if source_id in sensor_map:
                    del sensor_map[source_id]

                perf_monitor.remove_stream(source_id)
                print(f"Removed stream {source_id}")

    # Prepare pipeline with message handler
    pipeline.prepare(on_message)

    # Start pipeline
    pipeline.activate()
    pipeline.wait()

# Start with 2 sources (more can be added dynamically via API)
initial = [
    "file:///path/to/video1.mp4",
    "file:///path/to/video2.mp4"
]
dynamic_source_fps_monitoring(initial, "/path/to/config.yml")
```

### Pattern 4: Performance Monitoring with Pause/Resume

Control monitoring based on pipeline state.

```python
from pyservicemaker import Pipeline, utils
import time
import threading

def controlled_fps_monitoring(video_uri, config_path):
    """FPS monitoring with pause/resume control"""
    pipeline = Pipeline("controlled-monitoring")

    # Build pipeline
    pipeline.add("nvurisrcbin", "src", {"uri": video_uri})
    pipeline.add("nvstreammux", "mux", {"batch-size": 1, "width": 1920, "height": 1080})
    pipeline.add("nvinfer", "infer", {"config-file-path": config_path})
    pipeline.add("nvmultistreamtiler", "tiler", {"rows": 1, "columns": 1})
    pipeline.add("nvosdbin", "osd")
    pipeline.add("nveglglessink", "sink")

    pipeline.link(("src", "mux"), ("", "sink_%u"))
    pipeline.link("mux", "infer", "tiler", "osd", "sink")

    # Create performance monitor
    perf_monitor = utils.PerfMonitor(
        batch_size=1,
        interval=1,
        source_type="nvurisrcbin"
    )
    perf_monitor.apply(pipeline["tiler"], "sink")

    # Control thread
    def control_monitoring():
        time.sleep(10)
        print("Pausing monitoring...")
        perf_monitor.pause()

        time.sleep(5)
        print("Resuming monitoring...")
        perf_monitor.resume()

    control_thread = threading.Thread(target=control_monitoring, daemon=True)
    control_thread.start()

    # Start pipeline
    pipeline.start().wait()

controlled_fps_monitoring("file:///path/to/video.mp4", "/path/to/config.yml")
```

### Pattern 5: Model Engine Hot-Swapping

Monitor and automatically reload updated model engine files.

```python
from pyservicemaker import Pipeline, PipelineState, StateTransitionMessage, utils
import platform

def pipeline_with_otf_model_update(video_uri, config_path):
    """Pipeline with On-The-Fly model engine updates"""
    pipeline = Pipeline("otf-model-update")

    # Build pipeline
    pipeline.add("nvurisrcbin", "src", {"uri": video_uri})
    pipeline.add("nvstreammux", "mux", {"batch-size": 1, "width": 1920, "height": 1080})
    pipeline.add("nvinfer", "pgie", {"config-file-path": config_path})
    pipeline.add("nvosdbin", "osd")

    sink_type = "nv3dsink" if platform.processor() == "aarch64" else "nveglglessink"
    pipeline.add(sink_type, "sink")

    pipeline.link(("src", "mux"), ("", "sink_%u"))
    pipeline.link("mux", "pgie", "osd", "sink")

    # Get engine file path from nvinfer element
    engine_file = pipeline["pgie"].get("model-engine-file")

    # Create engine file monitor
    model_engine_monitor = utils.EngineFileMonitor(
        pipeline["pgie"],
        engine_file
    )

    # Message handler to start monitor when pipeline is ready
    def on_message(message):
        if isinstance(message, StateTransitionMessage):
            if message.new_state == PipelineState.PLAYING and message.origin == "sink":
                if not model_engine_monitor.started:
                    print("Starting model engine monitor...")
                    model_engine_monitor.start()

    pipeline.prepare(on_message)

    # Start pipeline
    pipeline.activate()
    pipeline.wait()

# Pipeline will automatically reload model when engine file changes
pipeline_with_otf_model_update(
    "file:///path/to/video.mp4",
    "/path/to/pgie_config.yml"
)
```

### Pattern 6: Combined Performance and Model Monitoring

Use both utilities together for production deployment. This pattern also uses `SourceConfig` and `SensorInfo` (see Part 2 below for details on those classes).

```python
from pyservicemaker import (
    Pipeline, PipelineState, StateTransitionMessage,
    DynamicSourceMessage, utils, SensorInfo, SourceConfig
)
import platform

def production_pipeline_monitoring(source_config_file, pipeline_config_file):
    """Production pipeline with full monitoring"""
    # Load configuration
    source_config = SourceConfig()
    source_config.load(source_config_file)

    # Create pipeline
    pipeline = Pipeline("production-pipeline", config_file=pipeline_config_file)

    # Sensor map
    sensor_map = {}
    for i, sensor in enumerate(source_config.sensor_list):
        sensor_map[i] = sensor

    # Create performance monitor
    perf_monitor = utils.PerfMonitor(
        batch_size=len(source_config.sensor_list),
        interval=5,  # Report every 5 seconds
        source_type=source_config.source_type,
        show_name=True
    )
    perf_monitor.apply(pipeline["tiler"], "sink")

    # Create model engine monitor
    engine_file = pipeline["pgie"].get("model-engine-file")
    model_engine_monitor = utils.EngineFileMonitor(
        pipeline["pgie"],
        engine_file
    )

    # Message handler
    def on_message(message):
        if isinstance(message, StateTransitionMessage):
            if message.new_state == PipelineState.PLAYING and message.origin == "sink":
                # Start monitors when pipeline is playing
                if not model_engine_monitor.started:
                    model_engine_monitor.start()
                    print("Model engine monitoring started")

        elif isinstance(message, DynamicSourceMessage):
            source_id = message.source_id

            if message.source_added:
                sensor_map[source_id] = SensorInfo(
                    sensor_id=message.sensor_id,
                    sensor_name=message.sensor_name,
                    uri=message.uri
                )
                perf_monitor.add_stream(
                    source_id=source_id,
                    sensor_id=message.sensor_id,
                    sensor_name=message.sensor_name,
                    uri=message.uri
                )
                print(f"Stream added: {message.sensor_name}")
            else:
                if source_id in sensor_map:
                    del sensor_map[source_id]
                perf_monitor.remove_stream(source_id)
                print(f"Stream removed: {source_id}")

    pipeline.prepare(on_message)

    # Start pipeline
    pipeline.activate()
    pipeline.wait()

# Run production pipeline
production_pipeline_monitoring(
    "source_config.yaml",
    "pipeline_config.yaml"
)
```

### Pattern 7: Custom FPS Logging

Capture FPS data for custom analysis.

```python
from pyservicemaker import Pipeline, Probe, BatchMetadataOperator, utils
import time
import json

class FPSLogger(BatchMetadataOperator):
    """Custom FPS logger"""
    def __init__(self, log_file="fps_log.json"):
        super().__init__()
        self.log_file = log_file
        self.frame_count = 0
        self.start_time = time.time()
        self.last_log_time = self.start_time
        self.fps_data = []

    def handle_metadata(self, batch_meta):
        self.frame_count += len(batch_meta.frame_items)

        current_time = time.time()
        elapsed = current_time - self.last_log_time

        if elapsed >= 1.0:  # Log every second
            fps = self.frame_count / elapsed

            log_entry = {
                "timestamp": current_time,
                "fps": fps,
                "total_frames": self.frame_count,
                "elapsed_total": current_time - self.start_time
            }

            self.fps_data.append(log_entry)
            print(f"FPS: {fps:.2f}")

            # Save to file
            with open(self.log_file, 'w') as f:
                json.dump(self.fps_data, f, indent=2)

            self.frame_count = 0
            self.last_log_time = current_time

def pipeline_with_custom_fps_logging(video_uri, config_path):
    """Pipeline with custom FPS logging"""
    pipeline = Pipeline("custom-fps-logging")

    # Build pipeline
    pipeline.add("nvurisrcbin", "src", {"uri": video_uri})
    pipeline.add("nvstreammux", "mux", {"batch-size": 1, "width": 1920, "height": 1080})
    pipeline.add("nvinfer", "infer", {"config-file-path": config_path})
    pipeline.add("nvosdbin", "osd")
    pipeline.add("nveglglessink", "sink")

    pipeline.link(("src", "mux"), ("", "sink_%u"))
    pipeline.link("mux", "infer", "osd", "sink")

    # Attach custom FPS logger
    from pyservicemaker import Probe
    fps_logger = FPSLogger("custom_fps_log.json")
    pipeline.attach("infer", Probe("fps_logger", fps_logger))

    # Also use built-in performance monitor
    perf_monitor = utils.PerfMonitor(
        batch_size=1,
        interval=1,
        source_type="nvurisrcbin"
    )
    perf_monitor.apply(pipeline["osd"], "sink")

    pipeline.start().wait()

pipeline_with_custom_fps_logging("file:///path/to/video.mp4", "/path/to/config.yml")
```

## Performance Monitoring Best Practices

### 1. Choose Appropriate Monitoring Interval
```python
# For real-time monitoring
perf_monitor = utils.PerfMonitor(batch_size=4, interval=1)

# For less frequent updates (production)
perf_monitor = utils.PerfMonitor(batch_size=4, interval=5)

# For detailed analysis
perf_monitor = utils.PerfMonitor(batch_size=4, interval=0.5)
```

### 2. Monitor at Appropriate Pipeline Point
```python
# Monitor after tiler (recommended for multi-stream)
perf_monitor.apply(pipeline["tiler"], "sink")

# Monitor at final sink
perf_monitor.apply(pipeline["sink"], "sink")

# Monitor after inference
perf_monitor.apply(pipeline["infer"], "src")
```

### 3. Start Engine Monitor After Pipeline is Ready
```python
def on_message(message):
    if isinstance(message, StateTransitionMessage):
        if message.new_state == PipelineState.PLAYING:
            if not model_engine_monitor.started:
                model_engine_monitor.start()
```

### 4. Keep References to Monitors
```python
# Store monitors to prevent garbage collection
reference_holders = []
reference_holders.append(perf_monitor)
reference_holders.append(model_engine_monitor)
```

### 5. Handle Dynamic Sources Properly
```python
# Add stream
perf_monitor.add_stream(
    source_id=source_id,
    sensor_id=sensor_id,
    sensor_name=sensor_name,
    uri=uri
)

# Remove stream
perf_monitor.remove_stream(source_id)
```

## Performance Tips

### 1. Monitoring Overhead
- Performance monitoring has minimal overhead (~0.1% CPU)
- Use longer intervals (5-10 seconds) for production
- Disable `show_name` if not needed to reduce string operations

### 2. Engine File Monitoring
- Engine monitor uses inotify (Linux) for efficient file watching
- Minimal overhead when file doesn't change
- Automatic reload triggers brief inference pause

### 3. Multi-Stream Monitoring
- Per-stream FPS tracking has negligible overhead
- Batch size should match actual number of streams
- Update batch size when adding/removing dynamic sources

## Performance Monitoring Common Use Cases

### 1. Production Deployment Monitoring
Monitor FPS and model updates in production systems.

### 2. Performance Benchmarking
Measure and log FPS for different configurations.

### 3. Dynamic Stream Management
Track performance as streams are added/removed.

### 4. Model A/B Testing
Monitor performance during model hot-swapping.

### 5. Quality of Service (QoS) Monitoring
Ensure FPS meets SLA requirements.

### 6. Resource Utilization Analysis
Correlate FPS with system resource usage.

## Performance Monitoring Troubleshooting

### Issue 1: No FPS Output
**Solution**: Ensure monitor is applied to correct element and pad, verify pipeline is running

### Issue 2: Incorrect FPS Values
**Solution**: Check batch_size matches actual number of streams, verify monitoring point

### Issue 3: Engine Monitor Not Triggering
**Solution**: Ensure monitor is started after pipeline is PLAYING, verify file path is correct

### Issue 4: Memory Leak with Dynamic Sources
**Solution**: Always call `remove_stream()` when removing sources, keep references to monitors

## Performance Monitoring Summary

The performance monitoring utilities provide essential capabilities for production DeepStream applications:

1. **PerfMonitor**: Real-time FPS tracking and throughput measurement
   - Per-stream FPS monitoring
   - Dynamic source support
   - Pause/resume capability
   - Minimal overhead

2. **EngineFileMonitor**: Automatic model engine hot-swapping
   - File change detection
   - Automatic inference engine reload
   - Zero-downtime model updates
   - Production-ready OTF updates

Key features:
- Real-time performance metrics
- Multi-stream support
- Dynamic source tracking
- Model hot-swapping
- Production deployment ready
- Minimal performance overhead

These utilities are essential for monitoring, debugging, and maintaining DeepStream applications in production environments.

---

# Part 2: Configuration and Helper Classes

The `pyservicemaker` module provides several configuration and helper classes that simplify DeepStream application development. These classes handle:
- Source configuration management (video streams, cameras)
- Smart recording configuration
- Custom postprocessing interfaces
- Common factory patterns
- Signal handling and events

## Core Classes

### SourceConfig

A configuration manager for video sources and cameras.

**Constructor**:
```python
from pyservicemaker import SourceConfig

source_config = SourceConfig()
```

**Properties**:
- `sensor_list`: List of `SensorInfo` objects (for URI-based sources)
- `camera_list`: List of `CameraInfo` objects (for physical cameras)
- `source_type`: Type of source bin (e.g., "nvurisrcbin", "nvmultiurisrcbin", "camerabin")
- `source_properties`: Dictionary of source properties

**Methods**:

#### `load(config_file)`
Load source configuration from a YAML file.

**Parameters**:
- `config_file` (str): Path to YAML configuration file

**Example**:
```python
from pyservicemaker import SourceConfig

config = SourceConfig()
config.load("source_config.yaml")

print(f"Source type: {config.source_type}")
print(f"Number of sensors: {len(config.sensor_list)}")

for sensor in config.sensor_list:
    print(f"  Sensor ID: {sensor.sensor_id}")
    print(f"  Name: {sensor.sensor_name}")
    print(f"  URI: {sensor.uri}")
```

**YAML Configuration Format**:

```yaml
# For URI-based sources (files, RTSP streams)
source-list:
  - uri: "file:///path/to/video1.mp4"
    sensor-id: "sensor-001"
    sensor-name: "Camera 1"

  - uri: "rtsp://192.168.1.100/stream"
    sensor-id: "sensor-002"
    sensor-name: "Camera 2"

source-config:
  source-bin: "nvurisrcbin"
  properties:
    gpu-id: 0
    cudadec-memtype: 0

# For physical cameras (CSI, V4L2)
camera-list:
  - camera-type: "CSI"
    camera-video-format: "NV12"
    camera-width: 1920
    camera-height: 1080
    camera-fps-n: 30
    camera-fps-d: 1
    camera-csi-sensor-id: 0
    gpu-id: 0
    nvbuf-mem-type: 0

  - camera-type: "V4L2"
    camera-video-format: "NV12"
    camera-width: 1280
    camera-height: 720
    camera-fps-n: 30
    camera-fps-d: 1
    camera-v4l2-dev-node: 0
    gpu-id: 0
    nvbuf-mem-type: 0
    nvvideoconvert-copy-hw: 0
```

### SensorInfo

Named tuple containing sensor information for URI-based sources.

**Fields**:
- `sensor_id` (str): Unique sensor identifier
- `sensor_name` (str): Human-readable sensor name
- `uri` (str): Video source URI

**Example**:
```python
from pyservicemaker import SensorInfo

sensor = SensorInfo(
    sensor_id="cam-001",
    sensor_name="Front Door Camera",
    uri="rtsp://192.168.1.100/stream"
)

print(f"ID: {sensor.sensor_id}")
print(f"Name: {sensor.sensor_name}")
print(f"URI: {sensor.uri}")
```

### CameraInfo

Named tuple containing camera configuration for physical cameras.

**Fields**:
- `camera_type` (str): Camera type ("CSI" or "V4L2")
- `camera_video_format` (str): Video format (e.g., "NV12", "RGB")
- `camera_width` (int): Frame width in pixels
- `camera_height` (int): Frame height in pixels
- `camera_fps_n` (int): Frame rate numerator
- `camera_fps_d` (int): Frame rate denominator
- `camera_csi_sensor_id` (int): CSI sensor ID (for CSI cameras)
- `camera_v4l2_dev_node` (int): V4L2 device node (for V4L2 cameras)
- `gpu_id` (int): GPU ID to use
- `nvbuf_mem_type` (int): Buffer memory type
- `nvvideoconvert_copy_hw` (int): Hardware copy mode

**Example**:
```python
from pyservicemaker import CameraInfo

# CSI camera configuration
csi_camera = CameraInfo(
    camera_type="CSI",
    camera_video_format="NV12",
    camera_width=1920,
    camera_height=1080,
    camera_fps_n=30,
    camera_fps_d=1,
    camera_csi_sensor_id=0,
    camera_v4l2_dev_node=None,
    gpu_id=0,
    nvbuf_mem_type=0,
    nvvideoconvert_copy_hw=0
)
```

### SmartRecordConfig

Configuration dataclass for smart recording functionality.

**Constructor**:
```python
from pyservicemaker import SmartRecordConfig

config = SmartRecordConfig(
    proto_lib="/path/to/libnvds_kafka_proto.so",
    conn_str="localhost;9092",
    msgconv_config_file="/path/to/msgconv_config.txt",
    proto_config_file="/path/to/proto_config.txt",
    topic_list="smart-recording-events",
    smart_rec_cache=30,
    smart_rec_container=0,
    smart_rec_dir_path="./recordings",
    smart_rec_mode=0
)
```

**Required Parameters**:
- `proto_lib` (str): Path to protocol library (e.g., Kafka protocol library)
- `conn_str` (str): Connection string for message broker (e.g., "localhost;9092")
- `msgconv_config_file` (str): Path to message converter configuration file
- `proto_config_file` (str): Path to protocol configuration file
- `topic_list` (str): Comma-separated list of topics for message publishing

**Optional Parameters**:
- `smart_rec_cache` (int): Cache size in seconds (default: 20, range: 0-4294967295)
- `smart_rec_container` (int): Container format (0=MP4, 1=MKV, default: 0)
- `smart_rec_dir_path` (str): Directory to save recordings (default: ".")
- `smart_rec_mode` (int): Recording mode (0=audio+video, 1=video only, 2=audio only, default: 0)

**Example**:
```python
from pyservicemaker import SmartRecordConfig

# Create smart recording configuration
sr_config = SmartRecordConfig(
    proto_lib="/opt/nvidia/deepstream/deepstream/lib/libnvds_kafka_proto.so",
    conn_str="localhost;9092",
    msgconv_config_file="/opt/nvidia/deepstream/deepstream/sources/libs/kafka_protocol_adaptor/cfg_kafka.txt",
    proto_config_file="/opt/nvidia/deepstream/deepstream/sources/libs/kafka_protocol_adaptor/cfg_kafka.txt",
    topic_list="sr-events",
    smart_rec_cache=30,      # 30 seconds cache
    smart_rec_container=0,   # MP4 format
    smart_rec_dir_path="./recordings",
    smart_rec_mode=0         # Record audio and video
)
```

### PostProcessing (Abstract Base Class)

Base class for custom tensor output postprocessing.

**Abstract Method**:

#### `__call__(output_layers)`
Convert output tensors to real-world representation.

**Parameters**:
- `output_layers` (Dict): Dictionary of (layer_name, tensor) pairs

**Returns**: Any (depends on implementation)

**Example**:
```python
from pyservicemaker import postprocessing
import torch

class CustomPostProcessing(postprocessing.PostProcessing):
    def __call__(self, output_layers):
        # Extract tensors
        output = output_layers.get('output_layer')

        if output:
            # Convert to PyTorch
            torch_tensor = torch.utils.dlpack.from_dlpack(output)

            # Custom processing
            result = self.process(torch_tensor)
            return result

        return None

    def process(self, tensor):
        # Your custom processing logic
        return tensor.cpu().numpy()
```

### ObjectDetectorOutputConverter (Abstract Base Class)

Specialized base class for object detection postprocessing.

**Abstract Method**:

#### `__call__(output_layers)`
Convert output tensors to object detection results.

**Parameters**:
- `output_layers` (Dict): Dictionary of (layer_name, tensor) pairs

**Returns**: List of bounding boxes in format `[class_id, confidence, x1, y1, x2, y2]`

**Example**:
```python
from pyservicemaker import postprocessing
import torch
import torchvision.ops as ops

class YOLOv5Converter(postprocessing.ObjectDetectorOutputConverter):
    def __init__(self, conf_threshold=0.5, nms_threshold=0.4):
        self.conf_threshold = conf_threshold
        self.nms_threshold = nms_threshold

    def __call__(self, output_layers):
        outputs = []

        # Extract output tensor
        predictions = output_layers.get('output')
        if predictions is None:
            return outputs

        # Convert to PyTorch
        pred_tensor = torch.utils.dlpack.from_dlpack(predictions).cpu()

        # Process predictions
        # pred_tensor shape: [batch, num_boxes, 85] (for COCO)
        # Format: [x, y, w, h, obj_conf, class_conf...]

        for detection in pred_tensor[0]:  # Assuming batch size 1
            obj_conf = detection[4]

            if obj_conf < self.conf_threshold:
                continue

            # Get class with highest confidence
            class_confs = detection[5:]
            class_id = torch.argmax(class_confs).item()
            class_conf = class_confs[class_id].item()

            confidence = obj_conf * class_conf

            if confidence < self.conf_threshold:
                continue

            # Convert center format to corner format
            x_center, y_center, width, height = detection[:4]
            x1 = (x_center - width / 2).item()
            y1 = (y_center - height / 2).item()
            x2 = (x_center + width / 2).item()
            y2 = (y_center + height / 2).item()

            outputs.append([class_id, confidence, x1, y1, x2, y2])

        # Apply NMS
        if outputs:
            boxes = torch.tensor([[o[2], o[3], o[4], o[5]] for o in outputs])
            scores = torch.tensor([o[1] for o in outputs])
            keep = ops.nms(boxes, scores, self.nms_threshold)
            outputs = [outputs[i] for i in keep]

        return outputs
```

### CommonFactory

Factory class for creating custom objects and plugins.

**Method**:

#### `create(factory_name, instance_name)`
Create an instance from a registered factory.

**Parameters**:
- `factory_name` (str): Name of the factory (e.g., "smart_recording_action")
- `instance_name` (str): Name for the created instance

**Returns**: Created object instance

**Example**:
```python
from pyservicemaker import CommonFactory

# Create smart recording controller
sr_controller = CommonFactory.create("smart_recording_action", "sr_controller")

# Configure the controller
if sr_controller:
    sr_controller.set({
        "proto-lib": "/path/to/libnvds_kafka_proto.so",
        "conn-str": "localhost;9092",
        "msgconv-config-file": "/path/to/msgconv_config.txt",
        "proto-config-file": "/path/to/proto_config.txt",
        "topic-list": "sr-events"
    })
```

## Configuration and Helper Usage Patterns

### Pattern 1: Load and Use Source Configuration

Load source configuration from YAML and build pipeline.

```python
from pyservicemaker import Pipeline, SourceConfig
import platform

def pipeline_from_source_config(source_config_file, pgie_config):
    """Build pipeline from source configuration file"""
    # Load source configuration
    source_config = SourceConfig()
    source_config.load(source_config_file)

    # Create pipeline
    pipeline = Pipeline("configured-pipeline")

    # Add sources based on configuration
    if source_config.source_type == "nvmultiurisrcbin":
        # Multi-URI source bin
        uri_list = ','.join([s.uri for s in source_config.sensor_list])
        sensor_id_list = ','.join([s.sensor_id for s in source_config.sensor_list])
        sensor_name_list = ','.join([s.sensor_name for s in source_config.sensor_list])

        properties = dict(source_config.source_properties)
        properties.update({
            "uri-list": uri_list,
            "sensor-id-list": sensor_id_list,
            "sensor-name-list": sensor_name_list
        })

        pipeline.add("nvmultiurisrcbin", "source", properties)
        pipeline.add("nvinfer", "pgie", {"config-file-path": pgie_config})
        pipeline.link("source", "pgie")

    elif source_config.source_type == "camerabin":
        # Physical cameras
        pipeline.add("nvstreammux", "mux", {
            "batch-size": len(source_config.camera_list),
            "width": 1920,
            "height": 1080,
            "live-source": 1
        })

        for i, camera in enumerate(source_config.camera_list):
            src_name = f"src_{i}"

            if camera.camera_type == "CSI":
                pipeline.add("nvarguscamerasrc" if platform.processor() == "aarch64" else "videotestsrc",
                           src_name, {"sensor-id": camera.camera_csi_sensor_id})
            elif camera.camera_type == "V4L2":
                device = f"/dev/video{camera.camera_v4l2_dev_node}"
                pipeline.add("v4l2src", src_name, {"device": device})

            pipeline.link((src_name, "mux"), ("", "sink_%u"))

        pipeline.add("nvinfer", "pgie", {"config-file-path": pgie_config})
        pipeline.link("mux", "pgie")

    else:
        # Individual URI sources
        pipeline.add("nvstreammux", "mux", {
            "batch-size": len(source_config.sensor_list),
            "width": 1920,
            "height": 1080
        })

        for i, sensor in enumerate(source_config.sensor_list):
            src_name = f"src_{i}"
            properties = dict(source_config.source_properties)
            properties["uri"] = sensor.uri

            pipeline.add(source_config.source_type, src_name, properties)
            pipeline.link((src_name, "mux"), ("", "sink_%u"))

        pipeline.add("nvinfer", "pgie", {"config-file-path": pgie_config})
        pipeline.link("mux", "pgie")

    # Add remaining elements
    pipeline.add("nvosdbin", "osd")
    pipeline.add("nveglglessink", "sink")
    pipeline.link("pgie", "osd", "sink")

    # Start pipeline
    pipeline.start().wait()

# Use configuration file
pipeline_from_source_config("sources.yaml", "pgie_config.yml")
```

### Pattern 2: Smart Recording with Configuration

Set up smart recording using SmartRecordConfig.

```python
from pyservicemaker import Pipeline, Flow, SmartRecordConfig

def pipeline_with_smart_recording(video_uris, pgie_config):
    """Pipeline with smart recording enabled"""
    # Create smart recording configuration
    sr_config = SmartRecordConfig(
        proto_lib="/opt/nvidia/deepstream/deepstream/lib/libnvds_kafka_proto.so",
        conn_str="localhost;9092",
        msgconv_config_file="/opt/nvidia/deepstream/deepstream/sources/libs/kafka_protocol_adaptor/cfg_kafka.txt",
        proto_config_file="/opt/nvidia/deepstream/deepstream/sources/libs/kafka_protocol_adaptor/cfg_kafka.txt",
        topic_list="sr-events",
        smart_rec_cache=30,
        smart_rec_container=0,  # MP4
        smart_rec_dir_path="./recordings",
        smart_rec_mode=0  # Audio + Video
    )

    # Create pipeline with Flow API
    pipeline = Pipeline("smart-recording-pipeline")
    flow = Flow(pipeline)

    # Build pipeline with smart recording
    flow.batch_capture(video_uris)
    flow.infer(pgie_config)
    flow.smart_record(sr_config)  # Enable smart recording
    flow.render()

    # Execute
    flow()

# Run with smart recording
video_sources = [
    "rtsp://192.168.1.100/stream",
    "rtsp://192.168.1.101/stream"
]
pipeline_with_smart_recording(video_sources, "pgie_config.yml")
```

### Pattern 3: Custom Postprocessing

Implement custom postprocessing for inference outputs.

```python
from pyservicemaker import Pipeline, Probe, BatchMetadataOperator, postprocessing
import torch

class CustomDetectorConverter(postprocessing.ObjectDetectorOutputConverter):
    """Custom object detector postprocessing"""
    def __init__(self, threshold=0.5):
        self.threshold = threshold

    def __call__(self, output_layers):
        outputs = []

        # Extract your model's output tensors
        bbox_layer = output_layers.get('bboxes')
        conf_layer = output_layers.get('confidences')
        class_layer = output_layers.get('classes')

        if not all([bbox_layer, conf_layer, class_layer]):
            return outputs

        # Convert to PyTorch
        bboxes = torch.utils.dlpack.from_dlpack(bbox_layer).cpu()
        confs = torch.utils.dlpack.from_dlpack(conf_layer).cpu()
        classes = torch.utils.dlpack.from_dlpack(class_layer).cpu()

        # Process detections
        for bbox, conf, cls in zip(bboxes, confs, classes):
            if conf > self.threshold:
                x1, y1, x2, y2 = bbox
                outputs.append([
                    int(cls),
                    float(conf),
                    float(x1), float(y1),
                    float(x2), float(y2)
                ])

        return outputs

class CustomPostprocessor(BatchMetadataOperator):
    """Apply custom postprocessing to inference results"""
    def __init__(self):
        super().__init__()
        self.converter = CustomDetectorConverter(threshold=0.6)

    def handle_metadata(self, batch_meta):
        for frame_meta in batch_meta.frame_items:
            # Process tensor outputs
            for tensor_meta in frame_meta.tensor_items:
                output_layers = tensor_meta.as_tensor_output().get_layers()
                detections = self.converter(output_layers)

                # Create object metadata from detections
                for det in detections:
                    obj_meta = batch_meta.acquire_object_meta()
                    obj_meta.class_id = det[0]
                    obj_meta.confidence = det[1]
                    obj_meta.rect_params.left = det[2]
                    obj_meta.rect_params.top = det[3]
                    obj_meta.rect_params.width = det[4] - det[2]
                    obj_meta.rect_params.height = det[5] - det[3]
                    frame_meta.append(obj_meta)

def pipeline_with_custom_postprocessing(video_uri, config_path):
    """Pipeline with custom postprocessing"""
    pipeline = Pipeline("custom-postproc")

    # Build pipeline
    pipeline.add("nvurisrcbin", "src", {"uri": video_uri})
    pipeline.add("nvstreammux", "mux", {"batch-size": 1, "width": 1920, "height": 1080})

    # Enable tensor output
    pipeline.add("nvinfer", "infer", {
        "config-file-path": config_path,
        "output-tensor-meta": 1  # Enable tensor output
    })

    pipeline.add("nvosdbin", "osd")
    pipeline.add("nveglglessink", "sink")

    pipeline.link(("src", "mux"), ("", "sink_%u"))
    pipeline.link("mux", "infer", "osd", "sink")

    # Attach custom postprocessor
    pipeline.attach("infer", Probe("custom-postproc", CustomPostprocessor()))

    pipeline.start().wait()

pipeline_with_custom_postprocessing("file:///path/to/video.mp4", "config.yml")
```

### Pattern 4: Dynamic Sensor Management

Manage sensors dynamically using SensorInfo. For combining this with performance monitoring, see Part 1 above (Pattern 3: Dynamic Source Monitoring).

```python
from pyservicemaker import Pipeline, SensorInfo, DynamicSourceMessage
import time
import threading

def dynamic_sensor_management():
    """Manage sensors dynamically"""
    pipeline = Pipeline("dynamic-sensors", config_file="pipeline_config.yml")

    # Sensor registry
    active_sensors = {}

    def on_message(message):
        if isinstance(message, DynamicSourceMessage):
            source_id = message.source_id

            if message.source_added:
                # Register new sensor
                sensor = SensorInfo(
                    sensor_id=message.sensor_id,
                    sensor_name=message.sensor_name,
                    uri=message.uri
                )
                active_sensors[source_id] = sensor
                print(f"Added sensor: {sensor.sensor_name} ({sensor.sensor_id})")
            else:
                # Unregister sensor
                if source_id in active_sensors:
                    sensor = active_sensors[source_id]
                    print(f"Removed sensor: {sensor.sensor_name}")
                    del active_sensors[source_id]

    pipeline.prepare(on_message)
    pipeline.activate()
    pipeline.wait()

dynamic_sensor_management()
```

### Pattern 5: Factory-Based Plugin Creation

Use CommonFactory to create custom plugins.

```python
from pyservicemaker import Pipeline, CommonFactory, signal

def pipeline_with_factory_plugins(video_uris, config_path):
    """Pipeline using factory-created plugins"""
    pipeline = Pipeline("factory-pipeline")

    # Build pipeline
    pipeline.add("nvstreammux", "mux", {
        "batch-size": len(video_uris),
        "width": 1920,
        "height": 1080
    })

    for i, uri in enumerate(video_uris):
        pipeline.add("nvurisrcbin", f"src{i}", {"uri": uri})
        pipeline.link((f"src{i}", "mux"), ("", "sink_%u"))

    pipeline.add("nvinfer", "pgie", {"config-file-path": config_path})
    pipeline.add("nvmsgbroker", "msgbroker", {
        "proto-lib": "/opt/nvidia/deepstream/deepstream/lib/libnvds_kafka_proto.so",
        "conn-str": "localhost;9092",
        "topic": "analytics"
    })

    pipeline.link("mux", "pgie", "msgbroker")

    # Create smart recording controller using factory
    sr_controller = CommonFactory.create("smart_recording_action", "sr_controller")

    if sr_controller and isinstance(sr_controller, signal.Emitter):
        # Configure smart recording
        sr_controller.set({
            "proto-lib": "/opt/nvidia/deepstream/deepstream/lib/libnvds_kafka_proto.so",
            "conn-str": "localhost;9092",
            "msgconv-config-file": "/path/to/msgconv_config.txt",
            "proto-config-file": "/path/to/proto_config.txt",
            "topic-list": "sr-events"
        })

        # Attach to sources
        for i in range(len(video_uris)):
            sr_controller.attach("start-sr", pipeline[f"src{i}"])
            sr_controller.attach("stop-sr", pipeline[f"src{i}"])
            pipeline.attach(f"src{i}", "smart_recording_signal", "sr", "sr-done")

    pipeline.start().wait()

video_sources = ["rtsp://cam1/stream", "rtsp://cam2/stream"]
pipeline_with_factory_plugins(video_sources, "pgie_config.yml")
```

## Configuration and Helper Best Practices

### 1. Use Configuration Files
```python
# Good: Externalize configuration
source_config = SourceConfig()
source_config.load("sources.yaml")

# Avoid: Hardcoding configuration
sensors = [
    SensorInfo("001", "Camera 1", "rtsp://..."),
    SensorInfo("002", "Camera 2", "rtsp://...")
]
```

### 2. Validate Configuration
```python
source_config = SourceConfig()
source_config.load("sources.yaml")

if not source_config.sensor_list:
    raise ValueError("No sensors configured")

if source_config.source_type not in ["nvurisrcbin", "nvmultiurisrcbin"]:
    raise ValueError(f"Unsupported source type: {source_config.source_type}")
```

### 3. Use Dataclasses for Configuration
```python
# Good: Use SmartRecordConfig dataclass
sr_config = SmartRecordConfig(
    proto_lib="/path/to/lib.so",
    conn_str="localhost;9092",
    # ... other parameters
)

# Avoid: Manual dictionary management
sr_config = {
    "proto-lib": "/path/to/lib.so",
    "conn-str": "localhost;9092",
    # ... other parameters
}
```

### 4. Implement Proper Postprocessing
```python
class MyConverter(postprocessing.ObjectDetectorOutputConverter):
    def __call__(self, output_layers):
        # Always return list of [class_id, conf, x1, y1, x2, y2]
        outputs = []

        # Process tensors
        # ...

        return outputs  # Return empty list if no detections
```

### 5. Handle Factory Creation Errors
```python
plugin = CommonFactory.create("plugin_name", "instance_name")

if plugin is None:
    print("Warning: Failed to create plugin")
    # Handle gracefully
else:
    # Use plugin
    plugin.set(properties)
```

## Related APIs

- **Pipeline API**: See `service_maker_api.md`
- **Flow API**: See `service_maker_api.md`
- **Postprocessing**: See `service_maker_api.md`
- **Smart Recording**: See `service_maker_api.md` and `kafka_messaging.md`

## Configuration and Helper Summary

The configuration and helper classes provide essential utilities for DeepStream application development:

1. **SourceConfig**: Manage video sources and cameras from YAML
2. **SensorInfo/CameraInfo**: Structured sensor and camera information
3. **SmartRecordConfig**: Configure smart recording functionality
4. **PostProcessing**: Base class for custom tensor postprocessing
5. **ObjectDetectorOutputConverter**: Specialized postprocessing for object detection
6. **CommonFactory**: Create custom plugins and objects

Key features:
- YAML-based configuration management
- Structured data classes for type safety
- Abstract base classes for custom implementations
- Factory pattern for plugin creation
- Smart recording configuration
- Flexible postprocessing framework

These utilities simplify configuration management, enable code reuse, and provide clean interfaces for extending DeepStream functionality.
