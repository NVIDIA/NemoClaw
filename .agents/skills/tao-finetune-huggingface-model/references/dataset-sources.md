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

# Dataset Source Handling Reference

Used in Phase 3 of tao-finetune-huggingface-model skill. Datasets can come from THREE sources:

1. **HuggingFace Hub** — user provides `dataset_id` like `lmms-lab/VQAv2`
2. **User-provided local dataset** — user provides `local_dataset_path` (folder / file)
3. **No dataset** — user provides only `model_id`; skill recommends popular datasets
   (see `dataset-recommendations.md`)

---

## Source Detection Logic

```python
def detect_dataset_source(config: dict) -> str:
    """Returns 'hf' | 'local' | 'recommend'."""
    if config.get("local_dataset_path"):
        path = Path(config["local_dataset_path"])
        if not path.exists():
            raise FileNotFoundError(f"local_dataset_path does not exist: {path}")
        return "local"
    if config.get("dataset_id"):
        return "hf"
    return "recommend"   # → agent must present dataset options to user
```

Config fields:
```yaml
# Option A — HF Hub
dataset_id: lmms-lab/VQAv2

# Option B — user's local dataset
local_dataset_path: /path/to/my/dataset
local_dataset_format: auto          # auto | imagefolder | coco | voc | jsonl | arrow | csv

# Option C — no dataset (agent recommends, user picks)
# (neither dataset_id nor local_dataset_path set)
```

---

## Option A: HuggingFace Hub (see dataset-patterns.md)

Use the `prepare_data.py` template from `dataset-patterns.md`. Streams N samples and
saves to Arrow at `output_dir/data/train` and `output_dir/data/eval`.

**Additional validation step before download:** verify HF_TOKEN has dataset access:

```python
from huggingface_hub import HfApi
api = HfApi(token=hf_token)
try:
    info = api.dataset_info(dataset_id)
    print(f"OK: dataset accessible, {info.downloads or 0} downloads")
except Exception as e:
    print(f"REJECT: cannot access {dataset_id} — {e}")
    # Common causes: gated dataset (user must accept terms on HF), wrong token, typo
```

---

## Option B: User-Provided Local Dataset

### Format auto-detection

Given `local_dataset_path`, detect format from directory structure:

```python
from pathlib import Path

def detect_local_format(path: Path) -> str:
    if path.is_file():
        if path.suffix in (".jsonl", ".json"):
            return "jsonl"
        if path.suffix == ".csv":
            return "csv"
        if path.suffix in (".parquet",):
            return "parquet"
        raise ValueError(f"Unsupported file: {path.suffix}")

    # Directory cases
    if (path / "dataset_info.json").exists() or (path / "data-00000-of-00001.arrow").exists():
        return "arrow"                                    # HF Dataset saved via save_to_disk

    if (path / "annotations.json").exists() or any(path.rglob("instances_*.json")):
        return "coco"                                     # COCO detection/segmentation

    if any((path / "Annotations").rglob("*.xml")) if (path / "Annotations").exists() else False:
        return "voc"                                      # Pascal VOC

    # ImageFolder: subdirectories are class names
    subdirs = [d for d in path.iterdir() if d.is_dir()]
    if len(subdirs) >= 2 and all(
        any(d.rglob("*.jpg")) or any(d.rglob("*.png"))
        for d in subdirs[:3]
    ):
        return "imagefolder"

    # Could also be: split-folder layout (train/, val/, test/ subdirs)
    if (path / "train").is_dir() and ((path / "val").is_dir() or (path / "validation").is_dir()):
        for split in ["train", "val", "validation", "test"]:
            sp = path / split
            if sp.is_dir() and any(d.is_dir() for d in sp.iterdir()):
                return "imagefolder_split"
        return "imagefolder_split"

    raise ValueError(
        f"Cannot detect format of {path}. "
        f"Set local_dataset_format explicitly: imagefolder | coco | voc | jsonl | arrow | parquet | csv"
    )
```

---

### B.1: ImageFolder (classification)

**Directory structure:**
```
dataset/
├── cat/
│   ├── img001.jpg
│   └── img002.jpg
├── dog/
│   ├── img003.jpg
│   └── img004.jpg
└── bird/
    └── img005.jpg
```

