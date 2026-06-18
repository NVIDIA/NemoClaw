# DINO Spec Overrides and Dataset Sources

This document gives the per-action dataset requirements, the mandatory
`spec_overrides` blocks for every DINO action, the dataset format details, and
the parameter/default reference for building DINO specs.

## Per-Action Dataset Requirements

| Action | Spec Key | Source | Files | List? |
|---|---|---|---|---|
| distill | dataset.train_data_sources | train_datasets | image_dir: images.tar.gz, json_file: annotations.json | Yes |
| distill | dataset.val_data_sources | train_datasets | image_dir: images.tar.gz, json_file: annotations.json | Yes |
| evaluate | evaluate.checkpoint | trained_model | DINO .pth/.tlt checkpoint | No |
| evaluate | dataset.test_data_sources.image_dir | eval_dataset | images.tar.gz | No |
| evaluate | dataset.test_data_sources.json_file | eval_dataset | annotations.json | No |
| gen_trt_engine | gen_trt_engine.tensorrt.calibration.cal_image_dir | calibration_dataset | images.tar.gz | Yes |
| inference | dataset.infer_data_sources.image_dir | inference_dataset | images.tar.gz | Yes |
| inference | dataset.infer_data_sources.classmap | inference_dataset | label_map.txt | No |
| quantize | dataset.train_data_sources | train_datasets | image_dir: images.tar.gz, json_file: annotations.json | Yes |
| quantize | dataset.val_data_sources | train_datasets | image_dir: images.tar.gz, json_file: annotations.json | Yes |
| quantize | dataset.quant_calibration_data_sources | train_datasets | image_dir: images.tar.gz, json_file: annotations.json | No |
| train | dataset.train_data_sources | train_datasets | image_dir: images.tar.gz, json_file: annotations.json | Yes |
| train | dataset.val_data_sources | train_datasets | image_dir: images.tar.gz, json_file: annotations.json | Yes |

## Typical Spec Overrides

Data source overrides are **mandatory for every action** — DINO's `config.json` has empty `data_sources` because the runner cannot auto-resolve array-of-objects spec keys (see `sdk_orchestration.md`). The agent MUST construct data source paths from the Per-Action Dataset Requirements table above and include them in `spec_overrides`.

```python
S3_TRAIN = "s3://bucket/data/train"
S3_VAL = "s3://bucket/data/val"    # can be same as S3_TRAIN
S3_EVAL = "s3://bucket/data/eval"  # for evaluate/inference

# Standard DINO dataset artifact. Pass the archive path as the remote input.
# At runtime the SDK extracts it and points DINO at the extracted "images" folder.
IMAGE_ARCHIVE = "images.tar.gz"
```

**train (mandatory):**
```python
{
    "dataset.train_data_sources": [
        {"image_dir": f"{S3_TRAIN}/{IMAGE_ARCHIVE}", "json_file": f"{S3_TRAIN}/annotations.json"}
    ],
    "dataset.val_data_sources": [
        {"image_dir": f"{S3_VAL}/{IMAGE_ARCHIVE}", "json_file": f"{S3_VAL}/annotations.json"}
    ],
    "dataset.num_classes": "<num_classes> + 1",
    "train.num_epochs": 10,
    "train.checkpoint_interval": 10,
    "train.validation_interval": 10,
    "train.num_gpus": 1,
}
```

**evaluate (mandatory checkpoint + data sources):**
```python
{
    "evaluate.checkpoint": "<checkpoint_uri>",
    "dataset.test_data_sources.image_dir": f"{S3_EVAL}/{IMAGE_ARCHIVE}",
    "dataset.test_data_sources.json_file": f"{S3_EVAL}/annotations.json",
    "dataset.num_classes": "<num_classes> + 1",
    "model.backbone": "<backbone used for training>",
    "model.num_queries": "<num_queries used for training>",
    "model.dropout_ratio": "<dropout_ratio used for training>",
}
```

For standard DINO eval datasets, do not search S3 to discover filenames. Build
the eval image and annotation URIs directly from the eval dataset base URI using
`images.tar.gz` and `annotations.json`, unless the user explicitly provides a
different layout.

