# Buffer Provider and Retriever APIs

## Overview

DeepStream Service Maker provides two complementary APIs for custom data injection and extraction:

1. **Media Extractor (BufferProvider/Feeder)** - Inject custom data INTO pipelines
2. **Frame Selector (BufferRetriever/Receiver)** - Extract data FROM pipelines

## When to Use Each API

### Use BufferProvider/Feeder When:
- You need to inject custom video frames from non-standard sources
- You want to generate synthetic video data for testing
- You have pre-processed frames to feed into the pipeline
- You need to implement custom video sources beyond file/RTSP
- You want to transfer frames FROM another pipeline or system INTO DeepStream

**See**: Part 1 below for detailed API reference and implementation patterns.

### Use BufferRetriever/Receiver When:
- You need to extract frames for custom processing outside the pipeline
- You want to save specific frames to disk or external storage
- You need to collect inference results with frame data
- You want to implement custom frame selection logic
- You want to transfer frames FROM DeepStream TO another pipeline or system

**See**: Part 2 below for detailed API reference and implementation patterns.

## Common Patterns

### Pattern 1: Pipeline-to-Pipeline Transfer
Transfer frames between two DeepStream pipelines.

```
Pipeline A -> BufferRetriever -> Queue -> BufferProvider -> Pipeline B
```

**Use Case**: Process video in one pipeline, then re-process results in another

**Details**: See Part 1 Pattern 3 (Frame Queue Injection) and Part 2 Pattern 2 (Frame Queue Transfer)

### Pattern 2: Custom Video Source
Read from custom camera or video source.

```
Custom Source -> BufferProvider -> appsrc -> DeepStream Pipeline
```

**Use Case**: Integrate non-standard cameras or video sources

**Details**: See Part 1 Pattern 1 (File-Based Custom Video Source)

### Pattern 3: Frame Extraction
Extract frames from pipeline for archival or analysis.

```
DeepStream Pipeline -> appsink -> BufferRetriever -> Save/Process
```

**Use Case**: Save frames at intervals, capture detection screenshots

**Details**: See Part 2 Pattern 1 (Frame Extraction and Saving)

### Pattern 4: Synthetic Data Generation
Generate test data for pipeline validation.

```
Synthetic Generator -> BufferProvider -> appsrc -> DeepStream Pipeline
```

**Use Case**: Testing, simulation, validation

**Details**: See Part 1 Pattern 2 (Synthetic Frame Generation)

### Pattern 5: Selective Frame Capture
Capture frames based on inference results.

```
Pipeline -> Inference -> Metadata Probe -> Trigger -> BufferRetriever -> Save
```

**Use Case**: Save frames only when specific objects detected

**Details**: See Part 2 Pattern 3 (Selective Frame Capture)

## API Comparison

| Feature | BufferProvider/Feeder | BufferRetriever/Receiver |
|---------|----------------------|--------------------------|
| **Direction** | Data IN (injection) | Data OUT (extraction) |
| **GStreamer Element** | appsrc | appsink |
| **Signal** | need-data/enough-data | new-sample |
| **Method to Implement** | `generate(size)` | `consume(buffer)` |
| **Return Value** | Buffer object | int (1=success, 0=error) |
| **EOS Handling** | Return empty Buffer() | Return -1 |
| **Properties** | format, width, height, framerate, device | None (configured on appsink) |

## Quick Start Examples

### Inject Custom Frames (BufferProvider)

```python
from pyservicemaker import Pipeline, BufferProvider, Feeder, as_tensor, ColorFormat, Buffer
import torch  # pip install torch torchvision (not in base DS container)

class MyProvider(BufferProvider):
    def __init__(self):
        super().__init__()
        self.format = "RGB"
        self.width = 1280
        self.height = 720
        self.framerate = 30
        self.device = 'gpu'

    def generate(self, size):
        # Your custom frame generation logic
        frame = get_custom_frame()  # Your function
        if frame is None:
            return Buffer()  # EOS

        torch_tensor = torch.from_numpy(frame).cuda()
        ds_tensor = as_tensor(torch_tensor, "HWC")
        return ds_tensor.wrap(ColorFormat.RGB)

pipeline = Pipeline("inject-pipeline")
caps = "video/x-raw(memory:NVMM), format=RGB, width=1280, height=720, framerate=30/1"
pipeline.add("appsrc", "src", {"caps": caps, "do-timestamp": True})
# ... add more elements ...
pipeline.attach("src", Feeder("feeder", MyProvider()), tips="need-data/enough-data")
pipeline.start().wait()
```

### Extract Frames (BufferRetriever)

```python
from pyservicemaker import Pipeline, BufferRetriever, Receiver
import torch  # pip install torch torchvision (not in base DS container)

class MyRetriever(BufferRetriever):
    def __init__(self):
        super().__init__()
        self.count = 0

    def consume(self, buffer):
        tensor = buffer.extract(0).clone()  # Always clone!
        torch_tensor = torch.utils.dlpack.from_dlpack(tensor)

        # Your custom processing logic
        process_frame(torch_tensor)  # Your function

        self.count += 1
        return 1  # Success

pipeline = Pipeline("extract-pipeline")
# ... add source and processing elements ...
pipeline.add("appsink", "sink", {"emit-signals": True, "sync": False})
pipeline.attach("sink", Receiver("receiver", MyRetriever()), tips="new-sample")
pipeline.start().wait()
```

## Key Concepts

### BufferProvider/Feeder
- **Purpose**: Custom data injection
- **Element**: Works with `appsrc`
- **Flow**: Your code -> BufferProvider -> Pipeline
- **Control**: Pipeline pulls data when needed
- **Properties**: Must set format, width, height, framerate, device

### BufferRetriever/Receiver
- **Purpose**: Custom data extraction
- **Element**: Works with `appsink`
- **Flow**: Pipeline -> BufferRetriever -> Your code
- **Control**: Pipeline pushes data when available
- **Critical**: Always call `.clone()` on extracted tensors

## Best Practices Summary

### For BufferProvider:
1. Set all required properties (format, width, height, framerate, device)
2. Return empty `Buffer()` to signal end of stream
3. Use GPU memory (`device='gpu'`) for best performance
4. Set `do-timestamp=True` on appsrc for proper sync
5. Use `tips="need-data/enough-data"` when attaching

### For BufferRetriever:
1. **Always** call `.clone()` on extracted tensors
2. Set `emit-signals=True` on appsink
3. Use `tips="new-sample"` when attaching
4. Return 1 for success, 0 for error (continue), -1 for fatal error
5. Set `sync=False` for non-real-time extraction

## Common Pitfalls

### BufferProvider Issues:
- Forgetting to set format properties -> Pipeline fails to negotiate caps
- Not returning empty Buffer() for EOS -> Pipeline hangs
- Mismatched caps between provider and appsrc -> Format errors

