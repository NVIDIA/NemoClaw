---
name: tao-train-mask2former
description: Mask2Former for universal image segmentation (panoptic, instance, and semantic). Transformer-based with
  masked attention for high-quality segmentation results. Use when training, evaluating, exporting, quantizing, or running
  inference for a TAO Mask2Former model. Trigger phrases include "train Mask2Former", "universal segmentation",
  "panoptic / instance / semantic segmentation", "masked-attention transformer segmenter".
license: Apache-2.0
compatibility: Requires docker + nvidia-container-toolkit.
metadata:
  version: "0.1.0"
  author: NVIDIA Corporation
allowed-tools: Read Bash
tags:
- segmentation
---

# Mask2Former

Mask2Former for universal image segmentation (panoptic, instance, and semantic). Transformer-based with masked attention for high-quality segmentation results.

Set model.backbone.pretrained_weights for Swin backbone weights.

For TAO Deploy TensorRT actions (`gen_trt_engine`, TensorRT `evaluate`, and TensorRT `inference`), read `references/tao-deploy-mask2former.md` first. Deploy spec templates live in this skill's `references/` folder with the `spec_template_deploy_*.yaml` prefix.

## Dataclass Schemas

Generated TAO Core schemas are packaged in `schemas/<action>.schema.json`, with `schemas/manifest.json` listing available actions. Each generated schema also emits `references/spec_template_<action>.yaml` from the schema top-level `default` field. AutoML enablement is declared at the model layer in `references/skill_info.yaml` via `automl_enabled`. Runnable AutoML still requires `schemas/train.schema.json` and `references/spec_template_train.yaml` to exist and parse. Use the packaged train schema for `automl_default_parameters`, `automl_disabled_parameters`, defaults, min/max bounds, enums, option weights, math conditions, dependencies, and popular parameters. Do not expect `~/tao-core` at runtime; maintainers regenerate schemas/templates before packaging the skill bank.

## Train Action Policy

This model is AutoML-enabled at the model layer. Before handling any train-stage request, read `references/skill_info.yaml` and resolve the run override from either an explicit `automl_policy` value or the user's workflow request. Treat phrases like "turn off AutoML", "disable AutoML", "no HPO", or "plain training" as `automl_policy: off` for this run only; otherwise default to `auto`. When `automl_policy: auto`, `automl_enabled: true`, and both `schemas/train.schema.json` and `references/spec_template_train.yaml` are packaged, route the train action through `tao-skill-bank:tao-run-automl` by default with this model's `skill_dir`. Preserve workflow/application overrides for datasets, specs, output directories, GPU/platform settings, parent checkpoints, and `automl_policy`. Use direct model training only when `automl_policy: off` or the packaged train schema/template is missing; in the missing-schema case, report that AutoML is enabled but not runnable for this model until schemas are generated.

Non-train actions such as `evaluate`, `inference`, `export`, and deploy flows stay in this model skill. The per-run `automl_policy` override does not change model metadata.

## Training Requirements

- **Dataset type:** segmentation
- **Formats:** coco_panoptic, coco
- **Monitoring metric:** mIoU

### Per-Action Dataset Requirements

