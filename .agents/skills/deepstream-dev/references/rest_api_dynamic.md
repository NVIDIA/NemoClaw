# REST API and Dynamic Source Management

## Overview

DeepStream supports dynamic addition and removal of video sources at runtime through REST APIs. This capability is built into `nvmultiurisrcbin`, which integrates an HTTP REST server, multiple `nvurisrcbin` instances, and `nvstreammux` into a single GStreamer bin.

**CRITICAL: Always use the built-in REST server in nvmultiurisrcbin. Do NOT implement a separate Flask/FastAPI server for stream management.**

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    nvmultiurisrcbin                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ nvds_rest_   │  │ nvurisrcbin  │  │   nvstreammux    │  │
│  │ server       │  │ (multiple)   │  │                  │  │
│  │ Port: 9000   │  │              │  │                  │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## Critical Configuration for Dynamic Sources

### Sink Element Configuration

**⚠️ CRITICAL: When using dynamic sources, the sink element MUST have `async=0`**

```python
# ✅ CORRECT - Required for dynamic source state transitions
pipeline.add("nveglglessink", "sink", {
    "sync": 0,   # Don't sync to clock (required for live sources)
    "qos": 0,    # Disable QoS events
    "async": 0   # CRITICAL: Synchronous state changes for dynamic streams
})

# ❌ WRONG - Will cause state transition deadlock
pipeline.add("nveglglessink", "sink", {"sync": 0})  # Missing async=0
```

**Why `async=0` is required:**
- Without it, the sink waits for preroll (first buffer) before allowing state transitions
- With dynamic streams, this creates a deadlock: source waits for sink, sink waits for data
- Setting `async=0` makes state changes synchronous, allowing proper transitions

### nvmultiurisrcbin Configuration

```python
source_props = {
    # REST API Server
    "ip-address": "0.0.0.0",        # Listen on all interfaces
    "port": 9000,                    # REST API port (0 to disable)
    
    # Batching
    "max-batch-size": 16,            # Maximum number of sources
    "batched-push-timeout": 33333,   # Push batch after 33ms even if not full
    "width": 1920,
    "height": 1080,
    
    # Dynamic source handling
    "live-source": 1,                # REQUIRED for dynamic streams
    "drop-pipeline-eos": 1,          # Keep pipeline alive when sources removed
    "async-handling": 1,             # Handle async state changes
    
    # RTSP settings
    "select-rtp-protocol": 0,        # 0=UDP+TCP auto, 4=TCP only
    "latency": 100,                  # Jitterbuffer size in ms
}

pipeline.add("nvmultiurisrcbin", "src", source_props)
```

---

## REST API Endpoints

The built-in REST server provides these endpoints:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/stream/add` | POST | Add a new stream |
| `/api/v1/stream/remove` | POST | Remove a stream |
| `/api/v1/stream/get-stream-info` | GET | Get current stream info |
| `/api/v1/health/get-dsready-state` | GET | Check pipeline readiness |

### Add Stream Payload

```json
{
    "key": "sensor",
    "value": {
        "camera_id": "unique_sensor_id",
        "camera_name": "human_readable_name",
        "camera_url": "rtsp://camera-ip/stream",
        "change": "camera_add"
    }
}
```

**Mandatory fields:**
- `value/camera_id` - Unique identifier
- `value/camera_url` - Stream URI
- `value/change` - Must contain "add" substring

### Remove Stream Payload

```json
{
    "key": "sensor",
    "value": {
        "camera_id": "unique_sensor_id",
        "camera_url": "rtsp://camera-ip/stream",
        "change": "camera_remove"
    }
}
```

**Note:** The `change` field must contain "remove" substring.

### Example curl Commands

```bash
# Add a stream
curl -X POST 'http://localhost:9000/api/v1/stream/add' -d '{
    "key": "sensor",
    "value": {
        "camera_id": "cam_001",
        "camera_name": "Front Door",
        "camera_url": "rtsp://192.168.1.100/stream",
        "change": "camera_add"
    }
}'

# Remove a stream
curl -X POST 'http://localhost:9000/api/v1/stream/remove' -d '{
    "key": "sensor",
    "value": {
        "camera_id": "cam_001",
        "camera_url": "rtsp://192.168.1.100/stream",
        "change": "camera_remove"
    }
}'

# Get stream info
curl -X GET 'http://localhost:9000/api/v1/stream/get-stream-info'

# Check pipeline readiness
curl -X GET 'http://localhost:9000/api/v1/health/get-dsready-state'
```

---

## Complete Pipeline Example

```python
from pyservicemaker import (
    Pipeline, Probe, BatchMetadataOperator,
    StateTransitionMessage, DynamicSourceMessage
)
import platform

