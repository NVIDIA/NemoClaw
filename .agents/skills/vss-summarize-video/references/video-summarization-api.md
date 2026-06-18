# Video Summarization API Reference

This reference documents the 3.2.0 GA video summarization API surface used by
`vss-summarize-video`. The OpenAPI source is
`long-video-summarization/api_spec/openapi.json`.

Use `/v1/summarize` for new file-summarization examples. `/summarize` is still
present with the same request and response schema as a compatibility route.

## Setup

The OpenAPI spec declares a relative server URL (`/`), so `BASE_URL` is
deployment-specific. For the VSS developer `lvs` profile, the default external
URL is:

```bash
export BASE_URL="${LVS_BACKEND_URL:-http://localhost:38111}"
```

The OpenAPI declares bearer auth globally, but local VSS developer deployments
usually expose these endpoints without an auth header. If the deployment
requires auth, add:

```bash
-H "Authorization: Bearer $API_KEY"
```

to each `curl` call.

## Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/ready` | GET | Readiness probe. HTTP 200 means ready; HTTP 503 means warming or dependency unavailable. |
| `/v1/live` | GET | Liveness probe. |
| `/v1/startup` | GET | Startup probe. |
| `/v1/healthz` | GET | VIA service health status. |
| `/v1/metadata` | GET | Service metadata. |
| `/models` | GET | List models available to the video summarization service. |
| `/recommended_config` | POST | Recommend chunking parameters. |
| `/metrics` | GET | Prometheus metrics. |
| `/v1/summarize` | POST | Summarize a video file. Canonical 3.2 route. |
| `/summarize` | POST | Compatibility route with the same schema as `/v1/summarize`. |
| `/v1/generate_captions` | POST | Start RTVI stream captioning for a stream id. |
| `/v1/stream_summarize` | POST | Summarize an already-captioned stream from database captions. |

## Health And Metadata

Readiness checks should use the HTTP status only. Do not parse the body; it can
be empty on success.

```bash
curl -sf --max-time 15 "$BASE_URL/v1/ready" >/dev/null
curl -sf --max-time 15 "$BASE_URL/v1/live" >/dev/null
curl -sf --max-time 15 "$BASE_URL/v1/startup" >/dev/null
curl -sf --max-time 15 "$BASE_URL/v1/healthz" >/dev/null
curl -sf --max-time 15 "$BASE_URL/v1/metadata" | jq .
```

## Models

Always use a model id that the serving endpoint advertises. In the VSS `lvs`
profile, `${VLM_NAME}` must match RT-VLM's `/v1/models` response.

```bash
curl -sf "$BASE_URL/models" | jq '.data[] | {id, object, owned_by, api_type}'
```

## File Summarization

`POST /v1/summarize` and `POST /summarize` both use `SummarizationQuery`.
The OpenAPI schema requires `model`, `scenario`, and `events` on every request;
omitting `scenario` (or any other required key) returns HTTP 422.

Required fields:

| Field | Type | Notes |
|---|---|---|
| `model` | string | Required. Must match an available model id. |
| `scenario` | string | Required. User-provided use-case context. |
| `events` | array[string] | Required. User-provided event names to detect or summarize. |

Source fields:

| Field | Type | Notes |
|---|---|---|
| `url` | string or null | HTTP(S) or S3 video URL. |
| `id` | UUID, array[UUID], or null | File or live stream ids known to the video summarization service. |
| `media_info` | object | Offset or timestamp segment selector. |

Common optional fields:

| Field | Notes |
|---|---|
| `prompt`, `system_prompt` | Prompt overrides. |
| `chunk_duration`, `chunk_overlap_duration`, `summary_duration` | Chunking and live-stream summary cadence. |
| `num_frames_per_second_or_fixed_frames_chunk`, `use_fps_for_chunking` | Preferred 3.2 frame sampling controls. |
| `num_frames_per_chunk` | Deprecated compatibility field; avoid in new examples. |
| `enable_audio`, `enable_reasoning` | Optional audio and reasoning controls. |
| `vlm_input_width`, `vlm_input_height` | VLM input dimensions. |
| `schema`, `batch_response_method`, `auto_generate_prompt`, `override_vlm_prompt`, `enable_vlm_structured_output` | Structured output controls. |
| `objects_of_interest`, `alert_category`, `creation_time`, `mm_processor_kwargs` | Extraction and model-processing context. |
| `temperature`, `top_p`, `top_k`, `max_tokens`, `min_tokens`, `ignore_eos`, `seed` | Generation controls. |

