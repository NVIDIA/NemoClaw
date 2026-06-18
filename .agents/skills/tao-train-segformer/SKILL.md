---
name: tao-train-segformer
description: SegFormer for semantic segmentation. Lightweight transformer-based architecture with hierarchical feature
  extraction, efficient for real-time segmentation tasks. Use when training, evaluating, exporting, quantizing, or running
  inference for a TAO SegFormer model. Trigger phrases include "train SegFormer", "semantic segmentation", "lightweight
  transformer segmenter", "real-time semantic segmentation".
license: Apache-2.0
compatibility: Requires docker + nvidia-container-toolkit.
metadata:
  version: "0.1.0"
  author: NVIDIA Corporation
allowed-tools: Read Bash
tags:
- segmentation
---

# SegFormer

SegFormer for semantic segmentation. Lightweight transformer-based architecture with hierarchical feature extraction. Efficient for real-time segmentation tasks.

Set model.backbone.pretrained_backbone_path for backbone weights.

For TAO Deploy TensorRT actions (`gen_trt_engine`, TensorRT `evaluate`, and TensorRT `inference`), read `references/tao-deploy-segformer.md` first. Deploy spec templates live in this skill's `references/` folder with the `spec_template_deploy_*.yaml` prefix.

## Dataclass Schemas

Generated TAO Core schemas are packaged in `schemas/<action>.schema.json`, with `schemas/manifest.json` listing available actions. Each generated schema also emits `references/spec_template_<action>.yaml` from the schema top-level `default` field. AutoML enablement is declared at the model layer in `references/skill_info.yaml` via `automl_enabled`. Runnable AutoML still requires `schemas/train.schema.json` and `references/spec_template_train.yaml` to exist and parse. Use the packaged train schema for `automl_default_parameters`, `automl_disabled_parameters`, defaults, min/max bounds, enums, option weights, math conditions, dependencies, and popular parameters. Do not expect `~/tao-core` at runtime; maintainers regenerate schemas/templates before packaging the skill bank.

## Train Action Policy

This model is AutoML-enabled at the model layer. Before handling any train-stage request, read `references/skill_info.yaml` and resolve the run override from either an explicit `automl_policy` value or the user's workflow request. Treat phrases like "turn off AutoML", "disable AutoML", "no HPO", or "plain training" as `automl_policy: off` for this run only; otherwise default to `auto`. When `automl_policy: auto`, `automl_enabled: true`, and both `schemas/train.schema.json` and `references/spec_template_train.yaml` are packaged, route the train action through `tao-skill-bank:tao-run-automl` by default with this model's `skill_dir`. Preserve workflow/application overrides for datasets, specs, output directories, GPU/platform settings, parent checkpoints, and `automl_policy`. Use direct model training only when `automl_policy: off` or the packaged train schema/template is missing; in the missing-schema case, report that AutoML is enabled but not runnable for this model until schemas are generated.

Non-train actions such as `evaluate`, `inference`, `export`, and deploy flows stay in this model skill. The per-run `automl_policy` override does not change model metadata.

## Training Requirements

- **Dataset type:** segmentation
- **Formats:** unet
- **Monitoring metric:** val_miou

### Per-Action Dataset Requirements

