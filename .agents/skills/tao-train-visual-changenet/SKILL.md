---
name: tao-train-visual-changenet
description: Visual ChangeNet for binary image classification and segmentation in AOI defect detection. Use when training,
  evaluating, exporting, or running inference for PCB defect detection or visual inspection, comparing image pairs for
  PASS/NO_PASS classification, or producing change-segmentation masks. Trigger phrases include "train Visual ChangeNet",
  "ChangeNet classify", "ChangeNet segment", "AOI defect detection", "PCB inspection model".
license: Apache-2.0
compatibility: Requires docker + nvidia-container-toolkit.
metadata:
  author: NVIDIA Corporation
  version: "0.1.0"
allowed-tools: Read Bash
tags:
- pcb
- aoi
- defect
- classification
- segmentation
- siamese
- visual-inspection
---

# Visual ChangeNet

Visual ChangeNet is a TAO Toolkit model for visual inspection and defect detection. It supports two tasks:

- **Classify** — Binary image classification using a siamese-style architecture with a shared backbone (C-RADIO ViT) and a learnable difference module. Compares image pairs to classify defects as PASS/NO_PASS.
- **Segment** — Pixel-level change segmentation using a ViT-Large NVDINOv2 backbone. Compares before/after image pairs to produce a binary change mask.

The backbone weight (`c_radio_v2_vit_base_patch16_224`) is the `nvidia/C-RADIOv2-B` model from HuggingFace, distributed as `model.safetensors` (~393 MB). **The TAO 7.0.0-rc container does not auto-fetch from HF URLs** — `ptm_utils.load_pretrained_weights()` hands the `pretrained_backbone_path` value to `torch.load(path)` / `safetensors.torch.load_file(path)` directly. Passing an `https://huggingface.co/...` URL or a repo id produces `FileNotFoundError` and the run fails with `Execution status: FAIL` within a few seconds. Stage the file locally before launch:

```bash
python3 -c "from huggingface_hub import hf_hub_download; import shutil; \
shutil.copy(hf_hub_download('nvidia/C-RADIOv2-B', 'model.safetensors'), '<workspace>/backbone/c_radio_v2_b.safetensors')"
```

Mount it into the container (`-v <workspace>/backbone/c_radio_v2_b.safetensors:/data/pretrained_models/C-RADIOv2_B.safetensors`) and set the spec `model.backbone.pretrained_backbone_path` to the container path. `HF_TOKEN` is only needed at staging time, not at training time.

## Dataclass Schemas

Generated TAO Core schemas are packaged in `schemas/<action>.schema.json`, with `schemas/manifest.json` listing available actions. Each generated schema also emits `references/spec_template_<action>.yaml` from the schema top-level `default` field. AutoML enablement is declared at the model layer in `references/skill_info.yaml` via `automl_enabled`. Runnable AutoML still requires `schemas/train.schema.json` and `references/spec_template_train.yaml` to exist and parse. Use the packaged train schema for `automl_default_parameters`, `automl_disabled_parameters`, defaults, min/max bounds, enums, option weights, math conditions, dependencies, and popular parameters. Do not expect `~/tao-core` at runtime; maintainers regenerate schemas/templates before packaging the skill bank.

## Train Action Policy

This model is AutoML-enabled at the model layer. Before handling any train-stage request, read `references/skill_info.yaml` and resolve the run override from either an explicit `automl_policy` value or the user's workflow request. Treat phrases like "turn off AutoML", "disable AutoML", "no HPO", or "plain training" as `automl_policy: off` for this run only; otherwise default to `auto`. When `automl_policy: auto`, `automl_enabled: true`, and both `schemas/train.schema.json` and `references/spec_template_train.yaml` are packaged, route the train action through `tao-skill-bank:tao-run-automl` by default with this model's `skill_dir`. Preserve workflow/application overrides for datasets, specs, output directories, GPU/platform settings, parent checkpoints, and `automl_policy`. Use direct model training only when `automl_policy: off` or the packaged train schema/template is missing; in the missing-schema case, report that AutoML is enabled but not runnable for this model until schemas are generated.

Non-train actions such as `evaluate`, `inference`, `export`, and deploy flows stay in this model skill. The per-run `automl_policy` override does not change model metadata.

