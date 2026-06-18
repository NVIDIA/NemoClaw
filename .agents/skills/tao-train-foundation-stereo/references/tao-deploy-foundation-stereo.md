# DepthNet Stereo Deploy

DepthNet Stereo deploy covers the TAO Deploy actions for an exported FoundationStereo model. Use the `depth-net-stereo` model skill for training, checkpoint evaluation, quantization, distillation, pruning, export, or non-TensorRT inference where those actions exist. Use this deploy workflow after export when the input artifact is an ONNX model and the desired output is a TensorRT engine or TensorRT-backed predictions.

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

Deploy action metadata is in `tao-deploy-foundation-stereo.skill_info.yaml`. Deploy spec template lives in this references folder:

- `spec_template_deploy.yaml`

## Deploy Workflow

1. Train and export with the `depth-net-stereo` skill.
2. Keep the exported ONNX artifact and any sidecar files together in the mounted model directory.
3. Build the TensorRT engine with this workflow.
4. Run TensorRT `evaluate` or `inference` from the engine artifact produced by `gen_trt_engine`.

Direct TAO Launcher spelling is `tao deploy depth_net gen_trt_engine`, `tao deploy depth_net evaluate`, `tao deploy depth_net inference`.

## Required Inputs

| Action | Required artifact or data | Spec key |
|---|---|---|
| `gen_trt_engine` | Exported FoundationStereo ONNX model | `gen_trt_engine.onnx_file` |
| `gen_trt_engine` | Output engine path | `gen_trt_engine.trt_engine` |
| `evaluate` | TensorRT engine | `evaluate.trt_engine` |
| `evaluate` | Stereo annotation file (3-col with GT, 4-col adds occlusion mask) | `dataset.test_dataset.data_sources[0].data_file` |
| `inference` | TensorRT engine | `inference.trt_engine` |
| `inference` | Stereo annotation file (2-col left+right, no GT) | `dataset.infer_dataset.data_sources[0].data_file` |

For direct Docker runs, mount input folders at the same paths used in the spec. For chained jobs, map exported ONNX artifacts into `gen_trt_engine.onnx_file` and map the engine artifact into `evaluate.trt_engine` or `inference.trt_engine`.

## Spec Template

Stereo deploy supports one model (`FoundationStereo`). Copy `spec_template_deploy.yaml` as a starting point and override only paths and environment-specific values (`data_file`, `results_dir`, `trt_engine` paths, batch size as needed).

Adjustments by use case:

