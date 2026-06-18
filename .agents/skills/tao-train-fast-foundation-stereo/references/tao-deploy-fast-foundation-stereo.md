# DepthNet Fast Stereo Deploy

DepthNet Fast Stereo deploy covers the TAO Deploy actions for an exported FFS (FastFoundationStereo) ONNX. Use the `depth-net-fast-stereo` model skill for training, checkpoint evaluation, export, or non-TensorRT (pyt) inference. Use this deploy workflow after export when the input artifact is an ONNX model and the desired output is a TensorRT engine or TensorRT-backed predictions.

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

Deploy action metadata is in `tao-deploy-fast-foundation-stereo.skill_info.yaml`. Deploy spec template lives at `spec_template_deploy.yaml`.

## Deploy Workflow

1. Train (optional) and export with the `depth-net-fast-stereo` skill. For the raw-bp2 use case, skip train and export directly from the bp2 ckpt.
2. Keep the exported ONNX artifact and any sidecar files together in the mounted model directory.
3. Build the TensorRT engine with this workflow.
4. Run TensorRT `evaluate` or `inference` from the engine artifact produced by `gen_trt_engine`.

Direct TAO Launcher spelling is `tao deploy depth_net gen_trt_engine`, `tao deploy depth_net evaluate`, `tao deploy depth_net inference`.

## Required Inputs

| Action | Required artifact or data | Spec key |
|---|---|---|
| `gen_trt_engine` | Exported FFS ONNX model | `gen_trt_engine.onnx_file` |
| `gen_trt_engine` | Output engine path | `gen_trt_engine.trt_engine` |
| `evaluate` | TensorRT engine | `evaluate.trt_engine` |
| `evaluate` | Stereo annotation file (3-col with GT, 4-col adds occlusion mask) | `dataset.test_dataset.data_sources[0].data_file` |
| `inference` | TensorRT engine | `inference.trt_engine` |
| `inference` | Stereo annotation file (2-col left+right, no GT) | `dataset.infer_dataset.data_sources[0].data_file` |

For direct Docker runs, mount input folders at the same paths used in the spec. For chained jobs, map exported ONNX artifacts into `gen_trt_engine.onnx_file` and map the engine artifact into `evaluate.trt_engine` or `inference.trt_engine`.

## Spec Template

Fast Stereo deploy supports one model (`FastFoundationStereo`). Copy `spec_template_deploy.yaml` as a starting point and override only paths and environment-specific values (`data_file`, `results_dir`, `trt_engine` paths, batch size as needed).

Adjustments by use case:

- **Inference (no GT)** — set `dataset.infer_dataset.data_sources[0].dataset_name` to `GenericDataset` (the default in the template). Use a 2-column annotation file (left + right).
- **Evaluate / Inference with GT** — pick a dataset-specific class (`Middlebury`, `Kitti`, `Eth3d`, `FSD`, `IsaacRealDataset`, `Crestereo`) when GT or occlusion-mask handling matches. Use a 3-column annotation (or 4-column with `nocc` mask).
- **Variable-aspect input** — pad each input to the nearest stride-32 multiple at preprocess and feed the dynamic-shape engine at the padded H × W. Do **not** rely on `evaluate.native_padded: True` — it currently triggers a TRT 10.13 Cask Pooling Runner failure (see Common errors).
- **Shape consistency** — match `dataset.test_dataset.augmentation.crop_size` to `evaluate.input_height/input_width` and to the export-time ONNX shape for fixed-shape engines (see "Shape consistency" below).

Common:

- The TAO Deploy command is `depth_net` for mono, stereo, and fast-stereo skills. The `model.model_type` field discriminates between them.
- Recommended TRT precision for FFS-bp2: **`gen_trt_engine.tensorrt.data_type: fp16` on the static-shape ONNX path** (static-shape deploy below). The dynamic-shape engine path supports both `fp16` and `fp32` — see the deployment matrix below for the trade-off.

## Two deploy paths

### Static-shape deploy — export static fp32 ONNX, build fp16 engine

Recommended path for FFS-bp2 deploy. Static fp16 has the lowest deploy-time disparity drift vs upstream.

```yaml
# export spec — produced via depth_net export
export:
  checkpoint: <bp2 ckpt path or finetuned ckpt>
  onnx_file: <out.onnx>
  input_height: 480
  input_width: 736
  opset_version: 17
  batch_size: 1                          # static
  on_cpu: False
```

