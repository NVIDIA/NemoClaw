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

# Model Discovery & Validation Reference

Used in Phase 0 of tao-finetune-huggingface-model skill.

---

## Full Task Type → AutoModel Mapping

| model_type (config) | Common model names | Task branch | AutoModel class | Processor class |
|--------------------|--------------------|-------------|-----------------|-----------------|
| `vit` | ViT-Base, ViT-Large | cv-classification | `AutoModelForImageClassification` | `AutoImageProcessor` |
| `swin` | Swin-T, Swin-B | cv-classification | `AutoModelForImageClassification` | `AutoImageProcessor` |
| `convnext` | ConvNeXt-Tiny, ConvNeXt-Base | cv-classification | `AutoModelForImageClassification` | `AutoImageProcessor` |
| `deit` | DeiT-Small, DeiT-Base | cv-classification | `AutoModelForImageClassification` | `AutoImageProcessor` |
| `beit` | BEiT-Base | cv-classification | `AutoModelForImageClassification` | `AutoImageProcessor` |
| `efficientnet` | EfficientNet-B0 to B7 | cv-classification | `AutoModelForImageClassification` | `AutoImageProcessor` |
| `mobilenet_v2` | MobileNetV2 | cv-classification | `AutoModelForImageClassification` | `AutoImageProcessor` |
| `mobilenet_v1` | MobileNetV1 | cv-classification | `AutoModelForImageClassification` | `AutoImageProcessor` |
| `resnet` | ResNet-50, ResNet-101 | cv-classification | `AutoModelForImageClassification` | `AutoImageProcessor` |
| `dinov2` | DINOv2-Base, DINOv2-Large | cv-classification | `AutoModelForImageClassification` | `AutoImageProcessor` |
| `detr` | DETR-ResNet-50 | cv-detection | `AutoModelForObjectDetection` | `AutoImageProcessor` |
| `conditional_detr` | Conditional DETR | cv-detection | `AutoModelForObjectDetection` | `AutoImageProcessor` |
| `yolos` | YOLOS-Tiny, YOLOS-Small | cv-detection | `AutoModelForObjectDetection` | `AutoImageProcessor` |
| `deta` | DETA | cv-detection | `AutoModelForObjectDetection` | `AutoImageProcessor` |
| `rt_detr` | RT-DETR | cv-detection | `AutoModelForObjectDetection` | `AutoImageProcessor` |
| `dfine` | D-FINE | cv-detection | `AutoModelForObjectDetection` | `AutoImageProcessor` |
| `segformer` | SegFormer-B0 to B5 | cv-segmentation | `AutoModelForSemanticSegmentation` | `AutoImageProcessor` |
| `upernet` | UperNet (Swin backbone) | cv-segmentation | `AutoModelForSemanticSegmentation` | `AutoImageProcessor` |
| `beit` (seg head) | BEiT segmentation | cv-segmentation | `AutoModelForSemanticSegmentation` | `AutoImageProcessor` |
| `mask2former` (semantic) | Mask2Former semantic | cv-segmentation | `AutoModelForSemanticSegmentation` | `AutoImageProcessor` |
| `mask2former` (instance) | Mask2Former instance | cv-instance-seg | `AutoModelForInstanceSegmentation` | `AutoImageProcessor` |
| `maskformer` | MaskFormer | cv-segmentation | `AutoModelForSemanticSegmentation` | `AutoImageProcessor` |
| `glpn` | GLPN | cv-depth | `AutoModelForDepthEstimation` | `AutoImageProcessor` |
| `dpt` | DPT | cv-depth | `AutoModelForDepthEstimation` | `AutoImageProcessor` |
| `depth_anything` | Depth Anything v1/v2 | cv-depth | `AutoModelForDepthEstimation` | `AutoImageProcessor` |
| `llava` | LLaVA-1.5, LLaVA-Next | vlm | `AutoModelForImageTextToText` | `AutoProcessor` |
| `paligemma` | PaliGemma 1/2 | vlm | `AutoModelForImageTextToText` | `AutoProcessor` |
| `gemma3` | Gemma 3 multimodal | vlm | `AutoModelForImageTextToText` | `AutoProcessor` |
| `idefics` | IDEFICS2/3 | vlm | `AutoModelForImageTextToText` | `AutoProcessor` |
| `qwen2_vl` | Qwen2-VL | vlm | `AutoModelForImageTextToText` | `AutoProcessor` |
| `mllama` | Llama-3.2 Vision | vlm | `AutoModelForImageTextToText` | `AutoProcessor` |
| `pixtral` | Pixtral | vlm | `AutoModelForImageTextToText` | `AutoProcessor` |
| `internvl` | InternVL2 | vlm | `AutoModelForImageTextToText` | `AutoProcessor` |
| `llama` | Llama 2/3 | llm | `AutoModelForCausalLM` | `AutoTokenizer` |
| `mistral` | Mistral 7B | llm | `AutoModelForCausalLM` | `AutoTokenizer` |
| `qwen2` | Qwen2 | llm | `AutoModelForCausalLM` | `AutoTokenizer` |
| `gemma` | Gemma 2 | llm | `AutoModelForCausalLM` | `AutoTokenizer` |
| `phi` | Phi-3, Phi-4 | llm | `AutoModelForCausalLM` | `AutoTokenizer` |

---

## Rejection Criteria

Reject with a clear message and do NOT proceed to Phase 1 if ANY of the following:

