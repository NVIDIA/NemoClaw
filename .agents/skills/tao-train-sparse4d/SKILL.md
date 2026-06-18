---
name: tao-train-sparse4d
description: Sparse4D for multi-camera temporal 3D object detection and tracking. Uses sparse queries with deformable
  attention across camera views and time for end-to-end 3D perception, with an instance bank for temporal tracking. Use when
  training, evaluating, exporting, quantizing, or running inference for a TAO Sparse4D model. Trigger phrases include
  "train Sparse4D", "multi-camera 3D detection", "temporal 3D tracker", "sparse query 3D perception".
license: Apache-2.0
compatibility: Requires docker + nvidia-container-toolkit.
metadata:
  version: "0.1.0"
  author: NVIDIA Corporation
allowed-tools: Read Bash
tags:
- temporal
- 3d
- detection
- tracking
---

# Sparse4D

Sparse4D for multi-camera temporal 3D object detection and tracking. Uses sparse queries with deformable attention across camera views and time for end-to-end 3D perception. Includes instance bank for temporal tracking.

Requires pretrained ResNet-101 backbone. Set train.pretrained_model_path.

## Dataclass Schemas

Generated TAO Core schemas are packaged in `schemas/<action>.schema.json`, with `schemas/manifest.json` listing available actions. Each generated schema also emits `references/spec_template_<action>.yaml` from the schema top-level `default` field. AutoML enablement is declared at the model layer in `references/skill_info.yaml` via `automl_enabled`. Runnable AutoML still requires `schemas/train.schema.json` and `references/spec_template_train.yaml` to exist and parse. Use the packaged train schema for `automl_default_parameters`, `automl_disabled_parameters`, defaults, min/max bounds, enums, option weights, math conditions, dependencies, and popular parameters. Do not expect `~/tao-core` at runtime; maintainers regenerate schemas/templates before packaging the skill bank.

## Train Action Policy

This model is AutoML-enabled at the model layer. Before handling any train-stage request, read `references/skill_info.yaml` and resolve the run override from either an explicit `automl_policy` value or the user's workflow request. Treat phrases like "turn off AutoML", "disable AutoML", "no HPO", or "plain training" as `automl_policy: off` for this run only; otherwise default to `auto`. When `automl_policy: auto`, `automl_enabled: true`, and both `schemas/train.schema.json` and `references/spec_template_train.yaml` are packaged, route the train action through `tao-skill-bank:tao-run-automl` by default with this model's `skill_dir`. Preserve workflow/application overrides for datasets, specs, output directories, GPU/platform settings, parent checkpoints, and `automl_policy`. Use direct model training only when `automl_policy: off` or the packaged train schema/template is missing; in the missing-schema case, report that AutoML is enabled but not runnable for this model until schemas are generated.

Non-train actions such as `evaluate`, `inference`, `export`, and deploy flows stay in this model skill. The per-run `automl_policy` override does not change model metadata.

## Training Requirements

- **Dataset type:** sparse4d
- **Formats:** ovpkl
- **Monitoring metric:** val_mAP

### Per-Action Dataset Requirements

