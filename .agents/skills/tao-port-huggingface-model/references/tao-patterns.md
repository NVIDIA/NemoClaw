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

# TAO Toolkit Code Patterns

Canonical patterns extracted from the TAO submodules. Always read the actual source files before implementing — these are guides, not templates to copy blindly.

---

## 1. Config Dataclasses (`tao-core`)

**Location:** `tao-core/nvidia_tao_core/config/<model_name>/default_config.py`

### Field types
All fields use typed constructors from `nvidia_tao_core.config.utils.types`:

```python
from nvidia_tao_core.config.utils.types import (
    BOOL_FIELD, STR_FIELD, INT_FIELD, FLOAT_FIELD,
    LIST_FIELD, DICT_FIELD, DATACLASS_FIELD,
)
```

| Type | Usage |
|------|-------|
| `STR_FIELD(value=..., valid_options=..., description=...)` | String fields, optionally constrained |
| `INT_FIELD(value=..., valid_min=..., valid_max=..., automl_enabled=...)` | Integers |
| `FLOAT_FIELD(value=..., valid_min=..., math_cond=..., automl_enabled=...)` | Floats |
| `BOOL_FIELD(value=..., description=...)` | Booleans |
| `LIST_FIELD(arrList=[...], description=...)` | Lists |
| `DICT_FIELD({...}, default_value={...}, description=...)` | Dicts |
| `DATACLASS_FIELD(DataclassInstance())` | Nested dataclasses |

### Base classes for sub-configs
```python
from nvidia_tao_core.config.common.common_config import (
    CommonExperimentConfig,  # Top-level base
    TrainConfig,
    EvaluateConfig,
    InferenceConfig,
    ExportConfig,
    GenTrtEngineConfig,
    TrtConfig,
    CalibrationConfig,
)
```

### Top-level ExperimentConfig pattern
```python
@dataclass
class ExperimentConfig(CommonExperimentConfig):
    model:        ModelConfig           = DATACLASS_FIELD(ModelConfig())
    dataset:      DatasetConfig         = DATACLASS_FIELD(DatasetConfig())
    train:        TrainExpConfig        = DATACLASS_FIELD(TrainExpConfig())
    evaluate:     EvalExpConfig         = DATACLASS_FIELD(EvalExpConfig())
    inference:    InferenceExpConfig    = DATACLASS_FIELD(InferenceExpConfig())
    export:       ExportExpConfig       = DATACLASS_FIELD(ExportExpConfig())
    gen_trt_engine: GenTrtEngineExpConfig = DATACLASS_FIELD(GenTrtEngineExpConfig())

    def __post_init__(self):
        if self.model_name is None:
            self.model_name = "<model_name>"
```

### Model parameters mapping
**Location:** `tao-core/nvidia_tao_core/config/<model_name>/model_params_mapping.py`

Maps backbone variant names to their output embedding dimensions. Used by `build_model()` to auto-wire the head's `in_channels`:
```python
map_params = {
    "head": {
        "in_channels": {
            "vit_base_patch16": 768,
            "vit_large_patch16": 1024,
            # ... one entry per backbone variant
        }
    }
}

# Optional: map input resolutions for backbones that require non-224 sizes
map_input_lr_head = {
    "vit_large_patch14_dinov2_swiglu_legacy": 518,
}
```

**Reference:** `tao-core/nvidia_tao_core/config/classification_pyt/default_config.py`, `model_params_mapping.py`

---

## 2. Backbone (`tao-pytorch`)

**Location:** `tao-pytorch/nvidia_tao_pytorch/cv/backbone_v2/`

### Required abstract methods on `BackboneBase`

New backbones **dual-inherit** from both the underlying model (HF/timm) AND `BackboneBase`. The `BackboneMeta` metaclass automatically calls `_post_init()` after `__init__`, which runs `freeze_backbone()` and `set_grad_checkpointing()`.

