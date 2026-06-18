<!--
Copyright (c) 2026, NVIDIA CORPORATION.  All rights reserved.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
-->

Full Phase 3 walkthrough — tao-core config schema, tao-pytorch native implementation (build_model, backbone, PLModel, scripts, entrypoint, experiment_spec.yaml), multi-GPU setup, native inference / evaluate endpoints, and MLOps wiring. The largest reference; mirrors the original Phase 3 content verbatim.

## Phase 3 — TAO Core Configuration & Native Implementation

> Use `<model_name>` as the `snake_case` short-name from Phase 1. Use `<ModelName>` as the `PascalCase` equivalent.

### Task-Type-Specific Implementation Notes

**Before writing code**, understand what differs based on task type (from Phase 2.1):

**Classification** — Simplest path:
- `backbone.forward(x)` returns logits directly
- Single ONNX output, reuse `ClassificationEngineBuilder`/`Inferencer`/`Loader`
- Dataset: class subdirectories, `classes.txt`

**Detection** — Must additionally implement:
- Multi-scale feature extraction: `backbone.forward_feature_pyramid(x)`
- Transformer encoder/decoder with deformable attention
- Hungarian matching loss (bipartite assignment)
- Multi-output ONNX export (pred_logits + pred_boxes)
- Post-processing: sigmoid → Top-K selection → box coord scaling
- Custom or reused `DDETRDetEngineBuilder` / `DDETRInferencer`
- COCO JSON dataset format, COCO mAP metrics

**Segmentation** — Must additionally implement:
- Multi-scale features: `backbone.forward_feature_pyramid(x)`
- Decode head with multi-resolution fusion + upsampling
- Per-pixel loss with `ignore_index` support
- Dynamic spatial ONNX dims (`height`, `width` axes)
- Custom or reused `SegformerEngineBuilder` / `SegformerInferencer`
- Image + mask pair dataset, mIoU metrics

**Instance/Panoptic Segmentation** — Most complex:
- Query-based instance prediction (like detection but with masks)
- Multi-output ONNX (logits + masks at reduced resolution)
- Post-processing: filter instances, upsample masks, merge overlaps
- COCO instance/panoptic format

**Zero-Shot Detection** — Multi-modal:
- BERT text encoder required (additional ONNX inputs)
- Contrastive class prediction (logit shape depends on text length)
- Tokenizer needed at inference time

See [task-type-guide.md](task-type-guide.md) for complete details on each task type.

### Step 1 — Define Model Spec & Hyperparameter Schema (`tao-core`)

Create three files in `tao-core/nvidia_tao_core/config/<model_name>/`:

**1a. `__init__.py`** — empty init

**1b. `default_config.py`** — All OmegaConf dataclass definitions:
- Use field constructors from `nvidia_tao_core.config.utils.types`: `BOOL_FIELD`, `STR_FIELD`, `INT_FIELD`, `FLOAT_FIELD`, `LIST_FIELD`, `DICT_FIELD`, `DATACLASS_FIELD`
- Subclass `CommonExperimentConfig` for the top-level `ExperimentConfig`
- Extend base configs: `TrainConfig`, `EvaluateConfig`, `InferenceConfig`, `ExportConfig`, `GenTrtEngineConfig` from `nvidia_tao_core.config.common.common_config`
- Define task-specific blocks: `ModelConfig` (containing `BackboneConfig` + `HeadConfig`), `DatasetConfig`, `AugmentationConfig`, `OptimConfig`, `LossConfig`, `TensorBoardLogger`
- The `BackboneConfig.type` field must list all supported backbone variants in `valid_options`
- Implement `__post_init__` on `ExperimentConfig` to set `self.model_name = "<model_name>"`

The `ExperimentConfig` MUST contain ALL of these top-level sections (they drive both tao-pytorch and tao-deploy scripts):
```python
@dataclass
class ExperimentConfig(CommonExperimentConfig):
    model: ModelConfig               = DATACLASS_FIELD(ModelConfig())
    dataset: DatasetConfig           = DATACLASS_FIELD(DatasetConfig())
    train: TrainExpConfig            = DATACLASS_FIELD(TrainExpConfig())
    evaluate: EvalExpConfig          = DATACLASS_FIELD(EvalExpConfig())
    inference: InferenceExpConfig    = DATACLASS_FIELD(InferenceExpConfig())
    export: ExportExpConfig          = DATACLASS_FIELD(ExportExpConfig())
    gen_trt_engine: GenTrtEngineExpConfig = DATACLASS_FIELD(GenTrtEngineExpConfig())
    quantize: ModelQuantizationConfig = DATACLASS_FIELD(ModelQuantizationConfig())
    # Inherited from CommonExperimentConfig: encryption_key, results_dir, wandb
```
Each `*ExpConfig` extends the corresponding base from `common_config.py` and adds task-specific fields. The field names here become the YAML keys and CLI override paths (e.g., `train.optim.lr`, `gen_trt_engine.tensorrt.data_type`).

