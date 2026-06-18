# Resource Plan — NGC vs Local sources (Steps 4 + 5 + 7)

How the skill decides whether each model / video asset comes from NGC or a
local path on the host, what it asks the user, and how it discovers the real
contents of each source before committing to a docker launch.

**Why this file exists:** not every deploy needs NGC. A user with an ONNX
already on disk and a local folder of `.mp4` files should never be asked for
an NGC API key. The skill must branch cleanly: collect sources → decide NGC
creds need → fetch/copy → verify contents → continue.

---

## Core rule — NGC credentials are CONDITIONAL

**The skill must NEVER ask for an NGC API key until it has confirmed at
least one asset is sourced from NGC.** If every asset is local (or the
videos come from RTSP), skip the NGC credential step entirely. The
container itself **never** receives a `~/.ngc` mount — all NGC downloads
run on the **host** (`fetch_resources.sh` in Step 1.g) before
`docker run`, then read from the `~/rtvicv-storage:/opt/storage` bind
mount inside the container.

| Source mix | Host-side NGC creds needed? |
|---|---|
| Any asset is NGC | Yes (for `fetch_resources.sh` to run `ngc registry download-version`) |
| All assets local (files/dirs) | No — `fetch_resources.sh` `cp`s straight into the storage tree |
| RTSP-only videos + local model | No |
| RTSP-only videos + NGC model | Yes (for the model download) |

---

## Per-use-case asset list

| Use case | Assets the user must source | Typical NGC layout |
|---|---|---|
| `warehouse-2d` | model + videos | single NGC resource containing both (per `usecases.warehouse-2d.{model,videos}.source` in the YAML) |
| `warehouse-3d` | model + videos + labels + anchor | single NGC resource containing all four |
| `smartcity-rtdetr` | model + videos | **two separate** NGC refs — model from `rtdetr_model`, videos from `smartcity_dataset` |
| `smartcity-gdino`  | model + videos | **two separate** NGC refs — model from `gdino_model`, videos from `smartcity_dataset` |

> **Source of truth:** every concrete tag / ref / in-resource path lives
> in [`deploy-defaults.yml`](../assets/deploy-defaults.yml). Do NOT cite specific
> tags in code or docs — read them via `scripts/load_defaults.sh
> <usecase>` and use the emitted `DEFAULT_*` env vars.

### Worked example — smartcity with two NGC refs (values resolved from YAML at runtime)

```bash
# Populated via: eval "$(scripts/load_defaults.sh smartcity-rtdetr)"
RESOURCE_PLAN=(
  "model:ngc:$DEFAULT_MODEL_NGC_REF"
  "videos:ngc:$DEFAULT_VIDEOS_NGC_REF"
)
NEEDS_NGC=1   # at least one NGC entry → Step 5 runs, NGC mount included
```

Each entry is fetched and scanned **independently against its role**:

- Model entry → `ngc registry model download-version <ref>`; scan for
  `*.onnx`/`*.engine`/`*.etlt` only. In this example the skill finds
  `resnet50_trafficcamnet_rtdetr.fp16.onnx` inside the unpacked TAO
  resource and commits it as `$RTDETR_ONNX` for Step 4.a.
- Videos entry → `ngc registry resource download-version <ref>` (+ untar
  if the resource ships `.tar.gz` files); scan for subdirs containing
  `.mp4`/`.mkv`. Commits the chosen dir as `$SMC_VIDEOS` for Step 4.a.

No ambiguity is forced across the two resources — the model scan doesn't
accidentally match videos in the app-data ref, and vice versa. If one of
the two resources is "wrong" (e.g. the user pasted the videos ref in the
model slot), the scan's 0-candidates path asks the user to retry the ref
or switch to a local path.

---

## Step 4 — Source selection (3-question AskQuestion driven by YAML defaults)

The skill drives **one** `AskQuestion` block with exactly three questions:
**docker image**, **model**, **videos**. Each option carries the resolved
NGC ref + in-resource path inline (read from
[`deploy-defaults.yml`](../assets/deploy-defaults.yml)) so the user never has to
answer a separate "NGC resource?" question.

