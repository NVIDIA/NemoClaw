# FastFoundationStereo Spec Overrides

Per-action spec override blocks for FastFoundationStereo (FFS). Data source overrides are **mandatory for every action**. Each `data_sources` entry is a dict with **two mandatory fields**: `data_file` and `dataset_name`. The `model.*` width fields in `FFS_MODEL_BLOCK` are also mandatory.

The spec templates at `references/spec_template_*.yaml` carry the bp2 width block as the canonical source.

## Shared bp2 model block

```python
S3_TRAIN = "aws://bucket/data/train"
S3_EVAL = "aws://bucket/data/eval"
BP2_CKPT = "/workspace/models/ffs/model_best_bp2_serialize.pth"

FFS_MODEL_BLOCK = {
    "model.model_type": "FastFoundationStereo",
    "model.encoder": "vitl",
    "model.hidden_dims": [128],
    "model.n_gru_layers": 1,
    "model.corr_radius": 4,
    "model.corr_levels": 2,
    "model.n_downsample": 2,
    "model.valid_iters": 8,
    "model.max_disparity": 192,
    "model.volume_dim": 28,
    "model.mixed_precision": False,
    "model.gwc_feature_normalize": True,
    "model.motion_encoder_widths": [56, 96, 16, 12],
    "model.motion_encoder_final": 48,
    "model.gru_hidden": 60,
    "model.gru_gating_conv_widths": [100, 168],
    "model.disp_head_input_dim": 60,
    "model.disp_head_intermediate": 36,
    "model.disp_head_pwconv1_widths": [212, 244],
    "model.mask_widths": [32, 16],
    "model.stem_2_widths": [12, 16],
    "model.spx_2_gru_widths": [16, 12, 16, 24],
    "model.spx_gru_out": 9,
    "model.classifier_mid": 14,
    "model.cnet_conv04_widths": [60, 48],
    "model.cam_mid_channels": 8,
    "model.cost_agg_conv_patch_padding": [0, 0, 0],
}
```

## train (finetune from bp2)

```python
{
    **FFS_MODEL_BLOCK,
    "train.num_epochs": 1,
    "train.checkpoint_interval": 1,
    "train.validation_interval": 1,
    "train.num_gpus": 1,
    "train.precision": "fp32",
    "train.pretrained_model_path": BP2_CKPT,
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

## evaluate (raw bp2 — no train job parent)

```python
{
    **FFS_MODEL_BLOCK,
    "evaluate.checkpoint": BP2_CKPT,
    "dataset.test_dataset.batch_size": 1,
    "dataset.test_dataset.workers": 4,
    "dataset.test_dataset.augmentation.crop_size": [480, 736],
    "dataset.test_dataset.data_sources": [
        {"data_file": f"{S3_EVAL}/annotations.txt", "dataset_name": "Middlebury"}
    ],
}
```

## inference (raw bp2 — 2-col annotations, no GT)

```python
{
    **FFS_MODEL_BLOCK,
    "inference.checkpoint": BP2_CKPT,
    "dataset.infer_dataset.batch_size": 1,
    "dataset.infer_dataset.workers": 4,
    "dataset.infer_dataset.data_sources": [
        {"data_file": f"{S3_EVAL}/annotations.txt", "dataset_name": "GenericDataset"}
    ],
}
```

## export (raw bp2)

```python
{
    **FFS_MODEL_BLOCK,
    "export.checkpoint": BP2_CKPT,
    "export.batch_size": 1,
    "export.input_height": 480,
    "export.input_width": 736,
    "export.opset_version": 17,
    "export.on_cpu": False,
}
```

For finetuned-ckpt actions (post-train), drop the explicit `<action>.checkpoint` and let the SDK resolve it from `parent_job_id` via `parent_model` (see "Spec Param / Parent Model Inference" in `references/parent-model-inference.md`).