**1c. `model_params_mapping.py`** — Maps backbone names to their embedding dimensions:
```python
map_params = {
    "head": {
        "in_channels": {
            "<backbone_variant_1>": 768,
            "<backbone_variant_2>": 1024,
            # ... one entry per backbone variant
        }
    }
}
```
This is used by `build_model()` to automatically wire the correct input dimension from backbone to task head.

**After creating**, verify the config is importable. Use the prepared TAO Toolkit container (from Phase 0):
```bash
docker run --rm \
  -v $(pwd):/workspace \
  -w /workspace/tao-core \
  tao-pytorch-base:latest \
  bash -c "pip install . && \
    python3 -c \"from nvidia_tao_core.config.<model_name>.default_config import ExperimentConfig; print('Config OK')\""
```
Then present the configuration to the user for review. Highlight important model blocks, dataset format objects, and any decisions about hyperparameter defaults. Do not proceed until the user confirms.

### Step 2 — Implement Base Trainer (`tao-pytorch`)

**Directory:** `tao-pytorch/nvidia_tao_pytorch/cv/<model_name>/`

Required sub-directories and files:
```
<model_name>/
├── __init__.py
├── model/
│   ├── __init__.py
│   ├── <model_name>.py             # build_model() + nn.Module
│   ├── <model_name>_pl_model.py   # TAOLightningModule subclass
│   └── utils.py                    # State dict adapter, weight loading
├── dataloader/
│   ├── __init__.py
│   ├── dataset.py                  # torch.utils.data.Dataset
│   └── pl_<model_name>_data_module.py  # pl.LightningDataModule
├── scripts/
│   ├── __init__.py
│   ├── train.py
│   ├── evaluate.py
│   ├── inference.py
│   └── export.py
├── entrypoint/
│   ├── __init__.py
│   └── <model_name>.py
├── experiment_specs/
│   └── experiment_spec.yaml        # Default experiment config YAML
└── utils/
    └── __init__.py
```

**`model/<model_name>.py`** — Must contain a `build_model()` function:
```python
from nvidia_tao_pytorch.cv.backbone_v2.registry import BACKBONE_REGISTRY

def build_model(experiment_config, export=False):
    model_config = experiment_config.model
    backbone_type = model_config.backbone.type

    model = BACKBONE_REGISTRY.get(backbone_type)(
        num_classes=experiment_config.dataset.num_classes,
        freeze_at='all' if model_config.backbone.freeze_backbone else None,
        freeze_norm=model_config.backbone.freeze_norm,
        export=export
    )

    # Unfreeze head even if backbone is frozen
    if model_config.backbone.freeze_backbone:
        head = model.get_classifier()
        for p in head.parameters():
            p.requires_grad = True
        head.train()

    # Load pretrained weights with state dict adapter
    if model_config.backbone.pretrained_backbone_path:
        state_dict = load_pretrained_weights(
            model_config.backbone.pretrained_backbone_path,
            parser=...,         # Removes "module." prefix, etc.
            ptm_adapter=...     # Adapts prefixes for different checkpoint formats
        )
        model.load_state_dict(state_dict, strict=False)

    return model
```

If the HF model introduces a **new backbone** not in `backbone_v2/`, you must implement one. This is significant work — study `backbone_v2/vit.py` (~677 lines) as the reference before starting. The implementation strategy was determined in Phase 2.3.

**File:** `tao-pytorch/nvidia_tao_pytorch/cv/backbone_v2/<backbone_name>.py`

**IMPORTANT — Do NOT dual-inherit from `transformers.PreTrainedModel`:** HuggingFace's `PreTrainedModel` has metaclass/mixin machinery that conflicts with TAO's `BackboneMeta`. Instead, use one of these two patterns:

**Pattern A (preferred) — Re-implement + dual-inherit from timm or plain nn.Module:**
Study the HF model source, then re-implement the architecture as a pure PyTorch module. This is what all existing TAO backbones do — they use `timm` models (which are plain `nn.Module`), NOT HF `transformers` models. Do NOT import from `transformers` at runtime — the TAO Toolkit images do not include it.

