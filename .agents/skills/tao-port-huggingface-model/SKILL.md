---
name: tao-port-huggingface-model
description: >
  Integrate a HuggingFace Computer Vision model into the NVIDIA TAO Toolkit
  ecosystem (tao-core config, tao-pytorch trainer, tao-deploy TensorRT
  pipeline). Use when the user asks to "integrate a HuggingFace model into
  TAO", "add an HF model to TAO Toolkit", "wire a HuggingFace ViT/DETR/
  SegFormer into tao-pytorch", "build a TAO trainer + deploy pipeline for an
  HF CV model", or pastes a HuggingFace model URL/ID and wants it turned
  into a TAO model. Covers the full 7-phase loop: prerequisites check,
  HuggingFace inspection and validation, codebase exploration, tao-core
  configuration and native trainer implementation, ONNX export plus TensorRT
  deploy integration, packaging and L0 testing, container-based end-to-end
  validation, and (conditional) accuracy/latency tuning. Supports
  classification, object detection, semantic / instance / panoptic
  segmentation, zero-shot detection, and depth estimation.
license: Apache-2.0
compatibility: Requires Python 3.10+, NVIDIA driver, CUDA 13.0+, docker + nvidia-container-toolkit, an NGC API key (`docker login nvcr.io`), and an HF_TOKEN. Needs the TAO Toolkit images on `nvcr.io` (`tao-pytorch`, `tao-deploy`, optionally `tao-dataservices`) and local clones of `tao-core`, `tao-pytorch`, `tao-deploy`, and `tao-dataservices`. All work is local-only; the skill never pushes to git, registries, or HF Hub.
metadata:
  author: NVIDIA Corporation
  version: "0.1.0"
allowed-tools: Read Bash Write Edit Grep Glob WebFetch
tags:
- tao
- huggingface
- integration
- computer-vision
- deploy
---
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


# TAO-HF Integration Skill

Integrate a HuggingFace (HF) Computer Vision model into the NVIDIA TAO Toolkit ecosystem. Work the phases iteratively — not purely linearly — following a **build → test → debug → fix → retest** loop at every step.

This SKILL.md is the workflow coordinator. Each phase has a dedicated reference file under `references/` with the full step-by-step content, code blocks, docker invocations, and gates. Read the matching reference at the start of each phase — the summaries below are not sufficient on their own.

---

## Local-Only Rule

All work is strictly local. You may only read/clone from remotes; all file edits, Docker builds, and test runs stay on the local machine. Do NOT `git commit`/`git push`/create remote branches (GitLab, GitHub, HuggingFace), create merge requests / pull requests / issues, or upload/publish/push Docker images to any registry or artifact store. This follows from the bind-mounted local-clone layout in [`references/execution-and-debugging.md`](references/execution-and-debugging.md).

---

## Submodule Override & Execution Platform

`local-docker` is the default platform. The user clones the four TAO repos (`tao-core`, `tao-pytorch`, `tao-deploy`, `tao-dataservices`) independently into one working directory; each repo also carries nested `tao-core/` (and `tao-pytorch/`) **submodules pinned at the original unmodified commit** that are stale — modifications live only in the top-level `tao-core/`. **Always install from the top-level `tao-core/`, never from `<repo>/tao-core/`** (the nested submodule silently drops all modifications). The override of the CI `pip install tao-core/` is three rules: mount the whole working directory (`-v $(pwd):/workspace`); `pip install /workspace/tao-core` FIRST so modified schemas win; put top-level tao-core first on `PYTHONPATH` (`-e PYTHONPATH=/workspace/tao-core:/workspace/tao-pytorch`).

Every test, smoke run, and end-to-end validation runs inside a locally prepared TAO Toolkit container (`tao-pytorch-base:latest`, `tao-deploy-base:latest`, optionally `tao-dataservices-base:latest`, all from Phase 0), with local clones bind-mounted at `/workspace` and installed via `pip install /workspace/tao-core` + `setup.py develop`. All Python work runs in containers — no host venvs, no host `pip install`s. The platform skills own the *how* of running containers — host GPU runtime via [`tao-setup-nvidia-gpu-host`](../../platform/tao-setup-nvidia-gpu-host/SKILL.md); `docker run` flags / NGC auth / mounts / env passthrough / `--ipc=host`/`--shm-size` / inspection / error modes via [`tao-run-on-docker`](../../platform/tao-run-on-docker/SKILL.md) and [`tao-run-on-local-docker`](../../platform/tao-run-on-local-docker/SKILL.md). This workflow specifies only *what* to run inside them and never forks those conventions. The annotated working-directory tree, canonical `docker run` flag set with the workflow-specific `-w`/`PYTHONPATH`/install-shell additions, three isolation contexts, four isolation rules, the **Development Loop**, and the **Debugging Playbook** table: [`references/execution-and-debugging.md`](references/execution-and-debugging.md).

