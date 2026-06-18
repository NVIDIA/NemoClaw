# API Reference: Video Embedding (RT-Embed)

The service exposes a v1 REST API on container port `8000`. The OpenAPI spec uses a relative server URL, so callers must set `BASE_URL` to the deployed host and port (for example, `http://localhost:${RTVI_EMBED_PORT}`).

The OpenAPI spec annotates every endpoint with a Bearer token security scheme. Compose-based **local** deployments may not enforce Bearer auth on the loopback interface, **but** Bearer auth MUST be enabled before exposing the API on any non-loopback interface, in staging, or in production. Treat the unauthenticated bring-up as a localhost-only debug shortcut: bind only to `127.0.0.1`, never to `0.0.0.0`, never to a publicly routable IP, and never to a shared host without first restoring the Bearer header. Operators who copy the local pattern into staging or prod will expose an unauthenticated embedding API to the network — this is a credential-equivalent disclosure risk for any RAG corpus reachable through it. Always inject `Authorization: Bearer <token>` at the caller boundary the moment the service leaves the developer laptop.

All examples below assume:

```bash
BASE_URL="http://localhost:${RTVI_EMBED_PORT}"
```

> **Note:** All `id`, `file_id`, and `stream_id` values in this API are UUIDs (RFC 4122, typically v4 — e.g. `550e8400-e29b-41d4-a716-446655440000`). Callers must generate a valid UUID for request bodies that accept an `id`, and the service returns UUIDs in all responses that reference one.

## Endpoint Index

### Embeddings

| Method | Path | Summary |
|---|---|---|
| `POST` | `/v1/generate_text_embeddings` | Generate embeddings for a text input. |
| `POST` | `/v1/generate_video_embeddings` | Generate embeddings for a video file, image, or live stream. |
| `DELETE` | `/v1/generate_video_embeddings/{stream_id}` | Stop a live stream from generating video embeddings. |

### Files

| Method | Path | Summary |
|---|---|---|
| `GET` | `/v1/files?purpose=<purpose>` | List files filtered by purpose. |
| `POST` | `/v1/files` | Upload a media file. |
| `GET` | `/v1/files/{file_id}` | Get metadata for a file. |
| `DELETE` | `/v1/files/{file_id}` | Delete a file. |
| `GET` | `/v1/files/{file_id}/content` | Stream the contents of a file. |

### Live Stream

| Method | Path | Summary |
|---|---|---|
| `POST` | `/v1/streams/add` | Add one or more live streams. |
| `GET` | `/v1/streams/get-stream-info` | List all registered live streams. |
| `DELETE` | `/v1/streams/delete/{stream_id}` | Remove a live stream. |
| `DELETE` | `/v1/streams/delete-batch` | Remove multiple live streams in one request. |

### Stream (single-stream control plane)

| Method | Path | Summary |
|---|---|---|
| `POST` | `/v1/stream/add` | Add a single video stream and (if metadata includes a model) start embedding it. |
| `POST` | `/v1/stream/remove` | Remove a single video stream and stop embedding it. |
| `GET` | `/v1/stream/get-stream-info` | List streams with inference status. |

### Models

| Method | Path | Summary |
|---|---|---|
| `GET` | `/v1/models` | List the currently available embedding models. |

### Health Check

| Method | Path | Summary |
|---|---|---|
| `GET` | `/v1/ready` | Readiness probe. Accepts `?detailed=true` for component status. |
| `GET` | `/v1/live` | Liveness probe. Accepts `?detailed=true`. |
| `GET` | `/v1/startup` | Startup probe. |
| `GET` | `/v1/assets/stats` | Asset storage counts, TTL, and oldest-asset age. |

### Metadata / NIM-compatible

| Method | Path | Summary |
|---|---|---|
| `GET` | `/v1/metadata` | Service metadata including version and license info. |
| `GET` | `/v1/version` | Service version. |
| `GET` | `/v1/manifest` | Service manifest (version, model). |

### Metrics

| Method | Path | Summary |
|---|---|---|
| `GET` | `/v1/metrics` | Prometheus-format metrics. |

## Worked Examples

### Upload a file and embed it

```bash
# 1. Upload.
RESP=$(curl -fsS -X POST "$BASE_URL/v1/files" \
  -F purpose=vision \
  -F media_type=video \
  -F file=@/path/to/clip.mp4)
FILE_ID=$(echo "$RESP" | jq -r .id)

# 2. Embed in 60-second chunks with 10-second overlap.
curl -fsS -X POST "$BASE_URL/v1/generate_video_embeddings" \
  -H "Content-Type: application/json" \
  -d "{
    \"id\": \"$FILE_ID\",
    \"model\": \"cosmos-embed1-448p\",
    \"chunk_duration\": 60,
    \"chunk_overlap_duration\": 10
  }"
```

