# Deployment Reference: Video Embedding (RT-Embed)

## Container Image

- **Image name** — `nvcr.io/nvidia/vss-core/vss-rt-embed`. The Compose service uses `${RTVI_EMBED_IMAGE}` and `${RTVI_EMBED_TAG}` so the image and tag are overridable per environment.
- **Tag** — published VSS release tag (Compose default: `3.2.0`). Override `RTVI_EMBED_TAG` only when pinning a different published build.
- **Registry** — `nvcr.io`. Pulls require an authenticated session with NGC.
- **NGC pull requirements** — `docker login nvcr.io` with `$oauthtoken` and a valid `NGC_API_KEY`. The same `NGC_API_KEY` must also be present in the container environment for model and asset access.
- **Architecture support** — x86_64. The image is built for `linux/amd64`; aarch64 variants are not specified in the Compose service.

## GPU Requirements

- **GPU required?** — Yes. The service runs Triton-backed inference for the Cosmos-Embed1 model and reserves an NVIDIA device via Compose `deploy.resources.reservations.devices`.
- **Minimum VRAM** — Not specified in the Compose service; size by workload. The Cosmos-Embed1-448p model and Triton runtime should be sized for the expected concurrent video chunk batch.
- **Supported GPU architectures** — Not specified in the Compose service; size by workload. Use a CUDA-capable NVIDIA datacenter or workstation GPU compatible with the included Triton/TensorRT stack.
- **GPU count per instance** — 1 by default. The service reads `RT_EMBED_DEVICE_ID` (default `0`) to pin to a specific GPU, and `RTVI_EMBED_NUM_GPUS` to scale within the container.
- **Can share GPU with other services?** — Yes for development and shared-GPU layouts; size VRAM accordingly. The service pins to a single device id, so co-locating with other RT-* services is supported when VRAM headroom allows.
- **Compose snippet for device reservation**:

```yaml
deploy:
  resources:
    reservations:
      devices:
        - capabilities: [gpu]
          driver: nvidia
          device_ids:
            - "${RT_EMBED_DEVICE_ID:-0}"
```

## CPU & Memory

- **Minimum CPU cores** — Not specified in the Compose service; size by workload.
- **Minimum RAM** — Not specified in the Compose service; size by workload. The service uses `ipc: host` and large memlock/stack ulimits, so plan for a multi-GB working set.
- **`shm_size`** — Default. The service uses `ipc: host` instead of a dedicated `shm_size`.
- **`ulimits`** —
  - `memlock`: soft `-1`, hard `-1` (unlimited).
  - `nofile`: soft `65535`, hard `65535`.
  - `stack`: `67108864` (64 MiB).

## Storage

| Mount Path | Purpose | Type | Size estimate | Required permissions |
|---|---|---|---|---|
| `/opt/nvidia/rtvi/.rtvi/ngc_model_cache` | NGC model cache for `Cosmos-Embed1-448p` weights and Triton repo artifacts. | Named volume (`rtvi-ngc-model-cache`) or bind via `NGC_MODEL_CACHE`. | Multi-GB; sized by model weights and Triton repo. | Writable by container UID/GID `1001:1001`. |
| `/tmp/huggingface` | Hugging Face cache used during model download from `MODEL_PATH`. | Named volume (`rtvi-hf-cache`) or bind via `RTVI_EMBED_HF_CACHE`. | Multi-GB; sized by HF assets. | Writable by container UID/GID `1001:1001`. |
| `/tmp/triton_model_repo` | Generated Triton model repository for the configured embedding model. | Named volume (`rtvi-triton-model-repo`). | Multi-GB. | Writable by container UID/GID `1001:1001`. |
| `/tmp/assets` | Optional asset storage when `ASSET_STORAGE_DIR` is set. | Bind mount (gated by `${ASSET_STORAGE_DIR:+...}`). | Sized by uploaded media volume. | Writable by container UID/GID `1001:1001`. |
| `/opt/nvidia/rtvi/log/rtvi/` | Optional host-side log directory when `RTVI_EMBED_LOG_DIR` is set. | Bind mount (gated by `${RTVI_EMBED_LOG_DIR:+...}`). | Grows with log retention. | Writable by container UID/GID `1001:1001`. |
| Container clip-storage reader mount | Shared clip storage written by upstream VST so the embedding service can read locally recorded clips. | Bind mount from `${VSS_DATA_DIR}/data_log/vst/clip_storage` to the target path in `rtvi-embed-docker-compose.yml`. | Sized by clip retention. | Readable by container UID/GID `1001:1001`. |

