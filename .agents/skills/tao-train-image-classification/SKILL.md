---
name: tao-train-image-classification
description: PyTorch-based TAO image classification. Supports a wide range of backbones (FAN, EfficientNet, ResNet, etc.)
  with distillation and quantization for deployment. Use when training, evaluating, distilling, quantizing, exporting, or
  running inference for a TAO image-classification (PyT) model. Trigger phrases include "train image classifier",
  "TAO classification", "ResNet/EfficientNet/FAN backbone classifier", "classification-pyt".
license: Apache-2.0
compatibility: Requires docker + nvidia-container-toolkit.
metadata:
  version: "0.1.0"
  author: NVIDIA Corporation
allowed-tools: Read Bash
tags:
- image
- classification
---

# Classification PyT

PyTorch image classification. Supports a wide range of backbones (FAN, EfficientNet, ResNet, etc.) with distillation and quantization for deployment.

Set model.backbone.pretrained_backbone_path for backbone weights or train.pretrained_model_path for full model.

For TAO Deploy TensorRT actions (`gen_trt_engine`, TensorRT `evaluate`, and TensorRT `inference`), read `references/tao-deploy-image-classification.md` first. Deploy spec templates live in this skill's `references/` folder with the `spec_template_deploy_*.yaml` prefix.

## Dataclass Schemas

Generated TAO Core schemas are packaged in `schemas/<action>.schema.json`, with `schemas/manifest.json` listing available actions. Each generated schema also emits `references/spec_template_<action>.yaml` from the schema top-level `default` field. AutoML enablement is declared at the model layer in `references/skill_info.yaml` via `automl_enabled`. Runnable AutoML still requires `schemas/train.schema.json` and `references/spec_template_train.yaml` to exist and parse. Use the packaged train schema for `automl_default_parameters`, `automl_disabled_parameters`, defaults, min/max bounds, enums, option weights, math conditions, dependencies, and popular parameters. Do not expect `~/tao-core` at runtime; maintainers regenerate schemas/templates before packaging the skill bank.

## Train Action Policy

This model is AutoML-enabled at the model layer. Before handling any train-stage request, read `references/skill_info.yaml` and resolve the run override from either an explicit `automl_policy` value or the user's workflow request. Treat phrases like "turn off AutoML", "disable AutoML", "no HPO", or "plain training" as `automl_policy: off` for this run only; otherwise default to `auto`. When `automl_policy: auto`, `automl_enabled: true`, and both `schemas/train.schema.json` and `references/spec_template_train.yaml` are packaged, route the train action through `tao-skill-bank:tao-run-automl` by default with this model's `skill_dir`. Preserve workflow/application overrides for datasets, specs, output directories, GPU/platform settings, parent checkpoints, and `automl_policy`. Use direct model training only when `automl_policy: off` or the packaged train schema/template is missing; in the missing-schema case, report that AutoML is enabled but not runnable for this model until schemas are generated.

Non-train actions such as `evaluate`, `inference`, `export`, and deploy flows stay in this model skill. The per-run `automl_policy` override does not change model metadata.

## Training Requirements

- **Dataset type:** image_classification
- **Formats:** classification_pyt
- **Monitoring metric:** val_acc_1

### Per-Action Dataset Requirements

| Action | Spec Key | Source | Files | List? |
|---|---|---|---|---|
| distill | dataset.train_dataset.images_dir | train_datasets | images_train.tar.gz | No |
| distill | dataset.classes_file | train_datasets | classes.txt | No |
| distill | dataset.val_dataset.images_dir | eval_dataset | images_val.tar.gz | No |
| evaluate | dataset.val_dataset.images_dir | eval_dataset | images_val.tar.gz | No |
| evaluate | dataset.classes_file | eval_dataset | classes.txt | No |
| evaluate | dataset.test_dataset.images_dir | inference_dataset | images_test.tar.gz | No |
| export | dataset.root_dir | train_datasets |  | No |
| inference | dataset.val_dataset.images_dir | eval_dataset | images_val.tar.gz | No |
| inference | dataset.classes_file | eval_dataset | classes.txt | No |
| inference | dataset.test_dataset.images_dir | inference_dataset | images_test.tar.gz | No |
| quantize | dataset.train_dataset.images_dir | train_datasets | images_train.tar.gz | No |
| quantize | dataset.classes_file | train_datasets | classes.txt | No |
| quantize | dataset.val_dataset.images_dir | eval_dataset | images_val.tar.gz | No |
| quantize | dataset.quant_calibration_dataset.images_dir | calibration_dataset | images_train.tar.gz | No |
| train | dataset.train_dataset.images_dir | train_datasets | images_train.tar.gz | No |
| train | dataset.classes_file | train_datasets | classes.txt | No |
| train | dataset.val_dataset.images_dir | eval_dataset | images_val.tar.gz | No |

