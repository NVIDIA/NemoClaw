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

Full Phase 6 walkthrough — TAO Toolkit container inventory, container-based tao-core / tao-pytorch / tao-deploy testing, static (lint) tests, wheel builds, end-to-end pipeline validation (train → export → TRT build → TRT inference / evaluate), native vs TRT cross-check, interactive debug shells, and (optional) release Docker image build.

## Phase 6 — Container Testing & End-to-End Validation

> **Mandatory — proceed immediately after Phase 5.** Do not wait for user instruction to start this phase. All TAO models ship as Docker images — code that only works outside a container is incomplete. Mount the source into the prepared TAO Toolkit containers, install it, run the tests, and validate the end-to-end pipeline now.

**How TAO testing works:**
TAO testing does NOT build Docker images. Instead, it:
1. Runs tests **directly inside the TAO Toolkit container** (started from the local image tag prepared in Phase 0)
2. Installs `tao-core` + the target repo at run time via `pip install /workspace/tao-core` and `setup.py develop`
3. Invokes `pytest` directly on the relevant `tests/` subdirectory
4. Builds wheels inside the same container
5. Builds release Docker images separately (using `release/docker/Dockerfile`) only for distribution — NOT for testing

The local flow is therefore: mount the source, `pip install /workspace/tao-core`, `python setup.py develop`, run `pytest`. See `docker-patterns.md` (sibling reference) for Docker build scripts, runner commands, and related patterns.

> **Public repos and the `ci/` directory:** NVIDIA's internal TAO mirrors carry helper scripts under `ci/` (e.g. `ci/run_functional_tests.py`, `ci/run_static_tests.py`, `ci/utils.py`) that wrap pytest with testmon, pylint with module discovery, and Docker prefix generation. These scripts are **NOT** present in the public github mirrors at `github.com/NVIDIA-TAO/` — do not invoke them. Use the vanilla `pytest` + lint commands shown below instead; they produce equivalent output and work on either mirror.

### Local TAO Toolkit Image Tags

Phase 0 prepared these local image tags from the TAO Toolkit container references the user supplied. Every `docker run` command in this phase references the local tag — never the underlying registry image directly — so this table never needs editing per release.

| Repo | Local tag (prepared in Phase 0) | Underlying TAO Toolkit image (user-supplied) | Packages removed during prep |
|------|---------------------------------|----------------------------------------------|------------------------------|
| **tao-core** | `tao-pytorch-base:latest` (or `nvcr.io/nvidia/pytorch:24.03-py3`) | n/a — uses public NGC PyTorch image directly, or piggybacks on the prepared tao-pytorch image | n/a |
| **tao-pytorch** | `tao-pytorch-base:latest` | tao-pytorch image (e.g. `nvcr.io/<org>/tao-toolkit:<version>-pyt`) | `nvidia_tao_pytorch`, `nvidia_tao_core` |
| **tao-deploy** | `tao-deploy-base:latest` | tao-deploy image (e.g. `nvcr.io/<org>/tao-toolkit:<version>-deploy`) | `nvidia_tao_deploy`, `nvidia_tao_core` |
| **tao-dataservices** | `tao-dataservices-base:latest` (optional) | tao-dataservices image (e.g. `nvcr.io/<org>/tao-toolkit:<version>-data-services`) | `nvidia_tao_ds`, `nvidia_tao_pytorch`, `nvidia_tao_core` |

Detect host architecture with `uname -m` (`x86_64` → x86, `aarch64` → ARM64). The TAO Toolkit images are typically multi-arch manifests, so a single image reference works on both x86 and ARM64 hosts — Docker auto-selects the matching layer.

### Step 16 — Verify the Local Image Tags are Ready

The local image tags should already be prepared from Phase 0. Verify they're available **and** confirm the preparation succeeded:

