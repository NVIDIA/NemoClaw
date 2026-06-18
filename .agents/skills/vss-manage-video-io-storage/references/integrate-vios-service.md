# Integration Reference: VIOS

## Overview

VIOS (Video IO & Storage Microservice) is the VSS service responsible for video ingestion, storage, retrieval, and stream lifecycle management. It auto-discovers ONVIF-S compliant IP cameras, accepts manual sensor registration by RTSP URL, stores recorded video with aging policy, exposes WebRTC for live and recorded playback, and serves REST APIs for sensor management, timeline queries, clip extraction, snapshots, and storage stats. Source: `met-blueprint-docs/vios-microservices.rst` § Overview + § Key Features.

VIOS is a **multi-container microservice**, deployed in one of two routing modes depending on the profile:

1. **Direct routing** (`VST_NGINX_MODE=vst-direct`, used by `bp_developer_base_2d`) — 4 long-running containers: `vss-vios-postgres` (centralizedb), `vss-vios-ingress` (nginx routing via `nginx-vst-direct.conf`), `vss-vios-sensor` (sensor-ms with `STREAM_PROCESSOR_MODULE_ENDPOINT=http://localhost:30001` → calls streamprocessing directly, no L7 router), and `vss-vios-streamprocessing` (streamprocessing-ms — HTTP on 30001, RTSP server pool 30554–30564, WebRTC on 80). No SDRC. Per `dev-profile-base/.env:222-224` ("Direct streamprocessing (no SDR/Envoy/SDRC router on :10000)").
2. **SDRC-routed** (`VST_NGINX_MODE` unset / default, used by `bp_developer_lvs_2d`, `bp_developer_search_2d`, `bp_developer_alerts_2d_{cv,vlm}`, and all `bp_wh_*` warehouse profiles) — adds a 5th long-running container `sdr-controller` (the SDRC workload — combined WDM controller + Envoy router, image `nvcr.io/nvidia/vss-core/sdr-mw-l:3.2.0`; controller on `WDM_CONTROLLER_PORT=5003`, SDRC direct listener on `8011`, Envoy admin on `9902`, and the rendered Envoy listener `WDM_MS_LISTENER_PORT` from `config.yml` — default `10000`, matching the SDRC-mode default of `STREAM_PROCESSOR_MODULE_ENDPOINT=http://localhost:10000` in `vss-vios-sensor`). Plus five one-shot SDRC init containers (`init-dirs`, `render-config`, `wdm-env-from-config`, `wait-for-redis`, `wait-for-docker-workloads`), but **only `init-dirs` + `render-config` (plus the external `broker-health-check`) are strict prerequisites for `sdr-controller`** — see [`sdrc/docker-compose.yaml`](../../../deploy/docker/services/infra/sdrc/docker-compose.yaml) lines 158-164. The other three (`wdm-env-from-config`, `wait-for-redis`, `wait-for-docker-workloads`) write env files and gate downstream peer services (e.g. RT-CV); `sdr-controller` does not consume their output and runs in parallel with them.

Container suffixes on `streamprocessing-ms` (`-2d`, `-3d`, `-mv3dt`) reflect industry-profile variants — only the base `streamprocessing-ms` runs in IN-1. Source: `vios-microservices.rst` § VIOS Microservices table + [`deploy/docker/services/infra/sdrc/docker-compose.yaml`](../../../deploy/docker/services/infra/sdrc/docker-compose.yaml) + [`dev-profile-base/.env`](../../../deploy/docker/developer-profiles/dev-profile-base/.env) lines 222-224 + verified live on `2xRTXPro-ubuntu` 2026-05-23.

**SDR → SDRC migration.** The legacy `vss-vios-sdr` (Flask WDM agent on port 4003, image `nvcr.io/nvidia/vss-core/sdr:3.1.0`) + `vss-vios-envoy` (L7 proxy on 10000, image `nvcr.io/nvidia/vss-core/envoy-proxy:3.1.0`) pair is **deprecated** and removed from `develop`. Both responsibilities (workload discovery + L7 routing) are consolidated in the single `sdr-controller` workload defined in [`deploy/docker/services/infra/sdrc/docker-compose.yaml`](../../../deploy/docker/services/infra/sdrc/docker-compose.yaml). The `localhost:10000` contract that downstream callers depend on is preserved by the SDRC-rendered Envoy listener (`WDM_MS_LISTENER_PORT`). New deployments should reference SDRC only.

> **VSS 3.2 architectural change.** The recorder, RTSP server, replay-stream service, and storage service formerly shipped as separate containers (`recorder-ms-{1-5}`, `replaystream-ms-1`, `rtsp-server-ms`, `storage-ms`) are now **consolidated into the single `launch_vst` binary inside `vss-vios-streamprocessing`**. The `vios-microservices.rst` enumerated list (§ "Storage / RTSP Server / Replay Stream / Recorder Service") describes the **scaled-enterprise topology**; the dev profile uses the consolidated single-container form. All recording / playback functionality is still present — just bundled.

Use this service in any deployment that needs (a) RTSP camera registration and proxying, (b) durable video clip storage with timeline indexing, (c) on-demand video upload + clip retrieval for downstream inference, (d) live and recorded **playback** via RTSP (30554/30564) or WebRTC (port 80), or (e) sensor lifecycle events on Kafka/Redis for downstream auto-subscribers (e.g., RT-CV). For live captioning with RT-VLM, see "Two ingestion topologies" below.

## Two ingestion topologies (read first)

VIOS supports **two distinct video-ingestion patterns**; a deployment chooses between them based on the described input source:

### Topology A — External RTSP camera (the canonical IN-1 path)

```
External RTSP camera (or any RTSP source — e.g. a synthetic test stream)
  │
  └─→ POST /vst/api/v1/sensor/add  ───▶ vss-vios-sensor (30000) ──┐
                                                                   │ HTTP via SDRC-rendered Envoy listener
                                                                   │ (WDM_MS_LISTENER_PORT, default :10000)
                                                                   │ inside sdr-controller → streamprocessing(30001)
                                                                   ▼
                                  vss-vios-streamprocessing (launch_vst, all roles)
                                       │ pulls upstream RTSP, transcodes if needed
                                       │ records to ${VST_VIDEO_STORAGE_PATH}/<stream-id>/
                                       │
                                       ├─► Live  RTSP: rtsp://<host>:30554/live/<sensorId>
                                       ├─► VOD   RTSP: rtsp://<host>:30564/vod/<sensorId>
                                       ├─► WebRTC playback: http://<host>:80/...
                                       ├─► Kafka topic `${KAFKA_MSG_KEY}` (default `sensor.id`) on `camera_streaming`
                                       └─► Redis stream `${REDIS_MSG_KEY}` (default `vst.event`)
```

