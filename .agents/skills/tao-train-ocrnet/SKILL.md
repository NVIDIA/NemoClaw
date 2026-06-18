---
name: tao-train-ocrnet
description: OCRNet for scene text recognition. Recognizes text content from cropped text-region images and supports CTC
  and attention-based decoders. Use when training, evaluating, exporting, pruning, quantizing, retraining, or running
  inference for a TAO OCRNet model. Trigger phrases include "train OCRNet", "scene text recognition", "OCR cropped text",
  "CTC / attention text decoder".
license: Apache-2.0
compatibility: Requires docker + nvidia-container-toolkit.
metadata:
  version: "0.1.0"
  author: NVIDIA Corporation
allowed-tools: Read Bash
tags:
- text
- recognition
---

# OCRNet

OCRNet for scene text recognition. Recognizes text content from cropped text region images. Supports CTC and attention-based decoders.

Set train.pretrained_model_path for pretrained OCR weights.

For TAO Deploy TensorRT actions (`gen_trt_engine`, TensorRT `evaluate`, and TensorRT `inference`), read `references/tao-deploy-ocrnet.md` first. Deploy spec templates live in this skill's `references/` folder with the `spec_template_deploy_*.yaml` prefix.

## Dataclass Schemas

Generated TAO Core schemas are packaged in `schemas/<action>.schema.json`, with `schemas/manifest.json` listing available actions. Each generated schema also emits `references/spec_template_<action>.yaml` from the schema top-level `default` field. AutoML enablement is declared at the model layer in `references/skill_info.yaml` via `automl_enabled`. Runnable AutoML still requires `schemas/train.schema.json` and `references/spec_template_train.yaml` to exist and parse. Use the packaged train schema for `automl_default_parameters`, `automl_disabled_parameters`, defaults, min/max bounds, enums, option weights, math conditions, dependencies, and popular parameters. Do not expect `~/tao-core` at runtime; maintainers regenerate schemas/templates before packaging the skill bank.

## Train Action Policy

This model is AutoML-enabled at the model layer. Before handling any train-stage request, read `references/skill_info.yaml` and resolve the run override from either an explicit `automl_policy` value or the user's workflow request. Treat phrases like "turn off AutoML", "disable AutoML", "no HPO", or "plain training" as `automl_policy: off` for this run only; otherwise default to `auto`. When `automl_policy: auto`, `automl_enabled: true`, and both `schemas/train.schema.json` and `references/spec_template_train.yaml` are packaged, route the train action through `tao-skill-bank:tao-run-automl` by default with this model's `skill_dir`. Preserve workflow/application overrides for datasets, specs, output directories, GPU/platform settings, parent checkpoints, and `automl_policy`. Use direct model training only when `automl_policy: off` or the packaged train schema/template is missing; in the missing-schema case, report that AutoML is enabled but not runnable for this model until schemas are generated.

Non-train actions such as `evaluate`, `inference`, `export`, and deploy flows stay in this model skill. The per-run `automl_policy` override does not change model metadata.

## Training Requirements

- **Dataset type:** ocrnet
- **Formats:** default
- **Monitoring metric:** val_acc

### Per-Action Dataset Requirements