Or with pre-split:
```
dataset/
├── train/
│   ├── cat/*.jpg
│   └── dog/*.jpg
└── val/
    ├── cat/*.jpg
    └── dog/*.jpg
```

**Loader:**
```python
from datasets import load_dataset

# Single folder → auto 90/10 split
ds = load_dataset("imagefolder", data_dir="/path/to/dataset")
train_ds = ds["train"].train_test_split(test_size=0.1, seed=42)
train_ds, eval_ds = train_ds["train"], train_ds["test"]

# Pre-split folder
ds = load_dataset("imagefolder", data_dir="/path/to/dataset")
train_ds, eval_ds = ds["train"], ds["validation"]
```

`ImageFolder` gives columns `image` (PIL) and `label` (int) — ready for classification training.

---

### B.2: COCO JSON (detection / instance segmentation)

**Directory structure:**
```
dataset/
├── annotations/
│   ├── instances_train2017.json
│   └── instances_val2017.json
├── train2017/
│   ├── 000000000001.jpg
│   └── 000000000002.jpg
└── val2017/
    └── ...
```

**Loader (convert to HF Dataset format):**
```python
import json
from pathlib import Path
from datasets import Dataset, Features, Sequence, Value
from datasets import Image as HFImage


def load_coco(coco_json: str, image_dir: str) -> Dataset:
    with open(coco_json) as f:
        coco = json.load(f)

    # Build image_id → filename and image_id → list of annotations
    images = {img["id"]: img for img in coco["images"]}
    anns_by_img = {}
    for ann in coco["annotations"]:
        anns_by_img.setdefault(ann["image_id"], []).append(ann)

    categories = {c["id"]: c["name"] for c in coco["categories"]}
    cat_id_list = sorted(categories.keys())
    cat_id_to_idx = {cid: i for i, cid in enumerate(cat_id_list)}

    examples = []
    for img_id, img_info in images.items():
        anns = anns_by_img.get(img_id, [])
        if not anns:
            continue
        examples.append({
            "image": str(Path(image_dir) / img_info["file_name"]),
            "image_id": img_id,
            "width": img_info["width"],
            "height": img_info["height"],
            "objects": {
                "bbox": [a["bbox"] for a in anns],                       # xywh
                "category_id": [cat_id_to_idx[a["category_id"]] for a in anns],
                "area": [a.get("area", a["bbox"][2] * a["bbox"][3]) for a in anns],
                "iscrowd": [a.get("iscrowd", 0) for a in anns],
            },
        })

    ds = Dataset.from_list(examples)
    ds = ds.cast_column("image", HFImage())
    ds.info.description = f"COCO dataset — {len(categories)} classes"
    ds.id2label = {cat_id_to_idx[cid]: categories[cid] for cid in cat_id_list}
    return ds


# Usage:
train_ds = load_coco("annotations/instances_train2017.json", "train2017/")
eval_ds = load_coco("annotations/instances_val2017.json", "val2017/")
```

**GOTCHA:** COCO `bbox` is already `[x, y, w, h]`. DETR/RT-DETR processors expect this.
If your model expects `[x1, y1, x2, y2]`, convert in `dataset.py`.

---

### B.3: Pascal VOC XML (detection)

**Directory structure:**
```
dataset/
├── Annotations/          # *.xml files
│   └── 000001.xml
├── JPEGImages/
│   └── 000001.jpg
└── ImageSets/Main/
    ├── train.txt         # one image stem per line
    └── val.txt
```

