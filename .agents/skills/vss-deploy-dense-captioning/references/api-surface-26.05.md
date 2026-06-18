# RT-VLM 26.05 API Surface Notes

Use the live OpenAPI as the source of truth before running optional endpoints:

```bash
curl -fsS "$BASE_URL/openapi.json" | jq -r '.paths | keys[]' | sort
MODEL_ID="$(curl -fsS "$BASE_URL/v1/models" -H "Authorization: Bearer $API_KEY" | jq -r '.data[0].id // .id')"
```

Use the exact `MODEL_ID` returned by `/v1/models` in request payloads. On local
Cosmos Reason 2 this is usually `nim_nvidia_cosmos-reason2-8b_hf-1208`; backend
selector aliases such as `cosmos-reason1` or `cosmos-reason2` return HTTP 400
unless the live model list exposes those exact ids.

## Caption Response Shape

`POST /v1/generate_captions` returns chunk responses, not OpenAI `choices`.

**SSE (`stream=true`)** emits one `data:` event per chunk with fields such as
`start_time`, `end_time`, and `content`, then terminates with:

```text
data: [DONE]
```

**Non-streaming** returns one JSON object with `chunk_responses`:

```json
{
  "id": "<request_id>",
  "object": "caption",
  "chunk_responses": [
    {"start_time": "0.0", "end_time": "10.0", "content": "..."}
  ],
  "usage": {"total_chunks_processed": 1}
}
```

## File Metadata

`POST /v1/files` may accept optional metadata such as `sensor_name` on newer
builds. Check the live OpenAPI before sending it:

```bash
curl -X POST "$BASE_URL/v1/files" -H "Authorization: Bearer $API_KEY" \
  -F "file=@./warehouse.mp4" \
  -F "purpose=vision" \
  -F "media_type=video" \
  -F "sensor_name=warehouse-camera-01"
```

## CV-Style Stream Endpoints

26.05 deployments also expose CV-style stream control paths:
`POST /v1/stream/add`, `GET /v1/stream/get-stream-info`, and
`POST /v1/stream/remove`. Use these when a workflow or release note explicitly uses
the key/value envelope; otherwise prefer the plural RT-VLM stream endpoints.
During standalone validation, do not treat the CV-style info response as the
source of truth for RT-VLM caption streams: `/v1/stream/add` may return
`status:"added"` while `/v1/stream/get-stream-info` immediately reports
`stream_count:0`. Use plural `/v1/streams/add` and its `results[0].id` for
caption generation and cleanup.

```bash
curl -fsS -X POST "$BASE_URL/v1/stream/add" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{
    "key": "sensor",
    "value": {
      "camera_id": "warehouse-camera-01",
      "camera_url": "rtsp://cam:8554/live",
      "change": "camera_add"
    }
  }'

curl -fsS "$BASE_URL/v1/stream/get-stream-info" -H "Authorization: Bearer $API_KEY" | jq

curl -fsS -X POST "$BASE_URL/v1/stream/remove" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"key":"sensor","value":{"camera_id":"warehouse-camera-01","change":"camera_remove"}}'
```

## Chat Completions

`POST /v1/chat/completions` supports text-only and multimodal requests.

Text-only:

```bash
curl -X POST "$BASE_URL/v1/chat/completions" -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL_ID\",\"messages\":[{\"role\":\"user\",\"content\":\"Summarize this scene.\"}]}"
```

Text-only streaming:

```bash
curl -N -X POST "$BASE_URL/v1/chat/completions" -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL_ID\",\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"List the visible safety risks.\"}]}"
```

Uploaded-video-backed chat:

```bash
curl -X POST "$BASE_URL/v1/chat/completions" -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"$MODEL_ID\",
    \"id\": \"$FILE_ID\",
    \"messages\": [{\"role\":\"user\",\"content\":\"What happens in this video?\"}]
  }"
```

Direct `video_url` chat:

```bash
curl -X POST "$BASE_URL/v1/chat/completions" -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nim_nvidia_cosmos-reason2-8b_hf-1208",
    "messages": [
      {
        "role": "user",
        "content": [
          {"type": "text", "text": "Describe the video with timestamps."},
          {"type": "video_url", "video_url": {"url": "http://host/path/clip.mp4"}}
        ]
      }
    ]
  }'
```

Direct `image_url` chat:

```bash
curl -X POST "$BASE_URL/v1/chat/completions" -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nim_nvidia_cosmos-reason2-8b_hf-1208",
    "messages": [
      {
        "role": "user",
        "content": [
          {"type": "text", "text": "What is visible in this image?"},
          {"type": "image_url", "image_url": {"url": "http://host/path/frame.jpg"}}
        ]
      }
    ]
  }'
```

RTSP/live-stream-backed chat can use an active stream id on builds whose live
OpenAPI exposes `id` for chat requests:

```bash
curl -X POST "$BASE_URL/v1/chat/completions" -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"$MODEL_ID\",
    \"id\": \"$STREAM_ID\",
    \"messages\": [{\"role\":\"user\",\"content\":\"What is happening on this live stream right now?\"}]
  }"
```

## Optional NIM-Compatible Endpoints

- `POST /v1/completions` exists for compatibility, but on current 26.05 builds text-only
  legacy completion requests return HTTP 400 by design. Use
  `/v1/chat/completions` for text-only and multimodal requests.
- Do not assume `/v1/license` exists. The current 26.05 live OpenAPI does not expose
  it and the endpoint returns 404; only call it after checking
  `GET /openapi.json`.
- `GET /v1/assets/stats` reports asset storage counts, TTL, and oldest-asset
  age when exposed by the live OpenAPI.
