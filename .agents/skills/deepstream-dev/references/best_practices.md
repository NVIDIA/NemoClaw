# DeepStream Best Practices and Design Patterns

## Overview

This document provides comprehensive best practices, design patterns, and optimization strategies for building production-grade DeepStream applications. These guidelines help ensure performance, reliability, maintainability, and scalability.

---

## 1. Pipeline Design Patterns

### Pattern 1: Modular Pipeline Construction

**Best Practice**: Build pipelines in modular, reusable functions.

```python
def create_source_pipeline(video_path, num_streams=1):
    """Create reusable source pipeline"""
    sources = []
    for i in range(num_streams):
        sources.extend([
            {"element": "filesrc", "name": f"src{i}", "props": {"location": video_path}},
            {"element": "h264parse", "name": f"parser{i}"},
            {"element": "nvv4l2decoder", "name": f"decoder{i}"}
        ])
    return sources

def create_inference_pipeline(config_files):
    """Create reusable inference pipeline"""
    inference_elements = []
    for idx, config in enumerate(config_files):
        unique_id = idx + 1
        inference_elements.append({
            "element": "nvinfer",
            "name": f"infer{idx}",
            "props": {
                "config-file-path": config,
                "unique-id": unique_id
            }
        })
    return inference_elements

def build_complete_pipeline(video_path, infer_configs):
    """Compose complete pipeline from modules"""
    pipeline = Pipeline("modular-pipeline")
    
    # Add source modules
    sources = create_source_pipeline(video_path)
    for src_config in sources:
        pipeline.add(src_config["element"], src_config["name"], src_config.get("props", {}))
    
    # Add inference modules
    infer_elements = create_inference_pipeline(infer_configs)
    for infer_config in infer_elements:
        pipeline.add(infer_config["element"], infer_config["name"], infer_config.get("props", {}))
    
    # Link modules
    # ... linking logic ...
    
    return pipeline
```

### Pattern 2: Configuration-Driven Pipelines

**Best Practice**: Use YAML/JSON configuration files for pipeline definition.

```python
import yaml

def load_pipeline_config(config_path):
    """Load pipeline configuration from YAML"""
    with open(config_path, 'r') as f:
        return yaml.safe_load(f)

def build_pipeline_from_config(config):
    """Build pipeline from configuration"""
    pipeline = Pipeline(config["pipeline"]["name"])
    
    # Add elements from config
    for elem_config in config["pipeline"]["elements"]:
        pipeline.add(
            elem_config["type"],
            elem_config["name"],
            elem_config.get("properties", {})
        )
    
    # Link elements from config
    for link_group in config["pipeline"]["links"]:
        pipeline.link(*link_group)
    
    return pipeline
```

### Pattern 3: Factory Pattern for Element Creation

**Best Practice**: Use factory functions for element creation with validation.

```python
def create_decoder(platform="x86"):
    """Factory function for decoder creation"""
    decoder_props = {}
    
    if platform == "jetson":
        decoder_props["device"] = "/dev/video0"
    
    return {
        "element": "nvv4l2decoder",
        "name": "decoder",
        "props": decoder_props
    }

def create_sink(platform="x86", window_config=None):
    """Factory function for sink creation"""
    sink_type = "nv3dsink" if platform == "jetson" else "nveglglessink"
    sink_props = {"sync": 1}
    
    if window_config:
        sink_props.update(window_config)
    
    return {
        "element": sink_type,
        "name": "sink",
        "props": sink_props
    }
```

### Pattern 4: Strategy Pattern for Processing

**Best Practice**: Use strategy pattern for different processing approaches.

```python
class ProcessingStrategy:
    """Base class for processing strategies"""
    def process(self, batch_meta):
        raise NotImplementedError

class DetectionStrategy(ProcessingStrategy):
    """Strategy for object detection"""
    def process(self, batch_meta):
        # Detection-specific processing
        pass

class ClassificationStrategy(ProcessingStrategy):
    """Strategy for classification"""
    def process(self, batch_meta):
        # Classification-specific processing
        pass

class PipelineBuilder:
    """Pipeline builder with strategy pattern"""
    def __init__(self, strategy: ProcessingStrategy):
        self.strategy = strategy
    
    def build(self):
        pipeline = Pipeline("strategy-pipeline")
        # Build pipeline based on strategy
        return pipeline
```

