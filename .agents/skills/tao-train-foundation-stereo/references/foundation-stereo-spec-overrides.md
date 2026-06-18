# FoundationStereo Typical Spec Overrides

Data source overrides are **mandatory for every action** — the agent MUST construct data source paths from the Per-Action Dataset Requirements table and include them in `spec_overrides`. Each `data_sources` entry is a dict with **two mandatory fields**: `data_file` and `dataset_name`.

```python
S3_TRAIN = "aws://bucket/data/train"
S3_EVAL = "aws://bucket/data/eval"
```

**train (mandatory data sources):**
```python
{
    "train.num_epochs": 10,
    "train.checkpoint_interval": 10,
    "train.validation_interval": 10,
    "train.num_gpus": 1,
    "model.model_type": "FoundationStereo",
    "model.encoder": "vits",
    "dataset.train_dataset.batch_size": 1,
    "dataset.train_dataset.workers": 4,
    "dataset.train_dataset.augmentation.crop_size": [320, 736],
    "dataset.train_dataset.data_sources": [
        {"data_file": f"{S3_TRAIN}/annotations.txt", "dataset_name": "Middlebury"}
    ],
    "dataset.val_dataset.batch_size": 1,
    "dataset.val_dataset.workers": 4,
    "dataset.val_dataset.augmentation.crop_size": [320, 736],
    "dataset.val_dataset.data_sources": [
        {"data_file": f"{S3_EVAL}/annotations.txt", "dataset_name": "Middlebury"}
    ],
}
```

**evaluate (mandatory data sources):**
```python
{
    "model.model_type": "FoundationStereo",
    "model.encoder": "vits",
    "dataset.test_dataset.batch_size": 1,
    "dataset.test_dataset.workers": 4,
    "dataset.test_dataset.augmentation.crop_size": [320, 736],
    "dataset.test_dataset.data_sources": [
        {"data_file": f"{S3_EVAL}/annotations.txt", "dataset_name": "Middlebury"}
    ],
}
```

**export:**
```python
{
    "model.model_type": "FoundationStereo",
    "model.encoder": "vits",
    "export.batch_size": 1,
    "export.input_height": 320,
    "export.input_width": 736,
}
```

**gen_trt_engine:**
```python
{
    "gen_trt_engine.batch_size": 1,
}
```

**inference (mandatory data sources):**
```python
{
    "model.model_type": "FoundationStereo",
    "model.encoder": "vits",
    "dataset.infer_dataset.batch_size": 1,
    "dataset.infer_dataset.workers": 4,
    "dataset.infer_dataset.data_sources": [
        {"data_file": f"{S3_EVAL}/annotations.txt", "dataset_name": "GenericDataset"}
    ],
}
```

**quantize (mandatory data sources):**
```python
{
    "dataset.train_dataset.data_sources": [
        {"data_file": f"{S3_TRAIN}/annotations.txt", "dataset_name": "Middlebury"}
    ],
    "dataset.val_dataset.data_sources": [
        {"data_file": f"{S3_EVAL}/annotations.txt", "dataset_name": "Middlebury"}
    ],
    "dataset.quant_calibration_dataset.images_dir": f"{S3_TRAIN}/images.tar.gz",
}
```
