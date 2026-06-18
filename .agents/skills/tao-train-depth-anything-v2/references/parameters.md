# Important Parameters

Full parameter glossary for the `depth_net` mono actions, plus the pretrained checkpoint loading use-case matrix.

- **model.model_type**: Model architecture. Options: `MetricDepthAnything`, `RelativeDepthAnything`. Default `MetricDepthAnything`.
- **model.encoder**: Backbone encoder (top-level `model` field, not nested under `mono_backbone`). Options: `vits`, `vitb`, `vitl`, `vitg`. Default `vitl`.
- **model.mono_backbone.pretrained_path**: Path to **DINOv2 ViT-L encoder weights** (used for Relative train-from-scratch only — Metric and Relative finetune use `train.pretrained_model_path` + a TAO ckpt instead; see use-case matrix below). Architecturally identical to the DepthAnything v2 encoder (same ViT-L), but the weights differ: DINOv2 is the self-supervised pretraining used to initialize the Relative DepthAnything encoder before depth-supervised training. Set to an empty string (`""`) to skip the backbone-only weight load — use this when the full TAO checkpoint is supplied via `train.pretrained_model_path` (Pytorch-Lightning state) or `evaluate.checkpoint` / `inference.checkpoint`, since those carry the backbone state already. Setting both is redundant; the backbone-only load happens first and is then overwritten by the full-state load.
- **model.mono_backbone.use_bn** / **model.mono_backbone.use_clstoken**: Backbone toggles. Booleans. Defaults: `use_bn: False`, `use_clstoken: False` (matches the released `RelativeDepthAnything` and `MetricDepthAnything` checkpoint architectures). Override only when training a custom variant whose checkpoint was produced with the alternate setting.
- **train.optim.lr**: Learning rate. Default 1e-4 (AdamW).
- **train.lr_scheduler**: LR scheduler. Options: MultiStepLR, StepLR, CustomMultiStepLRScheduler, LambdaLR, PolynomialLR, OneCycleLR, CosineAnnealingLR.
- **train.precision**: Training precision. Options: fp32 (recommended), bf16 (Ampere SM80+, alternative), fp16.
- **train.distributed_strategy**: Distribution strategy. Options: ddp, fsdp.
- **train.activation_checkpoint**: Enable activation checkpointing. Default False.
- **dataset.dataset_name**: Top-level dataset family identifier (e.g., `MonoDataset`).
- **dataset.{train,val,test,infer}_dataset.batch_size**: Per-split batch size.
- **dataset.{train,val,test,infer}_dataset.workers**: Per-split DataLoader worker count (the field name is `workers`, not `num_workers`).
- **dataset.{train,val,test,infer}_dataset.augmentation.crop_size**: Per-split crop size. Default `[518, 518]`.
- **dataset.{train,val,test,infer}_dataset.data_sources**: List of `{data_file, dataset_name}` dicts. Both fields are mandatory per entry.
- **dataset.max_depth** / **dataset.min_depth**: Top-level depth range for metric depth estimation.
- **export.input_channel**: ONNX input channel count. Default `3` (RGB), matching the runtime input expected by `RelativeDepthAnythingV2` / `MetricDepthAnythingV2`. Source: `experiment_mono_relative.yaml` export block.
- **export.input_height** / **export.input_width**: ONNX input spatial dims. Default `518` / `518`, matching the model's training-time crop. Override only when targeting a different deployment input shape — the model's positional embeddings constrain practical shapes to multiples of the patch size (14 for ViT-L).
- **export.opset_version**: ONNX opset target. Default `17` (native LayerNormalization op for fp16 stability). Source: `experiment_mono_relative.yaml` export block.
- **export.on_cpu**: Whether ONNX export runs on CPU. Default `False` (uses `export.gpu_id`). Source: `experiment_mono_relative.yaml` export block.
- **export.gpu_id**: GPU device index for ONNX export when `on_cpu: False`. Default `0`. Source: `experiment_mono_relative.yaml` export block. Should match the `--gpus '"device=N"'` flag passed to `docker run`.
- **export.batch_size**: ONNX batch size. `1` = static, `-1` = batch axis dynamic. Height and width are always taken from the trace shape; H/W dynamic is not supported. Default `-1`.
- **inference.save_raw_pfm**: Whether the inference action additionally writes raw single-channel disparity as `.pfm` files alongside the visualization JPGs. Default `False`. Source: `experiment_mono_relative.yaml` inference block. Set `True` for downstream metric computation; raw disparity is unbounded scale-shift-invariant for `RelativeDepthAnything` and bounded to `[min_depth, max_depth]` for `MetricDepthAnything`. With the default, the inference action emits a 240×960 RGB JPG triptych under `<results_dir>/inference/inference_images/` mirroring the source dataset's directory tree.

## Pretrained checkpoint loading — use case matrix

| Use case | `model.mono_backbone.pretrained_path` | `train.pretrained_model_path` |
|---|---|---|
| Relative — train from scratch (DINOv2 backbone weights only) | `<DINOv2 ViT-L weights>` | `""` |
| Relative — finetune from TAO relative checkpoint | `""` | `<TAO relative ckpt>` |
| Metric — train from scratch on top of relative backbone (sanity) | `<TAO relative ckpt>` | `""` |
| Metric — finetune from TAO metric checkpoint | `""` | `<TAO metric ckpt>` |

Setting both keys is redundant: the backbone-only load happens first and is overwritten by the full-state load. The metric variant requires the `MetricDepthAnythingV2` head naming (`metric_depth_head.*`); see **Checkpoint compatibility** in `finetuning.md`.
