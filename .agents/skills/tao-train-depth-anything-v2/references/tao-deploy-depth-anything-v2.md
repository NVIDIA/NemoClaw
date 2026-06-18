# DepthNet Mono Deploy

DepthNet Mono deploy covers the TAO Deploy actions for an exported monocular depth estimation model. Use the `depth-net-mono` model skill for training, checkpoint evaluation, quantization, distillation, pruning, export, or non-TensorRT inference where those actions exist. Use this deploy workflow after export when the input artifact is an ONNX model and the desired output is a TensorRT engine or TensorRT-backed predictions.

Supported actions: `gen_trt_engine`, `evaluate`, `inference`.
Direct TAO Deploy command name: `depth_net`.

## Quick Start

### Generate TensorRT Engine

```bash
docker run --gpus all --rm --shm-size=16g \
  -v /path/to/specs:/specs \
  -v /path/to/export:/models \
  -v /path/to/results:/results \
  nvcr.io/nvidia/tao/tao-toolkit:6.26.3-deploy \
  depth_net gen_trt_engine -e /specs/gen_trt_engine.yaml
```

### Evaluate TensorRT Engine

```bash
docker run --gpus all --rm --shm-size=16g \
  -v /path/to/specs:/specs \
  -v /path/to/eval:/data \
  -v /path/to/results:/results \
  nvcr.io/nvidia/tao/tao-toolkit:6.26.3-deploy \
  depth_net evaluate -e /specs/evaluate.yaml
```

### TensorRT Inference

```bash
docker run --gpus all --rm --shm-size=16g \
  -v /path/to/specs:/specs \
  -v /path/to/inference:/data \
  -v /path/to/results:/results \
  nvcr.io/nvidia/tao/tao-toolkit:6.26.3-deploy \
  depth_net inference -e /specs/inference.yaml
```

Deploy action metadata is in `tao-deploy-depth-anything-v2.skill_info.yaml`. Deploy spec template lives in this references folder:

- `spec_template_deploy.yaml`

## Deploy Workflow

1. Train and export with the `depth-net-mono` skill.
2. Keep the exported ONNX artifact and any sidecar files together in the mounted model directory.
3. Build the TensorRT engine with this workflow.
4. Run TensorRT `evaluate` or `inference` from the engine artifact produced by `gen_trt_engine`.

Direct TAO Launcher spelling is `tao deploy depth_net gen_trt_engine`, `tao deploy depth_net evaluate`, `tao deploy depth_net inference`.

## Required Inputs

| Action | Required artifact or data | Spec key |
|---|---|---|
| `gen_trt_engine` | Exported monocular ONNX model | `gen_trt_engine.onnx_file` |
| `gen_trt_engine` | Output engine path | `gen_trt_engine.trt_engine` |
| `evaluate` | TensorRT engine | `evaluate.trt_engine` |
| `evaluate` | Depth annotation file | `dataset.test_dataset.data_sources[0].data_file` |
| `inference` | TensorRT engine | `inference.trt_engine` |
| `inference` | Depth annotation file | `dataset.infer_dataset.data_sources[0].data_file` |

For direct Docker runs, mount input folders at the same paths used in the spec. For chained jobs, map exported ONNX artifacts into `gen_trt_engine.onnx_file` and map the engine artifact into `evaluate.trt_engine` or `inference.trt_engine`.

## Spec Templates

Two model variants are supported. The deploy spec template at `spec_template_deploy.yaml` covers the **relative variant** (default). For the **metric variant**, start from the same template and apply the overrides below.

### Relative variant (default)

Copy `spec_template_deploy.yaml` as a starting point. Override only paths and environment-specific values (`data_file`, `results_dir`, `trt_engine` paths, batch size as needed). No structural overrides required.

### Metric variant

Start from the same template, then apply these metric-specific overrides:

```yaml
dataset:
  test_dataset:
    data_sources:
    - dataset_name: NYUDV2              # metric pairs with NYUDV2 (not NYUDV2Relative)
      data_file: /data/annotations.txt
  infer_dataset:
    data_sources:
    - dataset_name: MetricMonoDataset
      data_file: /data/annotations.txt
  # carry the metric variant's NYU-trained normalization (from your train/export spec)
  normalize_depth: false
  max_depth: 10.0
  min_depth: 0.001
```

Common to both variants:

- The TAO Deploy command is `depth_net` for both mono and stereo DepthNet model skills.
- Recommended TRT precision: `gen_trt_engine.tensorrt.data_type: bf16` (Ampere SM80+ required). `fp32` is supported as a fallback. `fp16` is not supported for the ViT-L mono backbone.
- For aspect-preserved inference (matching pyt evaluator on variable-aspect input), set `dataset.test_dataset.augmentation.crop_size` and `dataset.infer_dataset.augmentation.crop_size` to the dataset's keep-aspect target shape (e.g., NYU 480×640 → `[518, 686]` with `multiple_of=14`). The deploy runtime selects input H/W from `augmentation.crop_size`, not from `evaluate.input_height/input_width`; leaving `crop_size` unset falls back to tao-core's `[518, 518]` default and silently overrides the engine shape. The engine input shape must match `crop_size` exactly (mono engines are built static at the trace shape — only the batch axis can be dynamic).

## Spec filename invariant

The spec yaml's basename (modulo `.yaml`) must match the action verb passed on the command line. For example, `gen_trt_engine` requires the spec at a path ending in `gen_trt_engine.yaml`; `evaluate` requires `evaluate.yaml`. Mismatched filenames produce a non-obvious `FileNotFoundError` from the hydra config loader before any action work begins.

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
| `evaluate` | Depth metrics under `results_dir` (`abs_rel`, `d1`/`d2`/`d3` for mono; `rmse` is N/A for the scale-shift-invariant relative variant) |
| `inference` | Predicted depth outputs under `results_dir` (colorized JPGs by default; `inference.save_raw_pfm: True` to add raw PFMs) |

## Common errors

**Engine profile mismatch**: Runtime batch size for evaluate or inference must fit within the TensorRT min/opt/max profile used during `gen_trt_engine`. The default profile in the spec template is `min=1 / opt=1 / max=4` — adjust if your inference call uses a larger batch.

**Aspect-stretched predictions**: Forcing the engine input H/W to a static shape that doesn't match the dataset's native aspect distorts the depth field. Mono examples: NYU 480×640 should run at 518×686 (keep-aspect, multiple-of-14), not 518×518. Pick the keep-aspect target at export time (`export.input_height` / `export.input_width`) and set `dataset.{test,infer}_dataset.augmentation.crop_size: [518, 686]` to match (this is what the deploy runtime actually reads). Different datasets with different aspect ratios require separate engines.

**INT8 calibration missing**: INT8 builds need an extracted calibration image directory, a writable cache path, and enough images for `cal_batch_size * cal_batches`.

**Mounted paths do not exist**: TAO Deploy checks local paths inside the container. Make sure every path in the spec has a matching Docker mount or job artifact mapping.