---

## Phase Map

The seven phases (full goals + gates below; references per phase):

- **Phase 0** — Prerequisites + TAO Toolkit images + local image tags: [phase-0-prereqs.md](references/phase-0-prereqs.md)
- **Phase 1** — HF-inspection environment, validate HF model + dataset: [phase-1-inspection.md](references/phase-1-inspection.md), [hf-inspection.md](references/hf-inspection.md)
- **Phase 2** — Closest existing TAO reference model: [phase-2-codebase.md](references/phase-2-codebase.md), [task-type-guide.md](references/task-type-guide.md)
- **Phase 3** — tao-core config + tao-pytorch trainer / native eval / inference: [phase-3-implementation.md](references/phase-3-implementation.md), [tao-patterns.md](references/tao-patterns.md), [repo-structure.md](references/repo-structure.md)
- **Phase 4** — ONNX export + tao-deploy TRT engine, inference, evaluation: [phase-4-deploy.md](references/phase-4-deploy.md)
- **Phase 5** — Packaging (`setup.py` console_scripts) + L0 tests: [phase-5-packaging.md](references/phase-5-packaging.md)
- **Phase 6** — Container-based testing + end-to-end pipeline validation: [phase-6-container-tests.md](references/phase-6-container-tests.md), [docker-patterns.md](references/docker-patterns.md)
- **Phase 7** — (conditional) Accuracy / latency / size tuning: [phase-7-optimization.md](references/phase-7-optimization.md)

**IMPORTANT — Continuous Execution Through Phase 6:** Do NOT stop after implementation (Phases 3–5) to wait for the user to run tests; immediately proceed to the mandatory Phase 6. The implementation is not complete until tests pass inside the TAO Toolkit containers and the end-to-end pipeline is validated. Apply the build-test-debug loop at every step — write, test immediately, fix on failure, never accumulate untested code.

---

## Phase 0 — Prerequisites Check

**Goal:** verify Python 3.10+ and `git`; delegate the NVIDIA driver / CUDA / Docker / NVIDIA Container Toolkit host check to `tao-setup-nvidia-gpu-host`; verify NGC `docker login` for `nvcr.io`. Then **ask the user** for the TAO Toolkit image references (tao-pytorch, tao-deploy, optionally tao-dataservices), pull them, and prepare local image tags `tao-pytorch-base:latest`, `tao-deploy-base:latest`, `tao-dataservices-base:latest` for Phases 3–6. Preparation strips the released TAO packages already in those images so the user's local clones (mounted at `/workspace/...`) install and get picked up at run time. **Hard stop** if any check fails. Full commands, user-prompt wording, and per-image preparation `Dockerfile` snippets: [phase-0-prereqs.md](references/phase-0-prereqs.md).

**Gate:** all prerequisite checks pass; the user has supplied the required image references; `tao-pytorch-base:latest` and `tao-deploy-base:latest` exist locally; `tao-dataservices-base:latest` exists if dataservices work is expected.

---

## Phase 1 — Information Gathering & Validation

**Goal:** decide whether to proceed. Gather credentials, locate (or clone) the four TAO repos and create a consistent local working branch across them, launch the long-lived `tao-hf-inspect` container (isolation Context A), validate that the HF model is a CV model with a supported `pipeline_tag`, extract config + state-dict schema, sanity-check ONNX export, and clean up. Full step-by-step (1.1–1.7): [phase-1-inspection.md](references/phase-1-inspection.md); generic patterns: [hf-inspection.md](references/hf-inspection.md).

**Reject if** `pipeline_tag` is NLP / audio / LLM (out of CV scope), `AutoConfig` raises, or ONNX export fundamentally cannot work and has no rewrite path.

**Gate:** all 4 TAO repos located/cloned with a consistent working branch; `pipeline_tag` confirmed CV; `model_type`, `image_size`, `hidden_size`, `num_labels` extracted; state-dict keys documented and the HF→TAO remapping plan drafted; ONNX sanity check passed (or failure mode understood); user confirmed `model_short_name` and task type. Present findings and confirm before proceeding.

---

## Phase 2 — Codebase Exploration