```python
from nvidia_tao_pytorch.cv.backbone_v2.backbone_base import BackboneBase
from nvidia_tao_pytorch.cv.backbone_v2 import BACKBONE_REGISTRY

class MyBackbone(SomeHFOrTimmModel, BackboneBase):
    """Dual-inherit: HF/timm model provides the architecture,
    BackboneBase provides TAO integration (freezing, checkpointing, registry)."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)

    # --- 6 abstract methods (all required) ---
    def get_stage_dict(self) -> dict:
        """Map stage-index -> nn.Module for layer freezing."""
        return {0: self.patch_embed, 1: self.blocks[:4], 2: self.blocks[4:8], ...}

    def get_classifier(self) -> nn.Module:
        """Return the classification head (e.g., self.head)."""
        return self.head

    def reset_classifier(self, num_classes, **kwargs):
        """Replace head for different num_classes."""
        self.head = nn.Linear(self.embed_dim, num_classes)

    def forward_pre_logits(self, x):
        """Features WITHOUT head. Returns [B, embed_dim]."""
        ...

    def forward_feature_pyramid(self, x, indices=None, **kwargs):
        """Multi-scale features for detection/segmentation.
        Returns dict {scale: feature_tensor}. Classification can return {0: features}."""
        ...

    def forward(self, x):
        """Full forward pass with head. Returns logits."""
        return self.get_classifier()(self.forward_pre_logits(x))

# --- Factory functions (one per variant) ---
@BACKBONE_REGISTRY.register()
def my_backbone_base(**kwargs):
    """kwargs from build_model(): num_classes, freeze_at, freeze_norm, export, img_size, ..."""
    return MyBackbone(embed_dim=768, depth=12, num_heads=12, **kwargs)

@BACKBONE_REGISTRY.register()
def my_backbone_large(**kwargs):
    return MyBackbone(embed_dim=1024, depth=24, num_heads=16, **kwargs)
```

**Key pattern from existing backbones (e.g., `vit.py`):**
- `VisionTransformer(TimmVisionTransformer, BackboneBase)` — wraps timm's ViT
- Overrides `forward_pre_logits` to handle positional encoding interpolation
- Each variant (`vit_base_patch16`, `vit_large_patch16`, etc.) is a factory function with fixed architecture params

### Already-registered backbones in `backbone_v2/`
`vit.py`, `swin.py`, `resnet.py`, `convnext.py`, `convnext_v2.py`, `dino_v2.py`,
`fan.py`, `fastervit.py`, `gcvit.py`, `hiera.py`, `mit.py`, `edgenext.py`,
`efficientvit.py`, `radio.py`, `siglip2.py`, `open_clip.py`

**Reference:** `tao-pytorch/nvidia_tao_pytorch/cv/backbone_v2/backbone_base.py`

---

## 3. build_model() Pattern (`tao-pytorch`)

**Location:** `tao-pytorch/nvidia_tao_pytorch/cv/<model_name>/model/classifier.py` (or equivalent)

The `build_model()` function is the core integration point between config, backbone registry, and pretrained weights:

```python
from nvidia_tao_pytorch.cv.backbone_v2.registry import BACKBONE_REGISTRY

def build_model(experiment_config, export=False):
    model_config = experiment_config.model
    backbone_type = model_config.backbone.type

    # 1. Instantiate backbone from registry
    model = BACKBONE_REGISTRY.get(backbone_type)(
        num_classes=experiment_config.dataset.num_classes,
        freeze_at='all' if model_config.backbone.freeze_backbone else None,
        freeze_norm=model_config.backbone.freeze_norm,
        export=export
    )

    # 2. Ensure head remains trainable even if backbone is frozen
    if model_config.backbone.freeze_backbone:
        head = model.get_classifier()
        for p in head.parameters():
            p.requires_grad = True
        head.train()

    # 3. Load pretrained weights with adaptation
    if model_config.backbone.pretrained_backbone_path:
        state_dict = load_pretrained_weights(
            model_config.backbone.pretrained_backbone_path,
            parser=cls_parser,       # Strips "module." prefix from DDP checkpoints
            ptm_adapter=ptm_adapter  # Maps prefixes from other TAO model types
        )

        # Special handling: ViT position embedding interpolation
        if isinstance(model, DINOV2):
            state_dict = interpolate_vit_checkpoint(state_dict, ...)

        msg = model.load_state_dict(state_dict, strict=False)
        logger.info(f"Loaded: {msg}")

    return model
```

