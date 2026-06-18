# Use Cases: Pipeline Construction Patterns

## Overview

This document covers two fundamental DeepStream pipeline construction patterns. **Part 1** explains how to build a simple video player -- reading video from a file or stream, decoding it with hardware acceleration, and displaying it on screen without any AI inference. **Part 2** builds on that foundation to construct multi-inference pipelines that chain primary and secondary inference engines for object detection, classification, and attribute extraction across one or more video streams.

---

## Part 1: Simple Video Player

### Use Case Requirements

- Read video from file (H.264/H.265) or network stream (RTSP)
- Hardware-accelerated video decoding
- Display video on screen
- Handle multiple video formats
- Support for different platforms (x86_64 and ARM64/Jetson)

### Pipeline Architecture

#### Minimal Pipeline
```
Source -> Parser -> Decoder -> Converter -> Renderer
```

#### Detailed Pipeline Elements

1. **Source**: `filesrc` (for files) or `nvurisrcbin` (for URIs)
2. **Parser**: `h264parse` or `h265parse`
3. **Decoder**: `nvv4l2decoder` (hardware-accelerated)
4. **Converter**: `nvvideoconvert` (format conversion if needed)
5. **Renderer**: `nveglglessink` (x86_64) or `nv3dsink` (Jetson)

### Implementation Approaches

#### Approach 1: Pipeline API (Python)

**Language: Python**
**Target Audience: Python developers**
**Recommended for: Python applications**

```python
from pyservicemaker import Pipeline
import platform
import sys

def simple_video_player(video_path):
    """
    Simple video player using DeepStream Pipeline API

    Args:
        video_path: Path to video file or URI (rtsp://, file://, etc.)
    """
    pipeline = Pipeline("simple-player")

    # Determine if it's a URI or file path
    if video_path.startswith(("rtsp://", "http://", "file://")):
        # Use nvurisrcbin for URI-based sources
        pipeline.add("nvurisrcbin", "src", {"uri": video_path})
    else:
        # Use filesrc for local files
        pipeline.add("filesrc", "src", {"location": video_path})
        # Add parser based on file extension or use qtdemux
        if video_path.endswith(('.h264', '.264')):
            pipeline.add("h264parse", "parser")
        elif video_path.endswith(('.h265', '.265', '.hevc')):
            pipeline.add("h265parse", "parser")
        else:
            # For MP4/MOV files, use qtdemux
            pipeline.add("qtdemux", "demux")
            pipeline.add("h264parse", "parser")

    # Hardware-accelerated decoder
    pipeline.add("nvv4l2decoder", "decoder")

    # Video converter (may be needed for format conversion)
    pipeline.add("nvvideoconvert", "converter", {"gpu-id": 0})

    # Renderer (platform-specific)
    sink_type = "nv3dsink" if platform.processor() == "aarch64" else "nveglglessink"
    pipeline.add(sink_type, "sink", {"sync": 1})

    # Link elements
    if "nvurisrcbin" in [elem.name for elem in pipeline.elements]:
        # nvurisrcbin handles parsing internally
        pipeline.link("src", "decoder", "converter", "sink")
    elif "qtdemux" in [elem.name for elem in pipeline.elements]:
        # Handle qtdemux video pad
        pipeline.link("src", "demux")
        pipeline.link(("demux", "parser"), ("video_%u", ""))
        pipeline.link("parser", "decoder", "converter", "sink")
    else:
        # Simple file with parser
        pipeline.link("src", "parser", "decoder", "converter", "sink")

    # Start and wait
    try:
        pipeline.start().wait()
    except KeyboardInterrupt:
        print("\nPlayback interrupted")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python simple_player.py <video_file_or_uri>")
        sys.exit(1)

    simple_video_player(sys.argv[1])
```

#### Approach 2: Flow API (Python)

**Language: Python**
**Target Audience: Python developers**
**Recommended for: Python applications**

```python
from pyservicemaker import Pipeline, Flow
import platform
import sys

def simple_video_player_flow(video_path):
    """
    Simple video player using DeepStream Flow API
    """
    pipeline = Pipeline("simple-player-flow")
    flow = Flow(pipeline)

    # Flow API doesn't directly support simple playback
    # This is a simplified example - Flow API is better for inference pipelines
    # For simple playback, use Pipeline API instead

    # However, we can still use Flow API with custom pipeline construction
    # This requires manual pipeline building
    pass

if __name__ == "__main__":
    simple_video_player_flow(sys.argv[1])
```

#### Approach 3: GStreamer Command Line

