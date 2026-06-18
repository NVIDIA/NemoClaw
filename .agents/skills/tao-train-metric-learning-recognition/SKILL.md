---
name: tao-train-metric-learning-recognition
description: Metric-learning recognition (ml-recog) for fine-grained visual recognition. Learns embeddings for
  retrieval-based matching (e.g., retail product recognition) using triplet / contrastive losses. Use when training,
  evaluating, exporting, or running inference for a TAO metric-learning recognition model. Trigger phrases include
  "train metric learning", "ml-recog", "retrieval embeddings", "triplet loss recognition", "fine-grained matching".
license: Apache-2.0
compatibility: Requires docker + nvidia-container-toolkit.
metadata:
  version: "0.1.0"
  author: NVIDIA Corporation
allowed-tools: Read Bash
tags:
- metric
- learning
- recognition
---

# ML Recog

Metric learning recognition for fine-grained visual recognition. Learns embeddings for retrieval-based matching (e.g., retail product recognition). Uses triplet/contrastive losses.

Set model.pretrained_model_path for pretrained backbone.

For TAO Deploy TensorRT actions (`gen_trt_engine`, TensorRT `evaluate`, and TensorRT `inference`), read `references/tao-deploy-metric-learning-recognition.md` first. Deploy spec templates live in this skill's `references/` folder with the `spec_template_deploy_*.yaml` prefix.

## Dataclass Schemas

Generated TAO Core schemas are packaged in `schemas/<action>.schema.json`, with `schemas/manifest.json` listing available actions. Each generated schema also emits `references/spec_template_<action>.yaml` from the schema top-level `default` field. AutoML enablement is declared at the model layer in `references/skill_info.yaml` via `automl_enabled`. Runnable AutoML still requires `schemas/train.schema.json` and `references/spec_template_train.yaml` to exist and parse. Use the packaged train schema for `automl_default_parameters`, `automl_disabled_parameters`, defaults, min/max bounds, enums, option weights, math conditions, dependencies, and popular parameters. Do not expect `~/tao-core` at runtime; maintainers regenerate schemas/templates before packaging the skill bank.

## Train Action Policy

This model is AutoML-enabled at the model layer. Before handling any train-stage request, read `references/skill_info.yaml` and resolve the run override from either an explicit `automl_policy` value or the user's workflow request. Treat phrases like "turn off AutoML", "disable AutoML", "no HPO", or "plain training" as `automl_policy: off` for this run only; otherwise default to `auto`. When `automl_policy: auto`, `automl_enabled: true`, and both `schemas/train.schema.json` and `references/spec_template_train.yaml` are packaged, route the train action through `tao-skill-bank:tao-run-automl` by default with this model's `skill_dir`. Preserve workflow/application overrides for datasets, specs, output directories, GPU/platform settings, parent checkpoints, and `automl_policy`. Use direct model training only when `automl_policy: off` or the packaged train schema/template is missing; in the missing-schema case, report that AutoML is enabled but not runnable for this model until schemas are generated.

Non-train actions such as `evaluate`, `inference`, `export`, and deploy flows stay in this model skill. The per-run `automl_policy` override does not change model metadata.

## Training Requirements

- **Dataset type:** ml_recog
- **Formats:** default
- **Monitoring metric:** val Precision at Rank 1

### Per-Action Dataset Requirements