---

## 2. Performance Optimization

### Optimization 1: Batch Size Tuning

**Best Practice**: Optimize batch sizes based on GPU memory and model complexity.

```python
def calculate_optimal_batch_size(
    num_streams,
    gpu_memory_gb,
    model_complexity="medium",
    resolution=(1920, 1080)
):
    """
    Calculate optimal batch size
    
    Args:
        num_streams: Number of input streams
        gpu_memory_gb: Available GPU memory in GB
        model_complexity: "low", "medium", "high"
        resolution: (width, height) tuple
    """
    # Base memory per stream (GB)
    base_memory = {
        (1920, 1080): 1.0,
        (1280, 720): 0.5,
        (640, 480): 0.25
    }.get(resolution, 1.0)
    
    # Model complexity multiplier
    complexity_mult = {
        "low": 1.0,
        "medium": 1.5,
        "high": 2.0
    }.get(model_complexity, 1.5)
    
    # Calculate max batch size
    memory_per_stream = base_memory * complexity_mult
    max_batch = int(gpu_memory_gb / memory_per_stream)
    
    # Clamp to number of streams and use power of 2
    optimal_batch = min(max_batch, num_streams)
    optimal_batch = 2 ** (optimal_batch.bit_length() - 1)  # Round down to power of 2
    
    return max(1, optimal_batch)
```

### Optimization 2: Inference Precision Selection

**Best Practice**: Use appropriate precision based on accuracy requirements.

```python
def get_inference_config(precision="fp16", model_path=None):
    """
    Get inference configuration with optimal precision
    
    Args:
        precision: "fp32", "fp16", "int8"
        model_path: Path to model file
    """
    precision_map = {
        "fp32": 0,  # Highest accuracy, slowest
        "fp16": 1,  # Good balance (recommended)
        "int8": 2   # Fastest, may need calibration
    }
    
    config = {
        "network-mode": precision_map.get(precision, 1),
        "model-engine-file": model_path
    }
    
    if precision == "int8":
        config["calibration-file"] = model_path.replace(".engine", "_calibration.bin")
    
    return config
```

### Optimization 3: Pipeline Parallelism

**Best Practice**: Run multiple pipelines on different GPUs for scalability.

```python
from multiprocessing import Process

def run_pipeline_on_gpu(pipeline_config, gpu_id):
    """Run pipeline on specific GPU"""
    import os
    os.environ["CUDA_VISIBLE_DEVICES"] = str(gpu_id)
    
    pipeline = build_pipeline(pipeline_config)
    pipeline.start().wait()

def run_multi_gpu_pipelines(pipeline_configs):
    """Run pipelines on multiple GPUs"""
    processes = []
    
    for idx, config in enumerate(pipeline_configs):
        gpu_id = idx % get_num_gpus()  # Distribute across GPUs
        process = Process(
            target=run_pipeline_on_gpu,
            args=(config, gpu_id)
        )
        process.start()
        processes.append(process)
    
    # Wait for all processes
    for process in processes:
        process.join()
```

### Optimization 4: Memory Pool Configuration

**Best Practice**: Configure appropriate buffer pool sizes.

```python
def configure_buffer_pools(pipeline, num_streams, batch_size):
    """Configure buffer pools for optimal performance"""
    # Calculate buffer pool size
    # Rule: pool_size >= (num_streams / batch_size) * 2
    pool_size = max(4, (num_streams // batch_size) * 2)
    
    # Configure queues
    for elem in pipeline.elements:
        if elem.name.startswith("queue"):
            elem.set_property("max-size-buffers", pool_size * 10)
            elem.set_property("max-size-time", 0)  # Unlimited time
            elem.set_property("leaky", 2)  # Leaky downstream
```

---

## 3. Memory Management

### Best Practice 1: Proper Cleanup

