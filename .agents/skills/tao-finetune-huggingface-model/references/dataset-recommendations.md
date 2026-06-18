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

# Dataset Recommendations Reference

When the user provides only a `model_id` and no dataset, the agent presents 3–5 curated
options from the tables below, matched to the model's task type (and where relevant, to
the specific model family).

**Always offer "bring your own dataset" as the last option** — users with a proprietary
use-case should know that path exists.

---

## How to use this file

After Phase 0 identifies `task` (e.g. `image-classification`), the agent:

1. Looks up the matching "Popular datasets" table below.
2. If the model belongs to a well-known family (e.g. PaliGemma, ViT-Base), also checks the
   "Model-specific recommendations" section — these datasets are known to work well with
   that model.
3. Presents a numbered list to the user with: dataset name, size, classes/schema, expected
   training time, notes/quirks.
4. Waits for user to pick a number or supply `--dataset_id` / `--local_dataset_path`.

---

## Image Classification

### Popular datasets

| # | HF Dataset ID | Size (train) | Classes | Notes |
|---|---|---|---|---|
| 1 | `beans` | 1,034 | 3 | Tiny — ideal smoke-test in 5 min on 1 GPU |
| 2 | `cifar10` | 50,000 | 10 | Classic baseline. Low-res (32×32). |
| 3 | `cifar100` | 50,000 | 100 | Harder than CIFAR-10. Low-res. |
| 4 | `food101` | 75,750 | 101 | Standard mid-size benchmark. Real photos. |
| 5 | `imagenet-1k` | 1.28M | 1,000 | Gated — accept license on HF first. Full benchmark. |
| 6 | `eurosat` | 27,000 | 10 | Satellite imagery (RGB). Good for remote sensing demos. |
| 7 | `skin-cancer` / `marmal88/skin_cancer` | 10,015 | 7 | Medical imaging baseline |
| 8 | `Matthijs/snacks` | 4,138 | 20 | Casual photos, 20 snack classes |

### Model-specific notes

- **ViT / DeiT / Swin / ConvNeXt** (pretrained on ImageNet-1k): fine-tune on `food101`, `cifar100`, `beans`.
  These have id2label already populated for 1000 ImageNet classes — `ignore_mismatched_sizes=True`
  required when changing num_labels.
- **DINOv2** backbones: pair with any dataset. Used as a strong feature extractor with a new classifier head.
- **MobileNetV3 / EfficientNet**: use `food101` or `eurosat` (small models shine on mid-complexity tasks).

---

## Object Detection

### Popular datasets

| # | HF Dataset ID | Size (train) | Classes | Notes |
|---|---|---|---|---|
| 1 | `detection-datasets/coco` | 118,287 | 80 | COCO 2017 train. Standard benchmark. |
| 2 | `cppe-5` | 1,000 | 5 | Medical PPE — small, quick demo |
| 3 | `keremberke/chest-xray-object-detection` | 6,500 | 14 | Medical detection use-case |
| 4 | `keremberke/license-plate-object-detection` | 433 | 1 | License plate demo |
| 5 | `hajekj/detection-dataset` | varies | - | Community datasets |
| 6 | `rafaelpadilla/coco2017` | 118K | 80 | Alternative COCO mirror |

### Model-specific notes

- **DETR / Conditional DETR** (`facebook/detr-resnet-50`): designed for COCO; fine-tune on
  `cppe-5` or `chest-xray` for small-data demos. Slow to converge (often 50+ epochs).
- **RT-DETR / D-FINE**: state-of-the-art; `ustc-community/dfine-small-coco` is COCO-pretrained
  and fine-tunes quickly (10-30 epochs).
- **YOLOS** (`hustvl/yolos-tiny`): fastest; good for quick experiments on `cppe-5`.

---

## Semantic Segmentation

### Popular datasets