For a DINO model trained by this SDK or by an AutoML child train job, prefer
microservices-style parent model inference instead of hardcoding the checkpoint
URI. Use this model-MD inference mapping:

```json
"spec_params": {
  "evaluate": {
    "evaluate.checkpoint": "parent_model"
  }
}
```

Use the train job id, or the AutoML best child train job id, as
`parent_job_id`. The SDK will list the parent result folder, filter `.pth`
checkpoints, and select the model file:

```python
checkpoint_uri = sdk.resolve_spec_param(
    eval_job_id,
    "parent_model",
    network_arch="dino",
    parent_job_id=train_job_id,
)
```

Equivalently, when resolving the checkpoint outside a spec-param loop:

```python
checkpoint_uri = sdk.get_model_results_path(train_job_id, network_arch="dino")
```

If cloud listing is unavailable but only the training job id is known, the
expected DINO fallback location is:

```python
checkpoint_uri = f"s3://{S3_BUCKET_NAME}/results/{train_job_id}/results_dir/train/dino_model_latest.pth"
```

Do not use `s3://<bucket>/results/<train_job_id>/dino_model_latest.pth`; DINO
training uploads checkpoints under `results_dir/train/`.

When evaluating an AutoML-trained model, carry forward the winning rec's
structural model settings into the eval spec. At minimum copy
`model.backbone`, `model.num_queries`, `model.dropout_ratio`, and
`dataset.num_classes`. If future HPO runs tune additional structural model
fields, copy those too so the checkpoint shape matches the evaluation model.

**export:**
```python
{
    "dataset.num_classes": "<num_classes> + 1",
}
```

**gen_trt_engine (mandatory data sources):**
```python
{
    "gen_trt_engine.tensorrt.calibration.cal_image_dir": [f"{S3_TRAIN}/{IMAGE_ARCHIVE}"],
    "gen_trt_engine.tensorrt.data_type": "FP16",
    "dataset.num_classes": "<num_classes> + 1",
}
```

**inference (mandatory data sources):**
```python
{
    "dataset.infer_data_sources.image_dir": [f"{S3_EVAL}/{IMAGE_ARCHIVE}"],
    "dataset.infer_data_sources.classmap": f"{S3_EVAL}/label_map.txt",
    "dataset.num_classes": "<num_classes> + 1",
}
```

**quantize (mandatory data sources):**
```python
{
    "dataset.train_data_sources": [
        {"image_dir": f"{S3_TRAIN}/{IMAGE_ARCHIVE}", "json_file": f"{S3_TRAIN}/annotations.json"}
    ],
    "dataset.val_data_sources": [
        {"image_dir": f"{S3_VAL}/{IMAGE_ARCHIVE}", "json_file": f"{S3_VAL}/annotations.json"}
    ],
    "dataset.quant_calibration_data_sources": {
        "image_dir": f"{S3_TRAIN}/{IMAGE_ARCHIVE}", "json_file": f"{S3_TRAIN}/annotations.json"
    },
    "dataset.num_classes": "<num_classes> + 1",
}
```

**distill (mandatory data sources):**
```python
{
    "dataset.train_data_sources": [
        {"image_dir": f"{S3_TRAIN}/{IMAGE_ARCHIVE}", "json_file": f"{S3_TRAIN}/annotations.json"}
    ],
    "dataset.val_data_sources": [
        {"image_dir": f"{S3_VAL}/{IMAGE_ARCHIVE}", "json_file": f"{S3_VAL}/annotations.json"}
    ],
    "dataset.num_classes": "<num_classes> + 1",
}
```

## Dataset

COCO JSON format. train_data_sources and val_data_sources are lists supporting multiple data source entries. Each entry has image_dir and json_file (COCO annotations JSON).

**`image_dir` remote path**: For the standard TAO DINO dataset, set
`image_dir` to the archive path, e.g. `s3://bucket/data/images.tar.gz`.
The SDK downloads and extracts it, then rewrites the runtime training spec to
the extracted folder path, e.g. `/mnt/lustre/.../images`.

