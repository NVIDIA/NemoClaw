---
name: tao-train-ocdnet
description: OCDNet for scene text detection. Detects arbitrary-oriented text regions in natural images using a
  differentiable binarization approach. Use when training, evaluating, exporting, pruning, quantizing, retraining, or running
  inference for a TAO OCDNet model. Trigger phrases include "train OCDNet", "scene text detection", "arbitrary-oriented text
  boxes", "differentiable binarization detector".
license: Apache-2.0
compatibility: Requires docker + nvidia-container-toolkit.
metadata:
  version: "0.1.0"
  author: NVIDIA Corporation
allowed-tools: Read Bash
tags:
- text
- detection
---

# OCDNet

OCDNet for scene text detection. Detects arbitrary-oriented text regions in natural images using a differentiable binarization approach.

Set train.pretrained_model_path for pretrained weights.

For TAO Deploy TensorRT actions (`gen_trt_engine`, TensorRT `evaluate`, and TensorRT `inference`), read `references/tao-deploy-ocdnet.md` first. Deploy spec templates live in this skill's `references/` folder with the `spec_template_deploy_*.yaml` prefix.

## Dataclass Schemas

Generated TAO Core schemas are packaged in `schemas/<action>.schema.json`, with `schemas/manifest.json` listing available actions. Each generated schema also emits `references/spec_template_<action>.yaml` from the schema top-level `default` field. AutoML enablement is declared at the model layer in `references/skill_info.yaml` via `automl_enabled`. Runnable AutoML still requires `schemas/train.schema.json` and `references/spec_template_train.yaml` to exist and parse. Use the packaged train schema for `automl_default_parameters`, `automl_disabled_parameters`, defaults, min/max bounds, enums, option weights, math conditions, dependencies, and popular parameters. Do not expect `~/tao-core` at runtime; maintainers regenerate schemas/templates before packaging the skill bank.

## Train Action Policy

This model is AutoML-enabled at the model layer. Before handling any train-stage request, read `references/skill_info.yaml` and resolve the run override from either an explicit `automl_policy` value or the user's workflow request. Treat phrases like "turn off AutoML", "disable AutoML", "no HPO", or "plain training" as `automl_policy: off` for this run only; otherwise default to `auto`. When `automl_policy: auto`, `automl_enabled: true`, and both `schemas/train.schema.json` and `references/spec_template_train.yaml` are packaged, route the train action through `tao-skill-bank:tao-run-automl` by default with this model's `skill_dir`. Preserve workflow/application overrides for datasets, specs, output directories, GPU/platform settings, parent checkpoints, and `automl_policy`. Use direct model training only when `automl_policy: off` or the packaged train schema/template is missing; in the missing-schema case, report that AutoML is enabled but not runnable for this model until schemas are generated.

Non-train actions such as `evaluate`, `inference`, `export`, and deploy flows stay in this model skill. The per-run `automl_policy` override does not change model metadata.

## Training Requirements

- **Dataset type:** ocdnet
- **Formats:** default
- **Monitoring metric:** hmean

### Per-Action Dataset Requirements