```bash
docker images | grep -E 'tao-pytorch-base|tao-deploy-base|tao-dataservices-base'

# Preparation sanity check — these should all print "not installed"
docker run --rm tao-pytorch-base:latest \
  bash -c "pip show nvidia_tao_pytorch nvidia_tao_core 2>&1 | grep -E '(Name|not installed)'"
docker run --rm tao-deploy-base:latest \
  bash -c "pip show nvidia_tao_deploy nvidia_tao_core 2>&1 | grep -E '(Name|not installed)'"
```

If any tag is missing or any pre-installed `nvidia_tao_*` package still shows up, re-run the pull + preparation commands from Phase 0 (`phase-0-prereqs.md`, sibling reference). If the user has not yet supplied an image reference for one of the components, ask them now — same prompt wording Phase 0 uses.

### Step 17 — Test tao-core

Run tao-core tests inside the prepared tao-pytorch container (matching the CI `Jenkinsfile.release` pattern):

```bash
docker run --rm --gpus all \
  -v $(pwd):/workspace \
  -w /workspace/tao-core \
  tao-pytorch-base:latest \
  bash -c "pip install pytest-cov && \
    pip install . && \
    pytest --cov=nvidia_tao_core -v --color=yes"
```

This validates that our tao-core modifications (new model configs, model_params_mapping, etc.) are correct and importable.

### Step 18 — Test tao-pytorch

Install our top-level `tao-core` (not the empty nested submodule), put the local tao-pytorch source on the path with `setup.py develop`, then invoke `pytest` directly. **Run only your new model's tests** for fast iteration:

```bash
docker run --rm --gpus all \
  --shm-size=16G \
  -v $(pwd):/workspace \
  -w /workspace/tao-pytorch \
  -e PYTHONPATH=/workspace/tao-core:/workspace/tao-pytorch \
  tao-pytorch-base:latest \
  bash -c "pip install /workspace/tao-core && \
    python setup.py develop && \
    pytest tests/cv_unit_test/<model_name>/ -v --color=yes -m 'cv_unit'"
```

