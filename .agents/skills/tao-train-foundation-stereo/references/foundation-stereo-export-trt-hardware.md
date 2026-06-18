# FoundationStereo Export, TensorRT Defaults, and Hardware

## Export / TRT Defaults

- TRT data types: FP32, FP16.
- Static-shape ONNX (`export.batch_size: 1`): `fp16` supported (recommended, best EPE).
- Batch-only dynamic ONNX (`export.batch_size: -1`): `fp16` supported. Engine accepts variable batch size; height and width are pinned to the trace shape.
- Height and width are always pinned to the trace shape; H/W-dynamic engines are not supported. Build separate engines for different (H, W) targets.
- For the NGC release (576×960), set `export.batch_size: 1`, `export.opset_version: 17`, `export.on_cpu: True` (CPU export is required at 576×960 to avoid GPU OOM during the trace).
- For user-trained fp16 export, pair `opset_version` to `on_cpu`: `on_cpu: True` (CPU trace) accepts either opset 16 or 17 deterministically; `on_cpu: False` (GPU trace) accepts only opset 16 (opset 17 + on_cpu=False is broken on TRT 10.13 fp16). At `on_cpu=False + opset 16` the fp16 build is occasionally non-deterministic — re-run on a `costTensor::indexOfMin` or `optimizer::reduce` assertion. fp32 builds are unaffected. See `tao-deploy-foundation-stereo.md` for the validation table.
- `export.on_cpu` is driven by GPU trace memory: `False` for ≤320×736 (fits 47 GB VRAM), `True` for ≥480×736 (PyTorch trace OOMs at GPU). Prefer `on_cpu: True` whenever feasible — fp16 builds at `on_cpu=True` are empirically deterministic at every tested shape (including NGC release 576×960).
- See `tao-deploy-foundation-stereo.md` for the three supported deploy paths (NGC static / user-trained static / user-trained batch-only-dynamic).

Full TAO Deploy reference: [tao-deploy-foundation-stereo](tao-deploy-foundation-stereo.md).

## Hardware

Minimum 1 GPU(s), recommended 4 GPU(s). 24GB+ (A100 recommended) VRAM per GPU. Stereo matching is memory intensive due to cost volume. Use `model.low_memory > 0` for constrained GPUs. fp32 recommended for training.