| # | HF Dataset ID | Size (train) | Classes | Notes |
|---|---|---|---|---|
| 1 | `scene_parse_150` | 20,210 | 150 | ADE20K — standard scene parsing benchmark |
| 2 | `segments/sidewalk-semantic` | 1,000 | 35 | Cityscapes-style street scenes |
| 3 | `Chris1/cityscapes` | 2,975 | 19 | Full Cityscapes (requires license acceptance) |
| 4 | `nateraw/ade20k-tiny` | 50 | 150 | Tiny smoke-test (50 images) |
| 5 | `Matthijs/sidewalk-semantic` | 1,000 | 35 | Mirror of segments/sidewalk-semantic |

### Model-specific notes

- **SegFormer** (`nvidia/segformer-b0/b1/.../b5-finetuned-*`): pre-finetuned on ADE20K or
  Cityscapes — match your dataset to the pretrained variant for best results.
- **UperNet / Mask2Former**: bigger models; use `scene_parse_150` for general scenes.
- **BEiT segmentation**: use with ADE20K.

---

## Depth Estimation

### Popular datasets

| # | HF Dataset ID | Size (train) | Notes |
|---|---|---|---|
| 1 | `sayakpaul/nyu_depth_v2` | 47,584 | NYU Depth v2 — indoor scenes, standard benchmark |
| 2 | `DepthAnything/kitti` | 26,000 | KITTI — outdoor driving |
| 3 | `nateraw/diode-subset` | varies | Mixed indoor/outdoor |

### Model-specific notes

- **Depth Anything v1/v2** (`LiheYoung/depth-anything-small-hf`): already strong zero-shot;
  fine-tune on domain-specific data (medical / industrial / aerial).
- **GLPN / DPT**: smaller; NYU Depth v2 is the canonical fine-tuning target.

---

## VLM / Image-Text-to-Text

### Popular datasets

| # | HF Dataset ID | Size (train) | Type | Notes |
|---|---|---|---|---|
| 1 | `lmms-lab/VQAv2` | 443K | VQA | ★ PREFERRED — images embedded as bytes. No COCO download. |
| 2 | `HuggingFaceM4/VQAv2` | 443K | VQA | ✗ AVOID — triggers 13.5GB COCO download |
| 3 | `lmms-lab/GQA` | 943K | VQA (scene graph) | Compositional reasoning |
| 4 | `lmms-lab/MME` | 2.4K | multi-task eval | Eval-only; good for zero-shot benchmarking |
| 5 | `HuggingFaceM4/the_cauldron` | ~2M | mixed VLM instruction | Large-scale instruction tuning |
| 6 | `nielsr/funsd-layoutlmv3` | 150 | document VQA | Small demo |
| 7 | `lmms-lab/TextVQA` | 34K | OCR-VQA | Text-in-image questions |
| 8 | `laion/laion-coco` | varies | captioning | Image captioning |
| 9 | `jxu124/llava-instruct-150k` | 150K | chat instruction | LLaVA-style multi-turn |
| 10 | `HuggingFaceH4/llava-instruct-mix-vsft` | 261K | chat (VSFT-ready) | VLM SFT dataset in TRL format |

### Model-specific notes

- **PaliGemma / PaliGemma 2** (`google/paligemma-3b-pt-224`, `google/paligemma2-3b-pt-224`):
  recommended with `lmms-lab/VQAv2` or `HuggingFaceM4/the_cauldron`.
  Use `lora_target_modules=".*language_model.*\\.(q_proj|k_proj|v_proj|o_proj|gate_proj|up_proj|down_proj)"`.
- **LLaVA-1.5 / LLaVA-Next** (`llava-hf/llava-1.5-7b-hf`, `llava-hf/llava-next-mistral-7b-hf`):
  fine-tune with `jxu124/llava-instruct-150k` or `HuggingFaceH4/llava-instruct-mix-vsft`.
- **Qwen2-VL** (`Qwen/Qwen2-VL-7B-Instruct`): `lmms-lab/VQAv2`, `lmms-lab/GQA`, or custom data.
  Requires `transformers>=5.0` and special image preprocessing.
- **Gemma 3/4 multimodal**: use `lmms-lab/VQAv2` for initial fine-tuning; small model works on 40GB VRAM.
- **IDEFICS 2/3** (`HuggingFaceM4/idefics2-8b`): pair with `HuggingFaceM4/the_cauldron` (same authors).

---

## LLM / Text Generation

### SFT (Supervised Fine-Tuning)