Do not ask the user whether to use `images` or `images.tar.gz` for standard
DINO datasets. Use `images.tar.gz`. If the user explicitly supplies a different
archive filename, derive the runtime folder from the archive stem:
`<name>.tar.gz` -> `<name>`, `<name>.tgz` -> `<name>`, `<name>.tar` -> `<name>`.

Supported formats: coco, coco_raw.

### Train Data Sources

- **image_dir**: `images.tar.gz` remote archive; runtime folder is `images`
- **json_file**: `annotations.json`

### Val Data Sources (ALWAYS required)

- **image_dir**: `images.tar.gz` remote archive; runtime folder is `images`
- **json_file**: `annotations.json`

### Inference Data Sources

- **image_dir**: `images.tar.gz` remote archive; runtime folder is `images`
- **classmap**: `label_map.txt`

### Evaluate Data Sources

- **checkpoint**: `evaluate.checkpoint`, a `.pth` or `.tlt` model file. For SDK
  train jobs and AutoML child train jobs, resolve it with `parent_model`
  inference so the SDK lists the result folder and selects an actual checkpoint
  file. If listing is unavailable, fall back to
  `results_dir/train/dino_model_latest.pth` under the training job's uploaded
  result directory.
- **image_dir**: `images.tar.gz` remote archive; runtime folder is `images`
- **json_file**: `annotations.json`

## Important Parameters

- **dataset.num_classes**: Number of object classes. Default is 91 (COCO). Must be >= `max(category_id) + 1`. Too low causes `CUDA error: device-side assert triggered`.
- **model.backbone**: Backbone architecture. Default resnet_50. Supported: resnet_34, resnet_50, fan_small_12_p4_hybrid, fan_base_16_p4_hybrid, fan_large_16_p4_hybrid, gcvit_tiny, gcvit_small, gcvit_base, gcvit_large, nvdinov2_vit_large_legacy, swin_tiny_224_1k, swin_small_224_1k, swin_base_224_22k, swin_large_224_22k, efficientvit_l2_224, efficientvit_l2_384.
- **train.optim.lr**: Learning rate. Default 2e-4 (AdamW). lr_backbone defaults to 2e-5 (10x lower). Reduce both if training diverges.
- **train.num_epochs**: DINO typically needs 30-50+ epochs for good mAP on real datasets. The default of 10 is suitable for quick iteration.
- **train.optim.lr_steps**: MultiStep LR decay schedule. Default [11]. For longer training, set to e.g. [30, 40] for a 50-epoch run.
- **model.num_queries**: Number of object queries. Default 300. Increase for dense scenes with many objects per image. num_select must be < num_queries * num_classes.
- **dataset.batch_size**: Per-GPU batch size. Default 4. Reduce to 2 if OOM on 16GB GPUs. Total batch = batch_size * num_gpus.

## Default Values

- **num_epochs**: `10`
- **batch_size**: `4`
- **learning_rate**: `2e-4`
- **lr_backbone**: `2e-5`
- **num_classes**: `91`
- **backbone**: `resnet_50`

## Evaluate Defaults

Use `spec_template_evaluate.yaml` (when present) as the base spec
for `action="evaluate"`, then apply the mandatory checkpoint and data-source
overrides above. `skill_info.yaml` declares the required evaluate
inputs so the SDK script runner downloads and rewrites them before running
the container. The DINO model also documents
`evaluate.checkpoint = parent_model`, so generated runners should infer the
checkpoint from the parent job result files before submission:

```json
{
  "evaluate.checkpoint": {"type": "file"},
  "dataset.test_data_sources.image_dir": {"type": "file"},
  "dataset.test_data_sources.json_file": {"type": "file"}
}
```

## Export Defaults

- **input_width**: `640`
- **input_height**: `640`
- **opset_version**: `17`
- **trt_data_types**: `[FP32, FP16, INT8]`
- **trt_workspace_size_mb**: `1024`

## Hardware

- **Minimum**: 1 GPU
- **Recommended**: 4 GPUs
- **GPU Memory**: 24GB+ (A100 recommended)

Transformer-based detection is memory-intensive. batch_size=4 fits on 24GB GPUs. For 16GB GPUs, reduce to batch_size=2. Multi-GPU with 4+ GPUs recommended for datasets > 10k images.
