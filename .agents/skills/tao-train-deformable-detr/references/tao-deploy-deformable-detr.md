# Deformable DETR Deploy

Deformable DETR deploy covers the TAO Deploy actions for an exported object detection model. Use the `deformable-detr` model skill for training, checkpoint evaluation, quantization, distillation, pruning, export, or non-TensorRT inference where those actions exist. Use this deploy workflow after export when the input artifact is an ONNX model and the desired output is a TensorRT engine or TensorRT-backed predictions.

Supported actions: `gen_trt_engine`, `evaluate`, `inference`.

## Quick Start

### Generate TensorRT Engine

```bash
docker run --gpus all --rm --shm-size=16g \
  -v /path/to/specs:/specs \
  -v /path/to/export:/models \
  -v /path/to/results:/results \
  nvcr.io/nvidia/tao/tao-toolkit:6.26.3-deploy \
  deformable_detr gen_trt_engine -e /specs/deformable-detr_deploy_gen_trt_engine.yaml
```

### Evaluate TensorRT Engine

```bash
docker run --gpus all --rm --shm-size=16g \
  -v /path/to/specs:/specs \
  -v /path/to/eval:/data \
  -v /path/to/results:/results \
  nvcr.io/nvidia/tao/tao-toolkit:6.26.3-deploy \
  deformable_detr evaluate -e /specs/deformable-detr_deploy_evaluate.yaml
```

### TensorRT Inference

```bash
docker run --gpus all --rm --shm-size=16g \
  -v /path/to/specs:/specs \
  -v /path/to/inference:/data \
  -v /path/to/results:/results \
  nvcr.io/nvidia/tao/tao-toolkit:6.26.3-deploy \
  deformable_detr inference -e /specs/deformable-detr_deploy_inference.yaml
```

Deploy action metadata is in `tao-deploy-deformable-detr.skill_info.yaml`. Deploy spec templates live in this references folder:

- `spec_template_deploy_gen_trt_engine.yaml`
- `spec_template_deploy_evaluate.yaml`
- `spec_template_deploy_inference.yaml`

## Deploy Workflow

1. Train and export with the `deformable-detr` skill.
2. Keep the exported ONNX artifact and any sidecar files together in the mounted model directory.
3. Build the TensorRT engine with this workflow.
4. Run TensorRT `evaluate` or `inference` from the engine artifact produced by `gen_trt_engine`.

Direct TAO Launcher spelling is `tao deploy deformable_detr gen_trt_engine`, `tao deploy deformable_detr evaluate`, `tao deploy deformable_detr inference`.

## Required Inputs

| Action | Required artifact or data | Spec key |
|---|---|---|
| `gen_trt_engine` | Exported ONNX model | `gen_trt_engine.onnx_file` |
| `gen_trt_engine` | Output engine path | `gen_trt_engine.trt_engine` |
| `evaluate` | TensorRT engine | `evaluate.trt_engine` |
| `evaluate` | COCO eval image folder | `dataset.test_data_sources.image_dir` |
| `evaluate` | COCO eval annotations | `dataset.test_data_sources.json_file` |
| `inference` | TensorRT engine | `inference.trt_engine` |
| `inference` | Inference image folder list | `dataset.infer_data_sources.image_dir` |
| `inference` | Class map text file | `dataset.infer_data_sources.classmap` |

For direct Docker runs, mount input folders at the same paths used in the spec. For chained jobs, map exported ONNX artifacts into `gen_trt_engine.onnx_file` and map the engine artifact into `evaluate.trt_engine` or `inference.trt_engine` where those actions are available.

## Spec Overrides

Carry structural model and dataset settings forward from the train/export spec. The deploy defaults are templates, not a substitute for the model-specific values used to produce the ONNX file.

Recommended starting overrides:

```python
{
    'dataset.num_classes': '<object classes> + 1',
    'gen_trt_engine.tensorrt.data_type': 'FP16',
    'gen_trt_engine.batch_size': -1,
    'dataset.batch_size': 1,
}
```

Model-specific notes:

- Carry `dataset.num_classes` as object classes plus background, matching train/export.
- Use FP16 for the starter-kit TensorRT engine path; INT8 requires a real calibration image folder and cache path.
- Keep transformer structure fields such as `model.num_queries`, `model.num_feature_levels`, `model.enc_layers`, and `model.dec_layers` aligned with export.

## Job Chain Mapping

| Action | Spec field | Parent or output |
|---|---|---|
| `gen_trt_engine` | `gen_trt_engine.onnx_file` | export job ONNX |
| `gen_trt_engine` | `gen_trt_engine.trt_engine` | new engine output path |
| `gen_trt_engine` INT8 | calibration image/cache fields | calibration dataset and new cache output |
| `evaluate` | `evaluate.trt_engine` | engine job output |
| `inference` | `inference.trt_engine` | engine job output |

## Outputs

| Action | Output |
|---|---|
| `gen_trt_engine` | TensorRT engine at `gen_trt_engine.trt_engine` |
| `evaluate` | COCO metrics under `results_dir` |
| `inference` | Annotated images and labels under `results_dir` |

## Known Pitfalls

**Engine profile mismatch:** Runtime batch size for evaluate or inference must fit within the TensorRT min/opt/max profile used during `gen_trt_engine`.

**Template class or shape mismatch:** Copy class count, input resolution, backbone, and post-processing settings from train/export before running TAO Deploy.

**INT8 calibration missing:** INT8 builds need an extracted calibration image directory, a writable cache path, and enough images for `cal_batch_size * cal_batches`.

**Mounted paths do not exist:** TAO Deploy checks local paths inside the container. Make sure every path in the spec has a matching Docker mount or job artifact mapping.
