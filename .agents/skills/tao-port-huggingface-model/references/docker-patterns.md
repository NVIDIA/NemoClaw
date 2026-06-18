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

# Docker & Container Patterns Reference

Concrete patterns extracted from the TAO repos for running tests in containers, building wheels, and (optionally) building release Docker images.

> **Note:** For testing, we run directly inside the prepared TAO Toolkit containers (image tags built in Phase 0) — no Docker build is involved in the test loop. Release Docker images are optional and only for distribution validation. All work must be **local only** (`--load`, not `--push`). Do NOT push images to any registry.

> **Authority for generic flags:** the `--gpus`, `--ipc=host` / `--shm-size`,
> `-v host:container`, `-e VAR` passthrough, container-name reuse, and
> `docker inspect` / `docker logs` patterns are owned by
> [`tao-skill-bank:tao-run-on-docker`](../../../platform/tao-run-on-docker/SKILL.md). The host GPU
> runtime (driver 580 / CUDA 13.0 / NVIDIA Container Toolkit 1.19.0) is owned
> by [`tao-skill-bank:tao-setup-nvidia-gpu-host`](../../../platform/tao-setup-nvidia-gpu-host/SKILL.md).
> Patterns in this file only layer on the TAO-Toolkit-specific bits — image
> preparation, `pip install /workspace/tao-core`, `setup.py develop`, the
> per-repo `pytest` / lint / wheel invocations.

---

## 1. Dockerfile Locations

| Repo | Development | Release | L4T (Jetson) |
|------|------------|---------|--------------|
| tao-pytorch | `docker/Dockerfile` | `release/docker/Dockerfile` | — |
| tao-deploy | `docker/Dockerfile` | `release/docker/Dockerfile.release` | `docker/Dockerfile.l4t`, `release/docker/Dockerfile.l4t.release` |
| tao-core | `Dockerfile` (multistage) | same | — |
| tao-dataservices | `docker/Dockerfile` | `release/docker/Dockerfile.release` | — |

---

## 2. TAO Toolkit Container Images

The skill runs every test inside a TAO Toolkit container image on `nvcr.io`. Phase 0 asks the user for each image reference (tags vary per release), pulls them, and prepares them as local image tags that every other reference file uses everywhere:

| Repo | Local tag (prepared in Phase 0) | Underlying TAO Toolkit image (user-supplied) |
|------|---------------------------------|----------------------------------------------|
| **tao-core** | `tao-pytorch-base:latest` (or `nvcr.io/nvidia/pytorch:24.03-py3`) | public NGC PyTorch image, or reuses the prepared tao-pytorch image |
| **tao-pytorch** | `tao-pytorch-base:latest` | tao-pytorch image (e.g. `nvcr.io/<org>/tao-toolkit:<version>-pyt`) |
| **tao-deploy** | `tao-deploy-base:latest` | tao-deploy image (e.g. `nvcr.io/<org>/tao-toolkit:<version>-deploy`) |
| **tao-dataservices** | `tao-dataservices-base:latest` (optional) | tao-dataservices image (e.g. `nvcr.io/<org>/tao-toolkit:<version>-data-services`) |

The TAO Toolkit images are typically multi-arch manifests, so the same reference works on both `x86_64` and `aarch64` hosts — Docker auto-selects the matching layer. Detect arch with `uname -m` if needed (`x86_64` → x86, `aarch64` → ARM64).

**Use these local tags directly as containers for testing — do NOT build Docker images from Dockerfiles for testing.** TAO testing runs tests inside a TAO Toolkit container, not inside a Docker image built from a Dockerfile.

Full image-prep snippets: see [phase-0-prereqs.md](phase-0-prereqs.md).

---

## 3. Phase 0 Image Preparation Pattern

The TAO Toolkit images come with the released TAO Python packages pre-installed. The skill installs the user's local clones of those packages on top at run time, so Phase 0 first removes the pre-installed copies via a tiny `Dockerfile` per component:

```dockerfile
ARG PUB_IMAGE
FROM ${PUB_IMAGE}
# Remove pre-installed TAO packages so the local /workspace clones can be installed at run time.
RUN pip uninstall -y --quiet nvidia_tao_pytorch nvidia_tao_core 2>/dev/null || true
ENV PIP_DISABLE_PIP_VERSION_CHECK=1
```

