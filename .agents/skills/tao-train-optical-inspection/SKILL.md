---
name: tao-train-optical-inspection
description: Optical Inspection for defect detection using Siamese networks. Compares image pairs to detect manufacturing
  defects, anomalies, or quality issues. Use when training, evaluating, exporting, or running inference for a TAO Optical
  Inspection model on AOI / quality-control data. Trigger phrases include "train optical inspection", "AOI defect
  detection", "Siamese defect classifier", "PCB / manufacturing inspection".
license: Apache-2.0
compatibility: Requires docker + nvidia-container-toolkit.
metadata:
  version: "0.1.0"
  author: NVIDIA Corporation
allowed-tools: Read Bash
tags:
- defect
- detection
---

# Optical Inspection

Optical inspection for defect detection using Siamese networks. Compares image pairs to detect manufacturing defects, anomalies, or quality issues.

Set train.pretrained_model_path for pretrained Siamese weights.

For TAO Deploy TensorRT actions (`gen_trt_engine`, TensorRT `evaluate`, and TensorRT `inference`), read `references/tao-deploy-optical-inspection.md` first. Deploy spec templates live in this skill's `references/` folder with the `spec_template_deploy_*.yaml` prefix.

## Dataclass Schemas

Generated TAO Core schemas are packaged in `schemas/<action>.schema.json`, with `schemas/manifest.json` listing available actions. Each generated schema also emits `references/spec_template_<action>.yaml` from the schema top-level `default` field. AutoML enablement is declared at the model layer in `references/skill_info.yaml` via `automl_enabled`. Runnable AutoML still requires `schemas/train.schema.json` and `references/spec_template_train.yaml` to exist and parse. Use the packaged train schema for `automl_default_parameters`, `automl_disabled_parameters`, defaults, min/max bounds, enums, option weights, math conditions, dependencies, and popular parameters. Do not expect `~/tao-core` at runtime; maintainers regenerate schemas/templates before packaging the skill bank.

## Train Action Policy

This model is AutoML-enabled at the model layer. Before handling any train-stage request, read `references/skill_info.yaml` and resolve the run override from either an explicit `automl_policy` value or the user's workflow request. Treat phrases like "turn off AutoML", "disable AutoML", "no HPO", or "plain training" as `automl_policy: off` for this run only; otherwise default to `auto`. When `automl_policy: auto`, `automl_enabled: true`, and both `schemas/train.schema.json` and `references/spec_template_train.yaml` are packaged, route the train action through `tao-skill-bank:tao-run-automl` by default with this model's `skill_dir`. Preserve workflow/application overrides for datasets, specs, output directories, GPU/platform settings, parent checkpoints, and `automl_policy`. Use direct model training only when `automl_policy: off` or the packaged train schema/template is missing; in the missing-schema case, report that AutoML is enabled but not runnable for this model until schemas are generated.

Non-train actions such as `evaluate`, `inference`, `export`, and deploy flows stay in this model skill. The per-run `automl_policy` override does not change model metadata.

## Training Requirements

- **Dataset type:** optical_inspection
- **Formats:** default
- **Monitoring metric:** val_acc

### Per-Action Dataset Requirements

| Action | Spec Key | Source | Files | List? |
|---|---|---|---|---|
| evaluate | dataset.test_dataset.images_dir | eval_dataset | images.tar.gz | No |
| evaluate | dataset.test_dataset.csv_path | eval_dataset | dataset.csv | No |
| gen_trt_engine | gen_trt_engine.tensorrt.calibration.cal_image_dir | calibration_dataset | images.tar.gz | Yes |
| inference | dataset.infer_dataset.images_dir | inference_dataset | images.tar.gz | No |
| inference | dataset.infer_dataset.csv_path | inference_dataset | dataset.csv | No |
| train | dataset.train_dataset.images_dir | train_datasets | images.tar.gz | No |
| train | dataset.train_dataset.csv_path | train_datasets | dataset.csv | No |
| train | dataset.validation_dataset.images_dir | eval_dataset | images.tar.gz | No |
| train | dataset.validation_dataset.csv_path | eval_dataset | dataset.csv | No |
| train | dataset.test_dataset.images_dir | eval_dataset | images.tar.gz | No |
| train | dataset.test_dataset.csv_path | eval_dataset | dataset.csv | No |

### Typical Spec Overrides

Data source overrides are **mandatory for every action** — the agent MUST construct data source paths from the Per-Action Dataset Requirements table above and include them in `spec_overrides`.

