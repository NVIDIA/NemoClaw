# Typical Spec Overrides

Per-action `spec_overrides` blocks for the `depth_net` mono actions.

Data source overrides are **mandatory for every action** — the agent MUST construct data source paths from the Per-Action Dataset Requirements table in SKILL.md and include them in `spec_overrides`. Each `data_sources` entry is a dict with **two mandatory fields**: `data_file` and `dataset_name`.

```python
S3_TRAIN = "aws://bucket/data/train"
S3_EVAL = "aws://bucket/data/eval"
```

**train (mandatory data sources):**
```python
{
    "train.num_epochs": 10,
    "train.precision": "fp32",
    "train.checkpoint_interval": 10,
    "train.validation_interval": 10,
    "train.num_gpus": 1,
    "model.model_type": "RelativeDepthAnything",
    "model.encoder": "vitl",
    "dataset.train_dataset.batch_size": 4,
    "dataset.train_dataset.workers": 4,
    "dataset.train_dataset.augmentation.crop_size": [518, 518],
    "dataset.train_dataset.data_sources": [
        {"data_file": f"{S3_TRAIN}/annotations.txt", "dataset_name": "RelativeMonoDataset"}
    ],
    "dataset.val_dataset.batch_size": 1,
    "dataset.val_dataset.workers": 4,
    "dataset.val_dataset.data_sources": [
        {"data_file": f"{S3_EVAL}/annotations.txt", "dataset_name": "RelativeMonoDataset"}
    ],
}
```

**Precision recommendation (relative variant)**: use `fp32` (recommended). `bf16` is supported as an alternative on Ampere SM80+ hardware.

**evaluate (mandatory data sources):**
```python
{
    "model.model_type": "RelativeDepthAnything",
    "dataset.test_dataset.batch_size": 1,
    "dataset.test_dataset.workers": 4,
    "dataset.test_dataset.data_sources": [
        {"data_file": f"{S3_EVAL}/annotations.txt", "dataset_name": "NYUDV2Relative"}
    ],
}
```

**export:**
```python
{
    "model.model_type": "RelativeDepthAnything",
    "export.input_channel": 3,
    "export.input_height": 518,
    "export.input_width": 518,
    "export.opset_version": 16,
    "export.on_cpu": False,
    "export.gpu_id": 0,
}
```

Defaults sourced from `nvidia_tao_pytorch/cv/depth_net/experiment_specs/experiment_mono_relative.yaml` (export block). Override only when the deployment target requires a different ONNX shape, opset, or export device.

**inference (mandatory data sources):**
```python
{
    "model.model_type": "RelativeDepthAnything",
    "dataset.infer_dataset.batch_size": 1,
    "dataset.infer_dataset.workers": 4,
    "dataset.infer_dataset.data_sources": [
        {"data_file": f"{S3_EVAL}/annotations.txt", "dataset_name": "RelativeMonoDataset"}
    ],
    "inference.save_raw_pfm": False,
}
```

`inference.save_raw_pfm` controls whether raw single-channel disparity is written as `.pfm` files alongside the visualization output. Default `False` — the action emits a 240×960 RGB JPG triptych (input | predicted disp | overlay-style panel) at 320×240 per panel, mirroring the source dataset's directory tree under `<results_dir>/inference/inference_images/`. Set `True` to additionally write `.pfm` files for downstream metric computation; raw disparity is unbounded scale-shift-invariant for `RelativeDepthAnything` and bounded to `[min_depth, max_depth]` for `MetricDepthAnything`.

**quantize (mandatory data sources):**
```python
{
    "dataset.train_dataset.data_sources": [
        {"data_file": f"{S3_TRAIN}/annotations.txt", "dataset_name": "RelativeMonoDataset"}
    ],
    "dataset.val_dataset.data_sources": [
        {"data_file": f"{S3_EVAL}/annotations.txt", "dataset_name": "RelativeMonoDataset"}
    ],
    "dataset.quant_calibration_dataset.images_dir": f"{S3_TRAIN}/images.tar.gz",
}
```