### Embed by URL (no upload)

```bash
curl -fsS -X POST "$BASE_URL/v1/generate_video_embeddings" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "model": "cosmos-embed1-448p",
    "url": "https://www.example.com/video.mp4",
    "media_type": "video"
  }'
```

Supported `url` schemes per the spec: `http://`, `https://`, `s3://`, `file://`, and `data:` URIs.

> **Security warning — `file://`**: this scheme causes the embedding server
> to read **arbitrary local files** from its own filesystem. It is gated by
> the `FILE_URL_ALLOWED_DIRS` env var and MUST stay restricted to a
> narrow allow-list of directories that hold only intended media. An
> empty / overly broad allow-list combined with an exposed (or
> unauthenticated) endpoint lets a caller read any file the container
> process can see — config, secrets, mounted data. Set
> `FILE_URL_ALLOWED_DIRS` to the smallest dataset directory possible and
> prefer `https://` / `s3://` whenever the caller can reach the media
> over the network.

#### Response schema

A synchronous (non-SSE) response looks like:

```json
{
  "id": "<uuid>",
  "created": "<unix-epoch>",
  "model": "cosmos-embed1-448p",
  "media_info": { "type": "offset", "start_offset": 0, "end_offset": 130 },
  "usage": {
    "query_processing_time": 2,
    "total_chunks_processed": 3,
    "prompt_tokens": null,
    "completion_tokens": null,
    "total_tokens": null
  },
  "chunk_responses": [
    { "start_time": "0", "end_time": "60",  "embeddings": ["<float>", "<float>", "..."] },
    { "start_time": "50", "end_time": "110", "embeddings": ["<float>", "<float>", "..."] }
  ]
}
```

Field notes that commonly trip up clients:

- The per-chunk field is `embeddings` (plural), not `embedding`. Each is a 768-dim `float32` array for `cosmos-embed1-448p`.
- `chunk_responses[].start_time` and `end_time` are **strings** (seconds), not numbers — cast before doing math.
- `media_info.start_offset` / `end_offset` are integer seconds and describe the whole request, not a chunk.
- `usage.prompt_tokens`, `completion_tokens`, and `total_tokens` are always `null` for embedding requests; only `query_processing_time` (seconds) and `total_chunks_processed` are populated.
- SSE mode emits one chunk per `data:` event with the same per-chunk shape and terminates with `data: [DONE]`.

### Stream video embeddings via SSE

```bash
curl -N -X POST "$BASE_URL/v1/generate_video_embeddings" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d "{
    \"id\": \"$FILE_ID\",
    \"model\": \"cosmos-embed1-448p\",
    \"chunk_duration\": 30,
    \"stream\": true,
    \"stream_options\": {\"include_usage\": true}
  }"
```

The stream is terminated by `data: [DONE]`.

### Generate a text embedding

```bash
curl -fsS -X POST "$BASE_URL/v1/generate_text_embeddings" \
  -H "Content-Type: application/json" \
  -d '{
    "text_input": "a forklift moving pallets",
    "model": "cosmos-embed1-448p"
  }'
```

#### Response schema

```json
{
  "id": "<uuid>",
  "created": "<unix-epoch>",
  "model": "cosmos-embed1-448p",
  "data": [
    { "text_input": "a forklift moving pallets", "embeddings": ["<float>", "<float>", "..."] }
  ]
}
```

Unlike the video endpoint, text embeddings come back under a top-level `data` array. Each element echoes its `text_input` and carries the 768-dim `embeddings` vector — same vector space as the video chunks, so they can be compared directly.

### Register, embed, and stop a live RTSP stream

```bash
# Add the stream.
STREAM_ID=$(curl -fsS -X POST "$BASE_URL/v1/streams/add" \
  -H "Content-Type: application/json" \
  -d '{
    "streams": [{
      "liveStreamUrl": "rtsp://host:port/live/video",
      "description": "camera-001"
    }]
  }' | jq -r '.results[0].id')

# Start embedding. Live streams REQUIRE `stream: true` and `chunk_duration > 0`.
curl -N -X POST "$BASE_URL/v1/generate_video_embeddings" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d "{
    \"id\": \"$STREAM_ID\",
    \"model\": \"cosmos-embed1-448p\",
    \"stream\": true,
    \"chunk_duration\": 10,
    \"chunk_overlap_duration\": 2
  }"

# Stop embedding (keep the stream registered).
curl -fsS -X DELETE "$BASE_URL/v1/generate_video_embeddings/$STREAM_ID"

# Remove the stream entirely.
curl -fsS -X DELETE "$BASE_URL/v1/streams/delete/$STREAM_ID"
```