- **Inference (no GT)** — switch `dataset.infer_dataset.data_sources[0].dataset_name` to `GenericDataset` (the default in the template). Use a 2-column annotation file (left + right).
- **Evaluate / Inference with GT** — pick a dataset-specific class (`Middlebury`, `Kitti`, `Eth3d`, `FSD`, `IsaacRealDataset`, `Crestereo`) when GT or occlusion-mask handling matches that class's conventions. Use a 3-column annotation (left + right + GT) or 4-column (with `nocc` mask).
- **Variable-aspect datasets (Middlebury)** — pick a single (H, W) export shape per dataset (multiple of 32, close to the dataset's median aspect) and rebuild the engine for each (H, W) you serve. The engine is fully static on H/W; per-image variable shape is not supported.
- **Shape consistency** — match `dataset.test_dataset.augmentation.crop_size` to `evaluate.input_height/input_width` and to the export-time ONNX shape (see "Shape consistency" below).

Common:

- The TAO Deploy command is `depth_net` for both mono and stereo DepthNet model skills.
- Recommended TRT precision: `fp16` on every supported deploy path (static-shape and batch-only-dynamic). Engine input H/W are pinned to the trace shape on every path.

## Deploy paths

Three deploy paths are supported. All produce a static-H/W engine; only the batch axis can be marked dynamic.

### Path 1 — NGC pretrained static-shape ONNX

Use the NGC release `deployable_foundationstereo_small_576x960_v2.0.onnx` directly (skip `train` and `export`).

```yaml
gen_trt_engine:
  onnx_file: <NGC ONNX path>
  trt_engine: <out engine path>
  batch_size: 1
  tensorrt:
    data_type: fp16
    workspace_size: 1024
evaluate:
  trt_engine: <built engine>
  input_height: 576
  input_width: 960
model:
  model_type: FoundationStereo
dataset:
  test_dataset:
    augmentation:
      crop_size: [576, 960]
```

### Path 2 — User-trained static-shape ONNX (NGC-compatible)

```yaml
export:
  checkpoint: <user-trained ckpt>
  onnx_file: <out.onnx>
  input_height: 576
  input_width: 960
  opset_version: 17        # 17 OK with on_cpu=True (NGC release uses 17); 16 also works
  batch_size: 1            # static
  on_cpu: True             # required at 576×960 to avoid GPU OOM during trace
```
Then use the Path 1 spec yamls for `gen_trt_engine`, `evaluate`, `inference`.

### Path 3 — User-trained batch-only-dynamic ONNX

Use this when the engine must accept multiple batch sizes from one build, with input H/W fixed by upstream preprocessing.

```yaml
export:
  batch_size: -1           # batch axis dynamic; H, W are static at the trace shape
  input_height: 320
  input_width: 736
  opset_version: 16        # required when on_cpu=False (opset 17 + on_cpu=False is broken on TRT 10.13 fp16)
  on_cpu: False            # GPU trace fits ≤320×736; use on_cpu: True for ≥480×736

gen_trt_engine:
  onnx_file: <user batch-dynamic ONNX>
  trt_engine: <out engine>
  batch_size: -1
  tensorrt:
    data_type: fp16
    workspace_size: 1024
    min_batch_size: 1
    opt_batch_size: 1
    max_batch_size: 4
evaluate:
  trt_engine: <built engine>
  input_height: 320        # same as export
  input_width: 736
inference:
  trt_engine: <built engine>
  input_height: 320
  input_width: 736
```

### Recommended `opset_version` and `on_cpu` for FS small fp16 deploy

`opset_version` must be paired with `on_cpu` per the validated combinations below:

| `on_cpu` | `opset_version` for fp16 | Status |
|---|---|---|
| **`True`** (CPU trace) | **16 or 17** | Deterministic PASS (validated at 480×736 and 576×960) |
| **`False`** (GPU trace) | **16 only** | Mostly works; occasional non-deterministic build failure on TRT 10.13 — re-run on `costTensor.cpp::indexOfMin::120` or `optimizer.cpp::reduce::1258` assertions |
| `False` + `17` | — | Deterministically broken on TRT 10.13 fp16 — do not use |

`on_cpu` is driven by export-trace GPU memory:
- ≤320×736: `on_cpu: False` is feasible (GPU trace fits in 47 GB VRAM).
- ≥480×736: `on_cpu: True` is required (PyTorch GPU trace OOMs on a 47 GB GPU).

Prefer `on_cpu: True` whenever feasible — at `on_cpu=True` the fp16 build is empirically deterministic at every tested shape (including the NGC release recipe 576×960+opset 17). fp32 builds are unaffected by these constraints.

## Shape consistency: export ↔ evaluate ↔ deploy

The TRT engine is built from an ONNX file that fixes the input height and width at export time (`export.input_height`, `export.input_width`). The pyt-side evaluator and the deploy-side TRT evaluator must operate at the same shape to produce comparable disparity values, since disparity is in **pixel units** and scales with image width.

| Knob | Where | Recommended convention |
|---|---|---|
| `export.input_height`, `export.input_width` | export action spec | the (height, width) the engine will see at inference time |
| `dataset.test_dataset.augmentation.crop_size` | pyt evaluate spec | match `[input_height, input_width]` exactly |
| `dataset.test_dataset.augmentation.crop_size` | deploy `evaluate` spec | match the engine input shape |

Mismatched shapes between pyt and deploy paths produce different disparity values because the cropped/resized image presents a different pixel-disparity distribution to the model. Pick one shape (e.g., `[320, 736]`) and use it across export, pyt eval, and deploy eval. For datasets whose native aspect differs from the chosen shape, build a separate engine per (H, W) target.

## Spec filename invariant

The spec yaml's basename (modulo `.yaml`) must match the action verb passed on the command line. For example, `gen_trt_engine` requires the spec at a path ending in `gen_trt_engine.yaml`; `evaluate` requires `evaluate.yaml`. Mismatched filenames produce a non-obvious `FileNotFoundError` from the hydra config loader before any action work begins.

## TRT engine build time

`gen_trt_engine` for `FoundationStereo` is dominated by cost-volume convolution kernels and takes several minutes on x86 with a single A100/L40 (≈ 5 min for the FP32 engine at `[1, 3, 320, 736]`). Plan the deploy chain (`gen_trt_engine → inference → evaluate`) accordingly; the long build is one-time per (shape, precision) tuple.

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
| `evaluate` | Stereo metrics under `results_dir` — primary metrics `epe`, `bp1`/`bp2`/`bp3`, `d1`, `rmse`. The simultaneously-emitted `abs_rel`, `sq_rel`, `rmse_log` are non-meaningful for stereo (formulated for mono metric depth); ignore them |
| `inference` | Disparity outputs under `results_dir` (PNGs; injective filenames per scene via `<scene>_im0.png`) |

## Common errors

**Engine profile mismatch**: Runtime batch size for evaluate or inference must fit within the TensorRT min/opt/max batch profile used during `gen_trt_engine`. Default profile in the spec template is `min=1 / opt=1 / max=4`.

**Aspect-stretched predictions on variable-aspect datasets**: forcing the engine input H/W to a single fixed shape distorts samples whose native aspect differs from that shape, degrading disparity quality. Build a separate engine per dataset (H, W) target close to the dataset's median aspect, multiple of 32. Per-image variable shape is not supported on the engine side.

**Stereo inference 2-col GenericDataset**: 2-column (left + right, no GT) annotation with `dataset_name: GenericDataset` is the supported inference path. Dataset-specific classes (`Middlebury` / `Kitti` / `Eth3d` / `FSD` / `IsaacRealDataset` / `Crestereo`) require 3-column input.

**Mounted paths do not exist**: TAO Deploy checks local paths inside the container. Make sure every path in the spec has a matching Docker mount or job artifact mapping.