### StateDictAdapter for cross-model checkpoint loading
```python
from nvidia_tao_pytorch.cv.classification_pyt.model.utils import StateDictAdapter

ptm_adapter = StateDictAdapter()
ptm_adapter.add("mae", "model.encoder.")           # MAE checkpoints
ptm_adapter.add("classification", "model.")         # Classification checkpoints
ptm_adapter.add("rtdetr", "model.model.backbone.")  # RT-DETR checkpoints
```

**Reference:** `tao-pytorch/nvidia_tao_pytorch/cv/classification_pyt/model/classifier.py`, `model/utils.py`

---

## 4. PyTorch Lightning Module (`tao-pytorch`)

**Base class:** `nvidia_tao_pytorch.core.lightning.tao_lightning_module.TAOLightningModule`

### TAOLightningModule provides
- `self.experiment_spec` — stored config
- `configure_callbacks()` — default `TAOStatusLogger`, `ModelCheckpoint`, `TAOExceptionCheckpoint`
- `_dataloader_batch_check()` — validates dataset_size >= total_batch_size
- `on_fit_start()`, `on_validation_start()`, `on_test_start()`, `on_predict_start()` — auto-validation
- `on_load_checkpoint()` — handles encrypted checkpoint decryption

### Constructor pattern
```python
class <ModelName>PlModel(TAOLightningModule):
    def __init__(self, experiment_spec, export=False):
        super().__init__(experiment_spec)
        self.checkpoint_filename = "<model_name>_model"  # MUST set
        self.dataset_config  = self.experiment_spec.dataset
        self.model_config    = self.experiment_spec.model
        self.train_config    = self.experiment_spec.train
        self.eval_config     = self.experiment_spec.evaluate
        self.infer_config    = self.experiment_spec.inference
        self._build_model(export)
        self._build_criterion()
```

### Callbacks (configure_callbacks)
```python
from pytorch_lightning.callbacks import ModelCheckpoint, LearningRateMonitor
from nvidia_tao_pytorch.core.callbacks.loggers import TAOStatusLogger
from nvidia_tao_pytorch.core.callbacks.ema import EMA, EMAModelCheckpoint

# Always include:
callbacks = [TAOStatusLogger(results_dir, append=True), lr_monitor]
# Checkpoint convention:
ModelCheckpoint.FILE_EXTENSION = ".pth"
ModelCheckpoint.CHECKPOINT_EQUALS_CHAR = "_"
ModelCheckpoint.CHECKPOINT_NAME_LAST = f"{self.checkpoint_filename}_latest"
```

### Status logging
```python
import nvidia_tao_pytorch.core.loggers.api_logging as status_logging

status_logging.get_status_logger().kpi = {"train_loss": ..., "val_acc": ...}
status_logging.get_status_logger().write(
    message="...", status_level=status_logging.Status.RUNNING
)
```

### Checkpoint save identifier
```python
def on_save_checkpoint(self, checkpoint):
    checkpoint["tao_model"] = "<model_name>"
```

**Reference:** `tao-pytorch/nvidia_tao_pytorch/core/lightning/tao_lightning_module.py`, `cv/classification_pyt/model/classifier_pl_model.py`

---

## 5. Script Entrypoints (`tao-pytorch` scripts)

### Decorator stack (all scripts use this)
```python
from nvidia_tao_pytorch.core.hydra.hydra_runner import hydra_runner
from nvidia_tao_pytorch.core.decorators.workflow import monitor_status
from nvidia_tao_pytorch.core.tlt_logging import obfuscate_logs
from nvidia_tao_core.config.<model_name>.default_config import ExperimentConfig

spec_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

@hydra_runner(
    config_path=os.path.join(spec_root, "experiment_specs"),
    config_name="experiment_spec",
    schema=ExperimentConfig
)
@monitor_status(name="<ModelName>", mode="<train|evaluate|inference|export>")
def main(cfg: ExperimentConfig) -> None:
    obfuscate_logs(cfg)
    ...
```