`load_defaults.sh <usecase>` resolves these values upfront (see
`scripts/load_defaults.sh`); the agent then plugs them into the question
options:

```json
{
  "questions": [
    {
      "id": "docker_image",
      "prompt": "Which RTVI-CV docker image should I use?",
      "options": [
        {"id": "default", "label": "<DEFAULT_IMAGE> (Recommended)",
         "description": "Default for the detected platform (per arch in deploy-defaults.yml)"},
        {"id": "custom",  "label": "Use a different docker image",
         "description": "Provide a custom <nvcr.io/.../...:tag> reference"}
      ]
    },
    {
      "id": "model",
      "prompt": "Which model ONNX should I use?",
      "options": [
        {"id": "default", "label": "<DEFAULT_MODEL_BASENAME> (Recommended)",
         "description": "From NGC: <DEFAULT_MODEL_NGC_REF>\nPath: <DEFAULT_MODEL_PATH>"},
        {"id": "custom",  "label": "Use a custom local ONNX",
         "description": "Provide a host path to a different ONNX file"}
      ]
    },
    {
      "id": "videos",
      "prompt": "Which video set should I use?",
      "options": [
        {"id": "default", "label": "<DEFAULT_VIDEOS_BASENAME> (Recommended)",
         "description": "From NGC: <DEFAULT_VIDEOS_NGC_REF>\nPath: <DEFAULT_VIDEOS_PATH>"},
        {"id": "custom",  "label": "Use a custom local video directory",
         "description": "Provide a host path to a directory of .mp4 / .mkv files"},
        {"id": "rtsp",    "label": "RTSP URLs only",
         "description": "No download — provide RTSP URLs in chat after this question"}
      ]
    }
  ]
}
```

**No separate `ngc_resource` question.** The NGC ref is embedded in
each option's `description` field.

**Smartcity vs warehouse — same shape, different YAML defaults.** Warehouse
use cases pull both model and videos from a single resource
(`warehouse_dataset`); smartcity uses two different resources
(`rtdetr_model` / `gdino_model` for the model and `smartcity_dataset` for
the videos). Either way, each option carries its own NGC ref so the user
sees the source of truth per asset.

If the user picks `custom` (or `rtsp` for videos), the agent collects the
path / URL list in chat as a free-form follow-up — no extra `AskQuestion`.

### Refs / paths collection

Group every outstanding value into one user-input block. Don't ping-pong.

For each asset the user chose:
- **NGC** → ask for the reference string (e.g. `org/team/resource:version`)
- **Local** → ask for an absolute path (file or directory)
- **RTSP** → ask for URL list (comma- or newline-separated)

Example — smartcity-rtdetr with NGC model + local videos:

```
? I need 2 inputs from you:

  1. NGC reference for the RT-DETR model (format: org/team/resource:version)

  2. Absolute path to the local videos directory
     (must contain one or more .mp4 / .mkv files)

(Paste both, one per line, in your next reply.)
```

Store results as a structured list:

```bash
# Example after Step 4:
RESOURCE_PLAN=(
  "model:ngc:nvidia/tao/rtdetr_model:v1"
  "videos:local:/data/my-videos"
)
```

### Filename / dirname hints (optional)

If the user mentioned a **specific ONNX filename** or **specific videos
directory name** in their initial request (e.g. `"use model
rtdetr_warehouse_v1.0.1.fp16.onnx with videos nv-warehouse-4cams"`), save
those as **hints** so Step 1.g can pre-select the matching candidate inside
an `AskQuestion` picker — not to silently auto-pick it.

```bash
# Optional — empty if the user didn't mention a specific name.
MODEL_NAME_HINT="rtdetr_warehouse_v1.0.1.fp16.onnx"
VIDEOS_DIR_HINT="nv-warehouse-4cams"
```

Recognize hints by shape, not by matching against a hardcoded list:
- Any token ending in `.onnx` / `.engine` / `.etlt` / `.pt` → `MODEL_NAME_HINT`
- Any token that looks like a directory name stem (alphanumeric with `-`/`_`)
  mentioned near "videos" / "dir" / "folder" → `VIDEOS_DIR_HINT`

### Discover → decide → tell the user (minimal-interaction rule)