| Action | Spec Key | Source | Files | List? |
|---|---|---|---|---|
| evaluate | dataset.segment.root_dir | eval_dataset |  | No |
| export | dataset.segment.root_dir | train_datasets |  | No |
| inference | dataset.segment.root_dir | eval_dataset |  | No |
| quantize | dataset.segment.root_dir | train_datasets |  | No |
| quantize | dataset.segment.quant_calibration_dataset.images_dir | train_datasets |  | No |
| train | dataset.segment.root_dir | train_datasets |  | No |

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
    "train.num_epochs": 10,
    "train.checkpoint_interval": 10,
    "train.validation_interval": 10,
    "dataset.segment.batch_size": 4,
    "dataset.segment.root_dir": f"{S3_TRAIN}",
}
```

**evaluate (mandatory data sources):**
```python
{
    "evaluate.batch_size": 4,
    "dataset.segment.root_dir": f"{S3_EVAL}",
}
```

**gen_trt_engine:**
```python
{
    "gen_trt_engine.tensorrt.data_type": "fp16",
}
```

**inference (mandatory data sources):**
```python
{
    "dataset.segment.batch_size": 1,
    "dataset.segment.root_dir": f"{S3_EVAL}",
}
```

**export (mandatory data sources):**
```python
{
    "dataset.segment.root_dir": f"{S3_TRAIN}",
}
```

**quantize (mandatory data sources):**
```python
{
    "dataset.segment.root_dir": f"{S3_TRAIN}",
    "dataset.segment.quant_calibration_dataset.images_dir": f"{S3_TRAIN}",
}
```
## Eval Dataset

Optional. Validation data is typically part of the root_dir structure.

## Important Parameters

- **dataset.segment.num_classes**: Number of segmentation classes. Default 2 (binary). Must match the number of classes in your mask annotations.
- **model.backbone.type**: Default fan_small_12_p4_hybrid. Supported includes FAN variants, SegFormer MIT variants, and others.
- **dataset.segment.root_dir**: Root directory of the segmentation dataset.
- **dataset.segment.img_size**: Input image size. Default 256. Increase for finer segmentation at the cost of memory.
- **train.optim.lr**: Learning rate. Default 6e-5.
- **model.freeze_backbone**: Whether to freeze the backbone during training. Useful for fine-tuning with limited data.
- **dataset.segment.batch_size**: Per-GPU batch size. Default 8.

## Multi-GPU / Multi-Node

**Launch method:** Lightning-managed (single `python` process, Lightning spawns workers).

| Spec Key | Description | Default |
|----------|-------------|---------|
| `train.num_gpus` | Number of GPUs | 1 |
| `train.gpu_ids` | GPU device indices | [0] |
| `train.num_nodes` | Number of nodes | 1 |
| `train.sync_batchnorm` | Sync BN across GPUs | configurable |
| `train.use_distributed_sampler` | Use distributed sampler | configurable |

- Multi-GPU strategy: `ddp_find_unused_parameters_true`
- No fsdp support

**Multi-node env vars** (set by orchestrator): `WORLD_SIZE`, `NODE_RANK`, `MASTER_ADDR`, `MASTER_PORT`, `NUM_GPU_PER_NODE`.

## Hardware

Minimum 1 GPU(s), recommended 2 GPU(s). 16GB+ (V100 or A100) VRAM per GPU. SegFormer is relatively lightweight. Default img_size=256 is memory-friendly. Increase img_size for higher resolution at the cost of memory and speed.

## Error Patterns

**CUDA out of memory**: Reduce batch_size or img_size. SegFormer memory scales quadratically with image size.

**num_classes mismatch**: Ensure dataset.segment.num_classes matches the actual number of classes in your mask annotations.

## Spec Param / Parent Model Inference

Model-specific inference mappings belong in this MD file, not in `config.json`. Generated runners should read this section and apply the mappings with SDK helpers before `create_job()`. This mirrors the old microservices `infer_params.py` flow.

Inference mappings from TAO Core `segformer.config.json`:

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
| quantize | `encryption_key` | `key` | encryption key |
| quantize | `quantize.model_path` | `parent_model` | model file inferred from the parent job results folder |
| quantize | `results_dir` | `output_dir` | current job results directory |
| train | `encryption_key` | `key` | encryption key |
| train | `model.backbone.pretrained_backbone_path` | `ptm_if_no_resume_model` | PTM when no resume checkpoint exists |
| train | `results_dir` | `output_dir` | current job results directory |
| train | `train.pretrained_model_path` | `ptm_if_no_resume_model` | PTM when no resume checkpoint exists |
| train | `train.resume_training_checkpoint_path` | `resume_model` | model file inferred from the current job results folder |

For `parent_model` or `parent_model_folder`, pass the upstream train/export/AutoML child job id as `parent_job_id`. The SDK lists the parent result folder, filters checkpoint artifacts, and returns the selected model file or folder. Do not add these mappings back to `config.json` and do not patch generated runner scripts to guess checkpoint paths.

## Deployment

- [tao-deploy-segformer](references/tao-deploy-segformer.md) — SegFormer deploy workflow for TensorRT engine generation, TensorRT evaluation, and TensorRT inference using TAO Deploy.