```python
S3_TRAIN = "s3://bucket/data/train"
S3_EVAL = "s3://bucket/data/eval"
```

**train (mandatory data sources):**
```python
{
    "train.num_epochs": 30,
    "train.checkpoint_interval": 10,
    "train.validation_interval": 10,
    "train.num_gpus": 1,
    "dataset.train_dataset.images_dir": f"{S3_TRAIN}/images.tar.gz",
    "dataset.train_dataset.csv_path": f"{S3_TRAIN}/dataset.csv",
    "dataset.validation_dataset.images_dir": f"{S3_EVAL}/images.tar.gz",
    "dataset.validation_dataset.csv_path": f"{S3_EVAL}/dataset.csv",
    "dataset.test_dataset.images_dir": f"{S3_EVAL}/images.tar.gz",
    "dataset.test_dataset.csv_path": f"{S3_EVAL}/dataset.csv",
}
```

**gen_trt_engine (mandatory data sources):**
```python
{
    "gen_trt_engine.tensorrt.data_type": "fp16",
    "gen_trt_engine.tensorrt.calibration.cal_image_dir": [f"{S3_TRAIN}/images.tar.gz"],
}
```

**evaluate (mandatory data sources):**
```python
{
    "dataset.test_dataset.images_dir": f"{S3_EVAL}/images.tar.gz",
    "dataset.test_dataset.csv_path": f"{S3_EVAL}/dataset.csv",
}
```

**inference (mandatory data sources):**
```python
{
    "dataset.infer_dataset.images_dir": f"{S3_EVAL}/images.tar.gz",
    "dataset.infer_dataset.csv_path": f"{S3_EVAL}/dataset.csv",
}
```
## Eval Dataset

Optional. Eval dataset uses same format (images + CSV).

## Important Parameters

- **model.model_type**: Siamese variant. Options include Siamese, Siamese_3.
- **model.model_backbone**: Default custom.
- **model.embedding_vectors**: Number of embedding dimensions. Default 5.
- **train.optim.lr**: Learning rate. Default 5e-4.
- **dataset.num_input**: Number of input images per comparison.
- **dataset.input_map**: Mapping of input channels / image pairs.

## Multi-GPU / Multi-Node

**Launch method:** Lightning-managed (single `python` process, Lightning spawns workers).

| Spec Key | Description | Default |
|----------|-------------|---------|
| `train.num_gpus` | Number of GPUs | 1 |
| `train.gpu_ids` | GPU device indices | [0] |

- Strategy: `auto` (Lightning picks best strategy automatically)
- No explicit `num_nodes` or `distributed_strategy` config — single-node only
- Lightweight Siamese network, single GPU typically sufficient

## Hardware

Minimum 1 GPU(s), recommended 1 GPU(s). 8GB+ VRAM per GPU. Siamese networks for inspection are lightweight. Single GPU sufficient.

## Error Patterns

**CSV format error**: Ensure dataset.csv has the correct column format for image pair paths and labels.

## Spec Param / Parent Model Inference

Model-specific inference mappings belong in this MD file, not in `config.json`. Generated runners should read this section and apply the mappings with SDK helpers before `create_job()`. This mirrors the old microservices `infer_params.py` flow.

Inference mappings from TAO Core `optical_inspection.config.json`:

| Action | Spec Field | Inference Function | Meaning |
|---|---|---|---|
| evaluate | `encryption_key` | `key` | encryption key |
| evaluate | `evaluate.checkpoint` | `parent_model` | model file inferred from the parent job results folder |
| evaluate | `results_dir` | `output_dir` | current job results directory |
| export | `encryption_key` | `key` | encryption key |
| export | `export.checkpoint` | `parent_model` | model file inferred from the parent job results folder |
| export | `export.onnx_file` | `create_onnx_file` | output ONNX path |
| export | `results_dir` | `output_dir` | current job results directory |
| gen_trt_engine | `encryption_key` | `key` | encryption key |
| gen_trt_engine | `gen_trt_engine.onnx_file` | `parent_model` | model file inferred from the parent job results folder |
| gen_trt_engine | `gen_trt_engine.tensorrt.calibration.cal_cache_file` | `create_cal_cache` | calibration cache path |
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

- [tao-deploy-optical-inspection](references/tao-deploy-optical-inspection.md) — Optical Inspection deploy workflow for TensorRT engine generation, TensorRT evaluation, and TensorRT inference using TAO Deploy.
