# vss-generate-video-calibration — Sample-Dataset Mode (verify install)

Load this reference when the user wants to **verify a fresh AMC install** by running calibration on the bundled sample dataset (`sdg_08_2_sample_data_010926.zip`, 4 synthetic warehouse cameras with ground truth). Useful before throwing real data at it.

For your own pre-recorded MP4s, see `videos.md`. For live RTSP streams, see `rtsp.md`.

The sample includes GT, so the run produces evaluation metrics (L2 distance, reprojection error) — no calibration parameter tuning needed.

## Mode-specific Prerequisites

- **Sample zip present at `assets/sdg_08_2_sample_data_010926.zip`** — **the VSS repo does not ship this file.** See [Obtain the sample zip](#obtain-the-sample-zip) below.
- **Python 3 with `requests` available** — or use the [Swagger UI walkthrough](#alternative-swagger-ui-walkthrough) below.
  - The inline run block self-heals: if `requests` is missing it creates a throwaway venv under `${TMPDIR:-/tmp}/amc-sample-test-venv` (nothing written to the repo).
  - If `python3 -m venv` itself fails with `ensurepip not available`, the inline block falls back to [`uv`](https://astral.sh/uv) (sudo-free, installed via `curl -LsSf https://astral.sh/uv/install.sh | sh`). If neither path is available: `sudo apt install -y python3-venv python3-pip` as a last resort.

The shared AMC microservice prereq comes from the SKILL.md [Prerequisites](../SKILL.md#prerequisites-shared-across-calibration-modes) section.

## Quick Start for Agents

**"launch AMC and test sample dataset" (or similar):**

1. Walk `deploy-auto-calibration-service.md` first to bring up the AMC stack.
2. Wait for `/v1/ready` to return OK.
3. Extract sample data (snippet below) — idempotent, safe to re-run.
4. Run the inline block in [Run Inline (No File Written)](#run-inline-no-file-written). Do **not** save it as a `.py` file — pipe via heredoc so the user's repo stays clean.
5. Report final metrics + UI URL for manual inspection.

**"test sample dataset" (MS already running):**

1. Detect backend: scan ports 8000–8009 (and 8010) for a `/v1/ready` response.
2. If none → walk `deploy-auto-calibration-service.md` first.
3. Extract sample data if not already cached.
4. Run the inline block (heredoc-piped Python — no file written).
5. Report metrics.

### Detect Running Backend

```bash
MS_HOST="${HOST_IP:-localhost}"
MS_PORT=""
for port in {8000..8009}; do
  if curl -s "http://${MS_HOST}:$port/v1/ready" | grep -q '"code":0'; then
    MS_PORT=$port; break
  fi
done
if [ -z "$MS_PORT" ] && curl -s "http://${MS_HOST}:8010/v1/ready" | grep -q '"code":0'; then
  MS_PORT=8010
fi
[ -z "$MS_PORT" ] && { echo "No running backend. Walk deploy-auto-calibration-service.md first to bring up AMC."; exit 1; }
echo "Backend on ${MS_HOST}:$MS_PORT"
```

### Obtain the sample zip

The zip is **not** committed to the VSS repo. It lives in the standalone AMC repo on GitHub, where it ships via git-lfs:

- Canonical source: <https://github.com/NVIDIA-AI-IOT/auto-magic-calib/blob/main/assets/sdg_08_2_sample_data_010926.zip>
- Raw LFS download: <https://github.com/NVIDIA-AI-IOT/auto-magic-calib/raw/main/assets/sdg_08_2_sample_data_010926.zip>
- File size: ~154 MB

Pick the path that fits your setup:

```bash
export REPO_ROOT=$(git rev-parse --show-toplevel)
mkdir -p "$REPO_ROOT/assets"
TARGET="$REPO_ROOT/assets/sdg_08_2_sample_data_010926.zip"

# (a) Reuse an existing AMC checkout on the same host (cheapest, no network)
if [ -f "$HOME/auto-magic-calib/assets/sdg_08_2_sample_data_010926.zip" ]; then
  ln -sf "$HOME/auto-magic-calib/assets/sdg_08_2_sample_data_010926.zip" "$TARGET"

# (b) Pull from GitHub LFS directly (no AMC checkout needed)
else
  curl -L -o "$TARGET" \
    https://github.com/NVIDIA-AI-IOT/auto-magic-calib/raw/main/assets/sdg_08_2_sample_data_010926.zip
fi

# (c) Or: clone the AMC repo with LFS into a sibling dir and symlink — useful if you
# also want the AMC scripts/docs:
#   git lfs install
#   git clone https://github.com/NVIDIA-AI-IOT/auto-magic-calib.git ../auto-magic-calib
#   ln -sf "$PWD/../auto-magic-calib/assets/sdg_08_2_sample_data_010926.zip" "$TARGET"

# Verify (~154 MB)
ls -lh "$TARGET"
```

> The VSS repo deliberately doesn't bundle the zip (size + version-skew across AMC releases). Don't commit it here — `assets/sdg_08_2_sample_data_010926.zip` should stay gitignored if you copy it in.

### Locate + Extract Sample Data (idempotent)

```bash
export REPO_ROOT=$(git rev-parse --show-toplevel)

SAMPLE_ZIP="$REPO_ROOT/assets/sdg_08_2_sample_data_010926.zip"
[ -f "$SAMPLE_ZIP" ] || { echo "Sample zip not found at $SAMPLE_ZIP"; exit 1; }

# Cache directory next to the zip.
SAMPLE_DIR="$(dirname "$SAMPLE_ZIP")/.cache/sdg_08_2_sample_data_010926"

if [ ! -d "$SAMPLE_DIR" ]; then
  mkdir -p "$SAMPLE_DIR"
  unzip -q "$SAMPLE_ZIP" -d "$SAMPLE_DIR"
fi
ls "$SAMPLE_DIR"
# Expected (possibly inside a wrapper folder): alignment_data/  GT.zip  videos/
```

## Run Inline (No File Written)

Run the test on the fly — pipe Python into `python3` via heredoc so nothing is saved into the user's repo. The block below is fully self-contained: it resolves `REPO_ROOT` via `git rev-parse`, reads `MS_PORT` from the warehouse-operations `.env`, picks (or creates) a Python with `requests` installed, and then pipes the inline script. Safe to copy/paste verbatim. Each invocation creates a fresh project.

```bash
# Resolve env
export REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
ENV_FILE="$REPO_ROOT/deploy/docker/industry-profiles/warehouse-operations/.env"
export MS_PORT="$(grep ^VSS_AUTO_CALIBRATION_PORT "$ENV_FILE" 2>/dev/null | cut -d= -f2)"
export MS_PORT="${MS_PORT:-8010}"
export BASE_URL="http://${HOST_IP:-localhost}:${MS_PORT}/v1"
# Optional: export SAMPLE_DIR=/abs/path/to/extracted/sample to override autodetection

# Pick a python3 that has `requests`; create a throwaway venv if needed (no repo files written)
PY=python3
"$PY" -c 'import requests' 2>/dev/null || {
  VENV="${TMPDIR:-/tmp}/amc-sample-test-venv"
  # Try the stdlib venv first.
  if python3 -m venv "$VENV" 2>/dev/null; then
    "$VENV/bin/pip" install --quiet requests
    PY="$VENV/bin/python3"
  # Fall back to uv (sudo-free, user-local install). Same fallback as the /deploy skill.
  elif command -v uv >/dev/null 2>&1 \
      || curl -LsSf https://astral.sh/uv/install.sh | sh; then
    export PATH="$HOME/.local/bin:$PATH"
    uv venv "$VENV"
    uv pip install --python "$VENV/bin/python" --quiet requests
    PY="$VENV/bin/python3"
  # Last resort: stdlib venv via apt (requires sudo).
  else
    echo "Need python3-venv or uv. Try one of:" >&2
    echo "  curl -LsSf https://astral.sh/uv/install.sh | sh   (no sudo)" >&2
    echo "  sudo apt install -y python3-venv python3-pip" >&2
    exit 1
  fi
}

"$PY" - <<'PY'
import os
import sys
import time
from pathlib import Path

import requests

# REPO_ROOT comes from the surrounding shell; fall back to cwd when missing
# (no `__file__` to lean on when fed via stdin).
REPO_ROOT = Path(os.environ.get("REPO_ROOT") or Path.cwd())
MS_PORT = os.environ.get("MS_PORT", "8010")
BASE_URL = os.environ.get("BASE_URL", f"http://{os.environ.get('HOST_IP', 'localhost')}:{MS_PORT}/v1")

# Sample zip lives in assets/.
def _find_sample_dir() -> Path:
    candidate = REPO_ROOT / "assets" / ".cache" / "sdg_08_2_sample_data_010926"
    if candidate.exists():
        return candidate
    sys.exit(
        "Sample data not extracted. Run the extraction snippet from this reference first, "
        "or pass SAMPLE_DIR= explicitly."
    )

# NOTE: do NOT write `Path(os.environ.get("SAMPLE_DIR", "")) or _find_sample_dir()`
# — Path("") evaluates to Path('.') which is truthy, so the `or` never falls
# through and the script silently picks `.` (typically the repo root). Rglobbing
# `cam_*.mp4` from there can sweep dozens of stale videos from prior test runs.
_env_sample = os.environ.get("SAMPLE_DIR")
SAMPLE_DIR = Path(_env_sample).resolve() if _env_sample else _find_sample_dir()

# Locate sample files (handle an optional wrapper folder from unzip)
def _find(path: Path, name: str) -> Path:
    hits = list(path.rglob(name))
    if not hits:
        sys.exit(f"Could not find {name} under {path}")
    return hits[0]

# Anchor video discovery on the canonical `videos/` directory if present
# (non-recursive). Only fall back to rglob if no `videos/` folder exists,
# and assert a sane upper bound so a misconfigured SAMPLE_DIR fails loud
# instead of uploading every cam_*.mp4 in the tree.
videos_dirs = list(SAMPLE_DIR.rglob("videos"))
videos_dir = next((d for d in videos_dirs if d.is_dir()), None)
if videos_dir is not None:
    videos = sorted(videos_dir.glob("cam_*.mp4"))
else:
    videos = sorted(SAMPLE_DIR.rglob("cam_*.mp4"))

alignment = _find(SAMPLE_DIR, "alignment_data.json")
layout = _find(SAMPLE_DIR, "layout.png")
gt_zip = _find(SAMPLE_DIR, "GT.zip")

assert len(videos) >= 2, f"Need >=2 cam_XX.mp4 under {SAMPLE_DIR}, found {len(videos)}"
# Sample dataset has 4 cameras — bail if SAMPLE_DIR is so wide we'd upload
# unrelated videos. Override SAMPLE_DIR explicitly if you need a different one.
assert len(videos) <= 16, (
    f"Found {len(videos)} cam_*.mp4 under {SAMPLE_DIR} — looks like SAMPLE_DIR "
    "is too broad (probably picked up stale test caches). Set SAMPLE_DIR to the "
    "extracted sample folder explicitly and re-run."
)
print(f"Base URL:   {BASE_URL}")
print(f"Sample dir: {SAMPLE_DIR}")
print(f"Videos:     {[v.name for v in videos]}")

s = requests.Session()

# Create the sample-dataset project
project_name = f"sample_test_{int(time.time())}"
r = s.post(f"{BASE_URL}/create_project", data={"project_name": project_name})
r.raise_for_status()
project_id = r.json()["project_id"]
print(f"[1] Created project {project_name} → {project_id}")

# Upload the bundled sample cameras; order defines camera indices.
upload_parts, open_files = [], []
try:
    for video_path in videos:
        handle = video_path.open("rb")
        open_files.append(handle)
        upload_parts.append(("files", (video_path.name, handle, "video/mp4")))
    r = s.post(f"{BASE_URL}/upload_video_files/{project_id}", files=upload_parts, timeout=300)
finally:
    for handle in open_files:
        handle.close()
r.raise_for_status()
print(f"[2] Uploaded {len(videos)} videos")

# Step 3 — Upload alignment JSON
with open(alignment, "rb") as f:
    r = s.post(f"{BASE_URL}/upload_alignment/{project_id}",
               files={"alignment_file": (alignment.name, f, "application/json")})
    r.raise_for_status()
print(f"[3] Uploaded alignment JSON")

# Step 4 — Upload layout PNG
with open(layout, "rb") as f:
    r = s.post(f"{BASE_URL}/upload_layout/{project_id}",
               files={"layout_file": (layout.name, f, "image/png")})
    r.raise_for_status()
print(f"[4] Uploaded layout PNG")

# Step 5 — Upload GT zip (enables evaluation metrics)
with open(gt_zip, "rb") as f:
    r = s.post(f"{BASE_URL}/upload_gt_file/{project_id}",
               files={"gt_file": (gt_zip.name, f, "application/zip")}, timeout=120)
    r.raise_for_status()
print(f"[5] Uploaded GT zip")

# Shared Calibration Tail — see references/calibration-tail.md for the snippet
# (verify_project → calibrate → poll → fetch evaluation_statistics)
# Note: detector_type is hard-coded to "resnet" for the sample dataset.
DETECTOR_TYPE = "resnet"
# Run the snippet from references/calibration-tail.md here.
# Then fetch the evaluation statistics:
r = s.get(f"{BASE_URL}/result/{project_id}/evaluation_statistics")
if r.status_code == 200:
    stats = r.json().get("statistics", r.json())
    print(f"\n[D] Evaluation statistics:")
    for k, v in stats.items():
        print(f"    {k}: {v}")
else:
    print(f"\n[D] evaluation_statistics returned {r.status_code}: {r.text[:200]}")

print(f"\nProject ID: {project_id}")
print("Inspect in UI: open the project in the web UI to view results and overlay videos")
PY
```

> **Why heredoc, not a `.py` file?** The reference is meant to run on demand against any user's checkout — writing `run_sample_test.py` into the repo would dirty their working tree. The `<<'PY'` quoting prevents shell expansion inside the script. Re-run the same block any time; each run creates a fresh project.

## Alternative: Swagger UI Walkthrough

The microservice exposes an interactive OpenAPI UI at **`http://<HOST_IP>:<MS_PORT>/docs`**. If you prefer clicking through the API by hand:

1. Open `http://<HOST_IP>:<MS_PORT>/docs` in a browser (default `MS_PORT` is `8010`).
2. Unzip `sdg_08_2_sample_data_010926.zip` into a cache directory next to it.
3. Execute these endpoints **in order**, copying the `project_id` from step 1 into subsequent paths:

   | # | Endpoint | Body / Files |
   |---|---|---|
   | 1 | `POST /v1/create_project` | `project_name`: any string |
   | 2 | `POST /v1/upload_video_files/{project_id}` | `files`: upload all 4 `videos/cam_0*.mp4` **sorted by name** |
   | 3 | `POST /v1/upload_alignment/{project_id}` | `alignment_file`: `alignment_data/alignment_data.json` |
   | 4 | `POST /v1/upload_layout/{project_id}` | `layout_file`: `alignment_data/layout.png` |
   | 5 | `POST /v1/upload_gt_file/{project_id}` | `gt_file`: `GT.zip` |
   | 6 | `POST /v1/verify_project/{project_id}` | — (expect `project_state: READY`) |
   | 7 | `POST /v1/calibrate/{project_id}` | JSON: `{"detector_type": "resnet"}` |
   | 8 | `GET /v1/get_project_info/{project_id}` | Refresh every ~10 s until `project_state` = `COMPLETED` |
   | 9 | `GET /v1/result/{project_id}/evaluation_statistics` | Read L2 distance + reprojection error |

This is the same sequence the Python script runs, just executed manually.

## Success Criteria

- Project reaches `project_state == "COMPLETED"` within ~30 min.
- `/v1/result/{id}/evaluation_statistics` returns non-empty `statistics` (GT was uploaded).
- No `ERROR` state encountered.

Representative metrics for the sample (yours should be similar):

```
Average L2 distance(m)               : < 1.5
Average reprojection error 0(px)     : < 10
```

## Monitoring Progress

```bash
PROJECT_ID=<id_from_step_1>
# Calibration log lives under the projects dir, relative to the container
# working directory. Use projects/...; do not prefix it with the
# working-directory basename.
docker exec vss-auto-calibration tail -F projects/project_${PROJECT_ID}/calibration.log
```

Or stream MS logs:

```bash
docker logs -f vss-auto-calibration
```

## Mode-specific Troubleshooting

| Issue | Fix |
|---|---|
| `requests` not installed | Inside a venv: `python3 -m venv venv && ./venv/bin/pip install requests`. If `python3 -m venv` fails (no `python3-venv` package, no sudo): use `uv` instead — `curl -LsSf https://astral.sh/uv/install.sh \| sh` then `uv venv venv && uv pip install --python venv/bin/python requests`. The inline run block already does this fallback chain automatically. |
| `[2] Uploaded N videos` where N >> 4 | `SAMPLE_DIR` resolved to the repo root (or another over-broad path) and `rglob("cam_*.mp4")` swept stale videos from `.cache/`, `projects/`, etc. Stop the run (`POST /v1/stop_calibration/{id}`), delete the project (`DELETE /v1/delete_project/{id}`), set `SAMPLE_DIR` explicitly to the extracted sample dir, re-run. The script anchors on `videos/` and asserts `len(videos) <= 16` to fail loud. |
| `create_project` returns `[Errno 13] Permission denied` | The host projects directory isn't writable by the container user (UID 1000). Run the write test in `deploy-auto-calibration-service.md` § Step 5, then grant access with `setfacl -m u:1000:rwx ${VSS_APPS_DIR}/services/auto-calibration/projects` and retry. |
| `verify_project` returns state `!= READY` | Confirm all 4 videos + alignment + layout + GT uploaded; inspect `GET /v1/get_project_info/{id}` response. |
| Sample zip not present at `assets/sdg_08_2_sample_data_010926.zip` | The VSS repo does not bundle it. Pull from GitHub LFS or a sibling AMC checkout — see [Obtain the sample zip](#obtain-the-sample-zip). |
| Sample not extracted | `unzip <repo_root>/assets/sdg_08_2_sample_data_010926.zip -d <repo_root>/assets/.cache/sdg_08_2_sample_data_010926/` |
| `cam_*.mp4` glob finds 0 files | Check wrapper-folder depth: `find <sample_dir> -name "cam_*.mp4"`. |
| Upload returns 413 | Raise server upload limit, or split files (sample files are <200 MB total so this is unusual). |
| Port scan finds no backend | Backend not running — walk `deploy-auto-calibration-service.md` first. |

See the [Cross-cutting Troubleshooting](../SKILL.md#cross-cutting-troubleshooting) table in SKILL.md for issues that span all modes.