### BufferRetriever Issues:
- Not calling `.clone()` -> Data corruption in async processing
- Forgetting `emit-signals=True` -> No frames received
- Slow processing in consume() -> Frame drops
- Not handling exceptions -> Pipeline crashes

## Performance Tips

### BufferProvider:
- Use GPU memory for zero-copy transfers
- Pre-allocate buffers when possible
- Avoid CPU<->GPU transfers in hot path
- Consider buffer pooling for high frame rates

### BufferRetriever:
- Set `sync=False` if you don't need real-time pacing
- Process frames asynchronously if possible
- Limit buffer accumulation to prevent memory issues
- Use batch processing when extracting multiple streams

## Example Applications

The service-maker package includes sample applications demonstrating these APIs:

**Pipeline API Examples**:
- `/opt/nvidia/deepstream/deepstream/service-maker/sources/apps/python/pipeline_api/deepstream_appsrc_test_app/`

**Flow API Examples**:
- `/opt/nvidia/deepstream/deepstream/service-maker/sources/apps/python/flow_api/deepstream_appsrc_test_app/`

## Goal-Based API Selection

| Goal | Use This API | Section |
|------|-------------|---------|
| Inject custom frames | BufferProvider/Feeder | Part 1 |
| Extract frames | BufferRetriever/Receiver | Part 2 |
| Pipeline-to-pipeline transfer | Both | Part 1 Pattern 3, Part 2 Pattern 2 |
| Custom video source | BufferProvider/Feeder | Part 1 Pattern 1 |
| Frame archival | BufferRetriever/Receiver | Part 2 Pattern 1 |
| Synthetic data generation | BufferProvider/Feeder | Part 1 Pattern 2 |
| Selective capture | BufferRetriever/Receiver | Part 2 Pattern 3 |

Choose the right API based on your data flow direction: injection (BufferProvider) or extraction (BufferRetriever).

---

# Part 1: BufferProvider / Feeder API (Media Extractor)

## Overview

The Media Extractor API (implemented through `BufferProvider` and `Feeder` classes) enables custom data injection into DeepStream pipelines. This is useful for:
- Injecting custom video frames from non-standard sources
- Generating synthetic video data for testing
- Feeding pre-processed frames into the pipeline
- Implementing custom video sources beyond file/RTSP streams

## Core Concepts

### BufferProvider
A `BufferProvider` is a user-implemented class that generates buffers on-demand. It works with GStreamer's `appsrc` element to inject data into the pipeline.

### Feeder
A `Feeder` is a wrapper that connects a `BufferProvider` to an `appsrc` element. It manages the signal handling for "need-data" and "enough-data" events.

### Data Flow
```
BufferProvider.generate() -> Feeder -> appsrc -> Pipeline
```

## API Reference

### BufferProvider Class

Base class for implementing custom media providers.

**Methods to Override**:

#### `generate(size)`
Generate a buffer when the pipeline needs data.

**Parameters**:
- `size` (int): Number of bytes requested by the pipeline

**Returns**: `Buffer` object containing the data, or empty `Buffer()` to signal EOS

**Properties to Set**:
- `format` (str): Video format (e.g., "RGB", "NV12")
- `width` (int): Frame width in pixels
- `height` (int): Frame height in pixels
- `framerate` (int): Frame rate
- `device` (str): 'gpu' or 'cpu'

**Example**:
```python
from pyservicemaker import BufferProvider, as_tensor, ColorFormat, Buffer
import torch  # pip install torch torchvision (not in base DS container)

class MyBufferProvider(BufferProvider):
    def __init__(self, video_source):
        super().__init__()
        self.source = video_source
        self.format = "RGB"
        self.width = 1920
        self.height = 1080
        self.framerate = 30
        self.device = 'gpu'
        self.frame_count = 0

    def generate(self, size):
        # Get frame from your custom source
        frame = self.source.get_next_frame()

        if frame is None:
            # Signal end of stream
            return Buffer()

        # Convert to torch tensor (on GPU if needed)
        torch_tensor = torch.from_numpy(frame).cuda()

        # Convert to DeepStream tensor format
        ds_tensor = as_tensor(torch_tensor, "HWC")  # Height, Width, Channels

        # Wrap in buffer with color format
        buffer = ds_tensor.wrap(ColorFormat.RGB)

        self.frame_count += 1
        return buffer
```

### Feeder Class

Wrapper for attaching a BufferProvider to a pipeline element.

**Constructor**:
```python
from pyservicemaker import Feeder

feeder = Feeder("feeder-name", buffer_provider_instance)
```

**Parameters**:
- `name` (str): Name of the feeder
- `provider` (BufferProvider): BufferProvider instance

### Helper Functions

#### `as_tensor(torch_tensor, layout)`
Convert a PyTorch tensor to DeepStream tensor format.

**Parameters**:
- `torch_tensor`: PyTorch tensor
- `layout` (str): Tensor layout - "HWC" (Height, Width, Channels) or "CHW"

**Returns**: DeepStream tensor object

#### ColorFormat Enum
Specifies the pixel format for buffers.

**Values**:
- `ColorFormat.RGB`: RGB format
- `ColorFormat.RGBA`: RGBA format
- `ColorFormat.NV12`: NV12 format (YUV 4:2:0)
- `ColorFormat.GRAY`: Grayscale

### Buffer Class

Container for video frame data.

**Constructor**:
```python
buffer = Buffer()  # Empty buffer (signals EOS)
```

**Methods**:
- `extract(index)`: Extract tensor at index from buffer
- `clone()`: Create a copy of the buffer

## Implementation Patterns

### Pattern 1: File-Based Custom Video Source

Read frames from custom file format and inject into pipeline.

