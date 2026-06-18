# DINO Deploy

DINO deploy covers the TAO Deploy actions for a trained and exported DINO object
detector. Use the `dino` model skill for train, checkpoint evaluation,
quantize, distill, and export. Use this deploy workflow after export when the
input artifact is an ONNX model and the desired output is a TensorRT engine or
TensorRT-backed predictions.

Supported actions: `gen_trt_engine`, `evaluate`, `inference`.

## Quick Start

### Generate TensorRT Engine

```bash
docker run --gpus all --rm --shm-size=16g \
  -v /path/to/specs:/specs \
  -v /path/to/export:/models \
  -v /path/to/results:/results \
  nvcr.io/nvidia/tao/tao-toolkit:6.26.3-deploy \
  dino gen_trt_engine -e /specs/dino_deploy_gen_trt_engine.yaml
```

### Evaluate TensorRT Engine

```bash
docker run --gpus all --rm --shm-size=16g \
  -v /path/to/specs:/specs \
  -v /path/to/eval/images:/data/images \
  -v /path/to/eval/annotations.json:/data/annotations.json \
  -v /path/to/results:/results \
  nvcr.io/nvidia/tao/tao-toolkit:6.26.3-deploy \
  dino evaluate -e /specs/dino_deploy_evaluate.yaml
```

### TensorRT Inference

```bash
docker run --gpus all --rm --shm-size=16g \
  -v /path/to/specs:/specs \
  -v /path/to/infer/images:/data/images \
  -v /path/to/label_map.txt:/data/label_map.txt \
  -v /path/to/results:/results \
  nvcr.io/nvidia/tao/tao-toolkit:6.26.3-deploy \
  dino inference -e /specs/dino_deploy_inference.yaml
```

Deploy action metadata is in `tao-deploy-dino.skill_info.yaml`. Deploy spec templates live in
this references folder:

- `spec_template_deploy_gen_trt_engine.yaml`
- `spec_template_deploy_evaluate.yaml`
- `spec_template_deploy_inference.yaml`

## Deploy Workflow

1. Train DINO with the `dino` skill.
2. Export the trained checkpoint to ONNX with the `dino` skill. Keep any
   ONNX sidecar files in the same directory as the ONNX file.
3. Build a TensorRT engine with this workflow's `gen_trt_engine` action.
4. Run TensorRT `evaluate` or `inference` with this workflow. For TensorRT
   inference, use the engine job as the parent artifact, not the train job.

Direct TAO Launcher spelling is `tao deploy dino gen_trt_engine`,
`tao deploy dino evaluate`, and `tao deploy dino inference`.

## Required Inputs

| Action | Required artifact | Spec key |
|---|---|---|
| `gen_trt_engine` | Exported DINO ONNX model | `gen_trt_engine.onnx_file` |
| `gen_trt_engine` | Output engine path | `gen_trt_engine.trt_engine` |
| `gen_trt_engine` INT8 only | Calibration image folder | `gen_trt_engine.tensorrt.calibration.cal_image_dir` |
| `gen_trt_engine` INT8 only | Calibration cache output path | `gen_trt_engine.tensorrt.calibration.cal_cache_file` |
| `evaluate` | TensorRT engine | `evaluate.trt_engine` |
| `evaluate` | COCO eval image folder | `dataset.test_data_sources.image_dir` |
| `evaluate` | COCO eval annotations | `dataset.test_data_sources.json_file` |
| `inference` | TensorRT engine | `inference.trt_engine` |
| `inference` | Image folder list | `dataset.infer_data_sources.image_dir` |
| `inference` | Class map text file | `dataset.infer_data_sources.classmap` |

For direct Docker runs, image inputs must be mounted as folders because TAO
Deploy checks local directories. In microservice-style job chains, standard DINO
dataset artifacts may be supplied as `images.tar.gz`; the platform layer
downloads and extracts the archive before invoking TAO Deploy.

## Spec Overrides

The deploy defaults are not safe to reuse blindly. Carry forward the structural
settings from the training/export spec, especially:

```python
{
    "dataset.num_classes": "<object classes> + 1",
    "model.backbone": "<backbone used for train/export>",
    "model.num_queries": "<num_queries used for train/export>",
    "model.num_select": "<num_select used for train/export>",
    "model.num_feature_levels": "<num_feature_levels used for train/export>",
    "model.enc_layers": "<enc_layers used for train/export>",
    "model.dec_layers": "<dec_layers used for train/export>",
    "model.dropout_ratio": "<dropout_ratio used for train/export>",
    "model.dim_feedforward": "<dim_feedforward used for train/export>",
}
```

