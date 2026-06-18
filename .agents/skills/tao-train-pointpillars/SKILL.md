---
name: tao-train-pointpillars
description: PointPillars for 3D object detection from LiDAR point clouds. Encodes point clouds into a pseudo-image via a
  pillar-based representation, then applies 2D detection — used in autonomous driving and robotics. Use when training,
  evaluating, exporting, pruning, retraining, or running inference for a TAO PointPillars model. Trigger phrases include
  "train PointPillars", "LiDAR 3D detection", "point-cloud object detection", "pillar-based 3D detector".
license: Apache-2.0
compatibility: Requires docker + nvidia-container-toolkit.
metadata:
  version: "0.1.0"
  author: NVIDIA Corporation
allowed-tools: Read Bash
tags:
- point
- cloud
- 3d
- detection
---

# PointPillars

PointPillars for 3D object detection from LiDAR point clouds. Encodes point clouds into a pseudo-image via pillar-based representation, then applies 2D detection. Used in autonomous driving / robotics.

Typically trained from scratch. Provide train.resume_training_checkpoint_path to resume.

For TAO Deploy TensorRT actions (`gen_trt_engine`, TensorRT `evaluate`, and TensorRT `inference`), read `references/tao-deploy-pointpillars.md` first. Deploy spec templates live in this skill's `references/` folder with the `spec_template_deploy_*.yaml` prefix.

## Dataclass Schemas

Generated TAO Core schemas are packaged in `schemas/<action>.schema.json`, with `schemas/manifest.json` listing available actions. Each generated schema also emits `references/spec_template_<action>.yaml` from the schema top-level `default` field. AutoML enablement is declared at the model layer in `references/skill_info.yaml` via `automl_enabled`. Runnable AutoML still requires `schemas/train.schema.json` and `references/spec_template_train.yaml` to exist and parse. Use the packaged train schema for `automl_default_parameters`, `automl_disabled_parameters`, defaults, min/max bounds, enums, option weights, math conditions, dependencies, and popular parameters. Do not expect `~/tao-core` at runtime; maintainers regenerate schemas/templates before packaging the skill bank.

## Train Action Policy

This model is AutoML-enabled at the model layer. Before handling any train-stage request, read `references/skill_info.yaml` and resolve the run override from either an explicit `automl_policy` value or the user's workflow request. Treat phrases like "turn off AutoML", "disable AutoML", "no HPO", or "plain training" as `automl_policy: off` for this run only; otherwise default to `auto`. When `automl_policy: auto`, `automl_enabled: true`, and both `schemas/train.schema.json` and `references/spec_template_train.yaml` are packaged, route the train action through `tao-skill-bank:tao-run-automl` by default with this model's `skill_dir`. Preserve workflow/application overrides for datasets, specs, output directories, GPU/platform settings, parent checkpoints, and `automl_policy`. Use direct model training only when `automl_policy: off` or the packaged train schema/template is missing; in the missing-schema case, report that AutoML is enabled but not runnable for this model until schemas are generated.

Non-train actions such as `evaluate`, `inference`, `export`, and deploy flows stay in this model skill. The per-run `automl_policy` override does not change model metadata.

## Training Requirements

- **Dataset type:** pointpillars
- **Formats:** default
- **Monitoring metric:** loss

### Per-Action Dataset Requirements

| Action | Spec Key | Source | Files | List? |
|---|---|---|---|---|
| dataset_convert | dataset.data_path | id |  | No |
| evaluate | dataset.data_path | train_datasets |  | No |
| evaluate | dataset.data_info_path | train_datasets | /results/{dataset_convert_job_id}/data_info/ | No |
| export | dataset.data_path | train_datasets |  | No |
| export | dataset.data_info_path | train_datasets | /results/{dataset_convert_job_id}/data_info/ | No |
| inference | dataset.data_path | train_datasets |  | No |
| inference | dataset.data_info_path | train_datasets | /results/{dataset_convert_job_id}/data_info/ | No |
| prune | dataset.data_path | train_datasets |  | No |
| prune | dataset.data_info_path | train_datasets | /results/{dataset_convert_job_id}/data_info/ | No |
| retrain | dataset.data_path | train_datasets |  | No |
| retrain | dataset.data_info_path | train_datasets | /results/{dataset_convert_job_id}/data_info/ | No |
| train | dataset.data_path | train_datasets |  | No |
| train | dataset.data_info_path | train_datasets | /results/{dataset_convert_job_id}/data_info/ | No |

