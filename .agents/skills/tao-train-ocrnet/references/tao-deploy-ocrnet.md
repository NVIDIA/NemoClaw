# OCRNet Deploy

OCRNet deploy covers the TAO Deploy actions for an exported optical character recognition model. Use the `ocrnet` model skill for training, checkpoint evaluation, quantization, distillation, pruning, export, or non-TensorRT inference where those actions exist. Use this deploy workflow after export when the input artifact is an ONNX model and the desired output is a TensorRT engine or TensorRT-backed predictions.

Supported actions: `gen_trt_engine`, `evaluate`, `inference`.

## Quick Start

### Generate TensorRT Engine

```bash
docker run --gpus all --rm --shm-size=16g \
  -v /path/to/specs:/specs \
  -v /path/to/export:/models \
  -v /path/to/results:/results \
  nvcr.io/nvidia/tao/tao-toolkit:6.26.3-deploy \
  ocrnet gen_trt_engine -e /specs/ocrnet_deploy_gen_trt_engine.yaml
```

### Evaluate TensorRT Engine

```bash
docker run --gpus all --rm --shm-size=16g \
  -v /path/to/specs:/specs \
  -v /path/to/eval:/data \
  -v /path/to/results:/results \
  nvcr.io/nvidia/tao/tao-toolkit:6.26.3-deploy \
  ocrnet evaluate -e /specs/ocrnet_deploy_evaluate.yaml
```

### TensorRT Inference

```bash
docker run --gpus all --rm --shm-size=16g \
  -v /path/to/specs:/specs \
  -v /path/to/inference:/data \
  -v /path/to/results:/results \
  nvcr.io/nvidia/tao/tao-toolkit:6.26.3-deploy \
  ocrnet inference -e /specs/ocrnet_deploy_inference.yaml
```

Deploy action metadata is in `tao-deploy-ocrnet.skill_info.yaml`. Deploy spec templates live in this references folder:

- `spec_template_deploy_experiment.yaml`

## Deploy Workflow

1. Train and export with the `ocrnet` skill.
2. Keep the exported ONNX artifact and any sidecar files together in the mounted model directory.
3. Build the TensorRT engine with this workflow.
4. Run TensorRT `evaluate` or `inference` from the engine artifact produced by `gen_trt_engine`.

Direct TAO Launcher spelling is `tao deploy ocrnet gen_trt_engine`, `tao deploy ocrnet evaluate`, `tao deploy ocrnet inference`.

## Required Inputs

| Action | Required artifact or data | Spec key |
|---|---|---|
| `gen_trt_engine` | Exported ONNX model | `gen_trt_engine.onnx_file` |
| `gen_trt_engine` | OCR character list | `dataset.character_list_file` |
| `evaluate` | TensorRT engine | `evaluate.trt_engine` |
| `evaluate` | Test dataset directory | `evaluate.test_dataset_dir` |
| `evaluate` | OCR character list | `dataset.character_list_file` |
| `inference` | TensorRT engine | `inference.trt_engine` |
| `inference` | Inference dataset directory | `inference.inference_dataset_dir` |
| `inference` | OCR character list | `dataset.character_list_file` |

For direct Docker runs, mount input folders at the same paths used in the spec. For chained jobs, map exported ONNX artifacts into `gen_trt_engine.onnx_file` and map the engine artifact into `evaluate.trt_engine` or `inference.trt_engine` where those actions are available.

## Spec Overrides

Carry structural model and dataset settings forward from the train/export spec. The deploy defaults are templates, not a substitute for the model-specific values used to produce the ONNX file.

Recommended starting overrides:

```python
{
    'gen_trt_engine.tensorrt.data_type': 'fp16',
    'dataset.input_width': 100,
    'dataset.input_height': 32,
    'dataset.input_channel': 1,
}
```

Model-specific notes:

- OCRNet deploy uses the shared experiment spec for all three actions.
- Use FP16 for the starter-kit TensorRT engine path when the target hardware supports it.
- Keep `dataset.input_width`, `dataset.input_height`, `dataset.input_channel`, and `dataset.character_list_file` aligned with training/export.

## Job Chain Mapping

| Action | Spec field | Parent or output |
|---|---|---|
| `gen_trt_engine` | `gen_trt_engine.onnx_file` | export job ONNX |
| `gen_trt_engine` | `gen_trt_engine.trt_engine` | new engine output path |
| `evaluate` | `evaluate.trt_engine` | engine job output |
| `inference` | `inference.trt_engine` | engine job output |

## Outputs

| Action | Output |
|---|---|
| `gen_trt_engine` | TensorRT engine under `results_dir` |
| `evaluate` | OCR accuracy metrics under `results_dir` |
| `inference` | Recognized text outputs under `results_dir` |

## Known Pitfalls

**Engine profile mismatch:** Runtime batch size for evaluate or inference must fit within the TensorRT min/opt/max profile used during `gen_trt_engine`.

**Template class or shape mismatch:** Copy class count, input resolution, backbone, and post-processing settings from train/export before running TAO Deploy.

**INT8 calibration missing:** INT8 builds need an extracted calibration image directory, a writable cache path, and enough images for `cal_batch_size * cal_batches`.

**Mounted paths do not exist:** TAO Deploy checks local paths inside the container. Make sure every path in the spec has a matching Docker mount or job artifact mapping.
