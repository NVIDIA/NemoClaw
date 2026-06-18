# Deployment Reference: VIOS

> **Two deploy modes in 3.2** — pick one before working through the rest of this runbook:
>
> 1. **Direct routing** (`VST_NGINX_MODE=vst-direct`, `STREAM_PROCESSOR_MODULE_ENDPOINT=http://localhost:30001`) — used by `dev-profile-base`. Sensor → streamprocessing on `:30001` via the bundled `nginx-vst-direct.conf`. **No SDR, no SDRC, no L7 router.** Lightest possible VIOS deploy; sufficient for upload + snapshot + clip-extraction + recorder-status workflows (i.e. everything the standalone VIOS eval exercises). Skip the SDRC sections below if you pick this mode.
> 2. **SDRC routing** (default; `STREAM_PROCESSOR_MODULE_ENDPOINT=http://localhost:10000`) — used by `dev-profile-lvs`, `dev-profile-search`, `dev-profile-alerts`, and all warehouse profiles. Sensor → `sdr-controller`'s Envoy listener on `:10000` → streamprocessing on `:30001`. Adds the SDRC controller + 5 init containers from [`services/infra/sdrc/`](../../../deploy/docker/services/infra/sdrc/) on top of the VIOS core. Required if you need WDM-routed RTSP camera registration with downstream CDS updates.
>
> The rest of this runbook documents mode (2) because it's the superset deploy — mode (1) drops the `sdr-controller` workload and its config templates and changes two env vars. Replaces the deprecated `vss-vios-sdr` + `vss-vios-envoy` pair (`sdr:3.1.0` + `envoy-proxy:3.1.0`) that earlier 3.1 builds used for all profiles.

## Container Image

VIOS is a **multi-image microservice**. Source: `vst.env` lines 64–66 (canonical image names + tag-var convention).

| Image | Tag pattern | Registry | Role |
|---|---|---|---|
| `nvcr.io/nvidia/vss-core/vss-vios-sensor:${VST_SENSOR_IMAGE_TAG}` | `3.2.0` | `nvcr.io` | sensor-ms |
| `nvcr.io/nvidia/vss-core/vss-vios-streamprocessing:${VST_STREAM_PROCESSOR_IMAGE_TAG}` | same | `nvcr.io` | streamprocessing-ms |
| `nvcr.io/nvidia/vss-core/vss-vios-ingress:${VST_INGRESS_IMAGE_TAG}` | same | `nvcr.io` | vst-ingress |
| `nvcr.io/nvidia/vss-core/sdr-mw-l:${SDR_MW_L_IMAGE_TAG:-3.2.0}` | `3.2.0` | `nvcr.io` | `sdr-controller` — combined WDM SDRC controller + Envoy router. **Replaces the legacy `sdr:3.1.0` + `envoy-proxy:3.1.0` pair** that previously ran as `vss-vios-sdr` / `vss-vios-envoy`; the legacy pair is deprecated and the source tree has been removed from `develop` (was kept around for the now-removed smart-city profile). Image source: [`deploy/docker/services/infra/sdrc/docker-compose.yaml`](../../../deploy/docker/services/infra/sdrc/docker-compose.yaml) `sdr-controller` service. |
| `alpine:3.23.4` | pinned | Docker Hub | SDRC init containers (`init-dirs`, `render-config`, `wdm-env-from-config`, `wait-for-docker-workloads`) |
| `redis:8.6.2-alpine` | pinned | Docker Hub | SDRC `wait-for-redis` init container (separate from the Redis broker peer) |
| `postgres:17.9-alpine` | upstream Postgres tag | Docker Hub | centralizedb |

- **NGC pull:** the four `nvcr.io/nvidia/vss-core/*` images (`vss-vios-sensor`, `vss-vios-streamprocessing`, `vss-vios-ingress`, `sdr-mw-l`) require `docker login nvcr.io` with `NGC_CLI_API_KEY` (`$oauthtoken` username), and the deploying key must have access to the published artifacts. The Docker Hub support images (`alpine:3.23.4`, `redis:8.6.2-alpine`, `postgres:17.9-alpine`) pull without authentication.
- **Architecture support:** x86_64 + aarch64 (Jetson Thor / IGX Thor / AGX Thor). SBSA Grace/Spark uses a separate suffix when applicable (the VIOS rst note is "see canonical `vios-microservices.rst` § VIOS Microservices table" for per-arch container-name suffixes `-smc`, `-2d`, `-3d`, `-dev`).
- **Canonical naming (Finding 2 — IMPORTANT):** the legacy `vss-vst-*` image names are **deprecated**. Always use the `vss-vios-*` names from `vst.env`.
- **SDR → SDRC migration:** the legacy `nvcr.io/nvidia/vss-core/sdr:3.1.0` (Flask WDM agent on port 4003) and `nvcr.io/nvidia/vss-core/envoy-proxy:3.1.0` (L7 proxy on port 10000) that previously ran as `vss-vios-sdr` + `vss-vios-envoy` are **deprecated** in 3.2. Their roles are now combined in a single `sdr-controller` workload (image `sdr-mw-l`) defined at [`deploy/docker/services/infra/sdrc/docker-compose.yaml`](../../../deploy/docker/services/infra/sdrc/docker-compose.yaml).

