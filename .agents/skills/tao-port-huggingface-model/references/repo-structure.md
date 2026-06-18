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

# TAO Repository Structure Guide

How files for a new model `<model_name>` map across all four TAO repos.
Use `<model_name>` = the `snake_case` identifier agreed upon in Phase 1 (e.g., `vit_base_p16`).
Use `<ModelName>` = the `PascalCase` equivalent (e.g., `VitBaseP16`).

---

## `tao-core` — Configuration Schemas

```
tao-core/nvidia_tao_core/config/
└── <model_name>/
    ├── __init__.py
    ├── default_config.py           # All OmegaConf/dataclass config definitions
    └── model_params_mapping.py     # Backbone name -> embedding dim mapping
```

The `default_config.py` is imported by both `tao-pytorch` scripts and `tao-deploy` scripts so the same schema validates both training and deployment configs.

The `model_params_mapping.py` maps each backbone variant to its output embedding dimension (used by `build_model()` to auto-wire the head's `in_channels`).

**Verify by looking at:**
```
tao-core/nvidia_tao_core/config/classification_pyt/default_config.py
tao-core/nvidia_tao_core/config/classification_pyt/model_params_mapping.py
```

---

## `tao-pytorch` — Training, Native Inference & Export

```
tao-pytorch/nvidia_tao_pytorch/cv/
└── <model_name>/
    ├── __init__.py
    ├── model/
    │   ├── __init__.py
    │   ├── <model_name>.py             # build_model() + nn.Module wrapper
    │   ├── <model_name>_pl_model.py   # TAOLightningModule subclass
    │   └── utils.py                    # State dict adapter, HF weight converter
    ├── dataloader/
    │   ├── __init__.py
    │   ├── dataset.py                  # torch.utils.data.Dataset
    │   ├── augmentation.py             # Transforms (torchvision / albumentations)
    │   └── pl_<model_name>_data_module.py  # pl.LightningDataModule
    ├── scripts/
    │   ├── __init__.py
    │   ├── train.py                    # @hydra_runner + @monitor_status("train")
    │   ├── evaluate.py                 # @hydra_runner + @monitor_status("evaluate")
    │   ├── inference.py                # @hydra_runner + @monitor_status("inference")
    │   └── export.py                   # @hydra_runner + @monitor_status("export")
    ├── entrypoint/
    │   ├── __init__.py
    │   └── <model_name>.py             # CLI entrypoint wiring all scripts
    ├── experiment_specs/
    │   └── experiment_spec.yaml        # Default/example YAML experiment config
    └── utils/
        ├── __init__.py
        ├── onnx_export.py              # (if task-specific ONNX logic needed)
        └── hf_checkpoint_converter.py  # HF -> TAO state_dict key remapping
```

**If the HF model introduces a new backbone architecture** (not already in `backbone_v2/`):
```
tao-pytorch/nvidia_tao_pytorch/cv/backbone_v2/
├── <backbone_name>.py                  # BackboneBase subclass + @BACKBONE_REGISTRY.register()
└── __init__.py                         # Add import here
```

**Reference layouts:**
```
tao-pytorch/nvidia_tao_pytorch/cv/classification_pyt/   # classification
tao-pytorch/nvidia_tao_pytorch/cv/segformer/            # segmentation
tao-pytorch/nvidia_tao_pytorch/cv/dino/                 # object detection
```

---

## `tao-deploy` — TensorRT Engine Build, TRT Inference & Evaluation

```
tao-deploy/nvidia_tao_deploy/cv/
└── <model_name>/
    ├── __init__.py
    ├── scripts/
    │   ├── __init__.py
    │   ├── gen_trt_engine.py           # Build TRT .engine from ONNX
    │   ├── inference.py                # TRT engine inference (NumPy dataloader)
    │   └── evaluate.py                 # TRT engine evaluation + metrics
    ├── entrypoint/
    │   ├── __init__.py
    │   └── <model_name>.py             # CLI entrypoint for deploy commands
    └── specs/
        ├── gen_trt_engine.yaml         # TRT engine build config
        ├── inference.yaml              # TRT inference config
        └── evaluate.yaml               # TRT evaluation config
```

**Engine builder base class location:**
```
tao-deploy/nvidia_tao_deploy/engine/
└── builder.py                          # EngineBuilder ABC
```

**Reusable task-specific classes (classification example):**
```
tao-deploy/nvidia_tao_deploy/cv/classification_tf1/
├── engine_builder.py                   # ClassificationEngineBuilder(EngineBuilder)
├── inferencer.py                       # ClassificationInferencer (TRT wrapper)
└── dataloader.py                       # ClassificationLoader (NumPy-based)
```

**Reference layouts:**
```
tao-deploy/nvidia_tao_deploy/cv/classification_pyt/
tao-deploy/nvidia_tao_deploy/cv/segformer/
tao-deploy/nvidia_tao_deploy/cv/dino/
```

---

## `tao-dataservices` (conditional)

Only needed if the HF model requires custom data annotation/conversion or augmentation pipelines.

```
tao-dataservices/nvidia_tao_ds/
├── annotations/
│   └── conversion/                     # COCO↔KITTI, COCO↔ODVG converters
├── augmentation/                       # Data augmentation pipelines
├── auto_label/                         # Grounding DINO / MAL auto-labeling
├── backbone/                           # Shared backbone utilities
└── data_analytics/                     # Dataset statistics
```

Check `annotations/conversion/` before writing new annotation converters — common formats (COCO, KITTI, ODVG) are already supported.

---

## Tests

```
tao-pytorch/tests/
├── conftest.py                         # Global pytest config
├── test_imports.py                     # Module import smoke tests
└── cv_unit_test/
    └── <model_name>/
        ├── conftest.py                 # Shared fixtures (_train_spec, _test_dir)
        ├── test_model.py              # build_model() with various backbones
        ├── test_trainer.py            # PL Trainer fit/eval/infer (fast_dev_run)
        ├── test_dataloader.py         # Data pipeline tests
        ├── test_config.py             # Config schema validation
        └── test_export.py             # ONNX export tests

tao-deploy/tests/
└── <model_name>/
    └── test_<model_name>.py           # gen_trt_engine, inference, evaluate
```

---

## Packaging

### `tao-pytorch/setup.py`
```python
entry_points={
    'console_scripts': [
        '<model_name>=nvidia_tao_pytorch.cv.<model_name>.entrypoint.<model_name>:main',
        # ... existing models ...
    ]
}
```

### `tao-deploy/setup.py`
```python
entry_points={
    'console_scripts': [
        '<model_name>=nvidia_tao_deploy.cv.<model_name>.entrypoint.<model_name>:main',
        # ... existing models ...
    ]
}
```

---

## Git submodule relationships

In the official TAO repos, cross-repo dependencies are managed via git submodules:

| Parent Repo | Submodule | Typical Submodule Path |
|---|---|---|
| tao-pytorch | tao-core | `tao-pytorch/tao-core/` |
| tao-deploy | tao-core | `tao-deploy/tao-core/` |
| tao-dataservices | tao-core | `tao-dataservices/tao-core/` |
| tao-dataservices | tao-pytorch | `tao-dataservices/tao-pytorch/` |

**For our workflow (independent clones):** The submodule copies inside each repo are initialized but point to the original (unmodified) commit. Our modifications only exist in the top-level clones. Always install from the top-level `tao-core/` clone instead of `<repo>/tao-core/`. See SKILL.md "Submodule Override Strategy" for the full rules on volume mounts, pip install order, and PYTHONPATH.

---

## Cross-repo import dependencies

```
tao-deploy scripts  →  import ExperimentConfig from tao-core
tao-pytorch scripts →  import ExperimentConfig from tao-core
tao-pytorch model   →  import BackboneBase, BACKBONE_REGISTRY from tao-pytorch/backbone_v2
tao-deploy builder  →  import EngineBuilder from tao-deploy/engine/builder.py
tao-deploy scripts  →  import hydra_runner from tao-deploy/cv/common/hydra/ (NOT tao-pytorch's version)
tao-deploy scripts  →  import monitor_status from tao-deploy/cv/common/decorators (NOT tao-pytorch's version)
```

**Important:** tao-pytorch and tao-deploy have **separate** `hydra_runner` and `monitor_status` implementations. Always use the correct one for the target repo.

---

## Naming conventions

| Item | Convention | Example |
|------|-----------|---------|
| Directory name | `snake_case` | `vit_base_p16` |
| Config file | `default_config.py` | always |
| Params mapping | `model_params_mapping.py` | always |
| PL model class | `<ModelName>PlModel` | `VitBaseP16PlModel` |
| nn.Module / build_model | `build_model()` in `<model_name>.py` | always |
| Backbone class | `<BackboneName>` | `VitBaseP16Backbone` |
| Registry key | `snake_case` function name | `@BACKBONE_REGISTRY.register()` |
| Checkpoint key | `tao_model = "<model_name>"` | `tao_model = "vit_base_p16"` |
| ONNX input name | `"input"` | always |
| ONNX output name | `"output"` | always (or task-specific for detection) |
| Console script | `<model_name>=nvidia_tao_pytorch.cv.<model_name>.entrypoint.<model_name>:main` | exact format |
| Experiment spec | `experiment_specs/experiment_spec.yaml` | tao-pytorch |
| Deploy specs | `specs/{gen_trt_engine,inference,evaluate}.yaml` | tao-deploy |
| Test markers | `@pytest.mark.cv_unit`, `@pytest.mark.<model_name>` | always |
| Checkpoint extension | `.pth` | always |
| Checkpoint naming | `model_{epoch:03d}.pth`, `<model_name>_model_latest.pth` | convention |
