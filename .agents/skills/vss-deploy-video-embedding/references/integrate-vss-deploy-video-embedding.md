# Integration Reference: Video Embedding (RT-Embed)

## Overview

The Video Embedding microservice (legacy name: RT-Embed) generates dense vector embeddings for video files, individual frames, and live RTSP streams using the Cosmos-Embed1 model served on Triton. It also produces text embeddings in the same vector space so that text queries can be compared against video embeddings for downstream search and retrieval workflows. Include this service whenever a VSS deployment needs video embeddings for clip-level indexing, frame-level similarity, text-to-video search, or for feeding a video-RAG or analytics pipeline.

## Required Peer Services

- **Hugging Face / NGC reachability** — Required at first boot to download `nvidia/Cosmos-Embed1-448p` and any NGC assets. After the model is cached in the persistent volumes, restarts do not need outbound access.
- **Redis** — Optional. Only required when error-message publishing is enabled (`ENABLE_REDIS_ERROR_MESSAGES=true`). Configure via `REDIS_HOST`, `REDIS_PORT`, `REDIS_DB`, and `REDIS_PASSWORD`.
- **Apache Kafka** — Optional. Only required when `RTVI_EMBED_KAFKA_ENABLED=true` is set on the host (Compose injects this as `KAFKA_ENABLED` inside the container). The service publishes embedding messages to the topic named by `RTVI_EMBED_KAFKA_TOPIC` (injected as `KAFKA_TOPIC`; default `vision-embed-messages`) and errors to `RTVI_EMBED_ERROR_MESSAGE_TOPIC` (injected as `ERROR_MESSAGE_TOPIC`; default `vision-embed-errors`) using `KAFKA_BOOTSTRAP_SERVERS` (Compose builds this from `${HOST_IP}:9092`).
- **OpenTelemetry collector** — Optional. Only required when `RTVI_EMBED_ENABLE_OTEL_MONITORING=true` is set on the host (Compose injects this as `ENABLE_OTEL_MONITORING` inside the container). The service exports OTLP traces and metrics to `OTEL_EXPORTER_OTLP_ENDPOINT` (default `http://otel-collector:4318`).
- **Upstream video source (VST or compatible clip writer)** — Optional. When you want to embed clips written by VST, bind `${VSS_DATA_DIR}/data_log/vst/clip_storage` to the container clip-storage reader mount declared in `rtvi-embed-docker-compose.yml` so the service can read clip files locally.

## Integration Interfaces

### Inputs

- **Method** — REST API on container port `8000`.
- **Address / topic / endpoint** —
  - `POST /v1/files` to upload media (multipart/form-data).
  - `POST /v1/generate_video_embeddings` to embed an uploaded file, an external URL, or a live-stream id.
  - `POST /v1/generate_text_embeddings` to embed a text string in the same vector space.
  - `POST /v1/streams/add`, `POST /v1/stream/add`, `DELETE /v1/streams/delete/{stream_id}`, and `DELETE /v1/generate_video_embeddings/{stream_id}` to register, list, and stop live RTSP streams.
- **Expected schema** — See the API Schema section. Live-stream inputs accept RTSP URLs and metadata such as `liveStreamUrl` and `description`; video embedding requests accept an `id` plus a `model` and optional URL, chunking, and streaming options.
- **Authentication** — The OpenAPI spec annotates endpoints with a Bearer token security scheme. In typical local-Compose deployments the service is reached on the loopback interface and Bearer auth is not enforced by the Compose configuration; treat the service as deployment-gated and add a Bearer token at the caller boundary if you expose it to other hosts.

### Outputs

