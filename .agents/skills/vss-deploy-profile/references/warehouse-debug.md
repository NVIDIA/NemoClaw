# Warehouse Debug Reference

Live debugging of an **already-running** VSS Warehouse deployment. Triage container health, perception FPS, GPU/CPU/disk resources, broker connectivity, and (3D / MV3DT) BEV camera timestamp synchronization via Elasticsearch. Identify root cause, propose a fix, then ask the user before applying it.

Companion to `warehouse.md`. Use this reference when the stack is already up but something is wrong — low FPS, containers restarting, streams missing, BEV out of sync, or general unhealthy state. For first-time install / redeploy / tear-down, go to `warehouse.md`.

Reference tables (container map, deps, log patterns, ES indices, GPU layout, endpoints, BEV thresholds) are in the top half; operational triage phases are in the bottom half.

---

## Container Dependency Chain

Failures propagate downstream. Always triage in this order — a broken upstream container is the root cause of all containers below it failing.

```
broker (kafka / redis)
  └── vss-broker-health-check
        └── vss-vios-nvstreamer
              └── vss-rtvi-cv                  (perception — 2D RT-DETR or 3D Sparse4D, same container)
                    ├── vss-rtvi-cv-sdr        (stream data router)
                    ├── vss-rtvi-cv-config-adaptor (3D only — DeepStream config adaptor)
                    ├── vss-configurator       (blueprint / stream / hardware config)
                    └── vss-behavior-analytics (ROI, tripwire, proximity events)
                          └── (extended only: logstash, kibana, vss-video-analytics-api)

MV3DT variant (MODE=mv3dt) — same dependency shape, all containers use -mv3dt suffix:
  broker → vss-broker-health-check → vss-vios-nvstreamer-mv3dt
    → mosquitto (MQTT)
      → vss-rtvi-cv-bev-fusion
        → vss-rtvi-cv-mv3dt (per-camera perception)
    → vss-configurator-mv3dt
    → vss-behavior-analytics-mv3dt

Warehouse Auto-Calibration (BP_PROFILE=bp_wh_auto_calib) — minimal footprint:
  vss-vios-nvstreamer / vss-vios-nvstreamer-mv3dt → vss-configurator / vss-configurator-mv3dt
                      → vss-auto-calibration + vss-auto-calibration-ui
  (no broker, no perception, no analytics)

VST (VIOS) stack — independent of perception, feeds RTSP into it:
  vss-vios-postgres → vss-vios-sensor / vss-vios-streamprocessing
                    → vss-vios-ingress
                    → sdr-controller  (from services/infra/sdrc/ — combined WDM controller + Envoy
                                       router on :10000; replaces the deprecated vss-vios-sdr +
                                       vss-vios-envoy pair. vss-vios-mcp was also removed.)

elasticsearch — deployed when: BP_PROFILE=bp_wh (always; vss-agent storage), OR kafka/redis with MINIMAL_PROFILE="" (extended; ELK + bounding-box overlays + analytics API; any mode).
NOTE: minimal does NOT deploy ES — so the mdx-bev index isn't persisted and Phase 5 BEV-sync check has no data to read (applies to 3D and MV3DT).

bp_wh-only stack (RTVI VLM + agent):
  vss-rtvi-vlm                                  (RTVI VLM — always local, hardcoded in compose profile bp_wh_2d; VLM_MODE=none)
  vss-alert-bridge ← depends on vss-rtvi-vlm
  LLM NIM (varies — see below)
  vss-agent ← depends on LLM, vios
  vss-agent-ui ← depends on vss-agent
  vss-va-mcp
  phoenix

vss-haproxy-ingress — bp_wh OR kafka/redis extended (front-door on HAPROXY_PORT)
```

## Full Container List by Profile

`MODE` (`2d` / `3d` / `mv3dt`) and `BP_PROFILE` (`bp_wh` / `bp_wh_kafka` / `bp_wh_redis` / `bp_wh_auto_calib`) select the active mode-specific compose-profile slice. Perception, behavior analytics, nvstreamer, and most other services use the **same container names** in 2D and 3D — no `-2d` / `-3d` suffix. MV3DT uses a **`-mv3dt` suffix** on all its containers (`vss-vios-nvstreamer-mv3dt`, `vss-behavior-analytics-mv3dt`, `vss-rtvi-cv-mv3dt`, `vss-configurator-mv3dt`, `vss-video-analytics-api-mv3dt`).

### Warehouse CV core (2D and 3D profiles)