### Typical Spec Overrides

Data source overrides are **mandatory for every action** — the agent MUST construct data source paths from the Per-Action Dataset Requirements table above and include them in `spec_overrides`.

```python
S3_TRAIN = "s3://bucket/data/train"
```

**train (mandatory data sources):**
```python
{
    "train.num_epochs": 30,
    "train.checkpoint_interval": 10,
    "train.validation_interval": 10,
    "train.num_gpus": 1,
    "dataset.data_path": f"{S3_TRAIN}",
    "dataset.data_info_path": f"{S3_TRAIN}//results/{dataset_convert_job_id}/data_info/",
}
```

**evaluate (mandatory data sources):**
```python
{
    "dataset.data_path": f"{S3_TRAIN}",
    "dataset.data_info_path": f"{S3_TRAIN}//results/{dataset_convert_job_id}/data_info/",
}
```

**export (mandatory data sources):**
```python
{
    "dataset.data_path": f"{S3_TRAIN}",
    "dataset.data_info_path": f"{S3_TRAIN}//results/{dataset_convert_job_id}/data_info/",
}
```

**inference (mandatory data sources):**
```python
{
    "dataset.data_path": f"{S3_TRAIN}",
    "dataset.data_info_path": f"{S3_TRAIN}//results/{dataset_convert_job_id}/data_info/",
}
```

**prune (mandatory data sources):**
```python
{
    "dataset.data_path": f"{S3_TRAIN}",
    "dataset.data_info_path": f"{S3_TRAIN}//results/{dataset_convert_job_id}/data_info/",
}
```

**retrain (mandatory data sources):**
```python
{
    "dataset.data_path": f"{S3_TRAIN}",
    "dataset.data_info_path": f"{S3_TRAIN}//results/{dataset_convert_job_id}/data_info/",
}
```
## Eval Dataset

Optional. Validation data (val.tar.gz) is separate from training. Used for mAP evaluation.

## Important Parameters

- **train.num_epochs**: Default 80 (much higher than other TAO models). PointPillars needs more epochs for convergence on 3D detection.
- **train.lr**: Learning rate. Default 0.003 (adam_onecycle scheduler).
- **dataset.class_names**: List of 3D object classes. Default 7 classes (KITTI-style). Modify to match your dataset.
- **dataset.data_path**: Path to point cloud data directory.
- **dataset.data_info_path**: Path to data info files from dataset_convert step.
- **dataset.point_cloud_range**: Spatial extent of the point cloud to consider. Must match your sensor configuration.
- **model.dense_head.anchor_generator_config**: Anchor configurations per class. Must be tuned for your object sizes and the point cloud range.

## Multi-GPU / Multi-Node

**Launch method:** `torchrun` (LIGHTNING_EXCLUDED_NETWORK). Uses PyTorch native `DistributedDataParallel` (NOT Lightning Trainer).

| Spec Key | Description | Default |
|----------|-------------|---------|
| `train.num_gpus` | Number of GPUs per node | 1 |
| `train.gpu_ids` | GPU device indices | [0] |
| `train.num_nodes` | Number of nodes | 1 |

- `CUDA_VISIBLE_DEVICES` is explicitly set from `TAO_VISIBLE_DEVICES`
- Uses `nn.parallel.DistributedDataParallel` directly (not Lightning strategy)
- `NODE_RANK` is copied to `RANK` if `RANK` is unset