```python
from pyservicemaker import Pipeline, BufferProvider, Feeder, as_tensor, ColorFormat, Buffer
import cv2  # pip install opencv-python-headless (not in base DS container)
import torch  # pip install torch torchvision (not in base DS container)
import platform

class CustomVideoFileProvider(BufferProvider):
    def __init__(self, video_path):
        super().__init__()
        self.cap = cv2.VideoCapture(video_path)

        # Set buffer properties
        self.format = "RGB"
        self.width = int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        self.height = int(self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        self.framerate = int(self.cap.get(cv2.CAP_PROP_FPS))
        self.device = 'gpu'
        self.frame_count = 0

    def generate(self, size):
        ret, frame = self.cap.read()

        if not ret:
            # End of video
            self.cap.release()
            return Buffer()

        # Convert BGR to RGB
        frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

        # Convert to torch tensor and move to GPU
        torch_tensor = torch.from_numpy(frame_rgb).cuda()

        # Convert to DeepStream tensor
        ds_tensor = as_tensor(torch_tensor, "HWC")

        self.frame_count += 1
        print(f"Generated frame {self.frame_count}")

        return ds_tensor.wrap(ColorFormat.RGB)

def main(video_path):
    pipeline = Pipeline("custom-video-source")

    # Create appsrc with appropriate capabilities
    caps = f"video/x-raw(memory:NVMM), format=RGB, width=1920, height=1080, framerate=30/1"
    pipeline.add("appsrc", "src", {
        "caps": caps,
        "do-timestamp": True,
        "format": 3  # GST_FORMAT_TIME
    })

    # Add processing elements
    pipeline.add("nvvideoconvert", "convert", {
        "nvbuf-memory-type": 2,  # NVBUF_MEM_CUDA_DEVICE
        "compute-hw": 1
    })
    pipeline.add("capsfilter", "caps", {"caps": "video/x-raw(memory:NVMM), format=NV12"})
    pipeline.add("nvstreammux", "mux", {
        "batch-size": 1,
        "width": 1920,
        "height": 1080
    })

    # Add inference (optional)
    pipeline.add("nvinfer", "infer", {
        "config-file-path": "/path/to/config.yml"
    })

    # Add display
    pipeline.add("nvosdbin", "osd")
    sink_type = "nv3dsink" if platform.processor() == "aarch64" else "nveglglessink"
    pipeline.add(sink_type, "sink", {"sync": False})

    # Link elements
    pipeline.link("src", "convert")
    pipeline.link(("convert", "mux"), ("", "sink_%u"))
    pipeline.link("mux", "infer", "osd", "sink")

    # Attach feeder to appsrc
    provider = CustomVideoFileProvider(video_path)
    pipeline.attach("src", Feeder("feeder", provider), tips="need-data/enough-data")

    # Start pipeline
    pipeline.start().wait()

if __name__ == "__main__":
    import sys
    main(sys.argv[1])
```

### Pattern 2: Synthetic Frame Generation

Generate synthetic frames for testing or simulation.

```python
from pyservicemaker import Pipeline, BufferProvider, Feeder, as_tensor, ColorFormat, Buffer
import torch  # pip install torch torchvision (not in base DS container)
import numpy as np

class SyntheticFrameProvider(BufferProvider):
    def __init__(self, num_frames=100, width=1280, height=720, fps=30):
        super().__init__()
        self.format = "RGB"
        self.width = width
        self.height = height
        self.framerate = fps
        self.device = 'gpu'
        self.num_frames = num_frames
        self.frame_idx = 0

    def generate(self, size):
        if self.frame_idx >= self.num_frames:
            return Buffer()

        # Generate synthetic frame (moving gradient)
        x = np.linspace(0, 255, self.width, dtype=np.uint8)
        y = np.linspace(0, 255, self.height, dtype=np.uint8)

        offset = (self.frame_idx * 5) % 255
        frame = np.zeros((self.height, self.width, 3), dtype=np.uint8)
        frame[:, :, 0] = (x + offset) % 255  # Red channel
        frame[:, :, 1] = (y + offset) % 255  # Green channel
        frame[:, :, 2] = 128  # Blue channel

        # Convert to torch and move to GPU
        torch_tensor = torch.from_numpy(frame).cuda()
        ds_tensor = as_tensor(torch_tensor, "HWC")

        self.frame_idx += 1
        return ds_tensor.wrap(ColorFormat.RGB)

def generate_test_video():
    pipeline = Pipeline("synthetic-video")

    provider = SyntheticFrameProvider(num_frames=300, width=1280, height=720, fps=30)

    caps = f"video/x-raw(memory:NVMM), format=RGB, width={provider.width}, height={provider.height}, framerate={provider.framerate}/1"
    pipeline.add("appsrc", "src", {"caps": caps, "do-timestamp": True})
    pipeline.add("nvvideoconvert", "convert")
    pipeline.add("nvv4l2h264enc", "encoder", {"bitrate": 4000000})
    pipeline.add("h264parse", "parser")
    pipeline.add("mp4mux", "mux")
    pipeline.add("filesink", "sink", {"location": "synthetic_output.mp4"})

    pipeline.link("src", "convert", "encoder", "parser", "mux", "sink")
    pipeline.attach("src", Feeder("feeder", provider), tips="need-data/enough-data")

    pipeline.start().wait()
```

### Pattern 3: Frame Queue Injection

Transfer frames between two pipelines using a queue.

```python
from pyservicemaker import Pipeline, BufferProvider, Feeder, as_tensor, ColorFormat, Buffer
from queue import Queue, Empty
import torch  # pip install torch torchvision (not in base DS container)

class QueuedBufferProvider(BufferProvider):
    def __init__(self, frame_queue, width=1280, height=720):
        super().__init__()
        self.queue = frame_queue
        self.format = "RGB"
        self.width = width
        self.height = height
        self.framerate = 30
        self.device = 'gpu'

    def generate(self, size):
        try:
            # Wait up to 2 seconds for frame
            tensor = self.queue.get(timeout=2)

            # Convert DLPack tensor to PyTorch
            torch_tensor = torch.utils.dlpack.from_dlpack(tensor)

            # Convert to DeepStream tensor
            ds_tensor = as_tensor(torch_tensor, "HWC")

            return ds_tensor.wrap(ColorFormat.RGB)
        except Empty:
            # Queue is empty, signal EOS
            print("Queue empty, ending stream")
            return Buffer()

def pipeline_with_queue_injection(frame_queue):
    pipeline = Pipeline("queue-injection")

    provider = QueuedBufferProvider(frame_queue, width=1280, height=720)

    caps = f"video/x-raw(memory:NVMM), format=RGB, width={provider.width}, height={provider.height}, framerate={provider.framerate}/1"
    pipeline.add("appsrc", "src", {"caps": caps, "do-timestamp": True})
    pipeline.add("nvvideoconvert", "convert", {"nvbuf-memory-type": 2})
    pipeline.add("capsfilter", "caps", {"caps": "video/x-raw(memory:NVMM), format=NV12"})
    pipeline.add("nvstreammux", "mux", {"batch-size": 1, "width": 1280, "height": 720})
    pipeline.add("nveglglessink", "sink", {"sync": False})

    pipeline.link("src", "convert", "caps")
    pipeline.link(("convert", "mux"), ("", "sink_%u"))
    pipeline.link("mux", "sink")

    pipeline.attach("src", Feeder("feeder", provider), tips="need-data/enough-data")
    pipeline.start().wait()
```

### Pattern 4: Flow API with Buffer Injection

High-level Flow API for buffer injection.

```python
from pyservicemaker import Pipeline, Flow, BufferProvider, ColorFormat, as_tensor, Buffer
import torch  # pip install torch torchvision (not in base DS container)
import cv2  # pip install opencv-python-headless (not in base DS container)

class SimpleVideoProvider(BufferProvider):
    def __init__(self, video_path):
        super().__init__()
        self.cap = cv2.VideoCapture(video_path)
        self.format = "RGB"
        self.width = int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        self.height = int(self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        self.framerate = int(self.cap.get(cv2.CAP_PROP_FPS))
        self.device = 'gpu'

    def generate(self, size):
        ret, frame = self.cap.read()
        if not ret:
            return Buffer()

        frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        torch_tensor = torch.from_numpy(frame_rgb).cuda()
        ds_tensor = as_tensor(torch_tensor, "HWC")
        return ds_tensor.wrap(ColorFormat.RGB)

def flow_api_injection(video_path):
    pipeline = Pipeline("flow-injection")
    provider = SimpleVideoProvider(video_path)

    # Flow API: inject() -> infer() -> render()
    flow = Flow(pipeline)
    flow.inject([provider])  # Pass list of providers
    flow.infer("/path/to/config.yml")  # Optional: add inference
    flow.render()  # Add renderer
    flow()  # Execute
```

