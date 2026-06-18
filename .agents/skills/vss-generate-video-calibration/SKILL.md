---
name: vss-generate-video-calibration
description: Use to run AutoMagicCalib on local MP4s, RTSP, or the bundled sample dataset, and to deploy vss-auto-calibration when needed. Do not use for non-AMC calibration or runtime analytics.
license: Apache-2.0
metadata:
  version: "3.2.0"
  github-url: "https://github.com/NVIDIA-AI-Blueprints/video-search-and-summarization"
  tags: "nvidia blueprint operational"
---
## Purpose

Run AutoMagicCalib end-to-end on local files, RTSP streams, or the bundled sample dataset and (when needed) deploy the AMC microservice.

## Instructions

Follow the routing tables and step-by-step workflows below. Each section that ends in *workflow*, *quick start*, or *flow* is intended to be executed top-to-bottom. Detailed reference material lives in `references/`; load only the reference needed for the selected input mode.

## Examples

Worked end-to-end examples are kept under `evals/` (each `*.json` manifest contains a runnable scenario) and inline in the per-workflow `curl` blocks below. Run a Tier-3 evaluation with `nv-base validate <this-skill-dir> --agent-eval` to replay them.

## Limitations

- Requires the matching VSS profile / microservice to be deployed and reachable from the caller.
- NGC-hosted models and NIMs may be subject to rate-limits, GPU memory requirements, and license restrictions.
- Concurrency, GPU memory, and storage limits depend on the host hardware and the profile's compose file.

## Troubleshooting

- **Error**: REST call returns connection refused. **Cause**: target microservice not running. **Solution**: probe `/docs` or `/health`; redeploy via `vss-deploy-profile` or the matching `vss-deploy-*` skill.
- **Error**: HTTP 401/403 from NGC pulls. **Cause**: missing/expired `NGC_CLI_API_KEY`. **Solution**: `docker login nvcr.io` and re-export the key before retrying.
- **Error**: container OOM or model fails to load. **Cause**: insufficient GPU memory for the selected profile. **Solution**: switch to a smaller variant or free GPUs via `docker compose down`.

# VSS Generate Video Calibration