```python
class ManagedPipeline:
    """Pipeline with proper resource management"""
    def __init__(self, pipeline):
        self.pipeline = pipeline
        self.probes = []
    
    def add_probe(self, element_name, probe):
        """Add probe and track for cleanup"""
        self.pipeline.attach(element_name, probe)
        self.probes.append(probe)
    
    def start(self):
        """Start pipeline"""
        self.pipeline.start()
    
    def stop(self):
        """Stop pipeline and cleanup"""
        self.pipeline.set_state(GST_STATE_NULL)
        
        # Cleanup probes
        for probe in self.probes:
            if hasattr(probe, 'close'):
                probe.close()
            if hasattr(probe, 'flush'):
                probe.flush()
    
    def __enter__(self):
        self.start()
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        self.stop()
```

### Best Practice 2: Memory Monitoring

```python
import pynvml

class MemoryMonitor:
    """Monitor GPU memory usage"""
    def __init__(self):
        pynvml.nvmlInit()
        self.handle = pynvml.nvmlDeviceGetHandleByIndex(0)
    
    def get_memory_info(self):
        """Get current GPU memory usage"""
        info = pynvml.nvmlDeviceGetMemoryInfo(self.handle)
        return {
            "total": info.total / (1024**3),  # GB
            "used": info.used / (1024**3),     # GB
            "free": info.free / (1024**3)     # GB
        }
    
    def check_memory_pressure(self, threshold=0.9):
        """Check if memory usage exceeds threshold"""
        info = self.get_memory_info()
        usage_ratio = info["used"] / info["total"]
        return usage_ratio > threshold

# Usage in pipeline
monitor = MemoryMonitor()
if monitor.check_memory_pressure():
    print("Warning: High GPU memory usage!")
```

---

## 4. Error Handling and Resilience

### Pattern 1: Retry Logic

```python
import time
from functools import wraps

def retry(max_attempts=3, delay=1.0, backoff=2.0):
    """Retry decorator with exponential backoff"""
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            attempts = 0
            current_delay = delay
            
            while attempts < max_attempts:
                try:
                    return func(*args, **kwargs)
                except Exception as e:
                    attempts += 1
                    if attempts >= max_attempts:
                        raise
                    print(f"Attempt {attempts} failed: {e}. Retrying in {current_delay}s...")
                    time.sleep(current_delay)
                    current_delay *= backoff
        return wrapper
    return decorator

@retry(max_attempts=3, delay=1.0)
def initialize_kafka_producer(config):
    """Initialize Kafka producer with retry"""
    return KafkaProducer(bootstrap_servers=config["servers"])
```

### Pattern 2: Circuit Breaker

```python
class CircuitBreaker:
    """Circuit breaker pattern for external services"""
    def __init__(self, failure_threshold=5, timeout=60):
        self.failure_threshold = failure_threshold
        self.timeout = timeout
        self.failure_count = 0
        self.last_failure_time = None
        self.state = "closed"  # closed, open, half_open
    
    def call(self, func, *args, **kwargs):
        """Execute function with circuit breaker"""
        if self.state == "open":
            if time.time() - self.last_failure_time > self.timeout:
                self.state = "half_open"
            else:
                raise Exception("Circuit breaker is OPEN")
        
        try:
            result = func(*args, **kwargs)
            self.on_success()
            return result
        except Exception as e:
            self.on_failure()
            raise
    
    def on_success(self):
        """Reset on success"""
        self.failure_count = 0
        self.state = "closed"
    
    def on_failure(self):
        """Track failures"""
        self.failure_count += 1
        self.last_failure_time = time.time()
        
        if self.failure_count >= self.failure_threshold:
            self.state = "open"
```

### Pattern 3: Graceful Shutdown

```python
import signal
import sys

class GracefulShutdown:
    """Handle graceful shutdown signals"""
    def __init__(self):
        self.shutdown_requested = False
        signal.signal(signal.SIGINT, self._signal_handler)
        signal.signal(signal.SIGTERM, self._signal_handler)
    
    def _signal_handler(self, signum, frame):
        """Handle shutdown signals"""
        print(f"\nReceived signal {signum}. Initiating graceful shutdown...")
        self.shutdown_requested = True
    
    def is_shutdown_requested(self):
        """Check if shutdown was requested"""
        return self.shutdown_requested

# Usage
shutdown_handler = GracefulShutdown()

def run_pipeline_with_graceful_shutdown(pipeline):
    """Run pipeline with graceful shutdown handling"""
    try:
        pipeline.start()
        
        while not shutdown_handler.is_shutdown_requested():
            time.sleep(0.1)
            # Check pipeline state, process messages, etc.
        
        print("Shutting down pipeline...")
        pipeline.stop()
    except Exception as e:
        print(f"Error: {e}")
        pipeline.stop()
```