#### Live-stream request constraints

- **SSE only.** Synchronous mode returns `400 BadParameters: "Only streaming output is supported for live-streams"`. Always send `stream: true` with `Accept: text/event-stream` for any `id` that resolves to a live stream.
- **`chunk_duration` is required and must be > 0.** Live streams registered via `POST /v1/streams/add` come back with `chunk_duration: 0` and `chunk_overlap_duration: 0` — those defaults are placeholders, not usable values. Pass `chunk_duration` (and optionally `chunk_overlap_duration`) on the `generate_video_embeddings` request, or you'll get `400 BadParameter: "chunk_duration must be greater than 0"`.
- **Chunk cadence.** With `chunk_duration: 10`, expect one `data:` event roughly every 10 seconds of wall clock, interleaved with `: ping` keepalive comments (~once per second) to hold the connection open. The stream terminates with `data: [DONE]` when you `DELETE /v1/generate_video_embeddings/{stream_id}`.

#### Live-stream response schema

Per-chunk SSE events use the same envelope as the file-mode response, but **timestamps replace offsets** — the service emits wall-clock ISO-8601 strings rather than seconds-into-file:

```json
{
  "id": "<uuid>",
  "created": "<unix-epoch>",
  "model": "cosmos-embed1-448p",
  "media_info": {
    "type": "timestamp",
    "start_timestamp": "<ISO-8601-UTC>",
    "end_timestamp":   "<ISO-8601-UTC>"
  },
  "chunk_responses": [
    {
      "start_time": "<ISO-8601-UTC>",
      "end_time":   "<ISO-8601-UTC>",
      "embeddings": ["<float>", "<float>", "..."]
    }
  ]
}
```

Differences from file mode (see the response schema under [Embed by URL](#embed-by-url-no-upload)):

| Field | File mode | Live-stream mode |
|---|---|---|
| `media_info.type` | `"offset"` | `"timestamp"` |
| `media_info` bounds | `start_offset` / `end_offset` (integer seconds) | `start_timestamp` / `end_timestamp` (ISO-8601 UTC strings) |
| `chunk_responses[].start_time` / `end_time` | strings of seconds, e.g. `"0.0"`, `"60.0"` | ISO-8601 UTC strings |
| Delivery | one JSON body (or SSE if `stream: true`) | SSE only, one event per chunk |
| Terminator | response close | `data: [DONE]` after `DELETE` |

Parse `start_time` / `end_time` based on `media_info.type` — don't assume one or the other.

### Single-stream control plane

`POST /v1/stream/add` accepts a `key`/`value` envelope. When `value` includes a `model`, embedding starts automatically.

```bash
curl -fsS -X POST "$BASE_URL/v1/stream/add" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "sensor",
    "value": {
      "camera_id": "camera-001",
      "camera_url": "rtsp://host:port/live/video",
      "change": "camera_add"
    }
  }'
```

### List models, version, manifest

```bash
curl -fsS "$BASE_URL/v1/models"
curl -fsS "$BASE_URL/v1/version"
curl -fsS "$BASE_URL/v1/manifest"
```

### Health and metrics

```bash
curl -fsS "$BASE_URL/v1/ready"
curl -fsS "$BASE_URL/v1/ready?detailed=true"
curl -fsS "$BASE_URL/v1/live"
curl -fsS "$BASE_URL/v1/startup"
curl -fsS "$BASE_URL/v1/assets/stats"
curl -fsS "$BASE_URL/v1/metrics"
```

## Common Errors

| HTTP status | Meaning | Typical fix |
|---|---|---|
| `400` | Bad Request — malformed JSON, invalid IDs, or unsupported URL scheme. | Validate the request body, the `id` UUID, and that `url` uses a supported scheme. |
| `401` | Unauthorized — Bearer token missing or rejected. | Provide a valid `Authorization: Bearer <token>` header if the deployment enforces auth. |
| `409` | File is in use and cannot be deleted (on `DELETE /v1/files/{file_id}`). | Stop or finish any embedding request that references the file before deleting. |
| `422` | Request failed semantic validation. | Inspect the response `message` for the failing field. |
| `429` | Rate limiting exceeded. | Back off and retry with exponential delay. |
| `500` | Internal server error. | Check `docker compose -f rtvi-embed-docker-compose.yml logs -f rtvi-embed`. |
| `503` | Service is busy or unhealthy. | For `/v1/ready`, wait for the service to finish warming up. For embedding endpoints, retry after a short delay. |