### Typical Spec Overrides

Data source overrides are **mandatory for every action** — the agent MUST construct data source paths from the Per-Action Dataset Requirements table above and include them in `spec_overrides`.

```python
S3_TRAIN = "s3://bucket/data/train"
S3_EVAL = "s3://bucket/data/eval"
```

**train (mandatory data sources):**
```python
{
    "train.num_epochs": 2,
    "train.validation_interval": 2,
    "train.checkpoint_interval": 2,
    "train.num_gpus": 1,
    "dataset.train_dataset.images_dir": f"{S3_TRAIN}/images_train.tar.gz",
    "dataset.classes_file": f"{S3_TRAIN}/classes.txt",
    "dataset.val_dataset.images_dir": f"{S3_EVAL}/images_val.tar.gz",
}
```

**export (mandatory data sources):**
```python
{
    "export.input_height": 224,
    "export.input_width": 224,
    "dataset.root_dir": f"{S3_TRAIN}",
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
    "dataset.batch_size": 1,
    "dataset.val_dataset.images_dir": f"{S3_EVAL}/images_val.tar.gz",
    "dataset.classes_file": f"{S3_EVAL}/classes.txt",
    "dataset.test_dataset.images_dir": f"{S3_EVAL}/images_test.tar.gz",
}
```

**distill (mandatory data sources):**
```python
{
    "dataset.train_dataset.images_dir": f"{S3_TRAIN}/images_train.tar.gz",
    "dataset.classes_file": f"{S3_TRAIN}/classes.txt",
    "dataset.val_dataset.images_dir": f"{S3_EVAL}/images_val.tar.gz",
}
```

**evaluate (mandatory data sources):**
```python
{
    "dataset.val_dataset.images_dir": f"{S3_EVAL}/images_val.tar.gz",
    "dataset.classes_file": f"{S3_EVAL}/classes.txt",
    "dataset.test_dataset.images_dir": f"{S3_EVAL}/images_test.tar.gz",
}
```

**quantize (mandatory data sources):**
```python
{
    "dataset.train_dataset.images_dir": f"{S3_TRAIN}/images_train.tar.gz",
    "dataset.classes_file": f"{S3_TRAIN}/classes.txt",
    "dataset.val_dataset.images_dir": f"{S3_EVAL}/images_val.tar.gz",
    "dataset.quant_calibration_dataset.images_dir": f"{S3_TRAIN}/images_train.tar.gz",
}
```
## Eval Dataset

Optional. Validation images are provided as a separate tar alongside training images.

## Important Parameters

- **dataset.num_classes**: Number of classes. Default 20. Must match the number of subdirectories in your image tarballs.
- **model.backbone.type**: Default fan_small_12_p4_hybrid. Supported backbones and their head in_channels (from model_params_mapping.py): FAN: fan_tiny, fan_small_12_p4_hybrid, fan_base_16_p4_hybrid, fan_large_16_p4_hybrid. GCViT: gcvit_tiny through gcvit_large. FasterViT: fastervit_0 through fastervit_6. ViT/EVA/DINO: vit_large_patch14_dinov2, eva02_large_patch14, etc. SigLIP-CLIPA: ViT-H-14-SigLIP-CLIPA-224, etc. Some backbones require non-default input resolution (384, 512, 768).
- **dataset.classes_file**: Path to classes.txt listing class names.
- **train.optim.lr**: Learning rate. Default 6e-5.
- **dataset.img_size**: Input image size. Default 224.
- **dataset.batch_size**: Per-GPU batch size. Default 8.