**Loader:**
```python
import xml.etree.ElementTree as ET
from pathlib import Path
from datasets import Dataset, Image as HFImage


def load_voc(voc_root: str, split_file: str) -> Dataset:
    voc_root = Path(voc_root)
    stems = (voc_root / "ImageSets/Main" / split_file).read_text().strip().split("\n")

    # First pass: collect all classes
    classes = set()
    for stem in stems:
        xml = ET.parse(voc_root / "Annotations" / f"{stem}.xml").getroot()
        for obj in xml.findall("object"):
            classes.add(obj.find("name").text)
    cat_to_idx = {c: i for i, c in enumerate(sorted(classes))}

    examples = []
    for stem in stems:
        xml = ET.parse(voc_root / "Annotations" / f"{stem}.xml").getroot()
        w = int(xml.find("size/width").text)
        h = int(xml.find("size/height").text)
        bboxes, cat_ids = [], []
        for obj in xml.findall("object"):
            bb = obj.find("bndbox")
            x1, y1 = float(bb.find("xmin").text), float(bb.find("ymin").text)
            x2, y2 = float(bb.find("xmax").text), float(bb.find("ymax").text)
            bboxes.append([x1, y1, x2 - x1, y2 - y1])                    # → xywh
            cat_ids.append(cat_to_idx[obj.find("name").text])
        examples.append({
            "image": str(voc_root / "JPEGImages" / f"{stem}.jpg"),
            "width": w, "height": h,
            "objects": {"bbox": bboxes, "category_id": cat_ids,
                        "area": [b[2]*b[3] for b in bboxes],
                        "iscrowd": [0] * len(bboxes)},
        })
    ds = Dataset.from_list(examples)
    ds = ds.cast_column("image", HFImage())
    ds.id2label = {i: c for c, i in cat_to_idx.items()}
    return ds
```

---

### B.4: Semantic Segmentation Folder

**Directory structure:**
```
dataset/
├── images/
│   ├── train/*.jpg
│   └── val/*.jpg
└── masks/                 # grayscale PNGs, pixel = class id
    ├── train/*.png
    └── val/*.png
```

**Loader:**
```python
from pathlib import Path
from datasets import Dataset, Image as HFImage


def load_seg_folder(images_dir: str, masks_dir: str) -> Dataset:
    images_dir, masks_dir = Path(images_dir), Path(masks_dir)
    examples = []
    for img in sorted(images_dir.glob("*.jpg")) + sorted(images_dir.glob("*.png")):
        stem = img.stem
        mask = masks_dir / f"{stem}.png"
        if not mask.exists():
            continue
        examples.append({"image": str(img), "annotation": str(mask)})
    ds = Dataset.from_list(examples)
    ds = ds.cast_column("image", HFImage()).cast_column("annotation", HFImage())
    return ds
```

**Optional `id2label.json`:** if `<masks_dir>/../id2label.json` exists, load it for class names.

---

### B.5: JSONL (VLM / LLM)

**File format — one JSON per line:**
```jsonl
{"image": "/path/to/img1.jpg", "question": "What color is the ball?", "answer": "red"}
{"image": "/path/to/img2.jpg", "question": "How many dogs?", "answer": "two"}
```

Or chat format:
```jsonl
{"image": "/path/to/img1.jpg", "messages": [{"role": "user", "content": [{"type":"image"},{"type":"text","text":"Describe"}]}, {"role": "assistant", "content": "A red ball on grass"}]}
```

Or text-only (LLM):
```jsonl
{"messages": [{"role": "user", "content": "Hi"}, {"role": "assistant", "content": "Hello"}]}
{"prompt": "Once upon a time", "completion": "there was a dragon"}
```

**Loader:**
```python
from datasets import load_dataset, Image as HFImage

ds = load_dataset("json", data_files={"train": "data/train.jsonl",
                                      "eval": "data/val.jsonl"})
if "image" in ds["train"].column_names:
    ds = ds.cast_column("image", HFImage())
```

**GOTCHA:** If `image` column is a string path, HF Datasets auto-casts with `HFImage()`.
If paths are relative, resolve them relative to the JSONL file's directory first.

---

### B.6: Arrow (HF save_to_disk output)

**Directory structure:**
```
dataset/
├── data-00000-of-00001.arrow
├── dataset_info.json
└── state.json
```

**Loader (no conversion needed):**
```python
from datasets import load_from_disk, Image as HFImage

ds = load_from_disk("/path/to/arrow_dataset")
if "image" in ds.column_names:
    ds = ds.cast_column("image", HFImage())
```

---

### B.7: CSV/Parquet

**CSV format (text tasks, or classification with image paths):**
```csv
image_path,label
/data/img1.jpg,cat
/data/img2.jpg,dog
```