- **Method** — REST responses for synchronous requests; optional Server-Sent Events (SSE) when `stream: true` is set on `POST /v1/generate_video_embeddings`.
- **Topic / endpoint / path** —
  - Embedding responses on `POST /v1/generate_video_embeddings` and `POST /v1/generate_text_embeddings` (synchronous or SSE).
  - Prometheus metrics on `GET /v1/metrics`.
  - Optional Kafka topic set via `RTVI_EMBED_KAFKA_TOPIC` on the host (injected as `KAFKA_TOPIC`; default `vision-embed-messages`) for embedding events when `RTVI_EMBED_KAFKA_ENABLED=true` on the host.
  - Optional Kafka topic set via `RTVI_EMBED_ERROR_MESSAGE_TOPIC` on the host (injected as `ERROR_MESSAGE_TOPIC`; default `vision-embed-errors`) for error events when `RTVI_EMBED_KAFKA_ENABLED=true` on the host.
- **Schema** — Successful video embedding responses include `id`, `created`, `model`, `media_info`, `usage`, and `chunk_responses`. Text embedding responses include `id`, `created`, `model`, and `data`. See the API Schema section for the full list of endpoints.
- **Frequency / trigger** — Per request for synchronous calls; per chunk when streaming (`chunk_duration`, `chunk_overlap_duration` control chunking).

## API Schema

The service exposes a v1 REST API. Set `BASE_URL=http://<host>:${RTVI_EMBED_PORT}` for callers. Endpoint groups:

- **Embeddings** — `POST /v1/generate_text_embeddings`, `POST /v1/generate_video_embeddings`, `DELETE /v1/generate_video_embeddings/{stream_id}` (stop live-stream embedding).
- **Files** — `GET /v1/files?purpose=...`, `POST /v1/files`, `GET /v1/files/{file_id}`, `DELETE /v1/files/{file_id}`, `GET /v1/files/{file_id}/content`.
- **Live Stream** — `POST /v1/streams/add`, `GET /v1/streams/get-stream-info`, `DELETE /v1/streams/delete/{stream_id}`, `DELETE /v1/streams/delete-batch`.
- **Stream** — `POST /v1/stream/add`, `POST /v1/stream/remove`, `GET /v1/stream/get-stream-info`.
- **Models** — `GET /v1/models`.
- **Health Check** — `GET /v1/ready`, `GET /v1/live`, `GET /v1/startup`, `GET /v1/assets/stats`.
- **Metadata / NIM-compatible** — `GET /v1/metadata`, `GET /v1/version`, `GET /v1/license`, `GET /v1/manifest`.
- **Metrics** — `GET /v1/metrics` (Prometheus text format).

