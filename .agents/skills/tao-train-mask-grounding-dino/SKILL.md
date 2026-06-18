---
name: tao-train-mask-grounding-dino
description: Mask Grounding DINO for grounded instance segmentation. Extends Grounding DINO with a mask-prediction head for
  open-set segmentation guided by text prompts. Use when training, evaluating, exporting, quantizing, or running inference for
  a TAO Mask-Grounding-DINO model. Trigger phrases include "train Mask Grounding DINO", "open-vocabulary segmentation",
  "text-prompted instance segmentation", "grounded mask DETR".
license: Apache-2.0
compatibility: Requires docker + nvidia-container-toolkit.
metadata:
  version: "0.1.0"
  author: NVIDIA Corporation
allowed-tools: Read Bash
tags:
- segmentation
---

# Mask Grounding DINO

Mask Grounding DINO for grounded instance segmentation. Extends Grounding DINO with mask prediction head for open-set segmentation guided by text prompts.

Set train.pretrained_model_path for full model weights.

For TAO Deploy TensorRT actions (`gen_trt_engine`, TensorRT `evaluate`, and TensorRT `inference`), read `references/tao-deploy-mask-grounding-dino.md` first. Deploy spec templates live in this skill's `references/` folder with the `spec_template_deploy_*.yaml` prefix.

## Dataclass Schemas

Generated TAO Core schemas are packaged in `schemas/<action>.schema.json`, with `schemas/manifest.json` listing available actions. Each generated schema also emits `references/spec_template_<action>.yaml` from the schema top-level `default` field. AutoML enablement is declared at the model layer in `references/skill_info.yaml` via `automl_enabled`. Runnable AutoML still requires `schemas/train.schema.json` and `references/spec_template_train.yaml` to exist and parse. Use the packaged train schema for `automl_default_parameters`, `automl_disabled_parameters`, defaults, min/max bounds, enums, option weights, math conditions, dependencies, and popular parameters. Do not expect `~/tao-core` at runtime; maintainers regenerate schemas/templates before packaging the skill bank.

## Train Action Policy

This model is AutoML-enabled at the model layer. Before handling any train-stage request, read `references/skill_info.yaml` and resolve the run override from either an explicit `automl_policy` value or the user's workflow request. Treat phrases like "turn off AutoML", "disable AutoML", "no HPO", or "plain training" as `automl_policy: off` for this run only; otherwise default to `auto`. When `automl_policy: auto`, `automl_enabled: true`, and both `schemas/train.schema.json` and `references/spec_template_train.yaml` are packaged, route the train action through `tao-skill-bank:tao-run-automl` by default with this model's `skill_dir`. Preserve workflow/application overrides for datasets, specs, output directories, GPU/platform settings, parent checkpoints, and `automl_policy`. Use direct model training only when `automl_policy: off` or the packaged train schema/template is missing; in the missing-schema case, report that AutoML is enabled but not runnable for this model until schemas are generated.

Non-train actions such as `evaluate`, `inference`, `export`, and deploy flows stay in this model skill. The per-run `automl_policy` override does not change model metadata.

## Training Requirements

- **Dataset type:** segmentation
- **Formats:** odvg, coco, coco_raw
- **Monitoring metric:** [bbox] val_mAP@50

### Per-Action Dataset Requirements

