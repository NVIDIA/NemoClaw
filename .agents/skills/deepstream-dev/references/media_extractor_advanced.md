# Advanced Media Extraction with MediaExtractor, MediaChunk, and FrameSampler

## Overview

The `pyservicemaker.utils` module provides advanced utilities for extracting frames from media sources with precise control over timing, sampling, and batch processing. These utilities are particularly useful for:
- Processing specific time segments (chunks) of video files
- Frame sampling at precise intervals
- Batch processing multiple video sources
- Dynamic source addition during runtime
- Seeking and timestamp-based frame extraction

## Core Classes

### MediaChunk

A `MediaChunk` represents a specific time segment of a media source with sampling parameters.

**Constructor**:
```python
from pyservicemaker.utils import MediaChunk

chunk = MediaChunk(
    source="path/to/video.mp4",
    start_pts=0,           # Start timestamp in nanoseconds
    duration=-1,           # Duration in nanoseconds (-1 = entire file)
    interval=0             # Frame sampling interval in nanoseconds (0 = no skipping)
)
```

**Parameters**:
- `source` (str): File path or URL of media source
- `start_pts` (int): Start timestamp in nanoseconds (default: 0)
- `duration` (int): Duration in nanoseconds (default: -1 for entire file)
- `interval` (int): Frame sampling interval in nanoseconds (default: 0 for no frame skipping)

**Properties**:
- `source`: Returns the media source path/URL
- `start_pts`: Returns the start timestamp
- `duration`: Returns the duration
- `interval`: Returns the sampling interval

**Example**:
```python
from pyservicemaker.utils import MediaChunk

# Extract entire video
chunk1 = MediaChunk(source="video1.mp4")

# Extract 10 seconds starting from 5 seconds
chunk2 = MediaChunk(
    source="video2.mp4",
    start_pts=5_000_000_000,   # 5 seconds in nanoseconds
    duration=10_000_000_000     # 10 seconds in nanoseconds
)

# Extract with frame sampling every 0.5 seconds
chunk3 = MediaChunk(
    source="video3.mp4",
    interval=500_000_000        # 0.5 seconds in nanoseconds
)

# Extract 30 seconds starting at 1 minute, sample every 2 seconds
chunk4 = MediaChunk(
    source="video4.mp4",
    start_pts=60_000_000_000,   # 1 minute
    duration=30_000_000_000,    # 30 seconds
    interval=2_000_000_000      # 2 seconds
)
```

### VideoFrame

Represents a decoded video frame with timestamp information.

**Constructor**:
```python
from pyservicemaker.utils import VideoFrame

frame = VideoFrame(data=tensor, timestamp=pts)
```

**Parameters**:
- `data` (Tensor): Frame data as DeepStream tensor
- `timestamp` (int): Frame timestamp in nanoseconds (default: -1)

**Properties**:
- `timestamp`: Returns the frame timestamp
- `tensor`: Returns the frame data tensor

**Example**:
```python
# Typically created internally by FrameSampler
# Access in your processing code:
for frame in output_queue:
    if frame is None:
        break  # End of stream
    
    print(f"Frame timestamp: {frame.timestamp} ns")
    tensor_data = frame.tensor
    # Process tensor_data...
```

### FrameSampler

Manages frame sampling logic based on MediaChunk specifications.

**Constructor**:
```python
from pyservicemaker.utils import FrameSampler

sampler = FrameSampler(chunk=media_chunk, seek_fn=None)
```

**Parameters**:
- `chunk` (MediaChunk): Media chunk specification
- `seek_fn` (Callable, optional): Function to call for seeking (default: None)

**Properties**:
- `done`: Returns True when chunk processing is complete

**Methods**:

#### `sample(buffer, pts)`
Sample a frame based on chunk specifications.

**Parameters**:
- `buffer`: Buffer containing frame data
- `pts` (int): Presentation timestamp in nanoseconds

**Returns**: `VideoFrame` object if frame should be sampled, `None` otherwise

**Example** (typically used internally):
```python
# Internal usage by MediaExtractor
sampler = FrameSampler(chunk)
frame = sampler.sample(buffer, pts)
if frame:
    queue.put(frame)
elif sampler.done:
    print("Chunk processing complete")
```

### MediaExtractor

High-level utility for extracting frames from media sources with advanced features.

