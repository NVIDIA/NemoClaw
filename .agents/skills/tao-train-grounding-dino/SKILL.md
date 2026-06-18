---
name: tao-train-grounding-dino
description: Grounding DINO for open-set object detection. Combines DINO-style detection with a BERT text encoder for
  language-guided detection — detects objects described by text prompts without a fixed class vocabulary. Use when training,
  evaluating, exporting, quantizing, or running inference for a TAO Grounding DINO model. Trigger phrases include "train
  Grounding DINO", "open-vocabulary detection", "text-prompted detector", "language-guided object detection".
license: Apache-2.0
compatibility: Requires docker + nvidia-container-toolkit.
metadata:
  version: "0.1.0"
  author: NVIDIA Corporation
allowed-tools: Read Bash
tags:
- object
- detection
---

# Grounding DINO

Grounding DINO for open-set object detection. Combines DINO-style detection with BERT text encoder for language-guided detection. Detects objects described by text prompts without fixed class vocabulary.

Set train.pretrained_model_path for full Grounding DINO weights or model.pretrained_backbone_path for backbone-only.

For TAO Deploy TensorRT actions (`gen_trt_engine`, TensorRT `evaluate`, and TensorRT `inference`), read `references/tao-deploy-grounding-dino.md` first. Deploy spec templates live in this skill's `references/` folder with the `spec_template_deploy_*.yaml` prefix.

## Dataclass Schemas

Generated TAO Core schemas are packaged in `schemas/<action>.schema.json`, with `schemas/manifest.json` listing available actions. Each generated schema also emits `references/spec_template_<action>.yaml` from the schema top-level `default` field. AutoML enablement is declared at the model layer in `references/skill_info.yaml` via `automl_enabled`. Runnable AutoML still requires `schemas/train.schema.json` and `references/spec_template_train.yaml` to exist and parse. Use the packaged train schema for `automl_default_parameters`, `automl_disabled_parameters`, defaults, min/max bounds, enums, option weights, math conditions, dependencies, and popular parameters. Do not expect `~/tao-core` at runtime; maintainers regenerate schemas/templates before packaging the skill bank.

## Train Action Policy

This model is AutoML-enabled at the model layer. Before handling any train-stage request, read `references/skill_info.yaml` and resolve the run override from either an explicit `automl_policy` value or the user's workflow request. Treat phrases like "turn off AutoML", "disable AutoML", "no HPO", or "plain training" as `automl_policy: off` for this run only; otherwise default to `auto`. When `automl_policy: auto`, `automl_enabled: true`, and both `schemas/train.schema.json` and `references/spec_template_train.yaml` are packaged, route the train action through `tao-skill-bank:tao-run-automl` by default with this model's `skill_dir`. Preserve workflow/application overrides for datasets, specs, output directories, GPU/platform settings, parent checkpoints, and `automl_policy`. Use direct model training only when `automl_policy: off` or the packaged train schema/template is missing; in the missing-schema case, report that AutoML is enabled but not runnable for this model until schemas are generated.

Non-train actions such as `evaluate`, `inference`, `export`, and deploy flows stay in this model skill. The per-run `automl_policy` override does not change model metadata.

## Training Requirements

- **Dataset type:** object_detection
- **Formats:** odvg, coco, raw
- **Monitoring metric:** val_mAP50

### Per-Action Dataset Requirements