| # | HF Dataset ID | Size (train) | Type | Notes |
|---|---|---|---|---|
| 1 | `HuggingFaceH4/ultrachat_200k` | 207K | chat | Strong general-purpose SFT baseline |
| 2 | `OpenAssistant/oasst2` | 84K | chat | Multi-turn conversations, multilingual |
| 3 | `teknium/OpenHermes-2.5` | 1M | chat | Large instruction mix |
| 4 | `trl-lib/tldr` | 116K | summarization | Reddit TL;DR for specific tasks |
| 5 | `Anthropic/hh-rlhf` | 161K | helpful+harmless | Also usable for DPO |
| 6 | `tatsu-lab/alpaca` | 52K | instruction | Smaller, classic |
| 7 | `HuggingFaceH4/no_robots` | 10K | high-quality instruction | Small, hand-curated |

### DPO (Direct Preference Optimization)

| # | HF Dataset ID | Size (train) | Schema | Notes |
|---|---|---|---|---|
| 1 | `HuggingFaceH4/ultrafeedback_binarized` | 61K | prompt / chosen / rejected | Standard DPO benchmark |
| 2 | `Anthropic/hh-rlhf` | 161K | chosen / rejected | Harmlessness focus |
| 3 | `argilla/distilabel-intel-orca-dpo-pairs` | 12K | prompt / chosen / rejected | Distilled from Orca |
| 4 | `trl-lib/ultrafeedback_binarized` | 61K | TRL-formatted | Pre-formatted for TRL DPOTrainer |

### GRPO

| # | HF Dataset ID | Size (train) | Schema | Notes |
|---|---|---|---|---|
| 1 | `openai/gsm8k` | 7,473 | math QA | Standard math reasoning GRPO benchmark |
| 2 | `trl-lib/tldr` | 116K | prompt | Can be adapted for GRPO with custom reward |
| 3 | `HuggingFaceH4/MATH-lighteval` | varies | math | Advanced math benchmarks |

### Model-specific notes

- **Llama 3 / 3.1 / 3.2** (`meta-llama/Llama-3.2-1B-Instruct`, etc.): `ultrachat_200k` or `no_robots`.
- **Mistral / Mixtral** (`mistralai/Mistral-7B-v0.3`): `ultrafeedback_binarized` for DPO.
- **Qwen 2/2.5** (`Qwen/Qwen2.5-7B-Instruct`): Chinese + English — works with `OpenHermes-2.5` or `ultrachat`.
- **Gemma 2** (`google/gemma-2-2b`): use `ultrachat_200k`; Gemma-2 responds well to small datasets.
- **Phi-3 / Phi-4** (`microsoft/Phi-3-mini-4k-instruct`): strong reasoning — pair with GSM8K for GRPO.

---

## Presenting to the user (recommended agent prompt)

```
You provided model `{model_id}` (task: `{task}`) but no dataset.

Here are the most popular datasets used to post-train this model:

  1. {dataset_1}  {size_1}  {desc_1}
  2. {dataset_2}  {size_2}  {desc_2}
  3. {dataset_3}  {size_3}  {desc_3}
  4. {dataset_4}  {size_4}  {desc_4}
  5. Bring your own — provide a HF dataset ID or local path

Which would you like to use? (enter 1-5, an HF dataset ID like `owner/name`,
or a local path like `/path/to/my/dataset`)

If you choose a local dataset, we also need the format:
  imagefolder | coco | voc | jsonl | arrow | parquet | csv
(or leave blank and we'll try to auto-detect)
```

---

## Gated datasets note

Some datasets require accepting terms on HuggingFace before download:
- `imagenet-1k` — must click "Agree and access" on https://huggingface.co/datasets/imagenet-1k
- `Chris1/cityscapes` — Cityscapes license
- Some medical imaging datasets

If the user picks a gated dataset, check HF_TOKEN access in Phase 3 with:
```python
from huggingface_hub import HfApi
try:
    HfApi(token=hf_token).dataset_info(dataset_id)
except Exception as e:
    print(f"Gated or inaccessible. Visit https://huggingface.co/datasets/{dataset_id} to accept terms.")
```
