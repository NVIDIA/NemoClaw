# vss-generate-video-calibration — Videos Mode (pre-recorded MP4s)

Load this reference when the user has **local MP4 files** to calibrate. Skip to the [Shared Calibration Tail](../SKILL.md#shared-calibration-tail) in SKILL.md once videos + alignment + layout are uploaded.

For live RTSP streams, see `rtsp.md`. For verifying the install with the bundled sample, see `sample-dataset.md`.

## What to Ask the User

### Required
1. **Videos directory** — a folder containing `cam_00.mp4`, `cam_01.mp4`, … (time-synchronized, 1920×1080 recommended). The skill reads `cam_*.mp4` from here and uploads them sorted alphabetically.
2. **Microservice URL** — e.g. `http://<HOST_IP>:8010`.
3. **Project name** — short descriptive string.

### Auto-Detected (ask only if not found)

The skill scans the **videos directory** and its **parent directory** for these files and uses them silently if exactly one match is found. Ask the user only if missing or ambiguous; if they don't have the file, fall back to the UI (see [SKILL.md UI Fallback Pattern](../SKILL.md#ui-fallback-pattern)):

| File | Candidate filenames |
|---|---|
| Calibration settings | `calibration_settings.json`, `settings.json`, `config.json`, `calibration_config.json` (UI Step 3 Download produces one of these). When provided, this file replaces the entire UI Step 3 Parameters dialog. If they don't have a file, ask which detector to use separately (see below). |
| Alignment JSON | `alignment_data.json` |
| Layout PNG | `layout.png` |

See the [Settings File + Detector Pattern](../SKILL.md#settings-file--detector-pattern) section in SKILL.md for the parsing rule.

### Required when no calibration-settings file is provided
4. **Detector type** — see [SKILL.md § Step B — Start Calibration](../SKILL.md#step-b--start-calibration) for the `resnet` vs `transformer` choice and the
   AskUserQuestion fallback. When a config file is provided, the script extracts
   the detector automatically.
5. **Parameter tuning** — also ask whether to proceed with the default calibration parameters or tune them in the UI (Step 3: Parameters) first. See [SKILL.md § Step B](../SKILL.md#step-b--start-calibration) for the exact prompt.

### Optional
5. **Ground truth zip** — `GT.zip` with `_World_Cameras_Camera_XX/` folders (enables evaluation metrics).
6. **Focal lengths** — one per camera, e.g. `1269.0, 1099.5, 1099.5`.

VGGT refinement is handled after AMC completes by [SKILL.md Step E](../SKILL.md#step-e--vggt-refinement). Do not collect a separate videos-mode VGGT flag; staging the model is optional during deployment, and missing VGGT must not block the AMC run.

Root `README.md` "Custom Dataset" section documents input-video guidelines and ground-truth format.

## API Call Sequence (videos mode)

### Step 1 — Initialize Videos Run

Create the project with the shared request in [`common-steps.md`](common-steps.md#create-project), then keep `project_id` for the upload calls.

### Step 2 — Upload Videos (required)

See [`common-steps.md` § Upload videos](common-steps.md#upload-videos).

> **Important**: upload sorted alphabetically — the server assigns camera
> indices by upload order. The `multipart/form-data` part name is `files`.

### Step 3 — Resolve Local Files (Auto-Scan, Ask, or UI)

For each of calibration-settings, alignment, and layout, run this resolution:

1. **Auto-scan** `VIDEO_DIR` and `VIDEO_DIR.parent` for the candidate filenames (table above).
2. If **exactly one match**, use it silently and print what was found.
3. If **zero or multiple matches**, ask the user for an explicit path via `AskUserQuestion`. If they don't have the file, mark it for UI fallback.
4. **UI fallback**: see [SKILL.md UI Fallback Pattern](../SKILL.md#ui-fallback-pattern).

### Step 4 — Upload Resolved Files

For each file that was resolved locally:

**Calibration settings**:
```
POST /v1/config/<project_id>
Content-Type: application/json

<file contents, posted as-is>
```

After a successful POST, also parse the file for `"detector"` / `"detector_type"` and override `DETECTOR_TYPE` for the `/calibrate` call (see [Settings File + Detector Pattern](../SKILL.md#settings-file--detector-pattern)).

**Alignment JSON**:
```
POST /v1/upload_alignment/<project_id>
alignment_file: ("alignment_data.json", <bytes>, "application/json")
```

**Layout PNG**:
```
POST /v1/upload_layout/<project_id>
layout_file: ("layout.png", <bytes>, "image/png")
```

**Ground truth** (optional, enables evaluation):
```
POST /v1/upload_gt_file/<project_id>
gt_file: ("GT.zip", <bytes>, "application/zip")
```

**Focal lengths** (optional, overrides GeoCalib estimates):
```
POST /v1/upload_focal_length/<project_id>
focal_length=1269.0&focal_length=1099.5&...
```

### Step 5 — Hand off to the Shared Calibration Tail

Once uploads are done (and any UI fallback confirmed on disk), continue with [SKILL.md Step A onward](../SKILL.md#step-a--verify-project) (verify → calibrate → poll → results). Use [`calibration-tail.md`](calibration-tail.md) for the shared Python snippet.

---

## Videos Mode Python Script

```python
import os
import time
from pathlib import Path

import requests

# --- Edit these ---
BASE_URL       = "http://<HOST_IP>:<MS_PORT>/v1"   # default MS_PORT 8010
PROJECT_NAME   = "my_calibration_run"
VIDEO_DIR      = Path("/path/to/videos")
# Optional explicit overrides (leave as None to trigger auto-scan, then ask-user, then UI fallback)
CONFIG_FILE    = None                                   # e.g. Path("/path/to/settings.json")
                                                        # Full settings override — replaces UI Step 3 (rectification, BA, eval, detector, ...).
                                                        # If the file pins a detector, it's also extracted for the calibrate call below.
ALIGNMENT_JSON = None                                   # e.g. Path("/path/to/alignment_data.json")
LAYOUT_PNG     = None                                   # e.g. Path("/path/to/layout.png")
GT_ZIP         = None                                   # optional: Path("/path/to/GT.zip")
FOCAL_LENGTHS  = None                                   # optional: [1269.0, 1099.5]
DETECTOR_TYPE  = "resnet"                               # "resnet" or "transformer" (overridden if CONFIG_FILE pins it)
RUN_VGGT_IF_READY = False  # Set True if the user requested VGGT or staged VGGT in this run

# Projects dir on the host (for verifying manual alignment output).
# Bind-mounted into the MS container from $VSS_APPS_DIR/services/auto-calibration/projects
# (see deploy/docker/services/auto-calibration/ms/compose.yml).
VSS_APPS_DIR = Path(os.environ.get("VSS_APPS_DIR", Path.cwd()))
PROJECTS_DIR = Path(os.environ.get("PROJECTS_DIR", VSS_APPS_DIR / "services" / "auto-calibration" / "projects"))

VIDEO_FILES = sorted(VIDEO_DIR.glob("cam_*.mp4"))
assert VIDEO_FILES, f"No cam_*.mp4 files under {VIDEO_DIR}"

# --- Auto-scan helper ---
def _resolve_local(override, candidate_names, scan_dirs, label):
    if override and Path(override).exists():
        return Path(override)
    hits = []
    for d in scan_dirs:
        for name in candidate_names:
            p = d / name
            if p.exists():
                hits.append(p)
    if len(hits) == 1:
        print(f"    auto-detected {label}: {hits[0]}")
        return hits[0]
    if len(hits) > 1:
        print(f"    multiple {label} candidates in {scan_dirs}: {hits} — skipping auto-detect")
    return None

_scan_dirs = [VIDEO_DIR, VIDEO_DIR.parent]
CONFIG_FILE    = _resolve_local(CONFIG_FILE,    ["calibration_settings.json", "settings.json", "config.json", "calibration_config.json"], _scan_dirs, "config")
ALIGNMENT_JSON = _resolve_local(ALIGNMENT_JSON, ["alignment_data.json"],                                       _scan_dirs, "alignment")
LAYOUT_PNG     = _resolve_local(LAYOUT_PNG,     ["layout.png"],                                                _scan_dirs, "layout")

s = requests.Session()

# Create the videos-mode project
r = s.post(f"{BASE_URL}/create_project", data={"project_name": PROJECT_NAME})
r.raise_for_status()
project_id = r.json()["project_id"]
print(f"[1] Created project: {project_id}")

# Upload videos alphabetically so camera indices are stable
files, handles = [], []
for v in VIDEO_FILES:
    f = open(v, "rb"); handles.append(f)
    files.append(("files", (v.name, f, "video/mp4")))
r = s.post(f"{BASE_URL}/upload_video_files/{project_id}", files=files, timeout=300)
for f in handles: f.close()
r.raise_for_status()
print(f"[2] Uploaded {len(VIDEO_FILES)} videos")

# Step 3/4 — Upload resolved files
if CONFIG_FILE and CONFIG_FILE.exists():
    r = s.post(f"{BASE_URL}/config/{project_id}",
               data=CONFIG_FILE.read_bytes(),
               headers={"Content-Type": "application/json"})
    r.raise_for_status()
    print(f"[3] Applied calibration config from {CONFIG_FILE.name}")
    try:
        import json as _json
        _cfg = _json.loads(CONFIG_FILE.read_text())
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
    print(f"[3] Uploaded alignment: {ALIGNMENT_JSON.name}")

if LAYOUT_PNG and LAYOUT_PNG.exists():
    with open(LAYOUT_PNG, "rb") as f:
        s.post(f"{BASE_URL}/upload_layout/{project_id}",
               files={"layout_file": (LAYOUT_PNG.name, f, "image/png")}).raise_for_status()
    print(f"[3] Uploaded layout: {LAYOUT_PNG.name}")

if GT_ZIP and GT_ZIP.exists():
    with open(GT_ZIP, "rb") as f:
        s.post(f"{BASE_URL}/upload_gt_file/{project_id}",
               files={"gt_file": (GT_ZIP.name, f, "application/zip")}, timeout=120).raise_for_status()
    print(f"[3] Uploaded GT zip")

if FOCAL_LENGTHS:
    s.post(f"{BASE_URL}/upload_focal_length/{project_id}",
           data={"focal_length": FOCAL_LENGTHS}).raise_for_status()
    print(f"[3] Uploaded focal lengths: {FOCAL_LENGTHS}")

# Step 5 — UI fallback for anything not resolved
ui_tasks = []
if not CONFIG_FILE:
    ui_tasks.append("Step 3 (Parameters): tune settings or accept defaults, then Save.")
    # Agent should ask via AskUserQuestion; the input() is the direct-run fallback.
    if DETECTOR_TYPE == "resnet":
        _choice = input("    Detector [resnet/transformer] (default resnet): ").strip().lower()
        if _choice in ("resnet", "transformer"):
            DETECTOR_TYPE = _choice
        print(f"    Using detector: {DETECTOR_TYPE}")
if not ALIGNMENT_JSON or not LAYOUT_PNG:
    ui_tasks.append("Step 2 (Video Configuration): upload layout.png only — videos already uploaded via API, do not re-upload. Then Save. Step 4 (Alignment): upload alignment_data.json or mark correspondence points, then Save.")
if ui_tasks:
    print(f"\n[5] UI action required for project {project_id}:")
    for t in ui_tasks:
        print(f"    - {t}")
    input("    Press Enter when done...")
    if not ALIGNMENT_JSON or not LAYOUT_PNG:
        manual_dir = PROJECTS_DIR / f"project_{project_id}" / "manual_adjustment"
        assert (manual_dir / "alignment_data.json").exists() and (manual_dir / "layout.png").exists(), (
            f"Alignment files missing under {manual_dir}. Re-check UI Step 4 and click Save."
        )
        print(f"    Alignment files verified at {manual_dir}")

# Paste references/calibration-tail.md here before VGGT refinement.

# Step E — VGGT refinement
info = s.get(f"{BASE_URL}/get_project_info/{project_id}").json()
vggt_state = info.get("project_info", {}).get("vggt_state", "INIT")
if vggt_state == "READY" and RUN_VGGT_IF_READY:
    s.post(f"{BASE_URL}/vggt/calibrate/{project_id}").raise_for_status()
    print("\n[E] VGGT started")
    t0 = time.time()
    while time.time() - t0 < 900:
        vs = s.get(f"{BASE_URL}/get_project_info/{project_id}").json() \
            .get("project_info", {}).get("vggt_state", "INIT")
        if vs == "COMPLETED":
            print("     VGGT done"); break
        if vs == "ERROR":
            raise RuntimeError("VGGT failed")
        time.sleep(10)
elif vggt_state == "READY":
    print("\n[E] VGGT is ready. Ask whether to run refinement; set RUN_VGGT_IF_READY=True for direct-mode runs.")
else:
    print(f"\n[E] VGGT not ready (state={vggt_state}) — skipping. VGGT refinement is available after staging the model.")

print(f"\nProject: {project_id}")
print(f"Final camera parameters: ${{VSS_APPS_DIR}}/services/auto-calibration/projects/project_{project_id}/output/multi_view_results/BA_output/results_ba/refined/camInfo_XX.yaml")
```

## Mode-specific Troubleshooting

| Issue | Fix |
|---|---|
| `cam_*.mp4` glob finds 0 files | Confirm `VIDEO_DIR` is the directory **containing** the camera files, not a parent. Try `ls "$VIDEO_DIR"/cam_*.mp4`. |
| Immediate `ERROR` after `/calibrate` | Check video naming: must be `cam_00.mp4`, `cam_01.mp4`, … contiguous, no gaps. |
| Upload returns 413 | Raise server upload limit, or split files. Most user videos are <500 MB so this is unusual. |
| Auto-scan finds multiple settings files | Disambiguate by passing `CONFIG_FILE = Path("...")` explicitly. |

See the [Cross-cutting Troubleshooting](../SKILL.md#cross-cutting-troubleshooting) table in SKILL.md for issues that span all modes.