| Action | Spec Key | Source | Files | List? |
|---|---|---|---|---|
| dataset_convert | aicity.root | id |  | No |
| evaluate | dataset.data_root | eval_dataset | (from convert job, spec: aicity.split) | No |
| evaluate | model.head.instance_bank.anchor | train_datasets | /results/{dataset_convert_job_id}/anchor_init.npy | No |
| evaluate | dataset.train_dataset.ann_file | train_datasets | (from convert job, spec: aicity.split) | No |
| evaluate | dataset.val_dataset.ann_file | eval_dataset | (from convert job, spec: aicity.split) | No |
| evaluate | dataset.test_dataset.ann_file | inference_dataset | (from convert job, spec: aicity.split) | No |
| export | model.head.instance_bank.anchor | train_datasets | /results/{dataset_convert_job_id}/anchor_init.npy | No |
| inference | dataset.data_root | inference_dataset | (from convert job, spec: aicity.split) | No |
| inference | model.head.instance_bank.anchor | train_datasets | /results/{dataset_convert_job_id}/anchor_init.npy | No |
| inference | dataset.train_dataset.ann_file | train_datasets | (from convert job, spec: aicity.split) | No |
| inference | dataset.val_dataset.ann_file | eval_dataset | (from convert job, spec: aicity.split) | No |
| inference | dataset.test_dataset.ann_file | inference_dataset | (from convert job, spec: aicity.split) | No |
| quantize | dataset.data_root | train_datasets | (from convert job, spec: aicity.split) | No |
| quantize | model.head.instance_bank.anchor | train_datasets | /results/{dataset_convert_job_id}/anchor_init.npy | No |
| quantize | dataset.train_dataset.ann_file | train_datasets | (from convert job, spec: aicity.split) | No |
| quantize | dataset.val_dataset.ann_file | eval_dataset | (from convert job, spec: aicity.split) | No |
| quantize | dataset.test_dataset.ann_file | inference_dataset | (from convert job, spec: aicity.split) | No |
| quantize | dataset.quant_calibration_dataset.images_dir | train_datasets |  | No |
| train | dataset.data_root | train_datasets | (from convert job, spec: aicity.split) | No |
| train | model.head.instance_bank.anchor | train_datasets | /results/{dataset_convert_job_id}/anchor_init.npy | No |
| train | dataset.train_dataset.ann_file | train_datasets | (from convert job, spec: aicity.split) | No |
| train | dataset.val_dataset.ann_file | eval_dataset | (from convert job, spec: aicity.split) | No |
| train | dataset.test_dataset.ann_file | inference_dataset | (from convert job, spec: aicity.split) | No |

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
    "dataset.sequences.split_num": 90,
    "train_dataset.sequences_split_num": 90,
    "dataset.data_root": {"spec": f"{S3_TRAIN}/aicity.split)"},
    "model.head.instance_bank.anchor": f"{S3_TRAIN}//results/{dataset_convert_job_id}/anchor_init.npy",
    "dataset.train_dataset.ann_file": {"spec": f"{S3_TRAIN}/aicity.split)"},
    "dataset.val_dataset.ann_file": {"spec": f"{S3_EVAL}/aicity.split)"},
    "dataset.test_dataset.ann_file": {"spec": f"{S3_EVAL}/aicity.split)"},
}
```

**evaluate (mandatory data sources):**
```python
{
    "dataset.data_root": {"spec": f"{S3_EVAL}/aicity.split)"},
    "model.head.instance_bank.anchor": f"{S3_TRAIN}//results/{dataset_convert_job_id}/anchor_init.npy",
    "dataset.train_dataset.ann_file": {"spec": f"{S3_TRAIN}/aicity.split)"},
    "dataset.val_dataset.ann_file": {"spec": f"{S3_EVAL}/aicity.split)"},
    "dataset.test_dataset.ann_file": {"spec": f"{S3_EVAL}/aicity.split)"},
}
```

**export (mandatory data sources):**
```python
{
    "model.head.instance_bank.anchor": f"{S3_TRAIN}//results/{dataset_convert_job_id}/anchor_init.npy",
}
```

**inference (mandatory data sources):**
```python
{
    "dataset.data_root": {"spec": f"{S3_EVAL}/aicity.split)"},
    "model.head.instance_bank.anchor": f"{S3_TRAIN}//results/{dataset_convert_job_id}/anchor_init.npy",
    "dataset.train_dataset.ann_file": {"spec": f"{S3_TRAIN}/aicity.split)"},
    "dataset.val_dataset.ann_file": {"spec": f"{S3_EVAL}/aicity.split)"},
    "dataset.test_dataset.ann_file": {"spec": f"{S3_EVAL}/aicity.split)"},
}
```

**quantize (mandatory data sources):**
```python
{
    "dataset.data_root": {"spec": f"{S3_TRAIN}/aicity.split)"},
    "model.head.instance_bank.anchor": f"{S3_TRAIN}//results/{dataset_convert_job_id}/anchor_init.npy",
    "dataset.train_dataset.ann_file": {"spec": f"{S3_TRAIN}/aicity.split)"},
    "dataset.val_dataset.ann_file": {"spec": f"{S3_EVAL}/aicity.split)"},
    "dataset.test_dataset.ann_file": {"spec": f"{S3_EVAL}/aicity.split)"},
    "dataset.quant_calibration_dataset.images_dir": f"{S3_TRAIN}",
}
```
## Eval Dataset

Optional. Val/test splits configured via dataset ann_file paths.

## Important Parameters

- **model.backbone**: Backbone. Default resnet_101.
- **model.neck.out_channels**: FPN output channels. Default 256. num_outs=4.
- **model.input_shape**: Input image shape [W, H]. Default [1408, 512].
- **model.head.num_output**: Number of detection output queries. Default 300.
- **model.head.num_decoder**: Number of decoder layers. Default 6.
- **model.head.temporal**: Enable temporal reasoning. Default True.
- **model.head.instance_bank.num_anchor**: Instance bank anchors. Default 900.
- **model.head.instance_bank.num_temp_instances**: Temporal instance count. Default 600.
- **model.depth_branch.loss_weight**: Depth supervision loss weight. Default 0.2.
- **dataset.batch_size**: Per-GPU batch size. Default 2.
- **dataset.num_frames**: Sequence length. Default 200.
- **dataset.classes**: Detection classes. Default [person, gr1_t2, agility_digit, nova_carter]. num_ids=70 for tracking.
- **train.optim.lr**: Learning rate. Default 5e-5. img_backbone lr_mult=0.2.
- **train.lr_scheduler**: Cosine scheduler with linear warmup (500 iters, ratio 0.333).
- **train.grad_clip.max_norm**: Gradient clipping. Default 25.
- **train.precision**: Options: bf16, fp16, fp32. Default bf16.
- **evaluate.metrics**: Eval metrics. Default ["detection"]. Optional tracking evaluation.
- **evaluate.tracking.enabled**: Enable tracking evaluation. tracking_threshold=0.2.

## Multi-GPU / Multi-Node

**Launch method:** Lightning-managed (single `python` process, Lightning spawns workers).

| Spec Key | Description | Default |
|----------|-------------|---------|
| `train.num_gpus` | Number of GPUs | 1 |
| `train.gpu_ids` | GPU device indices | [0] |
| `train.num_nodes` | Number of nodes | 1 |

- Multi-GPU strategy: `ddp_find_unused_parameters_true` (no fsdp support)
- `sync_batchnorm` is always enabled (True)
- Iterations per epoch computed as: `num_frames * num_bev_groups / (num_nodes * num_gpus * batch_size)`
- **Scaling:** When increasing GPUs, effective batch size grows and iterations-per-epoch shrinks proportionally

**Multi-node env vars** (set by orchestrator): `WORLD_SIZE`, `NODE_RANK`, `MASTER_ADDR`, `MASTER_PORT`, `NUM_GPU_PER_NODE`.

## Hardware

Minimum 2 GPU(s), recommended 8 GPU(s). 40GB+ (A100 recommended) VRAM per GPU. Multi-camera temporal model is memory intensive. bf16 required for practical training. Multi-GPU strongly recommended. Instance bank requires substantial memory for temporal reasoning.

## Error Patterns

**dataset_convert required**: Must run dataset_convert first to produce annotation pickles and anchor_init.npy.

**Missing anchor file**: Set model.head.instance_bank.anchor to the anchor_init.npy path from dataset_convert results.

**Temporal OOM**: Reduce dataset.num_frames or dataset.batch_size if running out of memory during temporal training.

## Spec Param / Parent Model Inference

Model-specific inference mappings belong in this MD file, not in `config.json`. Generated runners should read this section and apply the mappings with SDK helpers before `create_job()`. This mirrors the old microservices `infer_params.py` flow.

Inference mappings from TAO Core `sparse4d.config.json`:

| Action | Spec Field | Inference Function | Meaning |
|---|---|---|---|
| dataset_convert | `results_dir` | `output_dir` | current job results directory |
| evaluate | `encryption_key` | `key` | encryption key |
| evaluate | `evaluate.checkpoint` | `parent_model` | model file inferred from the parent job results folder |
| evaluate | `results_dir` | `output_dir` | current job results directory |
| export | `encryption_key` | `key` | encryption key |
| export | `export.checkpoint` | `parent_model` | model file inferred from the parent job results folder |
| export | `export.onnx_file` | `create_onnx_file` | output ONNX path |
| export | `results_dir` | `output_dir` | current job results directory |
| inference | `encryption_key` | `key` | encryption key |
| inference | `inference.checkpoint` | `parent_model` | model file inferred from the parent job results folder |
| inference | `results_dir` | `output_dir` | current job results directory |
| quantize | `encryption_key` | `key` | encryption key |
| quantize | `quantize.model_path` | `parent_model` | model file inferred from the parent job results folder |
| quantize | `results_dir` | `output_dir` | current job results directory |
| train | `encryption_key` | `key` | encryption key |
| train | `results_dir` | `output_dir` | current job results directory |
| train | `train.pretrained_model_path` | `ptm_if_no_resume_model` | PTM when no resume checkpoint exists |
| train | `train.resume_training_checkpoint_path` | `resume_model` | model file inferred from the current job results folder |

For `parent_model` or `parent_model_folder`, pass the upstream train/export/AutoML child job id as `parent_job_id`. The SDK lists the parent result folder, filters checkpoint artifacts, and returns the selected model file or folder. Do not add these mappings back to `config.json` and do not patch generated runner scripts to guess checkpoint paths.
