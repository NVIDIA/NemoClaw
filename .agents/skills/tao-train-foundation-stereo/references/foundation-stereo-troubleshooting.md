# FoundationStereo Troubleshooting and Shape Consistency

## Error Patterns

**Disparity overflow**: Reduce `model.max_disparity` if targets exceed range or OOM occurs.

**Missing pretrained paths**: Both `model.stereo_backbone.depth_anything_v2_pretrained_path` and `model.stereo_backbone.edgenext_pretrained_path` should be set for fine-tuning.

**`Key 'encoder' not in 'StereoBackBone'`**: `encoder` is a top-level `model.encoder` field, not under `stereo_backbone`. See `foundation-stereo-parameters.md`.

**`Key 'dataset_name' is not in struct`** under `data_sources`: every `data_sources` entry must include both `data_file` and `dataset_name`.

**`bash: exec: depth_net_stereo: not found`**: the unified entrypoint is `depth_net` (no `_mono` / `_stereo` suffix). The skill's `command` already uses the correct form; check any user-supplied wrapper.

**Pyt `evaluate` runs at native image resolution (`crop_size` is decorative on the pyt test path)**: the stereo data module's test transform is built with `split='infer'` (`pl_stereo_data_module.py`), which applies only `NormalizeImage` + `PrepareForNet` — no `Resize`/`Crop`. So `dataset.test_dataset.augmentation.crop_size` is read but **not consumed** for the pyt `evaluate` action; samples are fed at the annotation file's native shape. For variable-aspect datasets like Middlebury, point the test annotation file at a resolution that fits GPU memory (e.g., MiddEval3-data-Q at 718×496 instead of MiddEval3-data-H at 1428×988 for the small variant on 24–48 GB GPUs). This asymmetry is pyt-only — `crop_size` IS authoritative on the deploy `evaluate` side (the deploy runtime reads it; see `tao-deploy-foundation-stereo.md`).

## Shape consistency

The `crop_size` in `dataset.test_dataset.augmentation.crop_size` should match `export.input_height` / `export.input_width` so the trained-model evaluator and the deploy-side TensorRT evaluator operate at the same shape. The pyt `evaluate` path ignores `crop_size` (see the Error Pattern above), but the deploy-side `evaluate` path reads it; keep all three values aligned for end-to-end shape consistency. See `tao-deploy-foundation-stereo.md` for the deploy-side shape table.
