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

Full Phase 1 walkthrough for the `tao-port-huggingface-model` skill — credential gathering, branch creation, launching the long-lived `tao-hf-inspect` Docker container (no host venv), model/dataset inspection via `docker exec`, and the Phase 1 gate. See `hf-inspection.md` for a generic HF-inspection cheat sheet.

## Phase 1 — Information Gathering & Validation

### 1.1 Gather credentials, targets, and locate repos
Ask the user for:
- **HuggingFace Model ID** — e.g., `google/vit-base-patch16-224`
- **HuggingFace Access Token** (`HF_TOKEN`) — required for gated models
- **Model short-name** for TAO — a `snake_case` identifier used for directory names and class names (e.g., `vit_base_p16`)
- **Do you already have the TAO repos cloned locally?** Ask for the paths to `tao-core`, `tao-pytorch`, `tao-deploy`, and `tao-dataservices`. If the user provides paths, verify they exist and use them. Only clone repos that are missing.

If any repos need to be cloned, ask the user where they'd like them cloned to (default: current working directory), then clone only the missing ones:
```bash
# Only clone what's needed — skip repos the user already has
git clone <tao-core-url> /path/to/tao-core
git clone <tao-pytorch-url> /path/to/tao-pytorch
git clone <tao-deploy-url> /path/to/tao-deploy
git clone <tao-dataservices-url> /path/to/tao-dataservices
```

After cloning, each repo (tao-pytorch, tao-deploy, tao-dataservices) will have a `tao-core/` submodule inside it. This submodule points to the original commit and should NOT be used — always use our top-level `tao-core/` clone instead (see "Submodule Override Strategy" above).

### 1.2 Create a consistent working branch across all repos

Before any implementation work, create a new branch in **every** repo so changes are isolated and consistent:

1. Ask the user for:
   - **Branch name** — e.g., `feature/add-vit-base-p16`
   - **Base branch** — default is `main`. Ask if they want a different base.

2. Create the branch in all repos:
```bash
for repo in tao-core tao-pytorch tao-deploy tao-dataservices; do
  cd /path/to/$repo
  git checkout <base_branch>
  git pull origin <base_branch>
  git checkout -b <branch_name>
  cd -
done
```

**Important:** This branch is local only — it will NOT be pushed. It just keeps changes organized and makes it easy to diff against the base branch.

### 1.3 Set up an isolated environment for HF inspection

All Phase 1 Python work runs **inside the prepared `tao-pytorch-base:latest`
container** (built in Phase 0) — do NOT install into the host Python. That
image already ships `torch`, `transformers`, `onnx`, and `timm`, and is the
same image used in Phases 3/4/6, so there is no need to maintain a separate
host venv or to apt-install `python3-venv` / `python3-pip` on the host.

```bash
# Scratch dir on the host, bind-mounted into the container as /workspace.
# The directory is owned by the host user that created it, and we run the
# container as that same UID/GID via --user below, so no further chmod is
# needed.
mkdir -p ./.phase1/cache

# Launch a long-lived inspection container so each probe step is a quick `docker exec`.
docker rm -f tao-hf-inspect 2>/dev/null || true
docker run -d --name tao-hf-inspect \
  --user $(id -u):$(id -g) \
  -v "$(pwd)/.phase1":/workspace \
  -e HF_HOME=/workspace/cache -e HF_TOKEN \
  -w /workspace \
  tao-pytorch-base:latest sleep infinity
```

`--user $(id -u):$(id -g)` keeps any files written under `./.phase1` (HF
cache, the ONNX scratch file) owned by the host user. Use `--gpus all` only
if a probe step needs GPU; AutoConfig / AutoModel / ONNX export are
CPU-only.

If `tao-pytorch-base:latest` is unavailable (e.g. Phase 0 was skipped on a
machine that only has CPU), fall back to a small CPU-only image. Note the
extra `HOME=/workspace` + `PIP_USER=1` env: `python:3.12-slim`'s system
`site-packages` (`/usr/local/lib/python3.12/site-packages`) is root-owned,
so the pip install would fail with `PermissionError` once
`--user $(id -u):$(id -g)` drops root. Setting `HOME` + `PIP_USER` routes
the install into `/workspace/.local/lib/python3.12/site-packages` inside
the bind mount, which the host user can write to. Python's `site.py` then
adds that user-site to `sys.path` automatically for subsequent `docker
exec` probes:

```bash
docker run -d --name tao-hf-inspect \
  --user $(id -u):$(id -g) \
  -v "$(pwd)/.phase1":/workspace \
  -e HOME=/workspace -e PIP_USER=1 \
  -e HF_HOME=/workspace/cache -e HF_TOKEN \
  -e PIP_CACHE_DIR=/workspace/cache/pip \
  -w /workspace \
  python:3.12-slim \
  bash -c "pip install -q transformers huggingface_hub torch onnx timm && sleep infinity"
```