## GPU Requirements

VIOS is GPU-mixed: the **`streamprocessing-ms` container needs a GPU** (HW video decode / encode / transcode for clip extraction, snapshot rendering, WebRTC, and recorder pipelines), while every other VIOS service runs CPU-only.

| Container | GPU required? | Why |
|---|---|---|
| `vss-vios-streamprocessing` | **Yes** | Runs the full `launch_vst` binary with recorder / RTSP-server / storage enabled. Compose declares `runtime: nvidia` ([`streamprocessing/docker-compose.yaml`](../../../deploy/docker/services/vios/streamprocessing/docker-compose.yaml)); the binary uses NVDEC/NVENC for media-information probing, clip extraction, and snapshot rendering. |
| `vss-vios-sensor` | No | Same `launch_vst` binary but configured with `NEED_RECORDING=false`, `NEED_RTSPSERVER=false`, `NEED_STORAGE=false`, `NEED_STREAM_MONITORING=true` ([`initiator/docker-compose.yaml:42-46`](../../../deploy/docker/services/vios/initiator/docker-compose.yaml)) — pure control-plane / sensor metadata. `runtime: nvidia` is declared so the container *could* see the GPU, but no actual GPU work happens here. |
| `vss-vios-nvstreamer` (Topology B) | No | `ADAPTOR=streamer` only scans the bind-mounted directory and republishes files as RTSP. Compose has no `runtime: nvidia` and no device reservation ([`dev-profile-alerts/compose.yml:31-55`](../../../deploy/docker/developer-profiles/dev-profile-alerts/compose.yml)). |
| `vss-vios-ingress` | No | NGINX reverse proxy. |
| `vss-vios-postgres` | No | Standard PostgreSQL. |
| `sdr-controller` + SDRC init chain | No | WDM controller + Envoy router; pure CPU. |

- **Minimum VRAM:** modest — the streamprocessing GPU footprint is dominated by per-stream NVDEC/NVENC sessions plus working buffers. A few hundred MB per stream is a reasonable starting point; size to actual stream count.
- **Supported GPU architectures:** any architecture supported by the NVIDIA Container Toolkit + the `launch_vst` image's bundled CUDA / Video Codec SDK. x86_64 + aarch64 (Jetson Thor / IGX Thor / AGX Thor). Source: `vios-microservices.rst` § VIOS Microservices table.
- **GPU count per instance:** 1 GPU is sufficient for `streamprocessing-ms`; it does not need a dedicated GPU and can share with other services. The other VIOS containers don't reserve a GPU device.
- **Can share GPU with other services?** **Yes.** `streamprocessing-ms` requests `runtime: nvidia` without an explicit `device_ids` reservation in the standalone deploy, so it co-resides with whatever else is on the host GPU (RT-VLM, LLM NIM, etc.). Source: [`streamprocessing/docker-compose.yaml`](../../../deploy/docker/services/vios/streamprocessing/docker-compose.yaml) — no `deploy.resources.reservations.devices` clause.
- **Compose snippet for device reservation:** only `runtime: nvidia` is set on `streamprocessing-ms*`; no `deploy.resources.reservations.devices`. Pin to a specific GPU by adding `NVIDIA_VISIBLE_DEVICES=<id>` to its environment or by injecting a `device_ids` reservation in the patched compose.

This makes VIOS a light-weight GPU consumer: only `streamprocessing-ms` contends for GPU, leaving most planning to RT-VLM (and any future RTVI / NIM peer).

## CPU & Memory

- **Minimum CPU cores:** 4 cores recommended for a single-stream IN-1 deployment; scale with `NUM_STREAMS`-like provisioning (the RTSP Server and Recorder services support 1–5 horizontally-scaled instances). Source: `vios-microservices.rst` § VIOS MS Horizontal Scaling.
- **Minimum RAM:** 8 GB for the VIOS stack baseline. Recording-heavy deployments add proportionally with concurrent streams and bitrate (see Storage formula below).
- **`shm_size`:** not set in `vst.env` defaults — relies on Docker default. Set explicitly only if WebRTC or large clip downloads OOM the default shared memory.
- **`ulimits`:** none required for the VIOS containers.

## Storage

