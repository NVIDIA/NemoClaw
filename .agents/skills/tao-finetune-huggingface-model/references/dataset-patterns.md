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

# Dataset Validation & Preparation Reference

Used in Phase 3 of tao-finetune-huggingface-model skill.

---

## prepare_data.py — Universal Template

```python
"""
prepare_data.py — Download N samples from HuggingFace to local Arrow format.

Usage:
  python prepare_data.py --config config.yaml
"""
import argparse
import os
import yaml
import random
from itertools import islice
from pathlib import Path
from datasets import load_dataset, Dataset


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--config", default="config.yaml")
    return p.parse_args()


def filter_valid(item: dict, task: str) -> bool:
    if task == "image-classification":
        return item.get("image") is not None and item.get("label") is not None
    elif task == "object-detection":
        objs = item.get("objects", {})
        return item.get("image") is not None and len(objs.get("bbox", [])) > 0
    elif task == "semantic-segmentation":
        return (item.get("image") is not None and
                (item.get("annotation") is not None or item.get("mask") is not None))
    elif task == "image-text-to-text":
        return (item.get("image") is not None and
                (item.get("question") is not None or item.get("messages") is not None))
    elif task == "text-generation":
        return item.get("messages") is not None or item.get("text") is not None
    return True


def stratified_examples(ds, n: int, label_col: str, seed: int):
    """Return up to n class-balanced examples for image-classification."""
    names = getattr(ds.features[label_col], "names", None) or sorted(set(ds[label_col]))
    n_classes = len(names)
    base, remainder = divmod(n, n_classes)
    by_label = {i: [] for i in range(n_classes)}
    for idx, label in enumerate(ds[label_col]):
        by_label[int(label)].append(idx)
    rng = random.Random(seed)
    selected = []
    for label in range(n_classes):
        indices = by_label[label]
        rng.shuffle(indices)
        selected.extend(indices[: base + (1 if label < remainder else 0)])
    rng.shuffle(selected)
    return [ds[i] for i in selected[:n]]


def main():
    args = parse_args()
    with open(args.config) as f:
        cfg = yaml.safe_load(f)

    dataset_id = cfg["dataset_id"]
    task = cfg["task"]
    n_train = cfg.get("n_train", 10000)
    n_eval = cfg.get("n_eval", 1000)
    token = os.environ.get("HF_TOKEN") or cfg.get("hf_token")
    out_dir = Path(cfg.get("local_data_dir", "./data"))
    out_dir.mkdir(parents=True, exist_ok=True)

    # Determine split names (HF datasets use various conventions)
    train_split = cfg.get("train_split", "train")
    eval_split = cfg.get("eval_split", "validation")

    for split, n, name in [(train_split, n_train, "train"), (eval_split, n_eval, "eval")]:
        print(f"Downloading {n} examples from {dataset_id} split={split}...")
        try:
            if task == "image-classification":
                ds = load_dataset(dataset_id, split=split, token=token)
                ds = ds.filter(lambda x: filter_valid(x, task))
                label_col = "labels" if "labels" in ds.column_names else "label"
                examples = stratified_examples(ds, n, label_col, seed=42 if name == "train" else 43)
            else:
                raw = load_dataset(dataset_id, split=split, streaming=True,
                                   token=token)
                raw = raw.filter(lambda x: filter_valid(x, task))
                examples = list(islice(raw, n))
        except Exception as e:
            # Fallback: try non-streaming if dataset doesn't support it
            print(f"  Streaming failed ({e}), falling back to direct load...")
            ds = load_dataset(dataset_id, split=f"{split}[:{n}]",
                              token=token)
            examples = [ds[i] for i in range(min(n, len(ds)))]

        if len(examples) == 0:
            raise ValueError(f"No valid examples found in {dataset_id}/{split} for task={task}")

        # Save to Arrow format
        arrow_path = str(out_dir / name)
        Dataset.from_list(examples).save_to_disk(arrow_path)
        print(f"  Saved {len(examples)} examples to {arrow_path}")

    # Sanity check
    from datasets import load_from_disk, Image as HFImage
    train_ds = load_from_disk(str(out_dir / "train"))
    if "image" in train_ds.column_names:
        train_ds = train_ds.cast_column("image", HFImage())
    print(f"\nSanity check — train:")
    print(f"  Columns: {train_ds.column_names}")
    print(f"  Count: {len(train_ds)}")
    print(f"  Sample[0] keys: {list(train_ds[0].keys())}")


if __name__ == "__main__":
    main()
```

---

## Column Schema Requirements by Task

### image-classification
```
Required: image (PIL/bytes), label (int or ClassLabel)
Optional: label_name (str)

Validation check:
  assert "image" in ds.column_names
  assert "label" in ds.column_names
  assert isinstance(ds[0]["label"], int)

Common HF datasets:
  - beans (3 classes, 1034 train images)
  - food101 (101 classes, 75750 train images)
  - imagenet-1k (1000 classes, gated)
  - cifar10 (10 classes, 50000 train images)
```

