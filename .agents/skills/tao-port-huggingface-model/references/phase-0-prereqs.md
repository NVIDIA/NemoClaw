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

Full Phase 0 commands and content for the `tao-port-huggingface-model` skill — system prerequisite checks plus the one-time preparation of the published TAO Toolkit container images that the rest of the workflow runs inside. Linked from the SKILL.md Phase 0 summary.

## Phase 0 — Prerequisites Check

Before starting any work, verify the system has all required infrastructure. **Hard stop if any check fails — resolve before proceeding.**

### Workflow-specific checks

```bash
# Python 3.10+
python3 --version

# git
git --version
```

### GPU host runtime — delegate to tao-setup-nvidia-gpu-host

The NVIDIA driver (branch 580), CUDA Toolkit 13.0, and NVIDIA Container
Toolkit 1.19.0 are owned by the `tao-skill-bank:tao-setup-nvidia-gpu-host` skill, not
by this workflow. Invoke its `--check-only` mode; on failure, ask the user to
authorize the install, then re-run.

```bash
TAO_SKILL_BANK_ROOT="${TAO_SKILL_BANK_PATH:-${TAO_SKILL_BANK_ROOT:-$PWD}}"
SETUP_SCRIPT="${TAO_SKILL_BANK_ROOT}/platform/tao-setup-nvidia-gpu-host/scripts/setup-nvidia-gpu-host.sh"
[ -x "$SETUP_SCRIPT" ] || SETUP_SCRIPT="${TAO_SKILL_BANK_ROOT}/skills/tao-setup-nvidia-gpu-host/scripts/setup-nvidia-gpu-host.sh"

bash "$SETUP_SCRIPT" --backend docker --check-only || {
  echo "MISSING: TAO GPU host runtime not ready."
  echo "After user approval, run: bash \"$SETUP_SCRIPT\" --backend docker --install --yes"
  exit 1
}
```

This single delegation covers `nvidia-smi`, `nvcc`, the Docker daemon, the
NVIDIA Container Toolkit runtime registration, and the `docker run --gpus
all` smoke test. Do not re-implement those checks here — they live in
`tao-setup-nvidia-gpu-host` so every TAO skill picks up version pin changes the
moment that skill bumps.

### NGC registry login (TAO-Toolkit-specific)

```bash
# NGC Docker registry authentication (required to pull the TAO Toolkit container images from nvcr.io)
docker login nvcr.io
# Username: $oauthtoken
# Password: <NGC API Key>
# Verify: should print "Login Succeeded"
```

**NGC API Key:** required to pull the TAO Toolkit container images from `nvcr.io`. If the user does not have one, they must generate it at https://ngc.nvidia.com/setup/api-key. The login uses `$oauthtoken` as the username (literal string) and the NGC API key as the password.

**Checklist:**
- [ ] Python >= 3.10 installed
- [ ] `git` installed
- [ ] `tao-setup-nvidia-gpu-host --check-only` passes (driver 580, CUDA 13.0, NCT 1.19.0, `docker run --gpus all` smoke)
- [ ] NGC Docker registry authenticated (`docker login nvcr.io` succeeds)

If anything is missing, inform the user with the specific failure and what needs to be installed. Do NOT proceed until all checks pass.

---

### Ask the user for the TAO Toolkit container images

This skill drives modifications across `tao-core`, `tao-pytorch`, `tao-deploy`, and `tao-dataservices` and runs every test inside the matching TAO Toolkit container image on `nvcr.io`. Tags vary per release, so **the agent must ask the user for the exact image references** — the same way Phase 1 asks for repository paths and HF credentials. Ask up-front so they're available for every later phase.

Prompt the user with:

> Please provide the TAO Toolkit container image references you have access to on `nvcr.io` (or any registry mirror). Tags vary per release — paste the exact `<registry>/<repo>:<tag>` (or `@sha256:...`) string.
>
> 1. **tao-pytorch image** (required) — typically `nvcr.io/<org>/tao-toolkit:<version>-pyt` or `nvcr.io/<org>/tao-toolkit-pyt:<rc-tag>-multiarch`.
> 2. **tao-deploy image** (required) — typically `nvcr.io/<org>/tao-toolkit:<version>-deploy` or `nvcr.io/<org>/tao-toolkit-deploy:<rc-tag>-multiarch`.
> 3. **tao-dataservices image** (optional — only required if Phase 2.4 finds annotation-converter work) — typically `nvcr.io/<org>/tao-toolkit:<version>-data-services` or `nvcr.io/<org>/tao-toolkit-ds:<rc-tag>-multiarch`.
>
> tao-core does not require its own image — the public `nvcr.io/nvidia/pytorch:24.03-py3` image is used directly for tao-core smoke tests, or the prepared tao-pytorch image is reused.

Capture the answers into shell variables for the rest of Phase 0:

```bash
read -r -p "tao-pytorch image      : " TAO_PT_PUB_IMAGE
read -r -p "tao-deploy image       : " TAO_DEPLOY_PUB_IMAGE
read -r -p "tao-dataservices image : " TAO_DS_PUB_IMAGE   # leave blank to skip
```