| Mount Path (host → container) | Purpose | Type | Size estimate | Required permissions |
|---|---|---|---|---|
| `${CLIP_STORAGE_PATH}` → `/opt/clip_storage` | Clip storage; **shared bind mount with RT-VLM** for IN-1 on-demand path | bind | grows with on-demand uploads (typical: 10–50 GB) | writable by UID 1001 — `chmod 777` on the leaf dir (not recursive on the parent); `chown -R 1001:1001` is the cleanest approach |
| `${VST_VIDEO_STORAGE_PATH}` → `/opt/vst_video` | Long-term continuous recording storage | bind | capped at `${VST_VIDEO_STORAGE_SIZE_MB}` (default 100 GB) | writable by UID 1001 |
| `${VST_TEMP_FILES_PATH}` → `/opt/temp_files` | Temp files (transcode scratch, etc.) | bind | low (< 5 GB) | writable by UID 1001 |
| `${VST_DATA_PATH}` → `/opt/vst_data` | Internal data + DB seed + logs | bind | < 5 GB | writable by UID 1001 |
| `${VST_CONFIG_PATH}` → `/opt/vst_config` (ro) | VIOS configs (JSON, scripts) | bind (ro) | minimal | readable by container |
| `${SDR_CONTROLLER_CONFIG_PATH}/configs` → `/configs/` (ro on `sdr-controller`) / `/tmpl` (on `render-config`) | SDRC workload definitions: `config.yml.tmpl` + `docker_cluster_config-streamprocessing.json.tmpl` (rendered in place to `config.yml` / `*.json` by the `render-config` init container). Source: [`sdrc/docker-compose.yaml`](../../../deploy/docker/services/infra/sdrc/docker-compose.yaml) lines 71 + 157. | bind | minimal | readable by both containers; templates rendered as root |
| `./log` → `/mnt/log` (on `init-dirs`) / `/logs` (on `sdr-controller`) | `sdr-controller` runtime logs. **Host path is relative to the SDRC compose-file directory** (`services/infra/sdrc/log/` upstream; whatever the patched build-output places the compose next to) — NOT under `SDR_CONTROLLER_CONFIG_PATH`. | bind | low | chmod 0777 by the `init-dirs` container at first boot — host user can `rm -rf` without sudo |
| `./.wdm-env` → `/mnt/wdm-env` (`init-dirs`) / `/env` (`wdm-env-from-config`) / `/wdm-env` (`wait-for-redis`, `wait-for-docker-workloads`) | WDM env vars rendered from `config.yml` by `wdm-env-from-config`; consumed by the two wait-* init containers and downstream peer services (e.g. RT-CV). **`sdr-controller` does NOT mount this** — its env is set explicitly in the compose `environment:` block (see compose line 135). Host path is relative to the SDRC compose-file directory. | bind | minimal | chmod 0777 by `init-dirs` (same rationale) |
| `/var/run/docker.sock` → `/var/run/docker.sock` | Host docker socket — `sdr-controller` discovers `vss-vios-streamprocessing` via `WDM_CLUSTER_TYPE: docker`; also mounted on `wait-for-docker-workloads`. | bind | n/a | host docker socket; not required when running under k8s |

**Storage capacity formula** (per `vios-microservices.rst` § Storage Calculation):
- `Storage (GB/day) = Bitrate (Mbps) × 10.546875`
- For 8 Mbps stream: ~84.4 GB/day per stream.

**Persistent vs. wiped:** all VIOS storage is host-bind, so `docker compose down -v` does NOT wipe them. Hand-rm `${VST_VOLUME}/` only when you intentionally want to lose recorded video. The PostgreSQL container `vss-vios-postgres` may use a named volume — confirm in the live compose; on `down -v` that volume IS wiped, taking sensor configuration with it.

**Required host-path setup before first `up`:**

```bash
mkdir -p ${VSS_DATA_DIR}/data_log/vst/{clip_storage,vst_video,temp_files,vst_data}
sudo chown -R 1001:1001 ${VSS_DATA_DIR}/data_log/vst
# Alternatively, if sudo unavailable:
# sudo setfacl -R -m u:1001:rwx ${VSS_DATA_DIR}/data_log/vst

# SDRC workload-definition templates — minimum set for standalone VIOS
# (model after deploy/docker/developer-profiles/dev-profile-alerts/sdrc/2d_vlm/configs/).
# The render-config init container reads *.tmpl from configs/ and writes the rendered
# sibling alongside it (config.yml.tmpl -> config.yml, docker_cluster_config-*.json.tmpl
# -> docker_cluster_config-*.json), substituting ${HOST_IP}, ${NUM_STREAMS}, ${NUM_SENSORS}.
mkdir -p ${SDR_CONTROLLER_CONFIG_PATH}/configs
# Drop in:
#   ${SDR_CONTROLLER_CONFIG_PATH}/configs/config.yml.tmpl
#   ${SDR_CONTROLLER_CONFIG_PATH}/configs/docker_cluster_config-streamprocessing.json.tmpl
# The log/ and .wdm-env/ dirs land NEXT TO the SDRC compose file (the bind sources are
# `./log` and `./.wdm-env` per sdrc/docker-compose.yaml lines 35-36, 88-90, 111-112,
# 130-132, 154 — not under SDR_CONTROLLER_CONFIG_PATH). `init-dirs` creates and chmods
# them to 0777 itself on first start, so no manual mkdir is needed there.
```