**Loader:**
```python
from datasets import load_dataset
ds = load_dataset("csv", data_files={"train": "train.csv", "eval": "val.csv"})
# Convert image paths to PIL if needed:
if "image_path" in ds["train"].column_names:
    ds = ds.rename_column("image_path", "image")
    ds = ds.cast_column("image", HFImage())
# String labels → ClassLabel
if "label" in ds["train"].column_names and isinstance(ds["train"][0]["label"], str):
    from datasets import ClassLabel
    names = sorted(set(ds["train"]["label"]))
    ds = ds.cast_column("label", ClassLabel(names=names))
```

---

## Option C: No Dataset Provided (agent must recommend)

The agent using this skill must:

1. Look up `task` from Phase 0 output.
2. Open `references/dataset-recommendations.md` and present the matching section to the user.
3. Ask user to pick one, OR to provide a `dataset_id` / `local_dataset_path`.
4. Do NOT proceed to download until user confirms.

Example interaction:
```
Agent: You provided model `google/vit-base-patch16-224` (image-classification).
       You didn't specify a dataset. Here are popular choices:

       1. beans (small, 3 classes, 1034 images)               — good for quick test
       2. food101 (101 classes, 75K images)                   — standard benchmark
       3. imagenet-1k (1000 classes, gated)                   — full ImageNet
       4. cifar10 (10 classes, 60K images)                    — fast baseline
       5. Bring your own dataset (provide --local_dataset_path)

       Which one? (or type a custom HF dataset ID)
```

---

## Universal prepare_data.py (handles all sources)

```python
"""prepare_data.py — universal data prep for HF / local / pre-recommended datasets."""
import argparse
import os
import yaml
from pathlib import Path
from datasets import load_dataset, load_from_disk, Dataset, Image as HFImage
from itertools import islice


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--config", default="config.yaml")
    return p.parse_args()


def from_hf(cfg, split_name, n, token):
    raw = load_dataset(cfg["dataset_id"], split=split_name, streaming=True,
                       token=token, trust_remote_code=True)
    return list(islice(raw, n))


def from_local(cfg, split_name, n):
    from local_loaders import load_local_dataset            # see below
    ds = load_local_dataset(cfg["local_dataset_path"],
                            cfg.get("local_dataset_format", "auto"),
                            cfg["task"])
    # ds is a DatasetDict or Dataset
    if hasattr(ds, "keys"):
        ds = ds.get(split_name) or ds.get("train")
    return [ds[i] for i in range(min(n, len(ds)))]


def main():
    args = parse_args()
    cfg = yaml.safe_load(open(args.config))
    token = os.environ.get("HF_TOKEN")
    out_dir = Path(cfg.get("local_data_dir", "./data"))
    out_dir.mkdir(parents=True, exist_ok=True)

    source = "local" if cfg.get("local_dataset_path") else "hf" if cfg.get("dataset_id") else None
    if source is None:
        raise ValueError("Config must set either dataset_id (HF) or local_dataset_path (local)")

    for split_key, n, out_name in [
        (cfg.get("train_split", "train"), cfg.get("n_train", 10000), "train"),
        (cfg.get("eval_split", "validation"), cfg.get("n_eval", 1000), "eval"),
    ]:
        print(f"Loading {out_name} from {source} source (split={split_key}, n={n})...")
        if source == "hf":
            examples = from_hf(cfg, split_key, n, token)
        else:
            examples = from_local(cfg, split_key, n)
        Dataset.from_list(examples).save_to_disk(str(out_dir / out_name))
        print(f"  → {out_dir / out_name} ({len(examples)} examples)")


if __name__ == "__main__":
    main()
```

Companion file `local_loaders.py` (generated alongside `prepare_data.py` only when `local_dataset_path` is set) implements the format-specific loaders from sections B.1–B.7 above.

---

## Validation checklist

After `prepare_data.py` runs, verify:
```python
from datasets import load_from_disk
train = load_from_disk("data/train")
eval_ = load_from_disk("data/eval")

assert len(train) > 0, "train split empty"
assert len(eval_) > 0, "eval split empty"
assert set(train.column_names) == set(eval_.column_names), "column schema mismatch"

# Print sample for user inspection
print("Columns:", train.column_names)
print("Train count:", len(train), "| Eval count:", len(eval_))
print("Sample keys:", list(train[0].keys()))
```