Most request schemas set `additionalProperties: false`; do not invent fields
that are absent from the OpenAPI schema.

Basic request:

```bash
curl -s -X POST "$BASE_URL/v1/summarize" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg model "${VLM_NAME:-nim_nvidia_cosmos-reason2-8b_hf-1208}" \
    --arg url "https://www.example.com/video.mp4" \
    --arg scenario "warehouse monitoring" \
    --argjson events '["boxes falling","forklift stuck"]' \
    '{
      model: $model,
      url: $url,
      scenario: $scenario,
      events: $events,
      chunk_duration: 10,
      num_frames_per_second_or_fixed_frames_chunk: 20,
      use_fps_for_chunking: false,
      seed: 1
    }')"
```

Response shape: `CompletionResponse` with top-level fields such as `id`,
`video_id`, `choices`, `created`, `model`, `media_info`, `object`, and `usage`.
For the VSS summarization workflow, the actual summary payload is a JSON string
inside `choices[0].message.content`.

```bash
curl -s -X POST "$BASE_URL/v1/summarize" \
  -H "Content-Type: application/json" \
  -d @request.json \
  | jq -r '.choices[0].message.content' \
  | jq '{video_summary, events}'
```

## Stream Captioning And Stream Summarization

For streams, the OpenAPI directs callers to start captioning first, then
summarize the stored captions.

Start captioning:

```bash
curl -s -X POST "$BASE_URL/v1/generate_captions" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg id "<stream_uuid>" \
    --arg model "${VLM_NAME:-nim_nvidia_cosmos-reason2-8b_hf-1208}" \
    --arg scenario "traffic monitoring" \
    --argjson events '["accident","pedestrian crossing"]' \
    '{
      id: $id,
      model: $model,
      scenario: $scenario,
      events: $events,
      chunk_duration: 10,
      num_frames_per_second_or_fixed_frames_chunk: 20,
      use_fps_for_chunking: false
    }')"
```

The response has `id`, `status`, and `model`.

Summarize existing stream captions:

```bash
curl -s -X POST "$BASE_URL/v1/stream_summarize" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg id "<stream_uuid>" \
    --arg model "${VLM_NAME:-nim_nvidia_cosmos-reason2-8b_hf-1208}" \
    '{
      id: $id,
      model: $model,
      start_time: 0,
      end_time: 0,
      enable_vlm_structured_output: true
    }')"
```

`/v1/stream_summarize` uses `StreamSummarizeRequest`; `id` and `model` are
required.

## Recommended Config

```bash
curl -s -X POST "$BASE_URL/recommended_config" \
  -H "Content-Type: application/json" \
  -d '{
    "video_length": 300,
    "target_response_time": 60,
    "usecase_event_duration": 5
  }' | jq .
```

The response includes `text` and may include `chunk_size`.

## Metrics

```bash
curl -sf "$BASE_URL/metrics" | head
```

## Errors And Gotchas

- `400` means invalid syntax or malformed request.
- `401` means auth was required but missing or invalid.
- `422` usually means a schema validation failure. Check for missing required
  keys (`model`, `scenario`, `events` on `/v1/summarize`) or extra fields.
- `429` means rate limiting.
- `503` from readiness means warming or dependencies unavailable.
- `503` from summarize means the service is busy processing another file.
- Treat the OpenAPI as authoritative for GA fields. Some internal sanity
  scripts exercise non-spec streaming flags on `/v1/summarize`; do not teach
  those as public GA fields unless the OpenAPI is updated.