| Action | Spec Key | Source | Files | List? |
|---|---|---|---|---|
| evaluate | dataset.validate_dataset.data_path | eval_dataset | test.tar.gz | Yes |
| gen_trt_engine | gen_trt_engine.tensorrt.calibration.cal_image_dir | calibration_dataset | train/img.tar.gz | Yes |
| inference | inference.input_folder | eval_dataset | test/img.tar.gz | No |
| prune | dataset.validate_dataset.data_path | eval_dataset | test.tar.gz | Yes |
| quantize | dataset.train_dataset.data_path | train_datasets | train.tar.gz | Yes |
| quantize | dataset.validate_dataset.data_path | eval_dataset | test.tar.gz | Yes |
| quantize | dataset.quant_calibration_dataset.images_dir | train_datasets | train/img.tar.gz | No |
| retrain | dataset.train_dataset.data_path | train_datasets | train.tar.gz | Yes |
| retrain | dataset.validate_dataset.data_path | eval_dataset | test.tar.gz | Yes |
| train | dataset.train_dataset.data_path | train_datasets | train.tar.gz | Yes |
| train | dataset.validate_dataset.data_path | eval_dataset | test.tar.gz | Yes |

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
    "dataset.train_dataset.loader.batch_size": 16,
    "dataset.train_dataset.data_path": [f"{S3_TRAIN}/train.tar.gz"],
    "dataset.validate_dataset.data_path": [f"{S3_EVAL}/test.tar.gz"],
}
```

**gen_trt_engine (mandatory data sources):**
```python
{
    "gen_trt_engine.tensorrt.data_type": "INT8",
    "gen_trt_engine.tensorrt.calibration.cal_image_dir": [f"{S3_TRAIN}/train/img.tar.gz"],
}
```

**evaluate (mandatory data sources):**
```python
{
    "dataset.validate_dataset.data_path": [f"{S3_EVAL}/test.tar.gz"],
}
```

**inference (mandatory data sources):**
```python
{
    "inference.input_folder": f"{S3_EVAL}/test/img.tar.gz",
}
```

**prune (mandatory data sources):**
```python
{
    "dataset.validate_dataset.data_path": [f"{S3_EVAL}/test.tar.gz"],
}
```

**quantize (mandatory data sources):**
```python
{
    "dataset.train_dataset.data_path": [f"{S3_TRAIN}/train.tar.gz"],
    "dataset.validate_dataset.data_path": [f"{S3_EVAL}/test.tar.gz"],
    "dataset.quant_calibration_dataset.images_dir": f"{S3_TRAIN}/train/img.tar.gz",
}
```

**retrain (mandatory data sources):**
```python
{
    "dataset.train_dataset.data_path": [f"{S3_TRAIN}/train.tar.gz"],
    "dataset.validate_dataset.data_path": [f"{S3_EVAL}/test.tar.gz"],
}
```
## Eval Dataset

Optional. Test dataset provided as separate tarball.

## Important Parameters

- **model.backbone**: Default deformable_resnet18. Deformable convolutions improve text region detection for irregular text.
- **train.optimizer.args.lr**: Learning rate. Default 0.001 (Adam).
- **postprocess.thresh**: Binarization threshold for text region extraction.
- **postprocess.box_thresh**: Box confidence threshold for filtering detections.

## Multi-GPU / Multi-Node

**Launch method:** Lightning-managed (single `python` process, Lightning spawns workers).

| Spec Key | Description | Default |
|----------|-------------|---------|
| `train.num_gpus` | Number of GPUs | 1 |
| `train.gpu_ids` | GPU device indices | [0] |
| `train.distributed_strategy` | `ddp`, `fsdp`, or `deepspeed_stage_3_offload` | `ddp` |

- `ddp` with activation checkpointing: `find_unused_parameters=False`
- `ddp` without: `find_unused_parameters=True`
- `fsdp` forces FP16
- **`deepspeed_stage_3_offload`** is uniquely supported for OCDNet (forces FP16)
- FAN backbones auto-enable `sync_batchnorm`

## Hardware

Minimum 1 GPU(s), recommended 1 GPU(s). 8GB+ VRAM per GPU. OCDNet is lightweight. Single GPU is sufficient for most datasets.

## Error Patterns

**Low detection rate**: Tune postprocess.thresh and box_thresh. Default thresholds may be too aggressive for some datasets.

## Spec Param / Parent Model Inference

Model-specific inference mappings belong in this MD file, not in `config.json`. Generated runners should read this section and apply the mappings with SDK helpers before `create_job()`. This mirrors the old microservices `infer_params.py` flow.

Inference mappings from TAO Core `ocdnet.config.json`:

| Action | Spec Field | Inference Function | Meaning |
|---|---|---|---|
| evaluate | `evaluate.checkpoint` | `parent_model` | model file inferred from the parent job results folder |
| evaluate | `evaluate.trt_engine` | `parent_model` | model file inferred from the parent job results folder |
| evaluate | `model.pruned_graph_path` | `pruned_model` | parent pruned model |
| evaluate | `results_dir` | `output_dir` | current job results directory |
| export | `export.checkpoint` | `parent_model` | model file inferred from the parent job results folder |
| export | `export.onnx_file` | `create_onnx_file` | output ONNX path |
| export | `results_dir` | `output_dir` | current job results directory |
| gen_trt_engine | `gen_trt_engine.onnx_file` | `parent_model` | model file inferred from the parent job results folder |
| gen_trt_engine | `gen_trt_engine.tensorrt.calibration.cal_cache_file` | `create_cal_cache` | calibration cache path |
| gen_trt_engine | `gen_trt_engine.trt_engine` | `create_engine_file` | output TensorRT engine path |
| gen_trt_engine | `results_dir` | `output_dir` | current job results directory |
| inference | `inference.checkpoint` | `parent_model` | model file inferred from the parent job results folder |
| inference | `inference.trt_engine` | `parent_model` | model file inferred from the parent job results folder |
| inference | `model.pruned_graph_path` | `pruned_model` | parent pruned model |
| inference | `results_dir` | `output_dir` | current job results directory |
| prune | `prune.checkpoint` | `parent_model` | model file inferred from the parent job results folder |
| prune | `results_dir` | `output_dir` | current job results directory |
| quantize | `quantize.model_path` | `parent_model` | model file inferred from the parent job results folder |
| quantize | `results_dir` | `output_dir` | current job results directory |
| retrain | `model.pruned_graph_path` | `parent_model` | model file inferred from the parent job results folder |
| retrain | `results_dir` | `output_dir` | current job results directory |
| train | `model.pretrained_model_path` | `ptm_if_no_resume_model` | PTM when no resume checkpoint exists |
| train | `results_dir` | `output_dir` | current job results directory |
| train | `train.resume_training_checkpoint_path` | `resume_model` | model file inferred from the current job results folder |

For `parent_model` or `parent_model_folder`, pass the upstream train/export/AutoML child job id as `parent_job_id`. The SDK lists the parent result folder, filters checkpoint artifacts, and returns the selected model file or folder. Do not add these mappings back to `config.json` and do not patch generated runner scripts to guess checkpoint paths.

## Deployment

- [tao-deploy-ocdnet](references/tao-deploy-ocdnet.md) — OCDNet deploy workflow for TensorRT engine generation, TensorRT evaluation, and TensorRT inference using TAO Deploy.
