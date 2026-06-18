# Troubleshooting: Video Embedding (RT-Embed)

This reference collects the failure modes most often seen when bringing up or operating the Video Embedding service. Pair it with the deployment reference; the items below are operational diagnostics rather than schema-level requirements.

## Startup

| Symptom | What to check | Resolution |
|---|---|---|
| `docker compose up` fails immediately with a complaint about `RTVI_EMBED_PORT`. | The `ports:` mapping uses `${RTVI_EMBED_PORT?}`, which is a required-substitution. | Set `RTVI_EMBED_PORT` in the host environment or in the `.env` file alongside the Compose file. |
| Compose parser fails on the conditional `volumes:` entries. | The compose file uses the `${VAR:+value}` substitution for `ASSET_STORAGE_DIR` and `RTVI_EMBED_LOG_DIR`. | Upgrade the Docker Compose plugin to a version that supports conditional substitution. |
| `docker pull` fails with `Incorrect Repository Format`. | Docker is using containerd snapshotter mode that can fail on some private `nvcr.io` paths. | In `/etc/docker/daemon.json`, set `"features": { "containerd-snapshotter": false }`, then restart Docker: `sudo -n systemctl restart docker` or ask the host owner to run `sudo systemctl restart docker`. |
| `nvidia-container-cli: device error: unknown device`. | Invalid GPU device id selection or NVIDIA runtime/toolkit mismatch. | Verify the selected GPU exists (`nvidia-smi -L`), set a valid device id, then run `sudo -n nvidia-ctk runtime configure --runtime=docker`. If that succeeds, run `sudo -n systemctl restart docker` as a separate step. If either `sudo -n` command reports that a password is required, stop and ask the host owner to run those commands manually. |
| `sudo -n chown` reports that a password is required or fails in an agent session. | Host path ownership requires user privileges and passwordless sudo is unavailable. | Ask the host owner to run `sudo chown -R 1001:1001 "$VSS_DATA_DIR/data_log/vst/clip_storage"` (and any bind-mounted cache paths); do not use `chmod 777`. |
| `sudo -n docker ...` reports that a password is required. | Docker requires elevated privileges, but the agent cannot satisfy an interactive sudo prompt. | Prefer scoped passwordless sudo for Docker (for example `sudo -n docker ...` or `/etc/sudoers.d/` entries limited to specific Docker commands). If passwordless sudo is unavailable, ask the host owner to run the printed Docker command manually. Avoid broad `docker`-group membership in automated/agent environments: membership in the `docker` group is effectively root-equivalent. Do not retry with interactive sudo. |
| `password is empty` on Docker login. | `$NGC_API_KEY` is not set in the invoking shell, or a previous sudo shell dropped the environment. | Export `NGC_API_KEY` in the user shell and pipe it through stdin: `printf '%s' "$NGC_API_KEY" \| docker login nvcr.io -u '$oauthtoken' --password-stdin` (or `sudo -n docker login ...` only when passwordless sudo is configured). |
| Compose reports container-name/project conflicts (`already in use`). | Existing containers from a prior run are still attached to the same Compose project. | Run `docker compose -f rtvi-embed-docker-compose.yml down --remove-orphans`, or set a unique `COMPOSE_PROJECT_NAME` and retry. |
| Container exits during the first 30 seconds with permission errors on `/tmp/huggingface`, `/opt/nvidia/rtvi/.rtvi/ngc_model_cache`, or `/tmp/triton_model_repo`. | The host directories bound to those paths are not writable by UID/GID `1001:1001`. | Run `sudo -n chown -R 1001:1001 <host-path>` or ask the host owner to run the same command; switch back to named volumes (`rtvi-hf-cache`, `rtvi-ngc-model-cache`, `rtvi-triton-model-repo`) which are provisioned with the correct ownership. |
| Startup fails with mount issues on the container clip-storage bind target or shows host path `/data_log/vst/clip_storage`. | `VSS_DATA_DIR` is unset/empty, so `${VSS_DATA_DIR}/data_log/vst/clip_storage` expands to `/data_log/vst/clip_storage`. | Set `VSS_DATA_DIR` to a real writable directory and pre-create `${VSS_DATA_DIR}/data_log/vst/clip_storage` before `docker compose up`. |
| Container is healthy for several minutes, then flips to unhealthy. | Health check `start_period` was shortened below the model warmup. | Restore `start_period: 1200s` (20 minutes) for first boots. Subsequent boots can be reduced once the caches are warm. |
| `/v1/ready` returns 503 indefinitely even after warmup. | A peer service (Redis, Kafka) is enabled but unreachable, or the model failed to download. | Inspect `docker compose -f rtvi-embed-docker-compose.yml logs -f rtvi-embed` for model-download errors or `connection refused` against Redis/Kafka; disable the feature flag or fix the peer. |