```yaml
# gen_trt_engine spec
gen_trt_engine:
  onnx_file: <out.onnx from above>
  trt_engine: <out engine>
  batch_size: 1
  tensorrt:
    data_type: fp16                      # static-shape FFS supports fp16
    workspace_size: 4096                 # FFS needs more than the 1024 default
    min_batch_size: 1
    opt_batch_size: 1
    max_batch_size: 1
evaluate:
  trt_engine: <built engine>
  input_height: 480
  input_width: 736
model:
  model_type: FastFoundationStereo
dataset:
  test_dataset:
    augmentation:
      crop_size: [480, 736]
```

The fp16 selection at TRT compile is what gives FFS its real-time deploy latency. The pyt model itself trained with `mixed_precision: false` (or upstream's bf16) — `gen_trt_engine.tensorrt.data_type: fp16` is the compile-time switch.

### Dynamic-shape deploy (fp32 or fp16)

```yaml
export:
  batch_size: -1                         # dynamic batch axis
  dynamic_hw: true                       # dynamic H/W axes (FFS only; FS/mono ignored with warning)
  input_height: 320
  input_width: 736

gen_trt_engine:
  onnx_file: <user dynamic ONNX>
  trt_engine: <out engine>
  batch_size: -1
  min_height: 320
  opt_height: 480
  max_height: 1024                       # ≥ tallest expected input (see "Sizing the profile" below)
  min_width: 320
  opt_width: 736
  max_width: 1536                        # ≥ widest expected input
  tensorrt:
    data_type: fp32                      # fp32 default; fp16 also supported (see deployment matrix)
    workspace_size: 4096
evaluate:
  trt_engine: <built engine>
  # Do NOT enable evaluate.native_padded with a TRT 10.13 dynamic engine —
  # see "Common errors → native_padded with dynamic engine triggers Cask
  # Pooling Runner failure" below.
```

`fp32` is the default for the dynamic-shape engine (matches static-fp32 parity vs upstream). `fp16` on the dynamic-shape engine is supported but has higher drift than static fp16 — use it for latency-critical multi-resolution inference where the drift is acceptable for the downstream task.

#### Sizing the profile (`min/opt/max_height`, `min/opt/max_width`)

`max_height` and `max_width` must each be **≥ the largest input** you intend to inference at. If `max_width` is smaller than your widest input, the engine rejects the input at runtime with a `satisfyProfile` error. Recommended starting point for variable-aspect inputs:
- `min_height: 320`, `min_width: 320` (smallest crop you'll allow at preprocess)
- `opt_height: 480`, `opt_width: 736` (typical inference shape — TRT optimises for this)
- `max_height: 1024`, `max_width: 1536` (covers most variable-aspect datasets with ~30 % headroom)

Then ensure each input is padded / resized to a multiple of 32 in both dimensions — see "Common errors → Dynamic engine inference shape mismatch" for the stride-32 + stride-4 divisibility rule.

## Pyt-vs-deploy parity (FastFoundationStereo bp2)

If you benchmark TAO FFS bp2 deploy (`gen_trt_engine` + TRT `evaluate`) against the upstream FFS native deploy path on the same input, expect a small residual mean_abs disparity drift. The TAO output is **close to but not byte-equivalent with** the upstream `Fast-FoundationStereo` `make_single_onnx.py` deploy path because the TAO export graph topology and TRT 10.13 optimiser interact differently than the upstream graph.

The drift magnitude depends on:
- **Source image resolution** — lower-resolution sources amplify fp32-precision differences after resize-to-engine-shape because the cost-volume softmax peak is softer. For reproducible comparison across runs, hold the source resolution constant.
- **TRT precision** — fp16 is noisier than fp32; dynamic-shape engines are noisier than static at the same precision.
- **Hardware / TRT version** — same TRT version on both sides reduces cross-version contribution.

Validate the drift on your own dataset and decide whether it is acceptable for your downstream task. The residual is not improvable at the TAO source-code level.

### Recommended deployment paths

| Use case | Recommended path | Notes |
|---|---|---|
| Real-time fp16 fixed-resolution | **static H/W + fp16** | Lowest deploy-side latency. Build via `depth_net gen_trt_engine` (static-shape deploy). |
| Variable-aspect input + fixed resolution batch | **static H/W + fp16 + per-image resize at preprocess** | Caller resizes incoming frames to the engine's H×W, then rescales disparity by the per-image scale factor. |
| Multiple input resolutions (no preprocess resize) | **dynamic H/W + fp32** | Matches static-fp32 parity vs upstream. Build via `depth_net gen_trt_engine` with `min/opt/max_height` + `min/opt/max_width` under `gen_trt_engine:`. |
| Multiple input resolutions + fp16 (latency-critical) | **dynamic H/W + fp16, with caveat** | Higher drift than static fp16 due to TRT dynamic-shape inherent noise. Engine may produce NaN under some checkpoint states. Acceptable for many downstream tasks; for per-pixel metric disparity prefer static. |

### Implication for fp16 deploy

If your application requires fp16 (latency budget) AND multi-resolution input,
two options:
- **Static fp16 engine + per-image preprocess resize** — lowest drift; caller resizes each input to the engine H×W and rescales disparity by the per-image scale factor.
- **Dynamic H/W fp16 engine** — accepts variable resolutions natively (drift higher than static fp16; engine may produce NaN under some checkpoint states — fall back to dynamic fp32 if NaN observed).

### Note — drift floor is FFS-specific

This drift behaviour is specific to the FastFoundationStereo bp2 model: its
combination of EdgeNeXt encoder + cost-volume + GRU update path interacts
with the TAO export graph and TRT 10.13 in a way that produces this floor.
Other depth-net stereo / mono models (e.g. `FoundationStereo`, full-FS
variants) may exhibit different drift characteristics and should be
characterised independently.

### Troubleshooting — Upstream reference generation

When generating the upstream reference disparity (for an apples-to-apples
drift comparison) by running upstream `Fast-FoundationStereo/scripts/make_single_onnx.py`
on the bp2 checkpoint, the script raises:

```
omegaconf.errors.ConfigAttributeError: Missing key normalize
    full_key: normalize
```

Cause: the bp2 commercial checkpoint's sidecar `cfg.yaml` does not
include the `normalize` knob that upstream's `forward()` reads. The
upstream code path defaults to `normalize=True` for the GWC volume
when the knob is absent, but OmegaConf strict-key resolution rejects
the lookup before the default kicks in.

Workaround — set the knob explicitly after `torch.load()`, before
`make_single_onnx.py` runs the trace:

```python
import torch
m = torch.load('/path/to/model_best_bp2_serialize.pth', map_location='cpu', weights_only=False)
if 'normalize' not in m.args:
    m.args.normalize = True   # matches upstream pre-bp2 default
# then proceed with make_single_onnx.py logic
```

This matches what TAO's `gwc_feature_normalize: true` model knob does on
the deploy-skill side; both routes should produce the same upstream
reference numbers.

## Shape consistency: export ↔ evaluate ↔ deploy

The TRT engine is built from an ONNX file that fixes the input height and width at export time (`export.input_height`, `export.input_width`). The pyt-side evaluator and the deploy-side TRT evaluator must operate at the same shape to produce comparable disparity values, since disparity is in **pixel units** and scales with image width.

| Knob | Where | Recommended convention |
|---|---|---|
| `export.input_height`, `export.input_width` | export action spec | the (height, width) the engine will see at inference time |
| `dataset.test_dataset.augmentation.crop_size` | pyt evaluate spec | match `[input_height, input_width]` exactly |
| `dataset.test_dataset.augmentation.crop_size` | deploy `evaluate` spec | match the engine input shape |

Mismatched shapes yield a measurable EPE drift between pyt and deploy paths. Pick one shape (e.g., `[480, 736]`) and use it across export, pyt eval, and deploy eval — or use the dynamic-shape engine and pre-pad each input to a stride-32 multiple within the engine's `min/opt/max` profile (avoid `native_padded` on TRT 10.13 — see Common errors).

## Spec filename invariant

The spec yaml's basename (modulo `.yaml`) must match the action verb passed on the command line. For example, `gen_trt_engine` requires the spec at a path ending in `gen_trt_engine.yaml`; `evaluate` requires `evaluate.yaml`. Mismatched filenames produce a non-obvious `FileNotFoundError` from the hydra config loader before any action work begins.

## TRT engine build time

`gen_trt_engine` for FFS at static `[1, 3, 480, 736]` typically completes in a few minutes on x86 with a single A100 / L40 (faster than full FoundationStereo at the same shape due to FFS's pruned width). Plan the deploy chain accordingly; the build is one-time per (shape, precision) tuple.

## Common errors

**Engine profile mismatch**: Runtime batch size for `evaluate` or `inference` must fit within the TensorRT min/opt/max profile used during `gen_trt_engine`. Default profile in the spec template is `min=1 / opt=1 / max=1` (FFS-bp2 deploy uses static batch=1).

**Aspect-stretched predictions on variable-aspect inputs**: Forcing the engine input H/W to a fixed shape distorts samples whose source aspect ratio differs from the engine shape, inflating EPE vs pyt baseline. Recommended approach: dynamic-shape engine sized per "Sizing the profile" above, with each input pre-padded / resized to a stride-32 multiple before evaluation. `evaluate.native_padded: True` would conceptually fit this case but currently triggers a TRT 10.13 Cask Pooling Runner failure — see below.

**Stereo inference 2-col GenericDataset**: 2-column (left + right, no GT) annotation with `dataset_name: GenericDataset` is the supported inference path. Dataset-specific classes require 3-column input.

**Mounted paths do not exist**: TAO Deploy checks local paths inside the container. Make sure every path in the spec has a matching Docker mount or job artifact mapping (including the bp2 ckpt path, when present).

**Drift higher than expected — diagnostic checklist**: If your measured drift vs upstream looks unreasonably large for your task, check:

1. **Source image resolution** — lower-resolution sources amplify drift because the cost-volume softmax peak is softer and amplifies fp32-precision differences between TAO and upstream engines after resize-to-engine-shape. Hold source resolution constant when comparing across runs.
2. **Input resize parity** — your preprocessing resize order / interpolation must match upstream's, or drift amplifies for reasons unrelated to TAO.
3. **`model.max_disparity` explicit** — if the spec yaml's `model:` block omits `max_disparity: 192`, OmegaConf falls back to the schema default of `416`, which builds a 2× oversized cost volume and shifts disparity out of the trained regime. See the main skill's "Important Parameters" entry.

**fp16 dynamic-shape engine produces NaN or aspect-stretched bad disparity**: fp16 dynamic-shape is supported but more sensitive than static fp16. NaN can occur under some checkpoint states. If observed, fall back to static-shape fp16 or dynamic-shape fp32 — both are robust.

**`Key 'gwc_feature_normalize' not in 'DepthNetModelConfig'`**: TAO Core too old. The `gwc_feature_normalize` knob lives on the model config schema and is required for FFS-bp2; upgrade your TAO container.

**`native_padded: True` triggers Cask Pooling Runner failure on TRT 10.13 dynamic engine (silent corruption)**: With `evaluate.native_padded: True` and a dynamic-shape engine, the action exits 0 and `status.json` reports "finished successfully", but the per-image logs show `Cask Pooling Runner Execute Failure` on every batch and the EPE values are inflated by orders of magnitude — the disparity tensor is silently corrupted. This is a TRT 10.13 behaviour, not a skill-side configuration issue.

Mitigation:
- Set `evaluate.native_padded: False` (or omit it; default is False).
- Pad / resize each input to the engine's `optShapes` H × W (or to the nearest stride-32 multiple within the `min/opt/max` profile) at preprocess time. Track the per-image scale factor and rescale the disparity output in pixels.
- Static engines built at the exact target H × W are unaffected; the failure is specific to dynamic-shape `native_padded` interaction.

**Dynamic engine inference shape mismatch (silent failure)**: The TRT engine raises `axis 2 dimensions must be equal: <X> != <Y>` (e.g., `127 != 128`) at the `/feature/deconv8_4/Concat` layer, the inference action exits with code 0, `status.json` reports "finished successfully", but `predicted_depth/` is empty. This means the input image H × W did not satisfy both stride constraints required by the FFS architecture: H and W must each be divisible by **32** (encoder downsample) AND by **4** (cost-volume downsample). Many original-resolution inputs of variable-aspect public stereo datasets violate the stride-32 constraint.

Pick one of:
- **Preprocess resize** the input to the nearest multiple of 32 in both dimensions before inference. The disparity output will be at the resized H×W; rescale by `orig_W / resized_W` to recover original-resolution disparity if needed.
- **Static engine at the exact target H × W** (build with `export.input_height` / `export.input_width` matching your input). No runtime divisibility surprises.
- **Dynamic engine with `optShapes` matching the typical input** and pad the actual input to the nearest stride-32 boundary. Set `crop_size` and `evaluate.input_height/width` consistently.

The `status.json` "finished successfully" is misleading here: it reflects the entrypoint's exit, not whether any disparity was produced. Always check `predicted_depth/` is non-empty as a deploy success signal until the `status.json` schema captures the per-image result.