Hints **never** replace the dynamic-discovery pass. Every deploy:

1. **Discover** — scan the fetched resource by extension-only `find`
   (`*.onnx`, dirs containing `*.mp4`, etc.). No hardcoded filenames,
   no hardcoded directory names in the search.
2. **Decide** — apply the dispatch rules below. Most cases are
   auto-decided (1 candidate, hint uniquely matches, 0 candidates → hard
   error). Only truly ambiguous cases (>1 candidates, no hint) produce an
   `AskQuestion` picker.
3. **Tell the user** — print `✔ <role>: <filename>` with the concrete
   committed choice, plus any selection context (`1 of 1 found`,
   `matched query hint`, `selected from 3 candidates`). The user sees
   what's being used without being asked to approve it.

**Auto-decision rules (no picker, just print and proceed):**

| Situation | Action |
|---|---|
| 1 candidate found | Auto-use it. Print `✔ <role>: <filename> (1 of 1 found)`. |
| >1 candidates, hint matches exactly one | Auto-use the hint match. Print `✔ <role>: <filename> (matched query hint)`. |
| >1 candidates, hint matches none / no hint | **Picker required** — this is genuinely undecidable. |
| 0 candidates | Hard error — retry / switch / abort picker. |

**Hints never override "0 found" errors** — if the resource doesn't contain
the hinted file at all, the error path runs as usual (retry ref / switch
to local / abort). Hints are purely a way to resolve ambiguity when the
scan finds multiple candidates.

### Plan summary + NEEDS_NGC

After Refs / paths collection, print the resolved plan:

```
✔ Resource plan:
    • model  → NGC (nvidia/tao/rtdetr_model:v1)
    • videos → local (/data/my-videos)
```

Then compute `NEEDS_NGC`:

```bash
NEEDS_NGC=0
for entry in "${RESOURCE_PLAN[@]}"; do
    [[ "$entry" == *:ngc:* ]] && NEEDS_NGC=1 && break
done
```

- `NEEDS_NGC=1` → Step 5 runs normally (ask/reuse NGC config).
- `NEEDS_NGC=0` → skip Step 5 entirely. Immediately mark the `ngc_creds` todo
  `completed` via `TodoWrite merge:true` and print:
  `✔ NGC credentials: not needed (all sources local)`.

---

## Step 5 — NGC Credentials (conditional)

Only runs if `NEEDS_NGC=1`. Otherwise this step is a no-op (see 4.c above).

When it does run, the existing flow in `ngc-setup.md` applies
verbatim — check `~/.ngc/config`, reuse if present, otherwise ask once,
write with `chmod 600`, verify with `ngc config current`.

---

## Step 1.g — Fetch or copy resources

**On entry:** `→ Fetch resources (NGC download / local copy)`

For each entry in `RESOURCE_PLAN`, dispatch on source type. All results land
under `$HOME/rtvicv-storage/resources/` on the host so the existing
`-v $HOME/rtvicv-storage:/opt/storage` mount exposes them in the container
at `/opt/storage/resources/`.

### 7.a — NGC download (per NGC entry)

```bash
cd $HOME/rtvicv-storage/resources

# Pick `resource` vs `model` based on NGC ref type (the skill uses `resource`
# by default; `model` refs are typically flagged by the user or by the
# usecases.md table — fall back to trying `resource` first, then `model`).
ngc registry resource download-version "<NGC_REF>" || \
    ngc registry model download-version "<NGC_REF>"

# Untar if the resource shipped tarballs
for f in "$DOWNLOAD_DIR"/*.tar.gz; do
    [[ -f "$f" ]] && (cd "$DOWNLOAD_DIR" && tar -xvf "$f")
done
```

Heartbeat every 15-20s on long downloads — see `ux-conventions.md`.

### 7.b — Local copy / symlink (per local entry)

| Asset type | Strategy |
|---|---|
| Single file (`.onnx`, `.etlt`, `.engine`) | `cp` into `$RESOURCES/local-<asset>/` |
| Directory (videos, calibration data) | `cp -r` into `$RESOURCES/local-<asset>/` |