| Container | Role |
|---|---|
| `kafka` or `redis` (`STREAM_TYPE`) | Message broker |
| `vss-broker-health-check` | Gate — waits for broker before releasing dependents |
| `vss-vios-nvstreamer` | RTSP stream server |
| `vss-rtvi-cv` | DeepStream perception (RT-DETR for 2D, Sparse4D for 3D) |
| `vss-rtvi-cv-sdr` | Stream data router |
| `vss-rtvi-cv-config-adaptor` | DeepStream config adaptor (3D only) |
| `vss-configurator` | Stream and hardware config |
| `vss-behavior-analytics` | ROI / tripwire / proximity analytics |
| `vss-vios-postgres` / `-sensor` / `-streamprocessing` / `-ingress` + `sdr-controller` (from `services/infra/sdrc/`) | VST stack (legacy `-sdr` / `-mcp` / `-envoy` removed; SDR + Envoy roles now consolidated in `sdr-controller`) |

### MV3DT CV core (`bp_wh_kafka_mv3dt` / `bp_wh_redis_mv3dt`)

| Container | Role |
|---|---|
| `kafka` or `redis` (`STREAM_TYPE`) | Message broker |
| `vss-broker-health-check` | Gate — waits for broker before releasing dependents |
| `vss-vios-nvstreamer-mv3dt` | RTSP stream server |
| `vss-rtvi-cv-mv3dt` | DeepStream perception (per-camera) |
| `vss-rtvi-cv-bev-fusion` | BEV Fusion — fuses per-camera detections into unified 3D BEV frame |
| `mosquitto` | MQTT broker for cross-camera messaging |
| `vss-configurator-mv3dt` | Stream and hardware config |
| `vss-behavior-analytics-mv3dt` | 3D spatial analytics |
| `vss-vios-postgres` / `sensor-ms-mv3dt` (container `vss-vios-sensor`) / `-streamprocessing` / `-ingress` + `sdr-controller` (from `services/infra/sdrc/`) | VST stack (legacy `-sdr` / `-mcp` / `-envoy` removed; SDR + Envoy roles now consolidated in `sdr-controller`) |

### Warehouse Auto-Calibration (`bp_wh_auto_calib`)

| Container | Role |
|---|---|
| `vss-vios-nvstreamer` / `vss-vios-nvstreamer-mv3dt` | RTSP stream server |
| `vss-configurator` / `vss-configurator-mv3dt` | Blueprint configurator |
| `vss-auto-calibration` / `vss-auto-calibration-ui` | Camera auto-calibration |
| VST stack (subset) | Stream management for calibration |

Only `auto_calib`, `bp_wh_auto_calib_2d`, `bp_wh_auto_calib_3d`, and `bp_wh_auto_calib_mv3dt` start the auto-calibration containers. Regular `bp_wh`, `bp_wh_kafka`, and `bp_wh_redis` profiles do not.

> **2D:** Auto-Calibration adds blank `group` and `region` fields to `calibration.json`; remove those fields before redeploying. They are not required for 2D calibration.

