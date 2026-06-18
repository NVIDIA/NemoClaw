---
name: tao-train-pose-classification
description: Pose classification using ST-GCN (Spatial Temporal Graph Convolutional Network). Classifies skeleton sequences
  into action categories from pose-keypoint data. Use when training, evaluating, exporting, or running inference for a TAO
  pose-classification model. Trigger phrases include "train pose classification", "skeleton action recognition", "ST-GCN",
  "keypoint sequence classifier".
license: Apache-2.0
compatibility: Requires docker + nvidia-container-toolkit.
metadata:
  version: "0.1.0"
  author: NVIDIA Corporation
allowed-tools: Read Bash
tags:
- pose
- classification
---

# Pose Classification

Pose classification using ST-GCN (Spatial Temporal Graph Convolutional Network). Classifies skeleton sequences into action categories from pose keypoint data.

Typically trained from scratch on skeleton data.

## Dataclass Schemas

Generated TAO Core schemas are packaged in `schemas/<action>.schema.json`, with `schemas/manifest.json` listing available actions. Each generated schema also emits `references/spec_template_<action>.yaml` from the schema top-level `default` field. AutoML enablement is declared at the model layer in `references/skill_info.yaml` via `automl_enabled`. Runnable AutoML still requires `schemas/train.schema.json` and `references/spec_template_train.yaml` to exist and parse. Use the packaged train schema for `automl_default_parameters`, `automl_disabled_parameters`, defaults, min/max bounds, enums, option weights, math conditions, dependencies, and popular parameters. Do not expect `~/tao-core` at runtime; maintainers regenerate schemas/templates before packaging the skill bank.

## Train Action Policy

This model is AutoML-enabled at the model layer. Before handling any train-stage request, read `references/skill_info.yaml` and resolve the run override from either an explicit `automl_policy` value or the user's workflow request. Treat phrases like "turn off AutoML", "disable AutoML", "no HPO", or "plain training" as `automl_policy: off` for this run only; otherwise default to `auto`. When `automl_policy: auto`, `automl_enabled: true`, and both `schemas/train.schema.json` and `references/spec_template_train.yaml` are packaged, route the train action through `tao-skill-bank:tao-run-automl` by default with this model's `skill_dir`. Preserve workflow/application overrides for datasets, specs, output directories, GPU/platform settings, parent checkpoints, and `automl_policy`. Use direct model training only when `automl_policy: off` or the packaged train schema/template is missing; in the missing-schema case, report that AutoML is enabled but not runnable for this model until schemas are generated.

Non-train actions such as `evaluate`, `inference`, `export`, and deploy flows stay in this model skill. The per-run `automl_policy` override does not change model metadata.

## Training Requirements

- **Dataset type:** pose_classification
- **Formats:** default
- **Monitoring metric:** val_acc

### Per-Action Dataset Requirements

| Action | Spec Key | Source | Files | List? |
|---|---|---|---|---|
| evaluate | evaluate.test_dataset.data_path | train_datasets |  | No |
| evaluate | evaluate.test_dataset.label_path | train_datasets |  | No |
| inference | inference.test_dataset.data_path | train_datasets |  | No |
| train | dataset.train_dataset.data_path | train_datasets |  | No |
| train | dataset.train_dataset.label_path | train_datasets |  | No |
| train | dataset.val_dataset.data_path | train_datasets |  | No |
| train | dataset.val_dataset.label_path | train_datasets |  | No |

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
    "num_classes": 6,
    "graph_layout": "nvidia",
    "dataset.train_dataset.data_path": f"{S3_TRAIN}",
    "dataset.train_dataset.label_path": f"{S3_TRAIN}",
    "dataset.val_dataset.data_path": f"{S3_TRAIN}",
    "dataset.val_dataset.label_path": f"{S3_TRAIN}",
}
```

**evaluate (mandatory data sources):**
```python
{
    "evaluate.test_dataset.data_path": f"{S3_TRAIN}",
    "evaluate.test_dataset.label_path": f"{S3_TRAIN}",
}
```

**inference (mandatory data sources):**
```python
{
    "inference.test_dataset.data_path": f"{S3_TRAIN}",
}
```
## Eval Dataset

Optional. Validation data is provided alongside training as val_data.npy / val_label.pkl.

## Important Parameters

- **dataset.num_classes**: Number of pose action classes. Default 6.
- **model.graph_layout**: Skeleton graph layout. Options: nvidia, openpose. Determines joint connectivity.
- **model.graph_strategy**: Graph partitioning strategy for GCN.
- **train.optim.lr**: Learning rate. Default 0.1 (SGD). Higher than vision models due to graph convolution properties.
- **model.dropout**: Dropout rate for regularization.

## Multi-GPU / Multi-Node

**Launch method:** Lightning-managed (single `python` process, Lightning spawns workers).

| Spec Key | Description | Default |
|----------|-------------|---------|
| `train.num_gpus` | Number of GPUs | 1 |
| `train.gpu_ids` | GPU device indices | [0] |

- Strategy: `auto` (Lightning picks best strategy automatically)
- No explicit `num_nodes` or `distributed_strategy` config — single-node only
- Lightweight model, single GPU typically sufficient

## Hardware

Minimum 1 GPU(s), recommended 1 GPU(s). 8GB+ VRAM per GPU. Pose classification is very lightweight — skeleton data is small. Single GPU is sufficient.

## Error Patterns

**Graph layout mismatch**: Ensure model.graph_layout matches the skeleton format in your .npy data files.

**Label shape mismatch**: train_label.pkl class indices must be in range [0, num_classes).

## Spec Param / Parent Model Inference

Model-specific inference mappings belong in this MD file, not in `config.json`. Generated runners should read this section and apply the mappings with SDK helpers before `create_job()`. This mirrors the old microservices `infer_params.py` flow.

Inference mappings from TAO Core `pose_classification.config.json`:

| Action | Spec Field | Inference Function | Meaning |
|---|---|---|---|
| evaluate | `encryption_key` | `key` | encryption key |
| evaluate | `evaluate.checkpoint` | `parent_model` | model file inferred from the parent job results folder |
| evaluate | `results_dir` | `output_dir` | current job results directory |
| export | `encryption_key` | `key` | encryption key |
| export | `export.checkpoint` | `parent_model` | model file inferred from the parent job results folder |
| export | `export.onnx_file` | `create_onnx_file` | output ONNX path |
| export | `results_dir` | `output_dir` | current job results directory |
| inference | `encryption_key` | `key` | encryption key |
| inference | `inference.checkpoint` | `parent_model` | model file inferred from the parent job results folder |
| inference | `inference.output_file` | `create_inference_result_file_pose` | pose inference result file |
| inference | `results_dir` | `output_dir` | current job results directory |
| train | `encryption_key` | `key` | encryption key |
| train | `model.pretrained_model_path` | `ptm_if_no_resume_model` | PTM when no resume checkpoint exists |
| train | `results_dir` | `output_dir` | current job results directory |
| train | `train.resume_training_checkpoint_path` | `resume_model` | model file inferred from the current job results folder |

For `parent_model` or `parent_model_folder`, pass the upstream train/export/AutoML child job id as `parent_job_id`. The SDK lists the parent result folder, filters checkpoint artifacts, and returns the selected model file or folder. Do not add these mappings back to `config.json` and do not patch generated runner scripts to guess checkpoint paths.