Recommended `gen_trt_engine` starting overrides:

```python
{
    "gen_trt_engine.onnx_file": "/models/model.onnx",
    "gen_trt_engine.trt_engine": "/results/dino.engine",
    "gen_trt_engine.tensorrt.data_type": "FP16",
    "gen_trt_engine.tensorrt.min_batch_size": 1,
    "gen_trt_engine.tensorrt.opt_batch_size": 1,
    "gen_trt_engine.tensorrt.max_batch_size": 8,
    "gen_trt_engine.batch_size": -1,
}
```

Use `FP16` by default. The upstream deploy default is INT8, but INT8 requires a
real extracted calibration image directory, a calibration cache path, positive
`cal_batch_size`, positive `cal_batches`, and at least
`cal_batch_size * cal_batches` calibration images.

Recommended `evaluate` overrides:

```python
{
    "evaluate.trt_engine": "/results/dino.engine",
    "dataset.test_data_sources.image_dir": "/data/eval/images",
    "dataset.test_data_sources.json_file": "/data/eval/annotations.json",
    "dataset.batch_size": 1,
    "dataset.eval_class_ids": [1],
    "evaluate.conf_threshold": 0.0,
}
```

Set `dataset.eval_class_ids` to the COCO category ids you want scored. The
template default `[1]` is only a placeholder.

Recommended `inference` overrides:

```python
{
    "inference.trt_engine": "/results/dino.engine",
    "dataset.infer_data_sources.image_dir": ["/data/infer/images"],
    "dataset.infer_data_sources.classmap": "/data/infer/label_map.txt",
    "dataset.batch_size": 1,
    "inference.conf_threshold": 0.5,
}
```

`label_map.txt` must contain one class name per line. Class ids are assigned
starting at 1 in file order.

## Job Chain Mapping

When generating a chained job runner, infer parent artifacts as follows:

| Action | Spec field | Parent |
|---|---|---|
| `gen_trt_engine` | `gen_trt_engine.onnx_file` | export job ONNX |
| `gen_trt_engine` | `gen_trt_engine.trt_engine` | new engine output path |
| `gen_trt_engine` | `gen_trt_engine.tensorrt.calibration.cal_cache_file` | new calibration cache output path |
| `evaluate` | `evaluate.trt_engine` | engine job output |
| `inference` | `inference.trt_engine` | engine job output |

For regular DINO inference from a trained checkpoint, use the `dino` skill. This deploy workflow's `inference` action expects
`inference.trt_engine`.

## Outputs

| Action | Output |
|---|---|
| `gen_trt_engine` | TensorRT engine at `gen_trt_engine.trt_engine` |
| `evaluate` | COCO metrics in `<results_dir>/results.json` |
| `inference` | Annotated images in `<results_dir>/images_annotated` and labels in `<results_dir>/labels` |

## Important Parameters

- **`gen_trt_engine.tensorrt.data_type`**: `FP32`, `FP16`, or `INT8`. Prefer
  `FP16` unless INT8 calibration is explicitly requested.
- **`gen_trt_engine.tensorrt.workspace_size`**: MB of TensorRT workspace. Very
  large ViT backbones need a larger workspace; DINO deploy raises the workspace
  for `vit_large_dinov2` when needed.
- **`gen_trt_engine.tensorrt.min_batch_size` / `opt_batch_size` / `max_batch_size`**:
  Dynamic profile bounds. Runtime `dataset.batch_size` for evaluate/inference
  must fit within the engine profile.
- **`dataset.num_classes`**: Must match train/export and should be
  `max(category_id) + 1` for COCO-style ids.
- **`model.num_select`**: Top-K boxes selected during post-processing. Keep it
  less than `model.num_queries * dataset.num_classes`.
- **`dataset.augmentation.input_mean` / `input_std`**: Keep these aligned with
  training/export preprocessing.

## Known Pitfalls

**Engine build uses the wrong shape or class count:** The deploy default spec is
not the training default. Copy structural values from the export spec before
building the engine.

**INT8 calibration fails with a missing directory:** TAO Deploy expects
`cal_image_dir` entries to be local directories at runtime. Mount or extract the
calibration images before invoking Docker.

**`Number of calibration images ... should be larger`:** Reduce
`cal_batch_size` or `cal_batches`, or provide more calibration images.

**TensorRT inference cannot find the engine:** Chain inference from the
`gen_trt_engine` output. The train/export job does not produce
`inference.trt_engine`.

**No detections are drawn:** Check `inference.conf_threshold`, class-map order,
and `dataset.num_classes`. For quick inspection, lower the threshold.