**Constructor**:
```python
from pyservicemaker.utils import MediaExtractor, MediaChunk

extractor = MediaExtractor(
    chunks=[chunk1, chunk2, ...],  # List of MediaChunk objects
    batch_size=0,                   # 0 = no batching, N = batch N sources
    scaling=(1920, 1080),           # Target resolution (width, height)
    n_thread=1,                     # Number of worker threads
    q_size=1,                       # Output queue capacity
    enable_seek=False,              # Enable seeking for frame retrieval
    blocking=False                  # Block when queue is full
)
```

**Parameters**:
- `chunks` (List[MediaChunk], optional): List of media chunks to process
- `batch_size` (int): Batch size for processing (0 = no batching, default: 0)
- `scaling` (Tuple[int, int]): Target resolution (width, height), default: (1920, 1080)
- `n_thread` (int): Number of worker threads (default: 1)
- `q_size` (int): Output queue capacity (default: 1)
- `enable_seek` (bool): Enable seeking for efficient frame retrieval (default: False)
- `blocking` (bool): Block when output queue is full (default: False)

**Methods**:

#### `__call__()`
Start extraction and return output queues.

**Returns**: List of `queue.Queue` objects containing `VideoFrame` objects

#### `append(chunk)`
Dynamically add a new chunk during runtime (only if initialized without chunks).

**Parameters**:
- `chunk` (MediaChunk): Media chunk to add

**Returns**: `queue.Queue` for the added chunk

**Context Manager Support**:
MediaExtractor supports context manager protocol for automatic cleanup.

```python
with MediaExtractor(chunks=[...]) as extractor:
    queues = extractor()
    # Process frames...
# Automatic cleanup on exit
```

## Usage Patterns

### Pattern 1: Extract Entire Video Files

Extract all frames from multiple video files.

```python
from pyservicemaker.utils import MediaExtractor, MediaChunk
import torch  # pip install torch torchvision (not in base DS container)

def extract_all_frames(video_paths):
    """Extract all frames from multiple videos"""
    # Create chunks for each video
    chunks = [MediaChunk(source=path) for path in video_paths]
    
    # Create extractor
    with MediaExtractor(chunks=chunks, n_thread=len(video_paths), q_size=10) as extractor:
        # Start extraction
        queues = extractor()
        
        # Process frames from each video
        for i, q in enumerate(queues):
            print(f"Processing video {i}: {video_paths[i]}")
            frame_count = 0
            
            while True:
                frame = q.get()
                if frame is None:
                    break  # End of stream
                
                # Convert to PyTorch tensor
                torch_tensor = torch.utils.dlpack.from_dlpack(frame.tensor)
                
                # Process frame
                print(f"  Frame {frame_count}: timestamp={frame.timestamp} ns, shape={torch_tensor.shape}")
                
                frame_count += 1
            
            print(f"  Total frames: {frame_count}")

# Example usage
video_files = ["video1.mp4", "video2.mp4", "video3.mp4"]
extract_all_frames(video_files)
```

### Pattern 2: Extract Time Segments

Extract specific time segments from videos.

```python
from pyservicemaker.utils import MediaExtractor, MediaChunk

def extract_time_segments(video_path, segments):
    """
    Extract specific time segments from a video
    
    Args:
        video_path: Path to video file
        segments: List of (start_time, duration) tuples in seconds
    """
    # Create chunks for each segment
    chunks = [
        MediaChunk(
            source=video_path,
            start_pts=int(start * 1e9),      # Convert to nanoseconds
            duration=int(duration * 1e9)      # Convert to nanoseconds
        )
        for start, duration in segments
    ]
    
    with MediaExtractor(chunks=chunks, n_thread=1, q_size=5) as extractor:
        queues = extractor()
        
        for i, (q, (start, duration)) in enumerate(zip(queues, segments)):
            print(f"Segment {i}: {start}s - {start+duration}s")
            frames = []
            
            while True:
                frame = q.get()
                if frame is None:
                    break
                frames.append(frame)
            
            print(f"  Extracted {len(frames)} frames")
            
            # Process frames for this segment
            for frame in frames:
                # Your processing logic here
                pass

# Example: Extract three 10-second segments
segments = [
    (0, 10),      # First 10 seconds
    (30, 10),     # 10 seconds starting at 30s
    (60, 10)      # 10 seconds starting at 1 minute
]
extract_time_segments("long_video.mp4", segments)
```