## Multi-GPU / Multi-Node

**Launch method:** Lightning-managed (single `python` process, Lightning spawns workers).

| Spec Key | Description | Default |
|----------|-------------|---------|
| `train.num_gpus` | Number of GPUs | 1 |
| `train.gpu_ids` | GPU device indices | [0] |
| `train.num_nodes` | Number of nodes | 1 |

- Multi-GPU strategy: `ddp_find_unused_parameters_true`
- No fsdp support

**Multi-node env vars** (set by orchestrator): `WORLD_SIZE`, `NODE_RANK`, `MASTER_ADDR`, `MASTER_PORT`, `NUM_GPU_PER_NODE`.

## Hardware

Minimum 1 GPU(s), recommended 2 GPU(s). 16GB+ (V100 or A100) VRAM per GPU. Classification is generally lightweight. Most backbones at 224x224 fit well on 16GB GPUs with batch_size=8.

## Error Patterns

**CUDA out of memory**: Reduce batch_size or use a smaller backbone.

**num_classes mismatch**: Ensure dataset.num_classes matches the actual class directories in your image tarballs and classes.txt.

**Empty class directory**: Every class in classes.txt must have at least one image in the corresponding subdirectory.

## Spec Param / Parent Model Inference

Model-specific inference mappings belong in this MD file, not in `config.json`. Generated runners should read this section and apply the mappings with SDK helpers before `create_job()`. This mirrors the old microservices `infer_params.py` flow.

Inference mappings from TAO Core `classification_pyt.config.json`:

| Action | Spec Field | Inference Function | Meaning |
|---|---|---|---|
| distill | `distill.pretrained_teacher_model_path` | `parent_model` | model file inferred from the parent job results folder |
| distill | `results_dir` | `output_dir` | current job results directory |
| evaluate | `evaluate.checkpoint` | `parent_model` | model file inferred from the parent job results folder |
| evaluate | `results_dir` | `output_dir` | current job results directory |
| export | `export.checkpoint` | `parent_model` | model file inferred from the parent job results folder |
| export | `export.onnx_file` | `create_onnx_file` | output ONNX path |
| export | `results_dir` | `output_dir` | current job results directory |
| gen_trt_engine | `gen_trt_engine.onnx_file` | `parent_model` | model file inferred from the parent job results folder |
| gen_trt_engine | `gen_trt_engine.trt_engine` | `create_engine_file` | output TensorRT engine path |
| gen_trt_engine | `results_dir` | `output_dir` | current job results directory |
| inference | `inference.checkpoint` | `parent_model` | model file inferred from the parent job results folder |
| inference | `inference.trt_engine` | `parent_model` | model file inferred from the parent job results folder |
| inference | `results_dir` | `output_dir` | current job results directory |
| quantize | `quantize.model_path` | `parent_model` | model file inferred from the parent job results folder |
| quantize | `results_dir` | `output_dir` | current job results directory |
| train | `model.backbone.pretrained_backbone_path` | `ptm_if_no_resume_model` | PTM when no resume checkpoint exists |
| train | `results_dir` | `output_dir` | current job results directory |
| train | `train.pretrained_model_path` | `ptm_if_no_resume_model` | PTM when no resume checkpoint exists |
| train | `train.resume_training_checkpoint_path` | `resume_model` | model file inferred from the current job results folder |

For `parent_model` or `parent_model_folder`, pass the upstream train/export/AutoML child job id as `parent_job_id`. The SDK lists the parent result folder, filters checkpoint artifacts, and returns the selected model file or folder. Do not add these mappings back to `config.json` and do not patch generated runner scripts to guess checkpoint paths.

## Deployment

- [tao-deploy-image-classification](references/tao-deploy-image-classification.md) — Classification PyT deploy workflow for TensorRT engine generation, TensorRT evaluation, and TensorRT inference using TAO Deploy.