The named volumes `rtvi-hf-cache`, `rtvi-ngc-model-cache`, and `rtvi-triton-model-repo` survive `docker compose down`. They are destroyed by `docker compose down -v`, which forces a full model re-download and Triton repo rebuild on the next start.

## Startup Behavior

- **Expected startup time** — Long on first boot. The Compose healthcheck sets `start_period: 1200s`, which reflects the time required to download the Cosmos-Embed1 model, build the Triton model repository, and warm up GPU inference. Warm-cache restarts are substantially faster because the model and Triton repo are persisted in named volumes.
- **Startup ordering dependencies** — None declared in this Compose service. Configure peer services (Redis, Kafka brokers) to be reachable when their flags are enabled; the service does not block on them at startup.
- **Health check endpoint** — `GET /v1/ready` on container port `8000`. A 200 response indicates the service is ready to accept embedding requests.
- **Health check tuning** — From Compose: `interval: 30s`, `timeout: 10s`, `retries: 3`, `start_period: 1200s`. Do not shorten `start_period` below 20 minutes for first-boot deployments or the container will be marked unhealthy while still warming up.
- **Log signatures of healthy startup** — The container logs Triton model repository creation, model load progress, and a final readiness line once `/v1/ready` returns 200. Treat a steady stream of "ready" health probes (`200 OK` on `/v1/ready`) as the canonical healthy signal.

## Known Deployment Issues