For TAO Deploy TensorRT actions (`gen_trt_engine`, TensorRT `evaluate`, and TensorRT `inference` for classify and segment variants), read `references/tao-deploy-visual-changenet.md` first. Deploy spec templates live in this skill's `references/` folder with the `spec_template_deploy_*.yaml` prefix.

## Tasks

### Classify (default)

Uses actions: `train`, `evaluate`, `inference`. Defaults template: `references/spec_template_train.yaml`.

### Segment

Uses actions: `segment_train`, `segment_evaluate`, `segment_inference`. Defaults template: `references/spec_template_segment.yaml`.

Segmentation requires compiling custom CUDA ops (`MultiScaleDeformableAttention`) on first run, which takes ~5 minutes. The ViT adapter backbone uses these for multi-scale feature extraction.

Dataset structure for segmentation differs from classify — uses paired directories (`A/`, `B/`, `list/`, `label/`) instead of CSV files. See `dataset.segment.root_dir` in the defaults.

## Datasets, Spec Overrides, and Data Format

Visual ChangeNet has two task modes with different dataset types and data source structures. Classify uses a 4-column CSV (`input_path,golden_path,label,object_name`) plus an images directory; segment uses a paired directory structure (`A/`, `B/`, `list/`, `label/`) under a single `root_dir`. Data source overrides are **mandatory for every action** — the agent MUST construct data source paths and include them in `spec_overrides`.

See `references/dataset-and-specs.md` for the full per-action dataset requirement tables (classify and segment), every spec-override example (train, export, quantize, evaluate, inference, gen_trt_engine for both variants), the classify CSV format, evaluate/inference and segment input fields, lighting conventions, segment data layout, and the `input_map` multi-lighting configuration.

## Local Docker Invocation

Without the TAO SDK, resolve the TAO pyt image from `versions.yaml` and invoke `visual_changenet <action>` directly with `--shm-size=8g` and the backbone `.ckpt` mounted as a single file. See `references/local-docker-invocation.md` for the full `docker run` command, the shared-memory requirement, the backbone mount detail, and the checkpoint/results_dir command-line override pattern.

## Parameters, Hardware, and Error Patterns

Key knobs include `train.validation_interval` (default 50, must be ≤ num_epochs), `train.checkpoint_interval` (default 200, must be ≤ num_epochs), `train.num_epochs` (default 100), `model.classify.eval_margin` (default 0.3, the primary precision/recall threshold), and `train.classify.cls_weight` (default [1.0, 10.0]). Minimum hardware is 1 GPU with 16GB+ VRAM; 8 GPUs (DDP) are recommended for production. GPU count is managed internally by TAO — do not set `gpu_spec_key`.

See `references/parameters-and-troubleshooting.md` for the full parameter reference, hardware guidance, and the complete error-pattern catalog (checkpoint not found, CSV format mismatch, image extension mismatch, OOM, low eval accuracy, the contrastive-loss assertion, non-convergence, the segment-only MultiScaleDeformableAttention build, Lightning epoch misconfiguration, PYTHONPATH/ModuleNotFoundError, and epoch defaults).

## Spec Param / Parent Model Inference

Model-specific inference mappings belong in this MD file, not in `config.json`. Generated runners should read this section and apply the mappings with SDK helpers before `create_job()`. This mirrors the old microservices `infer_params.py` flow.

Inference mappings from this model skill:

| Action | Spec Field | Inference Function | Meaning |
|---|---|---|---|
| evaluate | `results_dir` | `output_dir` | current job results directory |
| inference | `results_dir` | `output_dir` | current job results directory |
| train | `results_dir` | `output_dir` | current job results directory |
| train | `train.resume_training_checkpoint_path` | `resume_model` | model file inferred from the current job results folder |

For `parent_model` or `parent_model_folder`, pass the upstream train/export/AutoML child job id as `parent_job_id`. The SDK lists the parent result folder, filters checkpoint artifacts, and returns the selected model file or folder. Do not add these mappings back to `config.json` and do not patch generated runner scripts to guess checkpoint paths.

## Deployment

- [tao-deploy-visual-changenet](references/tao-deploy-visual-changenet.md) — Visual ChangeNet deploy workflow for TensorRT engine generation, TensorRT evaluation, and TensorRT inference using TAO Deploy.
