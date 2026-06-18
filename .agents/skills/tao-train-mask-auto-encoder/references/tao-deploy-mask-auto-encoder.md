# MAE Deploy

MAE deploy covers the TAO Deploy actions for an exported self-supervised representation model. Use the `mae` model skill for training, checkpoint evaluation, quantization, distillation, export, or inference where those actions exist. Use this deploy workflow after export when the input artifact is an ONNX model and the desired output is a TensorRT engine.

Supported actions: `gen_trt_engine`.

## Quick Start

### Generate TensorRT Engine

```bash
docker run --gpus all --rm --shm-size=16g \
  -v /path/to/specs:/specs \
  -v /path/to/export:/models \
  -v /path/to/results:/results \
  nvcr.io/nvidia/tao/tao-toolkit:6.26.3-deploy \
  mae gen_trt_engine -e /specs/mae_deploy_gen_trt_engine.yaml
```

Deploy action metadata is in `tao-deploy-mask-auto-encoder.skill_info.yaml`. Deploy spec templates live in this references folder:

- `spec_template_deploy_gen_trt_engine.yaml`

## Deploy Workflow

1. Train and export with the `mae` skill.
2. Keep the exported ONNX artifact and any sidecar files together in the mounted model directory.
3. Build the TensorRT engine with this workflow.

Direct TAO Launcher spelling is `tao deploy mae gen_trt_engine`.

## Required Inputs

| Action | Required artifact or data | Spec key |
|---|---|---|
| `gen_trt_engine` | Exported ONNX model | `gen_trt_engine.onnx_file` |
| `gen_trt_engine` | Output engine path | `gen_trt_engine.trt_engine` |

For direct Docker runs, mount input folders at the same paths used in the spec. For chained jobs, map exported ONNX artifacts into `gen_trt_engine.onnx_file` and create the engine artifact at `gen_trt_engine.trt_engine`.

## Spec Overrides

Carry structural model and dataset settings forward from the train/export spec. The deploy defaults are templates, not a substitute for the model-specific values used to produce the ONNX file.

Recommended starting overrides:

```python
{
    'gen_trt_engine.tensorrt.data_type': 'fp32',
    'gen_trt_engine.tensorrt.min_batch_size': 1,
    'gen_trt_engine.tensorrt.opt_batch_size': 4,
    'gen_trt_engine.tensorrt.max_batch_size': 8,
}
```

Model-specific notes:

- TAO Deploy exposes `gen_trt_engine` for MAE; evaluate and inference stay in the MAE workflow.
- Keep `model.num_classes`, image size, and batch profile aligned with the exported MAE ONNX model.

## Job Chain Mapping

| Action | Spec field | Parent or output |
|---|---|---|
| `gen_trt_engine` | `gen_trt_engine.onnx_file` | export job ONNX |
| `gen_trt_engine` | `gen_trt_engine.trt_engine` | new engine output path |

## Outputs

| Action | Output |
|---|---|
| `gen_trt_engine` | TensorRT engine at `gen_trt_engine.trt_engine` |

## Known Pitfalls

**Engine profile mismatch:** Any downstream runtime batch size must fit within the TensorRT min/opt/max profile used during `gen_trt_engine`.

**Template class or shape mismatch:** Copy class count, input resolution, backbone, and post-processing settings from train/export before running TAO Deploy.

**INT8 calibration missing:** INT8 builds need an extracted calibration image directory, a writable cache path, and enough images for `cal_batch_size * cal_batches`.

**Mounted paths do not exist:** TAO Deploy checks local paths inside the container. Make sure every path in the spec has a matching Docker mount or job artifact mapping.