| Symptom | Root cause | Fix |
|---|---|---|
| Container is marked unhealthy within the first 20 minutes. | Health check `start_period` was shortened below the model warmup time. | Restore `start_period: 1200s` or longer for first boots; keep model and Triton volumes warm to shorten subsequent boots. |
| `docker compose up` errors that `RTVI_EMBED_PORT` is required. | The `ports:` mapping uses `${RTVI_EMBED_PORT?}`, which fails fast when unset. | Set `RTVI_EMBED_PORT` in the environment or `.env` file before bringing the service up. |
| Model download fails with HTTP 429 against Hugging Face. | Anonymous Hugging Face downloads are being rate-limited while pulling `nvidia/Cosmos-Embed1-448p`. | Set `HF_TOKEN` to a valid Hugging Face token to lift the rate limit, or pre-populate the `rtvi-hf-cache` volume so first boot does not need to re-fetch the weights. |
| Model download fails with HTTP 401/403 against NGC. | `NGC_API_KEY` is missing or invalid. | Provide a valid `NGC_API_KEY` and confirm `docker login nvcr.io` succeeded on the host. |
| Service starts but `/v1/ready` keeps returning 503. | A peer such as Redis or Kafka was enabled but is not reachable. | Either disable the feature on the host (`ENABLE_REDIS_ERROR_MESSAGES=false`, `RTVI_EMBED_KAFKA_ENABLED=false` — the latter maps to the container's `KAFKA_ENABLED`) or fix peer reachability (`REDIS_HOST`, `HOST_IP`/`KAFKA_BOOTSTRAP_SERVERS`). |
| Process exits with permission errors on `/opt/nvidia/rtvi/.rtvi/ngc_model_cache` or `/tmp/huggingface`. | Host-side bind mount is not writable by UID/GID `1001:1001`. | Run `sudo -n chown -R 1001:1001 <host-path>` or ask the host owner to run the same command; do not use `chmod 777`. Named volumes avoid this issue. |
| GPU not visible inside the container. | NVIDIA Container Toolkit not installed or driver too old. | Install/upgrade NVIDIA Container Toolkit and matching driver, then re-pull the image and restart the service. |

## Prerequisites

- NVIDIA driver compatible with the CUDA stack shipped in the image.
- Docker Engine and Docker Compose plugin recent enough to support the conditional `${VAR:+...}` bind-mount syntax used by the optional `ASSET_STORAGE_DIR` and `RTVI_EMBED_LOG_DIR` mounts.
- NVIDIA Container Toolkit configured as the default container runtime.
- API keys exposed to the runtime: `NGC_API_KEY` (required), `NVIDIA_API_KEY` (defaults to a sentinel; set to a real key if your downstream calls require it), and optionally `HF_TOKEN` to avoid Hugging Face 429 rate-limit errors during the Cosmos-Embed1 weights download.
- Host environment variables: `RTVI_EMBED_PORT`, `VSS_DATA_DIR`, and `HOST_IP` (used to construct `KAFKA_BOOTSTRAP_SERVERS`).
- Disk space sufficient for the Hugging Face cache, NGC model cache, and Triton model repository volumes.
- Network reachability to `nvcr.io`, `huggingface.co`, and any peer services (Redis, Kafka) that are enabled.

## Dry Run

```bash
docker compose -f rtvi-embed-docker-compose.yml --profile bp_developer_search_2d config --quiet
docker compose -f rtvi-embed-docker-compose.yml --profile bp_developer_search_2d up --no-start
```

## Verify Deployment

After `docker compose up -d`, confirm the service is healthy:

```bash
# Wait for readiness (allow up to 20 minutes on first boot).
curl -fsS "http://localhost:${RTVI_EMBED_PORT}/v1/ready"

# Detailed component status.
curl -fsS "http://localhost:${RTVI_EMBED_PORT}/v1/ready?detailed=true"

# Confirm the embedding model is registered.
curl -fsS "http://localhost:${RTVI_EMBED_PORT}/v1/models"
```

## Logs & Status

```bash
docker compose -f rtvi-embed-docker-compose.yml ps
docker compose -f rtvi-embed-docker-compose.yml logs -f rtvi-embed
docker stats vss-rtvi-embed
```

For container-internal logs, check `/opt/nvidia/rtvi/log/rtvi/` when `RTVI_EMBED_LOG_DIR` is bound to a host directory.

## Upgrade & Rollback

1. Update `RTVI_EMBED_IMAGE` and `RTVI_EMBED_TAG` to the target build.
2. Pull the new image: `docker compose -f rtvi-embed-docker-compose.yml pull rtvi-embed`.
3. Recreate the service: `docker compose -f rtvi-embed-docker-compose.yml --profile bp_developer_search_2d up -d rtvi-embed`.
4. Watch `/v1/ready` until it returns 200; keep the named caches warm to avoid a full re-download.
5. Roll back by re-pinning `RTVI_EMBED_TAG` to the previous build and repeating the pull and recreate steps. Named volumes persist across the swap, so the previous model cache and Triton repo are reused on rollback.

## Tear Down

```bash
docker compose -f rtvi-embed-docker-compose.yml down
# WARNING: also destroys rtvi-hf-cache, rtvi-ngc-model-cache, and rtvi-triton-model-repo,
# which forces a full model re-download and Triton repo rebuild on the next start.
docker compose -f rtvi-embed-docker-compose.yml down -v
```

## Gotchas & Known Issues

- The Compose service runs as non-root (`user: "1001:1001"`). Any host-side bind mount must be writable by that UID/GID, or the container will exit on startup.
- `KAFKA_BOOTSTRAP_SERVERS` is constructed from `${HOST_IP}:9092`. If `HOST_IP` is unset or resolves incorrectly inside the container, Kafka integration will silently fail; double-check it when Kafka is enabled.
- The conditional volume entries (`${ASSET_STORAGE_DIR:+...}` and `${RTVI_EMBED_LOG_DIR:+...}`) require a Docker Compose version that supports the `${VAR:+value}` substitution. Older Compose plugins will fail to parse the file.
- The healthcheck command is `curl -f http://localhost:8000/v1/ready` and assumes `curl` is present in the image, which it is. Do not strip `curl` when building derived images or the healthcheck will always fail.