```bash
# For H.264 file
gst-launch-1.0 filesrc location=/path/to/video.h264 ! \
    h264parse ! \
    nvv4l2decoder ! \
    nvvideoconvert ! \
    nveglglessink sync=1

# For MP4 file
gst-launch-1.0 filesrc location=/path/to/video.mp4 ! \
    qtdemux ! \
    h264parse ! \
    nvv4l2decoder ! \
    nvvideoconvert ! \
    nveglglessink sync=1

# For RTSP stream
gst-launch-1.0 nvurisrcbin uri=rtsp://camera-ip/stream ! \
    nvv4l2decoder ! \
    nvvideoconvert ! \
    nveglglessink sync=1

# For Jetson platform
gst-launch-1.0 filesrc location=/path/to/video.h264 ! \
    h264parse ! \
    nvv4l2decoder ! \
    nvvideoconvert ! \
    nv3dsink sync=1
```

#### Approach 4: C/C++ Application

**Note: This section is specifically for C/C++ applications only. For Python applications, use Approach 1 (Pipeline API) or Approach 2 (Flow API) instead.**

This approach demonstrates how to build a simple video player using the GStreamer C API directly. This is a native C/C++ implementation that provides low-level control over the GStreamer pipeline.

**Language: C/C++**
**Target Audience: C/C++ developers**
**Not applicable for: Python applications**

```c
#include <gst/gst.h>
#include <glib.h>

typedef struct {
    GstElement *pipeline;
    GstElement *source;
    GstElement *parser;
    GstElement *decoder;
    GstElement *converter;
    GstElement *sink;
} AppData;

int main(int argc, char *argv[]) {
    GstBus *bus;
    GstMessage *msg;
    AppData data;

    // Initialize GStreamer
    gst_init(&argc, &argv);

    // Create elements
    data.pipeline = gst_pipeline_new("simple-player");
    data.source = gst_element_factory_make("filesrc", "source");
    data.parser = gst_element_factory_make("h264parse", "parser");
    data.decoder = gst_element_factory_make("nvv4l2decoder", "decoder");
    data.converter = gst_element_factory_make("nvvideoconvert", "converter");

    // Platform-specific sink
    #ifdef __aarch64__
        data.sink = gst_element_factory_make("nv3dsink", "sink");
    #else
        data.sink = gst_element_factory_make("nveglglessink", "sink");
    #endif

    if (!data.pipeline || !data.source || !data.parser ||
        !data.decoder || !data.converter || !data.sink) {
        g_printerr("Not all elements could be created.\n");
        return -1;
    }

    // Set source location
    g_object_set(data.source, "location", argv[1], NULL);

    // Set sink sync
    g_object_set(data.sink, "sync", 1, NULL);

    // Add elements to pipeline
    gst_bin_add_many(GST_BIN(data.pipeline),
                      data.source, data.parser, data.decoder,
                      data.converter, data.sink, NULL);

    // Link elements
    if (gst_element_link_many(data.source, data.parser, data.decoder,
                              data.converter, data.sink, NULL) != TRUE) {
        g_printerr("Elements could not be linked.\n");
        gst_object_unref(data.pipeline);
        return -1;
    }

    // Set pipeline to PLAYING state
    gst_element_set_state(data.pipeline, GST_STATE_PLAYING);

    // Wait for EOS or error
    bus = gst_element_get_bus(data.pipeline);
    msg = gst_bus_timed_pop_filtered(bus, GST_CLOCK_TIME_NONE,
                                      GST_MESSAGE_ERROR | GST_MESSAGE_EOS);

    // Cleanup
    if (msg != NULL)
        gst_message_unref(msg);
    gst_object_unref(bus);
    gst_element_set_state(data.pipeline, GST_STATE_NULL);
    gst_object_unref(data.pipeline);

    return 0;
}
```

**End of C/C++ Implementation** - This section contains C/C++ code only. For Python implementations, refer to Approach 1 (Pipeline API) or Approach 2 (Flow API) above.

### Enhanced Video Player Features

#### Feature 1: Multi-Format Support

