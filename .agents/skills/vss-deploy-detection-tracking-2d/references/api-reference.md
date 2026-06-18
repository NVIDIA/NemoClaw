# RTVI-CV API Reference

Complete endpoint reference for the Real Time Video Intelligence CV (RTVI-CV) microservice REST API.

Base URL: `http://<host>:9000` | All endpoints prefixed with `/api/v1`

---

## Endpoints

### POST `/api/v1/stream/add` — Add a new video stream

**Request body:**

```json
{
  "key": "sensor",
  "value": {
    "camera_id": "<string, required — unique stream identifier>",
    "camera_url": "<string, required — video source URL>",
    "change": "camera_add",
    "camera_name": "<string, optional — display name, defaults to camera_id>",
    "creation_time": "<ISO 8601, optional — only for http/https URLs>",
    "metadata": {
      "resolution": "<string, optional — default '1920 x1080'>",
      "codec": "<string, optional — default 'h264'>",
      "framerate": "<integer, optional — default 30>"
    }
  },
  "headers": {
    "source": "<string, optional — source system>",
    "created_at": "<ISO 8601, optional>"
  }
}
```

**Responses:**

| Code | Meaning | Example `reason` |
|------|---------|------------------|
| 200 | Stream added | `"Stream added successfully"` |
| 400 | Missing/invalid fields | `"STREAM_ADD_FAIL, Source url empty"` or `"STREAM_ADD_FAIL, Source id empty"` |
| 500 | Pipeline error | `"Failed to add stream to pipeline"` |

**curl template:**

```bash
curl -s -X POST "${BASE_URL}/api/v1/stream/add" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "sensor",
    "value": {
      "camera_id": "${CAMERA_ID}",
      "camera_name": "${CAMERA_NAME}",
      "camera_url": "${CAMERA_URL}",
      "change": "camera_add",
      "metadata": { "resolution": "1920 x1080", "codec": "h264", "framerate": 30 }
    }
  }'
```

---

### POST `/api/v1/stream/remove` — Remove an existing video stream

**Request body:**

```json
{
  "key": "sensor",
  "value": {
    "camera_id": "<string, required — must match existing stream>",
    "camera_url": "<string, required — must match URL used when adding>",
    "change": "camera_remove",
    "camera_name": "<string, optional>"
  }
}
```

**Responses:**

| Code | Meaning | Example `reason` |
|------|---------|------------------|
| 200 | Stream removed | `"Stream removed successfully"` |
| 400 | Missing/invalid fields | `"STREAM_REMOVE_FAIL, Source url empty"` or `"STREAM_REMOVE_FAIL, Source id empty"` |
| 500 | Pipeline error | `"Failed to remove stream from pipeline"` |

**curl template:**

```bash
curl -s -X POST "${BASE_URL}/api/v1/stream/remove" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "sensor",
    "value": {
      "camera_id": "${CAMERA_ID}",
      "camera_name": "${CAMERA_NAME}",
      "camera_url": "${CAMERA_URL}",
      "change": "camera_remove"
    }
  }'
```

---

### GET `/api/v1/stream/get-stream-info` — List active streams

**Headers:** `Accept: application/json` (default) or `Accept: text/plain` (Prometheus)

**JSON response shape:**

```json
{
  "status": "HTTP/1.1 200 OK",
  "reason": "Stream info retrieved successfully",
  "stream-info": {
    "stream-count": 2,
    "stream-list": [
      {
        "camera_id": "camera_001",
        "camera_name": "Front Door Camera",
        "camera_url": "rtsp://192.168.1.100:554/stream1",
        "source_id": 0,
        "sensor_id": "sensor_0"
      }
    ]
  }
}
```

**curl:**

```bash
curl -s "${BASE_URL}/api/v1/stream/get-stream-info" -H "Accept: application/json"
```

---

### GET `/api/v1/live` — Liveness probe

**JSON response:**

```json
{
  "status": "HTTP/1.1 200 OK",
  "reason": "Application is alive",
  "live-info": { "ds-liveness": "YES" }
}
```

**curl:**

```bash
curl -s "${BASE_URL}/api/v1/live" -H "Accept: application/json"
```

---

### GET `/api/v1/ready` — Readiness probe

**JSON response:**

```json
{
  "status": "HTTP/1.1 200 OK",
  "reason": "Application is ready",
  "ready-info": { "ds-ready": "YES" }
}
```

**curl:**

```bash
curl -s "${BASE_URL}/api/v1/ready" -H "Accept: application/json"
```

---

### GET `/api/v1/startup` — Startup probe

**JSON response:**

```json
{
  "status": "HTTP/1.1 200 OK",
  "reason": "Application has started",
  "startup-info": { "ds-startup": "YES" }
}
```

**curl:**

```bash
curl -s "${BASE_URL}/api/v1/startup" -H "Accept: application/json"
```

---