Example: embed an uploaded video. See [Upload a file and embed it](rest-api.md#upload-a-file-and-embed-it) in `rest-api.md` for the canonical upload-and-embed `curl` sequence.

Example: embed a text query.

```bash
curl -fsS -X POST "$BASE_URL/v1/generate_text_embeddings" \
  -H "Content-Type: application/json" \
  -d '{"text_input": "a forklift moving pallets", "model": "cosmos-embed1-448p"}'
```

Example: register and embed a live RTSP stream. Live-stream requests **require** `stream: true` and `chunk_duration > 0`; a synchronous call returns `400 BadParameters: "Only streaming output is supported for live-streams"` and an unset/zero `chunk_duration` returns `400 BadParameter: "chunk_duration must be greater than 0"`. Send `Accept: text/event-stream` and use `curl -N` so SSE events stream immediately. See [Register, embed, and stop a live RTSP stream](rest-api.md#register-embed-and-stop-a-live-rtsp-stream) in `rest-api.md` for the canonical add / SSE / stop sequence.

## Environment Variables

| Variable | Purpose | Default | Required? |
|---|---|---|---|
| `RTVI_EMBED_PORT` | Host port mapped to container `8000`. | (unset; `${RTVI_EMBED_PORT?}` fails fast) | Yes |
| `RTVI_EMBED_IMAGE` | Container image. | `nvcr.io/nvidia/vss-core/vss-rt-embed` | No |
| `RTVI_EMBED_TAG` | Container image tag. | `3.2.0` | No |
| `RT_EMBED_DEVICE_ID` | GPU device id used by the Compose `device_ids` reservation. | `0` | No |
| `RTVI_EMBED_NVIDIA_VISIBLE_DEVICES` | Maps to `NVIDIA_VISIBLE_DEVICES` inside the container. | `all` | No |
| `RTVI_EMBED_NUM_GPUS` | Sets `NUM_GPUS` inside the container. | (unset) | No |
| `RTVI_EMBED_NUM_VLM_PROCS` | Sets `NUM_VLM_PROCS` inside the container. | (unset) | No |
| `VLM_BATCH_SIZE` | Inference batch size. | (unset) | No |
| `MODEL_PATH` | Model source URI used at first boot. | `git:https://huggingface.co/nvidia/Cosmos-Embed1-448p` | No |
| `MODEL_IMPLEMENTATION_PATH` | In-container path to the model implementation. | `/opt/nvidia/rtvi/rtvi/models/custom/samples/cosmos-embed1` | No |
| `MODEL_REPOSITORY_SCRIPT_PATH` | Script that builds the Triton model repository. | `/opt/nvidia/rtvi/rtvi/models/custom/samples/cosmos-embed1/create_triton_model_repo.py` | No |
| `NGC_API_KEY` | NGC API key for asset downloads. | (empty) | Yes for first boot |
| `NVIDIA_API_KEY` | NVIDIA API key for downstream calls. | `NOAPIKEYSET` | Yes if downstream calls require it |
| `HF_TOKEN` | Hugging Face token used during model download. | (empty) | No; recommended to avoid Hugging Face 429 rate limits |
| `INSTALL_PROPRIETARY_CODECS` | Install proprietary codecs at startup. | `false` | No |
| `FORCE_SW_AV1_DECODER` | Force software AV1 decoding. | (unset) | No |
| `RTVI_EMBED_LOG_LEVEL` | Maps to `LOG_LEVEL` inside the container. | `INFO` | No |
| `RTVI_EMBED_RTSP_LATENCY` | Maps to `RTVI_RTSP_LATENCY`. | (unset) | No |
| `RTVI_EMBED_RTSP_TIMEOUT` | Maps to `RTVI_RTSP_TIMEOUT`. | (unset) | No |
| `RTVI_EMBED_RTSP_RECONNECTION_INTERVAL` | Maps to `RTVI_RTSP_RECONNECTION_INTERVAL` (seconds). | `5` | No |
| `RTVI_EMBED_RTSP_RECONNECTION_WINDOW` | Maps to `RTVI_RTSP_RECONNECTION_WINDOW` (seconds). | `60` | No |
| `RTVI_EMBED_RTSP_RECONNECTION_MAX_ATTEMPTS` | Maps to `RTVI_RTSP_RECONNECTION_MAX_ATTEMPTS`. | `10` | No |
| `RTVI_EMBED_ENABLE_OTEL_MONITORING` | Maps to `ENABLE_OTEL_MONITORING`. | `false` | No |
| `RTVI_EMBED_OTEL_RESOURCE_ATTRIBUTES` | Maps to `OTEL_RESOURCE_ATTRIBUTES`. | (unset) | No |
| `RTVI_EMBED_OTEL_TRACES_EXPORTER` | Maps to `OTEL_TRACES_EXPORTER`. | `otlp` | No |
| `RTVI_EMBED_OTEL_EXPORTER_OTLP_ENDPOINT` | Maps to `OTEL_EXPORTER_OTLP_ENDPOINT`. | `http://otel-collector:4318` | No |
| `RTVI_EMBED_OTEL_METRIC_EXPORT_INTERVAL` | Maps to `OTEL_METRIC_EXPORT_INTERVAL` (ms). | `60000` | No |
| `RTVI_EMBED_KAFKA_ENABLED` | Maps to `KAFKA_ENABLED`. | `false` | No |
| `RTVI_EMBED_KAFKA_TOPIC` | Maps to `KAFKA_TOPIC`. | `vision-embed-messages` | No |
| `RTVI_EMBED_ERROR_MESSAGE_TOPIC` | Maps to `ERROR_MESSAGE_TOPIC`. | `vision-embed-errors` | No |
| `HOST_IP` | Used to build `KAFKA_BOOTSTRAP_SERVERS` as `${HOST_IP}:9092`. | (unset) | Yes when Kafka is enabled |
| `ENABLE_REDIS_ERROR_MESSAGES` | Publish error messages to Redis. | `false` | No |
| `REDIS_HOST` | Redis host. | `redis` | Yes when Redis error messages are enabled |
| `REDIS_PORT` | Redis port. | `6379` | No |
| `REDIS_DB` | Redis database index. | `0` | No |
| `REDIS_PASSWORD` | Redis password. | (empty) | Yes when the Redis instance requires auth |
| `ASSET_DOWNLOAD_TOTAL_TIMEOUT` | Maximum seconds for a URL asset download. | `300` | No |
| `ASSET_DOWNLOAD_CONNECT_TIMEOUT` | Connection timeout (seconds) for asset downloads. | `10` | No |
| `ENABLE_REQUEST_PROFILING` | Per-request profiling. | `false` | No |
| `NGC_MODEL_CACHE` | Optional bind/named volume override for the NGC model cache. | Named volume `rtvi-ngc-model-cache` | No |
| `RTVI_EMBED_HF_CACHE` | Optional bind/named volume override for the Hugging Face cache. | Named volume `rtvi-hf-cache` | No |
| `ASSET_STORAGE_DIR` | Optional host directory bound to `/tmp/assets` inside the container. | (unset; mount is skipped) | No |
| `RTVI_EMBED_LOG_DIR` | Optional host directory bound to `/opt/nvidia/rtvi/log/rtvi/`. | (unset; mount is skipped) | No |
| `VSS_DATA_DIR` | Host root for VSS data; `data_log/vst/clip_storage` under this path is mounted into the container. | (unset) | Yes |
| `RTVI_EMBED_CLIP_STORAGE_CONTAINER_PATH` | Container-side clip reader mount for the VST `clip_storage` bind (matches `rtvi-embed-docker-compose.yml`). | (from shipped compose; see export below) | Yes when binding clip storage |

## Network Requirements

- **Ports exposed** — `${RTVI_EMBED_PORT}:8000/tcp`.
- **Inbound traffic** — REST clients (other VSS microservices or operator tooling) calling the `/v1/*` endpoints.
- **Outbound traffic** — Hugging Face (`huggingface.co`) and NGC (`nvcr.io`) at first boot; optional Redis, Kafka brokers, and OpenTelemetry collector when those integrations are enabled; RTSP sources when live streams are registered.
- **DNS / hostname assumptions** — Uses `${HOST_IP}:9092` for Kafka and defaults `REDIS_HOST=redis`, both of which assume your Compose stack provides those names. The OpenTelemetry collector defaults to the compose-network name `otel-collector`.
- **`network_mode`** — Default bridge (no `network_mode` override in the Compose service).

## Known Integration Constraints

- The Compose service hardcodes `container_name: vss-rtvi-embed`, so only one instance can run per Docker engine without overriding the name.
- The service is profile-gated by `bp_developer_search_2d`; bring it up with `--profile bp_developer_search_2d` or include it in a Compose project that activates that profile.
- `${RTVI_EMBED_PORT?}` is a required-variable substitution; missing the variable fails the `compose config` parse.
- First-boot model download requires reachable Hugging Face/NGC and a valid `NGC_API_KEY`. `HF_TOKEN` is optional but recommended — without it, anonymous Hugging Face pulls of `nvidia/Cosmos-Embed1-448p` can be rate-limited (HTTP 429), which leaves the service running but keeps `/v1/ready` from transitioning to 200.
- The container runs as UID/GID `1001:1001`. Bind-mounted host directories must already be writable by that UID/GID; the service does not chown at startup.
- Kafka and Redis integration flags must match the peer service's reachability — enabling them without a reachable broker will leave `/v1/ready` reporting 503.
- Embedding model defaults to `cosmos-embed1-448p`. Callers must use the model id returned by `GET /v1/models` in their request bodies.

## Example Compose Snippet

Set the container-side clip reader mount before validating or starting this snippet. Run from the VSS repo root so the relative compose path resolves. Read the target from the shipped compose file (same value as in `rtvi-embed-docker-compose.yml`):

```bash
RTVI_EMBED_COMPOSE=deploy/docker/services/rtvi/rtvi-embed/rtvi-embed-docker-compose.yml
export RTVI_EMBED_CLIP_STORAGE_CONTAINER_PATH="$(
  grep 'data_log/vst/clip_storage' "$RTVI_EMBED_COMPOSE" \
    | head -1 \
    | sed -E 's/.*clip_storage:([^[:space:]]+).*/\1/'
)"
[ -z "$RTVI_EMBED_CLIP_STORAGE_CONTAINER_PATH" ] && {
  echo "ERROR: could not extract container clip-storage path from $RTVI_EMBED_COMPOSE" >&2
  return 1 2>/dev/null || exit 1
}
```

```yaml
services:
  rtvi-embed:
    image: ${RTVI_EMBED_IMAGE:-nvcr.io/nvidia/vss-core/vss-rt-embed}:${RTVI_EMBED_TAG:-3.2.0}
    container_name: vss-rtvi-embed
    user: "1001:1001"
    profiles: ["bp_developer_search_2d"]
    deploy:
      resources:
        reservations:
          devices:
            - capabilities: [gpu]
              driver: nvidia
              device_ids:
                - "${RT_EMBED_DEVICE_ID:-0}"
    ports:
      - "${RTVI_EMBED_PORT?}:8000"
    environment:
      MODEL_PATH: "${MODEL_PATH:-git:https://huggingface.co/nvidia/Cosmos-Embed1-448p}"
      NGC_API_KEY: "${NGC_API_KEY:-}"
      HF_TOKEN: "${HF_TOKEN:-}"
      NVIDIA_API_KEY: "${NVIDIA_API_KEY:-NOAPIKEYSET}"
      LOG_LEVEL: "${RTVI_EMBED_LOG_LEVEL:-INFO}"
      KAFKA_ENABLED: "${RTVI_EMBED_KAFKA_ENABLED:-false}"
      KAFKA_BOOTSTRAP_SERVERS: "${HOST_IP}:9092"
      REDIS_HOST: "${REDIS_HOST:-redis}"
      REDIS_PORT: "${REDIS_PORT:-6379}"
    volumes:
      - "${NGC_MODEL_CACHE:-rtvi-ngc-model-cache}:/opt/nvidia/rtvi/.rtvi/ngc_model_cache"
      - "${RTVI_EMBED_HF_CACHE:-rtvi-hf-cache}:/tmp/huggingface"
      - "rtvi-triton-model-repo:/tmp/triton_model_repo"
      - "${VSS_DATA_DIR}/data_log/vst/clip_storage:${RTVI_EMBED_CLIP_STORAGE_CONTAINER_PATH}"
    ipc: host
    ulimits:
      memlock:
        soft: -1
        hard: -1
      stack: 67108864
      nofile:
        soft: 65535
        hard: 65535
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/v1/ready"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 1200s
    restart: unless-stopped

volumes:
  rtvi-hf-cache:
  rtvi-ngc-model-cache:
  rtvi-triton-model-repo:
```

The export above parses the container-side target from the clip_storage volume line in `deploy/docker/services/rtvi/rtvi-embed/rtvi-embed-docker-compose.yml`.

## Authentication & Authorization

The OpenAPI spec annotates endpoints with a Bearer token security scheme. Compose-based local deployments do not enforce Bearer auth on the loopback interface, so for production deployments protect the service through deployment-side controls (reverse proxy, mTLS, allowlists) and inject a Bearer token at the caller boundary when exposing the API beyond localhost.

## Rate Limits & Quotas

The OpenAPI spec includes a 429 response for every endpoint. The service can return 429 under load; clients should implement exponential backoff and respect the response body's `message` field. A 503 response from embedding endpoints indicates the service is busy processing another request; retry after a short delay.

## Test / Smoke Hooks

```bash
BASE_URL="http://localhost:${RTVI_EMBED_PORT}"
curl -fsS "$BASE_URL/v1/ready"
curl -fsS "$BASE_URL/v1/version"
curl -fsS "$BASE_URL/v1/models"
```