```python
from pyservicemaker import Pipeline
import platform
import os

def detect_video_format(video_path):
    """Detect video format from file extension"""
    ext = os.path.splitext(video_path)[1].lower()
    formats = {
        '.h264': 'h264',
        '.264': 'h264',
        '.h265': 'h265',
        '.265': 'h265',
        '.hevc': 'h265',
        '.mp4': 'mp4',
        '.mov': 'mp4',
        '.mkv': 'mkv'
    }
    return formats.get(ext, 'unknown')

def multi_format_player(video_path):
    """Video player supporting multiple formats"""
    pipeline = Pipeline("multi-format-player")
    format_type = detect_video_format(video_path)

    # Source
    if video_path.startswith(("rtsp://", "http://", "file://")):
        pipeline.add("nvurisrcbin", "src", {"uri": video_path})
        # nvurisrcbin handles format detection automatically
        pipeline.add("nvv4l2decoder", "decoder")
    else:
        pipeline.add("filesrc", "src", {"location": video_path})

        if format_type == 'h264':
            pipeline.add("h264parse", "parser")
            pipeline.add("nvv4l2decoder", "decoder")
        elif format_type == 'h265':
            pipeline.add("h265parse", "parser")
            pipeline.add("nvv4l2decoder", "decoder")
        elif format_type in ['mp4', 'mkv']:
            demux_type = "qtdemux" if format_type == 'mp4' else "matroskademux"
            pipeline.add(demux_type, "demux")
            pipeline.add("h264parse", "parser")
            pipeline.add("nvv4l2decoder", "decoder")
        else:
            print(f"Unsupported format: {format_type}")
            return

    # Converter and sink
    pipeline.add("nvvideoconvert", "converter")
    sink_type = "nv3dsink" if platform.processor() == "aarch64" else "nveglglessink"
    pipeline.add(sink_type, "sink", {"sync": 1})

    # Link based on format
    if "nvurisrcbin" in [e.name for e in pipeline.elements]:
        pipeline.link("src", "decoder", "converter", "sink")
    elif "demux" in [e.name for e in pipeline.elements]:
        pipeline.link("src", "demux")
        pipeline.link(("demux", "parser"), ("video_%u", ""))
        pipeline.link("parser", "decoder", "converter", "sink")
    else:
        pipeline.link("src", "parser", "decoder", "converter", "sink")

    pipeline.start().wait()
```

#### Feature 2: Window Controls

```python
def video_player_with_controls(video_path):
    """Video player with window positioning and sizing"""
    pipeline = Pipeline("controlled-player")

    pipeline.add("filesrc", "src", {"location": video_path})
    pipeline.add("h264parse", "parser")
    pipeline.add("nvv4l2decoder", "decoder")
    pipeline.add("nvvideoconvert", "converter")

    sink_type = "nv3dsink" if platform.processor() == "aarch64" else "nveglglessink"
    pipeline.add(sink_type, "sink", {
        "sync": 1,
        "window-x": 100,      # Window X position
        "window-y": 100,      # Window Y position
        "window-width": 1280, # Window width
        "window-height": 720  # Window height
    })

    pipeline.link("src", "parser", "decoder", "converter", "sink")
    pipeline.start().wait()
```

#### Feature 3: Frame Rate Control

```python
def video_player_with_framerate(video_path, fps=None):
    """Video player with frame rate control"""
    pipeline = Pipeline("framerate-player")

    pipeline.add("filesrc", "src", {"location": video_path})
    pipeline.add("h264parse", "parser")
    pipeline.add("nvv4l2decoder", "decoder")

    # Add videorate for frame rate control
    if fps:
        pipeline.add("videorate", "rate")
        pipeline.add("capsfilter", "caps", {
            "caps": f"video/x-raw(memory:NVMM),framerate={fps}/1"
        })

    pipeline.add("nvvideoconvert", "converter")
    sink_type = "nv3dsink" if platform.processor() == "aarch64" else "nveglglessink"
    pipeline.add(sink_type, "sink", {"sync": 1})

    if fps:
        pipeline.link("src", "parser", "decoder", "rate", "caps", "converter", "sink")
    else:
        pipeline.link("src", "parser", "decoder", "converter", "sink")

    pipeline.start().wait()
```

### Platform-Specific Considerations

#### x86_64 (Desktop/Server)
- Use `nveglglessink` for rendering
- Supports multiple displays
- Higher GPU memory bandwidth
- Better for high-resolution playback

#### ARM64 (Jetson)
- Use `nv3dsink` for rendering
- Optimized for power efficiency
- Integrated GPU with shared memory
- Better for embedded applications

### Performance Optimization Tips

1. **Always use hardware decoders**: `nvv4l2decoder` instead of software decoders
2. **Provide headroom**: Bump `num-extra-surfaces` to prevent surface starvation
3. **Use NVMM memory**: Keeps frames on GPU for nvvideoconvert/sinks
4. **Sync to display**: Set `sync=1` on sink for smooth playback
5. **Match resolutions**: Avoid unnecessary scaling

### Error Handling