### 1.4 Validate that the model is a Computer Vision model

Run the probe via `docker exec`:

```bash
docker exec -e MODEL_ID="$MODEL_ID" tao-hf-inspect python - <<'PY'
import os
from huggingface_hub import model_info
mid = os.environ["MODEL_ID"]; tok = os.environ.get("HF_TOKEN") or None
info = model_info(mid, token=tok)
print(info.pipeline_tag)   # must be: image-classification, object-detection, image-segmentation, etc.
PY
```
**Hard stop:** If `pipeline_tag` is an NLP, audio, or LLM task, halt and inform the user. TAO Toolkit currently supports Computer Vision models only.

### 1.5 Fetch the model architecture and checkpoint

```bash
docker exec -e MODEL_ID="$MODEL_ID" tao-hf-inspect python - <<'PY'
import os
from transformers import AutoModel, AutoConfig
mid = os.environ["MODEL_ID"]; tok = os.environ.get("HF_TOKEN") or None
config = AutoConfig.from_pretrained(mid, token=tok)
model  = AutoModel.from_pretrained(mid, token=tok)
state_dict = model.state_dict()
print(config)
for k, v in list(state_dict.items())[:30]:
    print(k, tuple(v.shape))
PY
```
- Print `config` to extract: `model_type`, `image_size`, `hidden_size`, `num_labels`, `num_hidden_layers`, `patch_size`
- Print the top-level `state_dict` keys and shapes to understand HF naming conventions
- Assess whether the HF task head is separable from the backbone
- Draft a key-name remapping plan for the HF-to-TAO `state_dict` conversion

### 1.6 Verify ONNX exportability

```bash
docker exec -e MODEL_ID="$MODEL_ID" tao-hf-inspect python - <<'PY'
import os, torch
from transformers import AutoConfig, AutoModel
mid = os.environ["MODEL_ID"]; tok = os.environ.get("HF_TOKEN") or None
config = AutoConfig.from_pretrained(mid, token=tok)
model  = AutoModel.from_pretrained(mid, token=tok).eval()
img_size = getattr(config, "image_size", 224)
if isinstance(img_size, int):
    img_size = (img_size, img_size)
dummy = torch.randn(1, 3, *img_size)
torch.onnx.export(model, dummy, "/workspace/tao_hf_test.onnx",
    input_names=["input"], output_names=["output"],
    dynamic_axes={"input": {0: "batch"}, "output": {0: "batch"}},
    opset_version=17)
print("ONNX export OK")
PY
```
If this fails, identify the problematic ops and apply workarounds **before** starting TAO integration:
- **Unsupported op** → Replace with ONNX-compatible equivalent (e.g., replace `torch.einsum` with explicit `matmul`/`permute`, replace custom CUDA kernels with pure PyTorch ops)
- **Dynamic control flow** (if/else on tensor values) → Rewrite as static ops or use `torch.where()`
- **Unsupported attention variant** → Rewrite using standard `nn.MultiheadAttention` or explicit Q/K/V matmuls
- **Try higher opset** → `opset_version=17` or `18` supports more ops than older versions
- **TensorRT compatibility** → After ONNX export succeeds, test with `trtexec` inside the prepared tao-deploy container (the host does not have TensorRT):
  ```bash
  docker run --rm --gpus all \
    --user $(id -u):$(id -g) \
    -v "$(pwd)/.phase1":/workspace \
    -w /workspace \
    tao-deploy-base:latest \
    trtexec --onnx=/workspace/tao_hf_test.onnx --buildOnly
  ```
  If TRT fails on specific layers, those ops will need to be rewritten in the TAO implementation — record them now
- **If export fundamentally cannot work** (e.g., architecture uses dynamic shapes that vary per-input), inform the user — the model may not be suitable for TensorRT deployment

### 1.7 Clean up Phase 1 environment

After all inspection is complete and findings are recorded:
```bash
docker rm -f tao-hf-inspect

# Remove the host scratch dir (HF cache + tao_hf_test.onnx + pip cache).
# Keep .phase1 around between reruns if you want to skip the model redownload.
rm -rf ./.phase1
```

### Phase 1 Gate — Confirm before proceeding:
- [ ] All 4 TAO repos located or cloned
- [ ] Consistent working branch created across all repos
- [ ] `pipeline_tag` is a supported CV task
- [ ] `model_type`, `image_size`, `hidden_size`, `num_labels` extracted
- [ ] Top-level `state_dict` keys documented, remapping plan drafted
- [ ] ONNX export sanity check passed (or failure mode understood)
- [ ] User confirmed the model short-name and task type

**Present findings to the user and get confirmation before proceeding to implementation.**

---