## Advanced Usage

### Multi-Source Buffer Injection

Inject from multiple custom sources simultaneously.

```python
from pyservicemaker import Pipeline, BufferProvider, Feeder, as_tensor, ColorFormat, Buffer
import cv2  # pip install opencv-python-headless (not in base DS container)
import torch  # pip install torch torchvision (not in base DS container)

class MultiSourceProvider(BufferProvider):
    def __init__(self, source_id, video_path):
        super().__init__()
        self.source_id = source_id
        self.cap = cv2.VideoCapture(video_path)
        self.format = "RGB"
        self.width = 1280
        self.height = 720
        self.framerate = 30
        self.device = 'gpu'

    def generate(self, size):
        ret, frame = self.cap.read()
        if not ret:
            return Buffer()

        # Resize to common size
        frame = cv2.resize(frame, (self.width, self.height))
        frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

        torch_tensor = torch.from_numpy(frame_rgb).cuda()
        ds_tensor = as_tensor(torch_tensor, "HWC")
        return ds_tensor.wrap(ColorFormat.RGB)

def multi_source_injection(video_paths):
    pipeline = Pipeline("multi-source-injection")

    # Create multiple appsrc elements
    for i, path in enumerate(video_paths):
        caps = "video/x-raw(memory:NVMM), format=RGB, width=1280, height=720, framerate=30/1"
        pipeline.add("appsrc", f"src{i}", {"caps": caps, "do-timestamp": True})
        pipeline.add("nvvideoconvert", f"convert{i}", {"nvbuf-memory-type": 2})

    # Add muxer
    pipeline.add("nvstreammux", "mux", {
        "batch-size": len(video_paths),
        "width": 1280,
        "height": 720
    })

    # Add inference and display
    pipeline.add("nvinfer", "infer", {"config-file-path": "/path/to/config.yml"})
    pipeline.add("nvmultistreamtiler", "tiler", {"rows": 2, "columns": 2})
    pipeline.add("nvosdbin", "osd")
    pipeline.add("nveglglessink", "sink")

    # Link sources to muxer
    for i in range(len(video_paths)):
        pipeline.link(f"src{i}", f"convert{i}")
        pipeline.link((f"convert{i}", "mux"), ("", "sink_%u"))

        # Attach feeder
        provider = MultiSourceProvider(i, video_paths[i])
        pipeline.attach(f"src{i}", Feeder(f"feeder{i}", provider), tips="need-data/enough-data")

    # Link processing chain
    pipeline.link("mux", "infer", "tiler", "osd", "sink")
    pipeline.start().wait()
```

## Part 1 Best Practices

### 1. Memory Management
- Use GPU memory (`device='gpu'`) for best performance
- Release resources properly (close files, release capture devices)
- Avoid memory leaks by managing tensors correctly

### 2. Buffer Format
- Always specify correct `format`, `width`, `height`, and `framerate`
- Match color format with pipeline requirements
- Use `ColorFormat.RGB` for most cases, `ColorFormat.NV12` for optimized pipelines

### 3. Timestamping
- Set `"do-timestamp": True` on appsrc for proper synchronization
- Important for multi-stream applications

### 4. Signal Handling
- Use `tips="need-data/enough-data"` when attaching Feeder
- This enables proper flow control and prevents buffer overflow

### 5. End of Stream
- Return empty `Buffer()` to signal EOS
- Properly cleanup resources before returning EOS

### 6. Error Handling
```python
class SafeBufferProvider(BufferProvider):
    def __init__(self, source):
        super().__init__()
        self.source = source
        self.format = "RGB"
        self.width = 1280
        self.height = 720
        self.framerate = 30
        self.device = 'gpu'

    def generate(self, size):
        try:
            frame = self.source.get_frame()
            if frame is None:
                return Buffer()

            torch_tensor = torch.from_numpy(frame).cuda()
            ds_tensor = as_tensor(torch_tensor, "HWC")
            return ds_tensor.wrap(ColorFormat.RGB)
        except Exception as e:
            print(f"Error generating buffer: {e}")
            return Buffer()  # Signal EOS on error
```

## Part 1 Common Use Cases

### 1. Custom Camera Integration
Integrate cameras not supported by standard GStreamer elements.

### 2. Pre-processed Frame Injection
Inject frames that have been pre-processed by custom algorithms.

### 3. Frame Rate Control
Control exact frame timing and rate for testing.

### 4. Multi-Pipeline Communication
Transfer frames between multiple DeepStream pipelines. See also Part 2 Pattern 2 for the retriever side of pipeline-to-pipeline transfer.

### 5. Synthetic Data Generation
Generate synthetic data for testing inference models.

### 6. Image Sequence Processing
Process sequences of images as video streams.

## Part 1 Troubleshooting

### Issue 1: Frames Not Flowing
**Solution**: Check that `tips="need-data/enough-data"` is set, verify appsrc caps match buffer properties

### Issue 2: Memory Errors
**Solution**: Ensure tensors are on correct device (GPU/CPU), check memory allocation

### Issue 3: Format Mismatch
**Solution**: Verify color format matches between BufferProvider and appsrc caps

### Issue 4: Timing Issues
**Solution**: Enable timestamping with `"do-timestamp": True`

## Part 1 Summary

The Media Extractor API (BufferProvider/Feeder) provides a powerful way to inject custom video data into DeepStream pipelines. Key points:

1. Implement `BufferProvider.generate()` to create custom buffers
2. Use `Feeder` to attach provider to `appsrc` elements
3. Convert data to DeepStream format using `as_tensor()` and `wrap()`
4. Return empty `Buffer()` to signal end of stream
5. Always set correct format properties (`width`, `height`, `framerate`, etc.)
6. Use GPU memory for optimal performance

This API enables seamless integration of custom video sources with DeepStream's powerful inference and analytics capabilities.

---

# Part 2: BufferRetriever / Receiver API (Frame Selector)

## Overview

The Frame Selector API (implemented through `BufferRetriever` and `Receiver` classes) enables extraction of video frames and buffers from DeepStream pipelines. This is useful for:
- Extracting frames for custom processing outside the pipeline
- Saving frames to disk or sending to external systems
- Collecting inference results with frame data
- Implementing custom frame selection logic
- Transferring data between multiple pipelines

## Core Concepts