```python
from multiprocessing import Process
import sys

def safe_video_player(video_path):
    """Video player with error handling"""
    try:
        pipeline = Pipeline("safe-player")
        # ... pipeline construction ...
        pipeline.start().wait()
    except KeyboardInterrupt:
        print("\nPlayback interrupted by user")
    except Exception as e:
        print(f"Error during playback: {e}")
        sys.exit(1)

if __name__ == "__main__":
    process = Process(target=safe_video_player, args=(sys.argv[1],))
    try:
        process.start()
        process.join()
    except KeyboardInterrupt:
        print("\nTerminating...")
        process.terminate()
        process.join()
```

### Common Issues and Solutions

#### Issue 1: Black Screen
**Solution**: Check if decoder is working, verify video format support

#### Issue 2: Stuttering Playback
**Solution**: check GPU utilization

#### Issue 3: Format Not Supported
**Solution**: Use `nvurisrcbin` for automatic format detection, or add appropriate parser

#### Issue 4: High CPU Usage
**Solution**: Ensure hardware decoder is used, not software decoder

---

## Part 2: Multi-Inference Pipelines

### Use Case Requirements

- Detect objects using primary inference engine
- Classify detected objects using secondary inference engines
- Extract multiple attributes (e.g., vehicle make, vehicle type, color)
- Process multiple video streams simultaneously
- Track objects across frames
- Visualize all inference results

### Pipeline Architecture

#### Cascaded Inference Pipeline
```
Source -> Decoder -> Muxer -> PGIE -> SGIE1 -> SGIE2 -> Tracker -> OSD -> Renderer
```

#### Parallel Inference Pipeline (Advanced)
```
Source -> Decoder -> Muxer -> PGIE -> [SGIE1, SGIE2] -> Merger -> Tracker -> OSD -> Renderer
```

### Implementation Approaches

#### Approach 1: Cascaded Detection + Classification

This is the most common pattern: detect objects first, then classify each detected object.

##### Pipeline API Implementation

```python
from pyservicemaker import Pipeline, Probe, BatchMetadataOperator, osd
import platform
import sys

def cascaded_inference_pipeline(video_path, pgie_config, sgie1_config, sgie2_config=None):
    """
    Cascaded inference: Detection -> Classification -> Attribute Detection

    Args:
        video_path: Path to video file
        pgie_config: Primary GIE config (object detection)
        sgie1_config: Secondary GIE config (first classification)
        sgie2_config: Optional second secondary GIE config
    """
    pipeline = Pipeline("cascaded-inference")

    # Source and decoding
    pipeline.add("filesrc", "src", {"location": video_path})
    pipeline.add("h264parse", "parser")
    pipeline.add("nvv4l2decoder", "decoder")

    # Stream muxer (batch multiple streams if needed)
    pipeline.add("nvstreammux", "mux", {
        "batch-size": 1,
        "width": 1920,
        "height": 1080
    })

    # Primary Inference Engine (Object Detection)
    pipeline.add("nvinfer", "pgie", {
        "config-file-path": pgie_config,
        "unique-id": 1
    })

    # Secondary Inference Engine 1 (Classification)
    pipeline.add("nvinfer", "sgie1", {
        "config-file-path": sgie1_config,
        "unique-id": 2
    })

    # Secondary Inference Engine 2 (Optional - Additional Classification)
    if sgie2_config:
        pipeline.add("nvinfer", "sgie2", {
            "config-file-path": sgie2_config,
            "unique-id": 3
        })

    # Tracker
    pipeline.add("nvtracker", "tracker", {
        "ll-lib-file": "/opt/nvidia/deepstream/deepstream/lib/libnvds_nvmultiobjecttracker.so",
        "ll-config-file": "/opt/nvidia/deepstream/deepstream/samples/configs/deepstream-app/config_tracker_NvDCF_perf.yml",
        "tracker-width": 640,
        "tracker-height": 384
    })

    # On-Screen Display
    pipeline.add("nvosdbin", "osd", {
        "gpu-id": 0
    })

    # Converter and Sink
    pipeline.add("nvvideoconvert", "nvvideoconvert", {"gpu-id": 0})
    sink_type = "nv3dsink" if platform.processor() == "aarch64" else "nveglglessink"
    pipeline.add(sink_type, "sink", {"sync": 1})

    # Link pipeline
    pipeline.link("src", "parser", "decoder")
    pipeline.link(("decoder", "mux"), ("", "sink_%u"))

    # Link inference chain
    if sgie2_config:
        pipeline.link("mux", "pgie", "sgie1", "sgie2", "tracker", "s", "nvvideoconvert", "sink")
    else:
        pipeline.link("mux", "pgie", "sgie1", "tracker", "s", "nvvideoconvert", "sink")

    # Start pipeline
    pipeline.start().wait()

if __name__ == "__main__":
    if len(sys.argv) < 4:
        print("Usage: python cascaded_inference.py <video> <pgie_config> <sgie1_config> [sgie2_config]")
        sys.exit(1)

    sgie2 = sys.argv[4] if len(sys.argv) > 4 else None
    cascaded_inference_pipeline(sys.argv[1], sys.argv[2], sys.argv[3], sgie2)
```

