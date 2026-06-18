# vss-generate-video-calibration — RTSP Mode (live camera streams)

Load this reference when the user wants to calibrate from **live RTSP camera streams**. The MS records each stream through VIOS, ingests the recorded clips, then runs the normal AMC calibration. Skip to the [Shared Calibration Tail](../SKILL.md#shared-calibration-tail) in SKILL.md once the RTSP capture + ingest is done and alignment/layout are uploaded.

For local MP4s instead, see `videos.md`. For verifying the install with the bundled sample, see `sample-dataset.md`.

## Mode-specific Prerequisites

- **VIOS is running and reachable** — Step 1 probes the default port `30888` first, then falls back to `VIOS_BASE_URL` from the MS container env / compose files. If none work, point the user at the ``vss-manage-video-io-storage`` (see `../../vss-manage-video-io-storage/SKILL.md`) skill, else ask them to deploy VIOS.
- **MS knows where VIOS is** — `VIOS_BASE_URL` is set in the MS container's environment (auto-wired from `${VST_INTERNAL_URL}` under `bp_wh_*` blueprints; otherwise set explicitly in [`deploy/docker/industry-profiles/warehouse-operations/.env`](../../../deploy/docker/industry-profiles/warehouse-operations/.env)). Required at runtime; Step 1 only uses the 30888 probe to detect whether VIOS is up locally.
- **RTSP URLs reachable from the VIOS host** — verify with the user before starting capture.

The shared prerequisites (AMC microservice, Python+requests) come from the SKILL.md [Prerequisites](../SKILL.md#prerequisites-shared-across-calibration-modes) section.

## Step 1 — Verify VIOS Is Reachable

Confirm VIOS is up before doing anything else. Probe in this order — stop at the first hit:

```bash
export REPO_ROOT=$(git rev-parse --show-toplevel)
VIOS_BASE_URL=""

# 1a. Default port probe — standard VIOS one-click deployment listens on 30888.
if curl -sf http://localhost:30888/vst/api/v1/sensor/list >/dev/null 2>&1; then
  # Use HOST_IP from the warehouse-operations env (not `localhost` — the MS container can't reach host `localhost`)
  ENV_FILE="$REPO_ROOT/deploy/docker/industry-profiles/warehouse-operations/.env"
  HOST_IP=$(grep ^HOST_IP "$ENV_FILE" 2>/dev/null | cut -d= -f2)
  VIOS_BASE_URL="http://${HOST_IP:-localhost}:30888"
  echo "VIOS detected at default port: $VIOS_BASE_URL"
fi

# 1b. Fallback — VIOS_BASE_URL from the running MS container env (authoritative if set).
if [ -z "$VIOS_BASE_URL" ]; then
  VIOS_BASE_URL=$(docker exec vss-auto-calibration printenv VIOS_BASE_URL 2>/dev/null)
fi

# 1c. Fallback — grep compose files (useful when MS isn't running yet).
if [ -z "$VIOS_BASE_URL" ]; then
  VIOS_BASE_URL=$(grep -hR '^\s*-\?\s*VIOS_BASE_URL' "$REPO_ROOT/deploy/docker/services/auto-calibration" 2>/dev/null \
    | sed -E 's/.*VIOS_BASE_URL[=:]\s*//' | head -1)
fi

# 1d. Confirm VIOS actually responds at whatever URL we resolved.
if [ -n "$VIOS_BASE_URL" ]; then
  curl -sf "${VIOS_BASE_URL}/vst/api/v1/sensor/list" >/dev/null \
    && echo "VIOS up at $VIOS_BASE_URL" \
    || { echo "VIOS_BASE_URL=$VIOS_BASE_URL is set but not responding"; VIOS_BASE_URL=""; }
fi
```

**If VIOS still can't be reached** (all four checks failed):
1. Look for a VIOS setup skill: `ls skills/ | grep -i vios`. If found (e.g. `vios`), invoke it.
2. Otherwise, ask the user to deploy VIOS and share the base URL via `AskUserQuestion`. Do **not** proceed until `${VIOS_BASE_URL}/vst/api/v1/sensor/list` returns 200.

**If VIOS was detected on 30888 but the MS container env is unset**, the capture endpoint will still return 503 until `VIOS_BASE_URL` is set. The cleanest fix is to deploy alongside a `bp_wh_*` blueprint (which auto-wires it from `${VST_INTERNAL_URL}`). Otherwise set `VIOS_BASE_URL=http://<HOST_IP>:30888` in [`deploy/docker/industry-profiles/warehouse-operations/.env`](../../../deploy/docker/industry-profiles/warehouse-operations/.env) and re-run `docker compose --env-file ... up -d` from `deploy/docker/`.

## Step 2 — Collect Inputs From User

### Required
1. **RTSP URLs** — one per camera. Example: `rtsp://<nvstreamer-host>:31556/stream/cam_00.mp4` or `rtsp://user:pass@<cam-ip>:554/stream`.
2. **Camera names** — short label per stream (used as `camera_name` in the capture request), e.g. `cam_00`, `cam_01`, …
3. **Duration seconds** — recording window (minimum `60`). Pick at least 2–3 min of moving objects for decent calibration.
4. **Microservice URL** — e.g. `http://<HOST_IP>:8010`.
5. **Project name** — short descriptive string.

### Anchor-File Pattern (ask config first, then auto-scan its dir for alignment)

Because there's no local videos directory to anchor the scan, ask the user for the **calibration settings file** first. Then look in its directory for alignment/layout:

| File | Order |
|---|---|
| Calibration settings | Ask the user for a path. When provided, this file replaces the entire UI Step 3 Parameters dialog. If they don't have a file, skip to UI Step 3 **and** explicitly ask which detector to use. See [Settings File + Detector Pattern](../SKILL.md#settings-file--detector-pattern) for the parsing rule. |
| Alignment JSON | If a config path was given, scan the **same directory** for `alignment_data.json`. If exactly one match, use it; zero or multiple → ask the user; no answer → UI fallback. |
| Layout PNG | Same scan rule, filename `layout.png`. |

UI fallback details for any of these live in [SKILL.md UI Fallback Pattern](../SKILL.md#ui-fallback-pattern).

### Required when no calibration-settings file is provided
6. **Detector type** — see [SKILL.md § Step B — Start Calibration](../SKILL.md#step-b--start-calibration) for the choice and the AskUserQuestion fallback.
7. **Parameter tuning** — also ask whether to proceed with the default calibration parameters or tune them in the UI (Step 3: Parameters) first. See [SKILL.md § Step B](../SKILL.md#step-b--start-calibration) for the exact prompt.

### Optional
7. **`sensor_id`** per stream — if VIOS already has the sensor registered, pass the ID to skip re-registration. Leave null and the MS auto-registers via VIOS.
8. **Ground truth zip** (`GT.zip`) and **focal lengths** — same options as the videos mode.

VGGT refinement is handled after AMC completes by [SKILL.md Step E](../SKILL.md#step-e--vggt-refinement). Do not collect a separate RTSP-mode VGGT flag; staging the model is optional during deployment, and missing VGGT must not block the AMC run.

For nvstreamer setup details and sensor pre-registration, see your VIOS deployment docs.

## Step 3 — Initialize RTSP Run

Before capture, allocate an AMC project using [`common-steps.md`](common-steps.md#create-project). The RTSP capture request uses that `project_id`.

## Step 4 — Start RTSP Capture

```
POST /v1/rtsp/capture/<project_id>
Content-Type: application/json

{
  "streams": [
    {"rtsp_url": "rtsp://.../cam_00", "camera_name": "cam_00", "sensor_id": null},
    {"rtsp_url": "rtsp://.../cam_01", "camera_name": "cam_01", "sensor_id": null}
  ],
  "duration_seconds": 180,
  "vios_token": null,
  "ssl_verify": false
}
```

Response shape: `{"code": 0, "message": "...", "session": {"session_id": "...", "status": "STARTING", ...}}`. Save `session.session_id`. The same nested-`session` shape is returned by `GET /v1/rtsp/capture/<project_id>/<session_id>`, so unwrap it on every poll too.

**Session lifecycle:**
```
STARTING → RECORDING → COMPLETED → INGESTING → INGESTED
                                ↘ ERROR
RECORDING → CANCELLED (via /stop)
```

## Step 5 — Poll Capture Status, Then Ingest

Poll every ~10 s until session state is `COMPLETED`:

```
GET /v1/rtsp/capture/<project_id>/<session_id>
```

Then ingest the recorded clips as the project's video files:

```
POST /v1/rtsp/capture/<project_id>/<session_id>/ingest
```

When this returns successfully, the project has the clips attached — same state as if you'd called `/v1/upload_video_files/<project_id>` with local MP4s.

**Need to stop early?** `POST /v1/rtsp/capture/<project_id>/<session_id>/stop` — the partial clip can still be ingested.

**Other session endpoints:**
- `GET /v1/rtsp/sessions/<project_id>` — list all sessions for a project.
- `DELETE /v1/rtsp/session/<project_id>/<session_id>` — delete a session record.

## Step 6 — Apply Config, Upload Alignment / Layout

Resolve the config path (asked in Step 2) and use it as the anchor to scan for alignment + layout.

**Calibration settings**: see [Settings File + Detector Pattern](../SKILL.md#settings-file--detector-pattern).

**Alignment + layout** (resolved via same-dir scan of the config path, or user-provided, or UI fallback):
```
POST /v1/upload_alignment/<project_id>    alignment_file=<alignment_data.json>
POST /v1/upload_layout/<project_id>       layout_file=<layout.png>
```

**Other optional uploads** (same as the videos mode):
```
POST /v1/upload_gt_file/<project_id>      gt_file=<GT.zip>                 # optional
POST /v1/upload_focal_length/<project_id> focal_length=<f0>&focal_length=<f1>...  # optional
```

UI fallback details — see [SKILL.md UI Fallback Pattern](../SKILL.md#ui-fallback-pattern). Note for RTSP: the "Layout missing → UI Step 2" instruction says to upload `layout.png` ONLY; do not touch the video section because clips are already ingested from RTSP capture.

## Step 7 — Hand off to the Shared Calibration Tail

Continue with [SKILL.md Step A onward](../SKILL.md#step-a--verify-project) (verify → calibrate → poll → results). Use [`calibration-tail.md`](calibration-tail.md) for the shared Python snippet; [`common-steps.md` § Hand off](common-steps.md#hand-off-to-the-shared-calibration-tail) has the reusable handoff note.

---

## RTSP Mode Python Script

```python
from pathlib import Path
import os
import time

import requests

# --- Edit these ---
BASE_URL       = "http://<HOST_IP>:<MS_PORT>/v1"   # default MS_PORT 8010
PROJECT_NAME   = "rtsp_calibration_run"

# One entry per camera
STREAMS = [
    {"rtsp_url": "rtsp://<host>:31556/.../cam_00.mp4", "camera_name": "cam_00", "sensor_id": None},
    {"rtsp_url": "rtsp://<host>:31557/.../cam_01.mp4", "camera_name": "cam_01", "sensor_id": None},
]
DURATION_SECONDS = 180                 # >= 60

# Anchor file — ask user for this path. Leave None if they don't have one (→ UI Step 3 fallback).
CONFIG_FILE    = None                                   # e.g. Path("/path/to/settings.json")
# If CONFIG_FILE is set, the skill scans its parent directory for alignment + layout.
ALIGNMENT_JSON = None
LAYOUT_PNG     = None
GT_ZIP         = None                                   # optional
FOCAL_LENGTHS  = None                                   # optional: [1269.0, 1099.5]
DETECTOR_TYPE  = "resnet"                               # overridden below if CONFIG_FILE pins it

VSS_APPS_DIR = Path(os.environ.get("VSS_APPS_DIR", Path.cwd()))
PROJECTS_DIR = Path(os.environ.get("PROJECTS_DIR", VSS_APPS_DIR / "services" / "auto-calibration" / "projects"))

# Auto-scan alignment+layout from the same dir as CONFIG_FILE
def _resolve_local(override, candidate_names, scan_dir, label):
    if override and Path(override).exists():
        return Path(override)
    if scan_dir is None:
        return None
    hits = [scan_dir / n for n in candidate_names if (scan_dir / n).exists()]
    if len(hits) == 1:
        print(f"    auto-detected {label}: {hits[0]}")
        return hits[0]
    if len(hits) > 1:
        print(f"    multiple {label} candidates in {scan_dir}: {hits} — skipping auto-detect")
    return None

_scan_dir = CONFIG_FILE.parent if (CONFIG_FILE and Path(CONFIG_FILE).exists()) else None
ALIGNMENT_JSON = _resolve_local(ALIGNMENT_JSON, ["alignment_data.json"], _scan_dir, "alignment")
LAYOUT_PNG     = _resolve_local(LAYOUT_PNG,     ["layout.png"],           _scan_dir, "layout")

s = requests.Session()

# Open an RTSP calibration project
r = s.post(f"{BASE_URL}/create_project", data={"project_name": PROJECT_NAME})
r.raise_for_status()
project_id = r.json()["project_id"]
print(f"[3] Created project {project_id}")

# Step 4 — Start RTSP capture
r = s.post(f"{BASE_URL}/rtsp/capture/{project_id}", json={
    "streams": STREAMS,
    "duration_seconds": DURATION_SECONDS,
    "vios_token": None,
    "ssl_verify": False,
})
r.raise_for_status()
session = r.json().get("session") or r.json()  # response nests session_id/status under "session"
session_id = session["session_id"]
print(f"[4] Capture session {session_id} — duration {DURATION_SECONDS}s")

# Step 5a — Poll capture status
print(f"[5] Polling capture status (~{DURATION_SECONDS + 60}s)...")
start = time.time(); last = ""
while time.time() - start < DURATION_SECONDS + 600:
    info = s.get(f"{BASE_URL}/rtsp/capture/{project_id}/{session_id}").json()
    sess = info.get("session") or info
    state = sess.get("status") or sess.get("state")
    elapsed = int(time.time() - start)
    if state != last:
        print(f"    [{elapsed:>4}s] {state}", flush=True); last = state
    if state == "COMPLETED":
        break
    if state in {"ERROR", "CANCELLED"}:
        raise RuntimeError(f"Capture {state}: {info}")
    time.sleep(10)
else:
    raise RuntimeError("Capture poll timed out")

# Step 5b — Ingest clips into project
r = s.post(f"{BASE_URL}/rtsp/capture/{project_id}/{session_id}/ingest")
r.raise_for_status()
print(f"[5] Ingested clips: {r.json()}")

# Step 6 — Config + alignment + layout + optional extras
if CONFIG_FILE and Path(CONFIG_FILE).exists():
    r = s.post(f"{BASE_URL}/config/{project_id}",
               data=Path(CONFIG_FILE).read_bytes(),
               headers={"Content-Type": "application/json"})
    r.raise_for_status()
    print(f"[6] Applied calibration config from {Path(CONFIG_FILE).name}")
    try:
        import json as _json
        _cfg = _json.loads(Path(CONFIG_FILE).read_text())
        _det = _cfg.get("detector") or _cfg.get("detector_type")
        if _det in ("resnet", "transformer"):
            DETECTOR_TYPE = _det
            print(f"    Detector overridden from config: {DETECTOR_TYPE}")
    except Exception:
        pass

if ALIGNMENT_JSON and ALIGNMENT_JSON.exists():
    with open(ALIGNMENT_JSON, "rb") as f:
        s.post(f"{BASE_URL}/upload_alignment/{project_id}",
               files={"alignment_file": (ALIGNMENT_JSON.name, f, "application/json")}).raise_for_status()
if LAYOUT_PNG and LAYOUT_PNG.exists():
    with open(LAYOUT_PNG, "rb") as f:
        s.post(f"{BASE_URL}/upload_layout/{project_id}",
               files={"layout_file": (LAYOUT_PNG.name, f, "image/png")}).raise_for_status()
if GT_ZIP and Path(GT_ZIP).exists():
    with open(GT_ZIP, "rb") as f:
        s.post(f"{BASE_URL}/upload_gt_file/{project_id}",
               files={"gt_file": (Path(GT_ZIP).name, f, "application/zip")}, timeout=120).raise_for_status()
if FOCAL_LENGTHS:
    s.post(f"{BASE_URL}/upload_focal_length/{project_id}",
           data={"focal_length": FOCAL_LENGTHS}).raise_for_status()

# UI fallback for anything not resolved — run the canonical block from
# videos.md § "Step 5 — UI fallback for anything not resolved" (builds ui_tasks,
# prompts for the detector, and verifies the manual_adjustment alignment files).
# RTSP difference: videos are already ingested from the RTSP capture, so in UI
# Step 2 (Video Configuration) upload layout.png ONLY — do not re-upload videos.

# Run the shared tail now; see Step 7 above.
```

## Mode-specific Troubleshooting

| Issue | Fix |
|---|---|
| VIOS `/vst/api/v1/sensor/list` returns connection refused | VIOS isn't running. Look for the ``vss-manage-video-io-storage`` (see `../../vss-manage-video-io-storage/SKILL.md`) skill; if none, ask user to deploy VIOS and retry. |
| Capture endpoint returns 503 / "VIOS not configured" | `VIOS_BASE_URL` not set in MS container env. Either deploy alongside a `bp_wh_*` blueprint (which auto-wires it), or set it in `deploy/docker/industry-profiles/warehouse-operations/.env` and re-run `docker compose --env-file ... up -d` from `deploy/docker/`. |
| Session stuck in `STARTING` | VIOS received the request but sensors aren't online. Check `curl ${VIOS_BASE_URL}/vst/api/v1/sensor/list` — look for `status: "online"`. Wait 20–30 s after any `sensor-ms` restart. |
| Session stuck in `RECORDING` past `duration_seconds` | VIOS timer still running; call `POST /v1/rtsp/capture/<pid>/<sid>/stop` to end early. |
| Ingest fails: `No clip available` | Recording window didn't overlap the VIOS timeline — sensors likely came online after capture started. Wait 30–60 s after bringing sensors online before starting a capture. |
| 400 "empty streams" | Pass at least one entry in `streams`. |
| 400 "duration too short" | Minimum is 60 s. |
| 404 on `/v1/rtsp/capture/{project_id}` | Project doesn't exist — create it first via `/v1/create_project`. |
| `verify_project` not `READY` after ingest | Ingest may have partially failed; re-check `GET /v1/get_project_info/<project_id>` — ensure all expected `video_files` are listed. |

See the [Cross-cutting Troubleshooting](../SKILL.md#cross-cutting-troubleshooting) table in SKILL.md for issues that span all modes.