| Action | Spec Key | Source | Files | List? |
|---|---|---|---|---|
| evaluate | dataset.val_dataset | train_datasets | reference: metric_learning_recognition/retail-product-checkout-dataset_classification_demo/unknown_classes/reference.tar.gz, query: metric_learning_recognition/retail-product-checkout-dataset_classification_demo/unknown_classes/test.tar.gz | No |
| gen_trt_engine | gen_trt_engine.tensorrt.calibration.cal_image_dir | calibration_dataset | metric_learning_recognition/retail-product-checkout-dataset_classification_demo/known_classes/test.tar.gz | Yes |
| inference | dataset.val_dataset | train_datasets | reference: metric_learning_recognition/retail-product-checkout-dataset_classification_demo/unknown_classes/reference.tar.gz, query:  | No |
| inference | inference.input_path | train_datasets | metric_learning_recognition/retail-product-checkout-dataset_classification_demo/unknown_classes/test.tar.gz | No |
| train | dataset.train_dataset | train_datasets | metric_learning_recognition/retail-product-checkout-dataset_classification_demo/known_classes/train.tar.gz | No |
| train | dataset.val_dataset | train_datasets | reference: metric_learning_recognition/retail-product-checkout-dataset_classification_demo/known_classes/reference.tar.gz, query: metric_learning_recognition/retail-product-checkout-dataset_classification_demo/known_classes/val.tar.gz | No |

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
    "dataset.train_dataset": f"{S3_TRAIN}/metric_learning_recognition/retail-product-checkout-dataset_classification_demo/known_classes/train.tar.gz",
    "dataset.val_dataset": {"reference": f"{S3_TRAIN}/metric_learning_recognition/retail-product-checkout-dataset_classification_demo/known_classes/reference.tar.gz", "query": f"{S3_TRAIN}/metric_learning_recognition/retail-product-checkout-dataset_classification_demo/known_classes/val.tar.gz"},
}
```

**gen_trt_engine (mandatory data sources):**
```python
{
    "gen_trt_engine.tensorrt.data_type": "INT8",
    "gen_trt_engine.tensorrt.calibration.cal_image_dir": [f"{S3_TRAIN}/metric_learning_recognition/retail-product-checkout-dataset_classification_demo/known_classes/test.tar.gz"],
}
```

**evaluate (mandatory data sources):**
```python
{
    "dataset.val_dataset": {"reference": f"{S3_TRAIN}/metric_learning_recognition/retail-product-checkout-dataset_classification_demo/unknown_classes/reference.tar.gz", "query": f"{S3_TRAIN}/metric_learning_recognition/retail-product-checkout-dataset_classification_demo/unknown_classes/test.tar.gz"},
}
```

**inference (mandatory data sources):**
```python
{
    "dataset.val_dataset": {"reference": f"{S3_TRAIN}/metric_learning_recognition/retail-product-checkout-dataset_classification_demo/unknown_classes/reference.tar.gz"},
    "inference.input_path": f"{S3_TRAIN}/metric_learning_recognition/retail-product-checkout-dataset_classification_demo/unknown_classes/test.tar.gz",
}
```
## Eval Dataset

Required. Evaluation requires reference and query datasets for retrieval metrics.

## Important Parameters

- **model.backbone**: Default resnet_50. Options: resnet_50, resnet_101, fan_small, fan_base, fan_large, fan_tiny, nvdinov2_vit_large_legacy.
- **model.feat_dim**: Embedding dimension. Default 256. Output feature vector size for similarity matching.
- **train.batch_size**: Per-GPU batch size. Default 4. val_batch_size also 4.
- **dataset.num_instance**: Instances per identity in a batch (P/K sampling). Default 4. Controls how many images of the same class appear together.
- **train.optim.trunk.base_lr**: Learning rate for the trunk (backbone). Default 3.5e-4 (Adam).
- **train.optim.embedder.base_lr**: Learning rate for the embedding head. Default 3.5e-4.
- **train.optim.triplet_loss_margin**: Margin for triplet loss. Default 0.3. smooth_loss=True by default.
- **train.optim.miner_function_margin**: Hard mining margin. Default 0.1. Controls pair mining difficulty.
- **train.optim.steps**: LR decay steps. Default [40, 70] with gamma=0.1.
- **dataset.train_dataset**: Path to training images organized in class folders.
- **dataset.val_dataset**: Dict with 'reference' and 'query' keys pointing to ImageNet-format directories for retrieval evaluation.

## Multi-GPU / Multi-Node

**Launch method:** Lightning-managed (single `python` process, Lightning spawns workers).

| Spec Key | Description | Default |
|----------|-------------|---------|
| `train.num_gpus` | Number of GPUs | 1 |
| `train.gpu_ids` | GPU device indices | [0] |

- Strategy: `auto` (Lightning picks best strategy automatically)
- No explicit `num_nodes` or `distributed_strategy` config — single-node oriented

## Hardware

Minimum 1 GPU(s), recommended 2 GPU(s). 16GB+ VRAM per GPU. Metric learning benefits from larger batch sizes for better triplet sampling but is otherwise moderate on memory.

## Error Patterns

**Reference/query mismatch**: Ensure reference and query datasets share compatible class namespaces for evaluation.

## Spec Param / Parent Model Inference

Model-specific inference mappings belong in this MD file, not in `config.json`. Generated runners should read this section and apply the mappings with SDK helpers before `create_job()`. This mirrors the old microservices `infer_params.py` flow.

Inference mappings from TAO Core `ml_recog.config.json`:

| Action | Spec Field | Inference Function | Meaning |
|---|---|---|---|
| evaluate | `evaluate.checkpoint` | `parent_model` | model file inferred from the parent job results folder |
| evaluate | `evaluate.trt_engine` | `parent_model` | model file inferred from the parent job results folder |
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
| inference | `results_dir` | `output_dir` | current job results directory |
| train | `model.pretrained_model_path` | `ptm_if_no_resume_model` | PTM when no resume checkpoint exists |
| train | `results_dir` | `output_dir` | current job results directory |
| train | `train.resume_training_checkpoint_path` | `resume_model` | model file inferred from the current job results folder |

For `parent_model` or `parent_model_folder`, pass the upstream train/export/AutoML child job id as `parent_job_id`. The SDK lists the parent result folder, filters checkpoint artifacts, and returns the selected model file or folder. Do not add these mappings back to `config.json` and do not patch generated runner scripts to guess checkpoint paths.

## Deployment

- [tao-deploy-metric-learning-recognition](references/tao-deploy-metric-learning-recognition.md) — MLRecog deploy workflow for TensorRT engine generation, TensorRT evaluation, and TensorRT inference using TAO Deploy.