---

## 5. Code Organization and Maintainability

### Pattern 1: Separation of Concerns

```python
# config.py - Configuration management
class PipelineConfig:
    def __init__(self, config_path):
        self.config = self._load_config(config_path)
    
    def get_source_config(self):
        return self.config["source"]
    
    def get_inference_config(self):
        return self.config["inference"]

# pipeline_builder.py - Pipeline construction
class PipelineBuilder:
    def __init__(self, config: PipelineConfig):
        self.config = config
    
    def build(self):
        pipeline = Pipeline("main")
        # Build pipeline from config
        return pipeline

# processors.py - Processing logic
class MetadataProcessor:
    def process(self, batch_meta):
        # Processing logic
        pass

# main.py - Application entry point
def main():
    config = PipelineConfig("config.yml")
    builder = PipelineBuilder(config)
    pipeline = builder.build()
    pipeline.start().wait()
```

### Pattern 2: Dependency Injection

```python
class PipelineService:
    """Service class with dependency injection"""
    def __init__(self, 
                 source_factory,
                 inference_factory,
                 sink_factory,
                 processor_factory):
        self.source_factory = source_factory
        self.inference_factory = inference_factory
        self.sink_factory = sink_factory
        self.processor_factory = processor_factory
    
    def create_pipeline(self):
        """Create pipeline using injected factories"""
        pipeline = Pipeline("service-pipeline")
        
        # Use factories to create elements
        source = self.source_factory.create()
        inference = self.inference_factory.create()
        sink = self.sink_factory.create()
        
        # Build pipeline
        # ...
        
        return pipeline
```

---

## 6. Testing Strategies

### Unit Testing

```python
import unittest
from unittest.mock import Mock, patch

class TestMetadataProcessor(unittest.TestCase):
    def setUp(self):
        self.processor = MetadataProcessor()
    
    def test_process_empty_batch(self):
        """Test processing empty batch"""
        batch_meta = Mock()
        batch_meta.frame_items = []
        
        # Should not raise exception
        self.processor.process(batch_meta)
    
    def test_process_with_objects(self):
        """Test processing batch with objects"""
        batch_meta = Mock()
        frame_meta = Mock()
        frame_meta.object_items = [Mock(), Mock()]
        batch_meta.frame_items = [frame_meta]
        
        self.processor.process(batch_meta)
        # Assert expected behavior
```

### Integration Testing

```python
class TestPipelineIntegration(unittest.TestCase):
    def test_pipeline_creation(self):
        """Test pipeline creation"""
        config = PipelineConfig("test_config.yml")
        builder = PipelineBuilder(config)
        pipeline = builder.build()
        
        self.assertIsNotNone(pipeline)
        self.assertEqual(len(pipeline.elements), expected_count)
    
    def test_pipeline_linking(self):
        """Test pipeline element linking"""
        pipeline = create_test_pipeline()
        
        # Verify links are correct
        # ...
```

### Performance Testing

```python
import time

class PerformanceTest:
    def test_fps_measurement(self, pipeline, duration=10):
        """Measure FPS of pipeline"""
        start_time = time.time()
        frame_count = 0
        
        def frame_callback(batch_meta):
            nonlocal frame_count
            frame_count += len(batch_meta.frame_items)
        
        pipeline.attach("infer", Probe("fps", frame_callback))
        pipeline.start()
        
        time.sleep(duration)
        pipeline.stop()
        
        elapsed = time.time() - start_time
        fps = frame_count / elapsed
        
        print(f"Measured FPS: {fps:.2f}")
        return fps
```

---

## 7. Deployment Considerations

### Configuration Management