For the full functional suite (used before merging, much slower — equivalent to what NVIDIA's internal `ci/run_functional_tests.py` wrapper would invoke under the hood):
```bash
docker run --rm --gpus all \
  --shm-size=16G \
  -v $(pwd):/workspace \
  -w /workspace/tao-pytorch \
  -e PYTHONPATH=/workspace/tao-core:/workspace/tao-pytorch \
  tao-pytorch-base:latest \
  bash -c "pip install /workspace/tao-core && \
    python setup.py develop && \
    pytest tests/ -v --color=yes -m 'not slow'"
```

### Step 19 — Test tao-deploy

Same pattern: install our tao-core, install tao-deploy in dev mode, invoke `pytest` directly on the new model's tests:

```bash
docker run --rm --gpus all \
  -v $(pwd):/workspace \
  -w /workspace/tao-deploy \
  -e PYTHONPATH=/workspace/tao-core:/workspace/tao-deploy \
  tao-deploy-base:latest \
  bash -c "pip install /workspace/tao-core && \
    pip install -e . && \
    pytest tests/<model_name>/ -v --color=yes"
```

For the full deploy suite:
```bash
docker run --rm --gpus all \
  -v $(pwd):/workspace \
  -w /workspace/tao-deploy \
  -e PYTHONPATH=/workspace/tao-core:/workspace/tao-deploy \
  tao-deploy-base:latest \
  bash -c "pip install /workspace/tao-core && \
    pip install -e . && \
    pytest tests/ -v --color=yes"
```

### Step 20 — Run Static Tests (Linting)

Run `pylint` (errors-only is fastest), `pydocstyle`, and `flake8` directly on the new model directories. Use `--errors-only` for the fast path; drop the flag if you want the full report.

```bash
# Fast path: pylint --errors-only across the new code in all three repos
docker run --rm \
  -v $(pwd):/workspace \
  -w /workspace \
  tao-pytorch-base:latest \
  bash -c "pip install pylint pydocstyle flake8 && \
    python -m pylint --errors-only \
      tao-pytorch/nvidia_tao_pytorch/cv/<model_name>/ \
      tao-deploy/nvidia_tao_deploy/cv/<model_name>/ \
      tao-core/nvidia_tao_core/config/<model_name>/"
```

For the fuller report scoped to the tao-pytorch new model only (uses each repo's `.pylintrc` if present):
```bash
docker run --rm \
  -v $(pwd):/workspace \
  -w /workspace/tao-pytorch \
  -e PYTHONPATH=/workspace/tao-core:/workspace/tao-pytorch \
  tao-pytorch-base:latest \
  bash -c "pip install /workspace/tao-core && python setup.py develop && \
    pip install pylint pydocstyle flake8 && \
    pylint nvidia_tao_pytorch/cv/<model_name> $([ -f .pylintrc ] && echo --rcfile=.pylintrc) && \
    pydocstyle nvidia_tao_pytorch/cv/<model_name> && \
    flake8 nvidia_tao_pytorch/cv/<model_name>"
```

### Step 21 — Build Wheels

Build wheels inside the prepared TAO Toolkit containers to match the exact CUDA/TensorRT versions (same as CI's `buildWheel` stage):

```bash
# tao-pytorch wheel
docker run --rm --gpus all \
  -v $(pwd):/workspace \
  -w /workspace/tao-pytorch \
  -e PYTHONPATH=/workspace/tao-core:/workspace/tao-pytorch \
  tao-pytorch-base:latest \
  bash -c "pip install /workspace/tao-core && \
    python setup.py bdist_wheel && \
    ls -la dist/*.whl"

# tao-deploy wheel
docker run --rm --gpus all \
  -v $(pwd):/workspace \
  -w /workspace/tao-deploy \
  -e PYTHONPATH=/workspace/tao-core:/workspace/tao-deploy \
  tao-deploy-base:latest \
  bash -c "pip install /workspace/tao-core && \
    make build && \
    ls -la dist/*.whl"
```

The wheels are written to `tao-pytorch/dist/` and `tao-deploy/dist/` on the host (since the workspace is volume-mounted).

### Step 22 — End-to-End Pipeline Validation

After all tests pass, run the **full pipeline end-to-end** to verify the entire train → export → TRT build → TRT inference chain works:

**Step 22a+22b — Train dry-run + Export to ONNX (single tao-pytorch container):**

Both train and export must run in the **same container session** because `--rm` destroys the container (and its installed packages) when it exits.

```bash
docker run --rm --gpus all \
  --shm-size=16G \
  -v $(pwd):/workspace \
  -w /workspace/tao-pytorch \
  -e PYTHONPATH=/workspace/tao-core:/workspace/tao-pytorch \
  tao-pytorch-base:latest \
  bash -c "pip install /workspace/tao-core && python setup.py develop && \
    <model_name> train \
      -e nvidia_tao_pytorch/cv/<model_name>/experiment_specs/experiment_spec.yaml \
      results_dir=/workspace/results \
      train.num_epochs=1 \
      train.num_gpus=1 \
      dataset.batch_size=2 && \
    <model_name> export \
      -e nvidia_tao_pytorch/cv/<model_name>/experiment_specs/experiment_spec.yaml \
      results_dir=/workspace/results \
      export.checkpoint=/workspace/results/train/<model_name>_model_latest.pth \
      export.onnx_file=/workspace/results/export/model.onnx"
```

Verify on host:
- `results/train/<model_name>_model_latest.pth` exists
- `results/export/model.onnx` exists

**Step 22c+22d+22e — TRT engine build + inference + evaluation (single tao-deploy container):**

```bash
docker run --rm --gpus all \
  -v $(pwd):/workspace \
  -w /workspace/tao-deploy \
  -e PYTHONPATH=/workspace/tao-core:/workspace/tao-deploy \
  tao-deploy-base:latest \
  bash -c "pip install /workspace/tao-core && pip install -e . && \
    <model_name> gen_trt_engine \
      -e nvidia_tao_deploy/cv/<model_name>/specs/gen_trt_engine.yaml \
      results_dir=/workspace/results \
      gen_trt_engine.onnx_file=/workspace/results/export/model.onnx \
      gen_trt_engine.trt_engine=/workspace/results/trt/model.engine \
      gen_trt_engine.tensorrt.data_type=FP16 && \
    <model_name> inference \
      -e nvidia_tao_deploy/cv/<model_name>/specs/inference.yaml \
      results_dir=/workspace/results \
      inference.trt_engine=/workspace/results/trt/model.engine \
      dataset.test_dataset.images_dir=<test_images_dir> && \
    <model_name> evaluate \
      -e nvidia_tao_deploy/cv/<model_name>/specs/evaluate.yaml \
      results_dir=/workspace/results \
      evaluate.trt_engine=/workspace/results/trt/model.engine \
      dataset.test_dataset.images_dir=<test_images_dir>"
```

Verify on host:
- `results/trt/model.engine` exists and has non-zero size
- `results/trt_infer/result.csv` exists with predictions
- `results/trt_eval/results.json` exists with metrics

### Step 23 — Cross-Check: Compare Native vs TRT Results

Verify that the TRT-optimized model produces results consistent with the native PyTorch model:

1. Run native PyTorch inference on the same test images (Step 4)
2. Run TRT engine inference on the same test images (Step 22d)
3. Compare predictions: they should match within floating-point tolerance (FP32 ≈ exact, FP16 ≈ small delta)
4. If results diverge significantly, the ONNX export or TRT engine build has an issue — debug the conversion pipeline

### Step 24 — Interactive Container for Debugging

If any step fails and you need an interactive debugging session:

**tao-pytorch interactive shell:**
```bash
docker run -it --rm --gpus all \
  --shm-size=16G \
  -v $(pwd):/workspace \
  -w /workspace/tao-pytorch \
  -e PYTHONPATH=/workspace/tao-core:/workspace/tao-pytorch \
  tao-pytorch-base:latest \
  /bin/bash
```

**tao-deploy interactive shell:**
```bash
docker run -it --rm --gpus all \
  -v $(pwd):/workspace \
  -w /workspace/tao-deploy \
  -e PYTHONPATH=/workspace/tao-core:/workspace/tao-deploy \
  tao-deploy-base:latest \
  /bin/bash
```

Inside the container, you can:
- `pip install /workspace/tao-core && python setup.py develop` to install in dev mode
- `python3 -c "import nvidia_tao_pytorch.cv.<model_name>"` to test imports
- `python3 -c "from nvidia_tao_pytorch.cv.backbone_v2.registry import BACKBONE_REGISTRY; print(BACKBONE_REGISTRY)"` to verify backbone registration
- Run individual scripts manually with full control over arguments
- Use `pdb` for interactive debugging

### Step 25 — Build Release Docker Images (Optional)

Only needed for full distribution testing. The release Docker images use `release/docker/Dockerfile` (different from `docker/Dockerfile`) and package the wheels built in Step 21.

```bash
# tao-pytorch release image
cd tao-pytorch
docker build \
  --network=host \
  -t tao-pytorch-release:latest \
  -f release/docker/Dockerfile \
  .

# tao-deploy release image
cd ../tao-deploy
docker build \
  --network=host \
  -t tao-deploy-release:latest \
  -f release/docker/Dockerfile.release \
  .
```

These release images bake the wheels into the container. They're what end-users actually run but are NOT needed for the testing workflow above.

**Fix-and-retest loop:** If any test fails:
1. Read the full traceback — identify the failing module and line
2. Fix the code on the host filesystem (mounted volume — changes are live immediately)
3. Re-run the failing test (no need to rebuild anything — volume mounts pick up changes)
4. Once the specific test passes, re-run the full suite to check for regressions

---

