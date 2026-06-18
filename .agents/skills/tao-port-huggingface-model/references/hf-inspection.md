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

# HuggingFace Model Inspection Guide

How to gather the information needed from a HuggingFace model before writing any TAO code.

---

## 1. Authenticate

```python
from huggingface_hub import login
login(token="<HF_TOKEN>")   # or set env var HF_TOKEN
```

Or pass `token=` to every API call if you prefer not to persist credentials.

---

## 2. Validate model type

```python
from huggingface_hub import model_info

info = model_info("<MODEL_ID>", token="<HF_TOKEN>")
print("Pipeline tag:", info.pipeline_tag)
print("Tags:", info.tags)
print("Library:", info.library_name)
```

**Accepted CV pipeline tags:**
- `image-classification`
- `object-detection`
- `image-segmentation`
- `instance-segmentation`
- `panoptic-segmentation`
- `depth-estimation`
- `keypoint-detection`
- `zero-shot-object-detection`
- `zero-shot-image-classification`

**Reject** anything in NLP (`text-classification`, `text-generation`, `token-classification`, etc.), audio (`automatic-speech-recognition`, etc.), or multimodal LLM (`image-to-text`, `visual-question-answering` where the backbone is an LLM).

---

## 3. Inspect the model config

```python
from transformers import AutoConfig

config = AutoConfig.from_pretrained("<MODEL_ID>", token="<HF_TOKEN>")
print(config)
print("Model type:", config.model_type)       # e.g. "vit", "swin", "detr", "segformer"
print("Hidden size:", getattr(config, "hidden_size", "N/A"))
print("Num labels:", getattr(config, "num_labels", "N/A"))
print("Image size:", getattr(config, "image_size", "N/A"))
print("Patch size:", getattr(config, "patch_size", "N/A"))
print("Num layers:", getattr(config, "num_hidden_layers", "N/A"))
```

Key config attributes to extract and map to TAO `ModelConfig`:

| HF config field | TAO config equivalent |
|-----------------|----------------------|
| `image_size` | `dataset.img_size` |
| `num_labels` / `id2label` | `dataset.num_classes` |
| `hidden_size` | `model.head.in_channels` |
| `num_hidden_layers` | used to count stages for `get_stage_dict()` |
| `patch_size` | backbone architecture param |

---

## 4. Inspect the state_dict

```python
from transformers import AutoModel
import torch

model = AutoModel.from_pretrained("<MODEL_ID>", token="<HF_TOKEN>")
sd = model.state_dict()

for key in list(sd.keys())[:30]:
    print(f"{key:80s}  {sd[key].shape}")
```

Look for:
- **Prefix patterns** — e.g., `vit.encoder.layer.0.attention...` vs TAO's expected naming
- **Classifier head weights** — usually `classifier.weight`, `classifier.bias` or `head.weight`
- **Positional embeddings** — may need interpolation if TAO trains at a different resolution

**Write the key-mapping function** (`utils/hf_checkpoint_converter.py`):
```python
def convert_hf_state_dict(hf_state_dict: dict) -> dict:
    """Map HuggingFace parameter names to TAO nn.Module parameter names."""
    mapping = {
        "vit.embeddings.patch_embeddings.projection.weight": "patch_embed.proj.weight",
        # ... add all mappings
    }
    tao_state_dict = {}
    for hf_key, tensor in hf_state_dict.items():
        tao_key = mapping.get(hf_key, hf_key)   # fall through if not remapped
        tao_state_dict[tao_key] = tensor
    return tao_state_dict
```

---

## 5. Identify the task head

```python
from transformers import AutoModelForImageClassification   # or:
# AutoModelForObjectDetection, AutoModelForSemanticSegmentation,
# AutoModelForInstanceSegmentation, AutoModelForDepthEstimation

full_model = AutoModelForImageClassification.from_pretrained("<MODEL_ID>", token="<HF_TOKEN>")
print(full_model)   # prints full module tree
```

This reveals whether the task head is separable from the backbone — important for deciding whether to:
- **Wrap the full HF model** as a monolithic TAO nn.Module, or
- **Extract the backbone** and attach a TAO-native head (preferred for flexibility)

---

## 6. Verify ONNX exportability

Quick sanity check before writing any TAO code:
```python
import torch
import onnx

dummy = torch.randn(1, 3, 224, 224)
full_model.eval()

torch.onnx.export(
    full_model, dummy, "/workspace/tao_hf_test.onnx",
    input_names=["input"], output_names=["output"],
    dynamic_axes={"input": {0: "batch"}, "output": {0: "batch"}},
    opset_version=17,
)
onnx.checker.check_model("/workspace/tao_hf_test.onnx")
print("ONNX export OK")
```

If this fails, identify the problematic ops and plan workarounds before starting the TAO integration.

---

## 7. Check for existing backbone coverage

Before implementing a new backbone, check if `timm` (used by `backbone_v2`) already has it:
```python
import timm
print(timm.list_models("<pattern>*"))   # e.g., "vit*", "swin*", "convnext*"
```

If `timm` has the architecture, check `tao-pytorch/nvidia_tao_pytorch/cv/backbone_v2/` for an existing wrapper. If a wrapper exists, plan to reuse it and skip writing a new backbone.

---

## 8. Summary checklist

Before leaving Phase 1, confirm you have:
- [ ] `pipeline_tag` confirmed as CV
- [ ] `config.model_type` identified
- [ ] `image_size`, `num_labels`, `hidden_size` extracted
- [ ] Top-level `state_dict` keys documented
- [ ] Key-name remapping plan drafted
- [ ] Task head separability assessed
- [ ] ONNX export sanity check passed
- [ ] `timm` / `backbone_v2` coverage checked