### Pattern 3: Frame Sampling at Intervals

Extract frames at specific intervals (e.g., every N seconds).

```python
from pyservicemaker.utils import MediaExtractor, MediaChunk
import cv2  # pip install opencv-python-headless (not in base DS container)
import numpy as np
import torch  # pip install torch torchvision (not in base DS container)

def sample_frames_at_interval(video_path, interval_sec=1.0, output_dir="./sampled"):
    """
    Sample frames at regular intervals
    
    Args:
        video_path: Path to video file
        interval_sec: Sampling interval in seconds
        output_dir: Directory to save sampled frames
    """
    import os
    os.makedirs(output_dir, exist_ok=True)
    
    # Create chunk with sampling interval
    chunk = MediaChunk(
        source=video_path,
        interval=int(interval_sec * 1e9)  # Convert to nanoseconds
    )
    
    with MediaExtractor(chunks=[chunk], q_size=10) as extractor:
        queues = extractor()
        q = queues[0]
        
        frame_idx = 0
        while True:
            frame = q.get()
            if frame is None:
                break
            
            # Convert to numpy for saving
            torch_tensor = torch.utils.dlpack.from_dlpack(frame.tensor)
            frame_np = torch_tensor.cpu().numpy()
            
            # Convert RGB to BGR for OpenCV
            frame_bgr = cv2.cvtColor(frame_np, cv2.COLOR_RGB2BGR)
            
            # Save frame
            timestamp_sec = frame.timestamp / 1e9
            filename = f"{output_dir}/frame_{frame_idx:06d}_t{timestamp_sec:.3f}s.jpg"
            cv2.imwrite(filename, frame_bgr)
            
            print(f"Saved: {filename}")
            frame_idx += 1
        
        print(f"Total sampled frames: {frame_idx}")

# Sample frames every 2 seconds
sample_frames_at_interval("video.mp4", interval_sec=2.0)
```

### Pattern 4: Batch Processing Multiple Sources

Process multiple video sources in batches with scaling.

```python
from pyservicemaker.utils import MediaExtractor, MediaChunk
import torch  # pip install torch torchvision (not in base DS container)

def batch_process_videos(video_paths, batch_size=4, target_resolution=(1280, 720)):
    """
    Process multiple videos in batches with scaling
    
    Args:
        video_paths: List of video file paths
        batch_size: Number of videos to process in parallel
        target_resolution: Target (width, height) for scaling
    """
    # Create chunks
    chunks = [MediaChunk(source=path) for path in video_paths]
    
    # Create extractor with batching
    with MediaExtractor(
        chunks=chunks,
        batch_size=batch_size,
        scaling=target_resolution,
        n_thread=1,
        q_size=10
    ) as extractor:
        queues = extractor()
        
        # Process each batch queue
        for batch_idx, q in enumerate(queues):
            print(f"Processing batch {batch_idx}")
            frame_count = 0
            
            while True:
                frame = q.get()
                if frame is None:
                    break
                
                # Frame is already scaled to target resolution
                torch_tensor = torch.utils.dlpack.from_dlpack(frame.tensor)
                print(f"  Batch {batch_idx}, Frame {frame_count}: shape={torch_tensor.shape}")
                
                # Process batched frame
                # ... your processing logic ...
                
                frame_count += 1
            
            print(f"  Batch {batch_idx} complete: {frame_count} frames")

# Process 12 videos in batches of 4
videos = [f"video_{i}.mp4" for i in range(12)]
batch_process_videos(videos, batch_size=4, target_resolution=(1280, 720))
```

### Pattern 5: Dynamic Source Addition

Add video sources dynamically during runtime.

