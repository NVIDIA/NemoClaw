# FastFoundationStereo Export / TRT Defaults

ONNX export and TensorRT engine generation defaults for FastFoundationStereo (FFS), including the export use-case matrix.

## Export / TRT Defaults

- TRT data types: FP32, FP16.
- Recommended TRT precision for FFS-bp2: `fp16` on the static-shape ONNX path (lowest drift). Dynamic-shape path supports both `fp32` (default; static-fp32 parity) and `fp16` (latency-critical multi-resolution; higher drift than static fp16, may NaN under some checkpoint states — fall back to fp32 if observed). See `references/tao-deploy-fast-foundation-stereo.md` deployment matrix.
- `export` always emits a **fp32 ONNX** regardless of `model.mixed_precision`. The fp16 vs fp32 selection happens at the `gen_trt_engine` step via `gen_trt_engine.tensorrt.data_type`.
- For static-shape FFS at 480×736: `export.batch_size: 1`, `export.opset_version: 17`, `export.on_cpu: False`.
- **`export.batch_size`**: positive int (default `1`) — static batch dimension; `-1` enables a dynamic batch axis on the ONNX input.
- **`export.dynamic_hw`**: bool (default `false`) — `true` enables dynamic H/W axes on the ONNX input. **FFS only.** FS / mono models ignore this flag with a warning and fall back to static H/W (their DINOv2 backbone constant-folds positional embeddings into the trace, so dynamic H/W at runtime would produce a wrong-shape pos-embed mismatching the actual patch tokens — silent crash). FFS uses EdgeNeXt only and is safe.

## Export use-case matrix

`export.batch_size` and `export.dynamic_hw` are independent. The four combinations:

| Use case | `batch_size` | `dynamic_hw` | Resulting ONNX |
|---|---|---|---|
| Fixed-batch fixed-resolution (most common, production fp16) | `1` (positive) | `false` | static `[1, 3, H, W]` |
| Variable-batch fixed-resolution | `-1` | `false` | dynamic batch only |
| Variable-resolution single-batch (FFS only) | `1` (positive) | `true` | dynamic H/W only |
| Variable-resolution + variable-batch (FFS only) | `-1` | `true` | both batch and H/W dynamic |

For FS / mono models, `dynamic_hw: true` is automatically ignored with a warning and the engine falls back to static H/W. Only `FastFoundationStereo` supports dynamic H/W due to its EdgeNeXt-only encoder.