| Action | Spec Key | Source | Files | List? |
|---|---|---|---|---|
| evaluate | dataset.test_data_sources | eval_dataset | image_dir: images.tar.gz, json_file: annotations.json | No |
| inference | dataset.infer_data_sources | inference_dataset | image_dir: images.tar.gz, classmap: label_map.txt, json_file: inference.jsonl, captions: inference.jsonl | No |
| quantize | dataset.train_data_sources | train_datasets | image_dir: images.tar.gz, json_file: annotations_odvg.jsonl, label_map: annotations_odvg_labelmap.json | Yes |
| quantize | dataset.val_data_sources | eval_dataset | image_dir: images.tar.gz, json_file: annotations.json | No |
| quantize | dataset.quant_calibration_data_sources | train_datasets | image_dir: images.tar.gz, json_file: annotations_odvg.jsonl, label_map: annotations_odvg_labelmap.json | No |
| train | dataset.train_data_sources | train_datasets | image_dir: images.tar.gz, json_file: annotations_odvg.jsonl, label_map: annotations_odvg_labelmap.json | Yes |
| train | dataset.val_data_sources | eval_dataset | image_dir: images.tar.gz, json_file: annotations.json | No |

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
    "val_data_sources.data_type": "OD",
    "model.num_region_queries": 100,
    "dataset.train_data_sources": [{"image_dir": f"{S3_TRAIN}/images.tar.gz", "json_file": f"{S3_TRAIN}/annotations_odvg.jsonl", "label_map": f"{S3_TRAIN}/annotations_odvg_labelmap.json"}],
    "dataset.val_data_sources": {"image_dir": f"{S3_EVAL}/images.tar.gz", "json_file": f"{S3_EVAL}/annotations.json"},
}
```

**evaluate (mandatory data sources):**
```python
{
    "test_data_sources.data_type": "OD",
    "dataset.test_data_sources": {"image_dir": f"{S3_EVAL}/images.tar.gz", "json_file": f"{S3_EVAL}/annotations.json"},
}
```

**inference (mandatory data sources):**
```python
{
    "infer_data_sources.data_type": "OD",
    "dataset.infer_data_sources": {"image_dir": f"{S3_EVAL}/images.tar.gz", "classmap": f"{S3_EVAL}/label_map.txt", "json_file": f"{S3_EVAL}/inference.jsonl", "captions": f"{S3_EVAL}/inference.jsonl"},
}
```

**quantize (mandatory data sources):**
```python
{
    "dataset.train_data_sources": [{"image_dir": f"{S3_TRAIN}/images.tar.gz", "json_file": f"{S3_TRAIN}/annotations_odvg.jsonl", "label_map": f"{S3_TRAIN}/annotations_odvg_labelmap.json"}],
    "dataset.val_data_sources": {"image_dir": f"{S3_EVAL}/images.tar.gz", "json_file": f"{S3_EVAL}/annotations.json"},
    "dataset.quant_calibration_data_sources": {"image_dir": f"{S3_TRAIN}/images.tar.gz", "json_file": f"{S3_TRAIN}/annotations_odvg.jsonl", "label_map": f"{S3_TRAIN}/annotations_odvg_labelmap.json"},
}
```
## Eval Dataset

Optional. Validation uses COCO-format annotations even when training uses ODVG.

## Important Parameters

- **model.backbone**: Default swin_tiny_224_1k. Same backbone options as Grounding DINO.
- **train.optim.lr**: Learning rate. Default 2e-4. lr_backbone 2e-5. Reuses GDINOTrainExpConfig — same training setup as Grounding DINO.
- **model.num_queries**: Object queries. Default 900.
- **model.has_mask**: Enables mask prediction head. Default True. Adds mask/dice/rela loss coefficients.
- **model.num_region_queries**: Number of region queries for mask prediction. Default 100.
- **model.loss_types**: Loss components. Default [labels, boxes, masks]. Includes mask_loss_coef, dice_loss_coef, rela_loss_coef.
- **evaluate.ioi_threshold**: IoI threshold for mask evaluation. Default 0.5.
- **evaluate.nms_threshold**: NMS threshold. Default 0.2.
- **evaluate.text_threshold**: Text matching threshold. Default 0.3.
- **dataset.has_mask**: Dataset includes mask annotations. Default True. val_data_sources default data_type is "VG".

## Multi-GPU / Multi-Node

**Launch method:** Lightning-managed. Same DDP/FSDP behavior as Grounding DINO.

| Spec Key | Description | Default |
|----------|-------------|---------|
| `train.num_gpus` | Number of GPUs | 1 |
| `train.gpu_ids` | GPU device indices | [0] |
| `train.num_nodes` | Number of nodes | 1 |
| `train.distributed_strategy` | `ddp` or `fsdp` | `ddp` |

## Hardware

Minimum 1 GPU(s), recommended 4 GPU(s). 24GB+ (A100 recommended) VRAM per GPU. Heavier than Grounding DINO due to mask prediction head. 24GB+ GPU memory recommended.

## Error Patterns

**CUDA out of memory**: Reduce batch_size. Mask prediction adds overhead on top of Grounding DINO.

## Spec Param / Parent Model Inference

Model-specific inference mappings belong in this MD file, not in `config.json`. Generated runners should read this section and apply the mappings with SDK helpers before `create_job()`. This mirrors the old microservices `infer_params.py` flow.

Inference mappings from TAO Core `mask_grounding_dino.config.json`:

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
| train | `model.pretrained_backbone_path` | `ptm_if_no_resume_model` | PTM when no resume checkpoint exists |
| train | `results_dir` | `output_dir` | current job results directory |
| train | `train.pretrained_model_path` | `ptm_if_no_resume_model` | PTM when no resume checkpoint exists |
| train | `train.resume_training_checkpoint_path` | `resume_model` | model file inferred from the current job results folder |

For `parent_model` or `parent_model_folder`, pass the upstream train/export/AutoML child job id as `parent_job_id`. The SDK lists the parent result folder, filters checkpoint artifacts, and returns the selected model file or folder. Do not add these mappings back to `config.json` and do not patch generated runner scripts to guess checkpoint paths.

## Deployment

- [tao-deploy-mask-grounding-dino](references/tao-deploy-mask-grounding-dino.md) — Mask Grounding DINO deploy workflow for TensorRT engine generation, TensorRT evaluation, and TensorRT inference using TAO Deploy.
