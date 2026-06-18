---
name: vss-deploy-detection-tracking-3d
description: >
  Deploy and operate the RTVI-CV-3D microservice as MV3DT (`MODE=mv3dt`):
  per-camera DeepStream perception plus BEV Fusion over calibrated cameras.
  Supports the bundled sample dataset, custom video files, and RTSP streams,
  and chains to `vss-generate-video-calibration` when calibration is missing.
  Use `vss-deploy-profile` for the full warehouse blueprint and
  `vss-deploy-detection-tracking-2d` for single-camera 2D detection.
license: Apache-2.0
metadata:
  version: "3.2.0"
  github-url: "https://github.com/NVIDIA-AI-Blueprints/video-search-and-summarization"
  tags: "nvidia blueprint rtvi-cv-3d mv3dt detection tracking 3d warehouse"
---

## Purpose

Deploy and operate the RTVI-CV-3D microservice as MV3DT (`MODE=mv3dt`) — per-camera DeepStream perception plus BEV Fusion over multiple calibrated cameras — on the bundled sample dataset, custom videos, or live RTSP, without the full warehouse agent / LLM / VLM stack.

## Instructions

Work top-to-bottom: answer the routing questions (Q0–Q3) under [Routing](#routing), then follow the reference for the chosen path. Detailed step-by-step procedures live in `references/` (deploy, calibration chain, camera configuration, verification, teardown, troubleshooting).

## Examples

- Enable multi-camera tracking on the sample dataset.
- Deploy RTVI-CV-3D on my videos here: `<path/to/videos>`.
- Run MV3DT on RTSP streams after calibration.

# VSS Deploy Detection & Tracking — 3D (RTVI-CV-3D / MV3DT)

Bring up the RTVI-CV-3D microservice as the MV3DT stack (`MODE=mv3dt`) from the warehouse blueprint: per-camera DeepStream perception (`vss-rtvi-cv-mv3dt`) + BEV Fusion (`vss-rtvi-cv-bev-fusion`) + mosquitto MQTT bus + broker + VST sensor stack — without the agent / LLM / VLM stack that comes with the full warehouse blueprint.

The actual compose machinery lives in `deploy/docker/industry-profiles/warehouse-operations/warehouse-mv3dt-app/`. This skill drives the env overrides, calibration chain, and verification.

## Routing

Ask the user **at most four questions**, then dispatch.

### Q0 — Profile size (overlays or not)

Default to **extended** unless the user explicitly asks for minimal. Extended deploys ELK + `vss-video-analytics-api-mv3dt` + `vss-kibana-init-mv3dt` + `vss-import-calibration-output-mv3dt` on top of MV3DT core — these are what the VST video wall needs to render bounding-box overlays. Without them, the video wall works but shows raw streams without overlays.

| User answer | `MINIMAL_PROFILE` | What you get | When to choose |
|---|---|---|---|
| **extended** (default) | `""` | MV3DT core + ELK + analytics API + Kibana. **Overlays work in VST video wall.** Recommended for a complete e2e experience. | "I want the full e2e experience", "I want to see bounding boxes", or no preference stated |
| **minimal** | `"true"` | MV3DT core only. ~5 fewer containers. **No overlays in VST.** Metadata still on Kafka/Redis. | "I only need the data", "edge / Thor host", "minimum footprint" |

> **Note on selective ELK:** there's no "minimal + ELK only" middle path in the current compose. Every `${MINIMAL_PROFILE:+_extended}`-gated service comes up together (ES, Logstash, Kibana, video-analytics-api, kibana-init, import-calibration). `bash`'s `:+` parameter expansion produces the `_extended` suffix when `MINIMAL_PROFILE` is set; extended switches the gating string back to plain `bp_wh_kafka_mv3dt` which the active compose profile already matches. Either you accept the full extended bundle or you stay minimal.

### Q1 — Data source

Ask this unless the source is explicit in the user's first message. A bare request
like "deploy rtvi-cv-3d" routes to this MV3DT skill (`MODE=mv3dt`), but does
**not** imply `sample`.

- **sample** — the bundled 4-camera synthetic dataset (`warehouse-4cams-20mx20m-synthetic`). Calibration ships in-tree; no AMC run needed.
- **videos** — the user has local video files (any `*.mp4` named after their cameras). Standalone AMC (`auto_calib` profile) will run if calibration is missing.
- **rtsp** — the user has live RTSP URLs. Calibration via VIOS-driven AMC; final deploy also needs a Sensor Info File (`camera_info.json`) with those RTSP URLs.

### Q2 — Calibration coverage (skip for `sample`)

For `videos` and `rtsp`, check whether calibration is already on disk at the mount path the perception container expects:

```bash
DATASET="${SAMPLE_VIDEO_DATASET:?}"          # the user's dataset slug; see Q3
CAL_DIR="${VSS_APPS_DIR}/industry-profiles/warehouse-operations/warehouse-mv3dt-app/calibration/sample-data/${DATASET}"

# Look for ANY of: calibration.json, plus camInfo/*.yml or *.yaml with either
# 'cam_*' or 'Camera*' naming (the shipped sample uses Camera*.yml, AMC may
# produce cam_*.yaml — broaden accordingly)
test -f "${CAL_DIR}/calibration.json" \
  && ls "${CAL_DIR}/camInfo/"*.{yml,yaml} 2>/dev/null
```

If the user supplied a calibration path themselves, validate that path instead — don't recompute. See `configure-cameras.md` for camera-name normalization and authoritative camera-count discovery (parses `calibration.json`).

### Q3 — Detector + dataset slug (only when Q2 triggers AMC)

- `resnet` (default, fast) or `transformer` (slower, better under occlusion) — passed to the AMC `/v1/calibrate/<id>` API at Step B (see `vss-generate-video-calibration/SKILL.md:48-62`).
- A short kebab-case dataset slug used as `SAMPLE_VIDEO_DATASET` (e.g. `customer-aisle-4cams`). This drives the calibration mount path and gets persisted in `.env`.

### Routing table

| Q1 | Q2 result | Path |
|---|---|---|
| `sample` | (cal ships in-tree and already normalized) | [`references/deploy-rtvi-cv-3d-stack.md`](references/deploy-rtvi-cv-3d-stack.md) directly |
| `videos` | cal present | [`references/configure-cameras.md`](references/configure-cameras.md) → [`references/deploy-rtvi-cv-3d-stack.md`](references/deploy-rtvi-cv-3d-stack.md) |
| `videos` | cal missing | [`references/calibration-workflow.md`](references/calibration-workflow.md) (videos mode) → [`references/configure-cameras.md`](references/configure-cameras.md) → [`references/deploy-rtvi-cv-3d-stack.md`](references/deploy-rtvi-cv-3d-stack.md) |
| `rtsp` | cal present | [`references/configure-cameras.md`](references/configure-cameras.md) → [`references/deploy-rtvi-cv-3d-stack.md`](references/deploy-rtvi-cv-3d-stack.md) |
| `rtsp` | cal missing | [`references/calibration-workflow.md`](references/calibration-workflow.md) (rtsp mode) → [`references/configure-cameras.md`](references/configure-cameras.md) → [`references/deploy-rtvi-cv-3d-stack.md`](references/deploy-rtvi-cv-3d-stack.md) |

Every path converges on [`references/verify-and-view.md`](references/verify-and-view.md) once `up -d` completes. [`references/troubleshooting.md`](references/troubleshooting.md) and [`references/teardown.md`](references/teardown.md) are linked but off the happy path.

**Disambiguation rule.** In this skill, "RTVI-CV-3D" means the MV3DT microservice deployment and uses `MODE=mv3dt`. Route to [`../vss-deploy-profile/references/warehouse.md`](../vss-deploy-profile/references/warehouse.md) only when the user asks for the full warehouse blueprint, Sparse4D, `MODE=3d`, or `warehouse-3d-app`. This skill is for **MV3DT only** without the agent stack / LLM / VLM.

## Prerequisites

### 1. Repo path

Locate `video-search-and-summarization/` on disk. All compose commands run from `<repo>/deploy/docker/`. If unknown, ask the user.

### 2. NGC CLI + key

`$NGC_CLI_API_KEY` must be set and must have access to `nvidia/vss-core/*` images. See `vss-deploy-profile/references/ngc.md` for setup if missing.

If the user previously ran `ngc config set` but `$NGC_CLI_API_KEY` isn't exported in this shell, the key is already on disk:

```bash
NGC_CLI_API_KEY=$(awk -F'= ' '/^apikey/{print $2}' ~/.ngc/config 2>/dev/null)
test -n "${NGC_CLI_API_KEY}" && echo "key sourced from ~/.ngc/config"
```

Make sure the key value also lands in `industry-profiles/warehouse-operations/.env:164` (`NGC_CLI_API_KEY=...`) — compose only reads it from there at `up` time, not from your shell env.

### 3. `HARDWARE_PROFILE` slug

> The public MV3DT supported stream counts are listed in the Warehouse Quickstart Guide under "MV3DT Vision AI Profile Supported Deployment Options." Use the matching `HARDWARE_PROFILE` slug below.

Pick from `nvidia-smi --query-gpu=name --format=csv,noheader`:

| GPU name | `HARDWARE_PROFILE` | MV3DT supported streams |
|---|---|---|
| RTX PRO 6000 Blackwell | `RTXPRO6000BW` | 18 |
| H100 (NVL, SXM HBM3) | `H100` | 13 |
| L40S | `L40S` | 7 |
| IGX Thor | `IGX-THOR` | 4 |
| DGX Spark | `DGX-SPARK` | 4 |

If the user's GPU is not listed here, check `industry-profiles/warehouse-operations/.env` for available `HARDWARE_PROFILE` values, then confirm the matching profile exists in `blueprint-configurator/blueprint_config.yml` before using it. Do not infer a stream count from the slug alone.

**The per-GPU MV3DT cap is enforced at deploy time.** `vss-configurator-mv3dt` computes `final_stream_count = min(NUM_STREAMS, max_streams_supported)` and applies a `keep_count` file-management op against `${VSS_DATA_DIR}/videos/${SAMPLE_VIDEO_DATASET}/` so only `final_stream_count` `.mp4` files remain (sorted lexicographically, last N kept). If your GPU's MV3DT supported stream count (above table) is below your camera count, perception / `mdx-raw` / `mdx-bev` run with the supported stream count. Either pick a GPU with a higher supported stream count or surface the cap explicitly to the user so they're aware which streams will be processed.

### 4. App data on disk

`VSS_DATA_DIR` must point at the **extracted `vss-warehouse-app-data` directory** (separate from the repo). Pointing it at the repo's `deploy/docker/` causes the deploy to stall: the configurator can't find the dataset, redis can't open its log file, and perception stays in `Created`. Verify the path before deploy.

Pre-flight check before deploy:

```bash
DATA_DIR="${VSS_DATA_DIR:?VSS_DATA_DIR not set in .env}"
DATASET="${SAMPLE_VIDEO_DATASET:-warehouse-4cams-20mx20m-synthetic}"

for sub in videos models data_log; do
  test -d "${DATA_DIR}/${sub}" || { echo "ERROR: ${DATA_DIR}/${sub} missing"; exit 1; }
done

# For sample / videos modes — videos directory must exist
test -d "${DATA_DIR}/videos/${DATASET}" \
  || { echo "ERROR: ${DATA_DIR}/videos/${DATASET} missing — wrong slug or app-data not extracted"; exit 1; }

# Sanity: video count should match calibration count.
# Some published app-data tarballs are known to ship the sample dataset with
# fewer videos than the dataset name implies — verify and source any missing
# cams separately if your GPU's mv3dt cap is high enough to use them all.
ls "${DATA_DIR}/videos/${DATASET}/"*.mp4 2>/dev/null | wc -l

# Ensure every per-service subdir under data_log/ exists. kafka / elasticsearch /
# redis / postgres and the video-analytics API upload path (`/web-api-app/files`)
# run as non-root UIDs against these bind mounts. Without write access the daemons
# or calibration/image import can fail with permission errors.
mkdir -p \
  "${DATA_DIR}/data_log/analytics_cache" \
  "${DATA_DIR}/data_log/calibration_toolkit" \
  "${DATA_DIR}/data_log/elastic/data" \
  "${DATA_DIR}/data_log/elastic/logs" \
  "${DATA_DIR}/data_log/kafka" \
  "${DATA_DIR}/data_log/redis/data" \
  "${DATA_DIR}/data_log/redis/log" \
  "${DATA_DIR}/data_log/vss_video_analytics_api"

# Grant write access to the specific container UIDs only — scoped ACLs, NOT 777 and
# NOT chown. UIDs (per data-directory.md): postgres=70, redis=999, elasticsearch / VST /
# kafka=1000. The first call covers existing files; the second sets *default* ACLs so
# files/dirs the daemons create at runtime (e.g. postgres PGDATA) inherit the access.
ACL='u:70:rwx,u:999:rwx,u:1000:rwx'
setfacl -R    -m "$ACL" "${DATA_DIR}/data_log"
setfacl -R -d -m "$ACL" "${DATA_DIR}/data_log"
```

> **Scoped ACLs, not `chmod 777`.** This grants only the known container UIDs access — it does
> **not** make `data_log` world-writable, and it does **not** `chown` (which would break postgres /
> Elasticsearch, since they re-own their dirs on first start). Prefer this for agent-driven runs and
> shared hosts. The canonical [`../vss-deploy-profile/references/data-directory.md`](../vss-deploy-profile/references/data-directory.md)
> documents the broad `chmod -R 777` and the per-container UID table; this skill uses the scoped-ACL
> equivalent instead. **Ask the user for confirmation before changing host permissions.**
>
> Requires a POSIX-ACL filesystem (ext4 / xfs — the default) and the `acl` package (`setfacl`). If a
> daemon still logs a permission error after deploy, find its UID
> (`docker inspect <container> --format '{{.Config.User}}'`) and add `-m u:<uid>:rwx` to both calls.

If app-data isn't extracted yet: download via `ngc registry resource download-version "nvidia/vss-warehouse/vss-warehouse-app-data:<version>"` and `tar -xvf` (see [`references/deploy-rtvi-cv-3d-stack.md`](references/deploy-rtvi-cv-3d-stack.md) for tag discovery and full steps).

### 5. Pre-flight (system)

`nvidia-smi`, NVIDIA Docker runtime visible (`docker info | grep -i runtimes`), and `docker run --rm --gpus all ubuntu:24.04 nvidia-smi` all green. Full driver / kernel / sysctl checks live in `vss-deploy-profile/references/prerequisites.md`.

If any check fails, fix before continuing — don't proceed to deploy.

### 6. Browser reachability (cloud / corp-VPN hosts only)

If the user will view the VST video wall through a browser on a different network than the deploy host (cloud VM, corp VPN, ssh-tunnelled session), upstream firewall rules may block VST WebRTC (STUN to `stun.l.google.com:19302`, plus random UDP for media). See [`references/verify-and-view.md#browser-reachability`](references/verify-and-view.md) for symptoms and workarounds. Also: some hosts block the AMC microservice's default port (TCP/8010); if the user reports the AMC UI on `:5000` works but its data calls fail, retry with a different `VSS_AUTO_CALIBRATION_PORT`.

## Troubleshooting

When any deploy, calibration, or verification step fails, stop and classify the failure before retrying. The quick checks below cover the most common MV3DT errors; use [`references/troubleshooting.md`](references/troubleshooting.md) for full diagnostic commands and fixes, [`../vss-generate-video-calibration/SKILL.md`](../vss-generate-video-calibration/SKILL.md) for AMC workflow failures, and [`../vss-deploy-profile/references/warehouse-debug.md`](../vss-deploy-profile/references/warehouse-debug.md) for broader warehouse-stack issues.

| Symptom | Likely cause | First check or fix |
|---|---|---|
| `vss-rtvi-cv-bev-fusion` is unhealthy or `/tmp/fusion_ready` is missing | Broker not ready, `MAX_EXPECTED_SENSORS` mismatch, or `STREAM_TYPE` mismatch | Check `broker-health-check`, `docker inspect --format '{{.State.Health.Status}}' vss-rtvi-cv-bev-fusion`, and `mdx-raw` / `mdx-bev`; then re-run [`references/configure-cameras.md`](references/configure-cameras.md) if stream counts differ |
| Perception shows `Active sources : 0`, no FPS, or fewer cameras than expected | Stale VST sensor state, wrong dataset slug, missing calibration, or per-GPU stream cap | Verify `SAMPLE_VIDEO_DATASET`, `NUM_STREAMS`, `camInfo/`, and the VST sensor list; if old sensors remain, follow [`references/teardown.md`](references/teardown.md) before redeploying |
| `vss-rtvi-cv-mv3dt` exits with `MqttCommunicator` "invalid node" or tracker submit failures | Camera names in videos, `calibration.json`, and `camInfo/` do not match the `Camera`, `Camera_01`, ... convention | Normalize all camera names together with [`references/configure-cameras.md`](references/configure-cameras.md) Step 0, then clear stale VST state and redeploy |
| AMC project creation, upload, calibration, or MV3DT export fails | AutoMagicCalib service/API issue outside this MV3DT deploy path | Use [`../vss-generate-video-calibration/SKILL.md`](../vss-generate-video-calibration/SKILL.md) to deploy/debug AMC, then return to [`references/calibration-workflow.md`](references/calibration-workflow.md) after export succeeds |
| `vss-behavior-analytics-mv3dt` restarts with calibration schema validation errors | AMC export has empty `group`, `region`, or `place` fields | Apply the placeholder patch in [`references/calibration-workflow.md`](references/calibration-workflow.md) Step 4a, or populate those fields in AMC before export |
| Extended profile has no overlays and `vss-import-calibration-output-mv3dt` logs `imageMetadata.json not found` | AMC MV3DT export did not produce `images/Top.png` and `images/imageMetadata.json` | Synthesize both files with [`references/calibration-workflow.md`](references/calibration-workflow.md) Step 4b, then restart the one-shot importer |
| Image pulls, model load, or first-start engine build fail | Missing / expired `NGC_CLI_API_KEY`, incorrect `VSS_DATA_DIR`, missing BodyPose3DNet files, or GPU OOM | Re-check NGC auth, confirm `${VSS_DATA_DIR}/models/mv3dt/BodyPose3DNet/`, tail `vss-rtvi-cv-mv3dt` logs, and free or change `RT_CV_DEVICE_ID` if the GPU is exhausted |

Before destructive recovery (`docker compose down -v`, clearing `data_log`, deleting VST sensor state, or changing host ACLs), explain the impact and get user confirmation. Capture the failing command, relevant `.env` values, `docker compose ps`, and the last container logs before making state-reset changes.

## How it fits together

```
SKILL.md (this file — Q0/Q1/Q2/Q3 routing)
  └─ if cal missing ─> calibration-workflow.md
  │                     └─ chains to vss-generate-video-calibration (deploy + drive API)
  │                     └─ fetches /v1/result/{project_id}/mv3dt_result?result_type=amc (plus vggt when refinement is enabled)
  │                     └─ lands calibration files at warehouse-mv3dt-app/calibration/sample-data/<slug>/
  ├─> configure-cameras.md (camera-name normalization, NUM_STREAMS sync, VST sensor trim)
  └─> deploy-rtvi-cv-3d-stack.md (compose up with bp_wh_kafka_mv3dt + extended/minimal)
        └─> verify-and-view.md (FPS, fusion_ready, mdx-bev, VST video wall + WebRTC checks)
```

## Related Skills

- [`vss-generate-video-calibration`](../vss-generate-video-calibration/SKILL.md) — the AMC skill. Owns AMC deployment, RTSP capture, calibration API, and the `/v1/result/.../mv3dt_result` export hook this skill consumes. `calibration-workflow.md` chains into it.
- [`vss-deploy-profile`](../vss-deploy-profile/SKILL.md) — cross-profile umbrella. Use that instead when the user wants the **full warehouse blueprint** (with agents / LLM / VLM), not just MV3DT.
- [`vss-manage-video-io-storage`](../vss-manage-video-io-storage/SKILL.md) — VIOS / VST API skill. Useful for the VST video wall (overlay viz) and for sensor management referenced in `configure-cameras.md`.

The repo's authoritative warehouse-blueprint reference at [`../vss-deploy-profile/references/warehouse.md`](../vss-deploy-profile/references/warehouse.md) covers 2D / 3D / MV3DT inside the full warehouse stack — this skill is the **MV3DT-only** companion that trims the agent / LLM / VLM layer.