### Train script (initialize_train_experiment)
```python
from nvidia_tao_pytorch.core.initialize_experiments import initialize_train_experiment

def run_experiment(experiment_config, key, lightning_module):
    resume_ckpt, trainer_kwargs = initialize_train_experiment(experiment_config, key)
    dm = <ModelName>DataModule(experiment_config.dataset)
    dm.setup(stage="fit")
    model = lightning_module(experiment_config)
    trainer = Trainer(**trainer_kwargs,
                      gradient_clip_val=experiment_config.train.clip_grad_norm)
    trainer.fit(model, dm, ckpt_path=resume_ckpt)
```

`initialize_train_experiment()` handles: results_dir creation, GPU config, checkpoint resolution, distributed strategy setup, logger initialization.

### CLI Entrypoint (model-level CLI)
```python
from nvidia_tao_pytorch.core.entrypoint import get_subtasks, launch, command_line_parser

def main():
    parser = argparse.ArgumentParser("<model_name>", ...)
    subtasks = get_subtask_list()
    args, unknown_args = command_line_parser(parser, subtasks)
    launch(vars(args), unknown_args, subtasks, network="<model_name>")
```

`get_subtasks(scripts)` auto-discovers all .py files in the `scripts/` package. `launch()` constructs `python <script.py> --config-path ... --config-name ...` and runs it as a subprocess with GPU configuration.

**Reference:** `tao-pytorch/nvidia_tao_pytorch/core/entrypoint.py`, `cv/classification_pyt/entrypoint/classification.py`, `cv/classification_pyt/scripts/train.py`

---

## 6. ONNX Export (`tao-pytorch`)

```python
from nvidia_tao_pytorch.cv.classification_pyt.utils.onnx_export import ONNXExporter
from nvidia_tao_pytorch.core.utilities import encrypt_onnx

onnx_export = ONNXExporter()
onnx_export.export_model(
    model, batch_size, output_file, dummy_input,
    input_names=["input"], output_names=["output"],
    opset_version=cfg.export.opset_version,
    do_constant_folding=True,
)
onnx_export.check_onnx(output_file)

# Encrypt if needed
if output_file.endswith(".etlt") and key:
    encrypt_onnx(tmp_file_name=tmp_onnx_file, output_file_name=output_file, key=key)
```

Always use `dynamic_axes={"input": {0: "batch"}, "output": {0: "batch"}}` for variable batch size.

**Reference:** `tao-pytorch/nvidia_tao_pytorch/cv/classification_pyt/scripts/export.py`

---

## 7. TensorRT Engine Builder (`tao-deploy`)

### Base class
**Location:** `tao-deploy/nvidia_tao_deploy/engine/builder.py`

```python
from nvidia_tao_deploy.engine.builder import EngineBuilder  # Abstract base class

class EngineBuilder(ABC):
    def __init__(self, batch_size, verbose, max_batch_size, opt_batch_size,
                 min_batch_size, workspace, strict_type_constraints, force_ptq,
                 is_qat, timing_cache_path, strongly_typed):
        self.builder = trt.Builder(self.trt_logger)
        self.config = self.builder.create_builder_config()
        ...
```

### Task-specific builder
For classification: reuse `ClassificationEngineBuilder` from `tao-deploy/nvidia_tao_deploy/cv/classification_tf1/engine_builder.py`.

For other tasks: subclass `EngineBuilder` directly, implementing:
- `set_input_output_node_names()`
- Any task-specific preprocessing (mean/std, data format)

### Deploy script decorator stack (different from tao-pytorch!)
```python
from nvidia_tao_deploy.cv.common.hydra.hydra_runner import hydra_runner    # deploy version
from nvidia_tao_deploy.cv.common.decorators import monitor_status           # deploy version
from nvidia_tao_deploy.cv.common.initialize_experiments import initialize_gen_trt_engine_experiment
from nvidia_tao_deploy.utils.decoding import decode_model
from nvidia_tao_deploy.cv.common.utils import is_qdq_quantized_onnx
```

The deploy `@monitor_status` handles: results_dir creation, `experiment.yaml` save, `status.json` lifecycle, exception categorization (config errors, validation errors, filesystem errors).