```python
from timm.models.some_model import SomeModel  # or plain nn.Module if no timm equivalent
from nvidia_tao_pytorch.cv.backbone_v2 import BACKBONE_REGISTRY
from nvidia_tao_pytorch.cv.backbone_v2.backbone_base import BackboneBase

class <BackboneName>(SomeModel, BackboneBase):
    """Dual-inherit: timm/nn.Module provides architecture, BackboneBase provides TAO integration."""

    def __init__(self, *args, **kwargs):
        # Extract TAO-specific kwargs BEFORE passing to parent constructor
        # (parent constructor does not understand these kwargs)
        in_chans = kwargs.get("in_chans", 3)
        num_classes = kwargs.get("num_classes", 1000)
        activation_checkpoint = kwargs.pop("activation_checkpoint", False)
        freeze_at = kwargs.pop("freeze_at", None)
        freeze_norm = kwargs.pop("freeze_norm", False)
        export = kwargs.pop("export", False)
        img_size = kwargs.pop("img_size", [224, 224])

        # Call parent model constructor (timm/nn.Module)
        super().__init__(*args, **kwargs)

        # Call BackboneBase init for TAO integration
        BackboneBase.__init__(
            self, in_chans=in_chans, num_classes=num_classes,
            activation_checkpoint=activation_checkpoint,
            freeze_at=freeze_at, freeze_norm=freeze_norm,
            export=export, img_size=img_size,
        )
```

**Pattern B (fallback) — Compose HF model as internal attribute:**
When the architecture is too complex to re-implement, wrap the HF model inside a `BackboneBase` subclass. This requires `transformers` at runtime — install it in the container.

```python
from nvidia_tao_pytorch.cv.backbone_v2 import BACKBONE_REGISTRY
from nvidia_tao_pytorch.cv.backbone_v2.backbone_base import BackboneBase

class <BackboneName>(BackboneBase):
    """Wraps HF model as internal attribute."""

    def __init__(self, hf_model_id="acme/newarch-base", pretrained=True, **kwargs):
        num_classes = kwargs.pop("num_classes", 1000)
        super().__init__(num_classes=num_classes, **kwargs)

        # Use pretrained=True only for initial training. When loading from checkpoint
        # (evaluate/inference/export), pass pretrained=False to avoid redundant downloads.
        from transformers import AutoModel, AutoConfig
        if pretrained:
            self.backbone = AutoModel.from_pretrained(hf_model_id)
        else:
            self.backbone = AutoModel.from_config(AutoConfig.from_pretrained(hf_model_id))
        self.embed_dim = self.backbone.config.hidden_size
        self.head = nn.Linear(self.embed_dim, num_classes)

    def forward_pre_logits(self, x):
        outputs = self.backbone(pixel_values=x)
        # Extract tensor from HF BaseModelOutput (not a plain tensor)
        return outputs.last_hidden_state[:, 0]  # CLS token or pooled output

    def forward(self, x):
        return self.head(self.forward_pre_logits(x))
```

**Pattern B requirements:**

1. **`pretrained` flag:** The factory function must pass `pretrained=True` for training and `pretrained=False` for checkpoint loading. In `build_model()`, set `pretrained=False` when `export=True` or when loading from a checkpoint:
   ```python
   model = BACKBONE_REGISTRY.get(backbone_type)(pretrained=not export, **kwargs)
   ```

2. **ONNX export:** After implementing the wrapper, re-test ONNX export against the TAO-wrapped model (not just the raw HF model from Phase 1). HF models return `BaseModelOutput` namedtuples — your `forward()` must return plain tensors. The `forward_pre_logits` extraction (`.last_hidden_state[:, 0]`) handles this, but verify the full `forward()` traces cleanly:
   ```python
   torch.onnx.export(model, dummy, ..., input_names=["input"], output_names=["output"])
   ```

3. **Set `model.backbone.pretrained_backbone_path: null`** in the experiment spec — HF weights are loaded by `from_pretrained()`, not by the TAO weight loading path.