### GET `/api/v1/metrics` — Performance metrics

**Headers:**

| Header | Description |
|--------|-------------|
| `Accept` | `application/json` (default) or `text/plain` (Prometheus) |
| `X-Refresh-Period` | OpenTelemetry export interval in ms; `-1` to disable |
| `X-OTLP-URL` | OpenTelemetry collector endpoint URL |

**JSON response shape:**

```json
{
  "status": "HTTP/1.1 200 OK",
  "reason": "Metrics retrieved successfully",
  "metrics-info": {
    "stream-count": 2,
    "stream-stats": [
      {
        "sensor_id": "sensor_0",
        "sensor_name": "camera_001",
        "source_id": 0,
        "fps": 29.97,
        "frame_number": 1234,
        "latency_ms": 45.2
      }
    ],
    "system-stats": {
      "GPU_gb": 4.5,
      "RAM_gb": 8.2,
      "cpu_util": 45.3,
      "gpu_util": 78.9
    }
  }
}
```

**Prometheus format example:**

```
# HELP fps_metrics FPS metrics from ds
# TYPE fps_metrics gauge
fps_metrics{app_name="ds",metric_name="stream_fps",sensor_id="1",source_id="0"} 29.80
# HELP latency_metrics Latency metrics from ds
# TYPE latency_metrics gauge
latency_metrics{app_name="ds",metric_name="stream_latency_ms",sensor_id="1",source_id="0"} 402.39
# HELP memory_metrics Memory metrics from ds
# TYPE memory_metrics gauge
memory_metrics{app_name="ds",metric_name="system_ram_memory_gb"} 8.40
memory_metrics{app_name="ds",metric_name="system_gpu_memory_gb"} 1.34
# HELP utilization_metrics Utilization metrics from ds
# TYPE utilization_metrics gauge
utilization_metrics{app_name="ds",metric_name="system_gpu_utilization"} 6
utilization_metrics{app_name="ds",metric_name="system_cpu_utilization"} 7.5
# HELP stream_count Stream count from ds
# TYPE stream_count gauge
stream_count{app_name="ds",metric_name="stream_count"} 2
```

**curl (JSON):**

```bash
curl -s "${BASE_URL}/api/v1/metrics" -H "Accept: application/json"
```

**curl (Prometheus):**

```bash
curl -s "${BASE_URL}/api/v1/metrics" -H "Accept: text/plain"
```

**curl (with OpenTelemetry):**

```bash
curl -s "${BASE_URL}/api/v1/metrics" \
  -H "Accept: application/json" \
  -H "X-Refresh-Period: 5000" \
  -H "X-OTLP-URL: http://otel-collector:4318"
```

---

### GET `/api/v1/metadata` — Service metadata

**JSON response:**

```json
{
  "version": "1.0.0",
  "sub_version": "a3f5c8d",
  "licenseInfo": {
    "name": "NVIDIA-Proprietary",
    "path": "/opt/mm/LICENSE",
    "url": "file:///opt/mm/LICENSE"
  }
}
```

**curl:**

```bash
curl -s "${BASE_URL}/api/v1/metadata"
```

---

### POST `/api/v1/generate_text_embeddings` — Generate text embeddings

**Request body:**

```json
{
  "text_input": "<string, required — text to embed>",
  "model": "<string, required — e.g. 'cosmos-embed1-448p'>"
}
```

**Responses:**

| Code | Meaning | Example |
|------|---------|---------|
| 200 | Embeddings generated | `{"id": "uuid", "created": "<unix-epoch>", "model": "cosmos-embed1-448p", "data": [...]}` |
| 400 | Missing fields | `{"code": "BadRequest", "message": "Missing required fields: text_input and model"}` |
| 500 | Model error | `{"code": "ErrorCode", "message": "Failed to generate embeddings"}` |

**curl:**

```bash
curl -s -X POST "${BASE_URL}/api/v1/generate_text_embeddings" \
  -H "Content-Type: application/json" \
  -d '{ "text_input": "${TEXT}", "model": "cosmos-embed1-448p" }'
```

---

## Supported Video Protocols

| Protocol | Format | Example |
|----------|--------|---------|
| RTSP | `rtsp://host:port/path` | `rtsp://192.168.1.100:554/stream1` |
| RTMP | `rtmp://host:port/path` | `rtmp://10.0.0.50:1935/live` |
| File | `file:///absolute/path` | `file:///opt/videos/sample.mp4` |
| HTTP/HTTPS | `http(s)://host/path` | `https://example.com/video.mp4` |
| USB Camera | `v4l2:///dev/videoN` | `v4l2:///dev/video0` |

## Supported Codecs

`h264`, `h265`, `hevc`, `vp8`, `vp9`, `av1`

## Python Helper (stdlib only)

```python
import json, urllib.request

def call_rtvi_api(base_url, method, path, body=None):
    url = f"{base_url}{path}"
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json")
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())
```