## Startup Behavior

- **Expected startup time:**
  - First boot: 60–120 s for the VIOS trio (PostgreSQL initialization + sensor-ms boot + Ingress NGINX) plus an extra 20–40 s for the SDRC critical-path init (`init-dirs` + `render-config`) before `sdr-controller` boots. The remaining SDRC init containers (`wdm-env-from-config` + `wait-for-redis` + `wait-for-docker-workloads`) run in parallel with `sdr-controller` startup and serve downstream peer services, not sdr-controller itself. Total cold-start envelope to a `/sensor/version` response ≈ 80–160 s.
  - Warm cache: 30–60 s; SDRC critical-path init replays in <10 s once the alpine image is cached.
- **Startup ordering dependencies:** uses explicit wait-poller containers (`sensor-bp-wait-bp-configurator`, `sensor-bp-wait-storage`) instead of `depends_on` on external services. PostgreSQL must be healthy before sensor-ms / streamprocessing-ms start (compose declares this with `depends_on: vss-vios-postgres: condition: service_healthy`). `sdr-controller`'s strict prerequisites — per [`sdrc/docker-compose.yaml`](../../../deploy/docker/services/infra/sdrc/docker-compose.yaml) lines 158-164 — are exactly three `service_completed_successfully` deps: `broker-health-check` (external, from the infra compose), `init-dirs`, and `render-config`. **It does NOT depend on `wdm-env-from-config`**; the SDRC compose comment at line 134-135 explicitly notes "Does not use wdm-env-from-config (env is explicit below, like a hand-written docker run)" — sdr-controller reads its env vars directly from the compose `environment:` block. The two `wait-for-*` containers run for the benefit of *other* peer services and never block sdr-controller.
- **Health check endpoint:** `GET http://localhost:${VST_INGRESS_HTTP_PORT}/vst/api/v1/sensor/version`. Expect HTTP 200 + version JSON.
- **Health check tuning:** `interval: 10s, timeout: 5s, retries: 20, start_period: 30s` (per `integrate-vios-service.md` snippet).
- **Log signatures of healthy startup:**
  - `vss-vios-ingress`: `nginx: ready` (per the NGINX boot log) and the healthcheck flipping to healthy.
  - `vss-vios-postgres`: `database system is ready to accept connections`.
  - `vss-vios-sensor`: `Sensor Management Service started on :30000` (or equivalent).
  - `vss-vios-streamprocessing`: `Stream Processing Service started`.
  - `sdrc-render-config`: `render-config: rendered N template(s)` then exit 0 (visible via `docker logs sdrc-render-config`).
  - `sdr-controller`: WDM workload-add log line for the `docker-workload-streamprocessing` entry — confirms the Envoy LDS/CDS has been pushed and `/sensor/add` → `localhost:10000` → streamprocessing-ms will succeed.

## Environment Variables — Required for Upload-to-Caption Path

These env vars MUST be set in the consumer `.env` (or `vst.env` must be loaded into the patched VIOS compose include) before deploying — they affect runtime correctness, not just configuration. The skill's Step 6 `.env` generation must emit them.

