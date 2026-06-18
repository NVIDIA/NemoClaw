---
name: tao-train-nvpanoptix3d
description: NVPanoptix3D for panoptic 3D scene reconstruction from posed RGB images. Produces 3D panoptic segmentation
  (semantic, instance, and panoptic masks) with occupancy completion. Built on a VGGT backbone with a Mask2Former-style head
  and 3D frustum reconstruction. Use when training, evaluating, exporting, or running inference for a TAO NVPanoptix3D model.
  Trigger phrases include "train NVPanoptix3D", "panoptic 3D reconstruction", "3D scene segmentation", "occupancy completion".
license: Apache-2.0
compatibility: Requires docker + nvidia-container-toolkit.
metadata:
  version: "0.1.0"
  author: NVIDIA Corporation
allowed-tools: Read Bash
tags:
- panoptic
- 3d
- reconstruction
---

# NVPanoptix3D

NVPanoptix3D for panoptic 3D scene reconstruction from posed RGB images. Produces 3D panoptic segmentation (semantic, instance, and panoptic masks) with occupancy completion. Built on VGGT backbone with Mask2Former-style head and 3D frustum reconstruction.

Uses 2D and 3D stage checkpoints. Set train.checkpoint_2d and train.checkpoint_3d for staged initialization.

## Dataclass Schemas

Generated TAO Core schemas are packaged in `schemas/<action>.schema.json`, with `schemas/manifest.json` listing available actions. Each generated schema also emits `references/spec_template_<action>.yaml` from the schema top-level `default` field. AutoML enablement is declared at the model layer in `references/skill_info.yaml` via `automl_enabled`. Runnable AutoML still requires `schemas/train.schema.json` and `references/spec_template_train.yaml` to exist and parse. Use the packaged train schema for `automl_default_parameters`, `automl_disabled_parameters`, defaults, min/max bounds, enums, option weights, math conditions, dependencies, and popular parameters. Do not expect `~/tao-core` at runtime; maintainers regenerate schemas/templates before packaging the skill bank.

## Train Action Policy

This model is AutoML-enabled at the model layer. Before handling any train-stage request, read `references/skill_info.yaml` and resolve the run override from either an explicit `automl_policy` value or the user's workflow request. Treat phrases like "turn off AutoML", "disable AutoML", "no HPO", or "plain training" as `automl_policy: off` for this run only; otherwise default to `auto`. When `automl_policy: auto`, `automl_enabled: true`, and both `schemas/train.schema.json` and `references/spec_template_train.yaml` are packaged, route the train action through `tao-skill-bank:tao-run-automl` by default with this model's `skill_dir`. Preserve workflow/application overrides for datasets, specs, output directories, GPU/platform settings, parent checkpoints, and `automl_policy`. Use direct model training only when `automl_policy: off` or the packaged train schema/template is missing; in the missing-schema case, report that AutoML is enabled but not runnable for this model until schemas are generated.

Non-train actions such as `evaluate`, `inference`, `export`, and deploy flows stay in this model skill. The per-run `automl_policy` override does not change model metadata.

## Training Requirements

- **Dataset type:** nvpanoptix3d
- **Formats:** front3d, matterport
- **Monitoring metric:** kpi

### Per-Action Dataset Requirements

| Action | Spec Key | Source | Files | List? |
|---|---|---|---|---|
| evaluate | dataset.frustum_mask_path | eval_dataset | meta/frustum_mask.npz | No |
| evaluate | dataset.label_map | eval_dataset | meta/colormap.json | No |
| evaluate | dataset.val.json_path | eval_dataset | meta/val.json | No |
| evaluate | dataset.val.base_dir | eval_dataset |  | No |
| evaluate | dataset.test.json_path | inference_dataset | meta/test.json | No |
| evaluate | dataset.test.base_dir | inference_dataset |  | No |
| inference | dataset.frustum_mask_path | inference_dataset | meta/frustum_mask.npz | No |
| inference | dataset.label_map | inference_dataset | meta/colormap.json | No |
| inference | inference.images_dir | inference_dataset | images.tar.gz | No |
| train | dataset.frustum_mask_path | train_datasets | meta/frustum_mask.npz | No |
| train | dataset.label_map | train_datasets | meta/colormap.json | No |
| train | dataset.train.json_path | train_datasets | meta/train.json | No |
| train | dataset.train.base_dir | train_datasets |  | No |
| train | dataset.val.json_path | eval_dataset | meta/val.json | No |
| train | dataset.val.base_dir | eval_dataset |  | No |
| train | dataset.test.json_path | inference_dataset | meta/test.json | No |
| train | dataset.test.base_dir | inference_dataset |  | No |