**6 abstract methods** — ALL must be implemented regardless of pattern:
```python
def get_stage_dict(self) -> dict:
    """Map stage-index → nn.Module for layer freezing.
    Inspect the model's layers to identify logical stages.
    For transformers: {0: patch_embed, 1: blocks[:N//3], 2: blocks[N//3:2*N//3], 3: blocks[2*N//3:]}
    For CNNs: {0: stem, 1: layer1, 2: layer2, 3: layer3, 4: layer4}"""

def get_classifier(self) -> nn.Module:
    """Return the classification head (self.head)."""

def reset_classifier(self, num_classes, **kwargs):
    """Replace head for different num_classes."""

def forward_pre_logits(self, x):
    """Features WITHOUT head. Shape: [B, embed_dim] for classification,
    or [B, H*W, C] for spatial features."""

def forward_feature_pyramid(self, x, indices=None, **kwargs):
    """Multi-scale feature maps for detection/segmentation.
    To find tapping points: run forward pass with hooks on intermediate layers,
    print shapes at each layer, identify 4 stages at strides ~[4, 8, 16, 32].
    For classification-only models, return {0: forward_pre_logits(x)}."""

def forward(self, x):
    """Full forward: features → head → logits."""
```

**Finding feature pyramid tapping points** (for detection/segmentation):
```python
# Run this inside the long-lived Phase 1 `tao-hf-inspect` container (docker exec)
# to discover intermediate feature shapes:
model = ...  # instantiate the backbone
hooks, features = [], {}
for name, module in model.named_modules():
    def hook_fn(name):
        def fn(m, inp, out):
            if isinstance(out, torch.Tensor):
                features[name] = out.shape
        return fn
    hooks.append(module.register_forward_hook(hook_fn(name)))
model(torch.randn(1, 3, 224, 224))
for name, shape in features.items():
    if len(shape) >= 3:  # spatial features
        print(f"{name}: {shape}")
# Look for 4 feature maps at decreasing spatial resolution
```

**Factory functions** — one per variant, registered with the backbone registry:
```python
@BACKBONE_REGISTRY.register()
def <backbone_variant_name>(**kwargs):
    """Called by build_model() via BACKBONE_REGISTRY.get(backbone_type)(**kwargs).
    kwargs from TAO: num_classes, freeze_at, freeze_norm, export, img_size, in_chans, etc."""
    return <BackboneName>(
        embed_dim=768, depth=12, num_heads=12,  # variant-specific architecture params
        **kwargs,
    )
```

**HF weight loading (Pattern A only — Pattern B loads weights automatically):**
The HF model's `state_dict` keys will NOT match the re-implemented TAO module names. Create a systematic key remapping in `model/utils.py`:
```python
def convert_hf_state_dict(hf_state_dict, tao_model):
    """Map HF parameter names to TAO nn.Module names."""
    # Step 1: Get the TAO model's expected keys
    tao_keys = set(tao_model.state_dict().keys())

    # Step 2: Build mapping (use regex for systematic patterns)
    import re
    tao_sd = {}
    for hf_key, tensor in hf_state_dict.items():
        tao_key = hf_key
        tao_key = re.sub(r'^encoder\.layer\.(\d+)\.', r'blocks.\1.', tao_key)
        tao_key = re.sub(r'^embeddings\.patch_embeddings\.', 'patch_embed.', tao_key)
        tao_key = tao_key.replace('layernorm', 'norm').replace('classifier', 'head')
        tao_sd[tao_key] = tensor

    # Step 3: Verify coverage
    mapped_keys = set(tao_sd.keys())
    missing = tao_keys - mapped_keys
    unexpected = mapped_keys - tao_keys
    if missing:
        print(f"WARNING: {len(missing)} missing keys: {list(missing)[:5]}...")
    if unexpected:
        print(f"WARNING: {len(unexpected)} unexpected keys: {list(unexpected)[:5]}...")

    return tao_sd
```

Download HF weights once and save as `.pth` for use with `pretrained_backbone_path`:
```python
# Inside the long-lived Phase 1 `tao-hf-inspect` container:
from transformers import AutoModel
model = AutoModel.from_pretrained("acme/newarch-base")
torch.save(model.state_dict(), "/path/to/newarch_hf_weights.pth")
# Then in experiment_spec.yaml: model.backbone.pretrained_backbone_path: /path/to/newarch_hf_weights.pth
```

**After creating**, add the import to `backbone_v2/__init__.py`:
```python
from nvidia_tao_pytorch.cv.backbone_v2.<backbone_name> import *  # noqa
```

**Test immediately** — verify the backbone builds and produces correct output shapes:
```bash
docker run --rm --gpus all \
  -v $(pwd):/workspace -w /workspace/tao-pytorch \
  -e PYTHONPATH=/workspace/tao-core:/workspace/tao-pytorch \
  tao-pytorch-base:latest \
  bash -c "pip install /workspace/tao-core && python setup.py develop && \
    python3 -c \"
from nvidia_tao_pytorch.cv.backbone_v2.registry import BACKBONE_REGISTRY
print('Registered:', list(BACKBONE_REGISTRY.keys()))
model = BACKBONE_REGISTRY.get('<backbone_variant_name>')(num_classes=10)
import torch; x = torch.randn(1, 3, 224, 224)
out = model(x)
print(f'Output: {out.shape}')  # Should be [1, 10]
feat = model.forward_pre_logits(x)
print(f'Features: {feat.shape}')  # Should be [1, embed_dim]
\""
```