```python
from pyservicemaker.utils import MediaExtractor, MediaChunk
import threading
import time

def dynamic_extraction_system(n_threads=2):
    """
    System that accepts video processing requests dynamically
    """
    # Create extractor without initial chunks (for dynamic addition)
    with MediaExtractor(chunks=None, n_thread=n_threads, q_size=5) as extractor:
        # Start extractor threads
        extractor()
        
        def process_chunk(chunk, queue):
            """Process frames from a chunk"""
            print(f"Processing: {chunk.source}")
            frame_count = 0
            
            while True:
                frame = queue.get()
                if frame is None:
                    break
                
                # Process frame
                frame_count += 1
            
            print(f"Completed: {chunk.source} ({frame_count} frames)")
        
        # Simulate dynamic requests
        video_requests = [
            ("video1.mp4", 0, 10),    # (path, start_sec, duration_sec)
            ("video2.mp4", 5, 15),
            ("video3.mp4", 0, 20),
            ("video4.mp4", 10, 10),
        ]
        
        threads = []
        for path, start_sec, duration_sec in video_requests:
            # Create chunk
            chunk = MediaChunk(
                source=path,
                start_pts=int(start_sec * 1e9),
                duration=int(duration_sec * 1e9)
            )
            
            # Add to extractor (returns queue for this chunk)
            q = extractor.append(chunk)
            
            # Process in separate thread
            t = threading.Thread(target=process_chunk, args=(chunk, q))
            t.start()
            threads.append(t)
            
            # Simulate delay between requests
            time.sleep(0.5)
        
        # Wait for all processing to complete
        for t in threads:
            t.join()
        
        print("All requests processed")

# Run dynamic extraction system
dynamic_extraction_system(n_threads=2)
```

### Pattern 6: Frame Extraction with Seeking

Enable seeking for efficient frame retrieval with large intervals.

```python
from pyservicemaker.utils import MediaExtractor, MediaChunk

def extract_keyframes_with_seeking(video_path, keyframe_interval_sec=10.0):
    """
    Extract keyframes efficiently using seeking
    
    Args:
        video_path: Path to video file
        keyframe_interval_sec: Interval between keyframes in seconds
    """
    # Create chunk with large interval
    chunk = MediaChunk(
        source=video_path,
        interval=int(keyframe_interval_sec * 1e9)
    )
    
    # Enable seeking for efficient frame retrieval
    with MediaExtractor(
        chunks=[chunk],
        enable_seek=True,  # Enable seeking
        q_size=5
    ) as extractor:
        queues = extractor()
        q = queues[0]
        
        keyframes = []
        while True:
            frame = q.get()
            if frame is None:
                break
            
            keyframes.append(frame)
            print(f"Keyframe {len(keyframes)}: timestamp={frame.timestamp/1e9:.2f}s")
        
        print(f"Extracted {len(keyframes)} keyframes")
        return keyframes

# Extract keyframes every 10 seconds
keyframes = extract_keyframes_with_seeking("long_video.mp4", keyframe_interval_sec=10.0)
```

### Pattern 7: Blocking Mode for Controlled Processing

Use blocking mode to control frame processing rate.

```python
from pyservicemaker.utils import MediaExtractor, MediaChunk
import time

def controlled_frame_processing(video_path, processing_delay=0.1):
    """
    Process frames with controlled rate using blocking mode
    
    Args:
        video_path: Path to video file
        processing_delay: Simulated processing delay per frame
    """
    chunk = MediaChunk(source=video_path)
    
    # Use blocking mode with small queue
    with MediaExtractor(
        chunks=[chunk],
        q_size=2,          # Small queue
        blocking=True      # Block when queue is full
    ) as extractor:
        queues = extractor()
        q = queues[0]
        
        frame_count = 0
        while True:
            frame = q.get()
            if frame is None:
                break
            
            # Simulate slow processing
            print(f"Processing frame {frame_count}...")
            time.sleep(processing_delay)
            
            frame_count += 1
        
        print(f"Processed {frame_count} frames")

# Process with controlled rate
controlled_frame_processing("video.mp4", processing_delay=0.1)
```

## Advanced Usage

### Multi-Threaded Parallel Extraction

Process multiple videos in parallel using multiple threads.