Use when the user prompt names a live IP camera, an existing RTSP URL, or a sidecar that publishes RTSP. **Requires the trio** `vss-vios-sensor`, `vss-vios-streamprocessing`, and `sdr-controller` (the latter with its strict prerequisites `init-dirs` + `render-config` having exited 0) to run as a unit — see § Required Peer Services. Sensor registration is manual via REST. Downstream consumers (RT-CV auto-subscribes; RT-VLM is registered separately via `POST /v1/streams/add`).

### Topology B — On-disk videos via NvStreamer (the dev-profile-alerts pattern)

```
${VSS_DATA_DIR}/videos/<profile-name>/*.mp4   (sample files on host disk)
  │
  └─→ vss-vios-nvstreamer (launch_vst with ADAPTOR=streamer)
        │ scans directory, auto-creates one stream per file
        │
        ├─► RTSP server: rtsp://<host>:31554/<file-basename>
        ├─► HTTP API: http://<host>:31000/...  (NvStreamer REST)
        └─► WebRTC playback on 31000
```

Use when the user explicitly asks to serve sample files or OOBE clips over RTSP, or asks for a deployment without external camera dependencies. **No sensor/add call required** — NvStreamer auto-publishes everything in the watched directory. Source: `deploy/docker/developer-profiles/dev-profile-alerts/compose.yml` § `nvstreamer-alerts` + `deploy/docker/developer-profiles/dev-profile-alerts/nvstreamer/configs/vst-config.json`.

For video ingestion into the natural-language search workflow, use [`vss-search-archive`](../../vss-search-archive/SKILL.md) instead. Search ingestion must go through the VSS agent-backed file or RTSP ingest routes so the source is wired into RTVI-CV, RTVI-Embed, and Elasticsearch; a bare VIOS upload or NvStreamer publish only stores / serves the video and does not create search embeddings.

Both topologies surface the same Kafka `camera_streaming` event downstream, so consumers (RT-CV, vss-agent) work with either. Pick the topology based on the deployment's described input source.

## Required Peer Services

- **PostgreSQL (centralizedb)** — required. Stores sensor configurations, stream metadata, and system state across all VIOS microservice instances. Image `postgres:17.9-alpine` per `vst.env`. Source: `vios-microservices.rst` § OSS Containers table.
- **Kafka** — required when VSS publishes sensor add/remove events on a Kafka message bus. Broker address read from `KAFKA_BOOTSTRAP_URL` (default `localhost:9092` per `vst.env`); message key `KAFKA_MSG_KEY=sensor.id`. Used for downstream consumers to react to sensor lifecycle. Source: `vst.env` lines 56–58 + `vios-microservices.rst` § Key Features bullet 10.
- **Redis** — required (host-network default). Used for caching sensor state and as an alternate message bus for sensor events; reachable at `REDIS_HOSTADDR:REDIS_PORT` (default `localhost:6379`); event key `REDIS_MSG_KEY=vst.event`. Source: `vst.env` lines 53–55.
- **MinIO (optional)** — optional. S3-compatible object storage when video clips are stored in object storage rather than local filesystem. Source: `vios-microservices.rst` § OSS Containers.
- **SDRC (`sdr-controller`) — REQUIRED, NOT OPTIONAL.** Combined WDM controller + Envoy router; replaces the legacy `sdr-streamprocessing` + `envoy-streamprocessing` pair. Image `${SDR_MW_L_IMAGE:-nvcr.io/nvidia/vss-core/sdr-mw-l:3.2.0}`. Watches Redis `vst.event` + Docker container state, advertises workloads to its embedded Envoy router via the WDM control plane, and serves the `streamid`-header-routed L7 listener that `vss-vios-sensor` calls into. Listens on: `WDM_CONTROLLER_PORT=5003` (workload control plane), `WDM_SDRC_DIRECT_LISTENER_PORT=8011` (direct listener), `ENVOY_ADMIN_PORT=9902` (Envoy admin), and `WDM_MS_LISTENER_PORT` from the rendered `config.yml` (default `10000` — preserves the `vss-vios-sensor` endpoint contract). Mounts `${SDR_CONTROLLER_CONFIG_PATH}/configs:/configs/:ro` (the rendered `config.yml` + `docker_cluster_config-streamprocessing.json`), `./log:/logs`, and the host docker socket `/var/run/docker.sock`. Reads its env vars directly from the compose `environment:` block — `sdr-controller` does not mount the `.wdm-env` written by `wdm-env-from-config` (see the inline comment at [`sdrc/docker-compose.yaml`](../../../deploy/docker/services/infra/sdrc/docker-compose.yaml) lines 134-135: *"Does not use wdm-env-from-config (env is explicit below, like a hand-written docker run)"*). Strict prerequisites are `broker-health-check`, `init-dirs`, and `render-config` (compose lines 158-164); the other init containers serve downstream peer services. Source: [`deploy/docker/services/infra/sdrc/docker-compose.yaml`](../../../deploy/docker/services/infra/sdrc/docker-compose.yaml) + Helm chart [`deploy/helm/services/infra/charts/sdrc/`](../../../deploy/helm/services/infra/charts/sdrc/).

> **Critical wiring (SDRC mode):** `vss-vios-sensor` reads `STREAM_PROCESSOR_MODULE_ENDPOINT` from its env (consumer-overridable, not hardcoded — see `dev-profile-base/.env:223` for the direct-routing override). In SDRC mode the default is `http://localhost:10000` — sensor-ms calls the SDRC-rendered Envoy listener, which routes to streamprocessing-ms. **Without `sdr-controller` listening on `WDM_MS_LISTENER_PORT` (default 10000), `POST /sensor/add` fails with `InvalidParameterError: Invalid Parameters`** (the failure happens inside the adaptor pre-check, ~2ms after the parameters log, with no diagnostic). And until `sdr-controller` has finished registering `vss-vios-streamprocessing` with its Envoy LDS/CDS, the listener returns 503 to downstream `/record/*` / `/replay/*` / `/live/*` calls. A deployment using SDRC mode must enable: `streamprocessing-ms*`, `sensor-ms*`, AND **the entire SDRC stack in [`services/infra/sdrc/docker-compose.yaml`](../../../deploy/docker/services/infra/sdrc/docker-compose.yaml)** (`init-dirs`, `render-config`, `wdm-env-from-config`, `wait-for-redis`, `wait-for-docker-workloads`, `sdr-controller`). If targeting direct-routing instead (lighter, base-profile-style), set `STREAM_PROCESSOR_MODULE_ENDPOINT=http://localhost:30001` + `VST_NGINX_MODE=vst-direct` in the `.env` and skip the SDRC stack entirely.
- **Blueprint configurator readiness URL** — optional but used by VIOS start-up gating. `sensor-bp-wait-bp-configurator` polls `BP_CONFIGURATOR_READYZ_URL` (default `http://127.0.0.1:5001/readyz`) so VST services avoid an explicit `depends_on` on external configurator workloads. Timeout `SENSOR_BP_WAIT_BP_CONFIGURATOR_MAX_SEC=300`. Source: `vst.env` lines 42–46.

