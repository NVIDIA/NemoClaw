---
name: tao-train-mask-auto-encoder
description: Masked Auto-Encoder (MAE) for self-supervised pretraining and fine-tuning. Masks random patches and reconstructs
  them to learn visual representations; supports pretrain and finetune stages. Use when training, evaluating, exporting, or
  running inference for a TAO MAE backbone. Trigger phrases include "pretrain MAE", "self-supervised vision pretraining",
  "Masked Autoencoder", "Mask Auto-Encoder", "MAE fine-tune".
license: Apache-2.0
compatibility: Requires docker + nvidia-container-toolkit.
metadata:
  version: "0.1.0"
  author: NVIDIA Corporation
allowed-tools: Read Bash
tags:
- self
- supervised
- learning
---

# MAE

MAE (Masked Autoencoder) for self-supervised pretraining and fine-tuning. Masks random patches and reconstructs them to learn visual representations. Supports pretrain and finetune stages.

Set train.pretrained_model_path for pretrained MAE weights when fine-tuning.

For TAO Deploy TensorRT actions (`gen_trt_engine`), read `references/tao-deploy-mask-auto-encoder.md` first. Deploy spec templates live in this skill's `references/` folder with the `spec_template_deploy_*.yaml` prefix.

## Dataclass Schemas

Generated TAO Core schemas are packaged in `schemas/<action>.schema.json`, with `schemas/manifest.json` listing available actions. Each generated schema also emits `references/spec_template_<action>.yaml` from the schema top-level `default` field. AutoML enablement is declared at the model layer in `references/skill_info.yaml` via `automl_enabled`. Runnable AutoML still requires `schemas/train.schema.json` and `references/spec_template_train.yaml` to exist and parse. Use the packaged train schema for `automl_default_parameters`, `automl_disabled_parameters`, defaults, min/max bounds, enums, option weights, math conditions, dependencies, and popular parameters. Do not expect `~/tao-core` at runtime; maintainers regenerate schemas/templates before packaging the skill bank.

## Train Action Policy

This model is AutoML-enabled at the model layer. Before handling any train-stage request, read `references/skill_info.yaml` and resolve the run override from either an explicit `automl_policy` value or the user's workflow request. Treat phrases like "turn off AutoML", "disable AutoML", "no HPO", or "plain training" as `automl_policy: off` for this run only; otherwise default to `auto`. When `automl_policy: auto`, `automl_enabled: true`, and both `schemas/train.schema.json` and `references/spec_template_train.yaml` are packaged, route the train action through `tao-skill-bank:tao-run-automl` by default with this model's `skill_dir`. Preserve workflow/application overrides for datasets, specs, output directories, GPU/platform settings, parent checkpoints, and `automl_policy`. Use direct model training only when `automl_policy: off` or the packaged train schema/template is missing; in the missing-schema case, report that AutoML is enabled but not runnable for this model until schemas are generated.

Non-train actions such as `evaluate`, `inference`, `export`, and deploy flows stay in this model skill. The per-run `automl_policy` override does not change model metadata.

## Training Requirements

- **Dataset type:** image_classification
- **Formats:** ssl
- **Accepted dataset intents:** training, evaluation, testing
- **Monitoring metric:** train_loss

### Per-Action Dataset Requirements

| Action | Spec Key | Source | Files | List? |
|---|---|---|---|---|
| train | dataset.train_data_sources | train_datasets | images_train.tar.gz | No |
| train | dataset.val_data_sources | eval_dataset | images_val.tar.gz | No |
| evaluate | dataset.val_data_sources | eval_dataset | images_val.tar.gz | No |
| inference | dataset.test_data_sources | inference_dataset | images_test.tar.gz | No |

### Typical Spec Overrides

Data source overrides are **mandatory for every action** — the agent MUST construct data source paths from the Per-Action Dataset Requirements table above and include them in `spec_overrides`.

```python
S3_TRAIN = "s3://bucket/data/train"
S3_EVAL = "s3://bucket/data/eval"
```

**train (mandatory data sources):**
```python
{
    "dataset.train_data_sources": f"{S3_TRAIN}/images_train.tar.gz",
    "dataset.val_data_sources": f"{S3_EVAL}/images_val.tar.gz",
    "train.num_epochs": 10,
    "train.optim.lr": 2e-4,
}
```

**evaluate (mandatory data sources):**
```python
{
    "dataset.val_data_sources": f"{S3_EVAL}/images_val.tar.gz",
}
```

**inference (mandatory data sources):**
```python
{
    "dataset.test_data_sources": f"{S3_EVAL}/images_test.tar.gz",
}
```

## Eval Dataset