### BufferRetriever
A `BufferRetriever` is a user-implemented class that consumes buffers from the pipeline. It works with GStreamer's `appsink` element to extract data from the pipeline.

### Receiver
A `Receiver` is a wrapper that connects a `BufferRetriever` to an `appsink` element. It manages the signal handling for "new-sample" events.

### Data Flow
```
Pipeline -> appsink -> Receiver -> BufferRetriever.consume()
```

## API Reference

### BufferRetriever Class

Base class for implementing custom buffer consumers.

**Methods to Override**:

#### `consume(buffer)`
Process a buffer received from the pipeline.

**Parameters**:
- `buffer` (Buffer): Buffer object containing frame data

**Returns**: int (1 for success, 0 or negative for error/stop)

**Example**:
```python
from pyservicemaker import BufferRetriever
import torch  # pip install torch torchvision (not in base DS container)

class MyBufferRetriever(BufferRetriever):
    def __init__(self):
        super().__init__()
        self.frame_count = 0

    def consume(self, buffer):
        # Extract tensor from buffer at index 0
        tensor = buffer.extract(0)

        # Clone to prevent data loss
        tensor_copy = tensor.clone()

        # Convert to PyTorch for processing
        torch_tensor = torch.utils.dlpack.from_dlpack(tensor_copy)

        # Process the frame
        print(f"Received frame {self.frame_count}: shape={torch_tensor.shape}")

        self.frame_count += 1
        return 1  # Success
```

### Receiver Class

Wrapper for attaching a BufferRetriever to a pipeline element.

**Constructor**:
```python
from pyservicemaker import Receiver

receiver = Receiver("receiver-name", buffer_retriever_instance)
```

**Parameters**:
- `name` (str): Name of the receiver
- `retriever` (BufferRetriever): BufferRetriever instance

### Buffer Class Methods

**Methods**:

#### `extract(index)`
Extract tensor at specified index from the buffer.

**Parameters**:
- `index` (int): Batch index (usually 0 for single-stream)

**Returns**: Tensor object (DLPack format)

#### `clone()`
Create a copy of the tensor to prevent data corruption.

**Returns**: Cloned tensor

**Example**:
```python
def consume(self, buffer):
    # Extract and clone in one step
    tensor = buffer.extract(0).clone()

    # Now safe to use tensor asynchronously
    torch_tensor = torch.utils.dlpack.from_dlpack(tensor)
    return 1
```

## Implementation Patterns

### Pattern 1: Frame Extraction and Saving

Extract frames from pipeline and save to disk.

```python
from pyservicemaker import Pipeline, BufferRetriever, Receiver
import torch  # pip install torch torchvision (not in base DS container)
import cv2  # pip install opencv-python-headless (not in base DS container)
import numpy as np
import platform
from multiprocessing import Process

class FrameSaver(BufferRetriever):
    def __init__(self, output_dir="./frames", save_interval=30):
        super().__init__()
        self.output_dir = output_dir
        self.save_interval = save_interval
        self.frame_count = 0

        import os
        os.makedirs(output_dir, exist_ok=True)

    def consume(self, buffer):
        # Extract and clone buffer
        tensor = buffer.extract(0).clone()

        # Save every Nth frame
        if self.frame_count % self.save_interval == 0:
            # Convert to PyTorch tensor
            torch_tensor = torch.utils.dlpack.from_dlpack(tensor)

            # Move to CPU and convert to numpy
            frame_np = torch_tensor.cpu().numpy()

            # Convert RGB to BGR for OpenCV
            frame_bgr = cv2.cvtColor(frame_np, cv2.COLOR_RGB2BGR)

            # Save frame
            filename = f"{self.output_dir}/frame_{self.frame_count:06d}.jpg"
            cv2.imwrite(filename, frame_bgr)
            print(f"Saved: {filename}")

        self.frame_count += 1
        return 1

def extract_frames(video_uri, output_dir):
    pipeline = Pipeline("frame-extractor")

    # Source
    pipeline.add("nvurisrcbin", "src", {"uri": video_uri})

    # Muxer
    pipeline.add("nvstreammux", "mux", {
        "batch-size": 1,
        "width": 1920,
        "height": 1080
    })

    # Convert to RGB for extraction
    pipeline.add("nvvideoconvert", "converter")
    pipeline.add("capsfilter", "caps", {
        "caps": "video/x-raw(memory:NVMM), format=RGB"
    })

    # Sink for extraction
    pipeline.add("appsink", "sink", {
        "emit-signals": True,
        "sync": False
    })

    # Link elements
    pipeline.link(("src", "mux"), ("", "sink_%u"))
    pipeline.link("mux", "converter", "caps", "sink")

    # Attach retriever
    retriever = FrameSaver(output_dir, save_interval=30)
    pipeline.attach("sink", Receiver("receiver", retriever), tips="new-sample")

    # Run
    pipeline.start().wait()

if __name__ == "__main__":
    import sys
    process = Process(target=extract_frames, args=(sys.argv[1], "./output_frames"))
    try:
        process.start()
        process.join()
    except KeyboardInterrupt:
        process.terminate()
```

### Pattern 2: Frame Queue Transfer

Transfer frames from one pipeline to another using a queue.

> **CRITICAL WARNING: Queue Type Selection**
>
> When transferring data between **threads**, use `queue.Queue` (from `queue` module).
> When transferring data between **processes**, use `multiprocessing.Queue`.
>
> Using `queue.Queue` with `multiprocessing.Process` will silently fail - data put into the queue in a child process will NEVER reach the parent process! This is a common bug that causes pipelines to appear running but produce no output.
>
> See the Best Practices reference for Anti-Pattern 4 with detailed examples.