```python
from pyservicemaker.utils import MediaExtractor, MediaChunk
from concurrent.futures import ThreadPoolExecutor
import torch  # pip install torch torchvision (not in base DS container)

def parallel_video_analysis(video_paths, n_workers=4):
    """
    Analyze multiple videos in parallel
    
    Args:
        video_paths: List of video file paths
        n_workers: Number of parallel workers
    """
    # Create chunks
    chunks = [MediaChunk(source=path) for path in video_paths]
    
    # Create extractor with multiple threads
    with MediaExtractor(
        chunks=chunks,
        n_thread=n_workers,
        q_size=10
    ) as extractor:
        queues = extractor()
        
        def analyze_video(video_idx, queue, video_path):
            """Analyze a single video"""
            print(f"Analyzing: {video_path}")
            
            frame_stats = {
                'count': 0,
                'total_intensity': 0.0,
                'timestamps': []
            }
            
            while True:
                frame = queue.get()
                if frame is None:
                    break
                
                # Analyze frame
                torch_tensor = torch.utils.dlpack.from_dlpack(frame.tensor)
                mean_intensity = torch_tensor.float().mean().item()
                
                frame_stats['count'] += 1
                frame_stats['total_intensity'] += mean_intensity
                frame_stats['timestamps'].append(frame.timestamp)
            
            # Compute statistics
            avg_intensity = frame_stats['total_intensity'] / frame_stats['count']
            duration_sec = (frame_stats['timestamps'][-1] - frame_stats['timestamps'][0]) / 1e9
            
            return {
                'video': video_path,
                'frames': frame_stats['count'],
                'avg_intensity': avg_intensity,
                'duration': duration_sec
            }
        
        # Process all videos in parallel
        with ThreadPoolExecutor(max_workers=n_workers) as executor:
            futures = [
                executor.submit(analyze_video, i, q, path)
                for i, (q, path) in enumerate(zip(queues, video_paths))
            ]
            
            results = [f.result() for f in futures]
        
        # Print results
        for result in results:
            print(f"\nVideo: {result['video']}")
            print(f"  Frames: {result['frames']}")
            print(f"  Duration: {result['duration']:.2f}s")
            print(f"  Avg Intensity: {result['avg_intensity']:.2f}")

# Analyze 8 videos with 4 workers
videos = [f"video_{i}.mp4" for i in range(8)]
parallel_video_analysis(videos, n_workers=4)
```

### Combining with Inference Pipeline

Extract frames and run inference on them.

```python
from pyservicemaker.utils import MediaExtractor, MediaChunk
from pyservicemaker import Pipeline, Flow
import torch  # pip install torch torchvision (not in base DS container)

def extract_and_infer(video_path, model_config, segment_duration=30):
    """
    Extract video segments and run inference on each
    
    Args:
        video_path: Path to video file
        model_config: Path to inference model config
        segment_duration: Duration of each segment in seconds
    """
    import cv2  # pip install opencv-python-headless (not in base DS container)
    
    # Get video duration (simplified - use actual video metadata in production)
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    total_duration = total_frames / fps
    cap.release()
    
    # Create chunks for each segment
    n_segments = int(total_duration / segment_duration) + 1
    chunks = [
        MediaChunk(
            source=video_path,
            start_pts=int(i * segment_duration * 1e9),
            duration=int(segment_duration * 1e9)
        )
        for i in range(n_segments)
    ]
    
    # Extract frames
    with MediaExtractor(chunks=chunks, n_thread=2, q_size=10) as extractor:
        queues = extractor()
        
        for seg_idx, q in enumerate(queues):
            print(f"Processing segment {seg_idx}...")
            
            # Collect frames from segment
            frames = []
            while True:
                frame = q.get()
                if frame is None:
                    break
                frames.append(frame)
            
            print(f"  Segment {seg_idx}: {len(frames)} frames")
            
            # Run inference on frames (simplified example)
            for frame in frames:
                torch_tensor = torch.utils.dlpack.from_dlpack(frame.tensor)
                # Run your inference model here
                # results = model(torch_tensor)
                pass

# Extract and infer on 30-second segments
extract_and_infer("long_video.mp4", "model_config.yml", segment_duration=30)
```

## Best Practices

### 1. Timestamp Conversion
Always use nanoseconds for timestamps:
```python
# Convert seconds to nanoseconds
seconds = 10.5
nanoseconds = int(seconds * 1e9)

# Convert nanoseconds to seconds
nanoseconds = 10_500_000_000
seconds = nanoseconds / 1e9
```

### 2. Queue Size Management
Choose appropriate queue size based on memory and processing speed:
```python
# Small queue for memory-constrained systems
extractor = MediaExtractor(chunks=[...], q_size=2)

# Larger queue for smooth processing
extractor = MediaExtractor(chunks=[...], q_size=20)

# Use blocking mode if processing is slow
extractor = MediaExtractor(chunks=[...], q_size=5, blocking=True)
```