Run AutoMagicCalib over one of three input sources and drive the calibration through the microservice REST API. The input-resolution work differs per source; everything from `verify_project` onward is identical and lives in this file. Pick the right input-mode reference and pair it with the [Shared Calibration Tail](#shared-calibration-tail) below.

Shared helper references are loaded only when needed:
- Read [`references/common-steps.md`](references/common-steps.md) when a mode reference needs the shared `create_project`, video-upload, or handoff snippets.
- Read [`references/calibration-tail.md`](references/calibration-tail.md) when you need the reusable Python implementation of the verify → calibrate → poll → results tail.

## Input Routing

Match the user's request to a mode, then load that mode's reference for input collection, mode-specific API calls, and the full Python script.

| User says / has | Mode | Reference |
|---|---|---|
| "launch AMC" / "deploy auto-calibration" / "set up auto-magic-calib" / "start AMC microservice" | `deploy` | [`references/deploy-auto-calibration-service.md`](references/deploy-auto-calibration-service.md) |
| "calibrate my videos" / "calibrate from video files" / local `cam_*.mp4` files | `videos` | [`references/videos.md`](references/videos.md) |
| "calibrate RTSP streams" / "calibrate from live cameras" / live RTSP URLs | `rtsp` | [`references/rtsp.md`](references/rtsp.md) |
| "test sample dataset" / "verify AMC install" / "launch and test" | `sample-dataset` | [`references/sample-dataset.md`](references/sample-dataset.md) |

**Disambiguation rule:** if the user is asking to launch / deploy / set up AMC (no calibration verb) → `deploy`. If they provide RTSP URLs → `rtsp`. If they mention local files / a videos directory → `videos`. If they ask to verify install or test the bundled sample → `sample-dataset`. Combined intents (e.g. "launch AMC and calibrate my videos") → walk `deploy` first, then the calibration mode. When ambiguous, ask via `AskUserQuestion`.

## Prerequisites (shared across calibration modes)

- AMC microservice + UI running. If not, walk [`references/deploy-auto-calibration-service.md`](references/deploy-auto-calibration-service.md) first.
- Microservice reachable at `http://<HOST_IP>:${VSS_AUTO_CALIBRATION_PORT:-8010}/v1/ready` → `{"code":0,...}`.
- Projects directory writable by the container user. If you didn't just deploy (so Step 5 of the deploy reference hasn't run), confirm the write test in [`references/deploy-auto-calibration-service.md` § Step 5](references/deploy-auto-calibration-service.md#step-5--confirm-the-projects-directory-is-writable) — otherwise the first `create_project` returns `[Errno 13] Permission denied`.
- Python 3 with `requests` installed (each input-mode reference includes a self-healing venv fallback for direct runs).

Mode-specific prerequisites (VIOS for `rtsp`, sample zip for `sample-dataset`) live in the respective references.

## Shared Calibration Tail

The verify → calibrate → poll → results sequence is identical regardless of input mode. After the mode-specific reference has uploaded videos / ingested RTSP clips / uploaded the bundled sample, run this tail. Use [`references/calibration-tail.md`](references/calibration-tail.md) for the shared Python snippet.

### Step A — Verify Project

```
POST /v1/verify_project/<project_id>
```

Response: `{"project_state": "READY"}` — must be `READY` before calibrating. If not READY, re-check that videos + alignment + layout are present (either via API or via UI manual alignment).

### Step B — Start Calibration

**Confirm the plan before calibrating.** Whether the settings file and detector were auto-detected or asked, present a short summary and confirm via `AskUserQuestion` before the `POST /calibrate`. The resolved values are the defaults, so confirming is one click — but the user can switch the detector or skip an auto-detected settings file. Summarize:

- **Detector** — `resnet` or `transformer` (the value to be sent).
- **Calibration settings** — the file being applied (path), or default parameters (with the option to tune them in the UI first — see below).
- **Optional overrides** — ground-truth zip and focal lengths, if any.

The sample-dataset install-check run uses a fixed `resnet` and can proceed without this confirmation.

```
POST /v1/calibrate/<project_id>
Content-Type: application/json

{"detector_type": "resnet"}   # or "transformer"
```

`detector_type` is a separate `/calibrate` parameter — **not** consumed by `/v1/config/<id>`. If the user provided a calibration settings file, parse it for `"detector"` / `"detector_type"` and use that value. If the file doesn't specify one, the default (`resnet`) is the value shown in the confirmation above — the user can switch it there before calibrating. If there's no settings file at all, ask the user via `AskUserQuestion`:

- `resnet` — default, fast.
- `transformer` — slower, better under heavy occlusion.

UI Step 3 (Parameters) does NOT cover detector choice; never assume the user picked one in the UI.

**Also when there's no settings file, ask whether to tune the calibration parameters first** (`AskUserQuestion`):

- **Proceed with the default parameters** — well-suited to typical warehouse scenes; recommended unless the user has specific tuning in mind.
- **Adjust parameters in the UI first** — open the project, go to Step 3: Parameters, change values, and click Save; then continue.

Wait for the user's choice — and, if they choose to tune, for them to confirm they've Saved — before calling `/calibrate`.

### Step C — Poll for Completion

```
GET /v1/get_project_info/<project_id>
```

Poll every 10 s. `project_info.project_state`:

| State | Meaning |
|---|---|
| `RUNNING` | Calibration in progress |
| `COMPLETED` | Finished |
| `ERROR` | Failed — pull log via `GET /v1/amc/calibrate/<id>/log` |

When calibration starts, surface the project ID, the UI URL (`http://<HOST_IP>:${VSS_AUTO_CALIBRATION_UI_PORT:-5000}`), and the log endpoint so the user can watch progress while the run proceeds. During `RUNNING`, emit a progress line at least once a minute with elapsed time so a long run doesn't look stalled. On `ERROR`, fetch and show the last lines of `GET /v1/amc/calibrate/<id>/log` before stopping. Live logs can also be streamed via `GET /v1/calibrate/<project_id>/log/<type>/stream`.

Typical time: **10–60 min** (your-own videos), **10–30 min** (bundled sample).

### Step D — Results

```
GET /v1/get_project_info/<project_id>                    # project state
GET /v1/result/<project_id>/evaluation_statistics        # only if GT uploaded
GET /v1/result/<project_id>/overlay_image                # visual overlay (PNG)
GET /v1/amc/calibrate/<project_id>/log                   # calibration log
```

Evaluation response includes `Average L2 distance(m)` and `Average reprojection error 0(px)`. Evaluation metrics are produced **only when a ground-truth `GT.zip` was uploaded** — a missing `evaluation_statistics` result is normal otherwise and is not the end of result reporting.

After `COMPLETED`, always give the user a way to review the result for that exact project, regardless of whether metrics exist:

- **UI** — `http://<HOST_IP>:${VSS_AUTO_CALIBRATION_UI_PORT:-5000}`; open the project, then the Results page to view the overlay.
- **Overlay image on disk** — `${VSS_APPS_DIR}/services/auto-calibration/projects/project_<id>/output/multi_view_results/BA_output/results_ba_scaled_world/overlay_img_*.png` (single-camera projects use `output/single_view_results/cam_00/verification_map_overlay.png`).
- **Project files** — `${VSS_APPS_DIR}/services/auto-calibration/projects/project_<id>/`.

### Step E — VGGT Refinement

After the AMC run completes, always check `vggt_state` in project info. VGGT model staging is optional during setup and must not block the AMC result, but post-AMC handling follows the state:

- If `vggt_state == "READY"` and the user explicitly requested VGGT refinement or staged VGGT during this setup flow, run VGGT refinement without asking again.
- If `vggt_state == "READY"` but VGGT was already staged before this request and the user has not asked for VGGT-refined output, ask via `AskUserQuestion` whether to run refinement before starting it.
- If VGGT is not ready, skip refinement and mention that VGGT refinement is available after staging the model (see [`references/deploy-auto-calibration-service.md`](references/deploy-auto-calibration-service.md) Step 2).

```
POST /v1/vggt/calibrate/<project_id>
GET  /v1/get_project_info/<project_id>                    # poll vggt_state
GET  /v1/vggt_results/<project_id>/evaluation_statistics  # VGGT metrics
```

## Settings File + Detector Pattern

Optional across all three modes. When the user provides a JSON settings file (typically exported from UI Step 3 Download), POST it verbatim:

```
POST /v1/config/<project_id>
Content-Type: application/json

<file contents, posted as-is>
```

The file replaces what the user would otherwise tune in UI Step 3 (rectification, bundle-adjustment, evaluation knobs, detector, …). After a successful POST, **also** parse the file for `"detector"` / `"detector_type"` — if it's `"resnet"` or `"transformer"`, use that value for the `/calibrate` call in Step B (detector is a separate API parameter, not consumed by `/config`).

Non-2xx is surfaced — do not silently fall back. Skip this call entirely if the user chose the UI-fallback path.

## UI Fallback Pattern

When alignment / layout files aren't on disk, direct the user to the appropriate AMC UI step:

- **Settings missing** → "Open UI project `<project_id>`, go to **Step 3: Parameters**, tune via the settings dialog (or accept defaults), click Save." **Also**: before the `/calibrate` call, ask the user via `AskUserQuestion` whether to use the `resnet` or `transformer` detector — Step 3 doesn't cover detector choice.
- **Layout missing** → "Open UI project `<project_id>`, go to **Step 2: Video Configuration**, upload `layout.png` only (do NOT re-upload videos — they're already attached via API/RTSP), click Save."
- **Alignment missing** → "Open UI project `<project_id>`, go to **Step 4: Alignment**, either upload `alignment_data.json` or mark correspondence points on the layout, click Save."

Wait for user confirmation. For alignment/layout, verify on disk before continuing:

```bash
# Project state lives under $VSS_APPS_DIR/services/auto-calibration/projects
# (the path bind-mounted into the MS container in
#  deploy/docker/services/auto-calibration/ms/compose.yml).
HOST_PROJECTS="${VSS_APPS_DIR}/services/auto-calibration/projects"

ls "$HOST_PROJECTS/project_<project_id>/manual_adjustment/"
# Expected: alignment_data.json, layout.png
```

## Success Criteria

- `project_state == "COMPLETED"` after polling.
- If manual alignment was used: `${VSS_APPS_DIR}/services/auto-calibration/projects/project_<id>/manual_adjustment/` contains `alignment_data.json` + `layout.png`.
- If GT was uploaded: evaluation returns typical thresholds (`Average L2 distance(m)` < 1.5, `Average reprojection error 0(px)` < 5 for your data; < 10 for the bundled sample).
- No `ERROR` state.

## Key Output Files

Under `${VSS_APPS_DIR}/services/auto-calibration/projects/project_<project_id>/`:

```
project_<project_id>/
├── manual_adjustment/
│   ├── alignment_data.json
│   └── layout.png
├── output/
│   ├── single_view_results/cam_XX/
│   │   ├── camInfo_hyper_XX.yaml
│   │   └── trajDump_Stream_0_3d.txt
│   ├── multi_view_results/BA_output/results_ba/
│   │   ├── initial/camInfo_XX.yaml
│   │   └── refined/camInfo_XX.yaml          # ← final calibration
│   └── multi_view_results/BA_output/results_ba_scaled_world/
│       └── overlay_img_XX.png               # ← visual overlay for review
└── calibration.log
```

## Cross-cutting Troubleshooting

Mode-specific issues live in each reference's own troubleshooting table.

| Issue | Fix |
|---|---|
| `verify_project` state not `READY` | Confirm videos uploaded/ingested and alignment + layout are present (either via API or via UI manual alignment). Mode-specific upload steps in the reference. |
| Manual alignment files missing after UI step | User didn't click Save; also verify `${VSS_APPS_DIR}/services/auto-calibration/projects/project_<id>/manual_adjustment/` exists. |
| Calibration stuck `RUNNING` > 90 min | `GET /v1/amc/calibrate/<id>/log` — usually insufficient tracklets (scene too static). See "Custom Dataset" guidelines in root `README.md`. |
| Immediate `ERROR` state | Check video naming: must be `cam_00.mp4`, `cam_01.mp4`, … contiguous (videos mode) / camera_name labels (RTSP mode). |
| Low L2 but high reprojection | Provide explicit `focal_length` override during input upload (see videos / rtsp references). |
| VGGT `INIT`, never `READY` | VGGT model not loaded — see [`references/deploy-auto-calibration-service.md`](references/deploy-auto-calibration-service.md) Step 2. |
| Upload timeout | Large videos — bump `timeout=300` to e.g. `600` in the per-mode Python script. |
| Port scan finds no backend | Backend not running — walk [`references/deploy-auto-calibration-service.md`](references/deploy-auto-calibration-service.md) first. |

## For Downstream Skills — MV3DT Export

Downstream consumers (e.g. a Multi-View 3D Tracking skill owned by another team) fetch the MV3DT-format calibration output directly from the microservice. This skill returns the `project_id`; the downstream skill calls:

```
GET /v1/result/{project_id}/mv3dt_result?result_type=amc
# Response: application/zip — mv3dt_output.zip containing transforms.yml
```

For VGGT-refined output (only available if VGGT ran to `COMPLETED`, see Step E):

```
GET /v1/result/{project_id}/mv3dt_result?result_type=vggt
# Response: application/zip — vggt_mv3dt_output.zip
```

Downstream skill flow:
1. Call this skill with the user's inputs; capture the printed `project_id`.
2. Wait for the skill to return (it polls until `COMPLETED` internally).
3. `GET /v1/result/{project_id}/mv3dt_result?result_type=amc` — save the ZIP locally.
4. If VGGT also ran, optionally fetch `?result_type=vggt` for the refined MV3DT.

## Related Skills

- [`vss-manage-video-io-storage`](../vss-manage-video-io-storage/SKILL.md) — VIOS API skill; only the `rtsp` calibration mode depends on VIOS being reachable.

Root `README.md` "Custom Dataset" and "Calibration Workflow (UI)" sections document input-video guidelines and the UI-driven alternative to this API flow.

bump:1