```python
import os
from pathlib import Path

class EnvironmentConfig:
    """Load configuration based on environment"""
    def __init__(self):
        self.env = os.getenv("DEEPSTREAM_ENV", "development")
        self.config_dir = Path("/etc/deepstream") / self.env
    
    def get_config_path(self, config_name):
        """Get configuration file path"""
        return self.config_dir / f"{config_name}.yml"
    
    def get_model_path(self, model_name):
        """Get model file path"""
        return Path("/opt/models") / self.env / model_name
```

### Logging Best Practices

```python
import logging
import sys

def setup_logging(level=logging.INFO, log_file=None):
    """Setup logging configuration"""
    handlers = [logging.StreamHandler(sys.stdout)]
    
    if log_file:
        handlers.append(logging.FileHandler(log_file))
    
    logging.basicConfig(
        level=level,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        handlers=handlers
    )

# Usage
logger = logging.getLogger(__name__)
logger.info("Pipeline started")
logger.error("Error occurred", exc_info=True)
```

---

## 8. Security Best Practices

### Secure Configuration

```python
import os
from cryptography.fernet import Fernet

class SecureConfig:
    """Handle sensitive configuration securely"""
    def __init__(self):
        self.key = os.getenv("CONFIG_ENCRYPTION_KEY")
        self.cipher = Fernet(self.key) if self.key else None
    
    def get_secret(self, secret_name):
        """Get decrypted secret"""
        encrypted = os.getenv(secret_name)
        if self.cipher and encrypted:
            return self.cipher.decrypt(encrypted.encode()).decode()
        return encrypted
```

### Input Validation

```python
def validate_video_path(path):
    """Validate video file path"""
    if not os.path.exists(path):
        raise ValueError(f"Video file not found: {path}")
    
    allowed_extensions = ['.h264', '.h265', '.mp4', '.mkv']
    if not any(path.endswith(ext) for ext in allowed_extensions):
        raise ValueError(f"Unsupported video format: {path}")
    
    return path

def validate_config_file(config_path):
    """Validate configuration file"""
    if not os.path.exists(config_path):
        raise ValueError(f"Config file not found: {config_path}")
    
    # Additional validation
    # ...
    
    return config_path
```

---

## 9. Monitoring and Observability

### Metrics Collection

```python
from prometheus_client import Counter, Histogram, Gauge

# Define metrics
frames_processed = Counter('deepstream_frames_processed_total', 'Total frames processed')
inference_latency = Histogram('deepstream_inference_latency_seconds', 'Inference latency')
gpu_memory_usage = Gauge('deepstream_gpu_memory_bytes', 'GPU memory usage')

class MetricsCollector(BatchMetadataOperator):
    """Collect metrics from pipeline"""
    def handle_metadata(self, batch_meta):
        for frame_meta in batch_meta.frame_items:
            frames_processed.inc()
            
            # Record inference latency if available
            if hasattr(frame_meta, 'inference_time'):
                inference_latency.observe(frame_meta.inference_time)
```

---

## 10. Common Anti-Patterns to Avoid

### Anti-Pattern 1: Blocking Operations in Probes

**Bad**:
```python
class BadProbe(BatchMetadataOperator):
    def handle_metadata(self, batch_meta):
        # Blocking network call in probe
        response = requests.get("http://api.example.com/data")
        # This blocks the pipeline!
```

**Good**:
```python
import queue
import threading

class GoodProbe(BatchMetadataOperator):
    def __init__(self):
        super().__init__()
        self.queue = queue.Queue()
        self.worker = threading.Thread(target=self._process_queue)
        self.worker.start()
    
    def handle_metadata(self, batch_meta):
        # Non-blocking: add to queue
        self.queue.put(batch_meta)
    
    def _process_queue(self):
        while True:
            batch_meta = self.queue.get()
            # Process asynchronously
            response = requests.get("http://api.example.com/data")
```

### Anti-Pattern 2: Ignoring Memory Limits

**Bad**:
```python
# No batch size limits
pipeline.add("nvstreammux", "mux", {"batch-size": 100})  # Too large!
```

**Good**:
```python
# Calculate optimal batch size
optimal_batch = calculate_optimal_batch_size(num_streams, gpu_memory)
pipeline.add("nvstreammux", "mux", {"batch-size": optimal_batch})
```