| Action | Spec Key | Source | Files | List? |
|---|---|---|---|---|
| evaluate | dataset.test_data_sources | eval_dataset | image_dir: images.tar.gz, json_file: annotations.json | No |
| inference | dataset.infer_data_sources | inference_dataset | image_dir: images.tar.gz, classmap: label_map.txt | No |
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
    "train.num_epochs": 10,
    "train.checkpoint_interval": 10,
    "train.validation_interval": 10,
    "train.num_gpus": 1,
    "dataset.train_data_sources": [{"image_dir": f"{S3_TRAIN}/images.tar.gz", "json_file": f"{S3_TRAIN}/annotations_odvg.jsonl", "label_map": f"{S3_TRAIN}/annotations_odvg_labelmap.json"}],
    "dataset.val_data_sources": {"image_dir": f"{S3_EVAL}/images.tar.gz", "json_file": f"{S3_EVAL}/annotations.json"},
}
```

**gen_trt_engine:**
```python
{
    "gen_trt_engine.tensorrt.data_type": "FP16",
}
```

**inference (mandatory data sources):**
```python
{
    "dataset.infer_data_sources.captions": [
        "person"
    ],
    "dataset.infer_data_sources": {"image_dir": f"{S3_EVAL}/images.tar.gz", "classmap": f"{S3_EVAL}/label_map.txt"},
}
```

**evaluate (mandatory data sources):**
```python
{
    "dataset.test_data_sources": {"image_dir": f"{S3_EVAL}/images.tar.gz", "json_file": f"{S3_EVAL}/annotations.json"},
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

Optional. Validation uses COCO-format annotations for mAP even though training can use ODVG format.

## Important Parameters

- **model.backbone**: Default swin_tiny_224_1k. Also supports resnet_50 and other Swin variants. Swin generally performs better for grounding tasks.
- **model.text_encoder_type**: BERT model for text encoding. Default bert-base-uncased. max_text_len defaults to 256.
- **train.optim.lr**: Learning rate. Default 2e-4. lr_backbone 2e-5. Supports bf16 precision in addition to fp16/fp32.
- **dataset.max_labels**: Maximum labels per image during training. Default 50. Increase for dense annotation datasets.
- **model.num_queries**: Object queries. Default 900 (higher than DINO's 300) due to open-vocabulary nature.
- **train.optim.lr_steps**: MultiStep LR schedule. Default [10].

## Multi-GPU / Multi-Node

**Launch method:** Lightning-managed (single `python` process, Lightning spawns workers).

| Spec Key | Description | Default |
|----------|-------------|---------|
| `train.num_gpus` | Number of GPUs | 1 |
| `train.gpu_ids` | GPU device indices | [0] |
| `train.num_nodes` | Number of nodes | 1 |
| `train.distributed_strategy` | `ddp` or `fsdp` | `ddp` |

Same DDP/FSDP behavior as DINO. Multi-node requires `WORLD_SIZE`, `NODE_RANK`, `MASTER_ADDR`, `MASTER_PORT` env vars set by orchestrator.

## Export / TRT Defaults

- Export input: 960x544 (larger than other OD models), opset 17
- TRT data types: FP32, FP16 only — **INT8 is NOT supported**
- TRT workspace: 8192 MB (8x larger than other OD models)
- TRT max_batch_size: 4

Full TAO Deploy reference: [tao-deploy-grounding-dino](references/tao-deploy-grounding-dino.md).

## Hardware

Minimum 1 GPU(s), recommended 4 GPU(s). 24GB+ (A100 recommended) VRAM per GPU. Grounding DINO is heavier than standard DINO due to the text encoder (BERT). 24GB+ GPU memory recommended. Reduce batch_size for 16GB GPUs.

## Error Patterns

**CUDA out of memory**: Reduce batch_size (4 -> 2 -> 1). The BERT text encoder adds significant memory overhead on top of the vision backbone.

**Val annotation category IDs**: Validation annotations should have category IDs starting from 0 for correct loss computation. Use annotation format conversion if needed.

**Text encoder loading error**: Ensure the container has access to download bert-base-uncased weights or provide a local path.

## Spec Param / Parent Model Inference

Model-specific inference mappings belong in this MD file, not in `config.json`. Generated runners should read this section and apply the mappings with SDK helpers before `create_job()`. This mirrors the old microservices `infer_params.py` flow.

Inference mappings from TAO Core `grounding_dino.config.json`:

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