| Action | Spec Key | Source | Files | List? |
|---|---|---|---|---|
| dataset_convert | dataset_convert.input_img_dir | id |  | No |
| dataset_convert | dataset_convert.gt_file | id |  | No |
| evaluate | dataset.character_list_file | eval_dataset | character_list | No |
| evaluate | evaluate.test_dataset_dir | eval_dataset | results/{dataset_convert_job_id}/dataset_convert/lmdb | No |
| export | dataset.character_list_file | eval_dataset | character_list | No |
| gen_trt_engine | gen_trt_engine.tensorrt.calibration.cal_image_dir | calibration_dataset |  | Yes |
| inference | dataset.character_list_file | eval_dataset | character_list | No |
| inference | inference.inference_dataset_dir | eval_dataset | test.tar.gz | No |
| prune | dataset.character_list_file | eval_dataset | character_list | No |
| quantize | dataset.train_dataset_dir | train_datasets | results/{dataset_convert_job_id}/dataset_convert/lmdb | Yes |
| quantize | dataset.val_dataset_dir | eval_dataset | results/{dataset_convert_job_id}/dataset_convert/lmdb | No |
| quantize | dataset.character_list_file | eval_dataset | character_list | No |
| quantize | dataset.quant_calibration_dataset.images_dir | train_datasets | train.tar.gz | No |
| retrain | dataset.train_dataset_dir | train_datasets | results/{dataset_convert_job_id}/dataset_convert/lmdb | Yes |
| retrain | dataset.val_dataset_dir | eval_dataset | results/{dataset_convert_job_id}/dataset_convert/lmdb | No |
| retrain | dataset.character_list_file | eval_dataset | character_list | No |
| train | dataset.train_dataset_dir | train_datasets | results/{dataset_convert_job_id}/dataset_convert/lmdb | Yes |
| train | dataset.val_dataset_dir | eval_dataset | results/{dataset_convert_job_id}/dataset_convert/lmdb | No |
| train | dataset.character_list_file | eval_dataset | character_list | No |

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
    "dataset.batch_size": 16,
    "dataset.train_dataset_dir": [f"{S3_TRAIN}/results/{dataset_convert_job_id}/dataset_convert/lmdb"],
    "dataset.val_dataset_dir": f"{S3_EVAL}/results/{dataset_convert_job_id}/dataset_convert/lmdb",
    "dataset.character_list_file": f"{S3_EVAL}/character_list",
}
```

**gen_trt_engine (mandatory data sources):**
```python
{
    "gen_trt_engine.tensorrt.data_type": "fp16",
    "gen_trt_engine.tensorrt.calibration.cal_image_dir": [f"{S3_TRAIN}"],
}
```

**evaluate (mandatory data sources):**
```python
{
    "dataset.character_list_file": f"{S3_EVAL}/character_list",
    "evaluate.test_dataset_dir": f"{S3_EVAL}/results/{dataset_convert_job_id}/dataset_convert/lmdb",
}
```

**export (mandatory data sources):**
```python
{
    "dataset.character_list_file": f"{S3_EVAL}/character_list",
}
```

**inference (mandatory data sources):**
```python
{
    "dataset.character_list_file": f"{S3_EVAL}/character_list",
    "inference.inference_dataset_dir": f"{S3_EVAL}/test.tar.gz",
}
```

**prune (mandatory data sources):**
```python
{
    "dataset.character_list_file": f"{S3_EVAL}/character_list",
}
```

**quantize (mandatory data sources):**
```python
{
    "dataset.train_dataset_dir": [f"{S3_TRAIN}/results/{dataset_convert_job_id}/dataset_convert/lmdb"],
    "dataset.val_dataset_dir": f"{S3_EVAL}/results/{dataset_convert_job_id}/dataset_convert/lmdb",
    "dataset.character_list_file": f"{S3_EVAL}/character_list",
    "dataset.quant_calibration_dataset.images_dir": f"{S3_TRAIN}/train.tar.gz",
}
```

**retrain (mandatory data sources):**
```python
{
    "dataset.train_dataset_dir": [f"{S3_TRAIN}/results/{dataset_convert_job_id}/dataset_convert/lmdb"],
    "dataset.val_dataset_dir": f"{S3_EVAL}/results/{dataset_convert_job_id}/dataset_convert/lmdb",
    "dataset.character_list_file": f"{S3_EVAL}/character_list",
}
```
## Eval Dataset

Optional. Test data provided as separate tarball.

## Important Parameters

- **dataset.character_list_file**: Path to character list defining the supported character set. This determines the output vocabulary size.
- **model.backbone**: Default ResNet.
- **model.prediction**: Decoder type. CTC or Attn (attention-based).
- **train.optim.lr**: Learning rate. Default 1.0 (Adadelta optimizer). High default is specific to Adadelta.
- **dataset.batch_size**: Per-GPU batch size. Default 16.

## Multi-GPU / Multi-Node

**Launch method:** Lightning-managed (single `python` process, Lightning spawns workers).

| Spec Key | Description | Default |
|----------|-------------|---------|
| `train.num_gpus` | Number of GPUs | 1 |
| `train.gpu_ids` | GPU device indices | [0] |
| `train.distributed_strategy` | Strategy name | `auto` |

- Strategy: `auto` for single-GPU, reads `train.distributed_strategy` from config when multi-GPU
- No explicit `num_nodes` in train script — single-node oriented
- Lightweight model, single GPU typically sufficient

## Hardware

Minimum 1 GPU(s), recommended 1 GPU(s). 8GB+ VRAM per GPU. OCR text recognition is lightweight. Single GPU is typically sufficient.

## Error Patterns

**dataset_convert required**: If using raw images + gt files, run dataset_convert first to produce LMDB format.

**Character list mismatch**: All characters in training data must be present in the character_list file.

## Spec Param / Parent Model Inference

Model-specific inference mappings belong in this MD file, not in `config.json`. Generated runners should read this section and apply the mappings with SDK helpers before `create_job()`. This mirrors the old microservices `infer_params.py` flow.

Inference mappings from TAO Core `ocrnet.config.json`:

| Action | Spec Field | Inference Function | Meaning |
|---|---|---|---|
| dataset_convert | `results_dir` | `output_dir` | current job results directory |
| evaluate | `encryption_key` | `key` | encryption key |
| evaluate | `evaluate.checkpoint` | `parent_model` | model file inferred from the parent job results folder |
| evaluate | `evaluate.trt_engine` | `parent_model` | model file inferred from the parent job results folder |
| evaluate | `model.pruned_graph_path` | `pruned_model` | parent pruned model |
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
| inference | `model.pruned_graph_path` | `pruned_model` | parent pruned model |
| inference | `results_dir` | `output_dir` | current job results directory |
| prune | `encryption_key` | `key` | encryption key |
| prune | `prune.checkpoint` | `parent_model` | model file inferred from the parent job results folder |
| prune | `prune.pruned_file` | `create_pth_file` | output PTH path |
| prune | `results_dir` | `output_dir` | current job results directory |
| quantize | `encryption_key` | `key` | encryption key |
| quantize | `quantize.model_path` | `parent_model` | model file inferred from the parent job results folder |
| quantize | `results_dir` | `output_dir` | current job results directory |
| retrain | `encryption_key` | `key` | encryption key |
| retrain | `model.pruned_graph_path` | `parent_model` | model file inferred from the parent job results folder |
| retrain | `results_dir` | `output_dir` | current job results directory |
| train | `encryption_key` | `key` | encryption key |
| train | `results_dir` | `output_dir` | current job results directory |
| train | `train.pretrained_model_path` | `ptm_if_no_resume_model` | PTM when no resume checkpoint exists |
| train | `train.resume_training_checkpoint_path` | `resume_model` | model file inferred from the current job results folder |

For `parent_model` or `parent_model_folder`, pass the upstream train/export/AutoML child job id as `parent_job_id`. The SDK lists the parent result folder, filters checkpoint artifacts, and returns the selected model file or folder. Do not add these mappings back to `config.json` and do not patch generated runner scripts to guess checkpoint paths.

## Deployment

- [tao-deploy-ocrnet](references/tao-deploy-ocrnet.md) — OCRNet deploy workflow for TensorRT engine generation, TensorRT evaluation, and TensorRT inference using TAO Deploy.