> **3D / MV3DT:** When deploying calibration for 3D or MV3DT modes, generated calibration files must include a populated `sensors[].group` object on every camera sensor. For MV3DT, after generating `calibration.json`, also run the utility scripts under `tools/rtvi-cv-mv3dt-utils` to refresh `camInfo/<sensor_id>.yml`, `pub_sub_info_config.yml`, and the tracker `ObjectModelProjection.cameraModelFilepath` mappings. Then run camera clustering with `--n_clusters 1` for the standard single-BEV warehouse setup, and verify the group field is present under sensors in `calibration.json`. Use `auto_calib` to upload videos directly, or `bp_wh_auto_calib_3d` / `bp_wh_auto_calib_mv3dt` to calibrate against RTSP streams. See [Calibration Generation](warehouse.md#calibration-generation).

```bash
CALIBRATION_JSON=/path/to/calibration.json
REPO_ROOT=/path/to/video-search-and-summarization
SDU_DIR="${REPO_ROOT}/libs/analytics/spatialai-data-utils"
SENSOR_COUNT=$(jq '.sensors | length' "${CALIBRATION_JSON}")

PYTHONPATH="${SDU_DIR}:${PYTHONPATH:-}" python3 \
  "${SDU_DIR}/tools/camera_grouping/create_camera_clusters.py" \
  "${CALIBRATION_JSON}" \
  --max_camera_per_group "${SENSOR_COUNT}" \
  --n_clusters 1 \
  --disable_param_tuning \
  --overwrite
```

### Extended profile only (`MINIMAL_PROFILE=""`, any mode) — adds

| Container | Role |
|---|---|
| `logstash` | Log ingestion pipeline |
| `kibana` | Dashboard UI |
| `vss-video-analytics-api` / `vss-video-analytics-api-mv3dt` | REST API for analytics data |

`elasticsearch`, `kibana`, `logstash`, `vss-video-analytics-api` are also deployed for `BP_PROFILE=bp_wh` (always — independent of `MINIMAL_PROFILE`). See [Phase 1](#phase-1-stack-snapshot) for the consolidated trigger table.

### `bp_wh` only — adds

| Container | Role |
|---|---|
| `vss-rtvi-vlm` | Real-time VLM (Cosmos Reason) — **always local**, hardcoded in compose profile `bp_wh_2d`. Warehouse uses RTVI VLM instead of the standalone VLM NIM path, so `VLM_MODE=none` and `VLM_NAME_SLUG=none`. `vss-agent` connects to RTVI VLM directly |
| `vss-alert-bridge` | Drives realtime VLM alerts (POST/DELETE `/api/v1/realtime`) |
| LLM NIM (container name = `LLM_NAME_SLUG`, e.g. `nvidia-nemotron-nano-9b-v2`) | LLM inference — only when `LLM_MODE=local` / `local_shared` |
| `vss-agent` | Orchestrator |
| `vss-agent-ui` | Next.js UI |
| `vss-va-mcp` | Video Analysis MCP server |
| `vss-haproxy-ingress` | Front-door on `HAPROXY_PORT` (default `7777`). Also deployed in kafka/redis extended (proxies kibana + analytics API there) |
| `phoenix` | Telemetry / observability |

> **No VLM NIM container.** VSS has two VLM paths: standalone VLM NIM (`VLM_MODE` / `VLM_NAME_SLUG`) and integrated RTVI VLM (`vss-rtvi-vlm`). Warehouse uses **RTVI VLM only** — `vss-agent` connects to it directly. `VLM_MODE=none` in the warehouse `.env`. Do not search for a VLM NIM container — it does not exist in this stack.

## Container Health Check Settings

| Container | Start period | Interval | Retries | Impact if failing |
|---|---|---|---|---|
| `vss-broker-health-check` | 10 s | 5 s | 12 | All downstream containers will not start |
| `vss-configurator` | **60 s** | 10 s | 6 | Streams not configured — perception gets no input |
| `vss-rtvi-cv` | 30 s | 10 s | 6 | No detections produced |
| `elasticsearch` | 30 s | 10 s | 5 | BEV index unavailable (3D); no overlays (2D extended); agent storage broken |

> `vss-configurator` failing in the **first 60 seconds** is expected — do not flag this as an error.

## Key Log Patterns and Root Causes

| Log string | Container | Root cause |
|---|---|---|
| `model not found` / `No such file` | `vss-rtvi-cv` | `VSS_DATA_DIR` wrong or models not present |
| `CUDA out of memory` | `vss-rtvi-cv` / LLM NIM / `vss-rtvi-vlm` | Too many streams or wrong device assignment — reduce `NUM_STREAMS` or change device IDs |
| `GST pipeline error` / `Failed to start pipeline` | `vss-rtvi-cv` | No valid RTSP input — check `vss-vios-nvstreamer` first |
| `Connection refused` on broker port | `vss-broker-health-check` | Kafka/Redis not listening — broker crashed |
| `RTSP connection failed` / `Cannot open resource` | `vss-vios-nvstreamer` | RTSP source (camera / video file) unreachable |
| `Health check failed` (after 60 s) | `vss-configurator` | Stream config bad — check `.env` `BP_PROFILE` and `NUM_STREAMS` |
| `authentication required` / `401` | any | `NGC_CLI_API_KEY` invalid or expired |
| `no space left on device` | any | Disk full — free space before redeploy |
| `OOMKilled` (exit code 137) | any | Container OOM — check RAM (`free -h`) and GPU memory |

> **Don't `docker restart vss-rtvi-cv` to "fix" stream issues during normal operation.** The SDR-to-CV stream re-registration after a CV restart is fragile — it often drops streams instead of recovering them. If perception is misbehaving, better to do a full clean redeploy.

## Elasticsearch Indices

| Index | Written by | Contains | Used for |
|---|---|---|---|
| `mdx-bev` | `vss-behavior-analytics` (3D) / `vss-behavior-analytics-mv3dt` (MV3DT) | BEV frame data, camera timestamps in `info`, detected objects | 3D / MV3DT BEV sync check, object history |
| `mdx-raw` | perception via broker | Raw detection events per frame | Debugging detection pipeline |
| `mdx-events` | `vss-behavior-analytics` | ROI / tripwire / proximity events | Event history and UI |

Query latest record from any index:

```bash
curl -s "http://localhost:9200/<index>/_search?size=1" \
  -H 'Content-Type: application/json' \
  -d '{"sort":[{"timestamp":{"order":"desc"}}]}' | python3 -m json.tool | head -60
```

Check index health:

```bash
curl -s "http://localhost:9200/_cat/indices?v"
```

## Kafka / Redis Topic Reference

| Topic | Producer | Consumer | Contains |
|---|---|---|---|
| `mdx-raw` | `vss-rtvi-cv` | `vss-behavior-analytics` | Raw bounding boxes + tracking IDs per frame |
| `mdx-events` | `vss-behavior-analytics` | downstream / UI | ROI, tripwire, proximity events |
| `mdx-vlm-incidents` | `vss-rtvi-vlm` | `vss-alert-bridge`, `vss-agent` | Realtime VLM incident detections (`bp_wh` only) |

**Check messages are flowing (Kafka):**

```bash
docker exec kafka kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 \
  --topic mdx-raw --from-beginning --max-messages 5 2>/dev/null
```

**Check messages are flowing (Redis):**

```bash
docker exec redis redis-cli XREVRANGE mdx-raw + - COUNT 3
```

## GPU Device Assignment

| Role | `.env` variable | Default device | Notes |
|---|---|---|---|
| RT-CV perception (RT-DETR for 2D, Sparse4D for 3D, BEV Fusion for MV3DT) | `RT_CV_DEVICE_ID` | `0` | Always local |
| RTVI VLM | `RT_VLM_DEVICE_ID` | `1` | Always local; `bp_wh` only |
| LLM NIM (dedicated) | `LLM_DEVICE_ID` | `2` | `bp_wh` + `LLM_MODE=local` |
| LLM NIM colocated with RTVI VLM | `SHARED_LLM_VLM_DEVICE_ID` | `2` | `bp_wh` + `LLM_MODE=local_shared` |

`LLM_MODE`: `local` | `local_shared` | `remote` | `none`. RTVI VLM has no mode — always deployed locally for `bp_wh`. `bp_wh_auto_calib` profiles uses no GPU for perception or LLM.

Check per-GPU process load:

```bash
nvidia-smi --query-compute-apps=gpu_uuid,pid,process_name,used_gpu_memory \
  --format=csv,noheader
```

## Service Access Points

Expected access points after a successful deploy.

**Standard (bare-metal / VM with reachable IP):**

```
HAProxy:             http://<host_ip>:7777
Kibana:              http://<host_ip>:7777/kibana
VST:                 http://<host_ip>:30888/vst/
Grafana:             http://<host_ip>:35000
NvStreamer:          http://<host_ip>:31000
Video Analytics API: http://<host_ip>:7777/video-analytics-api
```

**Brev (secure-link domain):**

```
Access Points (Brev):

HAProxy:             https://7777-<BREV_ENV_ID>.brevlab.com
VSS UI:              https://7777-<BREV_ENV_ID>.brevlab.com
Kibana:              https://7777-<BREV_ENV_ID>.brevlab.com/kibana
VST:                 https://30888-<BREV_ENV_ID>.brevlab.com/vst/
NvStreamer:          https://31000-<BREV_ENV_ID>.brevlab.com
Video Analytics API: https://7777-<BREV_ENV_ID>.brevlab.com/video-analytics-api

Brev Secure Links — each exposed port requires its own secure-link hostname:
  Port 7777  (HAProxy)    → https://7777-<BREV_ENV_ID>.brevlab.com
  Port 30888 (VST)        → https://30888-<BREV_ENV_ID>.brevlab.com
  Port 31000 (NvStreamer)  → https://31000-<BREV_ENV_ID>.brevlab.com
  Port 35000  (Grafana)     → https://35000-<BREV_ENV_ID>.brevlab.com

HAProxy-routed paths (/, /kibana, /api, /chat, /websocket, /alert-bridge,
/video-analytics-api, /phoenix, /va-mcp, /static) all go through
the port-7777 secure link. Direct-port services (VST, NvStreamer, Grafana)
each need their own secure link opened in the Brev dashboard.
```

If URLs still show the old `http://...:7777` form, the `VSS_PUBLIC_*` overrides were not applied — see [`warehouse.md` § Brev Secure Link Overrides](warehouse.md#brev-secure-link-overrides).

VST is accessed directly on port `30888` — it does not go through the HAProxy ingress.

For the full HAProxy ingress route table, direct-port diagnostics table, and
the `h_main` Host-header ACL rules, see
[`warehouse.md` § Access Points](warehouse.md#access-points). The canonical
tables live there to avoid drift when ports/services change.

## BEV Sync Thresholds

| Drift | Status |
|---|---|
| ≤ 34 ms | SYNCHRONIZED — healthy |
| 34 ms – 67 ms | WARNING — monitor; may affect 3D fusion accuracy |
| > 67 ms | OUT OF SYNC — restart `vss-vios-nvstreamer` / `vss-vios-nvstreamer-mv3dt`; verify RTSP sources |

## Documentation Reference

- Warehouse overview: https://docs.nvidia.com/vss/3.2.0/warehouse-docs/warehouse-toc.html
- 2D profile: https://docs.nvidia.com/vss/3.2.0/warehouse-docs/2D-profile.html
- 2D profile with Agents: https://docs.nvidia.com/vss/3.2.0/warehouse-docs/2D-profile-with-agents.html
- 3D profile: https://docs.nvidia.com/vss/3.2.0/warehouse-docs/3D-profile.html
- RT-DETR model (2D): https://docs.nvidia.com/vss/3.2.0/warehouse-docs/RT-DETR.html
- Sparse4D model (3D): https://docs.nvidia.com/vss/3.2.0/warehouse-docs/Sparse4D.html

---

## Setup

Before starting, collect two pieces of information (ask if unknown):

1. **`<repo>`** — path to the `video-search-and-summarization` checkout. All compose / cleanup commands run from `<repo>/deploy/docker/`, with `--env-file industry-profiles/warehouse-operations/.env`. Treat `<repo>` as a placeholder you replace before running each command (or `export REPO=<absolute-path>` and use `$REPO`).
2. **`MODE`** — `2d`, `3d`, or `mv3dt`. Detect from the running perception container:

```bash
docker inspect vss-rtvi-cv --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
  | grep -i "^MODE="
```

If that returns nothing (container not running or named differently), fall back to reading the env file:

```bash
grep "^MODE=" $REPO/deploy/docker/industry-profiles/warehouse-operations/.env
```

`vss-rtvi-cv` is the same container in 2D and 3D — you cannot tell them apart by container name alone. MV3DT uses `vss-rtvi-cv-mv3dt` instead — if that container exists, MODE is `mv3dt`.

---

## Phase 1: Stack Snapshot

Get the full picture of what is and isn't running.

```bash
echo "=== Stack Snapshot: $(date) ==="
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.RunningFor}}\t{{.Ports}}'
echo ""
echo "--- Exited / missing containers ---"
docker ps -a --filter "status=exited" --filter "status=dead" \
  --format 'table {{.Names}}\t{{.Status}}\t{{.ExitCode}}'
```

**Expected `Up` containers (flag any missing or restarting):**

| Profile | Required containers |
|---|---|
| 2D / 3D profiles | broker (`kafka` or `redis`), `vss-broker-health-check`, `vss-vios-nvstreamer`, `vss-rtvi-cv`, `vss-rtvi-cv-sdr`, `vss-configurator`, `vss-behavior-analytics`, the `vss-vios-*` VST stack |
| 3D extra | `vss-rtvi-cv-config-adaptor` |
| MV3DT profiles | broker, `vss-broker-health-check`, `vss-vios-nvstreamer-mv3dt`, `vss-rtvi-cv-mv3dt`, `vss-rtvi-cv-bev-fusion`, `mosquitto`, `vss-configurator-mv3dt`, `vss-behavior-analytics-mv3dt`, the `vss-vios-*` VST stack |
| `bp_wh_auto_calib` | `vss-vios-nvstreamer` / `vss-vios-nvstreamer-mv3dt`, `vss-configurator` / `vss-configurator-mv3dt`, `vss-auto-calibration`, `vss-auto-calibration-ui`, VST stack (subset) — no broker, no perception, no analytics |
| `bp_wh` extra | `vss-rtvi-vlm`, `vss-alert-bridge`, `vss-agent`, `vss-agent-ui`, `vss-va-mcp`, `phoenix`, LLM NIM (container name = `LLM_NAME_SLUG`) when `LLM_MODE=local` / `local_shared` |
| Extended (kafka/redis, any mode) extra | `logstash`, `kibana`, `vss-video-analytics-api` / `vss-video-analytics-api-mv3dt` |
| `vss-haproxy-ingress` | `BP_PROFILE=bp_wh`, **or** kafka/redis extended (any mode) |
| `elasticsearch` | `BP_PROFILE=bp_wh` (always), **or** kafka/redis with `MINIMAL_PROFILE=""` (extended, any mode). **Minimal does NOT deploy ES** |

Record which containers are **Down**, **Restarting**, or have a non-zero exit code — these are the primary suspects.

---

## Phase 2: Perception FPS

Check whether perception is producing output.

**2D / 3D** — same container regardless of MODE:

```bash
echo "--- Perception FPS (last 60 s) ---"
docker logs --since 60s vss-rtvi-cv 2>&1 | grep -i fps | tail -10
```

**MV3DT** — check per-camera perception and BEV Fusion separately:

```bash
echo "--- MV3DT Per-Camera Perception FPS ---"
docker logs --since 60s vss-rtvi-cv-mv3dt 2>&1 | grep -i fps | tail -10
echo "--- BEV Fusion FPS ---"
docker logs --since 60s vss-rtvi-cv-bev-fusion 2>&1 | grep -i fps | tail -10
```

- **FPS lines present and non-zero** → perception is running; issue is likely downstream (broker, analytics, BEV sync).
- **No FPS lines** → perception is stalled or not receiving streams. Proceed to Phase 3.
- **FPS present but very low** → GPU saturation or stream count too high. Check Phase 4.
- **MV3DT: per-camera FPS OK but BEV Fusion FPS zero** → MQTT messaging issue; check `mosquitto` container.

---

## Phase 3: Per-Container Log Triage

For each container that is **Down**, **Restarting**, or suspected from Phase 1/2, run:

```bash
docker logs --tail 80 <container-name> 2>&1
```

Work through this order — earlier failures often cause downstream ones:

### 3.1 Broker

```bash
# Kafka
docker logs --tail 50 kafka 2>&1 | grep -E "ERROR|WARN|Exception" | tail -20
# Redis
docker logs --tail 50 redis 2>&1 | grep -E "ERROR|WARNING" | tail -20
```

If broker is unhealthy, all downstream services will fail. Fix broker first.

### 3.2 NvStreamer (VST source feed)

```bash
docker logs --tail 80 vss-vios-nvstreamer 2>&1 | grep -E "ERROR|error|fail|RTSP" | tail -20
```

Errors here → streams are not being served → perception gets no input.

### 3.3 Perception

**2D / 3D:**

```bash
docker logs --tail 100 vss-rtvi-cv 2>&1 | grep -E "ERROR|error|fail|GST|pipeline|model" | tail -30
```

**MV3DT:**

```bash
docker logs --tail 100 vss-rtvi-cv-mv3dt 2>&1 | grep -E "ERROR|error|fail|GST|pipeline|model" | tail -30
docker logs --tail 100 vss-rtvi-cv-bev-fusion 2>&1 | grep -E "ERROR|error|fail" | tail -20
docker logs --tail 50 mosquitto 2>&1 | grep -E "ERROR|error|fail" | tail -10
```

Common issues:
- `model not found` → `$VSS_DATA_DIR/models/` is missing or wrong path.
- `GST pipeline error` → stream input issue; check `vss-vios-nvstreamer` first.
- `CUDA out of memory` → GPU saturation; reduce `NUM_STREAMS`.
- MV3DT: MQTT connection errors in `vss-rtvi-cv-mv3dt` → check `mosquitto` container first.

### 3.4 Perception SDR + Config Adaptor

```bash
docker logs --tail 50 vss-rtvi-cv-sdr 2>&1 | grep -E "ERROR|error|fail" | tail -20
# 3D only:
docker logs --tail 50 vss-rtvi-cv-config-adaptor 2>&1 | grep -E "ERROR|error|fail" | tail -20
```

### 3.5 Configurator

```bash
# 2D / 3D / mv3dt:
docker logs --tail 50 vss-configurator 2>&1 | grep -E "ERROR|error|fail" | tail -20
# MV3DT:
docker logs --tail 50 vss-configurator-mv3dt 2>&1 | grep -E "ERROR|error|fail" | tail -20
```

Note: `vss-configurator` / `vss-configurator-mv3dt` has a **60 s start period** — a health-check failure in the first minute is expected.

### 3.6 Behavior Analytics

```bash
# 2D / 3D:
docker logs --tail 50 vss-behavior-analytics 2>&1 | grep -E "ERROR|error|fail" | tail -20
# MV3DT:
docker logs --tail 50 vss-behavior-analytics-mv3dt 2>&1 | grep -E "ERROR|error|fail" | tail -20
```

### 3.7 VST / VIOS stack

```bash
for c in vss-vios-postgres vss-vios-sensor vss-vios-streamprocessing vss-vios-ingress sdr-controller; do
  echo "=== $c ==="
  docker logs --tail 30 "$c" 2>&1 | grep -E "ERROR|error|fail" | tail -10
done
```

### 3.8 `bp_wh` extras (RTVI VLM + agent)

Skip unless `BP_PROFILE=bp_wh`.

```bash
docker logs --tail 50 vss-rtvi-vlm     2>&1 | grep -E "ERROR|error|fail|CUDA" | tail -20
docker logs --tail 50 vss-alert-bridge 2>&1 | grep -E "ERROR|error|fail"      | tail -20
docker logs --tail 50 vss-agent        2>&1 | grep -E "ERROR|error|fail"      | tail -20
docker logs --tail 50 vss-agent-ui     2>&1 | grep -E "ERROR|error|fail"      | tail -20
docker logs --tail 50 vss-haproxy-ingress 2>&1 | grep -E "ERROR|error|fail"   | tail -20
# LLM NIM container name = LLM_NAME_SLUG from .env (e.g. nvidia-nemotron-nano-9b-v2)
# Warehouse industry-profile compose commands read from .env directly
# (no generated.env flow — that pattern is only for dev-profile-*).
LLM_SLUG=$(grep '^LLM_NAME_SLUG=' "$REPO/deploy/docker/industry-profiles/warehouse-operations/.env" | cut -d= -f2 | tr -d '"')
docker logs --tail 50 "$LLM_SLUG" 2>&1 | grep -E "ERROR|error|fail|CUDA" | tail -20
```

---

## Phase 4: System Resources

```bash
echo "=== System Resources: $(date) ==="

echo "--- GPU ---"
nvidia-smi --query-gpu=index,name,utilization.gpu,utilization.memory,memory.used,memory.total \
  --format=csv,noheader

echo "--- CPU ---"
top -bn1 | grep "Cpu(s)"

echo "--- Memory ---"
free -h

echo "--- Disk ---"
df -h / /tmp 2>/dev/null
```

**Flag these as root causes if observed:**

| Finding | Root cause |
|---|---|
| GPU memory usage ≥ 90 % | Too many streams for the GPU — reduce `NUM_STREAMS`, or move LLM/VLM to a different `LLM_DEVICE_ID` / `RT_VLM_DEVICE_ID` |
| GPU utilization sustained at 100 % | Same as above |
| Disk < 10 GB free on `/` | Insufficient space — containers may fail to write logs or temp files |
| RAM < 8 GB free | Memory pressure — broker or analytics OOM likely |

---

## Phase 5 (3D / MV3DT extended only): BEV Camera Timestamp Sync

For `MODE=3d` or `MODE=mv3dt` **with `MINIMAL_PROFILE=""` (extended)**, check that all cameras contributing to the BEV frame are synchronized. Skip this phase in 3D/MV3DT minimal: `elasticsearch` is not deployed there, so `mdx-bev` is never persisted and the query below will fail with a connection error.

```bash
curl -s "http://localhost:9200/mdx-bev/_search?size=1" \
  -H 'Content-Type: application/json' \
  -d '{"sort":[{"timestamp":{"order":"desc"}}]}' | \
python3 - << 'EOF'
import json, sys
from datetime import datetime

data = json.load(sys.stdin)
hits = data.get("hits", {}).get("hits", [])
if not hits:
    print("mdx-bev: no records found — Elasticsearch may be down or index empty")
    sys.exit(0)

src = hits[0]["_source"]
info = src.get("info", {})
record_ts = src.get("timestamp", "unknown")

timestamps = {}
for cam, ts in info.items():
    try:
        timestamps[cam] = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except Exception:
        pass

if not timestamps:
    print("mdx-bev: no valid camera timestamps in info field")
    sys.exit(0)

times = list(timestamps.values())
min_ts, max_ts = min(times), max(times)
drift_ms = (max_ts - min_ts).total_seconds() * 1000

print(f"mdx-bev record timestamp : {record_ts}")
print(f"Cameras checked          : {len(timestamps)}")
print(f"Earliest                 : {min_ts.isoformat()}")
print(f"Latest                   : {max_ts.isoformat()}")
print(f"Max drift                : {drift_ms:.1f} ms")

if drift_ms <= 34:
    print("STATUS: SYNCHRONIZED")
elif drift_ms <= 67:
    print("STATUS: WARNING — drift 34–67 ms, monitor closely")
    for cam, ts in sorted(timestamps.items(), key=lambda x: x[1]):
        delta = (ts - min_ts).total_seconds() * 1000
        print(f"  {cam}: {ts.isoformat()}  (+{delta:.1f} ms)")
else:
    print("STATUS: OUT OF SYNC — drift exceeds 67 ms")
    for cam, ts in sorted(timestamps.items(), key=lambda x: x[1]):
        delta = (ts - min_ts).total_seconds() * 1000
        print(f"  {cam}: {ts.isoformat()}  (+{delta:.1f} ms)")
EOF
```

- **SYNCHRONIZED** (≤ 34 ms) → BEV fusion healthy; issue is elsewhere.
- **WARNING** (34–67 ms) → minor drift; monitor. Check `docker logs vss-vios-nvstreamer` (3D) / `docker logs vss-vios-nvstreamer-mv3dt` (MV3DT) for lagging streams.
- **OUT OF SYNC** (> 67 ms) → restart `vss-vios-nvstreamer` / `vss-vios-nvstreamer-mv3dt`; verify RTSP source health for drifting cameras.
- **No records found** → `elasticsearch` container may be down or the `mdx-bev` index has not been written to yet.

---

## Phase 6: Root Cause Summary

After completing Phases 1–5, state the root cause clearly before proposing any action. Use this decision table:

| Evidence | Root cause | Proposed fix |
|---|---|---|
| Container exited, exit code non-zero | Container crash — see its logs | Fix config or missing file; redeploy |
| `model not found` in `vss-rtvi-cv` logs | `VSS_DATA_DIR` path wrong or models not present | Correct `.env` path or re-acquire app data (see `warehouse.md` Phase 4) |
| `CUDA out of memory` on `vss-rtvi-cv` | Too many streams for GPU | Reduce `NUM_STREAMS`; redeploy |
| `CUDA out of memory` on LLM NIM or `vss-rtvi-vlm` | LLM and RTVI VLM colliding on the same GPU | Adjust `LLM_DEVICE_ID` / `RT_VLM_DEVICE_ID` / `SHARED_LLM_VLM_DEVICE_ID`; redeploy |
| Broker (Kafka/Redis) down | All downstream services lose messaging | Fix broker; redeploy |
| `vss-vios-nvstreamer` / `vss-vios-nvstreamer-mv3dt` errors / no RTSP | Streams not reaching perception | Fix stream config; redeploy |
| BEV OUT OF SYNC (3D / MV3DT) | One or more camera feeds lagging | Restart `vss-vios-nvstreamer` / `vss-vios-nvstreamer-mv3dt`; check camera RTSP sources |
| `mosquitto` down / MQTT connection refused (MV3DT) | Cross-camera messaging broken — BEV Fusion cannot receive per-camera detections | Fix mosquitto container; redeploy |
| `vss-rtvi-cv-bev-fusion` OOM or no output (MV3DT) | BEV Fusion cannot fuse per-camera detections | Check GPU memory; reduce cameras or streams; redeploy |
| GPU 100 % sustained, low FPS | GPU oversaturated | Reduce `NUM_STREAMS`; redeploy |
| Disk < 10 GB | Write failures / container OOM | Free disk space; redeploy |
| `vss-configurator` failing after 60 s | Misconfigured streams or hardware profile | Verify `.env` values; redeploy |
| `vss-haproxy-ingress` up but UI 502 / report links broken | `EXTERNAL_IP` / `HAPROXY_PORT` not browser-reachable | Set `EXTERNAL_IP` to a real reachable hostname (see `warehouse.md` Phase 5); redeploy |
| Brev: UI loads but API calls fail / mixed-content errors in browser console | `VSS_PUBLIC_*` overrides not applied — browser-facing URLs still use `http://7777-<BREV_ENV_ID>.brevlab.com:7777` instead of `https://7777-<BREV_ENV_ID>.brevlab.com` | Apply [Brev secure link overrides](warehouse.md#brev-secure-link-overrides): set `VSS_PUBLIC_HTTP_PROTOCOL=https`, `VSS_PUBLIC_WS_PROTOCOL=wss`, `VSS_PUBLIC_HOST=7777-<BREV_ENV_ID>.brevlab.com`, `VSS_PUBLIC_PORT=443`; redeploy |
| Brev: HAProxy returns 404 on all paths | `Host:` header in the request doesn't match HAProxy `h_main` ACL | Verify `VSS_PUBLIC_HOST` matches the Brev secure-link domain (`7777-<BREV_ENV_ID>.brevlab.com`); redeploy |
| Brev: WebSocket chat connection refused / falls back to HTTP | `VSS_PUBLIC_WS_PROTOCOL` still set to `ws` instead of `wss`, or `VSS_PUBLIC_PORT` not `443` | Fix the `.env` overrides and redeploy |
| `error from registry: Incorrect Repository Format` during `docker compose up` | Docker 29.x multi-arch pull regression | Pin to Docker 28.3.3 and Docker Compose v2.39.1+ (warehouse.md §2.2). |

Present the summary in this format:

```
=== Debug Summary ===
Root cause : <one-line description>
Evidence   : <which container / log line / metric revealed it>
Proposed fix: <what needs to change>
Requires redeploy: yes / no
```

---

## Phase 7: Redeploy (if required)

**Ask the user before taking any action:**

> "Root cause identified: `<root cause>`. Proposed fix: `<fix>`. Should I apply the fix and redeploy now? (yes / no)"

Only proceed on explicit **"yes"**.

If yes:

1. Apply the fix (edit `<repo>/deploy/docker/industry-profiles/warehouse-operations/.env` or correct the missing resource).
2. Tear down:

```bash
cd <repo>/deploy/docker
docker compose -f compose.yml --env-file industry-profiles/warehouse-operations/.env down
docker volume prune -f
docker system prune -f
bash ./scripts/cleanup_all_datalog.sh -e industry-profiles/warehouse-operations/.env
```

3. Bring up:

```bash
LOG=${LOG:-/tmp/warehouse-blueprint.log}
cd <repo>/deploy/docker
printf '%s' "$NGC_CLI_API_KEY" | docker login --username '$oauthtoken' --password-stdin nvcr.io
nohup docker compose -f compose.yml \
  --env-file industry-profiles/warehouse-operations/.env \
  up --detach --pull always --force-recreate --build \
  > "$LOG" 2>&1 &
echo "Compose PID $! — logging to $LOG"
```

4. Monitor until all required containers show `Up`:

```bash
tail -20 "$LOG"
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
```

5. Re-run **Phase 2** (FPS check) and, for 3D / MV3DT, **Phase 5** (BEV sync) to confirm the issue is resolved.

If the issue persists after redeploy, consult the [Documentation Reference](#documentation-reference) links above and `warehouse.md` → Troubleshooting.