Optional. Pretraining does not need eval data. Fine-tuning optionally uses val set.

## Important Parameters

- **train.stage**: Training stage. Options: pretrain, finetune. Pretrain learns representations via masking. Finetune adds a classification head.
- **model.arch**: Architecture. Default convnextv2_base. Wide range of options including ConvNeXt, Hiera, ViT variants.
- **model.num_classes**: Number of classes for fine-tuning. Default 1000 (ImageNet). Only relevant in finetune stage.
- **model.mask_ratio**: Fraction of patches to mask during pretraining. Typically 0.75.
- **model.norm_pix_loss**: Whether to normalize pixel values in reconstruction loss.
- **train.optim.lr**: Learning rate. Default 2e-4.
- **dataset.augmentation**: Augmentation settings including mixup, cutmix for fine-tuning.

## Multi-GPU / Multi-Node

**Launch method:** Lightning-managed (single `python` process, Lightning spawns workers).

| Spec Key | Description | Default |
|----------|-------------|---------|
| `train.num_gpus` | Number of GPUs | 1 |
| `train.gpu_ids` | GPU device indices | [0] |
| `train.num_nodes` | Number of nodes | 1 |
| `train.distributed_strategy` | `ddp` or `fsdp` | `ddp` |

- `ddp` uses `find_unused_parameters=True`
- `fsdp` forces FP16
- Multi-GPU strongly recommended for pretraining (large batch sizes needed)

**Multi-node env vars** (set by orchestrator): `WORLD_SIZE`, `NODE_RANK`, `MASTER_ADDR`, `MASTER_PORT`, `NUM_GPU_PER_NODE`.

## Hardware

Minimum 2 GPU(s), recommended 8 GPU(s). 24GB+ (A100 recommended) VRAM per GPU. MAE pretraining benefits from large batch sizes across many GPUs. Fine-tuning is more modest in resource requirements.

## Error Patterns

**Stage mismatch**: Ensure train.stage matches your intent (pretrain vs finetune). Fine-tuning without a pretrained_model_path trains from scratch.

**num_classes mismatch (finetune only)**: Ensure model.num_classes matches your dataset class count when fine-tuning.

## Spec Param / Parent Model Inference

Model-specific inference mappings belong in this MD file, not in `config.json`. Generated runners should read this section and apply the mappings with SDK helpers before `create_job()`. This mirrors the old microservices `infer_params.py` flow.

Inference mappings from TAO Core `mae.config.json`:

| Action | Spec Field | Inference Function | Meaning |
|---|---|---|---|
| evaluate | `encryption_key` | `key` | encryption key |
| evaluate | `evaluate.checkpoint` | `parent_model` | model file inferred from the parent job results folder |
| evaluate | `evaluate.trt_engine` | `parent_model` | model file inferred from the parent job results folder |
| evaluate | `results_dir` | `output_dir` | current job results directory |
| export | `encryption_key` | `key` | encryption key |
| export | `export.checkpoint` | `parent_model` | model file inferred from the parent job results folder |
| export | `export.onnx_file` | `create_onnx_file` | output ONNX path |
| export | `results_dir` | `output_dir` | current job results directory |
| gen_trt_engine | `encryption_key` | `key` | encryption key |
| gen_trt_engine | `gen_trt_engine.onnx_file` | `parent_model` | model file inferred from the parent job results folder |
| gen_trt_engine | `gen_trt_engine.trt_engine` | `create_engine_file` | output TensorRT engine path |
| gen_trt_engine | `results_dir` | `output_dir` | current job results directory |
| inference | `encryption_key` | `key` | encryption key |
| inference | `inference.checkpoint` | `parent_model` | model file inferred from the parent job results folder |
| inference | `inference.trt_engine` | `parent_model` | model file inferred from the parent job results folder |
| inference | `results_dir` | `output_dir` | current job results directory |
| train | `encryption_key` | `key` | encryption key |
| train | `results_dir` | `output_dir` | current job results directory |
| train | `train.pretrained_model_path` | `ptm_if_no_resume_model` | PTM when no resume checkpoint exists |
| train | `train.resume_training_checkpoint_path` | `resume_model` | model file inferred from the current job results folder |

For `parent_model` or `parent_model_folder`, pass the upstream train/export/AutoML child job id as `parent_job_id`. The SDK lists the parent result folder, filters checkpoint artifacts, and returns the selected model file or folder. Do not add these mappings back to `config.json` and do not patch generated runner scripts to guess checkpoint paths.

## Deployment

- [tao-deploy-mask-auto-encoder](references/tao-deploy-mask-auto-encoder.md) — MAE deploy workflow for TensorRT engine generation using TAO Deploy.