## Model And Cache Issues

| Symptom | What to check | Resolution |
|---|---|---|
| Model download stops at 429 from Hugging Face. | Anonymous Hugging Face downloads are being rate-limited while pulling `nvidia/Cosmos-Embed1-448p`. | Set `HF_TOKEN` to a valid Hugging Face token to lift the rate limit. As a fallback, pre-populate `rtvi-hf-cache` (or the host-bound `RTVI_EMBED_HF_CACHE`) so first boot does not refetch the weights. |
| Model download stops at 401/403 from NGC. | `NGC_API_KEY` is empty or invalid; `docker login nvcr.io` was never run on the host. | Set `NGC_API_KEY` to a valid key and ensure the host is logged in to `nvcr.io`. |
| First boot is dramatically faster than expected and `/v1/ready` returns 200 unexpectedly. | A stale or partial Triton model repository in `rtvi-triton-model-repo` was reused. | Stop the service, `docker volume rm rtvi-triton-model-repo`, and bring the service back up to force a clean rebuild. |
| Disk fills up under `/var/lib/docker/volumes/`. | The named caches accumulate model weights and Triton artifacts. | Confirm volume sizes with `docker system df -v`; prune old caches when switching model versions. |

## Runtime

| Symptom | What to check | Resolution |
|---|---|---|
| `POST /v1/generate_video_embeddings` returns 503 with "Server is busy processing another file or text". | The service is already handling a request. | Retry with exponential backoff; consider sharding work across multiple instances if sustained 503 is observed. |
| `POST /v1/generate_video_embeddings` returns 422 with a message about `url`. | The `url` scheme is unsupported, or `file://` is used without `FILE_URL_ALLOWED_DIRS` configured. | Use `http(s)://`, `s3://`, an allowed `file://` path, or a `data:` URI, or upload first via `POST /v1/files`. |
| Embedding requests succeed but downstream consumers see no Kafka messages. | Host `RTVI_EMBED_KAFKA_ENABLED` is unset (Compose substitution `${RTVI_EMBED_KAFKA_ENABLED:-false}` resolves to `false`, so the container's `KAFKA_ENABLED` is `false`), or `HOST_IP` is unset so `KAFKA_BOOTSTRAP_SERVERS` resolves to `:9092`. | Set `RTVI_EMBED_KAFKA_ENABLED=true` on the host (this maps to the container's `KAFKA_ENABLED`) and `HOST_IP` to the broker-reachable host IP. |
| Logs show Kafka bootstrap as `:9092` / DNS failures for Kafka. | `HOST_IP` is missing, so `KAFKA_BOOTSTRAP_SERVERS` is malformed. | For standalone mode keep `RTVI_EMBED_KAFKA_ENABLED=false`; otherwise export a valid `HOST_IP` and verify the broker endpoint resolves/reaches from the container. |
| RTSP streams keep reconnecting. | `RTVI_RTSP_RECONNECTION_INTERVAL`/`WINDOW`/`MAX_ATTEMPTS` are too aggressive for the network. | Tune the reconnection envelope; raise `RTVI_RTSP_TIMEOUT` if the upstream stream has high latency. |
| GPU disappears from `nvidia-smi` inside the container. | NVIDIA Container Toolkit misconfiguration or driver mismatch. | Reinstall NVIDIA Container Toolkit, ensure the default runtime is `nvidia`, and confirm the host driver matches the CUDA stack baked into the image. |

## Observability

- Tail logs: `docker compose -f rtvi-embed-docker-compose.yml logs -f rtvi-embed`.
- Scrape Prometheus metrics: `curl -fsS "http://localhost:${RTVI_EMBED_PORT}/v1/metrics"`.
- Detailed component status: `curl -fsS "http://localhost:${RTVI_EMBED_PORT}/v1/ready?detailed=true"`.
- Asset storage stats: `curl -fsS "http://localhost:${RTVI_EMBED_PORT}/v1/assets/stats"`.
- OTLP traces and metrics: enable on the host with `RTVI_EMBED_ENABLE_OTEL_MONITORING=true` (Compose maps this to the container's `ENABLE_OTEL_MONITORING`) and point `RTVI_EMBED_OTEL_EXPORTER_OTLP_ENDPOINT` at a reachable collector.

## When To Wipe State

`docker compose down -v` destroys the named volumes:

- `rtvi-hf-cache`
- `rtvi-ngc-model-cache`
- `rtvi-triton-model-repo`

Only do this when you need a clean rebuild or when migrating to a new model. After a destructive teardown, the next start performs a full model download and Triton repo rebuild, which can take 20+ minutes.