### object-detection
```
Required: image (PIL/bytes), objects (dict with bbox and category_id)

Expected objects structure:
  {
    "bbox": [[x, y, w, h], [x2, y2, w2, h2]],   # list of bboxes (COCO xywh or xyxy)
    "category_id": [0, 1],                          # list of int class ids
    "id": [42, 43],                                 # optional bbox IDs
    "area": [1234, 567],                            # optional
    "iscrowd": [0, 0]                               # optional
  }

Validation check:
  objs = ds[0]["objects"]
  assert "bbox" in objs and "category_id" in objs
  assert len(objs["bbox"]) == len(objs["category_id"])

Common HF datasets:
  - detection-datasets/coco_2017_val (118K train, COCO format)
  - keremberke/chest-xray-object-detection
  - keremberke/satellite-object-detection

GOTCHA: Some datasets use "categories" instead of "category_id". Check and rename in dataset.py.
GOTCHA: bbox can be xywh (COCO) or xyxy. Always convert to xywh for DETR/RT-DETR processors.
```

### semantic-segmentation
```
Required: image (PIL/bytes), annotation or mask (PIL grayscale, same WxH as image)

Validation check:
  assert "image" in ds.column_names
  assert "annotation" in ds.column_names or "mask" in ds.column_names
  # Check mask and image have same size
  item = ds[0]
  assert item["image"].size == item.get("annotation", item.get("mask")).size

Common HF datasets:
  - scene_parse_150 (ADE20K, 150 classes, 20210 train)
  - sidewalk-semantic (19 classes, Cityscapes-style)
  - segments/sidewalk-semantic

GOTCHA: Mask pixel values should be class indices (0-N), not RGB colors.
  If masks are RGB, convert: mask = Image.fromarray(np.array(mask_rgb)[:,:,0])
GOTCHA: ignore_index=255 is standard for "unlabeled" pixels in most seg datasets.
```

### image-text-to-text (VLM)
```
Required: image (PIL/bytes), and one of:
  - question (str) + answers (list[str]) — VQA style
  - messages (list[{role, content}]) — chat style
  - caption (str) — captioning style

Validation check:
  has_vqa = "question" in ds.column_names and "answers" in ds.column_names
  has_chat = "messages" in ds.column_names
  has_cap = "caption" in ds.column_names or "text" in ds.column_names
  assert has_vqa or has_chat or has_cap

Common HF datasets:
  - lmms-lab/VQAv2 (443K train, VQA style) ← PREFERRED for VQA
  - HuggingFaceM4/VQAv2 ← AVOID: triggers 13.5GB COCO download
  - nyu-dl/clevr (clevr VQA, synthetic)
  - liuhaotian/LLaVA-Instruct-150K (instruction following)

GOTCHA: lmms-lab/VQAv2 answers field is a list — use answers[0] as primary,
  full list for VQA accuracy scoring (need ≥3 annotators for official protocol).
```

### text-generation (LLM SFT)
```
Required: messages (list[{role, content}]) or text (str) or prompt+completion

Validation check:
  has_messages = "messages" in ds.column_names
  has_text = "text" in ds.column_names
  has_pc = "prompt" in ds.column_names and "completion" in ds.column_names
  assert has_messages or has_text or has_pc

DPO additionally requires: prompt, chosen, rejected columns

Common HF datasets:
  - HuggingFaceH4/ultrachat_200k (chat SFT)
  - HuggingFaceH4/ultrafeedback_binarized (DPO)
  - trl-lib/tldr (summarization SFT)
```

---

## Arrow PIL Bug Fix

Always apply after `load_from_disk()`:

```python
from datasets import load_from_disk, Image as HFImage

ds = load_from_disk("./data/train")
if "image" in ds.column_names:
    # Without this, image column comes back as dict {"bytes": ..., "path": None}
    # causing TypeError in any processor call
    ds = ds.cast_column("image", HFImage())
```

Similarly for annotation/mask columns:
```python
if "annotation" in ds.column_names:
    ds = ds.cast_column("annotation", HFImage())
if "mask" in ds.column_names:
    ds = ds.cast_column("mask", HFImage())
```

---

## Sample Size Recommendations

| GPU VRAM | Model size | Recommended n_train |
|----------|-----------|---------------------|
| 24 GB | small (<1B) | 50K-100K |
| 24 GB | medium (1-3B) | 10K-50K |
| 80 GB | small (<1B) | 100K+ |
| 80 GB | medium (1-7B) | 50K-100K |
| 80 GB | large (7B+) | 10K-50K (LoRA) |

For quick validation runs, use `n_train=1000`, `n_eval=200`.

---

## Config Fields for Dataset

```yaml
dataset_id: lmms-lab/VQAv2
train_split: train           # default "train"
eval_split: validation       # default "validation" — try "test" if missing
local_data_dir: ./data
n_train: 10000
n_eval: 1000
```

If the dataset has no `validation` split:
```yaml
eval_split: train[90%:]   # last 10% of train as eval
```
