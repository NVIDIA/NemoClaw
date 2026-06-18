---
name: tao-train-mask-auto-label
description: MAL (Mask Auto-Label) for weakly-supervised segmentation. Produces segmentation masks from minimal annotations
  (point or box annotations) using a ViT-MAE backbone. Use when training, evaluating, or running inference for a TAO MAL
  model. Trigger phrases include "train MAL", "Mask Auto-Label", "weakly-supervised segmentation", "box-prompted
  segmentation", "minimal-annotation mask prediction".
license: Apache-2.0
compatibility: Requires docker + nvidia-container-toolkit.
metadata:
  version: "0.1.0"
  author: NVIDIA Corporation
allowed-tools: Read Bash
tags:
- segmentation
---

# MAL

MAL (Mask Auto-Label) for weakly-supervised segmentation. Produces segmentation masks from minimal annotations (e.g., point or box annotations). Uses ViT-MAE backbone.

Set train.pretrained_model_path for ViT-MAE pretrained weights.

## Dataclass Schemas

Generated TAO Core schemas are packaged in `schemas/<action>.schema.json`, with `schemas/manifest.json` listing available actions. Each generated schema also emits `references/spec_template_<action>.yaml` from the schema top-level `default` field. AutoML enablement is declared at the model layer in `references/skill_info.yaml` via `automl_enabled`. Runnable AutoML still requires `schemas/train.schema.json` and `references/spec_template_train.yaml` to exist and parse. Use the packaged train schema for `automl_default_parameters`, `automl_disabled_parameters`, defaults, min/max bounds, enums, option weights, math conditions, dependencies, and popular parameters. Do not expect `~/tao-core` at runtime; maintainers regenerate schemas/templates before packaging the skill bank.

## Train Action Policy

This model is AutoML-enabled at the model layer. Before handling any train-stage request, read `references/skill_info.yaml` and resolve the run override from either an explicit `automl_policy` value or the user's workflow request. Treat phrases like "turn off AutoML", "disable AutoML", "no HPO", or "plain training" as `automl_policy: off` for this run only; otherwise default to `auto`. When `automl_policy: auto`, `automl_enabled: true`, and both `schemas/train.schema.json` and `references/spec_template_train.yaml` are packaged, route the train action through `tao-skill-bank:tao-run-automl` by default with this model's `skill_dir`. Preserve workflow/application overrides for datasets, specs, output directories, GPU/platform settings, parent checkpoints, and `automl_policy`. Use direct model training only when `automl_policy: off` or the packaged train schema/template is missing; in the missing-schema case, report that AutoML is enabled but not runnable for this model until schemas are generated.

Non-train actions such as `evaluate`, `inference`, `export`, and deploy flows stay in this model skill. The per-run `automl_policy` override does not change model metadata.

## Training Requirements

- **Dataset type:** segmentation
- **Formats:** default
- **Monitoring metric:** mIoU

### Per-Action Dataset Requirements

| Action | Spec Key | Source | Files | List? |
|---|---|---|---|---|
| evaluate | dataset.val_img_dir | eval_dataset | images.tar.gz | No |
| evaluate | dataset.val_ann_path | eval_dataset | annotations.json | No |
| inference | inference.img_dir | inference_dataset | images.tar.gz | No |
| inference | inference.ann_path | inference_dataset | annotations.json | No |
| train | dataset.train_img_dir | train_datasets | images.tar.gz | No |
| train | dataset.train_ann_path | train_datasets | annotations.json | No |
| train | dataset.val_img_dir | eval_dataset | images.tar.gz | No |
| train | dataset.val_ann_path | eval_dataset | annotations.json | No |

### Typical Spec Overrides

Data source overrides are **mandatory for every action** — the agent MUST construct data source paths from the Per-Action Dataset Requirements table above and include them in `spec_overrides`.

```python
S3_TRAIN = "s3://bucket/data/train"
S3_EVAL = "s3://bucket/data/eval"
```

