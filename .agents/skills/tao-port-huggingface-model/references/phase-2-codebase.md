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

Full Phase 2 walkthrough — task-type → reference-model mapping, reference-implementation reading list, backbone coverage check, and dataservices coverage check. See `task-type-guide.md` for per-task architectural details.

## Phase 2 — Codebase Exploration

Before writing any code, search the submodules for the closest existing model to the one being integrated. This determines which base classes, engine builders, and test patterns to reuse.

### 2.1 Determine the task type and find the closest existing TAO model

The HF model's `pipeline_tag` (from Phase 1.4) determines which TAO reference model to follow. **Different task types have fundamentally different architectures, losses, dataset formats, and deploy pipelines** — see [references/task-type-guide.md](references/task-type-guide.md) for full details.

```bash
# Identify a similar model by task type and architecture
ls tao-pytorch/nvidia_tao_pytorch/cv/
ls tao-core/nvidia_tao_core/config/
ls tao-deploy/nvidia_tao_deploy/cv/
```

**Task-type → Reference model mapping:**

| HF pipeline_tag | Reference model | Key architectural difference |
|---|---|---|
| `image-classification` | `classification_pyt` | Backbone + linear head, single output |
| `object-detection` | `dino` or `rtdetr` | Backbone + transformer encoder/decoder, multi-output (logits + boxes), Hungarian matching loss |
| `image-segmentation` | `segformer` | Backbone + decode head, per-pixel output, spatial ONNX dims |
| `instance-segmentation` | `mask2former` | Backbone + pixel decoder + transformer decoder, query-based masks |
| `panoptic-segmentation` | `oneformer` | Task-conditional head, stuff + things merging |
| `zero-shot-object-detection` | `grounding_dino` | Multi-modal (image + BERT text encoder), contrastive prediction |
| `depth-estimation` | `mono_depth` | Encoder-decoder, single-channel depth output |

**This choice affects EVERYTHING downstream:** config structure, model architecture, loss functions, ONNX export (single vs multi-output), TRT engine builder, deploy inferencer/loader, evaluation metrics, and dataset format. Read the reference model thoroughly before proceeding.

### 2.2 Read and understand the reference implementation
Read **all of these** from your chosen reference model:
- `tao-core/nvidia_tao_core/config/<ref_model>/default_config.py` — dataclass schema
- `tao-core/nvidia_tao_core/config/<ref_model>/model_params_mapping.py` — backbone→embedding dimension map
- `tao-pytorch/nvidia_tao_pytorch/cv/<ref_model>/model/classifier.py` (or equivalent) — the `build_model()` function
- `tao-pytorch/nvidia_tao_pytorch/cv/<ref_model>/model/<ref_model>_pl_model.py` — Lightning module
- `tao-pytorch/nvidia_tao_pytorch/cv/<ref_model>/scripts/train.py` — train script pattern
- `tao-pytorch/nvidia_tao_pytorch/cv/<ref_model>/scripts/export.py` — ONNX export
- `tao-pytorch/nvidia_tao_pytorch/cv/<ref_model>/entrypoint/<ref_model>.py` — CLI entrypoint
- `tao-pytorch/nvidia_tao_pytorch/cv/<ref_model>/experiment_specs/experiment_spec.yaml` — default YAML config
- `tao-deploy/nvidia_tao_deploy/cv/<ref_model>/scripts/gen_trt_engine.py` — TRT engine builder
- `tao-deploy/nvidia_tao_deploy/cv/<ref_model>/scripts/inference.py` — TRT inference
- `tao-deploy/nvidia_tao_deploy/cv/<ref_model>/specs/` — deploy YAML specs
- `tao-pytorch/tests/cv_unit_test/<ref_model>/` — L0 test files

### 2.3 Check if the backbone already exists
```bash
ls tao-pytorch/nvidia_tao_pytorch/cv/backbone_v2/
```
Already registered: `vit.py`, `swin.py`, `resnet.py`, `convnext.py`, `convnext_v2.py`, `dino_v2.py`, `fan.py`, `fastervit.py`, `gcvit.py`, `hiera.py`, `mit.py`, `edgenext.py`, `efficientvit.py`, `radio.py`, `siglip2.py`, `open_clip.py`.

Also check if `timm` has the architecture:
```python
import timm; print(timm.list_models("<pattern>*"))
```

If the backbone already exists in `backbone_v2/`, reuse it. Do **not** re-implement.

**If the backbone does NOT exist** in `backbone_v2/` or `timm`, you must implement a new one in Step 2. This is significant additional work. Before proceeding, inform the user and determine the implementation strategy:

1. **Wrap via `timm`** (preferred if `timm` has the architecture or something close): Subclass the timm model + `BackboneBase`, same pattern as `vit.py`. This is the easiest path because `timm` models are plain `nn.Module` with no metaclass conflicts.

2. **Re-implement from scratch** (when no timm/HF base exists): Study the HF model source code, then re-implement the architecture as a pure PyTorch `nn.Module` + `BackboneBase`. Use the HF source as reference but do NOT import from `transformers` at runtime — the TAO Toolkit images do not include it. Load HF pretrained weights via state_dict conversion.

3. **Wrap HF model as black-box** (quickest but limited): Import the HF model class inside the backbone, delegate `forward()` to it. This approach creates a runtime dependency on `transformers` which must be pip-installed inside the container. It also makes ONNX export harder because `PreTrainedModel` has complex internal structure. **Only use this as a last resort.**

**Important:** Do NOT dual-inherit from `transformers.PreTrainedModel` and `BackboneBase` — the HF `PreTrainedModel` has incompatible metaclass/mixin machinery that conflicts with `BackboneMeta`. Instead, compose: create a `BackboneBase` subclass that internally instantiates the HF model as an attribute.

Record which strategy you'll use — it affects everything downstream (weight loading, ONNX export, deploy pipeline).

### 2.4 Check `tao-dataservices` for data utilities
```bash
ls tao-dataservices/nvidia_tao_ds/annotations/conversion/
```
If the HF model requires a custom annotation format (COCO, KITTI, ODVG), check if a converter already exists. Only touch `tao-dataservices` if you need new annotation converters or augmentation pipelines for the model's dataset format.

### Phase 2 Gate — Confirm before proceeding:
- [ ] Reference TAO model identified and all 12 reference locations read
- [ ] Task type determines: architecture pattern, loss functions, ONNX output count, deploy builder/inferencer, metrics, dataset format
- [ ] Backbone coverage checked (`backbone_v2/` and `timm`)
- [ ] Dataservices coverage checked (existing converters vs. new needed)

---