| Variable | Required value | Why required | Source |
|---|---|---|---|
| `VST_INSTALL_ADDITIONAL_PACKAGES` | `true` | The `vss-vios-streamprocessing:3.2.0` image ships WITHOUT `libavcodec` / `libavformat` / `libavutil`. The container's entrypoint runs `apt install` to install them at startup ONLY when this env var is `true`. Without it, **PUT video uploads fail with `InvalidParameterError: Failed to get media information`** because both the primary (libav) and fallback (GStreamer discoverer) extraction paths fail inside the container. Finding 9, 2026-05-25. | `vst.env:28` (upstream default `true`); live verification 2026-05-25 |
| `VST_INGRESS_IMAGE_TAG` | `3.2.0` | Published VSS 3.2.0 tag for the VIOS ingress image. | `dev-profile-base/.env:230` |
| `VST_SENSOR_IMAGE_TAG` | `3.2.0` | Published VSS 3.2.0 tag for the VIOS sensor image. | `dev-profile-base/.env:228` |
| `VST_STREAM_PROCESSOR_IMAGE_TAG` | `3.2.0` | Published VSS 3.2.0 tag for the VIOS streamprocessing image. | `dev-profile-base/.env:227` |
| `NVSTREAMER_IMAGE_TAG` | `3.2.0` | Published VSS 3.2.0 tag for the NvStreamer image. | `dev-profile-base/.env:229` |
| `CENTRALIZE_DB_PASSWORD` | non-empty (any value) | PostgreSQL password — `vst.env` has no default; deploy hangs in `password authentication failed` on first init without this set | `vst.env` |
| `KAFKA_BOOTSTRAP_URL` | `kafka:9092` (compose-internal hostname) | Used by streamprocessing-ms for `camera_streaming` event publication. Wrong value → silent caption-pipeline break | `vst.env` |
| `REDIS_HOSTADDR` / `REDIS_PORT` | `redis` / `6379` (compose-internal) | streamprocessing-ms publishes `vst.event` here; `sdr-controller` consumes via `WDM_WL_REDIS_SERVER` / `WDM_WL_REDIS_PORT` (defaulted to `${HOST_IP}` / `6379` in [`sdrc/docker-compose.yaml`](../../../deploy/docker/services/infra/sdrc/docker-compose.yaml) lines 143-144). Wrong value → SDRC never picks up new streams → 503 on `/record/*` and `/replay/*` calls. | `vst.env` |
| `HOST_IP` | the host's reachable IP (NOT `localhost`) | **Required by SDRC's `render-config` init container** ([`sdrc/docker-compose.yaml`](../../../deploy/docker/services/infra/sdrc/docker-compose.yaml) line 66 declares `HOST_IP: ${HOST_IP:?HOST_IP must be set...}`). Substituted into every `*.tmpl` and into `WDM_WL_REDIS_SERVER` / `KAFKA_BOOTSTRAP_URL` inside the rendered `config.yml`. Missing → SDRC chain fails fast with a `must be set` error before `sdr-controller` ever boots. | `sdrc/docker-compose.yaml` |
| `SDR_CONTROLLER_CONFIG_PATH` | host path containing `configs/*.tmpl` | Compose-time bind source for the rendered config dir; see [`dev-profile-alerts/sdrc/2d_vlm/configs/`](../../../deploy/docker/developer-profiles/dev-profile-alerts/sdrc/2d_vlm/configs/) for the reference 2d_vlm template pair. Standalone VIOS uses the same shape with a single `docker-workload-streamprocessing` entry. | `sdrc/docker-compose.yaml` line 71, 88, 157 |
| `NUM_STREAMS` / `NUM_SENSORS` | `1` each (standalone single-stream) | Substituted into `config.yml.tmpl` and `docker_cluster_config-streamprocessing.json.tmpl` by `render-config` (lines 67-68 of `sdrc/docker-compose.yaml`). Defaults to `1` if unset; raise to match the actual stream count. | `sdrc/docker-compose.yaml` |
| `WDM_CONTROLLER_PORT` / `WDM_SDRC_DIRECT_LISTENER_PORT` / `ENVOY_ADMIN_PORT` | `5003` / `8011` / `9902` (hardcoded inside the SDRC compose `sdr-controller.environment:` — NOT `${VAR:-default}`, so a consumer `.env` cannot override them) | `sdr-controller` listen ports for the WDM control plane, SDRC direct listener, and Envoy admin. To change them, patch [`sdrc/docker-compose.yaml`](../../../deploy/docker/services/infra/sdrc/docker-compose.yaml) lines 147, 149, 150 in the build-output's patched tree. The Envoy listener that actually fronts streamprocessing-ms is `WDM_MS_LISTENER_PORT` from inside the rendered `config.yml` (default `10000` — must match `STREAM_PROCESSOR_MODULE_ENDPOINT` on `vss-vios-sensor`, which is env-overridable, not hardcoded; see `dev-profile-base/.env:223` for the direct-routing override that sets it to `:30001` and bypasses SDRC entirely). | `sdrc/docker-compose.yaml` lines 147-151 + `dev-profile-alerts/sdrc/2d_vlm/configs/config.yml.tmpl:40` |
| `SDR_MW_L_IMAGE` | `nvcr.io/nvidia/vss-core/sdr-mw-l:3.2.0` (default in compose) | `sdr-controller` image. Override to pin a different published `sdr-mw-l` tag. | `sdrc/docker-compose.yaml` line 138 |

> **Image registry path:** VIOS 3.2.0 components ship under `nvcr.io/nvidia/vss-core/*`; the current repo defaults point at the published org. Source: `vst.env` lines 70–72 + the VSS 3.2.0 publishing manifests.

## Known Deployment Issues