### Typical Spec Overrides

Data source overrides are **mandatory for every action** — the agent MUST construct data source paths from the Per-Action Dataset Requirements table above and include them in `spec_overrides`.

```python
S3_TRAIN = "s3://bucket/data/train"
S3_EVAL = "s3://bucket/data/eval"
```

**train (mandatory data sources):**
```python
{
    "train.num_epochs": 10,
    "train.checkpoint_interval": 10,
    "train.validation_interval": 10,
    "train.num_gpus": 1,
    "dataset.enable_3d": True,
    "model.sem_seg_head.num_classes": 13,
    "dataset.frustum_mask_path": f"{S3_TRAIN}/meta/frustum_mask.npz",
    "dataset.label_map": f"{S3_TRAIN}/meta/colormap.json",
    "dataset.train.json_path": f"{S3_TRAIN}/meta/train.json",
    "dataset.train.base_dir": f"{S3_TRAIN}",
    "dataset.val.json_path": f"{S3_EVAL}/meta/val.json",
    "dataset.val.base_dir": f"{S3_EVAL}",
    "dataset.test.json_path": f"{S3_EVAL}/meta/test.json",
    "dataset.test.base_dir": f"{S3_EVAL}",
}
```

**evaluate (mandatory data sources):**
```python
{
    "dataset.enable_3d": True,
    "dataset.frustum_mask_path": f"{S3_EVAL}/meta/frustum_mask.npz",
    "dataset.label_map": f"{S3_EVAL}/meta/colormap.json",
    "dataset.val.json_path": f"{S3_EVAL}/meta/val.json",
    "dataset.val.base_dir": f"{S3_EVAL}",
    "dataset.test.json_path": f"{S3_EVAL}/meta/test.json",
    "dataset.test.base_dir": f"{S3_EVAL}",
}
```

**inference (mandatory data sources):**
```python
{
    "dataset.enable_3d": True,
    "dataset.frustum_mask_path": f"{S3_EVAL}/meta/frustum_mask.npz",
    "dataset.label_map": f"{S3_EVAL}/meta/colormap.json",
    "inference.images_dir": f"{S3_EVAL}/images.tar.gz",
}
```
## Eval Dataset

Optional. Val/test splits configured via dataset.val and dataset.test paths.

## Important Parameters

- **model.sem_seg_head.num_classes**: Number of semantic classes. Default 13.
- **model.mode**: Prediction mode. Options: panoptic, instance, semantic. Default panoptic.
- **model.backbone_type**: Backbone. Default vggt (only option in schema).
- **model.mask_former.num_object_queries**: Object queries. Default 100.
- **model.mask_former.dec_layers**: Decoder layers. Default 10.
- **model.frustum3d.truncation**: 3D frustum truncation. Default 3.
- **model.frustum3d.panoptic_weight**: Panoptic loss weight. Default 25.
- **model.frustum3d.completion_weights**: Completion loss weights. Default [50, 25, 10].
- **dataset.name**: Dataset name. Options: front3d, matterport, synthetic_hospital, synthetic_warehouse.
- **dataset.downsample_factor**: Image downsample factor. Default 1 (Front3D), 2 (Matterport).
- **dataset.target_size**: Target image size. Default [320, 240].
- **dataset.depth_min**: Min depth. Default 0.4 meters.
- **dataset.depth_max**: Max depth. Default 6.0 meters.
- **train.lr**: Learning rate. Default 2e-4. backbone_multiplier=0.1.
- **train.lr_scheduler**: Options: MultiStep, Warmuppoly. Milestones [88, 96].
- **train.precision**: Options: fp16, fp32. Default fp16.
- **train.distributed_strategy**: Options: ddp, fsdp. activation_checkpoint=True by default.
- **train.clip_grad_norm**: Gradient clipping norm. Default 0.1.
- **export.onnx_file_2d**: ONNX path for 2D model component.
- **export.onnx_file_3d**: ONNX path for 3D model component.
- **export.max_voxels**: Max voxels for engine input. Default 700000.
- **inference.mode**: Options: semantic, instance, panoptic.