```python
from pyservicemaker import Pipeline, BufferRetriever, Receiver, BufferProvider, Feeder
import torch  # pip install torch torchvision (not in base DS container)
from queue import Queue, Empty  # Use for THREADING only!
# from multiprocessing import Queue  # Use this for MULTIPROCESSING!
import threading

class QueuedRetriever(BufferRetriever):
    def __init__(self, frame_queue):
        super().__init__()
        self.queue = frame_queue
        self.count = 0

    def consume(self, buffer):
        # Extract and clone
        tensor = buffer.extract(0).clone()

        # Put in queue for other pipeline
        self.queue.put(tensor)

        self.count += 1
        print(f"Queued frame {self.count}")
        return 1

class QueuedProvider(BufferProvider):
    def __init__(self, frame_queue, width=1280, height=720):
        super().__init__()
        self.queue = frame_queue
        self.format = "RGB"
        self.width = width
        self.height = height
        self.framerate = 30
        self.device = 'gpu'

    def generate(self, size):
        try:
            tensor = self.queue.get(timeout=2)
            torch_tensor = torch.utils.dlpack.from_dlpack(tensor)

            from pyservicemaker import as_tensor, ColorFormat
            ds_tensor = as_tensor(torch_tensor, "HWC")
            return ds_tensor.wrap(ColorFormat.RGB)
        except Empty:
            from pyservicemaker import Buffer
            return Buffer()

def source_pipeline(uri, queue):
    """Extract frames from source and queue them"""
    pipeline = Pipeline("source-pipeline")

    pipeline.add("nvurisrcbin", "src", {"uri": uri})
    pipeline.add("nvstreammux", "mux", {"batch-size": 1, "width": 1280, "height": 720})
    pipeline.add("nvvideoconvert", "converter")
    pipeline.add("capsfilter", "caps", {"caps": "video/x-raw(memory:NVMM), format=RGB"})
    pipeline.add("appsink", "sink", {"emit-signals": True, "sync": False})

    pipeline.link(("src", "mux"), ("", "sink_%u"))
    pipeline.link("mux", "converter", "caps", "sink")

    retriever = QueuedRetriever(queue)
    pipeline.attach("sink", Receiver("receiver", retriever), tips="new-sample")

    pipeline.start().wait()

def destination_pipeline(queue):
    """Consume frames from queue and process"""
    pipeline = Pipeline("dest-pipeline")

    provider = QueuedProvider(queue, width=1280, height=720)

    caps = "video/x-raw(memory:NVMM), format=RGB, width=1280, height=720, framerate=30/1"
    pipeline.add("appsrc", "src", {"caps": caps, "do-timestamp": True})
    pipeline.add("nvvideoconvert", "convert", {"nvbuf-memory-type": 2})
    pipeline.add("capsfilter", "caps2", {"caps": "video/x-raw(memory:NVMM), format=NV12"})
    pipeline.add("nvstreammux", "mux", {"batch-size": 1, "width": 1280, "height": 720})
    pipeline.add("nvinfer", "infer", {"config-file-path": "/path/to/config.yml"})
    pipeline.add("nvosdbin", "osd")
    pipeline.add("nveglglessink", "sink")

    pipeline.link("src", "convert", "caps2")
    pipeline.link(("convert", "mux"), ("", "sink_%u"))
    pipeline.link("mux", "infer", "osd", "sink")

    pipeline.attach("src", Feeder("feeder", provider), tips="need-data/enough-data")

    pipeline.start().wait()

def multi_pipeline_transfer(video_uri, use_multiprocessing=False):
    """
    Transfer frames between pipelines.

    IMPORTANT: Queue type must match execution model:
    - Threading: use queue.Queue
    - Multiprocessing: use multiprocessing.Queue

    Args:
        video_uri: Video source URI
        use_multiprocessing: If True, use processes (requires multiprocessing.Queue)
    """
    if use_multiprocessing:
        from multiprocessing import Queue as MPQueue, Process
        queue = MPQueue(maxsize=10)  # MUST use multiprocessing.Queue!

        # Run pipelines in separate processes
        proc1 = Process(target=source_pipeline, args=(video_uri, queue))
        proc2 = Process(target=destination_pipeline, args=(queue,))

        proc1.start()
        proc2.start()

        proc2.join()
        proc1.join()
    else:
        # Threading approach - queue.Queue works fine here
        queue = Queue(maxsize=10)

        # Run both pipelines in threads (same process, shared memory)
        thread1 = threading.Thread(target=source_pipeline, args=(video_uri, queue))
        thread2 = threading.Thread(target=destination_pipeline, args=(queue,))

        thread1.start()
        thread2.start()

        thread2.join()
        thread1.join()
```

### Pattern 3: Selective Frame Capture

Capture frames based on inference results (e.g., when objects are detected).

```python
from pyservicemaker import Pipeline, BufferRetriever, Receiver, BatchMetadataOperator, Probe
import torch  # pip install torch torchvision (not in base DS container)
import cv2  # pip install opencv-python-headless (not in base DS container)
import numpy as np

class SelectiveFrameCapture(BufferRetriever):
    def __init__(self, output_dir="./captured", min_objects=1):
        super().__init__()
        self.output_dir = output_dir
        self.min_objects = min_objects
        self.frame_count = 0
        self.saved_count = 0
        self.capture_next = False

        import os
        os.makedirs(output_dir, exist_ok=True)

    def set_capture_flag(self, should_capture):
        """Called by metadata probe to signal capture"""
        self.capture_next = should_capture

    def consume(self, buffer):
        tensor = buffer.extract(0).clone()

        if self.capture_next:
            # Save this frame
            torch_tensor = torch.utils.dlpack.from_dlpack(tensor)
            frame_np = torch_tensor.cpu().numpy()
            frame_bgr = cv2.cvtColor(frame_np, cv2.COLOR_RGB2BGR)

            filename = f"{self.output_dir}/capture_{self.saved_count:06d}.jpg"
            cv2.imwrite(filename, frame_bgr)
            print(f"Captured frame {self.frame_count} with objects -> {filename}")

            self.saved_count += 1
            self.capture_next = False

        self.frame_count += 1
        return 1

class ObjectDetectionTrigger(BatchMetadataOperator):
    def __init__(self, frame_capture, min_objects=1):
        super().__init__()
        self.frame_capture = frame_capture
        self.min_objects = min_objects

    def handle_metadata(self, batch_meta):
        for frame_meta in batch_meta.frame_items:
            # Note: object_items is an ITERATOR - cannot use len() directly
            # Count by iterating
            obj_count = sum(1 for _ in frame_meta.object_items)

            if obj_count >= self.min_objects:
                # Signal frame capture to save this frame
                self.frame_capture.set_capture_flag(True)
                print(f"Detected {obj_count} objects, triggering capture")

def selective_capture(video_uri, config_path, output_dir):
    pipeline = Pipeline("selective-capture")

    # Source and muxer
    pipeline.add("nvurisrcbin", "src", {"uri": video_uri})
    pipeline.add("nvstreammux", "mux", {"batch-size": 1, "width": 1920, "height": 1080})

    # Inference
    pipeline.add("nvinfer", "infer", {"config-file-path": config_path})

    # Convert for extraction
    pipeline.add("nvvideoconvert", "converter")
    pipeline.add("capsfilter", "caps", {"caps": "video/x-raw(memory:NVMM), format=RGB"})

    # Sink
    pipeline.add("appsink", "sink", {"emit-signals": True, "sync": False})

    # Link
    pipeline.link(("src", "mux"), ("", "sink_%u"))
    pipeline.link("mux", "infer", "converter", "caps", "sink")

    # Attach frame capture
    frame_capture = SelectiveFrameCapture(output_dir, min_objects=2)
    pipeline.attach("sink", Receiver("receiver", frame_capture), tips="new-sample")

    # Attach metadata processor to trigger capture
    trigger = ObjectDetectionTrigger(frame_capture, min_objects=2)
    pipeline.attach("infer", Probe("trigger", trigger))

    pipeline.start().wait()
```

### Pattern 4: Flow API with Frame Retrieval

High-level Flow API for frame extraction.