Per-component `pip uninstall` lists (sourced from each repo's `release/docker/Dockerfile{,.release}`):

| Local tag | `pip uninstall -y` list |
|-----------|--------------------------|
| `tao-pytorch-base:latest` | `nvidia_tao_pytorch nvidia_tao_core` |
| `tao-deploy-base:latest` | `nvidia_tao_deploy nvidia_tao_core` |
| `tao-dataservices-base:latest` | `nvidia_tao_ds nvidia_tao_pytorch nvidia_tao_core` |

The `2>/dev/null || true` keeps the build idempotent — packages absent from a particular image variant don't fail the preparation step.

**Release Dockerfile multi-arch pattern (used by the TAO repos themselves to publish the TAO Toolkit images):**
```dockerfile
ARG TARGETARCH
ARG X86_DIGEST=sha256:...
ARG ARM64_DIGEST=sha256:...

FROM <upstream-image>@${X86_DIGEST} AS base-amd64
FROM <upstream-image>@${ARM64_DIGEST} AS base-arm64
FROM base-${TARGETARCH}
```

This skill does not invoke that pattern — it is shown only for reference when reading the TAO repos' release Dockerfiles.

---

## 4. Build Scripts

All repos share the same build script pattern at `docker/build.sh`:

```bash
# Usage:
./build.sh --build --x86                    # x86_64 only
./build.sh --build --arm                    # ARM64 only
./build.sh --build --multiplatform --push   # Both platforms
./build.sh --build --l4t                    # Jetson (tao-deploy only)
./build.sh --force --build --x86            # Force rebuild (no cache)
```

**Key features:**
- QEMU setup for cross-platform builds (ARM on x86 host)
- Auto-detection of host architecture via `uname -m`
- Uses `docker buildx` for multi-platform: `docker buildx build --platform linux/amd64,linux/arm64 --push`
- Single platform uses `--load` (loads into local daemon)
- Sets `DOCKER_BUILDKIT=1`

**For testing (recommended):** Use the local image tag prepared in Phase 0 (`tao-pytorch-base:latest`, `tao-deploy-base:latest`, etc.) and run tests inside it directly with the source mounted — no Docker build needed:
```bash
docker run --rm --gpus all \
  -v $(pwd):/workspace \
  -w /workspace/tao-pytorch \
  -e PYTHONPATH=/workspace/tao-core:/workspace/tao-pytorch \
  tao-pytorch-base:latest \
  bash -c "pip install /workspace/tao-core && python setup.py develop && pytest tests/ -v --color=yes -m 'not slow'"
```

**For release Docker images (distribution only):**
```bash
# Uses the release Dockerfile, not docker/Dockerfile
cd tao-pytorch
docker build --network=host -t tao-pytorch-release:latest -f release/docker/Dockerfile .

cd tao-deploy
docker build --network=host -t tao-deploy-release:latest -f release/docker/Dockerfile.release .
```

---

## 5. Requirements Files

**tao-pytorch/docker/requirements/:**
| File | Purpose |
|------|---------|
| `requirements-apt.txt` | System packages (build-essential, ffmpeg, nginx, etc.) |
| `requirements-pip.txt` | Core Python packages (~80 deps) |
| `requirements-pip-pytorch.txt` | PyTorch ecosystem (fairscale, pytorch-lightning, etc.) |
| `requirements-pip-odise.txt` | ODISE model dependencies |
| `requirements-pip-quantization.txt` | Quantization tools |
| `requirements-pip-nvpanoptix3d.txt` | 3D panoptic dependencies |

**tao-deploy/docker/requirements/:**
| File | Purpose |
|------|---------|
| `requirements-apt.txt` | Minimal APT set (curl, ffmpeg, nginx) |
| `requirements.txt` | TensorRT/Deploy dependencies |
| `requirements-dev.txt` | Development environment (CUDA 12.8, cupy) |
| `requirements-l4t.txt` | Jetson-specific packages |

---

## 6. Wheel Build Patterns

**Build order:** tao-core first (both tao-pytorch and tao-deploy depend on it).

> **CRITICAL — Submodule override:** In CI, `pip install tao-core/` installs from the submodule inside each repo. Locally, the submodule points to the original (unmodified) commit. Always install from our top-level `tao-core/` clone instead: `pip install /workspace/tao-core`. See SKILL.md "Submodule Override Strategy".

```bash
# Standard wheel build
python3 setup.py bdist_wheel
pip3 install dist/*.whl

# Editable install (for development)
pip3 install -e .
```

**Release builds use pyarmor obfuscation** (via `release/docker/build_wheel.sh`):
```bash
pyarmor -d reg /release/docker/pyarmor-regfile-1219.zip
pyarmor -d gen --recursive --output /obf_src/ /nvidia_tao_pytorch/
python setup.py bdist_wheel
```

**Makefile targets (tao-deploy):**
```makefile
make build       # python3 setup.py bdist_wheel (+ auditwheel repair for L4T)
make build_l4t   # L4T-specific wheel
make install     # pip3 install dist/*.whl
```

**Wheel install inside container:**
```dockerfile
COPY dist/*.whl /opt/nvidia/wheels/
RUN cd wheels && ls ./*.whl | xargs -I'{}' python -m pip install '{}' && rm *.whl
```

---

## 7. Runner Scripts (Container Launchers)

| Repo | Script |
|------|--------|
| tao-pytorch | `runner/tao_pt.py` |
| tao-deploy | `runner/tao_deploy.py` |
| tao-dataservices | `runner/tao_ds.py` |

**What runners do:**
1. Read `docker/manifest.json` to get registry/digest
2. Detect host platform: `platform.machine()` → x86_64 or aarch64
3. Configure GPU access based on Docker API version:
   - Docker >= 1.40: `--gpus all` (or `--gpus 'device=0,1'`)
   - Docker < 1.40: `--runtime=nvidia -e NVIDIA_DRIVER_CAPABILITIES=all`
4. Read user mount config from `~/.tao_mounts.json`
5. Set `--shm-size 16G`
6. Inject `PYTHONPATH`

**Generated command pattern:**
```bash
docker run -it --rm --gpus all \
  -v /path/to/data:/data \
  -e PYTHONPATH=/tao-pt:$PYTHONPATH \
  --shm-size 16G \
  tao-pytorch-base:latest \
  <model_name> train -e /path/to/spec.yaml
```

(`tao-pytorch-base:latest` is the local image tag prepared in Phase 0 from the user-supplied tao-pytorch TAO Toolkit image. Substitute `tao-deploy-base:latest` for deploy-side commands.)

---

## 8. CI Pipeline Patterns

### GitLab CI (`.gitlab-ci.yml`)

**Stages:** `mr-standards` → `static-tests` → `build-docker-image` → `check-jenkins-status`

- **Static tests:** Run pylint, pydocstyle, flake8 on merge requests
- **Docker build:** Triggered on `renovate/*` and `build-base-image/*` branches; uses `--cache-from` with stable tag
- **Jenkins:** Polls Jenkins job status for GPU-heavy functional tests

### Static lint (vanilla `pylint` / `pydocstyle` / `flake8`)

The internal NVIDIA TAO mirrors ship a `ci/run_static_tests.py` helper that wraps `pylint` + `pydocstyle` + `flake8` with module discovery and `--changed-files-only` plumbing. The public github mirrors do NOT ship this helper — invoke the tools directly instead:

```bash
# Errors only — fast path, suitable for the Phase 6 Step 20 gate
python -m pylint --errors-only nvidia_tao_pytorch/cv/<model_name>/

# Full report (uses repo .pylintrc if present)
pylint nvidia_tao_pytorch/cv/<model_name>/ $([ -f .pylintrc ] && echo --rcfile=.pylintrc)
pydocstyle nvidia_tao_pytorch/cv/<model_name>/
flake8 nvidia_tao_pytorch/cv/<model_name>/
```

Tools: `pylint`, `pydocstyle`, `flake8` — install with `pip install pylint pydocstyle flake8` if missing in the container.

### Functional tests (vanilla `pytest`)

Same story: the internal `ci/run_functional_tests.py` wrapper adds testmon (incremental retest) and a CI-mode shortcut. The public mirrors do not ship it — invoke `pytest` directly:

```bash
# New model only (fast iteration)
pytest tests/cv_unit_test/<model_name>/ -v --color=yes -m 'cv_unit'

# Full functional suite, skip slow tests (equivalent to internal CI default)
pytest tests/ -v --color=yes -m 'not slow'

# Optional: incremental retest if you've installed testmon yourself
pip install pytest-testmon && pytest tests/ -v --color=yes --testmon
```

### Generating the `docker run` prefix

The internal `ci/utils.py` exposes `get_docker_information()` (parses `docker/manifest.json`) and `get_docker_command()` (generates a docker run prefix with the right `--gpus` flag for the host's Docker API version). The public mirrors do not ship `ci/utils.py` — and this skill no longer parses `manifest.json` either, since Phase 0 produces the canonical local image tags. Use the patterns shown in §7 above to construct the `docker run` prefix manually, or invoke `tao-pytorch-base:latest` / `tao-deploy-base:latest` directly.

---

## 9. GPU & CUDA Environment Variables

```dockerfile
# CUDA architecture targets
TORCH_CUDA_ARCH_LIST="7.5 8.0 8.6 9.0 9.0a 10.0 11.0 12.0+PTX"
GPU_ARCHS="75 80 86 90 90a 100 110 120"

# Library paths (platform-specific)
LD_LIBRARY_PATH="/usr/lib/$(uname -m)-linux-gnu:${LD_LIBRARY_PATH}"
# x86: /usr/lib/x86_64-linux-gnu
# ARM: /usr/lib/aarch64-linux-gnu

# CUDA include path (for ONNX Runtime build)
CPATH="/usr/local/cuda/include/cccl:${CPATH}"

# Deterministic CUDA ops
CUBLAS_WORKSPACE_CONFIG=":4096:8"
```

---

## 10. Cross-Platform Detection

**In Dockerfiles:**
```dockerfile
RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "aarch64" ]; then \
        CUDA_TARGET="sbsa-linux"; \
    else \
        CUDA_TARGET="${ARCH}-linux"; \
    fi
```

**Conditional builds (x86 only):**
```dockerfile
RUN if [ "$TARGETARCH" = "amd64" ]; then \
    git clone https://github.com/vllm-project/vllm.git && \
    pip install -e .; \
    fi
```

**In runner scripts (Python):**
```python
import platform
arch = platform.machine()   # "x86_64" or "aarch64"
digest = manifest["digests"]["x86" if arch == "x86_64" else "arm"]
```

---

## 11. Container User Setup

```dockerfile
ARG uid=1000
ARG gid=1000
RUN groupadd -r -f -g ${gid} taotoolkituser && \
    useradd -o -r -l -u ${uid} -g ${gid} -ms /bin/bash taotoolkituser && \
    usermod -aG sudo taotoolkituser
```

---

## 12. Security Cleanup (Release Images)

```dockerfile
# Remove git history and CI configs
RUN find / -type d -name ".git" -exec rm -rf {} + && \
    find / -type f -name ".gitlab-ci.yml" -exec rm -f {} +
```

---

## 13. TAO-Specific Environment Variables

```dockerfile
ENV NVIDIA_PRODUCT_NAME="TAO Toolkit"
ENV TAO_TOOLKIT_VERSION="6.25.10"
ENV NVIDIA_TAO_TOOLKIT_VERSION="${TAO_TOOLKIT_VERSION}-pytorch"  # or -deploy
ENV TAO_TELEMETRY_SERVER="..."
ENV DEBIAN_FRONTEND=noninteractive
ENV TZ="America/New_York"
ENV PYTHONUNBUFFERED=1
```

---

## 14. Pytest Configuration

**tao-pytorch/pytest.ini:**
```ini
[pytest]
addopts = --verbose --pyargs --durations=0
markers =
    unit: unit tests
    train: training scripts
    finetune: fine-tuning scripts
    evaluate: evaluation scripts
    export: ONNX export
    infer: inference
    tensorrt: TensorRT tests
    cv_unit: CV unit tests
```

---

## 15. xformers / ONNX Runtime Build Memory Management

The tao-pytorch Dockerfile calculates build parallelism based on available memory:

```dockerfile
# xformers: max_jobs = (total_mem_gb - 90) / 20 (min 4, max nproc)
MAX_JOBS=$(python3 -c "
import os, psutil
mem = psutil.virtual_memory().total / (1024**3)
jobs = max(4, min(os.cpu_count(), int((mem - 90) / 20)))
print(jobs)
")
```

If builds OOM, reduce parallelism by limiting `MAX_JOBS` or `ONNXRUNTIME_BUILD_PARALLEL`.
