# Visual ChangeNet Deploy

Visual ChangeNet deploy covers the TAO Deploy actions for an exported visual change detection model. Use the `visual-changenet` model skill for training, checkpoint evaluation, quantization, distillation, pruning, export, or non-TensorRT inference where those actions exist. Use this deploy workflow after export when the input artifact is an ONNX model and the desired output is a TensorRT engine or TensorRT-backed predictions.

Supported actions: `gen_trt_engine`, `evaluate`, `inference`.
Visual ChangeNet has separate classify and segment deploy spec variants for each action.
Direct TAO Deploy command name: `visual_changenet`.

## Quick Start

Resolve the deploy container URI from `versions.yaml` once at the top of the session — that file is the single source of truth for image tags:

```bash
TAO_DEPLOY_IMAGE=$("${TAO_SKILL_BANK_PATH:?}/scripts/resolve_versions_key.py" images.tao_toolkit.deploy)
```

Every invocation below uses `"$TAO_DEPLOY_IMAGE"` in place of the literal image URI.

### Classify Variant

#### Generate TensorRT Engine

```bash
docker run --gpus all --rm --shm-size=16g \
  -v /path/to/specs:/specs \
  -v /path/to/export:/models \
  -v /path/to/results:/results \
  "$TAO_DEPLOY_IMAGE" \
  visual_changenet gen_trt_engine -e /specs/visual-changenet_deploy_classify_gen_trt_engine.yaml
```

#### Evaluate TensorRT Engine

```bash
docker run --gpus all --rm --shm-size=16g \
  -v /path/to/specs:/specs \
  -v /path/to/eval:/data \
  -v /path/to/results:/results \
  "$TAO_DEPLOY_IMAGE" \
  visual_changenet evaluate -e /specs/visual-changenet_deploy_classify_evaluate.yaml
```

#### TensorRT Inference

```bash
docker run --gpus all --rm --shm-size=16g \
  -v /path/to/specs:/specs \
  -v /path/to/inference:/data \
  -v /path/to/results:/results \
  "$TAO_DEPLOY_IMAGE" \
  visual_changenet inference -e /specs/visual-changenet_deploy_classify_inference.yaml
```

### Segment Variant

#### Generate TensorRT Engine

```bash
docker run --gpus all --rm --shm-size=16g \
  -v /path/to/specs:/specs \
  -v /path/to/export:/models \
  -v /path/to/results:/results \
  "$TAO_DEPLOY_IMAGE" \
  visual_changenet gen_trt_engine -e /specs/visual-changenet_deploy_segment_gen_trt_engine.yaml
```

#### Evaluate TensorRT Engine

```bash
docker run --gpus all --rm --shm-size=16g \
  -v /path/to/specs:/specs \
  -v /path/to/eval:/data \
  -v /path/to/results:/results \
  "$TAO_DEPLOY_IMAGE" \
  visual_changenet evaluate -e /specs/visual-changenet_deploy_segment_evaluate.yaml
```

#### TensorRT Inference

```bash
docker run --gpus all --rm --shm-size=16g \
  -v /path/to/specs:/specs \
  -v /path/to/inference:/data \
  -v /path/to/results:/results \
  "$TAO_DEPLOY_IMAGE" \
  visual_changenet inference -e /specs/visual-changenet_deploy_segment_inference.yaml
```

Deploy action metadata is in `tao-deploy-visual-changenet.skill_info.yaml`. Deploy spec templates live in this references folder:

- `spec_template_deploy_classify_gen_trt_engine.yaml` (classify `gen_trt_engine`)
- `spec_template_deploy_classify_evaluate.yaml` (classify `evaluate`)
- `spec_template_deploy_classify_inference.yaml` (classify `inference`)
- `spec_template_deploy_segment_gen_trt_engine.yaml` (segment `gen_trt_engine`)
- `spec_template_deploy_segment_evaluate.yaml` (segment `evaluate`)
- `spec_template_deploy_segment_inference.yaml` (segment `inference`)

## Deploy Workflow

1. Train and export with the `visual-changenet` skill.
2. Keep the exported ONNX artifact and any sidecar files together in the mounted model directory.
3. Build the TensorRT engine with this workflow.
4. Run TensorRT `evaluate` or `inference` from the engine artifact produced by `gen_trt_engine`.

Direct TAO Launcher spelling is `tao deploy visual_changenet gen_trt_engine`, `tao deploy visual_changenet evaluate`, `tao deploy visual_changenet inference`.

## Required Inputs

| Action | Required artifact or data | Spec key |
|---|---|---|
| `gen_trt_engine` | Exported ONNX model | `gen_trt_engine.onnx_file` |
| `gen_trt_engine` | Output engine path | `gen_trt_engine.trt_engine` |
| `gen_trt_engine` | Variant dataset section | `dataset.classify or dataset.segment` |
| `evaluate` | TensorRT engine | `evaluate.trt_engine` |
| `evaluate` | Classify CSV/images or segment root | `dataset.classify.test_dataset or dataset.segment.root_dir` |
| `inference` | TensorRT engine | `inference.trt_engine` |
| `inference` | Classify CSV/images or segment root | `dataset.classify.infer_dataset or dataset.segment.root_dir` |

For direct Docker runs, mount input folders at the same paths used in the spec. For chained jobs, map exported ONNX artifacts into `gen_trt_engine.onnx_file` and map the engine artifact into `evaluate.trt_engine` or `inference.trt_engine` where those actions are available.

## Spec Overrides

Carry structural model and dataset settings forward from the train/export spec. The deploy defaults are templates, not a substitute for the model-specific values used to produce the ONNX file.

Recommended starting overrides:

```python
{
    'segment.gen_trt_engine.tensorrt.data_type': 'fp16',
    'segment.dataset.segment.batch_size': 1,
    'classify.dataset.classify.num_input': 4,
    'classify.dataset.classify.concat_type': 'linear',
}
```

Model-specific notes:

- Visual ChangeNet deploy has classify and segment spec variants under the same TAO Deploy command.
- The starter-kit segment TensorRT path uses FP16; classify can use FP32 unless a precision target is specified.
- For segment inference, keep `dataset.segment.batch_size: 1`; for classify, keep image maps, concat type, and grid map aligned with training.

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
| `gen_trt_engine` | TensorRT engine at `gen_trt_engine.trt_engine` |
| `evaluate` | Change detection metrics or CSV under `results_dir` |
| `inference` | Change detection predictions under `results_dir` |

## Known Pitfalls

**Engine profile mismatch:** Runtime batch size for evaluate or inference must fit within the TensorRT min/opt/max profile used during `gen_trt_engine`.

**Template class or shape mismatch:** Copy class count, input resolution, backbone, and post-processing settings from train/export before running TAO Deploy.

**INT8 calibration missing:** INT8 builds need an extracted calibration image directory, a writable cache path, and enough images for `cal_batch_size * cal_batches`.

**Mounted paths do not exist:** TAO Deploy checks local paths inside the container. Make sure every path in the spec has a matching Docker mount or job artifact mapping.
