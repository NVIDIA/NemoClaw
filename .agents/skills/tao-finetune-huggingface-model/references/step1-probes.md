<!--
Copyright (c) 2026, NVIDIA CORPORATION.  All rights reserved.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
-->

# Step 1 Containerized Probes

Model + dataset probes run inside a small CPU-only `python:3.12-slim`
container, so the host needs no Python prerequisites (`python3-pip`,
`python3-venv`, distro-managed Python). Docker is the only host-side
prerequisite.

---

## Docker prerequisite (Step 1 preflight)

Step 1's probes run inside Docker (no host venv / pip needed), so Docker has
to exist on the host before Step 1a. The full GPU-runtime preflight still
happens in Step 2a — this just covers the Docker-daemon prereq earlier so the
probe's `docker run` doesn't fail with a bare `docker: command not found`:

```bash
TAO_SKILL_BANK_ROOT="${TAO_SKILL_BANK_PATH:-${TAO_SKILL_BANK_ROOT:-$PWD}}"
SETUP_SCRIPT="${TAO_SKILL_BANK_ROOT}/platform/tao-setup-nvidia-gpu-host/scripts/setup-nvidia-gpu-host.sh"
[ -x "$SETUP_SCRIPT" ] || SETUP_SCRIPT="${TAO_SKILL_BANK_ROOT}/skills/tao-setup-nvidia-gpu-host/scripts/setup-nvidia-gpu-host.sh"

if ! command -v docker >/dev/null 2>&1; then
  echo "MISSING: docker is required for Step 1's containerized probe."
  echo "After user approval, run the platform installer (same one Step 2a uses):"
  echo "  bash \"$SETUP_SCRIPT\" --backend docker --install --yes"
  echo "Then re-source your shell or 'newgrp docker' so the new group membership applies."
  exit 1
fi
```

If you'd rather front-load the full driver/CUDA/NCT preflight (recommended
on a fresh host), just call `bash "$SETUP_SCRIPT" --backend docker --check-only`
here — same invocation Step 2a uses, repeated calls are cheap.

---

## 1a. Probe model

The probe runs inside a small CPU-only `python:3.12-slim` container so the
host needs no Python prereqs (`python3-pip`, `python3-venv`, distro-managed
Python). Save the script to `$OUTPUT_DIR/.probe/model_probe.py` first so
it's diff-able, then run it with a bind-mounted scratch dir for cache reuse.

Docker rejects relative paths in `-v` (anything not starting with `/` is
parsed as a named-volume name and fails for `./output/...`). The snippet
normalizes `$OUTPUT_DIR` to an absolute path with a single bash case
before any `mkdir` / `cat` / `docker run`, so both the default
relative `./output/<short>` and an explicit absolute override resolve
correctly:

```bash
case "$OUTPUT_DIR" in
  /*) ;;
  *) OUTPUT_DIR="$(pwd)/$OUTPUT_DIR" ;;
esac
mkdir -p "$OUTPUT_DIR/.probe/.cache"
cat > "$OUTPUT_DIR/.probe/model_probe.py" <<'PY'
import os, sys
from transformers import AutoConfig
from huggingface_hub import model_info
mid = os.environ["MODEL_ID"]; tok = os.environ.get("HF_TOKEN") or None  # optional — public models work without it
try:
    cfg = AutoConfig.from_pretrained(mid, token=tok, trust_remote_code=True)
except Exception as e:
    # If this is a gated model, the error message will name 401/access-denied;
    # tell the user to export HF_TOKEN and retry.
    print(f"REJECT: AutoConfig failed — {e}"); sys.exit(1)
info = model_info(mid, token=tok)
print("model_type:", cfg.model_type)
print("architectures:", getattr(cfg, "architectures", []))
print("tags:", info.tags)
print("hidden_size:", getattr(cfg, "hidden_size", None))
print("num_kv_heads:", getattr(cfg, "num_key_value_heads", None))
print("num_attn_heads:", getattr(cfg, "num_attention_heads", None))
PY

docker run --rm \
  --user $(id -u):$(id -g) \
  -e HOME=/probe -e PIP_USER=1 \
  -e MODEL_ID="$MODEL_ID" -e HF_TOKEN \
  -e HF_HOME=/probe/.cache -e PIP_CACHE_DIR=/probe/.cache/pip \
  -v "$OUTPUT_DIR/.probe":/probe -w /probe \
  python:3.12-slim \
  bash -c "pip install -q transformers huggingface_hub datasets Pillow && python model_probe.py"
```

Notes:
- `--user $(id -u):$(id -g)` keeps any cached files in `.probe/.cache`
  owned by the host user. Without it the cache ends up `root:root` and
  cleanup needs sudo.
- `HOME=/probe` + `PIP_USER=1` makes `pip install` resolve to
  `--user` mode (installing into `/probe/.local/lib/python3.12/site-packages`
  inside the bind mount). System `/usr/local/lib/python3.12/site-packages`
  in `python:3.12-slim` is root-owned, so without these env vars the pip
  install would fail with `PermissionError` once `--user $(id -u):$(id -g)`
  drops root. Python picks up the user-site automatically via `site.py`.