If the user is non-interactive, accept the references as part of `$ARGUMENTS` or as environment variables exported beforehand.

---

### Pull and prepare the TAO Toolkit images

Each TAO Toolkit container image ships with the released TAO Python packages already installed (via wheels — see `tao-pytorch/release/docker/Dockerfile`, `tao-deploy/release/docker/Dockerfile.release`, and `tao-dataservices/release/docker/Dockerfile.release`). This skill installs the user's **local** clones of those packages on top via `pip install /workspace/...` + `python setup.py develop`, picking up all in-progress modifications. Pre-installed wheels would shadow the local source, so the preparation step removes them up front with `pip uninstall`. This leaves the CUDA + PyTorch + TensorRT + xformers + ONNX Runtime + OS layers fully intact, ready for the local source to be installed at run time.

The result is tagged with canonical local names that every later phase uses everywhere — `tao-pytorch-base:latest`, `tao-deploy-base:latest`, `tao-dataservices-base:latest` — so the per-release image references only ever appear here.

```bash
# Pull the TAO Toolkit container images
docker pull "$TAO_PT_PUB_IMAGE"
docker pull "$TAO_DEPLOY_PUB_IMAGE"
[ -n "$TAO_DS_PUB_IMAGE" ] && docker pull "$TAO_DS_PUB_IMAGE"

# Prepare the tao-pytorch image
#   Removes the pre-installed nvidia_tao_pytorch + nvidia_tao_core wheels (and their console_scripts).
docker build --build-arg PUB_IMAGE="$TAO_PT_PUB_IMAGE" -t tao-pytorch-base:latest - <<'EOF'
ARG PUB_IMAGE
FROM ${PUB_IMAGE}
# Remove pre-installed TAO packages so the local /workspace clones can be installed at run time.
RUN pip uninstall -y --quiet nvidia_tao_pytorch nvidia_tao_core 2>/dev/null || true
ENV PIP_DISABLE_PIP_VERSION_CHECK=1
EOF

# Prepare the tao-deploy image
docker build --build-arg PUB_IMAGE="$TAO_DEPLOY_PUB_IMAGE" -t tao-deploy-base:latest - <<'EOF'
ARG PUB_IMAGE
FROM ${PUB_IMAGE}
RUN pip uninstall -y --quiet nvidia_tao_deploy nvidia_tao_core 2>/dev/null || true
ENV PIP_DISABLE_PIP_VERSION_CHECK=1
EOF

# Prepare the tao-dataservices image (optional)
if [ -n "$TAO_DS_PUB_IMAGE" ]; then
  docker build --build-arg PUB_IMAGE="$TAO_DS_PUB_IMAGE" -t tao-dataservices-base:latest - <<'EOF'
ARG PUB_IMAGE
FROM ${PUB_IMAGE}
RUN pip uninstall -y --quiet nvidia_tao_ds nvidia_tao_pytorch nvidia_tao_core 2>/dev/null || true
ENV PIP_DISABLE_PIP_VERSION_CHECK=1
EOF
fi
```

**Notes on the preparation step:**

- `pip uninstall -y` removes both the package files **and** the registered `console_scripts` (`tao` CLI subcommands). When `python setup.py develop` runs against the local source in later phases, the entry points are re-registered cleanly.
- `nvidia_tao_core` is removed from every image because all three TAO Toolkit images install it; the local `pip install /workspace/tao-core` reinstalls the (potentially modified) version at run time.
- The dataservices image also pre-installs `nvidia_tao_pytorch`; we remove it too so a local-source override still wins.
- The `2>/dev/null || true` keeps the build idempotent — packages absent from a particular image variant don't fail the preparation.

**Verify the images work and the preparation succeeded:**

```bash
docker run --rm --gpus all tao-pytorch-base:latest nvidia-smi
docker run --rm --gpus all tao-deploy-base:latest nvidia-smi

# These should ALL print "not installed" — confirming the pre-installed packages were removed
docker run --rm tao-pytorch-base:latest \
  bash -c "pip show nvidia_tao_pytorch nvidia_tao_core 2>&1 | grep -E '(Name|not installed)'"
docker run --rm tao-deploy-base:latest \
  bash -c "pip show nvidia_tao_deploy nvidia_tao_core 2>&1 | grep -E '(Name|not installed)'"
```

If any `nvidia_tao_*` package still shows up in `pip show`, the preparation step missed something — re-check the image's `pip list` and add any missing `nvidia_tao_*` package to the corresponding `pip uninstall` line.

---

**Gate (Phase 0 done):**

- [ ] All system prerequisite checks pass.
- [ ] User provided TAO Toolkit image references for tao-pytorch, tao-deploy (and optionally tao-dataservices).
- [ ] `tao-pytorch-base:latest` and `tao-deploy-base:latest` exist locally and contain no pre-installed `nvidia_tao_*` packages.
- [ ] (Optional) `tao-dataservices-base:latest` exists locally if dataservices work is anticipated.

All subsequent phase reference files use the local tag names (`tao-pytorch-base:latest`, `tao-deploy-base:latest`, `tao-dataservices-base:latest`) — they don't need to know which underlying image fed them.

---
