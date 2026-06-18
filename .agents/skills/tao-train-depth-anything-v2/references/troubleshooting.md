# Error Patterns

Common failure signatures and fixes for the `depth_net` mono actions.

**Depth range mismatch**: Ensure `dataset.max_depth` / `dataset.min_depth` match the actual depth range in your data.

**Missing pretrained weights**: DepthAnything v2 encoder requires `model.mono_backbone.pretrained_path` to be set for fine-tuning.

**`Key 'encoder' not in 'MonoBackBone'`**: `encoder` is a top-level `model.encoder` field, not under `mono_backbone`. See `parameters.md`.

**`Key 'dataset_name' is not in struct`** under `data_sources`: every `data_sources` entry must include both `data_file` and `dataset_name`.

**`bash: exec: depth_net_mono: not found`**: the unified entrypoint is `depth_net` (no `_mono` / `_stereo` suffix). The skill's `command` already uses the correct form; check any user-supplied wrapper.

**Metric variant hyperparameter sourcing** (`dataset.normalize_depth`, `dataset.train_dataset.augmentation.input_mean`, `dataset.train_dataset.augmentation.input_std`): `MetricDepthAnything` requires depth normalization and ImageNet input statistics that match the checkpoint's training run. These are model- and dataset-specific (not skill-level defaults) — read them from the checkpoint's sibling `experiment.yaml` (or the upstream training spec). Common NYU-trained values: `normalize_depth: false`, `max_depth: 10.0`, `min_depth: 0.001`, `input_mean: [0.485, 0.456, 0.406]`, `input_std: [0.229, 0.224, 0.225]`. Mirror the depth-range values into the export spec — see Metric Variant Finetuning Recipe → Dataset normalization block in `finetuning.md`.

**Export refuses to overwrite an existing ONNX file**: `ValueError: Default onnx file <path> already exists`. The mono export action refuses to overwrite a prior artifact at `export.onnx_file`. Delete or rename the existing file, or change the spec's `export.onnx_file` to a fresh path before re-running.