> **Never use `ln -sfn` for paths outside `$HOME/rtvicv-storage`.** The docker
> run only mounts `$HOME/rtvicv-storage:/opt/storage`. A symlink whose target is
> outside that tree (e.g. `~/smc/videos`) is valid on the host but dangling
> inside the container — the container follows the link and hits "No such file".
> Always copy so the data lands physically inside the mounted volume.

```bash
RESOURCES=$HOME/rtvicv-storage/resources
mkdir -p "$RESOURCES"

stage_local() {
    local role="$1"   # e.g. "model", "videos"
    local src="$2"    # user-provided absolute path
    local dst="$RESOURCES/local-$role"

    if [[ -f "$src" ]]; then
        mkdir -p "$dst"
        cp "$src" "$dst/"
    elif [[ -d "$src" ]]; then
        # Copy, not symlink — symlinks outside $HOME/rtvicv-storage are broken
        # inside the container (only that tree is mounted as /opt/storage).
        rm -rf "$dst"
        cp -r "$src" "$dst"
    else
        echo "STAGE_ERROR: $src does not exist" >&2
        return 1
    fi
    echo "STAGED: role=$role src=$src dst=$dst"
}
```

Print one `    ✔ <role>: staged at resources/local-<role>` per asset.

### 7.c — Scan fetched resource contents (dispatch on what's inside)

**The whole point of this sub-step:** catch mismatches between what the user
*said* the resource would provide vs. what actually landed on disk. Do this
once per NGC entry (local entries are already known — the user told us what
they contain).

```bash
# For each freshly-downloaded NGC resource directory:
scan_ngc_resource() {
    local dir="$1"
    local models=() video_dirs=()

    # Models — any ONNX / engine / ETLT under the resource
    mapfile -t models < <(find "$dir" -type f \
        \( -name '*.onnx' -o -name '*.engine' -o -name '*.etlt' \))

    # Video directories — any subdir containing at least one .mp4 / .mkv
    while IFS= read -r d; do
        if find "$d" -maxdepth 1 \( -name '*.mp4' -o -name '*.mkv' \) \
               -print -quit | grep -q .; then
            video_dirs+=("$d")
        fi
    done < <(find "$dir" -type d)

    echo "SCAN_RESULT dir=$dir models=${#models[@]} video_dirs=${#video_dirs[@]}"
    printf '  model: %s\n' "${models[@]}"
    printf '  videos_dir: %s\n' "${video_dirs[@]}"
}
```

### 7.d — Dispatch on scan result (role-based)

Every `RESOURCE_PLAN` entry carries a **role** — `model` or `videos` —
and the dispatch is driven by what that role expects. **Scan the resource
once, then evaluate against the role.** When the user provides two
separate NGC refs (one per role, typical smartcity case), each is scanned
and dispatched INDEPENDENTLY — no cross-contamination. When the same NGC
ref appears under both roles (warehouse-2d / warehouse-3d), the download
is de-duped, then each role scans the extracted tree for its own files.

#### Role = `model`

E.g. `model:ngc:$DEFAULT_MODEL_NGC_REF` (resolved from YAML at runtime).

| Scan result | Action |
|---|---|
| Exactly 1 model artifact | Auto-use. Print `    ✔ model: <filename> (1 of 1 found)`. No prompt. |
| >1 model artifacts, `MODEL_NAME_HINT` uniquely matches one | Auto-select the hint match. Print `    ✔ model: <filename> (matched query hint)`. No prompt. |
| >1 model artifacts, hint matches none / no hint | `AskQuestion` picker with one option per candidate. Committed choice feeds Step 4.a. This is the only case that prompts. |
| 0 model artifacts | `✖ <ref> does not contain any model files (*.onnx/*.engine/*.etlt).` → `AskQuestion`: (a) retry with another NGC ref, (b) switch to a local model path, (c) abort. Re-enter Refs / paths collection for this asset only — other roles stay resolved. |
| Extras present (e.g. videos in a model-role resource) | Silently ignored — not this entry's role. |

#### Role = `videos`

E.g. `videos:ngc:$DEFAULT_VIDEOS_NGC_REF` (resolved from YAML at runtime).