### Deploy inference classes
```python
from nvidia_tao_deploy.cv.classification_tf1.inferencer import ClassificationInferencer
from nvidia_tao_deploy.cv.classification_tf1.dataloader import ClassificationLoader
```
- `ClassificationInferencer` — wraps TRT engine, handles `infer(imgs)` calls
- `ClassificationLoader` — NumPy-based batch loader (no PyTorch dependency)

For non-classification tasks, find equivalent inferencer/loader in the task-specific directory.

**Reference:** `tao-deploy/nvidia_tao_deploy/engine/builder.py`, `cv/classification_pyt/scripts/gen_trt_engine.py`, `cv/classification_pyt/scripts/inference.py`

---

## 8. L0 Tests

### Test directory layout
```
tao-pytorch/tests/cv_unit_test/<model_name>/
├── conftest.py           # Fixtures: _train_spec, _test_dir, etc.
├── test_model.py         # build_model() with various backbones
├── test_trainer.py       # PL Trainer fit/evaluate/inference dry-runs
├── test_dataloader.py    # Data loading pipeline
├── test_config.py        # Config loading & schema validation
└── test_export.py        # ONNX export

tao-deploy/tests/<model_name>/
└── test_<model_name>.py  # gen_trt_engine, inference, evaluate
```

### Test markers
```python
@pytest.mark.cv_unit
@pytest.mark.<model_name>
@pytest.mark.train          # or @pytest.mark.evaluate, .inference
```

### Trainer dry-run pattern
```python
@pytest.mark.parametrize("backbone", TEST_TOPOLOGIES)
def test_trainer_fit(_test_dir, _train_spec, backbone):
    _train_spec.model.backbone.type = backbone
    dm = <ModelName>DataModule(_train_spec.dataset)
    dm.setup(stage="fit")
    model = <ModelName>PlModel(_train_spec)
    trainer = Trainer(devices=_train_spec.train.num_gpus,
                      default_root_dir=_train_spec.results_dir,
                      accelerator='gpu', fast_dev_run=True)
    trainer.fit(model, dm)
```

### Deploy test pattern (subprocess)
```python
def test_gen_trt_engine(model_path, spec_path, tmp_path):
    cmd = f"python {gen_trt_engine_script} -e {spec_path} ..."
    result = subprocess.run(cmd, shell=True, capture_output=True)
    assert result.returncode == 0
    assert (tmp_path / "model.engine").exists()
```

**Reference:** `tao-pytorch/tests/cv_unit_test/classification_pyt/test_trainer.py`, `tao-deploy/tests/`

---

## 9. Packaging (`setup.py`)

### tao-pytorch console_scripts
```python
# In tao-pytorch/setup.py, entry_points.console_scripts:
'<model_name>=nvidia_tao_pytorch.cv.<model_name>.entrypoint.<model_name>:main',
```

### tao-deploy console_scripts
```python
# In tao-deploy/setup.py, entry_points.console_scripts:
'<model_name>=nvidia_tao_deploy.cv.<model_name>.entrypoint.<model_name>:main',
```

**Reference:** `tao-pytorch/setup.py`, `tao-deploy/setup.py`

---

## 10. Core Utilities Summary

| Utility | Import | Purpose |
|---------|--------|---------|
| `obfuscate_logs(cfg)` | `nvidia_tao_pytorch.core.tlt_logging` | Hide encryption keys in logs |
| `expand_path(path)` | `nvidia_tao_pytorch.core.path_utils` | Safe tilde expansion + absolute path |
| `get_global_rank()` | `nvidia_tao_pytorch.core.distributed.comm` | DDP rank (0 if not distributed) |
| `get_world_size()` | `nvidia_tao_pytorch.core.distributed.comm` | Number of processes |
| `is_master_node()` | `nvidia_tao_core.distributed.utils` | Multi-framework master check |
| `get_latest_checkpoint()` | `nvidia_tao_pytorch.core.utilities` | Find latest .pth in results_dir |
| `TLTPyTorchCookbook` | `nvidia_tao_pytorch.core.cookbooks` | Encryption key management |