**`model/utils.py`** — HF checkpoint conversion:
```python
def convert_hf_state_dict(hf_state_dict):
    """Map HuggingFace parameter names to TAO nn.Module names."""
    mapping = {
        "hf.key.name": "tao.key.name",
        # ... one entry per layer
    }
    tao_sd = {}
    for hf_key, tensor in hf_state_dict.items():
        tao_sd[mapping.get(hf_key, hf_key)] = tensor
    return tao_sd
```

**`model/<model_name>_pl_model.py`** — Subclass `TAOLightningModule`. The `__init__` signature must accept `experiment_spec` as a keyword argument because `load_from_checkpoint()` passes it that way:
```python
from nvidia_tao_pytorch.core.lightning.tao_lightning_module import TAOLightningModule
from pytorch_lightning.callbacks import ModelCheckpoint, LearningRateMonitor

class <ModelName>PlModel(TAOLightningModule):
    def __init__(self, experiment_spec, export=False):
        super().__init__(experiment_spec)
        # checkpoint_filename controls naming: <name>_model_latest.pth symlink
        # and model_{epoch:03d}.pth per-epoch checkpoints
        self.checkpoint_filename = "<model_name>_model"
        self.dataset_config  = self.experiment_spec.dataset
        self.model_config    = self.experiment_spec.model
        self.train_config    = self.experiment_spec.train
        self.eval_config     = self.experiment_spec.evaluate
        self.infer_config    = self.experiment_spec.inference
        self._build_model(export)
        self._build_criterion()

    def _build_model(self, export):
        self.model = build_model(experiment_config=self.experiment_spec, export=export)

    def training_step(self, batch, batch_idx): ...
    def validation_step(self, batch, batch_idx): ...

    def test_step(self, batch, batch_idx):
        """Called by trainer.test() in evaluate.py. Compute metrics here."""
        ...

    def predict_step(self, batch, batch_idx):
        """Called by trainer.predict() in inference.py. Write result.csv here."""
        ...

    def on_train_epoch_end(self): ...
    def on_validation_epoch_end(self): ...

    def configure_callbacks(self):
        """Return callbacks list. ModelCheckpoint naming must match spec references."""
        callbacks = [TAOStatusLogger()]

        # Checkpoint callback — naming determines what evaluate/inference specs reference
        ckpt_cb = ModelCheckpoint(
            filename="model_{epoch:03d}",
            every_n_epochs=self.train_config.checkpoint_interval,
            save_last="link",       # Creates <checkpoint_filename>_latest.pth symlink
            save_top_k=-1,          # Keep all checkpoints
            save_on_train_epoch_end=True,
            dirpath=self.experiment_spec.results_dir,
        )
        callbacks.append(ckpt_cb)
        callbacks.append(LearningRateMonitor(logging_interval="step"))

        # Optional EMA
        if getattr(self.train_config, 'enable_ema', False):
            callbacks.append(EMAModelCheckpoint(...))

        return callbacks

    def configure_optimizers(self):
        """Return optimizer + LR scheduler. Support: adamw, adam, sgd + linear/step/cosine/multistep."""
        ...

    def on_save_checkpoint(self, checkpoint):
        checkpoint["tao_model"] = "<model_name>"

    def on_test_epoch_end(self):
        """Write results.json with metrics to results_dir (for evaluate.py)."""
        ...

    def on_predict_epoch_end(self):
        """Write result.csv with predictions to results_dir (for inference.py)."""
        ...
```

**`load_from_checkpoint` contract:** The evaluate, inference, and export scripts all call:
```python
model = <ModelName>PlModel.load_from_checkpoint(
    checkpoint_path, map_location="cpu", experiment_spec=cfg
)
```
Lightning passes `experiment_spec=cfg` as a keyword argument to `__init__`. The PLModel must accept it.