| Scan result | Action |
|---|---|
| Exactly 1 video directory | Auto-use. Print `    ✔ videos: <dirname> (1 of 1 found, N .mp4 files)`. No prompt. |
| >1 video directories, `VIDEOS_DIR_HINT` uniquely matches one basename | Auto-select the hint match. Print `    ✔ videos: <dirname> (matched query hint)`. No prompt. |
| >1 video directories, hint matches none / no hint | `AskQuestion` picker with one option per candidate (dir name + file count). For `warehouse-3d`, post-check the chosen dir's `.mp4` stems against `sensors[].id` in `calibration.json` and warn on mismatch. This is the only case that prompts. |
| 0 video directories | `✖ <ref> does not contain any directories with .mp4/.mkv files.` → retry-ref / switch-to-local / abort. |
| Extras present (e.g. an ONNX inside a videos-role resource) | Ignored — not this entry's role. |

#### Same ref under both roles (warehouse-2d / warehouse-3d)

When `RESOURCE_PLAN` has both `model:ngc:<ref>` and `videos:ngc:<ref>`
with the same `<ref>`, download once and run the model + videos scans
above against the same extracted tree. Each role's miss case (no model
files, no video dirs) follows the per-role tables — no separate "ref is
empty" failure mode.

### Passing scanned choices to Step 4.a (no re-discovery)

Every committed choice from 7.d is exported as the env var Step 4.a would
otherwise `find` for. When the var is already set, Step 4.a skips the
`resolve_or_ask` dance — no duplicate disambiguation prompts.

| Role + use case | Env var set by 7.d |
|---|---|
| model (warehouse-2d)    | `WAREHOUSE_2D_ONNX` |
| model (warehouse-3d)    | `SPARSE4D_ONNX`, `SPARSE4D_LABELS`, `SPARSE4D_ANCHOR`, `SPARSE4D_CALIB` (when present) |
| model (smartcity-rtdetr)| `RTDETR_ONNX` |
| model (smartcity-gdino) | `GDINO_ONNX` |
| videos (any)            | `WAREHOUSE_2D_VIDEOS` / `WAREHOUSE_3D_VIDEOS` / `SMC_VIDEOS` |

The goal: by the time Step 1.g exits, the user has a concrete, confirmed view
of what's on disk, every asset has a single committed path, and Steps 9-10
consume those paths without asking the user anything again.

### 7.e — Exit line

```
✔ Resources ready:
    • model  → /opt/storage/resources/<ngc-dir>/path/to/model.onnx
    • videos → /opt/storage/resources/local-videos  (symlink → /data/my-videos)
```

(Use container-relative paths — `/opt/storage/...` — since that's what Steps
9-10 will consume.)

---

## Step 3.2 — Docker mount adjustment

Base mounts (always):

```
-v $HOME/rtvicv-storage:/opt/storage
```

Conditional mount:

```bash
```

If `NEEDS_NGC=0`, the `-v $HOME/.ngc:...` flag is omitted. The container
never sees the NGC config — there's nothing to download from NGC inside the
container, and exposing credentials that aren't needed is pointless.

Display flags (only for eglsink) and `--name <CONTAINER_NAME>` are independent
of the NGC decision — add them per `platforms.md` as usual.

---

## Edge cases

- **User changes their mind mid-flow.** If scan reveals a missing asset
  (Step 1.g second/third row), treat the follow-up AskQuestion answer as a
  partial Step 4 re-run for that asset only. Don't re-ask for the assets
  that already resolved.
- **User pastes a path that doesn't exist.** `stage_local()` returns
  non-zero; print `✖ Path not found: <path>` and re-ask.
- **Local path inside `$HOME/rtvicv-storage` already.** Skip the copy —
  symlink instead, or just point the role at the path directly. Don't
  duplicate storage.
- **Mixed plan + parallel deploy.** The `RESOURCE_PLAN` array is specific to
  this deploy. Each parallel deploy computes its own plan and `NEEDS_NGC`.
- **Reused container (Step 3 "reuse" branch).** The NGC mount decision is
  baked into the original `docker run`. If reusing a container that was
  launched without the NGC mount, but the current deploy plan has NGC
  assets, either (a) use `restart` instead of `reuse`, or (b) download on
  the host before reusing. Print a warning on this mismatch.