### 3. Thread Count Selection
```python
# Single thread for sequential processing
extractor = MediaExtractor(chunks=[...], n_thread=1)

# Multiple threads for parallel processing
extractor = MediaExtractor(chunks=[...], n_thread=4)

# Match thread count to CPU cores
import os
n_cores = os.cpu_count()
extractor = MediaExtractor(chunks=[...], n_thread=n_cores)
```

### 4. Seeking Optimization
Enable seeking for large sampling intervals:
```python
# Enable seeking when interval > 1 second
if interval_sec > 1.0:
    extractor = MediaExtractor(chunks=[...], enable_seek=True)
else:
    extractor = MediaExtractor(chunks=[...], enable_seek=False)
```

### 5. Context Manager Usage
Always use context manager for automatic cleanup:
```python
# Good: Automatic cleanup
with MediaExtractor(chunks=[...]) as extractor:
    queues = extractor()
    # Process frames...
# Cleanup happens automatically

# Avoid: Manual cleanup required
extractor = MediaExtractor(chunks=[...])
queues = extractor()
# Must manually clean up
```

### 6. Error Handling
```python
from pyservicemaker.utils import MediaExtractor, MediaChunk

def safe_extraction(video_paths):
    """Extract frames with error handling"""
    chunks = [MediaChunk(source=path) for path in video_paths]
    
    try:
        with MediaExtractor(chunks=chunks, q_size=10) as extractor:
            queues = extractor()
            
            for i, q in enumerate(queues):
                try:
                    while True:
                        frame = q.get(timeout=30)  # Timeout to detect stalls
                        if frame is None:
                            break
                        
                        # Process frame
                        # ...
                        
                except Exception as e:
                    print(f"Error processing video {i}: {e}")
                    continue
    
    except Exception as e:
        print(f"Extraction error: {e}")
```

## Performance Tips

### 1. Batch Processing
Use batching for multiple sources:
```python
# Process 12 videos in batches of 4
extractor = MediaExtractor(
    chunks=chunks,
    batch_size=4,  # Process 4 at a time
    scaling=(1280, 720)
)
```

### 2. Memory Management
Control memory usage with queue size:
```python
# Low memory: small queue
extractor = MediaExtractor(chunks=[...], q_size=2)

# High throughput: larger queue
extractor = MediaExtractor(chunks=[...], q_size=20)
```

### 3. Parallel Processing
Use multiple threads for I/O-bound tasks:
```python
# Process 8 videos with 4 threads
extractor = MediaExtractor(
    chunks=chunks,
    n_thread=4
)
```

## Common Use Cases

### 1. Video Thumbnail Generation
Extract keyframes at regular intervals for thumbnails.

### 2. Video Segmentation
Split long videos into processable segments.

### 3. Frame Sampling for Training Data
Extract frames at intervals for ML training datasets.

### 4. Video Quality Analysis
Sample frames to analyze video quality metrics.

### 5. Event Detection
Extract frames around specific timestamps for event analysis.

### 6. Multi-Video Synchronization
Process multiple synchronized video sources in batches.

## Troubleshooting

### Issue 1: Frames Not Extracted
**Solution**: Check that source path is valid, verify timestamps are in nanoseconds

### Issue 2: Memory Issues
**Solution**: Reduce `q_size`, process frames immediately, use smaller batches

### Issue 3: Slow Extraction
**Solution**: Enable seeking for large intervals, increase thread count, use batching

### Issue 4: Queue Timeout
**Solution**: Increase queue size, enable blocking mode, check video file integrity

## Related APIs

- **BufferProvider/Feeder**: See `buffer_apis.md`
- **BufferRetriever/Receiver**: See `buffer_apis.md`
- **Pipeline API**: See `service_maker_api.md`

## Summary

The MediaExtractor, MediaChunk, and FrameSampler utilities provide powerful capabilities for advanced frame extraction:

1. **MediaChunk**: Define time segments and sampling parameters
2. **FrameSampler**: Intelligent frame sampling based on timestamps
3. **MediaExtractor**: High-level extraction with batching, threading, and seeking
4. **VideoFrame**: Container for extracted frames with timestamps

Key features:
- Precise timestamp-based extraction
- Frame sampling at intervals
- Batch processing multiple sources
- Dynamic source addition
- Seeking optimization
- Multi-threaded parallel processing
- Context manager support for cleanup

These utilities are ideal for video analysis, training data preparation, thumbnail generation, and any application requiring precise frame extraction from video sources.