**train (mandatory data sources):**
```python
{
    "train.num_gpus": 1,
    "train.gpu_ids": [
        0
    ],
    "train.num_epochs": 5,
    "train.checkpoint_interval": 5,
    "train.validation_interval": 5,
    "dataset.train_img_dir": f"{S3_TRAIN}/images.tar.gz",
    "dataset.train_ann_path": f"{S3_TRAIN}/annotations.json",
    "dataset.val_img_dir": f"{S3_EVAL}/images.tar.gz",
    "dataset.val_ann_path": f"{S3_EVAL}/annotations.json",
}
```

**evaluate (mandatory data sources):**
```python
{
    "dataset.val_img_dir": f"{S3_EVAL}/images.tar.gz",
    "dataset.val_ann_path": f"{S3_EVAL}/annotations.json",
}
```

**inference (mandatory data sources):**
```python
{
    "inference.img_dir": f"{S3_EVAL}/images.tar.gz",
    "inference.ann_path": f"{S3_EVAL}/annotations.json",
}
```
## Eval Dataset

Optional. Val images and annotations configured alongside train paths.

## Important Parameters

- **model.arch**: ViT-MAE backbone variant. Default vit-mae-base/16. Options include vit-mae-large/16 and other ViT-MAE variants.
- **train.lr**: Learning rate. Default 1e-6 (very low — fine-tuning ViT).
- **model.crop_size**: Training crop size. Default 512.
- **train.warmup_epochs**: Warmup epochs before full learning rate.
- **model.load_mask**: Whether to load pre-computed masks.

## Multi-GPU / Multi-Node

**Launch method:** Lightning-managed (single `python` process, Lightning spawns workers).

| Spec Key | Description | Default |
|----------|-------------|---------|
| `train.num_gpus` | Number of GPUs | 1 |
| `train.gpu_ids` | GPU device indices | [0] |
| `train.num_nodes` | Number of nodes | 1 |

- Multi-GPU strategy: `ddp_find_unused_parameters_true`
- No fsdp support
- **LR auto-scaling:** `lr = lr * num_devices * batch_size` (learning rate is scaled automatically by device count and batch size)

**Multi-node env vars** (set by orchestrator): `WORLD_SIZE`, `NODE_RANK`, `MASTER_ADDR`, `MASTER_PORT`, `NUM_GPU_PER_NODE`.

## Hardware

Minimum 1 GPU(s), recommended 2 GPU(s). 24GB+ (A100 recommended) VRAM per GPU. ViT-MAE backbone at crop_size=512 needs 24GB+ GPU memory.

## Error Patterns

**CUDA out of memory**: Reduce model.crop_size (512 -> 384 -> 256) or use a smaller ViT-MAE variant (base vs large).

## Spec Param / Parent Model Inference

Model-specific inference mappings belong in this MD file, not in `config.json`. Generated runners should read this section and apply the mappings with SDK helpers before `create_job()`. This mirrors the old microservices `infer_params.py` flow.

Inference mappings from TAO Core `mal.config.json`:

| Action | Spec Field | Inference Function | Meaning |
|---|---|---|---|
| evaluate | `evaluate.checkpoint` | `parent_model` | model file inferred from the parent job results folder |
| evaluate | `results_dir` | `output_dir` | current job results directory |
| inference | `inference.checkpoint` | `parent_model` | model file inferred from the parent job results folder |
| inference | `inference.label_dump_path` | `create_inference_result_file_mal` | MAL inference JSON path |
| inference | `results_dir` | `output_dir` | current job results directory |
| train | `results_dir` | `output_dir` | current job results directory |

For `parent_model` or `parent_model_folder`, pass the upstream train/export/AutoML child job id as `parent_job_id`. The SDK lists the parent result folder, filters checkpoint artifacts, and returns the selected model file or folder. Do not add these mappings back to `config.json` and do not patch generated runner scripts to guess checkpoint paths.