**`scripts/train.py`** — Training script. Must handle multi-GPU strategy, precision mapping, and sampler delegation:
```python
from nvidia_tao_pytorch.core.hydra.hydra_runner import hydra_runner
from nvidia_tao_pytorch.core.decorators.workflow import monitor_status
from nvidia_tao_pytorch.core.initialize_experiments import initialize_train_experiment
from nvidia_tao_pytorch.core.tlt_logging import obfuscate_logs

@hydra_runner(config_path=os.path.join(spec_root, "experiment_specs"),
              config_name="experiment_spec", schema=ExperimentConfig)
@monitor_status(name="<ModelName>", mode="train")
def main(cfg: ExperimentConfig) -> None:
    obfuscate_logs(cfg)
    run_experiment(experiment_config=cfg, key=cfg.encryption_key,
                   lightning_module=<ModelName>PlModel)

def run_experiment(experiment_config, key, lightning_module):
    # initialize_train_experiment returns (resume_ckpt, trainer_kwargs)
    # trainer_kwargs includes: devices, max_epochs, check_val_every_n_epoch,
    # default_root_dir, accelerator='gpu', logger=[TBLogger, optional WandB],
    # enable_checkpointing=False (PLModel provides its own ModelCheckpoint)
    resume_ckpt, trainer_kwargs = initialize_train_experiment(experiment_config, key)

    dm = <ModelName>DataModule(experiment_config.dataset)
    dm.setup(stage="fit")
    model = lightning_module(experiment_config)

    # DDP strategy: use ddp with find_unused_parameters for multi-GPU
    num_devices = len(trainer_kwargs.get('devices', [0]))
    strategy = 'ddp_find_unused_parameters_true' if num_devices > 1 else 'auto'

    # Precision mapping: TAO config values → Lightning format
    precision_map = {'fp16': '16-mixed', 'bf16': 'bf16-mixed', 'fp32': '32-true'}
    precision = precision_map.get(experiment_config.train.precision.lower(), '32-true')

    trainer = Trainer(
        **trainer_kwargs,
        gradient_clip_val=experiment_config.train.clip_grad_norm,
        num_nodes=experiment_config.train.num_nodes,
        strategy=strategy,
        precision=precision,
        use_distributed_sampler=False,  # DataModule provides its own DistributedSampler
        sync_batchnorm=True,
    )
    trainer.fit(model, dm, ckpt_path=resume_ckpt)
```

**`entrypoint/<model_name>.py`** — CLI entrypoint using the core dispatcher:
```python
from nvidia_tao_pytorch.core.entrypoint import get_subtasks, launch, command_line_parser
from nvidia_tao_pytorch.cv.<model_name> import scripts

def get_subtask_list():
    return get_subtasks(scripts)

def main():
    parser = argparse.ArgumentParser("<model_name>", ...)
    subtasks = get_subtask_list()
    args, unknown_args = command_line_parser(parser, subtasks)
    launch(vars(args), unknown_args, subtasks, network="<model_name>")
```

**`experiment_specs/experiment_spec.yaml`** — Default YAML config. This YAML must mirror the `ExperimentConfig` dataclass field paths exactly — every key here is a dot-path into the dataclass. Include ALL sections (train, evaluate, inference, export, gen_trt_engine) so users can run the full pipeline from one spec:
```yaml
encryption_key: tlt_encode
results_dir: ???

model:
  backbone:
    type: "<default_backbone>"
    pretrained_backbone_path: null
    freeze_backbone: False
    freeze_norm: False
  head:
    type: TAOLinearClsHead
    in_channels: <embed_dim>    # Must match model_params_mapping.py for this backbone
    topk: [1, 5]
    loss:
      type: CrossEntropyLoss
      label_smooth_val: 0.0

dataset:
  dataset: "CLDataset"
  root_dir: ???                 # Directory containing classes.txt
  num_classes: ???
  img_size: 224
  batch_size: 8
  workers: 8
  shuffle: True
  augmentation:
    mean: [0.485, 0.456, 0.406]   # MUST match deploy specs and preprocess_mode
    std: [0.229, 0.224, 0.225]    # MUST match deploy specs and preprocess_mode
    random_flip:
      enable: True
      hflip_probability: 0.5
      vflip_probability: 0.0
    random_rotate:
      enable: False
    random_color:
      enable: False
    random_erase:
      enable: False
  train_dataset:
    images_dir: ${dataset.root_dir}/train
  val_dataset:
    images_dir: ${dataset.root_dir}/val
  test_dataset:
    images_dir: ${dataset.root_dir}/test

train:
  seed: 1234
  num_epochs: 25
  num_gpus: 1
  gpu_ids: [0]
  num_nodes: 1
  checkpoint_interval: 5
  validation_interval: 1
  resume_training_checkpoint_path: null
  clip_grad_norm: 2.0
  precision: fp32
  enable_ema: False
  optim:
    optim: "adamw"
    lr: 0.00006
    weight_decay: 0.05
    policy: "cosine"
    warmup_epochs: 5
    momentum: 0.9
  tensorboard:
    enabled: True

evaluate:
  checkpoint: ${results_dir}/train/<model_name>_model_latest.pth

inference:
  checkpoint: ${results_dir}/train/<model_name>_model_latest.pth

export:
  results_dir: ${results_dir}/export
  gpu_id: 0
  checkpoint: ${results_dir}/train/<model_name>_model_latest.pth
  onnx_file: ${export.results_dir}/<model_name>.onnx
  input_width: 224
  input_height: 224
  input_channel: 3
  batch_size: -1              # -1 = dynamic batch
  opset_version: 17

gen_trt_engine:
  onnx_file: ${export.results_dir}/<model_name>.onnx
  trt_engine: ${results_dir}/trt/<model_name>.engine
  tensorrt:
    data_type: FP16
    workspace_size: 1024
    min_batch_size: 1
    opt_batch_size: 4
    max_batch_size: 8
```
**Critical consistency rules:**
- `augmentation.mean`/`std` values here MUST be identical in the deploy specs (inference.yaml, evaluate.yaml)
- `model.head.in_channels` MUST match the value in `model_params_mapping.py` for the chosen backbone
- `<model_name>_model_latest.pth` in checkpoint paths MUST match `self.checkpoint_filename` in the PLModel
- `export.onnx_file` path MUST match what `gen_trt_engine.onnx_file` references
- All `???` fields are MISSING (required) — user must supply them via YAML or CLI override