- The first invocation downloads `python:3.12-slim` (~50 MB) and a fresh set
  of HF wheels (~150 MB) into `.probe/.cache/pip` plus
  `.probe/.local/lib/python3.12/site-packages/`; subsequent probes reuse
  both.
- The probe never installs anything on the host — Docker is the only
  host-side prereq, and the Step 1 preflight above verifies it.

Detect `task` from `architectures` + `tags` + model-card body. If the card
doesn't show `from transformers import AutoModelFor...`, fall back to
`model-discovery.md` and log the fallback under `notes:`.

---

## 1b. Probe dataset

For `source = recommend`, present 3–5 picks from
`dataset-recommendations.md` to the user, then re-run with the chosen
`dataset_id` / `local_dataset_path`.

Same in-container pattern as 1a — write the script to `.probe/dataset_probe.py`
first, then run it under `python:3.12-slim` with the bind-mounted cache.
Step 1b is a separate bash invocation, so it repeats the `$OUTPUT_DIR`
normalization (the variable doesn't survive across `bash -c` calls):

```bash
case "$OUTPUT_DIR" in
  /*) ;;
  *) OUTPUT_DIR="$(pwd)/$OUTPUT_DIR" ;;
esac
cat > "$OUTPUT_DIR/.probe/dataset_probe.py" <<'PY'
# HF source loadability + schema probe (catches gated / script-based / missing)
import os
from datasets import load_dataset, load_dataset_builder
DID = os.environ["DATASET_ID"]; TOK = os.environ.get("HF_TOKEN") or None  # optional — public datasets work without it
try:
    load_dataset_builder(DID, token=TOK)
    ds = load_dataset(DID, split="train[:20]", token=TOK)
except Exception as e:
    print(f"REJECT dataset: {type(e).__name__}: {e}"); raise
rows = list(ds)
print("columns:", list(rows[0].keys()))
for col, val in rows[0].items():
    print(f"  {col}: {type(val).__name__}")
PY

docker run --rm \
  --user $(id -u):$(id -g) \
  -e HOME=/probe -e PIP_USER=1 \
  -e DATASET_ID="$DATASET_ID" -e HF_TOKEN \
  -e HF_HOME=/probe/.cache -e PIP_CACHE_DIR=/probe/.cache/pip \
  -v "$OUTPUT_DIR/.probe":/probe -w /probe \
  python:3.12-slim \
  bash -c "pip install -q transformers huggingface_hub datasets Pillow && python dataset_probe.py"
```

Same `HOME=/probe` + `PIP_USER=1` rationale as 1a — the install lands in
`.probe/.local/lib/python3.12/site-packages` and survives between probes
under the bind mount.

For `source = local`, see `dataset-sources.md` for format detection
and loaders. Bind-mount the local dataset path with an additional
`-v "<local_dataset_path>":"<local_dataset_path>":ro` so the container can
read it, and adapt `dataset_probe.py` to use the local loader instead of
`load_dataset(DID, …)`.

Verify columns match the task schema (Core rules → Dataset format). Mismatch +
rename fixes it → write the rename into `prepare_data.py`. Otherwise stop.

---

## Probe scratch dir cleanup

Optionally clean up the probe scratch dir once the gate is met:

```bash
rm -rf "$OUTPUT_DIR/.probe"
```

Keeping it around between reruns is fine — it caches `python:3.12-slim`
layers, pip wheels, and any HF model/dataset files already pulled, so a
re-probe is fast. Add `.probe/` to `.gitignore` (covered in Step 4a).

---

## Step 1 prerequisites (assumed set by the calling agent)

- `MODEL_ID`, optional `DATASET_ID`, optional `HF_TOKEN` (loaded from the
  SessionStart hook when present).
- `OUTPUT_DIR` — defaults to `./output/<model_short_name>`. Same variable
  Steps 4–5 bind-mount into the training container, so any HF/pip cache the
  probe leaves behind under `$OUTPUT_DIR/.probe/.cache` survives for later
  inspection but is gitignored.

---

## 1c. Apply accept/reject

REJECT if:
- `AutoConfig` raised
- task can't be determined
- task is not CV / VLM / SFT-LLM (out of scope)
- no recipe source exists at all (no card example, no HF repo script, no author
  finetune, no task doc, no paper)
- dataset is gated / script-based / missing (loadability probe failed)

Stop and report the specific reason. Do not proceed.

---

## 1d. Walk compat-workarounds

For every entry in `compat-workarounds.md`, evaluate its `detect`
expression against `cfg` and the detected `task`. Hardware-dependent rules
(those needing `hw`) are deferred to Step 2.

Record matches in `config.yaml` under `applicable_workarounds:` (id + fix type +
one-line reason). Each becomes a Dockerfile block, requirements pin, config
override, or runtime env in Step 4.

---

## 1e. Write `config.yaml` skeleton

```yaml
model_id: <…>
task: <…>
dataset_id: <…>             # or local_dataset_path
research_sources: []         # filled in Step 3
applicable_workarounds: [<…>]
notes: []                    # log any reference fallback
push_to_hub: true            # default
```