| Action | Spec Key | Source | Files | List? |
|---|---|---|---|---|
| evaluate | dataset.train.img_dir | train_datasets | images.tar.gz | No |
| evaluate | dataset.label_map | train_datasets | coco_panoptic: label_map_panoptic.json; *: label_map.json | No |
| evaluate | dataset.train.instance_json | train_datasets | annotations.json | No |
| evaluate | dataset.train.panoptic_json | train_datasets | annotations_panoptic.json | No |
| evaluate | dataset.train.panoptic_dir | train_datasets | images_panoptic.tar.gz | No |
| evaluate | dataset.val.img_dir | eval_dataset | images.tar.gz | No |
| evaluate | dataset.val.instance_json | eval_dataset | annotations.json | No |
| evaluate | dataset.val.panoptic_json | eval_dataset | annotations_panoptic.json | No |
| evaluate | dataset.val.panoptic_dir | eval_dataset | images_panoptic.tar.gz | No |
| evaluate | dataset.test.img_dir | eval_dataset | images.tar.gz | No |
| inference | dataset.train.img_dir | train_datasets | images.tar.gz | No |
| inference | dataset.label_map | train_datasets | coco_panoptic: label_map_panoptic.json; *: label_map.json | No |
| inference | dataset.train.instance_json | train_datasets | annotations.json | No |
| inference | dataset.train.panoptic_json | train_datasets | annotations_panoptic.json | No |
| inference | dataset.train.panoptic_dir | train_datasets | images_panoptic.tar.gz | No |
| inference | dataset.val.img_dir | eval_dataset | images.tar.gz | No |
| inference | dataset.val.instance_json | eval_dataset | annotations.json | No |
| inference | dataset.val.panoptic_json | eval_dataset | annotations_panoptic.json | No |
| inference | dataset.val.panoptic_dir | eval_dataset | images_panoptic.tar.gz | No |
| inference | dataset.test.img_dir | eval_dataset | images.tar.gz | No |
| quantize | dataset.train.img_dir | train_datasets | images.tar.gz | No |
| quantize | dataset.label_map | train_datasets | coco_panoptic: label_map_panoptic.json; *: label_map.json | No |
| quantize | dataset.train.instance_json | train_datasets | annotations.json | No |
| quantize | dataset.train.panoptic_json | train_datasets | annotations_panoptic.json | No |
| quantize | dataset.train.panoptic_dir | train_datasets | images_panoptic.tar.gz | No |
| quantize | dataset.val.img_dir | eval_dataset | images.tar.gz | No |
| quantize | dataset.val.instance_json | eval_dataset | annotations.json | No |
| quantize | dataset.val.panoptic_json | eval_dataset | annotations_panoptic.json | No |
| quantize | dataset.val.panoptic_dir | eval_dataset | images_panoptic.tar.gz | No |
| quantize | dataset.test.img_dir | eval_dataset | images.tar.gz | No |
| quantize | dataset.quant_calibration_dataset.images_dir | train_datasets | images.tar.gz | No |
| train | dataset.train.img_dir | train_datasets | images.tar.gz | No |
| train | dataset.label_map | train_datasets | coco_panoptic: label_map_panoptic.json; *: label_map.json | No |
| train | dataset.train.instance_json | train_datasets | annotations.json | No |
| train | dataset.train.panoptic_json | train_datasets | annotations_panoptic.json | No |
| train | dataset.train.panoptic_dir | train_datasets | images_panoptic.tar.gz | No |
| train | dataset.val.img_dir | eval_dataset | images.tar.gz | No |
| train | dataset.val.instance_json | eval_dataset | annotations.json | No |
| train | dataset.val.panoptic_json | eval_dataset | annotations_panoptic.json | No |
| train | dataset.val.panoptic_dir | eval_dataset | images_panoptic.tar.gz | No |
| train | dataset.test.img_dir | eval_dataset | images.tar.gz | No |

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
    "model.sem_seg_head.num_classes": 90,
    "dataset.contiguous_id": True,
    "dataset.train.img_dir": f"{S3_TRAIN}/images.tar.gz",
    "dataset.label_map": {"coco_panoptic": f"{S3_TRAIN}/label_map_panoptic.json; *: label_map.json"},
    "dataset.train.instance_json": f"{S3_TRAIN}/annotations.json",
    "dataset.train.panoptic_json": f"{S3_TRAIN}/annotations_panoptic.json",
    "dataset.train.panoptic_dir": f"{S3_TRAIN}/images_panoptic.tar.gz",
    "dataset.val.img_dir": f"{S3_EVAL}/images.tar.gz",
    "dataset.val.instance_json": f"{S3_EVAL}/annotations.json",
    "dataset.val.panoptic_json": f"{S3_EVAL}/annotations_panoptic.json",
    "dataset.val.panoptic_dir": f"{S3_EVAL}/images_panoptic.tar.gz",
    "dataset.test.img_dir": f"{S3_EVAL}/images.tar.gz",
}
```

**evaluate (mandatory data sources):**
```python
{
    "model.sem_seg_head.num_classes": 90,
    "dataset.contiguous_id": True,
    "dataset.train.img_dir": f"{S3_TRAIN}/images.tar.gz",
    "dataset.label_map": {"coco_panoptic": f"{S3_TRAIN}/label_map_panoptic.json; *: label_map.json"},
    "dataset.train.instance_json": f"{S3_TRAIN}/annotations.json",
    "dataset.train.panoptic_json": f"{S3_TRAIN}/annotations_panoptic.json",
    "dataset.train.panoptic_dir": f"{S3_TRAIN}/images_panoptic.tar.gz",
    "dataset.val.img_dir": f"{S3_EVAL}/images.tar.gz",
    "dataset.val.instance_json": f"{S3_EVAL}/annotations.json",
    "dataset.val.panoptic_json": f"{S3_EVAL}/annotations_panoptic.json",
    "dataset.val.panoptic_dir": f"{S3_EVAL}/images_panoptic.tar.gz",
    "dataset.test.img_dir": f"{S3_EVAL}/images.tar.gz",
}
```

**export:**
```python
{
    "model.sem_seg_head.num_classes": 90,
}
```

**inference (mandatory data sources):**
```python
{
    "model.sem_seg_head.num_classes": 90,
    "dataset.contiguous_id": True,
    "dataset.train.img_dir": f"{S3_TRAIN}/images.tar.gz",
    "dataset.label_map": {"coco_panoptic": f"{S3_TRAIN}/label_map_panoptic.json; *: label_map.json"},
    "dataset.train.instance_json": f"{S3_TRAIN}/annotations.json",
    "dataset.train.panoptic_json": f"{S3_TRAIN}/annotations_panoptic.json",
    "dataset.train.panoptic_dir": f"{S3_TRAIN}/images_panoptic.tar.gz",
    "dataset.val.img_dir": f"{S3_EVAL}/images.tar.gz",
    "dataset.val.instance_json": f"{S3_EVAL}/annotations.json",
    "dataset.val.panoptic_json": f"{S3_EVAL}/annotations_panoptic.json",
    "dataset.val.panoptic_dir": f"{S3_EVAL}/images_panoptic.tar.gz",
    "dataset.test.img_dir": f"{S3_EVAL}/images.tar.gz",
}
```

**quantize (mandatory data sources):**
```python
{
    "dataset.train.img_dir": f"{S3_TRAIN}/images.tar.gz",
    "dataset.label_map": {"coco_panoptic": f"{S3_TRAIN}/label_map_panoptic.json; *: label_map.json"},
    "dataset.train.instance_json": f"{S3_TRAIN}/annotations.json",
    "dataset.train.panoptic_json": f"{S3_TRAIN}/annotations_panoptic.json",
    "dataset.train.panoptic_dir": f"{S3_TRAIN}/images_panoptic.tar.gz",
    "dataset.val.img_dir": f"{S3_EVAL}/images.tar.gz",
    "dataset.val.instance_json": f"{S3_EVAL}/annotations.json",
    "dataset.val.panoptic_json": f"{S3_EVAL}/annotations_panoptic.json",
    "dataset.val.panoptic_dir": f"{S3_EVAL}/images_panoptic.tar.gz",
    "dataset.test.img_dir": f"{S3_EVAL}/images.tar.gz",
    "dataset.quant_calibration_dataset.images_dir": f"{S3_TRAIN}/images.tar.gz",
}
```
## Eval Dataset

Optional. Val data sources are part of the dataset config alongside train.

## Important Parameters

- **model.sem_seg_head.num_classes**: Number of segmentation classes. Default 200. Must match your annotation categories.
- **model.backbone.swin.type**: Swin Transformer variant. Default tiny. Options include tiny, small, base, large.
- **model.mode**: Segmentation mode. Default panoptic. Options: panoptic, instance, semantic.
- **train.optim.lr**: Learning rate. Default 2e-4 (AdamW).
- **dataset.train.batch_size**: Per-GPU batch size. Default 1. Mask2Former is memory-intensive due to per-pixel predictions.

## Multi-GPU / Multi-Node

**Launch method:** Lightning-managed (single `python` process, Lightning spawns workers).

| Spec Key | Description | Default |
|----------|-------------|---------|
| `train.num_gpus` | Number of GPUs | 1 |
| `train.gpu_ids` | GPU device indices | [0] |
| `train.num_nodes` | Number of nodes | 1 |
| `train.distributed_strategy` | `ddp` or `fsdp` | `ddp` |

- Same DDP/FSDP behavior as DINO (activation checkpoint aware)
- FAN backbones auto-enable `sync_batchnorm`
- `fsdp` forces FP16

**Multi-node env vars** (set by orchestrator): `WORLD_SIZE`, `NODE_RANK`, `MASTER_ADDR`, `MASTER_PORT`, `NUM_GPU_PER_NODE`.

## Export / TRT Defaults

- TRT data types: FP32, FP16 only — **INT8 is NOT supported**

Full TAO Deploy reference: [tao-deploy-mask2former](references/tao-deploy-mask2former.md).

## Hardware

Minimum 1 GPU(s), recommended 4 GPU(s). 24GB+ (A100 recommended) VRAM per GPU. Mask2Former is memory-heavy. batch_size=1 is the default for good reason. Multi-GPU recommended for reasonable training speed.

## Error Patterns

**CUDA out of memory**: batch_size is already 1 by default. Reduce image resolution in augmentation config or use a smaller Swin variant.

**Panoptic vs instance format mismatch**: Ensure you provide the correct annotation format matching model.mode setting.

## Spec Param / Parent Model Inference

Model-specific inference mappings belong in this MD file, not in `config.json`. Generated runners should read this section and apply the mappings with SDK helpers before `create_job()`. This mirrors the old microservices `infer_params.py` flow.

Inference mappings from TAO Core `mask2former.config.json`:

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
| train | `model.backbone.pretrained_weights` | `{'link': 'https://github.com/SwinTransformer/storage/releases/download/v1.0.8/swin_tiny_patch4_window7_224_22k.pth', 'destination_path': '/ptm/mask2former/swin_tiny_patch4_window7_224_22k/swin_tiny_patch4_window7_224_22k.pth'}` | {'link': 'https://github.com/SwinTransformer/storage/releases/download/v1.0.8/swin_tiny_patch4_window7_224_22k.pth', 'destination_path': '/ptm/mask2former/swin_tiny_patch4_window7_224_22k/swin_tiny_patch4_window7_224_22k.pth'} |
| train | `results_dir` | `output_dir` | current job results directory |
| train | `train.resume_training_checkpoint_path` | `resume_model` | model file inferred from the current job results folder |

For `parent_model` or `parent_model_folder`, pass the upstream train/export/AutoML child job id as `parent_job_id`. The SDK lists the parent result folder, filters checkpoint artifacts, and returns the selected model file or folder. Do not add these mappings back to `config.json` and do not patch generated runner scripts to guess checkpoint paths.