```python
REJECT_MODEL_TYPES = {
    "wav2vec2", "wav2vec2_conformer", "hubert", "whisper", "encodec",
    "seamless_m4t", "bark", "musicgen",                    # audio models
    "bert", "roberta", "albert", "electra", "deberta",     # text-only
    "gpt2", "gpt_neo", "gpt_neox", "bloom", "opt",         # LLMs without image support
    "t5", "bart", "pegasus", "mbart",                       # seq2seq text-only
    "layoutlm", "layoutlmv2", "layoutlmv3",                 # document AI (no image_size)
    "clip",                                                  # encoder-only, no generation/clf head
}

REJECT_IF = [
    "model_type not in known table AND no matching architecture",
    "transformers_version absent AND model_type unrecognized",
    "config loads but AutoModelForImageClassification raises ValueError",
    "model card has no 'image' or 'vision' tag AND not explicitly vlm/llm",
]
```

---

## Transformers Integration Check Procedure

Run this full check inside the Step 1 probe container (`docker run … python:3.12-slim …`
with the bind-mounted `.probe/` scratch dir — same invocation as Step 1a in the
SKILL.md, no host Python needed):

```python
from transformers import AutoConfig, AutoImageProcessor, AutoProcessor
import sys

model_id = sys.argv[1]
token = sys.argv[2]

results = {}

# 1. Config load
try:
    cfg = AutoConfig.from_pretrained(model_id, token=token)
    results["config_ok"] = True
    results["model_type"] = cfg.model_type
    results["architectures"] = getattr(cfg, "architectures", [])
except Exception as e:
    print(f"REJECT: config load failed — {e}")
    sys.exit(1)

# 2. Check transformers auto-mapping
from transformers.models.auto.configuration_auto import CONFIG_MAPPING
results["in_config_mapping"] = cfg.model_type in CONFIG_MAPPING

# 3. Try processor
for proc_cls in [AutoImageProcessor, AutoProcessor]:
    try:
        proc = proc_cls.from_pretrained(model_id, token=token)
        results["processor_ok"] = True
        results["processor_class"] = proc.__class__.__name__
        break
    except Exception:
        pass
else:
    results["processor_ok"] = False

# 4. Determine task branch
arch = results.get("architectures", [""])[0].lower()
mt = results["model_type"].lower()

CV_CLASSIFICATION = {"vit", "swin", "convnext", "deit", "beit", "efficientnet",
                      "mobilenet_v2", "mobilenet_v1", "resnet", "dinov2"}
CV_DETECTION = {"detr", "conditional_detr", "yolos", "deta", "rt_detr", "dfine"}
CV_SEGMENTATION = {"segformer", "upernet", "mask2former", "maskformer"}
CV_DEPTH = {"glpn", "dpt", "depth_anything"}
VLM = {"llava", "paligemma", "gemma3", "idefics", "qwen2_vl", "mllama", "pixtral", "internvl"}
LLM = {"llama", "mistral", "qwen2", "gemma", "phi"}

if mt in CV_CLASSIFICATION or "ForImageClassification" in arch:
    results["task_branch"] = "cv"
    results["task"] = "image-classification"
    results["auto_model"] = "AutoModelForImageClassification"
elif mt in CV_DETECTION or "ForObjectDetection" in arch:
    results["task_branch"] = "cv"
    results["task"] = "object-detection"
    results["auto_model"] = "AutoModelForObjectDetection"
elif mt in CV_SEGMENTATION or "ForSemanticSegmentation" in arch:
    results["task_branch"] = "cv"
    results["task"] = "semantic-segmentation"
    results["auto_model"] = "AutoModelForSemanticSegmentation"
elif mt in CV_DEPTH or "ForDepthEstimation" in arch:
    results["task_branch"] = "cv"
    results["task"] = "depth-estimation"
    results["auto_model"] = "AutoModelForDepthEstimation"
elif mt in VLM or "ForImageTextToText" in arch or "ForConditionalGeneration" in arch:
    results["task_branch"] = "vlm"
    results["task"] = "image-text-to-text"
    results["auto_model"] = "AutoModelForImageTextToText"
elif mt in LLM or "ForCausalLM" in arch:
    results["task_branch"] = "vlm"
    results["task"] = "text-generation"
    results["auto_model"] = "AutoModelForCausalLM"
else:
    print(f"REJECT: unknown task type for model_type={mt}, arch={arch}")
    sys.exit(1)

import yaml
print(yaml.dump(results))
```

---

## Model Config Fields to Extract

Record these in `phase0_model_info.yaml`:

```yaml
model_id: google/vit-base-patch16-224
model_type: vit
task_branch: cv
task: image-classification
auto_model: AutoModelForImageClassification
processor_class: ViTImageProcessor
architectures: ["ViTForImageClassification"]
hidden_size: 768
num_hidden_layers: 12
image_size: 224
patch_size: 16
num_labels: 1000
id2label_sample: {0: "tench", 1: "goldfish", 2: "great_white_shark"}
transformers_version: "4.x"
param_count_approx: "86M"
```

To get param count:
```python
from transformers import AutoModel
m = AutoModel.from_pretrained(model_id, token=token)
print(f"{sum(p.numel() for p in m.parameters()) / 1e6:.0f}M params")
del m
```

---

## Ambiguous Cases

**BEiT** — can be classification or segmentation depending on the specific model. Check:
- `config.architectures[0]` = `BeitForImageClassification` → classification
- `config.architectures[0]` = `BeitForSemanticSegmentation` → segmentation

**Mask2Former** — can be semantic, instance, or panoptic. Check:
- `config.num_queries` and `config.decoder_config` for clues
- Or ask the user to specify explicitly

**CLIP** — encoder-only, no classification head by default. REJECT unless the user is using
a fine-tuned CLIP variant with a classification head (check `architectures`).

**PaliGemma** — uses `ForConditionalGeneration` architecture but maps to VLM branch.
`AutoModelForImageTextToText` works from transformers ≥ 4.45.
