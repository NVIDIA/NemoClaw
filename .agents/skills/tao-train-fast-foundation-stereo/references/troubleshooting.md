# FastFoundationStereo Troubleshooting

Error patterns and their fixes for FastFoundationStereo (FFS) train, evaluate, inference, and export actions.

**`shape mismatch` at forward**: A `model.*` width override field is missing or wrong. Re-check the bp2 distilled width overrides — all 15 fields must be set to the bp2 distilled values exactly.

**`Key 'gwc_feature_normalize' not in 'DepthNetModelConfig'`**: TAO Core too old. The `gwc_feature_normalize` knob requires the FFS-support TAO Core release; upgrade your container or remove the flag (which leaves the model in the broken-output state — see `references/parameters.md` → "Important Parameters → gwc_feature_normalize").

**`dynamic_hw: true` warning on FS / mono export**: Expected behavior, not an error. FS / mono models use a DINOv2 backbone that constant-folds positional embeddings into the trace, so dynamic H/W at runtime produces a fixed-size pos-embed mismatching the actual patch tokens (silent crash). The export path detects the model type, emits a warning, and falls back to static H/W. FFS uses EdgeNeXt only and supports `dynamic_hw: true` as documented in the Export use-case matrix.

**`Key 'encoder' not in 'StereoBackBone'`**: `encoder` is a top-level `model.encoder` field, not nested under `stereo_backbone`.

**`Key 'dataset_name' is not in struct`** under `data_sources`: every `data_sources` entry must include both `data_file` and `dataset_name`.

**Negative disparity in pyt evaluate / inference output**: `gwc_feature_normalize: true` is missing or `false`. The bp2 ckpt was trained with normalization on; without it, ~7-8% of pixels predict negative disparity (physically meaningless for stereo).

**Disparity drift much larger than expected vs upstream baseline**: The spec yaml's `model:` block is missing `max_disparity: 192`. OmegaConf falls back to the TAO Core schema default of `416`, which builds a cost volume with 2× the disparity levels the bp2 ckpt was trained for. The model loads and runs, no error is raised, but per-pixel disparity is shifted out of the trained regime. Fix: add `max_disparity: 192` under `model:` (separate from any `dataset.max_disparity` setting — they don't propagate to each other).

**`bash: exec: depth_net_stereo: not found`**: the unified entrypoint is `depth_net` (no `_mono` / `_stereo` / `_fast` suffix).

**Pyt `evaluate` runs at native image resolution (`crop_size` is decorative on the pyt test path)**: same asymmetry as `depth-net-stereo` — the test transform applies only `NormalizeImage` + `PrepareForNet`, no `Resize` / `Crop`. So `dataset.test_dataset.augmentation.crop_size` is read but **not consumed** for the pyt `evaluate` action; samples are fed at the annotation file's native shape. `crop_size` IS authoritative on the deploy side.

**`Failed to import SAM3` warning**: cosmetic only. SAM3 is an unrelated TAO model whose import is attempted at startup; the warning surfaces several times per pyt action (entrypoint init + Lightning callback init + others). Safe to ignore for FFS — has no effect on training, evaluation, inference, or export.

**Dynamic deploy inference fails silently on stride-incompatible images**: see `references/tao-deploy-fast-foundation-stereo.md` → "Common errors" → "Dynamic engine inference shape mismatch (silent failure)". Input H × W must be divisible by both 32 (encoder) and 4 (cost-volume); inputs that violate stride-32 produce empty `predicted_depth/` despite `status.json` "finished successfully".

## Local bind-mount tip (QA / development only)

When bind-mounting a modified TAO repo (`tao-pytorch`, `tao-core`, `tao-deploy`) into the container, stale `__pycache__/*.pyc` files from a previous container run can shadow your patched `.py` source. The symptom is a cryptic TRT-side error (e.g., `IOptimizationProfile::setDimensions Error Code 3`) when the new code path should have produced something different. Clear the caches before launching the container:

```bash
find /path/to/tao-pytorch -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null
find /path/to/tao-core    -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null
find /path/to/tao-deploy  -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null
```

SDK-runner production deployments are not affected — the runner copies sources fresh per job.