| Symptom | Root cause | Fix |
|---|---|---|
| `invalid spec: :/opt/clip_storage: empty section between colons` (or similar mount-spec error) on dry-run | `CLIP_STORAGE_PATH` empty — `vst.env` not loaded into the include | Ensure the patched VIOS compose has `env_file: [..., vst.env]` on its `include:` directive; this was Finding 1 of the IN-1 first run |
| Containers loop on restart with `Permission denied` writing to `/opt/clip_storage` | Host bind dir not writable by UID 1001 | `sudo chown -R 1001:1001 ${VSS_DATA_DIR}/data_log/vst` (or use ACL grant) |
| Containers boot but `sensor/version` returns 502 / connection refused | Ingress (`vss-vios-ingress`) ready but `vss-vios-sensor` still booting → 502 from NGINX | Wait for `vss-vios-sensor` healthcheck; the Ingress start_period (`30s`) is shorter than sensor-ms boot — give it 60–120 s on first boot |
| `vss-vios-postgres` healthcheck fails with `password authentication failed` | `CENTRALIZE_DB_PASSWORD` unset or rotated since last init | Set explicitly in `.env`; on first-time init Postgres adopts whatever was passed; subsequent runs require the same value or a volume reset |
| Camera RTSP add returns HTTP 500 with `unable to connect to RTSP` | Camera RTSP credentials missing or wrong; or the camera is unreachable from the VIOS host | Provide `username`/`password` in `POST /sensor/add`; confirm L3 reachability from the VIOS host to the camera |
| Compose rejects `vst.env`-style image variables as empty (`vss-vios-sensor:`) | `VST_*_IMAGE_TAG` env vars unset — no default in `vst.env` for the tag halves | Set `VST_SENSOR_IMAGE_TAG=3.2.0` etc. in the consumer `.env`; do not rely on the `vst.env` providing them |
| Image-name typo `vss-vst-sensor` (legacy) fails to pull | Catalog or env using deprecated legacy image names | Use the canonical `vss-vios-*` names from `vst.env` lines 64–66 — Finding 2 |
| `port already allocated` for `30888` | Other service binding the Ingress port | Override `VST_INGRESS_HTTP_PORT` to an unused port |
| `sdrc-render-config` exits non-zero with `HOST_IP must be set in .env or shell before running compose` (or `wdm-env-from-config` aborts on the same env check) | `HOST_IP` env var unset on the compose invocation. Required by [`sdrc/docker-compose.yaml`](../../../deploy/docker/services/infra/sdrc/docker-compose.yaml) lines 66 + 84 — the SDRC init chain refuses to start without it. | Export `HOST_IP=<host's reachable IP>` (NOT `localhost` — gets baked into rendered `WDM_WL_REDIS_SERVER`, which downstream consumers reach from other containers) before `docker compose up`. |
| `sdrc-render-config` exits non-zero with `render-config: no *.tmpl files found in /tmpl` | The `${SDR_CONTROLLER_CONFIG_PATH}/configs/` host directory contains no `*.tmpl` files for the render-config init container to consume. SDRC requires at minimum a `config.yml.tmpl` describing the `docker-workload-streamprocessing` workload. | Drop a `config.yml.tmpl` + `docker_cluster_config-streamprocessing.json.tmpl` pair under `${SDR_CONTROLLER_CONFIG_PATH}/configs/`, modeled after [`dev-profile-alerts/sdrc/2d_vlm/configs/`](../../../deploy/docker/developer-profiles/dev-profile-alerts/sdrc/2d_vlm/configs/) (single-workload, no rtvi-cv variant). |
| `POST /vst/api/v1/sensor/add` returns `{"error_code":"InvalidParameterError","error_message":"Invalid Parameters"}` instantly, no validator field cited in `vss-vios-sensor` logs | `sdr-controller` is not listening on the SDRC-rendered Envoy listener port (default `10000` per `WDM_MS_LISTENER_PORT` in the rendered `config.yml`). `vss-vios-sensor` env contains `STREAM_PROCESSOR_MODULE_ENDPOINT=http://localhost:10000`; without that listener up, the adaptor pre-check fails. | Confirm `vss-vios-sensor`, `vss-vios-streamprocessing`, **and** `sdr-controller` (plus its strict prerequisites `sdrc-init-dirs` + `sdrc-render-config` exited 0 — the other three SDRC init containers gate downstream peers, not sdr-controller itself) are all up: `docker ps --format '{{.Names}}' \| grep -E 'vss-vios-(sensor\|streamprocessing)\|sdr-controller'`. Then `nc -z localhost 10000`. If the SDRC critical-path init failed, fix that first (see the two rows above). |
| `POST /vst/api/v1/sensor/add` rejects payload with field name `url` | The in-container OpenAPI YAML (`${VST_CONTAINER_ROOT}/webroot/doc/sensor_management_ms.yaml`) is stale — declares `url` but the binary requires `sensorUrl`. Finding 6, 2026-05-23. | Use `sensorUrl` instead of `url`; cross-check against `services/agent/src/vss_agents/tools/vst/utils.py` for the authoritative payload shape |
| SDRC-rendered Envoy listener on `localhost:10000` returns 503 `Service Unavailable` for `/record/*` or `/replay/*` calls immediately after deploy | `sdr-controller` is healthy but hasn't yet pushed the LDS/CDS update for the `docker-workload-streamprocessing` entry — the WDM agent watches Docker for `vss-vios-streamprocessing` to report `healthy` before it registers the route. | Wait ~30 s after `vss-vios-streamprocessing` flips to healthy; check `docker logs sdr-controller` for the workload-add log line tied to `vss-vios-streamprocessing`. Persistent 503 → `docker restart sdr-controller`. |
| Sensor registers (`state: online`) but VOD URL `rtsp://<host>:30564/vod/<id>` returns 404 | Recording is active (state=2) but no segment has rolled to disk yet | Wait for the segment-rotation interval (default 5 min); confirm `SELECT * FROM video_record_details` in `vss-vios-postgres` shows non-zero rows; explicitly trigger via `POST /vst/api/v1/record/<sensorId>/start` if recording was not auto-started |
| `GET /vst/api/v1/sensor/list` or `/sensor/<id>/streams` returns **HTTP 502 Bad Gateway** or stale results | Leftover `*-smc` containers from a prior alerts-profile deploy (older `develop`) survived teardown and lose the port-bind race against the new `*-dev` containers (both use `network_mode: host` on ports 30000 / 30888). See issue [#151](https://github.com/NVIDIA-AI-Blueprints/video-search-and-summarization/issues/151). On the current contract only `sdr-controller` runs alongside, so the failure mode is narrower — but a stale host can still carry pre-SDRC `sdr-streamprocessing` / `envoy-streamprocessing` containers from a prior deploy. | Re-run `/vss-deploy-profile` (its Step 0 teardown grep covers `sensor-ms-*`, `vst-ingress-*`, `centralizedb-*`, `storage-ms-*`, `sdr-*`, `envoy-*`, `sdr-controller`, `sdrc-*`, `rtspserver-ms-*`) or manually `docker rm -f` any surviving `*-smc` or legacy `vss-vios-sdr` / `vss-vios-envoy` containers before re-deploying. |
| `POST /vst/api/v1/files` returns 404 or 503 | Wrong endpoint — VIOS does NOT expose a generic `POST /files` upload route. The supported endpoint is `PUT /vst/api/v1/storage/file/<filename>?timestamp=<iso>` (new v2) or `PUT /vst/api/v1/storage/file/<filename>/<timestamp>` (legacy v1). | Switch the client to the PUT API; see `integrate-vios-service.md § Integration Interfaces > Inputs > Upload video file` and `references/api-reference.md § 8`. |
| `PUT /vst/api/v1/storage/file/<name>?timestamp=<iso>` returns `{"error_code":"InvalidParameterError","error_message":"Failed to get media information"}` and uploads are immediately deleted (`fs_utils.cpp: Deleting File`) | The `vss-vios-streamprocessing:3.2.0` image ships WITHOUT bundled libav (`libavcodec`/`libavformat`/`libavutil`). Both primary (`LibavWrapper: Failed to load libav libraries dynamically`) and fallback (`gst_discoverer_discover_uri failed`) media-information paths fail. The container's entrypoint apt-installs these libs only when `VST_INSTALL_ADDITIONAL_PACKAGES=true`. Finding 9, 2026-05-25. | Set `VST_INSTALL_ADDITIONAL_PACKAGES=true` in `.env` (upstream `vst.env:28` default — gets clobbered if the consumer `.env` declares it empty). After fix, container takes ~30 s extra on first boot for the apt-install step; verify with `docker exec vss-vios-streamprocessing ls /usr/lib/x86_64-linux-gnu/libavformat.so.60`. |
| `/url`-variant snapshot or clip responses contain `"imageUrl":"http://http://localhost:30888/..."` (double `http://`) and `curl $url` fails with `Could not resolve host: http` | Upstream URL-construction defect in `vss-vios-streamprocessing:3.2.0` — VIOS prepends `http://` to a value that already contains the scheme. Finding 8, 2026-05-25. | (a) Client-side: strip the leading `http://http://` → `http://` before issuing the secondary GET; OR (b) preferred — use the binary direct endpoints (`/storage/file/<id>?...`, `/replay/stream/<id>/picture?...`, `/storage/stream/<id>/picture?...`). The binary endpoints return the actual bytes correctly. See `integrate-vios-service.md § Integration Interfaces > Inputs > VST Storage Management API`. |
| `docker compose up -d` hangs indefinitely with no container creation, no error printed | Compose detected named-volume `driver_opts` drift between prior deploy and current `.env` (typical for `mdx_mdx-elastic-data`, `mdx_mdx-elastic-logs`, `mdx_mdx-kafka` when host bind paths shift). Compose prompts `Volume "X" exists but doesn't match configuration in compose file. Recreate (data will be lost)?` — but stdout is buffered and the prompt is invisible. Finding 10, 2026-05-25. | Run `docker volume rm mdx_mdx-elastic-data mdx_mdx-elastic-logs mdx_mdx-kafka` BEFORE re-deploy; OR pass `--yes` to `docker compose up` (auto-accepts the recreate prompt). The host data dirs they bind into (`${MDX_DATA_DIR}/data_log/elastic/{data,logs,kafka}`) survive the volume removal. The skill's generated `deploy-<flag-slug>` skill should default to `--yes` on `up -d`. |

## Prerequisites

- **Docker Engine:** 28.2+
- **Docker Compose plugin:** 2.36+ (the upstream compose uses `${VAR:+:path}` conditional-bind syntax that older Compose rejects on `config`)
- **NVIDIA Driver:** required on the host — `streamprocessing-ms` declares `runtime: nvidia` and uses NVDEC/NVENC for clip / snapshot / recorder pipelines. The other VIOS containers are CPU-only and don't depend on the driver themselves, but the host must have it installed for the streamprocessing container to start.
- **NVIDIA Container Toolkit:** required — `streamprocessing-ms`'s `runtime: nvidia` directive resolves through `nvidia-container-runtime`. Without it, the streamprocessing container fails to start; the rest of VIOS still comes up but clip/snapshot extraction returns 5xx.
- **API keys:**
  - `NGC_CLI_API_KEY` — for `docker login nvcr.io` to pull the four `vss-core/*` images
- **OS packages:** standard Linux base; `curl`, `jq` for smoke tests.
- **Disk space:** ≥ 50 GB for clip storage + recorded video at modest stream counts; scale per the storage formula.
- **Network reachability:** `nvcr.io` for image pulls; camera RTSP endpoints from the VIOS host; the configured Kafka broker + Redis at the addresses in `vst.env`.
- **Filesystem setup:** the `${VSS_DATA_DIR}/data_log/vst/{clip_storage,vst_video,temp_files,vst_data}` host tree must exist and be writable by UID 1001 before the first `up`.

## Dry Run

```bash
# Resolve VIOS + SDRC composes together. Must pre-set VSS_APPS_DIR + VSS_DATA_DIR +
# VST_*_IMAGE_TAG + HOST_IP + SDR_CONTROLLER_CONFIG_PATH.
docker compose --env-file <consumer.env> \
  -f deploy/docker/services/vios/compose.yml \
  -f deploy/docker/services/infra/sdrc/docker-compose.yaml \
  config --no-interpolate
```

When build-vision-agent generates IN-1, it uses the **patched** copies at `build-output/patched/services/vios/compose.yml` + `build-output/patched/services/infra/sdrc/docker-compose.yaml` and resolves against `build-output/.env`; never against the upstream tree directly (per `feedback_build_output_self_contained`).

## Verify Deployment

```bash
# Ingress + sensor-ms healthy
curl -f http://localhost:30888/vst/api/v1/sensor/version

# Sensor enumeration (empty array on a fresh deploy is fine)
curl http://localhost:30888/vst/api/v1/sensor/list

# PostgreSQL liveness
docker exec vss-vios-postgres pg_isready -U vst

# SDRC chain completed
docker ps --format '{{.Names}}' | grep -qx sdr-controller \
  && echo "sdr-controller up" || echo "sdr-controller MISSING"

# SDRC rendered config visible inside the container
docker exec sdr-controller ls /configs/config.yml /configs/docker_cluster_config-streamprocessing.json

# SDRC-rendered Envoy listener answers (after sdr-controller pushes the LDS/CDS,
# typically within 30s of vss-vios-streamprocessing flipping healthy)
curl -sLv http://localhost:10000/api/v1/record/streams 2>&1 | head
#   Expect: 200 + `null` (empty list). 503 means SDRC has not registered the workload yet.

# Confirm the clip-storage shared bind is wired correctly
docker exec vss-vios-sensor ls -la /opt/clip_storage
ls -la ${VSS_DATA_DIR}/data_log/vst/clip_storage  # same dir from host side
```

## Tear Down

```bash
# Stop both stacks, preserve everything on disk (clip storage, video storage, DB volume,
# rendered SDRC configs)
docker compose -f deploy/docker/services/vios/compose.yml \
               -f deploy/docker/services/infra/sdrc/docker-compose.yaml \
               --profile bp_developer_in_1 down

# Stop + wipe named volumes (centralizedb may live in one — kills sensor configs)
docker compose -f deploy/docker/services/vios/compose.yml \
               -f deploy/docker/services/infra/sdrc/docker-compose.yaml \
               --profile bp_developer_in_1 down -v

# SDRC runtime artifact cleanup — log/ and .wdm-env/ are written as root inside the
# container; rm needs write+exec on the parent dirs (init-dirs chmod-0777ed them so
# this works without sudo). Same shape as dev-profile.sh:1585-1617.
# IMPORTANT: ./log and ./.wdm-env are relative to the SDRC compose-file directory
# (typically `deploy/docker/services/infra/sdrc/` upstream, or
# `build-output/patched/services/infra/sdrc/` for IN-1) — NOT under
# SDR_CONTROLLER_CONFIG_PATH. Substitute the actual SDRC compose dir below.
SDRC_DIR=deploy/docker/services/infra/sdrc      # or build-output/patched/services/infra/sdrc
rm -rf "${SDRC_DIR}/log/"* "${SDRC_DIR}/.wdm-env/"*
# And the render-config-rendered siblings under SDR_CONTROLLER_CONFIG_PATH (the *.tmpl
# source files stay):
find ${SDR_CONTROLLER_CONFIG_PATH}/configs -type f ! -name '*.tmpl' \
  \( -name 'config.yml' -o -name 'docker_cluster_config-*.json' \) -delete

# Host-side cleanup (DESTRUCTIVE — removes all recorded video)
# rm -rf ${VSS_DATA_DIR}/data_log/vst
```