### Anti-Pattern 3: Not Handling Errors

**Bad**:
```python
pipeline.start().wait()  # No error handling
```

**Good**:
```python
try:
    pipeline.start().wait()
except Exception as e:
    logger.error(f"Pipeline error: {e}", exc_info=True)
    pipeline.stop()
    raise
```

### Anti-Pattern 4: Missing async=0 on All Sinks (Tee/Dynamic Sources)

**CRITICAL**: When using `tee` to split a pipeline into multiple branches OR using dynamic sources (nvmultiurisrcbin), **ALL sink elements** must have `async: 0`. This is the most common cause of pipelines stuck in PAUSED state.

**Bad** - Pipeline stuck in PAUSED:
```python
# ❌ WRONG - Only display sink has async=0, Kafka sink is missing it
# Pipeline will be STUCK IN PAUSED STATE!

# Tee split
pipeline.add("tee", "tee")

# Metadata branch - MISSING async=0!
pipeline.add("nvmsgbroker", "msgbroker", {
    "proto-lib": "/opt/nvidia/deepstream/deepstream/lib/libnvds_kafka_proto.so",
    "conn-str": "localhost;9092",
    "sync": 0,
    # async: 0 is MISSING! Pipeline will hang!
})

# Video branch - has async=0 but it's not enough
pipeline.add("nveglglessink", "sink", {
    "sync": 0,
    "async": 0  # This alone is NOT enough - ALL sinks need it!
})
```

**Good** - All sinks have async=0:
```python
# ✅ CORRECT - ALL sinks have async=0

# Tee split
pipeline.add("tee", "tee")

# Metadata branch - Kafka sink with async=0
pipeline.add("nvmsgbroker", "msgbroker", {
    "proto-lib": "/opt/nvidia/deepstream/deepstream/lib/libnvds_kafka_proto.so",
    "conn-str": "localhost;9092",
    "sync": 0,
    "async": 0  # CRITICAL: Required on ALL sinks!
})

# Video branch - display sink with async=0
pipeline.add("nveglglessink", "sink", {
    "sync": 0,
    "qos": 0,
    "async": 0  # CRITICAL: Required on ALL sinks!
})
```

**Symptoms of this bug**:
- Camera shows "added successfully" in logs
- Pipeline elements transition to READY, then PAUSED
- Pipeline never transitions to PLAYING
- No video display, no data flowing
- No error messages (silent failure)

**Rule**: When using `tee` or dynamic sources, ALWAYS set `async: 0` on EVERY sink element in the pipeline.

### Anti-Pattern 5: Using threading.Queue with multiprocessing.Process

**CRITICAL**: This is a common and subtle bug that causes data loss!

When using `multiprocessing.Process` to run pipelines in separate processes, you MUST use `multiprocessing.Queue` for inter-process communication. A regular `queue.Queue` (from the `queue` module) only works within a single process.

**Bad** - Data silently lost:
```python
from multiprocessing import Process
from queue import Queue  # WRONG! This is a threading queue

class MultiStreamProcessor:
    def __init__(self):
        # This queue WILL NOT work across process boundaries!
        self.batch_queue = Queue()  # BAD: threading.Queue
    
    def start(self, use_multiprocessing=True):
        for stream in self.streams:
            if use_multiprocessing:
                # Child process gets a COPY of the queue
                # Any data put into it never reaches the parent!
                process = Process(
                    target=self._run_pipeline,
                    args=(stream, self.batch_queue)
                )
                process.start()
```

**Good** - Use multiprocessing.Queue for inter-process communication:
```python
from multiprocessing import Process, Queue as MPQueue  # Correct!
from queue import Queue as ThreadQueue

class MultiStreamProcessor:
    def __init__(self, use_multiprocessing=True):
        # Choose the right queue type based on usage
        if use_multiprocessing:
            self.batch_queue = MPQueue()  # CORRECT: multiprocessing.Queue
        else:
            self.batch_queue = ThreadQueue()  # For single-process/threading
    
    def start(self, use_multiprocessing=True):
        for stream in self.streams:
            if use_multiprocessing:
                # multiprocessing.Queue properly shares data across processes
                process = Process(
                    target=self._run_pipeline,
                    args=(stream, self.batch_queue)
                )
                process.start()
```