**Incremental test checkpoint — verify before proceeding.**
Run these inside the prepared TAO Toolkit container. Do NOT install into the
host Python.

This smoke test does `pip install /workspace/tao-core && python setup.py develop`
at runtime — both write to the container's system site-packages (root-owned),
so we deliberately run the container as root (no `--user $(id -u):$(id -g)`).
Side-effects in the bind mount (`*.egg-info/`, `build/`) end up root-owned;
clean them with `sudo rm -rf` if needed, or skip cleanup since they're
regenerated on every re-test.

```bash
# Run via Docker (image tag prepared in Phase 0)
docker run --rm --gpus all \
  -v $(pwd):/workspace \
  -w /workspace/tao-pytorch \
  -e PYTHONPATH=/workspace/tao-core:/workspace/tao-pytorch \
  tao-pytorch-base:latest \
  bash -c 'pip install /workspace/tao-core && python setup.py develop &&
    # 1. Config imports cleanly
    python3 -c "from nvidia_tao_core.config.<model_name>.default_config import ExperimentConfig; print(\"Config OK\")"

    # 2. Model builds successfully
    python3 -c "
from nvidia_tao_core.config.<model_name>.default_config import ExperimentConfig
from nvidia_tao_pytorch.cv.<model_name>.model.<model_name> import build_model
from omegaconf import OmegaConf
cfg = OmegaConf.structured(ExperimentConfig())
cfg.dataset.num_classes = 10
model = build_model(cfg)
print(f\"Model params: {sum(p.numel() for p in model.parameters()):,}\")
"

    # 3. PLModel instantiates
    python3 -c "
from nvidia_tao_pytorch.cv.<model_name>.model.<model_name>_pl_model import <ModelName>PlModel
from omegaconf import OmegaConf
from nvidia_tao_core.config.<model_name>.default_config import ExperimentConfig
cfg = OmegaConf.structured(ExperimentConfig())
cfg.dataset.num_classes = 10
model = <ModelName>PlModel(cfg)
print(\"PLModel OK\")
"
  '
```
The local image tag (`tao-pytorch-base:latest`) was prepared in Phase 0 and should always be available. If it's missing, re-run the pull + preparation commands from Phase 0.

If any of these fail, fix the issue before moving on. Common problems: missing `__init__.py`, wrong import path, backbone not registered, field name mismatch between config and code.

### Step 3 — Multi-GPU/Multi-Node Support (conditional)

Multi-GPU is handled by the entrypoint's `launch()` function, which wraps the script with `torchrun`:
```
launch() reads: train.num_gpus, train.gpu_ids, train.num_nodes from spec
  → sets env var: TAO_VISIBLE_DEVICES=0,1,2,3
  → runs: torchrun --nnodes=N --nproc-per-node=M script.py --config-path ...
```