## Integration Interfaces

### Inputs

- **Method:** REST — VST Sensor Management API
  **Endpoint base:** `http://<host>:${VST_INGRESS_HTTP_PORT}/vst/api/v1/sensor/...` (default port `30888`)
  **Operations:**
  - `POST /sensor/add` — register an RTSP camera. **Required fields: `sensorUrl` (RTSP URL — NOT `url`), `name`, `username`, `password`.** Optional: `location`, `tags`, `desc`, `hardware`, `manufacturer`, `serialNumber`, `firmwareVersion`, `hardwareId`. ONVIF-IP-based alternative: `sensorIp` + `username` + `password`. Returns `{"sensorId": "<uuid>"}` on 200.
  - `GET /sensor/list` — list all sensors (returns array with `sensorId`, `name`, `state`, `sensorIp`, `hardwareId`, `tags`, `type`, `isTimelinePresent`, `isRemoteSensor`)
  - `GET /sensor/{sensorId}/info` — hardware metadata
  - `GET /sensor/{sensorId}/status` and `/sensor/status` — sensor state + error info (`state: online` after VIOS validates the upstream RTSP connection)
  - `GET /sensor/{sensorId}/streams` — returns `streamId`, `url` (live RTSP proxy), `vodUrl` (recorded-replay RTSP), codec, framerate, resolution per stream. After `sdr-controller` (SDRC) registers the stream, the VIOS Kafka `camera_streaming` event also carries `camera_url=rtsp://<host>:30554/live/<id>` and `camera_vod_url=rtsp://<host>:30564/vod/<id>`.
  - `POST /record/{streamId}/start`, `POST /record/{streamId}/stop` — explicit recording control (recording is registered automatically on sensor-add but is in state `0` until /start is called or schedule kicks in)
  - `DELETE /sensor/{sensorId}` — remove sensor
  Source: `references/api-reference.md` § 1–2 + `met-blueprint-docs/vst-sensor-management-api.rst` + verified live 2026-05-23.

  > **Upstream documentation bug (Finding 6, 2026-05-23):** the OpenAPI YAML shipped inside `vss-vios-sensor` at `${VST_CONTAINER_ROOT}/webroot/doc/sensor_management_ms.yaml` declares the request field as `url`, but the actual `launch_vst` binary rejects payloads with `url` and accepts only `sensorUrl`. The authoritative usage is in `services/agent/src/vss_agents/tools/vst/utils.py` (the VSS agent's VIOS helper) which uses `sensorUrl`. When authoring `POST /sensor/add` clients, follow the VSS-agent contract, not the in-container OpenAPI.
  **Auth:** none in default deployments (Ingress NGINX is reverse-proxy only); can be wrapped with an auth layer externally.

- **Method:** REST — VST Live Stream + Replay + Record Management
  **Endpoint base:** `http://<host>:${VST_INGRESS_HTTP_PORT}/vst/api/v1/{live,replay,record}/...`
  Source: `vst-live-stream-management-api.rst`, `vst-replay-stream-management-api.rst`, `vst-record-stream-management-api.rst`.

- **Method:** REST — VST Storage Management API
  **Endpoint base:** `http://<host>:${VST_INGRESS_HTTP_PORT}/vst/api/v1/storage/...`
  **Operations:**
  - `GET /storage/{streamId}/timelines` — array of `{startTime, endTime}` ISO 8601 ranges
  - `GET /storage/timelines[?streams=<id1>&streams=<id2>]` — bulk timelines
  - `GET /storage/size` — per-stream + total storage stats (`sizeInMegabytes`, `totalDiskCapacity`, `totalAvailableStorageSize`, `remainingStorageDays`)
  - `GET /storage/file/{streamId}?startTime=...&endTime=...&container=mp4&disableAudio=true` — download a clip as MP4 or TS bytes **(binary direct — recommended)**
  - `GET /storage/file/{streamId}/url?startTime=...&endTime=...` — get a JSON `{videoUrl, ...}` envelope wrapping a temp-files HTTP URL. **Upstream bug (Finding 8, 2026-05-25):** the returned `videoUrl` carries a double `http://` prefix (e.g. `http://http://localhost:30888/storage/temp_files/...mp4`), so a literal `curl $videoUrl` fails with `Could not resolve host: http`. Either strip the first `http://` client-side (`videoUrl.replace(/^http:\/\/http:\/\//, 'http://')`) or use the binary direct endpoint above. Same defect applies to the `/url` snapshot variants below.
  - `GET /replay/stream/{streamId}/picture?startTime=...` (binary JPEG) — historical snapshot from recordings. Requires `streamId` header. **(binary direct — recommended)**
  - `GET /replay/stream/{streamId}/picture/url?startTime=...` — JSON `{imageUrl, ...}` envelope. Same double-`http://` bug as the clip `/url` variant. Requires `streamId` header.
  - `GET /storage/stream/{streamId}/picture?startTime=...` (binary JPEG) — second snapshot variant; same shape but does NOT require the `streamId` header. **(binary direct — recommended)**
  - `GET /storage/stream/{streamId}/picture/url?startTime=...` — JSON envelope variant; same double-`http://` bug.
  Source: `references/api-reference.md` § 3–5 + `met-blueprint-docs/vst-storage-management-api.rst` + live verification 2026-05-25 (Phase 2 IN-1 validation run).

  > **For IN-1 / Topology A clients: prefer the binary direct endpoints over the `/url` JSON variants** until the upstream double-`http://` URL-construction bug is fixed. The binary endpoints return the actual JPEG / MP4 bytes with correct `Content-Type` and `Content-Length` headers; the `/url` variants require client-side prefix stripping to be usable.

- **Method:** REST — Upload video file
  **Endpoint (new v2 API, preferred):** `PUT http://<host>:${VST_INGRESS_HTTP_PORT}/vst/api/v1/storage/file/<filename>?timestamp=<iso>&sensorId=<sensorId>` (octet-stream PUT, `Content-Length` required). `sensorId` is optional — omit for a new random UUID; pass to group as a sub-stream under an existing sensor. Returns 409 if a file with that name already exists.
  **Endpoint (legacy v1 API):** `PUT http://<host>:${VST_INGRESS_HTTP_PORT}/vst/api/v1/storage/file/<filename>/<timestamp>` (timestamp in path; auto-renames on filename collision; `sensorId` always a new UUID).
  **Response (both):** `{id, filename, bytes, sensorId, streamId, filePath, timestamp, created_at}`. The uploaded file is written to `CLIP_STORAGE_PATH` (default `${VSS_DATA_DIR}/data_log/vst/clip_storage`) and made available for downstream services that share that bind mount.
  **Important — `timestamp` IS honored for the recorded timeline.** Per `references/api-reference.md` § 8: "Uploaded file sensors report timelines relative to the timestamp provided at upload time, not the upload wall-clock time. If the default was used, timelines start at `2025-01-01T00:00:00.000Z`." Snapshot / clip queries against the uploaded sensor MUST use timestamps within the timeline range bound by the upload `timestamp` parameter — fetch the timeline first via `GET /storage/<streamId>/timelines` before constructing snapshot/clip URLs.
  > **Do NOT use `POST /vst/api/v1/files`** — that path is not implemented on the VIOS ingress (returns 404/503). The `/files` shorthand may exist on other microservices (e.g. RT-VLM's `POST /v1/files` upload) but not on VIOS.
  Source: `references/api-reference.md` § 8 + `vios-microservices.rst` § Storage Service + `vst.env` line 22.

- **Method:** RTSP — direct camera streams
  **Endpoint:** the camera's RTSP URL (registered via `POST /sensor/add`)
  VIOS proxies the camera RTSP stream and exposes a stable VIOS-side RTSP URL on `RTSP_SERVER_PORT` (default `30554`) for downstream consumers. Source: `vst.env` line 51 + `vios-microservices.rst` § RTSP Server Service.

- **Method:** ONVIF auto-discovery
  ONVIF-S/T cameras on the local network are auto-discovered without manual sensor add. Source: `vios-microservices.rst` § Key Features bullet 1.

### Outputs

- **Method:** Filesystem write — clip storage
  **Path:** `${CLIP_STORAGE_PATH}` (default `${VST_VOLUME}/clip_storage`, which expands to `${VSS_DATA_DIR}/data_log/vst/clip_storage`)
  **Schema:** raw video files keyed by sensor/stream ID and time range.
  **Trigger:** continuous, while recording is enabled per the sensor's aging policy.
  This is the **IN-1 producer half** of the on-demand path: RT-VLM mounts the same host directory at `${VST_CONTAINER_ROOT}/streamer_videos` to read clips for VOD captioning. Source: `vst.env` line 22 + `deploy-rt-vlm-service.md` §6.

- **Method:** Filesystem write — long-term video storage
  **Path:** `${VST_VIDEO_STORAGE_PATH}` (default `${VST_VOLUME}/vst_video`)
  Capacity capped at `${VST_VIDEO_STORAGE_SIZE_MB}` (default `100000` = ~100 GB) with aging policy. Source: `vst.env` lines 28–29.

- **Method:** Filesystem write — temp + logs
  Paths: `${VST_TEMP_FILES_PATH}` (`${VST_VOLUME}/temp_files`), `${VST_LOGS}` (`${VST_DATA_PATH}/logs`). Source: `vst.env` lines 23–26.

- **Method:** Kafka topic — sensor lifecycle events
  **Topic / key:** message key `${KAFKA_MSG_KEY}` (default `sensor.id`); broker at `${KAFKA_BOOTSTRAP_URL}`
  **Schema:** sensor add/remove events (exact wire schema per the VIOS schema definitions, not enumerated in `vst.env`).
  **Trigger:** on sensor registration/removal.
  Source: `vios-microservices.rst` § Key Features bullet 10 + `vst.env` lines 57–58.

- **Method:** Redis stream — sensor events (alternate)
  **Key:** `${REDIS_MSG_KEY}` (default `vst.event`); reachable at `${REDIS_HOSTADDR}:${REDIS_PORT}`. Source: `vst.env` lines 53–55.

- **Method:** RTSP live playback (pass-through proxy)
  **Endpoint:** `rtsp://<host>:30554/live/<sensorId>` (port = `${RTSP_SERVER_PORT}`, default 30554)
  Re-publishes the registered upstream camera RTSP stream under a stable VIOS-managed URL. Available within 1–2 seconds of `POST /sensor/add` once the sensor transitions to `state=online`. Verified 2026-05-23 with `ffprobe -rtsp_transport tcp rtsp://<host>:30554/live/<id>` returning H.264 metadata. Source: `vios-microservices.rst` § Key Features bullet 4 + § RTSP Server Service + verified live.

- **Method:** RTSP recorded-replay playback (VOD)
  **Endpoint:** `rtsp://<host>:30564/vod/<sensorId>`
  Serves recorded segments back to the client. Returns 404 until at least one recording segment has rolled over to disk (typically 1–5 min after `POST /record/<id>/start`, governed by VIOS's segment-rotation policy). Source: VIOS `camera_streaming` event payload `camera_vod_url` field, verified 2026-05-23.

- **Method:** WebRTC live + replay playback (browser-friendly)
  **Endpoint:** `http://<host>:80/...` (served by `vss-vios-streamprocessing`'s embedded HTTP server in dev profile)
  The VIOS WebUI uses this for browser playback. Signaling proxied through the `vss-vios-ingress` NGINX. Configuration in `vst_config.json` (`max_webrtc_out_connections`, `webrtc_video_quality_tunning` per-resolution settings). Source: `vios-microservices.rst` § Live Stream Service + § Replay Stream Service.

## API Schema

REST API base URL: `http://<host>:${VST_INGRESS_HTTP_PORT}/vst/api/v1/`. Full schema and endpoint listings live in the upstream VST API .rst series (Sensor Management, Live Stream, Replay Stream, Record Stream, Storage Management, Proxy Stream). Concrete request/response shapes for the IN-1-relevant subset are documented inline in `references/api-reference.md` § 1–4 (lines 56–170).

Authoritative reference per topic:

| API Area | Source `.rst` |
|---|---|
| Sensor Management (add/list/info/status/remove/streams) | `vst-sensor-management-api.rst` |
| Live Stream (start/stop, WebRTC offer/answer) | `vst-live-stream-management-api.rst` |
| Replay Stream | `vst-replay-stream-management-api.rst` |
| Record Stream | `vst-record-stream-management-api.rst` |
| Proxy Stream | `vst-proxy-stream-management-api.rst` |
| Storage Management (timelines, clip download, snapshot, storage size) | `vst-storage-management-api.rst` |

## Environment Variables

The IN-1-relevant subset (full list in `deploy/docker/services/vios/vst.env`):

| Variable | Purpose | Default | Required? |
|---|---|---|---|
| `VSS_DATA_DIR` | Host root for all VIOS bind mounts (clip storage, video storage, temp, logs) | — | **Yes** |
| `VST_VOLUME` | Derived: `${VSS_DATA_DIR}/data_log/vst` | — | **Yes (derived)** |
| `VSS_APPS_DIR` | Host root for VIOS configs + scripts | — | **Yes** |
| `CLIP_STORAGE_PATH` | Clip storage path on host; shared with RT-VLM read mount | `${VST_VOLUME}/clip_storage` | **Yes (derived)** |
| `VST_VIDEO_STORAGE_PATH` | Long-term video storage on host | `${VST_VOLUME}/vst_video` | **Yes (derived)** |
| `VST_TEMP_FILES_PATH` | Temp file directory | `${VST_VOLUME}/temp_files` | **Yes (derived)** |
| `VST_DATA_PATH` | Internal data directory | `${VST_VOLUME}/vst_data` | optional |
| `VST_LOGS` | Log directory | `${VST_DATA_PATH}/logs` | optional |
| `VST_INGRESS_HTTP_PORT` | Host port for the Ingress REST API | `30888` | optional |
| `VST_INGRESS_ENDPOINT` | Public REST endpoint string | `${HOST_IP}:30888/vst` | optional |
| `SENSOR_HTTP_PORT` | Internal sensor-ms HTTP port | `30000` | optional |
| `STREAM_PROCESSOR_HTTP_PORT` | Internal streamprocessing-ms HTTP port | `30001` | optional |
| `RTSP_SERVER_PORT` | RTSP proxy port | `30554` | optional |
| `SENSOR_MODULE_ENDPOINT` | Internal URL of sensor-ms | `http://localhost:30000` | optional |
| `STREAM_PROCESSOR_MODULE_ENDPOINT` | Internal URL of streamprocessing-ms | `http://localhost:10000` | optional |
| `CENTRALIZE_DB_NAME` | PostgreSQL DB name | `nvcentralizedb` | optional |
| `CENTRALIZE_DB_USERNAME` | PostgreSQL user | `vst` | optional |
| `VST_VIDEO_STORAGE_SIZE_MB` | Storage cap in MB | `100000` | optional |
| `VST_ADAPTOR` | Camera adapter type: `vst_rtsp` or `milestone_onvif` | `vst_rtsp` | optional |
| `VST_INSTALL_ADDITIONAL_PACKAGES` | Pull extra apt packages at first boot | `true` | optional |
| `HOST_IP` | Used in `VST_INGRESS_ENDPOINT` and `KAFKA_BOOTSTRAP_URL` when not `localhost` | — | conditional |
| `REDIS_HOSTADDR` | Redis address (host networking) | `localhost` | optional |
| `REDIS_PORT` | Redis port | `6379` | optional |
| `REDIS_MSG_KEY` | Redis sensor-event key | `vst.event` | optional |
| `KAFKA_BOOTSTRAP_URL` | Kafka broker | `localhost:9092` | optional |
| `KAFKA_MSG_KEY` | Kafka sensor-event key | `sensor.id` | optional |
| `VST_SENSOR_IMAGE_TAG` | Tag for `vss-vios-sensor` image | (no default — must be set) | **Yes** |
| `VST_STREAM_PROCESSOR_IMAGE_TAG` | Tag for `vss-vios-streamprocessing` image | (no default) | **Yes** |
| `VST_INGRESS_IMAGE_TAG` | Tag for `vss-vios-ingress` image | (no default) | **Yes** |
| `BP_CONFIGURATOR_READYZ_URL` | Optional readiness URL the configurator-wait poller hits | `http://127.0.0.1:5001/readyz` | optional |
| `SENSOR_BP_WAIT_BP_CONFIGURATOR_MAX_SEC` / `SENSOR_BP_WAIT_STORAGE_MAX_SEC` | Wait-loop timeouts | `300` | optional |
| `SDR_CONTROLLER_CONFIG_PATH` | Host path containing `configs/*.tmpl` for SDRC (`config.yml.tmpl` + `docker_cluster_config-streamprocessing.json.tmpl`); the `render-config` init container renders them in place. Mount source for the `sdr-controller` `/configs` bind. | per-profile (e.g. `${VSS_APPS_DIR}/developer-profiles/dev-profile-alerts/sdrc/${MODE}`) | **Yes (SDRC)** |
| `NUM_STREAMS` / `NUM_SENSORS` | Substituted into SDRC `*.tmpl` by `render-config`. | `1` each | optional |
| `WDM_CONTROLLER_PORT` | SDRC WDM controller listen port. **Hardcoded** at [`sdrc/docker-compose.yaml:147`](../../../deploy/docker/services/infra/sdrc/docker-compose.yaml) — not `${VAR:-default}`, so consumer `.env` cannot override; patch the compose to change. | `5003` | not env-controllable |
| `WDM_SDRC_DIRECT_LISTENER_PORT` | SDRC direct listener port. **Hardcoded** at `sdrc/docker-compose.yaml:149`. | `8011` | not env-controllable |
| `ENVOY_ADMIN_PORT` | Embedded Envoy admin port. **Hardcoded** at `sdrc/docker-compose.yaml:150`. | `9902` | not env-controllable |
| `WDM_WL_REDIS_PORT` | Redis port `sdr-controller` connects to (substituted as `${WDM_WL_REDIS_PORT:-6379}` at compose line 144). | `6379` | optional |
| `WDM_MS_LISTENER_PORT` | Rendered Envoy listener port that fronts `streamprocessing-ms`; **must remain `10000`** because `vss-vios-sensor`'s `STREAM_PROCESSOR_MODULE_ENDPOINT=http://localhost:10000` hardcodes it. Set via the rendered `config.yml`, not the compose env. | `10000` | conditional |
| `SDR_MW_L_IMAGE` | `sdr-controller` image override (full repo + tag) | `nvcr.io/nvidia/vss-core/sdr-mw-l:3.2.0` | optional |

## Network Requirements

- **Ports exposed (host-binding via Ingress):**
  - `${VST_INGRESS_HTTP_PORT}` = `30888` (REST API + WebRTC signaling)
  - `${RTSP_SERVER_PORT}` = `30554` (RTSP proxy out)
  - `${SENSOR_HTTP_PORT}` = `30000` (internal — typically not exposed publicly)
  - `${STREAM_PROCESSOR_HTTP_PORT}` = `30001` (internal)
  - PostgreSQL on its standard port from the `centralizedb-*` container
- **SDRC-side ports (host-binding via `sdr-controller`'s `network_mode: host`):**
  - `WDM_CONTROLLER_PORT` = `5003` (WDM workload control plane)
  - `WDM_SDRC_DIRECT_LISTENER_PORT` = `8011` (SDRC direct listener)
  - `ENVOY_ADMIN_PORT` = `9902` (Envoy admin — used for debugging the SDRC-rendered config)
  - `WDM_MS_LISTENER_PORT` = `10000` (rendered Envoy listener fronting `streamprocessing-ms` — **must equal the `STREAM_PROCESSOR_MODULE_ENDPOINT` port baked into `vss-vios-sensor`**)
- **Inbound traffic:** REST clients + RTSP consumers on the Ingress port; camera RTSP streams inbound to the sensor-ms / streamprocessing-ms (registered out-of-band via sensor-add).
- **Outbound traffic:**
  - To configured cameras over RTSP (for pull-mode adapter)
  - To `KAFKA_BOOTSTRAP_URL` for sensor events
  - To `REDIS_HOSTADDR:${REDIS_PORT}` for Redis events
  - To `BP_CONFIGURATOR_READYZ_URL` during startup gating
  - To `nvcr.io` for image pulls
- **DNS / hostname assumptions:** VIOS containers run **with `network_mode: host`** in dev profiles, so internal references use `localhost:<port>` and external references use `${HOST_IP}:<port>`. This is what makes the shared filesystem mount work with RT-VLM (which uses bridge networking but maps host paths in).
- **`network_mode`:** `host` for most VIOS containers (`vst-ingress`, `sensor-ms*`, `streamprocessing-ms*`, `sdr-controller`); `centralizedb` (PostgreSQL) typically bridge. The SDRC init containers run on the default network — only `sdr-controller` itself uses `network_mode: host` because its rendered Envoy listener and WDM controller ports must be host-reachable.

## Known Integration Constraints

- **VIOS image-name canonicalization (Finding 2).** The current canonical image names are `vss-vios-sensor`, `vss-vios-streamprocessing`, `vss-vios-ingress` (NOT the legacy `vss-vst-*` names). Source: `vst.env` lines 64–66. Catalog and integration consumers must use the `vss-vios-*` naming, with the corresponding `*_IMAGE_TAG` env vars driven externally.
- **Bind-mount permissions are NOT recursive chown.** Specific subdirs require `chmod 777` (not recursive across the parent), enabling the container's UID 1001 to write. The standard remedy is `mkdir -p $VSS_DATA_DIR/data_log/vst/{clip_storage,vst_video,temp_files,vst_data}` followed by per-subdir permission grants.
- **CLIP_STORAGE_PATH is the IN-1 contract with RT-VLM.** RT-VLM expects to read videos at the container path `${VST_CONTAINER_ROOT}/streamer_videos`, which a consuming deployment binds from the same host directory (`${VSS_DATA_DIR}/data_log/vst/clip_storage`) that VIOS writes to. If `VSS_DATA_DIR` is set inconsistently between VIOS and RT-VLM, the on-demand caption path silently breaks — RT-VLM gets an empty filesystem mount.
- **`vst.env` must be loaded by every VIOS include.** The top-level `deploy/docker/services/vios/compose.yml` re-declares `env_file: [..., vst.env]` on each `include:` directive. If a deployment's compose copy `include:`s a VIOS sub-compose without re-declaring `vst.env`, ~20 VIOS-internal variables (`CLIP_STORAGE_PATH`, `SDR_IMAGE`, `KAFKA_BOOTSTRAP_URL`, `REDIS_HOSTADDR`, image tags, etc.) collapse to empty and dry-run fails. This was Finding 1 of the IN-1 first run. Source: `deploy/docker/services/vios/compose.yml` lines 17–26.
- **Host networking implications.** With `network_mode: host`, the VIOS containers cannot also have `ports:` mappings — collisions on the host must be resolved by changing the `*_HTTP_PORT` variables. Containers reach each other by `localhost:<port>` (no compose DNS).
- **Compose profile gating.** VIOS service blocks are gated by `profiles:` on every container, listing the existing developer / industry blueprint flags (`bp_developer_alerts_2d_vlm`, `bp_developer_search_2d`, `bp_wh_2d`, etc.). A standalone deployment adds its chosen compose-profile flag to every relevant `profiles:` list in a patched copy of the compose — the upstream tree stays untouched.
- **Startup ordering.** `sensor-bp-wait-bp-configurator` and `sensor-bp-wait-storage` are explicit wait-poller containers used INSTEAD OF `depends_on` so VIOS can come up alongside profile composes that don't define the configurator/storage workloads. Don't add `depends_on` to those external services.
- **Sample-data bundle and friendly names.** `references/api-reference.md` § "Sample data bootstrap" documents 8 NGC-shipped sample mp4s (warehouse, warehouse-ladder, warehouse-safety-1/2, sim-traffic, sim-jaywalking, sim-box-conveyor, drone-bridge). When the user asks for "the sample warehouse video," map to `warehouse_sample.mp4` (etc.); do not invent paths for unknown friendly names.
- **The VIOS + SDRC service set must be enabled together.** For Topology A, a deployment must enable `sensor-ms*`, `streamprocessing-ms*`, AND every service in [`services/infra/sdrc/docker-compose.yaml`](../../../deploy/docker/services/infra/sdrc/docker-compose.yaml) — the `profiles:` lists at lines 24, 47, 76, 100, 117, and 137 covering `init-dirs`, `render-config`, `wdm-env-from-config`, `wait-for-redis`, `wait-for-docker-workloads`, and `sdr-controller`. Patching only `streamprocessing-ms` leaves sensor-ms unable to reach the SDRC-rendered Envoy listener on `localhost:10000` and `POST /sensor/add` fails with `Invalid Parameters` with no useful diagnostic. The legacy `sdr-streamprocessing` + `envoy-streamprocessing` pair (and the four-service VIOS quartet they were part of) is deprecated in 3.2 — do not reproduce it.
- **SDRC requires workload-definition templates.** The SDRC `render-config` init container reads `*.tmpl` files from `${SDR_CONTROLLER_CONFIG_PATH}/configs/` and renders each in place. A deployment must provide a `config.yml.tmpl` + `docker_cluster_config-streamprocessing.json.tmpl` pair at whatever path becomes `SDR_CONTROLLER_CONFIG_PATH`. Use [`developer-profiles/dev-profile-alerts/sdrc/2d_vlm/configs/`](../../../deploy/docker/developer-profiles/dev-profile-alerts/sdrc/2d_vlm/configs/) as the reference single-workload template (no rtvi-cv variant for a VIOS-only deployment). If the `*.tmpl` files are absent, `sdrc-render-config` exits with `render-config: no *.tmpl files found in /tmpl`, the rest of the SDRC chain never runs, and downstream `sdr-controller` never boots — leaving sensor-ms's `localhost:10000` call unanswered. The legacy `./envoy.yaml` + `./sdr-config/` bind-mount sources from the deprecated `services/vios/sdr/streamprocessing/` tree no longer apply.
- **VOD URL is 404 until first segment rolls.** `rtsp://<host>:30564/vod/<id>` returns `404 Stream Not Found` until at least one recording segment exists on disk. This is normal; do not interpret as a wiring failure. Either wait the segment-rotation interval (default 5 min) or explicitly trigger a roll-over before testing VOD playback.
- **The OpenAPI YAML inside the sensor-ms container is out of date.** `${VST_CONTAINER_ROOT}/webroot/doc/sensor_management_ms.yaml` documents `url` as the RTSP-mode field name; the actual binary requires `sensorUrl`. Always cross-check against `services/agent/src/vss_agents/tools/vst/utils.py` — that's the authoritative usage example shipped alongside the binary.
- **`/url` JSON envelope variants return double-`http://` URLs (Finding 8, 2026-05-25).** The four `/url` storage / replay endpoints (`/storage/file/{streamId}/url`, `/replay/stream/{streamId}/picture/url`, `/storage/stream/{streamId}/picture/url`, and the bulk-timeline `/url` variant) construct their `videoUrl` / `imageUrl` fields by prepending `http://` to a value that already contains the scheme — producing `http://http://localhost:30888/storage/temp_files/<file>`. The underlying file IS served correctly at the (single-`http://`) location; the defect is purely in response-body URL construction.
  - **Client-side remediation:** strip the first `http://` (`url.startswith("http://http://") and url[7:]`) before issuing the secondary GET.
  - **Skill / consumer recommendation:** prefer the binary direct endpoints (`/storage/file/{streamId}?...`, `/replay/stream/{streamId}/picture?...`, `/storage/stream/{streamId}/picture?...`) — they return the actual bytes with correct headers and avoid the URL-construction path entirely.
  - **Verified live** 2026-05-25 against VIOS image `nvcr.io/nvidia/vss-core/vss-vios-ingress:3.2.0` / `vss-vios-streamprocessing:3.2.0`. Source: Phase 2 IN-1 validation run on `2xRTXPro-ubuntu` with `streamId=1b5eb54a-7d5b-4ad9-840d-729c399dfcf3` — `imageUrl` response field literal: `http://http://localhost:30888/storage/temp_files/warehouse_safety_in1_..._6334d.jpg`.

## Example Compose Snippet

VIOS is structured as multiple compose files included from `deploy/docker/services/vios/compose.yml` — `foundational/docker-compose.yaml` and `initiator/docker-compose.yaml`. The combined WDM controller + Envoy router is a sibling stack at `deploy/docker/services/infra/sdrc/docker-compose.yaml`. A deployment patches copies of both trees (never the upstream tree) and `include:`s them from its top-level compose.

The IN-1 Topology A service set (canonical container names verified live 2026-05-23):

```yaml
services:

  vss-vios-postgres:           # foundational/docker-compose.yaml (was `centralizedb`)
    profiles: [..., <your-profile-flag>]   # add your deployment's compose-profile flag

  vss-vios-ingress:            # foundational/docker-compose.yaml (nginx reverse proxy on :30888)
    profiles: [..., <your-profile-flag>]

  vss-vios-sensor:             # initiator/docker-compose.yaml (sensor-ms; HTTP_PORT=30000; ADAPTOR=vst_rtsp;
                               #   NEED_STORAGE=false, NEED_RECORDING=false, NEED_RTSPSERVER=false;
                               #   STREAM_PROCESSOR_MODULE_ENDPOINT=http://localhost:10000
                               #   → SDRC-rendered Envoy listener)
    profiles: [..., <your-profile-flag>]

  vss-vios-streamprocessing:   # services/vios/streamprocessing/docker-compose.yaml
                               #   (HTTP_PORT=30001; RTSP server pool 30554–30564; WebRTC on :80;
                               #   recorder/storage/RTSP all bundled in launch_vst)
    profiles: [..., <your-profile-flag>]

  # SDRC init containers (one-shot). Strict prerequisites for sdr-controller are
  # init-dirs + render-config (+ external broker-health-check). The other three run
  # in parallel with sdr-controller and serve downstream peer consumers.
  init-dirs:                   # services/infra/sdrc/docker-compose.yaml — chmod 0777 ./log + ./.wdm-env
                               #   (host paths relative to the SDRC compose-file directory).
    profiles: [..., <your-profile-flag>]
  render-config:               # services/infra/sdrc/docker-compose.yaml — renders *.tmpl in place
                               #   under ${SDR_CONTROLLER_CONFIG_PATH}/configs, substituting
                               #   ${HOST_IP}, ${NUM_STREAMS}, ${NUM_SENSORS}.
    profiles: [..., <your-profile-flag>]
  wdm-env-from-config:         # services/infra/sdrc/docker-compose.yaml — writes ./.wdm-env from
                               #   the rendered config.yml. Consumed by wait-for-* and downstream
                               #   peers; NOT by sdr-controller.
    profiles: [..., <your-profile-flag>]
  wait-for-redis:              # services/infra/sdrc/docker-compose.yaml — blocks until Redis is up
                               #   (gates downstream peer consumers, not sdr-controller).
    profiles: [..., <your-profile-flag>]
  wait-for-docker-workloads:   # services/infra/sdrc/docker-compose.yaml — blocks until the docker
                               #   workloads listed in config.yml exist (gates downstream peers).
    profiles: [..., <your-profile-flag>]

  sdr-controller:              # services/infra/sdrc/docker-compose.yaml
                               #   image: sdr-mw-l:3.2.0
                               #   WDM controller :5003, SDRC direct :8011, Envoy admin :9902,
                               #   rendered Envoy listener WDM_MS_LISTENER_PORT default :10000
                               #   (replaces vss-vios-sdr + vss-vios-envoy from the legacy tree)
                               #   depends_on: broker-health-check, init-dirs, render-config
                               #   (NOT wdm-env-from-config — env is explicit in compose)
    profiles: [..., <your-profile-flag>]
    network_mode: host
    volumes:
      # the deployment must materialize a config.yml.tmpl + docker_cluster_config-*.json.tmpl pair
      # here, modeled after developer-profiles/dev-profile-alerts/sdrc/2d_vlm/configs/.
      - "${SDR_CONTROLLER_CONFIG_PATH}/configs:/configs/:ro"   # trailing slash matches compose line 157
      - ./log:/logs
      - /var/run/docker.sock:/var/run/docker.sock
```

(Full upstream definitions live in `deploy/docker/services/vios/{foundational,initiator,streamprocessing}/docker-compose.yaml` + `deploy/docker/services/infra/sdrc/docker-compose.yaml`. Container names use the canonical `vss-vios-*` form, NOT the legacy `*-dev` form. The deprecated `services/vios/sdr/streamprocessing/` tree has been removed — streamprocessing now lives directly under `services/vios/streamprocessing/`, with the legacy `envoy.yaml` + `sdr-config/` bind sources gone.)

For Topology B (NvStreamer file-driven), use this service shape instead of `vss-vios-sensor`:

```yaml
  vss-vios-nvstreamer:         # developer-profiles/dev-profile-alerts/compose.yml § nvstreamer-alerts
    image: nvcr.io/nvidia/vss-core/vss-vios-nvstreamer:${NVSTREAMER_IMAGE_TAG}
    profiles: [..., <your-profile-flag>]
    network_mode: host
    environment:
      ADAPTOR: streamer          # NvStreamer mode — auto-scans video_path for files
      HTTP_PORT: ${NVSTREAMER_HTTP_PORT}   # default 31000; RTSP server defaults to 31554
    volumes:
      - ./nvstreamer/configs/vst-config.json:${VST_CONTAINER_ROOT}/configs/vst_config.json
      - ./nvstreamer/configs/vst-storage.json:${VST_CONTAINER_ROOT}/configs/vst_storage.json
      - ${VSS_DATA_DIR}/videos/<profile-name>:${VST_CONTAINER_ROOT}/streamer_videos
      - ${VSS_DATA_DIR}/data_log/nvstreamer/vst_data:${VST_CONTAINER_ROOT}/vst_data
```

Both topologies emit the same `camera_streaming` Kafka/Redis event downstream.

## Test / Smoke Hooks

- **Health:** `curl -f http://localhost:${VST_INGRESS_HTTP_PORT}/vst/api/v1/sensor/version` — expect HTTP 200 + version JSON. Used as the Ingress healthcheck.
- **Sensor enumeration:** `curl http://localhost:${VST_INGRESS_HTTP_PORT}/vst/api/v1/sensor/list` — list registered sensors.
- **SDRC-rendered Envoy listener reachable:** `curl -sLv http://localhost:10000/api/v1/record/streams 2>&1 | head` — expect `null` (empty list) NOT `503 Service Unavailable`. 503 indicates `sdr-controller` hasn't yet pushed the workload to its Envoy LDS/CDS (`docker restart sdr-controller` and wait ~30 s after `vss-vios-streamprocessing` is healthy; check `docker logs sdr-controller` for the workload-add log line tied to `vss-vios-streamprocessing`).
- **SDRC chain status:** `docker ps --format '{{.Names}}' | grep -qx sdr-controller` — expect exit 0. If `sdr-controller` is absent, inspect its strict prerequisites in order: `docker logs sdrc-init-dirs sdrc-render-config` — both must exit 0. `HOST_IP must be set` from `render-config` = the deploy env didn't export `HOST_IP`. The other one-shots (`sdrc-wdm-env-from-config`, `sdrc-wait-for-redis`, `sdrc-wait-for-docker-workloads`) gate downstream peer services, not `sdr-controller` — failures in those don't block sdr-controller from starting but will surface as broken downstream consumers.
- **Upload smoke test (v2):** `PUT` an MP4 to `/vst/api/v1/storage/file/<filename>?timestamp=2025-01-01T00:00:00.000Z` with `Content-Type: application/octet-stream` + `Content-Length`; confirm 200 + `{sensorId, streamId, filePath}` in the response and the file present at `${VSS_DATA_DIR}/data_log/vst/clip_storage/...`. Then verify the timeline honors the requested timestamp: `curl http://localhost:30888/vst/api/v1/storage/<streamId>/timelines` should show a `{startTime, endTime}` range anchored at `2025-01-01T00:00:00.000Z`.
- **DB liveness:** `docker exec vss-vios-postgres pg_isready -U ${CENTRALIZE_DB_USERNAME}`.
- **End-to-end live ingestion + playback (Topology A, verified 2026-05-23):**
  1. Bring up an RTSP source (e.g., `mediamtx` + `ffmpeg` pushing `warehouse_safety_0001.mp4` on `rtsp://127.0.0.1:8554/warehouse`).
  2. `POST /vst/api/v1/sensor/add` with `{"sensorUrl":"rtsp://127.0.0.1:8554/warehouse","name":"warehouse-cam","username":"admin","password":"admin"}` — expect 200 + `{"sensorId":"<uuid>"}`.
  3. `GET /vst/api/v1/sensor/<sensorId>/status` — expect `state: online`.
  4. `ffprobe -rtsp_transport tcp rtsp://<host>:30554/live/<sensorId>` — expect H.264 stream metadata (live playback works).
  5. `POST /vst/api/v1/record/<sensorId>/start` — start recording.
  6. After ~1–5 min, `ffprobe rtsp://<host>:30564/vod/<sensorId>` — expect H.264 metadata (VOD playback works) and `SELECT * FROM video_record_details` shows non-zero rows in `vss-vios-postgres`.
- **End-to-end VOD captioning (Topology A + B):** confirm RT-VLM can read a VIOS-recorded file by submitting `POST /v1/files` to RT-VLM with the file path from VIOS — the shared bind mount makes it visible at the RT-VLM container path `${VST_CONTAINER_ROOT}/streamer_videos`.