```python
from pyservicemaker import Pipeline, Flow, BufferRetriever
import torch  # pip install torch torchvision (not in base DS container)
import cv2  # pip install opencv-python-headless (not in base DS container)
import numpy as np

class SimpleFrameRetriever(BufferRetriever):
    def __init__(self, save_path="output.jpg"):
        super().__init__()
        self.save_path = save_path
        self.count = 0

    def consume(self, buffer):
        if self.count == 0:  # Save first frame only
            tensor = buffer.extract(0).clone()
            torch_tensor = torch.utils.dlpack.from_dlpack(tensor)
            frame_np = torch_tensor.cpu().numpy()
            frame_bgr = cv2.cvtColor(frame_np, cv2.COLOR_RGB2BGR)
            cv2.imwrite(self.save_path, frame_bgr)
            print(f"Saved frame to {self.save_path}")

        self.count += 1
        return 1

def flow_api_retrieval(video_uri):
    pipeline = Pipeline("flow-retrieval")
    retriever = SimpleFrameRetriever("output_frame.jpg")

    # Flow API: batch_capture() -> retrieve()
    flow = Flow(pipeline)
    flow.batch_capture([video_uri])
    flow.retrieve(retriever)
    flow()
```

### Pattern 5: Frame Analysis and Logging

Extract frames with metadata for analysis.

```python
from pyservicemaker import Pipeline, BufferRetriever, Receiver, BatchMetadataOperator, Probe
import torch  # pip install torch torchvision (not in base DS container)
import json
from datetime import datetime

class FrameAnalyzer(BufferRetriever):
    def __init__(self, log_file="frame_analysis.json"):
        super().__init__()
        self.log_file = log_file
        self.frame_count = 0
        self.metadata_cache = {}

    def set_metadata(self, frame_num, metadata):
        """Called by metadata probe"""
        self.metadata_cache[frame_num] = metadata

    def consume(self, buffer):
        tensor = buffer.extract(0).clone()
        torch_tensor = torch.utils.dlpack.from_dlpack(tensor)

        # Calculate frame statistics
        mean_intensity = torch_tensor.float().mean().item()
        std_intensity = torch_tensor.float().std().item()

        # Get metadata if available
        metadata = self.metadata_cache.get(self.frame_count, {})

        # Log analysis
        analysis = {
            "frame_number": self.frame_count,
            "timestamp": datetime.now().isoformat(),
            "mean_intensity": mean_intensity,
            "std_intensity": std_intensity,
            "shape": list(torch_tensor.shape),
            "objects_detected": metadata.get("object_count", 0),
            "object_classes": metadata.get("classes", [])
        }

        with open(self.log_file, "a") as f:
            f.write(json.dumps(analysis) + "\n")

        # Clear cached metadata
        if self.frame_count in self.metadata_cache:
            del self.metadata_cache[self.frame_count]

        self.frame_count += 1
        return 1

class MetadataExtractor(BatchMetadataOperator):
    def __init__(self, frame_analyzer):
        super().__init__()
        self.frame_analyzer = frame_analyzer

    def handle_metadata(self, batch_meta):
        for frame_meta in batch_meta.frame_items:
            # Note: object_items is an ITERATOR - convert to list if you need
            # to access it multiple times or use len()
            objects = list(frame_meta.object_items)
            metadata = {
                "object_count": len(objects),
                "classes": [obj.class_id for obj in objects],
                "confidences": [obj.confidence for obj in objects]
            }
            self.frame_analyzer.set_metadata(frame_meta.frame_number, metadata)

def analyze_frames(video_uri, config_path):
    pipeline = Pipeline("frame-analyzer")

    # Source
    pipeline.add("nvurisrcbin", "src", {"uri": video_uri})
    pipeline.add("nvstreammux", "mux", {"batch-size": 1, "width": 1920, "height": 1080})

    # Inference
    pipeline.add("nvinfer", "infer", {"config-file-path": config_path})

    # Convert and extract
    pipeline.add("nvvideoconvert", "converter")
    pipeline.add("capsfilter", "caps", {"caps": "video/x-raw(memory:NVMM), format=RGB"})
    pipeline.add("appsink", "sink", {"emit-signals": True, "sync": False})

    # Link
    pipeline.link(("src", "mux"), ("", "sink_%u"))
    pipeline.link("mux", "infer", "converter", "caps", "sink")

    # Attach analyzer
    analyzer = FrameAnalyzer("analysis_log.json")
    pipeline.attach("sink", Receiver("receiver", analyzer), tips="new-sample")

    # Attach metadata extractor
    extractor = MetadataExtractor(analyzer)
    pipeline.attach("infer", Probe("extractor", extractor))

    pipeline.start().wait()
```

### Pattern 6: Real-time Frame Streaming

Stream frames to external system (e.g., web server, cloud service).

```python
from pyservicemaker import Pipeline, BufferRetriever, Receiver
import torch  # pip install torch torchvision (not in base DS container)
import cv2  # pip install opencv-python-headless (not in base DS container)
import numpy as np
import base64
import requests

class FrameStreamer(BufferRetriever):
    def __init__(self, endpoint_url, stream_interval=1):
        super().__init__()
        self.endpoint_url = endpoint_url
        self.stream_interval = stream_interval
        self.frame_count = 0

    def consume(self, buffer):
        # Stream every Nth frame
        if self.frame_count % self.stream_interval == 0:
            tensor = buffer.extract(0).clone()
            torch_tensor = torch.utils.dlpack.from_dlpack(tensor)
            frame_np = torch_tensor.cpu().numpy()

            # Encode as JPEG
            frame_bgr = cv2.cvtColor(frame_np, cv2.COLOR_RGB2BGR)
            _, jpeg_buffer = cv2.imencode('.jpg', frame_bgr, [cv2.IMWRITE_JPEG_QUALITY, 85])

            # Encode as base64
            jpeg_base64 = base64.b64encode(jpeg_buffer).decode('utf-8')

            # Send to endpoint
            try:
                response = requests.post(
                    self.endpoint_url,
                    json={
                        "frame_number": self.frame_count,
                        "image": jpeg_base64
                    },
                    timeout=1
                )
                if response.status_code == 200:
                    print(f"Streamed frame {self.frame_count}")
            except Exception as e:
                print(f"Failed to stream frame {self.frame_count}: {e}")

        self.frame_count += 1
        return 1

def stream_frames(video_uri, endpoint_url):
    pipeline = Pipeline("frame-streamer")

    pipeline.add("nvurisrcbin", "src", {"uri": video_uri})
    pipeline.add("nvstreammux", "mux", {"batch-size": 1, "width": 1280, "height": 720})
    pipeline.add("nvvideoconvert", "converter")
    pipeline.add("capsfilter", "caps", {"caps": "video/x-raw(memory:NVMM), format=RGB"})
    pipeline.add("appsink", "sink", {"emit-signals": True, "sync": False})

    pipeline.link(("src", "mux"), ("", "sink_%u"))
    pipeline.link("mux", "converter", "caps", "sink")

    streamer = FrameStreamer(endpoint_url, stream_interval=10)
    pipeline.attach("sink", Receiver("receiver", streamer), tips="new-sample")

    pipeline.start().wait()
```