The train script (Step 2) then:
1. `initialize_train_experiment()` reads `TAO_VISIBLE_DEVICES` → sets `trainer_kwargs['devices']`
2. Creates `Trainer(strategy='ddp_find_unused_parameters_true', sync_batchnorm=True, use_distributed_sampler=False)`
3. The DataModule must create its own `DistributedSampler` when distributed

Only add custom distributor hooks from `nvidia_tao_pytorch.core.distributed.comm` (e.g., `get_global_rank()`, `get_world_size()`) if the model requires rank-specific logic beyond what Lightning provides.

### Step 4 — Native Inference Endpoint (`tao-pytorch`)

**File:** `tao-pytorch/nvidia_tao_pytorch/cv/<model_name>/scripts/inference.py`

Must follow the same config resolution and initialization pattern as training:
```python
from nvidia_tao_pytorch.core.initialize_experiments import initialize_inference_experiment

@hydra_runner(config_path=os.path.join(spec_root, "experiment_specs"),
              config_name="experiment_spec", schema=ExperimentConfig)
@monitor_status(name="<ModelName>", mode="inference")
def main(cfg: ExperimentConfig) -> None:
    obfuscate_logs(cfg)
    run_experiment(cfg, key=cfg.encryption_key)

def run_experiment(experiment_config, key):
    model_path, trainer_kwargs = initialize_inference_experiment(experiment_config, key)

    dm = <ModelName>DataModule(experiment_config.dataset)
    dm.setup(stage="predict")    # "predict" stage uses test_dataset

    model = <ModelName>PlModel.load_from_checkpoint(
        model_path, map_location="cpu", experiment_spec=experiment_config
    )

    trainer = Trainer(**trainer_kwargs)
    trainer.predict(model, datamodule=dm)
    # predict_step() in PLModel writes result.csv to results_dir
```
**Output:** `{results_dir}/result.csv` — columns: `img_name`, per-class probabilities, `pred_label`, `pred_score`

### Step 5 — Native Evaluation Endpoint (`tao-pytorch`)

**File:** `tao-pytorch/nvidia_tao_pytorch/cv/<model_name>/scripts/evaluate.py`

```python
from nvidia_tao_pytorch.core.initialize_experiments import initialize_evaluation_experiment

@hydra_runner(config_path=os.path.join(spec_root, "experiment_specs"),
              config_name="experiment_spec", schema=ExperimentConfig)
@monitor_status(name="<ModelName>", mode="evaluate")
def main(cfg: ExperimentConfig) -> None:
    obfuscate_logs(cfg)
    run_experiment(cfg, key=cfg.encryption_key)

def run_experiment(experiment_config, key):
    model_path, trainer_kwargs = initialize_evaluation_experiment(experiment_config, key)

    dm = <ModelName>DataModule(experiment_config.dataset)
    dm.setup(stage="test")       # "test" stage uses test_dataset with labels

    model = <ModelName>PlModel.load_from_checkpoint(
        model_path, map_location="cpu", experiment_spec=experiment_config
    )

    trainer = Trainer(**trainer_kwargs)
    trainer.test(model, datamodule=dm)
    # test_step() / on_test_epoch_end() in PLModel computes metrics
    # and writes results.json to results_dir
```
**Output:** `{results_dir}/results.json` — task-appropriate metrics (top-k accuracy, mAP, mIoU).

Compute task-appropriate metrics and log via status logging:
```python
status_logging.get_status_logger().kpi = {"val_acc_1": ..., "val_loss": ...}
status_logging.get_status_logger().write(
    message="Eval metrics generated.",
    status_level=status_logging.Status.RUNNING
)
```

### Step 6 — Enable MLOps & Visualization for Training

In the PL model's `training_step` and `on_train_epoch_end`:
- Log training scalars with `self.log("train_loss", loss, ...)` and `self.log("lr", ...)`
- Add `TensorBoardLogger` config block in `default_config.py`
- Use `TAOStatusLogger` callback in `configure_callbacks()` for `status.json` writes
- Use `LearningRateMonitor(logging_interval="step")` callback

### Step 7 — Enable MLOps & Visualization for Eval/Infer

Extend status logging to the **standalone** eval and inference scripts (not just PL training):
- Both `scripts/evaluate.py` and `scripts/inference.py` use `@monitor_status`, which already writes `status.json` (STARTED → RUNNING → complete/failure)
- Within the eval script, write metrics to `results.json` in `cfg.results_dir`
- Within the inference script, write predictions to `result.csv` in `cfg.results_dir`
- The `@monitor_status` decorator also saves `experiment.yaml` to results_dir for reproducibility

---