##### Configuration Files

**Primary GIE Config (pgie_config.yml)**:
```yaml
property:
  model-engine-file: /path/to/detector.engine
  labelfile-path: /path/to/detector_labels.txt
  batch-size: 1
  net-scale-factor: 0.0039215697906911373
  model-color-format: 0
  num-detected-classes: 4
  process-mode: 1
  gie-unique-id: 1
  network-mode: 0
  cluster-mode: 2

class-attrs-all:
  topk: 20
  nms-iou-threshold: 0.5
  pre-cluster-threshold: 0.2
```

**Secondary GIE Config (sgie1_config.yml)**:
```yaml
property:
  model-engine-file: /path/to/classifier.engine
  labelfile-path: /path/to/classifier_labels.txt
  batch-size: 16
  net-scale-factor: 0.0039215697906911373
  model-color-format: 0
  process-mode: 2
  network-mode: 0
  network-type: 1
  gie-unique-id: 2
  operate-on-gie-id: 1
  operate-on-class-ids: 0
  classifier-async-mode: 1
  classifier-threshold: 0.51
```

#### Approach 2: Multi-Stream with Cascaded Inference

Process multiple video streams with cascaded inference on each stream.

```python
def multi_stream_cascaded_inference(video_paths, pgie_config, sgie_configs):
    """
    Multi-stream cascaded inference

    Args:
        video_paths: List of video file paths
        pgie_config: Primary GIE config
        sgie_configs: List of secondary GIE configs
    """
    pipeline = Pipeline("multi-stream-cascaded")
    num_streams = len(video_paths)

    # Add sources
    for i, video_path in enumerate(video_paths):
        pipeline.add("filesrc", f"src{i}", {"location": video_path})
        pipeline.add("h264parse", f"parser{i}")
        pipeline.add("nvv4l2decoder", f"decoder{i}")

    # Stream muxer
    pipeline.add("nvstreammux", "mux", {
        "batch-size": num_streams,
        "width": 1920,
        "height": 1080
    })

    # Primary Inference
    pipeline.add("nvinfer", "pgie", {
        "config-file-path": pgie_config,
        "unique-id": 1
    })

    # Secondary Inferences
    for idx, sgie_config in enumerate(sgie_configs):
        pipeline.add("nvinfer", f"sgie{idx+1}", {
            "config-file-path": sgie_config,
            "unique-id": idx + 2
        })

    # Tracker
    pipeline.add("nvtracker", "tracker", {
        "ll-lib-file": "/opt/nvidia/deepstream/deepstream/lib/libnvds_nvmultiobjecttracker.so",
        "ll-config-file": "/opt/nvidia/deepstream/deepstream/samples/configs/deepstream-app/config_tracker_NvDCF_perf.yml"
    })

    # Stream demuxer
    pipeline.add("nvstreamdemux", "demux")

    # OSD and sinks for each stream
    for i in range(num_streams):
        pipeline.add("nvosdbin", f"osd{i}")
        pipeline.add("nvvideoconvert", f"converter{i}")
        pipeline.add("nveglglessink", f"sink{i}", {"sync": 1})

    # Link sources to muxer
    # CRITICAL: Always use "sink_%u" pad template for nvstreammux, NOT f"sink_{i}" or "sink_0"
    for i in range(num_streams):
        pipeline.link(f"src{i}", f"parser{i}", f"decoder{i}")
        pipeline.link((f"decoder{i}", "mux"), ("", "sink_%u"))  # Pad template auto-assigns sink_0, sink_1, etc.

    # Link inference chain
    link_chain = ["mux", "pgie"]
    for idx in range(len(sgie_configs)):
        link_chain.append(f"sgie{idx+1}")
    link_chain.extend(["tracker", "demux"])
    pipeline.link(*link_chain)

    # Link demuxer outputs to sinks
    for i in range(num_streams):
        pipeline.link((f"demux", f"osd{i}"), (f"src_{i}", ""))
        pipeline.link(f"osd{i}", f"converter{i}", f"sink{i}")

    pipeline.start().wait()
```

#### Approach 2b: Multi-Stream RTSP with nvurisrcbin and Cascaded Inference

Process multiple RTSP streams using nvurisrcbin with cascaded inference.