**Goal:** find the closest existing TAO reference model for the detected `pipeline_tag` (classification → `classification_pyt`, detection → `dino`/`rtdetr`, segmentation → `segformer`, instance → `mask2former`, panoptic → `oneformer`, zero-shot → `grounding_dino`, depth → `mono_depth`), read its full implementation across `tao-core`, `tao-pytorch`, and `tao-deploy`, and decide whether the backbone already exists in `backbone_v2/`. The chosen reference drives everything downstream — config structure, architecture, loss, ONNX export shape, TRT builder, deploy inferencer/loader, metrics, dataset format. The full reference list (12 files per model), the `backbone_v2/` coverage check (it already provides `vit`, `swin`, `resnet`, `dino_v2`, and others), and the `tao-dataservices` coverage check: [phase-2-codebase.md](references/phase-2-codebase.md); per-task details: [task-type-guide.md](references/task-type-guide.md).

If a new backbone is needed, decide the strategy (timm wrap > re-implement from scratch > HF black-box wrap) before Phase 3 — it changes weight loading, ONNX export, and the deploy pipeline. **Never dual-inherit from `transformers.PreTrainedModel` and `BackboneBase`** (metaclass conflict).

**Gate:** reference TAO model identified and all 12 locations read; task-type implications understood (architecture, loss, ONNX outputs, deploy classes, metrics, dataset); backbone coverage decided (reuse / wrap timm / new); dataservices coverage checked.

---

## Phase 3 — TAO Core Configuration & Native Implementation

**Goal:** write the tao-core config schema and the tao-pytorch trainer + native inference + native evaluation, smoke-testing in between. Use `<model_name>` (`snake_case` from Phase 1) and `<ModelName>` (`PascalCase`). Seven steps: (1) `tao-core` config under `config/<model_name>/` — `ExperimentConfig(CommonExperimentConfig)` MUST contain `model`, `dataset`, `train`, `evaluate`, `inference`, `export`, `gen_trt_engine`, `quantize`; (2) `tao-pytorch` trainer under `cv/<model_name>/` (`build_model()`, `<ModelName>PlModel(TAOLightningModule)`, `train.py`, entrypoint, `experiment_spec.yaml`; new backbone → add+register `cv/backbone_v2/<backbone_name>.py`); (3) multi-GPU/multi-node via the entrypoint's `launch()`; (4) native inference → `result.csv`; (5) native evaluation → `results.json`; (6–7) MLOps wiring (`@monitor_status` → `status.json`). Consistency rules (including `export.onnx_file` vs `gen_trt_engine.onnx_file` and `???` = required `MISSING`) are enforced by the Cross-Phase checklist below.

Full per-step code and the canonical `experiment_spec.yaml`: [phase-3-implementation.md](references/phase-3-implementation.md) (with snippets [tao-patterns.md](references/tao-patterns.md), layout [repo-structure.md](references/repo-structure.md), per-task [task-type-guide.md](references/task-type-guide.md)).

**Gates:** Step 1 — `ExperimentConfig` imports cleanly in the container; Step 2 — `build_model(cfg)` runs and the PLModel instantiates; overall — all 7 steps complete, smoke tests pass, no missing `__init__.py`.

---

## Phase 4 — Export, Deployment & TensorRT Integration

**Goal:** ship ONNX export from tao-pytorch, then a TRT engine builder + TRT inference + TRT evaluation in tao-deploy that reuse the tao-core `ExperimentConfig`. Four steps (8–11): ONNX export (`scripts/export.py`, per-task input/output names, `batch_size=-1` ⇒ dynamic batch); TRT engine builder (`gen_trt_engine.py`, subclasses `EngineBuilder` or reuses `ClassificationEngineBuilder`, writes `specs/{gen_trt_engine,inference,evaluate}.yaml`); TRT inference (NumPy-only `ClassificationLoader` → `result.csv`); TRT evaluation (sklearn/pycocotools → `results.json`). Full code and the Phase 3+4 gate: [phase-4-deploy.md](references/phase-4-deploy.md).

Module pitfall: tao-pytorch and tao-deploy have **separate** `hydra_runner` and `monitor_status` implementations — use the deploy versions in deploy scripts; `ExperimentConfig` is imported from `nvidia_tao_core` in both repos (same schema, same field paths).

**Phase 3+4 gate:** all three in-container checks pass — `tao-pytorch` imports + model + ONNX export, and `tao-deploy` imports.

---

## Phase 5 — Packaging & L0 Testing