**Alternative - Use threading instead of multiprocessing**:
```python
import threading
from queue import Queue  # OK for threading

class MultiStreamProcessor:
    def __init__(self):
        self.batch_queue = Queue()  # OK: threading.Queue for threads
    
    def start(self):
        for stream in self.streams:
            # Threads share memory, so queue.Queue works fine
            thread = threading.Thread(
                target=self._run_pipeline,
                args=(stream, self.batch_queue)
            )
            thread.start()
```

**Key Rules**:
1. `queue.Queue` → Use with `threading.Thread` (same process)
2. `multiprocessing.Queue` → Use with `multiprocessing.Process` (cross-process)
3. When in doubt, set `use_multiprocessing=False` and use threads
4. Always add debug logs to verify data flows through queues correctly

**Symptoms of this bug**:
- Pipeline appears to run normally
- No error messages
- Downstream processing (e.g., VLM, Kafka) never receives data
- Statistics show 0 batches/messages processed

---

## 11. Common Pitfalls and Code Generation Errors

This section documents common mistakes encountered when generating DeepStream code, to prevent them in future.

### Pitfall 1: Using len() on Metadata Iterators

**Problem**: `frame_meta.object_items`, `frame_meta.tensor_items`, and `frame_meta.user_items` return **iterators**, not lists.

**Error**:
```
TypeError: object of type 'iterator' has no len()
```

**Bad Code**:
```python
# ❌ WRONG - Causes crash
count = len(frame_meta.object_items)

# ❌ WRONG - Second loop is empty (iterator already consumed)
for obj in frame_meta.object_items:
    process(obj)
for obj in frame_meta.object_items:
    count += 1
```

**Correct Code**:
```python
# ✅ CORRECT - Count while iterating
obj_count = 0
for obj in frame_meta.object_items:
    obj_count += 1
    process(obj)
```

### Pitfall 2: Incorrect nvinfer Configuration Syntax

**Problem**: nvinfer supports **both YAML and INI-style formats**, but the syntax must be correct for each format.

**Error**:
```
Configuration file parsing failed
```

**Common Mistakes**:
```yaml
# ❌ WRONG - Incorrect section name (should be 'property', not 'model')
model:
  model-engine-file: /path/to/model.engine
  batch-size: 1

# ❌ WRONG - Mixing formats (YAML syntax in .txt file or vice versa)
```

**Correct YAML Config** (`.yml`):
```yaml
# ✅ CORRECT YAML format
property:
  gpu-id: 0
  onnx-file: /opt/nvidia/deepstream/deepstream/samples/models/Primary_Detector/resnet18_trafficcamnet_pruned.onnx
  labelfile-path: /opt/nvidia/deepstream/deepstream/samples/models/Primary_Detector/labels.txt
  batch-size: 1
  network-mode: 2
  num-detected-classes: 4
  process-mode: 1
  cluster-mode: 2

class-attrs-all:
  topk: 20
  pre-cluster-threshold: 0.2
```

**Correct INI-style Config** (`.txt`):
```ini
# ✅ CORRECT INI-style format
[property]
gpu-id=0
onnx-file=/opt/nvidia/deepstream/deepstream/samples/models/Primary_Detector/resnet18_trafficcamnet_pruned.onnx
labelfile-path=/opt/nvidia/deepstream/deepstream/samples/models/Primary_Detector/labels.txt
batch-size=1
network-mode=2
num-detected-classes=4
process-mode=1
cluster-mode=2

[class-attrs-all]
topk=20
pre-cluster-threshold=0.2
```

**Key Rules**:
- YAML format: Use `property:` (no brackets), `key: value` with colon+space
- INI format: Use `[property]` (with brackets), `key=value` with equals sign
- Section must be named `property` (not `model` or other names)
- Don't mix formats in the same file

### Pitfall 3: Using Wrong Model (ResNet10 vs ResNet18)

**Problem**: DeepStream samples use **ResNet18** TrafficCamNet model, not ResNet10.