```python
def multi_rtsp_cascaded_inference(rtsp_urls, pgie_config, sgie_configs):
    """
    Multi-stream RTSP cascaded inference using nvurisrcbin

    Args:
        rtsp_urls: List of RTSP stream URLs
        pgie_config: Primary GIE config
        sgie_configs: List of secondary GIE configs
    """
    pipeline = Pipeline("multi-rtsp-cascaded")
    num_streams = len(rtsp_urls)

    # Add RTSP sources with nvurisrcbin (handles codec detection and decoding automatically)
    for i, url in enumerate(rtsp_urls):
        pipeline.add("nvurisrcbin", f"src{i}", {"uri": url})

    # Stream muxer
    pipeline.add("nvstreammux", "mux", {
        "batch-size": num_streams,
        "width": 1920,
        "height": 1080,
        "batched-push-timeout": 40000,
        "live-source": 1  # Important for RTSP streams
    })

    # Primary Inference
    pipeline.add("nvinfer", "pgie", {
        "config-file-path": pgie_config,
        "unique-id": 1,
        "batch-size": num_streams
    })

    # Secondary Inferences
    for idx, sgie_config in enumerate(sgie_configs):
        pipeline.add("nvinfer", f"sgie{idx+1}", {
            "config-file-path": sgie_config,
            "unique-id": idx + 2,
            "batch-size": num_streams
        })

    # Tracker
    pipeline.add("nvtracker", "tracker", {
        "ll-lib-file": "/opt/nvidia/deepstream/deepstream/lib/libnvds_nvmultiobjecttracker.so",
        "ll-config-file": "/opt/nvidia/deepstream/deepstream/samples/configs/deepstream-app/config_tracker_NvDCF_perf.yml"
    })

    # Tiler for multi-stream display
    pipeline.add("nvmultistreamtiler", "tiler", {
        "rows": 2,
        "columns": 2,
        "width": 1920,
        "height": 1080
    })

    # OSD and sink
    pipeline.add("nvosdbin", "osd")
    pipeline.add("nveglglessink", "sink", {"sync": 0})

    # Link sources to muxer - CRITICAL: Use "sink_%u" pad template
    # nvurisrcbin creates dynamic src pads, so link directly to mux sink pad template
    for i in range(num_streams):
        pipeline.link((f"src{i}", "mux"), ("", "sink_%u"))  # CORRECT - pad template auto-assigns
        # WRONG: pipeline.link((f"src{i}", "mux"), ("", f"sink_{i}"))  # This will FAIL!

    # Link inference chain
    link_chain = ["mux", "pgie"]
    for idx in range(len(sgie_configs)):
        link_chain.append(f"sgie{idx+1}")
    link_chain.extend(["tracker", "tiler", "osd", "sink"])
    pipeline.link(*link_chain)

    pipeline.start().wait()
```

#### Approach 3: Custom Postprocessing with Tensor Metadata

Use custom postprocessing when built-in parsers don't support your model format.