## Part 2 Best Practices

### 1. Always Clone Buffers
```python
def consume(self, buffer):
    # ALWAYS clone to prevent data corruption
    tensor = buffer.extract(0).clone()
    # Now safe to use asynchronously
```

### 2. Signal Configuration
```python
# Always use "new-sample" signal for appsink
pipeline.attach("sink", Receiver("receiver", retriever), tips="new-sample")

# Enable signal emission on appsink
pipeline.add("appsink", "sink", {"emit-signals": True})
```

### 3. Synchronization Control
```python
# For frame extraction, usually disable sync
pipeline.add("appsink", "sink", {
    "emit-signals": True,
    "sync": False  # Don't block on frame rate
})

# For real-time processing, enable sync
pipeline.add("appsink", "sink", {
    "emit-signals": True,
    "sync": True  # Maintain real-time pacing
})
```

### 4. Return Value Handling
```python
def consume(self, buffer):
    try:
        # Process buffer
        tensor = buffer.extract(0).clone()
        # ... processing ...
        return 1  # Success, continue processing
    except Exception as e:
        print(f"Error: {e}")
        return 0  # Error, but continue
        # return -1  # Fatal error, stop pipeline
```

### 5. Memory Management
```python
class EfficientRetriever(BufferRetriever):
    def __init__(self):
        super().__init__()
        self.frame_buffer = []
        self.max_buffer_size = 100

    def consume(self, buffer):
        tensor = buffer.extract(0).clone()

        # Limit buffer size to prevent memory issues
        if len(self.frame_buffer) >= self.max_buffer_size:
            self.frame_buffer.pop(0)  # Remove oldest

        self.frame_buffer.append(tensor)
        return 1
```

### 6. Thread Safety
```python
import threading

class ThreadSafeRetriever(BufferRetriever):
    def __init__(self):
        super().__init__()
        self.lock = threading.Lock()
        self.frame_count = 0

    def consume(self, buffer):
        with self.lock:
            tensor = buffer.extract(0).clone()
            # Safe concurrent access
            self.frame_count += 1
        return 1
```

## Advanced Usage

### Multi-Batch Frame Extraction

Extract frames from multi-stream batches.

```python
class MultiBatchRetriever(BufferRetriever):
    def __init__(self, num_streams):
        super().__init__()
        self.num_streams = num_streams
        self.frame_counts = [0] * num_streams

    def consume(self, buffer):
        # Extract all streams in batch
        for stream_idx in range(self.num_streams):
            try:
                tensor = buffer.extract(stream_idx).clone()
                torch_tensor = torch.utils.dlpack.from_dlpack(tensor)

                # Process each stream
                print(f"Stream {stream_idx}, Frame {self.frame_counts[stream_idx]}")

                self.frame_counts[stream_idx] += 1
            except Exception as e:
                print(f"Error extracting stream {stream_idx}: {e}")

        return 1

def multi_stream_extraction(video_uris):
    pipeline = Pipeline("multi-stream-extract")

    # Add sources
    for i, uri in enumerate(video_uris):
        pipeline.add("nvurisrcbin", f"src{i}", {"uri": uri})

    # Muxer for batching
    pipeline.add("nvstreammux", "mux", {
        "batch-size": len(video_uris),
        "width": 1280,
        "height": 720
    })

    # Convert and extract
    pipeline.add("nvvideoconvert", "converter")
    pipeline.add("capsfilter", "caps", {"caps": "video/x-raw(memory:NVMM), format=RGB"})
    pipeline.add("appsink", "sink", {"emit-signals": True, "sync": False})

    # Link sources to muxer
    for i in range(len(video_uris)):
        pipeline.link((f"src{i}", "mux"), ("", "sink_%u"))

    pipeline.link("mux", "converter", "caps", "sink")

    # Attach multi-batch retriever
    retriever = MultiBatchRetriever(len(video_uris))
    pipeline.attach("sink", Receiver("receiver", retriever), tips="new-sample")

    pipeline.start().wait()
```

## Part 2 Common Use Cases

### 1. Frame Archival
Extract and save frames at regular intervals for archival purposes.

### 2. Thumbnail Generation
Extract keyframes to generate video thumbnails.

### 3. Object Detection Screenshots
Capture frames when specific objects are detected.

### 4. Video Quality Analysis
Extract frames for quality metrics computation.

### 5. Pipeline Debugging
Extract frames at various pipeline stages for debugging.

### 6. Data Collection
Collect frames and metadata for training dataset creation.

## Part 2 Troubleshooting

### Issue 1: No Frames Received
**Solution**: Ensure `emit-signals=True` is set on appsink, verify `tips="new-sample"` is set

### Issue 2: Data Corruption
**Solution**: Always call `.clone()` on extracted tensors before async processing

### Issue 3: Memory Leaks
**Solution**: Limit buffer accumulation, properly release tensors

### Issue 4: Performance Issues
**Solution**: Set `sync=False` on appsink, process frames asynchronously

### Issue 5: Missing Frames
**Solution**: Check return value (return 1 for success), ensure processing is fast enough

### Issue 6: Frames/Batches Not Reaching Downstream Processing (Queue Empty)
**Symptoms**:
- Pipeline runs without errors
- BufferRetriever.consume() is being called
- But downstream processing (VLM, Kafka, etc.) never receives data
- Queue appears to be empty in consumer thread/process

**Root Cause**: Using `queue.Queue` with `multiprocessing.Process`

**Solution**:
1. If using multiprocessing: Switch to `multiprocessing.Queue`
2. If process isolation not required: Use `threading.Thread` with `queue.Queue`
3. Set `use_multiprocessing=False` in your configuration

```python
# WRONG: queue.Queue with multiprocessing
from multiprocessing import Process
from queue import Queue  # Won't work across processes!

# CORRECT Option 1: Use multiprocessing.Queue
from multiprocessing import Process, Queue

# CORRECT Option 2: Use threading instead
import threading
from queue import Queue

# See the Best Practices reference for Anti-Pattern 4 details
```

## Part 2 Summary

The Frame Selector API (BufferRetriever/Receiver) provides powerful capabilities for extracting frames and data from DeepStream pipelines. Key points:

1. Implement `BufferRetriever.consume()` to process extracted buffers
2. Use `Receiver` to attach retriever to `appsink` elements
3. Always call `buffer.extract(0).clone()` to safely extract tensors
4. Return `1` for success, `0` for error (continue), `-1` for fatal error
5. Set `emit-signals=True` on appsink and use `tips="new-sample"`
6. Consider `sync=False` for non-real-time extraction

This API enables seamless extraction of frames, inference results, and metadata from DeepStream pipelines for custom processing, archival, or transfer to other systems.