def run_dynamic_source_pipeline():
    """Pipeline with dynamic source management via REST API."""
    
    def on_message(message):
        """Handle pipeline messages for dynamic sources."""
        if isinstance(message, DynamicSourceMessage):
            if message.source_added:
                print(f"Camera ADDED: {message.sensor_name} "
                      f"(id={message.sensor_id}, source_id={message.source_id})")
            else:
                print(f"Camera REMOVED: source_id={message.source_id}")
        
        elif isinstance(message, StateTransitionMessage):
            state_name = str(message.new_state).split('.')[-1]
            print(f"{message.origin} -> {state_name}")
    
    pipeline = Pipeline("dynamic-source-pipeline")
    
    # Source with built-in REST server
    pipeline.add("nvmultiurisrcbin", "src", {
        "ip-address": "0.0.0.0",
        "port": 9000,                    # REST API on port 9000
        "max-batch-size": 16,
        "batched-push-timeout": 33333,
        "width": 1920,
        "height": 1080,
        "live-source": 1,                # Required for dynamic sources
        "drop-pipeline-eos": 1,
        "async-handling": 1,
        "select-rtp-protocol": 0,
        "latency": 100,
    })
    
    # Inference
    pipeline.add("nvinfer", "pgie", {
        "config-file-path": "/path/to/pgie_config.yml",
        "batch-size": 16
    })
    
    # Tiler for multi-stream display
    pipeline.add("nvmultistreamtiler", "tiler", {
        "width": 1920,
        "height": 1080,
        "rows": 4,
        "columns": 4
    })
    
    # OSD
    pipeline.add("nvosdbin", "osd")
    
    # Sink - CRITICAL: async=0 for dynamic sources
    sink_type = "nv3dsink" if platform.processor() == "aarch64" else "nveglglessink"
    pipeline.add(sink_type, "sink", {
        "sync": 0,
        "qos": 0,
        "async": 0  # CRITICAL for dynamic source state transitions
    })
    
    # Link pipeline
    pipeline.link("src", "pgie", "tiler", "osd", "sink")
    
    # Prepare and activate
    pipeline.prepare(on_message)
    pipeline.activate()
    
    print("Pipeline started. REST API available at http://localhost:9000")
    print("Add streams with: POST /api/v1/stream/add")
    
    pipeline.wait()

if __name__ == "__main__":
    from multiprocessing import Process
    process = Process(target=run_dynamic_source_pipeline)
    process.start()
    process.join()
```

---

## Handling DynamicSourceMessage

When streams are added or removed, the pipeline emits `DynamicSourceMessage`:

```python
from pyservicemaker import DynamicSourceMessage

def on_message(message):
    if isinstance(message, DynamicSourceMessage):
        source_id = message.source_id      # Internal source ID (int)
        sensor_id = message.sensor_id      # Your camera_id from REST API
        sensor_name = message.sensor_name  # Your camera_name from REST API
        
        if message.source_added:
            # Stream successfully added
            # Map source_id to your camera tracking
            print(f"Added: {sensor_name} (sensor_id={sensor_id})")
        else:
            # Stream removed
            print(f"Removed: source_id={source_id}")
```

---

## Common Errors and Solutions

### Error: Stream added but no video displayed

**Symptom:** REST API returns success, `DynamicSourceMessage` received, but elements stuck in PAUSED state.

**Cause:** Missing `async=0` on sink element.

**Solution:**
```python
# Add async=0 to sink
pipeline.add("nveglglessink", "sink", {
    "sync": 0,
    "qos": 0,
    "async": 0  # This is the fix
})
```

### Error: No data from source, reconnection attempts

**Symptom:**
```
WARNING from dsnvurisrcbin0: No data from source since last 10 sec. Trying reconnection
Could not send message. (Received end-of-file)
```

**Cause:** RTSP source issue - invalid URL, authentication required, or network problem.

**Solution:**
1. Test RTSP URL with ffplay: `ffplay rtsp://camera-ip/stream`
2. Include credentials: `rtsp://user:password@camera-ip/stream`
3. Try different RTP protocol: `select-rtp-protocol: 4` (TCP only)

### Error: Pipeline EOS when stream removed

**Symptom:** Pipeline stops when the last stream is removed.

**Solution:** Set `drop-pipeline-eos: 1` on nvmultiurisrcbin.

### Anti-Pattern: Implementing Custom REST Server

**❌ WRONG - Do not implement a separate Flask/FastAPI server:**
```python
# DON'T DO THIS
from flask import Flask
app = Flask(__name__)

@app.route('/add-camera', methods=['POST'])
def add_camera():
    # Custom REST server adds complexity and potential bugs
    pass
```

**✅ CORRECT - Use the built-in REST server:**
```python
# Just configure the port on nvmultiurisrcbin
pipeline.add("nvmultiurisrcbin", "src", {
    "port": 9000,  # Built-in REST server on port 9000
    # ... other properties
})
# REST API is automatically available at http://localhost:9000/api/v1/
```

If you need a proxy API for simplified requests, make HTTP calls to the built-in server instead of reimplementing stream management.

---

## Headless Operation

For headless (no display) operation, use `fakesink`:

```python
import os

if "DISPLAY" not in os.environ:
    # Headless mode
    pipeline.add("fakesink", "sink", {
        "sync": 0,
        "async": 0
    })
else:
    # Display mode
    pipeline.add("nveglglessink", "sink", {
        "sync": 0,
        "qos": 0,
        "async": 0
    })
```

---

## RTSP URL Formats

Common RTSP URL formats by manufacturer:

| Manufacturer | URL Format |
|--------------|------------|
| Hikvision | `rtsp://user:pass@ip:554/Streaming/Channels/101` |
| Dahua | `rtsp://user:pass@ip:554/cam/realmonitor?channel=1&subtype=0` |
| Axis | `rtsp://user:pass@ip/axis-media/media.amp` |
| Generic | `rtsp://user:pass@ip:554/stream1` |
| NVIDIA Demo | `rtsp://nv-wowza-pdc.nvidia.com:1935/vod/concat_wh_52.mp4` |

---

## Quick Reference

| Requirement | Property | Value |
|-------------|----------|-------|
| Enable REST API | `port` | 9000 (or any port, 0 to disable) |
| Dynamic sources | `live-source` | 1 |
| Keep pipeline alive | `drop-pipeline-eos` | 1 |
| Async state changes | `async-handling` | 1 |
| **Sink async** | `async` | **0 (CRITICAL)** |
| Sink sync | `sync` | 0 |

---

## Related Documentation

- **GStreamer Plugins**: `gstreamer_plugins.md`
- **Service Maker API**: `service_maker_api.md`
- **Troubleshooting**: `troubleshooting.md`
- **Configuration Classes**: `utilities_config.md`