```python
from pyservicemaker import Pipeline, Probe, BatchMetadataOperator, postprocessing, osd
import torch  # pip install torch torchvision (not in base DS container)
import torchvision.ops as ops

class CustomDetectorConverter(postprocessing.ObjectDetectorOutputConverter):
    """Custom converter for detection model outputs"""
    NETWORK_WIDTH = 960
    NETWORK_HEIGHT = 544

    def __init__(self, threshold=0.5):
        self.threshold = threshold

    def __call__(self, output_layers):
        """Convert tensor outputs to detection format"""
        outputs = []

        # Extract output layers (adjust names based on your model)
        bbox_layer = output_layers.get('output_bbox/BiasAdd:0')
        conf_layer = output_layers.get('output_cov/Sigmoid:0')

        if bbox_layer is None or conf_layer is None:
            return outputs

        # Convert DLPack tensors to PyTorch
        bbox_tensor = torch.utils.dlpack.from_dlpack(bbox_layer).to('cpu')
        conf_tensor = torch.utils.dlpack.from_dlpack(conf_layer).to('cpu')

        # Process detections
        # ... custom processing logic ...

        return outputs

class CustomPostprocessor(BatchMetadataOperator):
    """Custom postprocessor for tensor outputs"""
    def __init__(self, converter):
        super().__init__()
        self.converter = converter
        self.stream_width = 1920
        self.stream_height = 1080

    def handle_metadata(self, batch_meta):
        for frame_meta in batch_meta.frame_items:
            # Process tensor metadata
            for tensor_meta in frame_meta.tensor_items:
                output_layers = tensor_meta.as_tensor_output().get_layers()
                detections = self.converter(output_layers)

                # Scale coordinates
                scale_x = self.stream_width / self.converter.NETWORK_WIDTH
                scale_y = self.stream_height / self.converter.NETWORK_HEIGHT

                # Create object metadata
                for det in detections:
                    class_id, conf, x1, y1, x2, y2 = det

                    obj_meta = batch_meta.acquire_object_meta()
                    obj_meta.class_id = int(class_id)
                    obj_meta.confidence = float(conf)
                    obj_meta.rect_params.left = x1 * scale_x
                    obj_meta.rect_params.top = y1 * scale_y
                    obj_meta.rect_params.width = (x2 - x1) * scale_x
                    obj_meta.rect_params.height = (y2 - y1) * scale_y
                    obj_meta.rect_params.border_width = 2
                    obj_meta.rect_params.border_color = osd.Color(1.0, 0.0, 0.0, 1.0)

                    frame_meta.append(obj_meta)

def custom_postprocessing_pipeline(video_path, infer_config):
    """Pipeline with custom postprocessing"""
    pipeline = Pipeline("custom-postprocess")

    # Source and decoding
    pipeline.add("filesrc", "src", {"location": video_path})
    pipeline.add("h264parse", "parser")
    pipeline.add("nvv4l2decoder", "decoder")
    pipeline.add("nvstreammux", "mux", {"batch-size": 1, "width": 1920, "height": 1080})

    # Inference with tensor output
    pipeline.add("nvinfer", "infer", {
        "config-file-path": infer_config,
        "output-tensor-meta": 1  # Enable tensor metadata output
    })

    # Disable built-in object metadata generation
    pipeline["infer"].set({"filter-out-class-ids": "0;1;2;3"})

    # Custom postprocessing
    converter = CustomDetectorConverter(threshold=0.5)
    postprocessor = CustomPostprocessor(converter)

    # Tracker, OSD, Sink
    pipeline.add("nvtracker", "tracker", {
        "ll-lib-file": "/opt/nvidia/deepstream/deepstream/lib/libnvds_nvmultiobjecttracker.so",
        "ll-config-file": "/opt/nvidia/deepstream/deepstream/samples/configs/deepstream-app/config_tracker_NvDCF_perf.yml"
    })
    pipeline.add("nvosdbin", "osd")
    pipeline.add("nvvideoconvert", "converter")
    pipeline.add("nveglglessink", "sink", {"sync": 1})

    # Link and attach probe
    pipeline.link("src", "parser", "decoder")
    pipeline.link(("decoder", "mux"), ("", "sink_%u"))
    pipeline.link("mux", "infer", "tracker", "osd", "converter", "sink")
    pipeline.attach("infer", Probe("postprocess", postprocessor))

    pipeline.start().wait()
```

#### Approach 4: Preprocessing + Inference Pipeline

Use custom preprocessing before inference for ROI-based processing.

```python
def preprocessing_inference_pipeline(video_path, preprocess_config, infer_config):
    """Pipeline with custom preprocessing"""
    pipeline = Pipeline("preprocess-inference")

    # Source and decoding
    pipeline.add("filesrc", "src", {"location": video_path})
    pipeline.add("h264parse", "parser")
    pipeline.add("nvv4l2decoder", "decoder")
    pipeline.add("nvstreammux", "mux", {"batch-size": 1, "width": 1920, "height": 1080})

    # Custom preprocessing
    pipeline.add("nvdspreprocess", "preprocess", {
        "config-file": preprocess_config,
        "gpu-id": 0
    })

    # Inference with tensor input
    pipeline.add("nvinfer", "infer", {
        "config-file-path": infer_config,
        "input-tensor-meta": 1,  # Use tensor metadata from preprocessing
        "batch-size": 1
    })

    # Postprocessing (if needed)
    pipeline.add("nvdspostprocess", "postprocess", {
        "postprocesslib-name": "/path/to/libpostprocess.so",
        "postprocesslib-config-file": "/path/to/postprocess_config.yml"
    })

    # Tracker, OSD, Sink
    pipeline.add("nvtracker", "tracker", {
        "ll-lib-file": "/opt/nvidia/deepstream/deepstream/lib/libnvds_nvmultiobjecttracker.so",
        "ll-config-file": "/opt/nvidia/deepstream/deepstream/samples/configs/deepstream-app/config_tracker_NvDCF_perf.yml"
    })
    pipeline.add("nvosdbin", "osd")
    pipeline.add("nvvideoconvert", "converter")
    pipeline.add("nveglglessink", "sink", {"sync": 1})

    # Link
    pipeline.link("src", "parser", "decoder")
    pipeline.link(("decoder", "mux"), ("", "sink_%u"))
    pipeline.link("mux", "preprocess", "infer", "postprocess", "tracker", "osd", "converter", "sink")

    pipeline.start().wait()
```