**Correct Model Paths**:
```
/opt/nvidia/deepstream/deepstream/samples/models/Primary_Detector/
├── resnet18_trafficcamnet_pruned.onnx    # ✅ Use this ONNX model
├── labels.txt                              # Class labels
└── cal_trt.bin                            # INT8 calibration (optional)
```

**In nvinfer config**:
```ini
[property]
onnx-file=/opt/nvidia/deepstream/deepstream/samples/models/Primary_Detector/resnet18_trafficcamnet_pruned.onnx
labelfile-path=/opt/nvidia/deepstream/deepstream/samples/models/Primary_Detector/labels.txt
```

### Pitfall 4: nvv4l2decoder Output Format Assumption

**Fact**: `nvv4l2decoder` outputs `video/x-raw(memory:NVMM)` - already in GPU memory format.

**Common Mistake**: Adding unnecessary `nvvideoconvert` after decoder.

**Unnecessary Code**:
```python
# ❌ UNNECESSARY - nvv4l2decoder already outputs NVMM format
pipeline.add("nvv4l2decoder", "decoder")
pipeline.add("nvvideoconvert", "conv")  # Not needed!
pipeline.add("nvstreammux", "mux")
```

**Correct Code**:
```python
# ✅ CORRECT - Direct connection, no converter needed
pipeline.add("nvv4l2decoder", "decoder")
pipeline.add("nvstreammux", "mux")
pipeline.link(("decoder", "mux"), ("", "sink_%u"))
```

### Pitfall 5: Built-in Probe Usage

**Fact**: `measure_fps_probe` is a valid built-in probe, but must be attached to the correct element.

**Correct Usage**:
```python
# Attach to inference element for FPS measurement
pipeline.attach("infer", "measure_fps_probe", "fps-probe")
```

**If probe attachment fails**, implement custom FPS measurement:
```python
class FPSCounter(BatchMetadataOperator):
    def __init__(self):
        super().__init__()
        self.start_time = None
        self.frame_count = 0
    
    def handle_metadata(self, batch_meta):
        if self.start_time is None:
            self.start_time = time.time()
        self.frame_count += 1
        elapsed = time.time() - self.start_time
        if elapsed > 0 and self.frame_count % 30 == 0:
            print(f"FPS: {self.frame_count / elapsed:.2f}")

pipeline.attach("infer", Probe("fps-counter", FPSCounter()))
```

---

## Summary

Following these best practices and patterns will help you build robust, performant, and maintainable DeepStream applications. Key takeaways:

1. **Design for modularity**: Use patterns like Factory, Strategy, and Dependency Injection
2. **Optimize performance**: Tune batch sizes, use appropriate precision, enable parallelism
3. **Manage resources**: Proper cleanup, memory monitoring, buffer pool configuration
4. **Handle errors gracefully**: Retry logic, circuit breakers, graceful shutdown
5. **Test thoroughly**: Unit tests, integration tests, performance tests
6. **Monitor and observe**: Metrics collection, logging, health checks
7. **Secure your application**: Input validation, secure configuration, access control
8. **Use correct Queue types**: 
   - `queue.Queue` → for threading (same process)
   - `multiprocessing.Queue` → for multiprocessing (cross-process)
   - **NEVER** use `queue.Queue` with `multiprocessing.Process` - data will be silently lost!
9. **Set async=0 on ALL sinks when using tee or dynamic sources**:
   - When pipeline uses `tee` to split into multiple branches, ALL sink elements need `async: 0`
   - When using dynamic sources (nvmultiurisrcbin), ALL sinks need `async: 0`
   - **Symptom if missing**: Pipeline stuck in PAUSED state, no video/data flows
   - This applies to display sinks, Kafka sinks, file sinks - ALL sinks!
10. **Avoid common code generation pitfalls**:
   - **NEVER** use `len()` on metadata iterators (`object_items`, `tensor_items`, `user_items`)
   - **USE** correct syntax for nvinfer config (YAML: `property:` with `: `, or INI: `[property]` with `=`)
   - **USE** ResNet18 model (`resnet18_trafficcamnet_pruned.onnx`) from DeepStream samples
   - **KNOW** that `nvv4l2decoder` outputs NVMM format (no converter needed before nvstreammux)

These practices ensure your DeepStream applications are production-ready and scalable.