**Goal:** register the model as a `'<model_name>=...entrypoint.<model_name>:main'` console_script in both `tao-pytorch/setup.py` and `tao-deploy/setup.py` (deploy entrypoint uses `nvidia_tao_deploy.cv.common.entrypoint.entrypoint_hydra`), and add L0 tests — deploy tests (`tao-deploy/tests/<model_name>/`, subprocess + `--buildOnly` `trtexec`) and trainer tests (`tao-pytorch/tests/cv_unit_test/<model_name>/`, `Trainer(..., fast_dev_run=True)`, markers `@pytest.mark.cv_unit @pytest.mark.<model_name>`). Full code and test layout: [phase-5-packaging.md](references/phase-5-packaging.md).

**Gate:** entrypoints registered; pytest files exist and follow the marker convention. **Do NOT stop here — proceed directly to Phase 6.**

---

## Cross-Phase Data Flow & Consistency Verification

Before Docker testing, verify the artifact chain — `train` produces `<results_dir>/train/<model_name>_model_latest.pth` → `export.checkpoint` → `<results_dir>/export/<model_name>.onnx` → `gen_trt_engine` → `<results_dir>/trt/<model_name>.engine` → `inference.trt_engine` / `evaluate.trt_engine`. Then confirm the consistency checklist: the `*_latest.pth` name; `augmentation.mean`/`std` matching across the training spec, `inference.yaml`, `evaluate.yaml`, and builder `preprocess_mode`; ONNX `input_names`/`output_names`; `export.input_width`/`input_height` vs `dataset.img_size`; `model.head.in_channels` vs `model_params_mapping.py`; shared `classes.txt`; and an `__init__.py` in every package dir (including `scripts/__init__.py` for `get_subtasks()` `pkgutil` discovery). Full interpolation paths, itemized checklist, and config field paths: [workflow-consistency.md](references/workflow-consistency.md).

---

## Phase 6 — Container Testing & End-to-End Validation

**Mandatory — start immediately after Phase 5.** All TAO models ship as Docker images; code that only works outside a container is incomplete. Testing runs **directly inside the TAO Toolkit container** (no Docker image build in the test loop): mount the local source into the Phase-0 image tags, install via `setup.py develop`, and invoke `pytest` / `pylint` / `pydocstyle` / `flake8` directly — use vanilla `pytest` + lint binaries, NOT any `ci/run_functional_tests.py` / `ci/run_static_tests.py` wrappers (those exist only in NVIDIA's internal mirrors; the public `github.com/NVIDIA-TAO/` mirrors have no `ci/` directory).

Steps 16–25, in order: verify the local image tags (16); container `pytest` for tao-core (17), tao-pytorch (18, `-m cv_unit`, `--shm-size=16G`), tao-deploy (19); static/lint tests (20, `pylint --errors-only` + optional `pydocstyle`/`flake8`); wheel builds (21); the end-to-end pipeline (22 — train dry-run + export in **one** tao-pytorch session, then gen_trt_engine + inference + evaluate in **one** tao-deploy session, since `--rm` discards installed packages); native-vs-TRT cross-check (23 — FP32 ≈ exact, FP16 ≈ small delta, divergence ⇒ ONNX/TRT issue); interactive debug shells (24); optional release Docker image build (25, distribution-only). Full per-step commands and the fix-and-retest loop: [phase-6-container-tests.md](references/phase-6-container-tests.md); build scripts, runner patterns, requirements, CI conventions: [docker-patterns.md](references/docker-patterns.md).

**Phase 6 gate (Done criteria):** tao-core / tao-pytorch / tao-deploy unit tests pass in their TAO Toolkit containers; static tests pass (or only legacy lint warnings); wheels build; end-to-end `<model_name>_model_latest.pth` → `model.onnx` → `model.engine` → non-empty `result.csv` and `results.json`; native vs TRT predictions agree within tolerance.

---

## Phase 7 — Optimization & Tuning (conditional)

Enter only if Phase 6 passes but accuracy / latency / model size needs improvement. **Ask the user for target metrics first.** Diagnose (Step 26) across four categories — accuracy too low, TRT-vs-native gap, training too slow, inference too slow — then apply the relevant technique: hyperparameter tuning (27), INT8 quantization (28), channel pruning + retrain (29), knowledge distillation (30), or resolution tuning (31). Full diagnostics, config blocks, YAML overrides, and decision tree: [phase-7-optimization.md](references/phase-7-optimization.md).

---

## Argument

`$ARGUMENTS`

If provided, interpret `$ARGUMENTS` as the HuggingFace model ID or URL to use as the starting point for Phase 1. If credentials or model short-name are not included, ask the user for them before proceeding.