### Metadata Processing Examples

#### Example 1: Extract All Inference Results

```python
class InferenceResultExtractor(BatchMetadataOperator):
    """Extract and print all inference results"""
    def handle_metadata(self, batch_meta):
        for frame_meta in batch_meta.frame_items:
            print(f"\nFrame {frame_meta.frame_number}:")

            for obj_meta in frame_meta.object_items:
                print(f"  Object:")
                print(f"    Class ID: {obj_meta.class_id}")
                print(f"    Confidence: {obj_meta.confidence:.2f}")
                print(f"    BBox: ({obj_meta.rect_params.left:.1f}, "
                      f"{obj_meta.rect_params.top:.1f}, "
                      f"{obj_meta.rect_params.width:.1f}, "
                      f"{obj_meta.rect_params.height:.1f})")
                print(f"    Object ID (Tracking): {obj_meta.object_id}")

                # Check for secondary inference results
                # Secondary results are stored in object metadata
                # Access via obj_meta.obj_user_meta_list
```

#### Example 2: Filter Objects by Confidence

```python
class ConfidenceFilter(BatchMetadataOperator):
    """Filter objects by confidence threshold"""
    def __init__(self, threshold=0.5):
        super().__init__()
        self.threshold = threshold

    def handle_metadata(self, batch_meta):
        for frame_meta in batch_meta.frame_items:
            # Remove low-confidence objects
            objects_to_remove = []
            for obj_meta in frame_meta.object_items:
                if obj_meta.confidence < self.threshold:
                    objects_to_remove.append(obj_meta)

            # Note: Direct removal may not be supported
            # Instead, mark them or filter in downstream processing
```

#### Example 3: Aggregate Statistics

```python
class StatisticsAggregator(BatchMetadataOperator):
    """Aggregate statistics across frames"""
    def __init__(self):
        super().__init__()
        self.class_counts = {}
        self.total_frames = 0

    def handle_metadata(self, batch_meta):
        self.total_frames += len(batch_meta.frame_items)

        for frame_meta in batch_meta.frame_items:
            for obj_meta in frame_meta.object_items:
                class_id = obj_meta.class_id
                self.class_counts[class_id] = self.class_counts.get(class_id, 0) + 1

    def print_statistics(self):
        print(f"\nStatistics:")
        print(f"Total frames processed: {self.total_frames}")
        print(f"Class distribution:")
        for class_id, count in self.class_counts.items():
            print(f"  Class {class_id}: {count} objects")
```

### Performance Optimization

#### Batch Size Optimization

```python
def optimize_batch_size(num_streams, gpu_memory_gb):
    """Calculate optimal batch size"""
    # Rule of thumb: 1GB GPU memory per stream for 1080p
    max_batch = min(num_streams, gpu_memory_gb)
    # Use power of 2 for better GPU utilization
    batch_size = 1
    while batch_size * 2 <= max_batch:
        batch_size *= 2
    return batch_size
```

#### Inference Precision Selection

```python
# In inference config file:
# network-mode: 0 = FP32 (highest accuracy, slowest)
# network-mode: 1 = FP16 (good balance)
# network-mode: 2 = INT8 (fastest, may need calibration)

# For production, typically use FP16:
infer_config = {
    "network-mode": 1  # FP16
}
```

### Common Patterns

#### Pattern 1: Vehicle Detection + Make/Type Classification

```python
# PGIE: Vehicle detection (cars, trucks, buses)
# SGIE1: Vehicle make classification (Toyota, Honda, Ford, etc.)
# SGIE2: Vehicle type classification (sedan, SUV, truck, etc.)

pipeline.link("mux", "pgie", "sgie1", "sgie2", "tracker", "osd", "sink")
```

#### Pattern 2: Person Detection + Attribute Classification

```python
# PGIE: Person detection
# SGIE1: Gender classification
# SGIE2: Age estimation
# SGIE3: Clothing classification

pipeline.link("mux", "pgie", "sgie1", "sgie2", "sgie3", "tracker", "osd", "sink")
```

#### Pattern 3: Multi-Model Ensemble

```python
# Run multiple detection models and merge results
# Requires custom postprocessing to combine outputs
```

### Best Practices

1. **Use appropriate batch sizes**: Match number of streams
2. **Cascade inferences properly**: Ensure operate-on-gie-id is correct
3. **Filter classes appropriately**: Use operate-on-class-ids
4. **Optimize inference precision**: Use FP16 for production
5. **Monitor GPU memory**: Adjust batch sizes accordingly
6. **Use tracker after all inferences**: Ensures consistent tracking
7. **Test with representative data**: Use real-world video samples