**Multi-node env vars** (set by orchestrator):

| Variable | Purpose |
|----------|---------|
| `WORLD_SIZE` | Number of nodes |
| `NODE_RANK` | This node's rank |
| `MASTER_ADDR` | Rank-0 node IP |
| `MASTER_PORT` | Rank-0 port (default 29500) |
| `NUM_GPU_PER_NODE` | GPUs per node |

## Hardware

Minimum 1 GPU(s), recommended 4 GPU(s). 16GB+ (V100 or A100) VRAM per GPU. PointPillars is relatively efficient for 3D detection. The main bottleneck is data I/O for large point cloud datasets.

## Error Patterns

**dataset_convert required**: Training will fail if data_info_path is not populated from a prior dataset_convert job. Always run convert first.

**Point cloud range mismatch**: If point_cloud_range does not match the actual sensor data extent, detections will be poor or empty.

**Epoch numbering**: PointPillars checkpoint epoch numbers may be offset by 1 from status.json reported epochs.

## Spec Param / Parent Model Inference

Model-specific inference mappings belong in this MD file, not in `config.json`. Generated runners should read this section and apply the mappings with SDK helpers before `create_job()`. This mirrors the old microservices `infer_params.py` flow.

Inference mappings from TAO Core `pointpillars.config.json`:

| Action | Spec Field | Inference Function | Meaning |
|---|---|---|---|
| dataset_convert | `results_dir` | `output_dir` | current job results directory |
| evaluate | `evaluate.checkpoint` | `parent_model` | model file inferred from the parent job results folder |
| evaluate | `key` | `key` | encryption key |
| evaluate | `results_dir` | `output_dir` | current job results directory |
| export | `export.checkpoint` | `parent_model` | model file inferred from the parent job results folder |
| export | `export.onnx_file` | `create_onnx_file` | output ONNX path |
| export | `export.save_engine` | `create_engine_file` | output TensorRT engine path |
| export | `key` | `key` | encryption key |
| export | `results_dir` | `output_dir` | current job results directory |
| gen_trt_engine | `gen_trt_engine.onnx_file` | `parent_model` | model file inferred from the parent job results folder |
| gen_trt_engine | `gen_trt_engine.save_engine` | `create_engine_file` | output TensorRT engine path |
| gen_trt_engine | `key` | `key` | encryption key |
| gen_trt_engine | `results_dir` | `output_dir` | current job results directory |
| inference | `inference.checkpoint` | `parent_model` | model file inferred from the parent job results folder |
| inference | `inference.trt_engine` | `parent_model` | model file inferred from the parent job results folder |
| inference | `key` | `key` | encryption key |
| inference | `results_dir` | `output_dir` | current job results directory |
| prune | `key` | `key` | encryption key |
| prune | `prune.model` | `parent_model` | model file inferred from the parent job results folder |
| prune | `results_dir` | `output_dir` | current job results directory |
| retrain | `key` | `key` | encryption key |
| retrain | `results_dir` | `output_dir` | current job results directory |
| retrain | `train.pruned_model_path` | `parent_model` | model file inferred from the parent job results folder |
| train | `key` | `key` | encryption key |
| train | `model.pretrained_model_path` | `ptm_if_no_resume_model` | PTM when no resume checkpoint exists |
| train | `results_dir` | `output_dir` | current job results directory |
| train | `train.resume_training_checkpoint_path` | `resume_model` | model file inferred from the current job results folder |

For `parent_model` or `parent_model_folder`, pass the upstream train/export/AutoML child job id as `parent_job_id`. The SDK lists the parent result folder, filters checkpoint artifacts, and returns the selected model file or folder. Do not add these mappings back to `config.json` and do not patch generated runner scripts to guess checkpoint paths.

## Deployment

- [tao-deploy-pointpillars](references/tao-deploy-pointpillars.md) — PointPillars deploy workflow for TensorRT engine generation, TensorRT evaluation, and TensorRT inference using TAO Deploy.