## Multi-GPU / Multi-Node

**Launch method:** Lightning-managed (single `python` process, Lightning spawns workers).

| Spec Key | Description | Default |
|----------|-------------|---------|
| `train.num_gpus` | Number of GPUs | 1 |
| `train.gpu_ids` | GPU device indices | [0] |
| `train.num_nodes` | Number of nodes | 1 |
| `train.distributed_strategy` | `ddp` only | `ddp` |

- **`fsdp` is NOT supported** for NVPanoptix3D (code only handles `ddp`)
- `ddp` with activation checkpointing (enabled by default): `find_unused_parameters=False`
- `ddp` without: `find_unused_parameters=True`
- FAN backbones with 3D enabled auto-enable `sync_batchnorm`

**Multi-node env vars** (set by orchestrator): `WORLD_SIZE`, `NODE_RANK`, `MASTER_ADDR`, `MASTER_PORT`, `NUM_GPU_PER_NODE`.

## Export / TRT Defaults

- Exports separate 2D and 3D ONNX models (onnx_file_2d, onnx_file_3d)
- TRT data types: FP32, FP16 only
- max_voxels: 700000 (engine input tensor limit)

## Hardware

Minimum 2 GPU(s), recommended 4 GPU(s). 40GB+ (A100 recommended) VRAM per GPU. 3D reconstruction is very memory intensive. fp16 recommended. activation_checkpoint enabled by default. FSDP for multi-node. AutoML is enabled at the model layer; preserve this GPU/VRAM guidance when routing train through AutoML.

## Error Patterns

**Missing frustum mask**: Ensure meta/frustum_mask.npz is present in the dataset directory.

**Downsample factor mismatch**: Use downsample_factor=2 for Matterport3D, 1 for Front3D / synthetic datasets.

**3D occupancy OOM**: Reduce frustum_dims or grid_dimensions if running out of GPU memory during 3D reconstruction.

## Spec Param / Parent Model Inference

Model-specific inference mappings belong in this MD file, not in `config.json`. Generated runners should read this section and apply the mappings with SDK helpers before `create_job()`. This mirrors the old microservices `infer_params.py` flow.

Inference mappings from TAO Core `nvpanoptix3d.config.json`:

| Action | Spec Field | Inference Function | Meaning |
|---|---|---|---|
| evaluate | `encryption_key` | `key` | encryption key |
| evaluate | `evaluate.checkpoint` | `parent_model` | model file inferred from the parent job results folder |
| evaluate | `results_dir` | `output_dir` | current job results directory |
| export | `encryption_key` | `key` | encryption key |
| export | `export.checkpoint` | `parent_model` | model file inferred from the parent job results folder |
| export | `export.onnx_file_2d` | `create_onnx_file_2d` | create_onnx_file_2d |
| export | `export.onnx_file_3d` | `create_onnx_file_3d` | create_onnx_file_3d |
| export | `results_dir` | `output_dir` | current job results directory |
| inference | `encryption_key` | `key` | encryption key |
| inference | `inference.checkpoint` | `parent_model` | model file inferred from the parent job results folder |
| inference | `results_dir` | `output_dir` | current job results directory |
| train | `encryption_key` | `key` | encryption key |
| train | `results_dir` | `output_dir` | current job results directory |
| train | `train.checkpoint_2d` | `parent_model_or_ptm` | parent model if available, otherwise PTM |
| train | `train.checkpoint_3d` | `ptm` | pretrained model |
| train | `train.resume_training_checkpoint_path` | `resume_model` | model file inferred from the current job results folder |

For `parent_model` or `parent_model_folder`, pass the upstream train/export/AutoML child job id as `parent_job_id`. The SDK lists the parent result folder, filters checkpoint artifacts, and returns the selected model file or folder. Do not add these mappings back to `config.json` and do not patch generated runner scripts to guess checkpoint paths.
