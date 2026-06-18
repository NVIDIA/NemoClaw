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

# CV Pipeline Scripts Reference

> **How to use this file**
>
> This file defines two things:
> 1. **Structural scaffolding** (marked `[SCAFFOLD]`) — file names, entry point names, config
>    schema, CLI boilerplate, logging setup, checkpoint saving. Copy these as-is.
> 2. **ML implementation stubs** (marked `[FETCH LIVE]`) — preprocessing transforms, model
>    loading kwargs, collator choice, training loop, metrics. **Do NOT copy these.**
>    Instead, fetch the canonical live HuggingFace documentation for the task and use that.
>
> **Why:** templates go stale. The HF docs are maintained by the model authors. The augmentation
> pattern, collator class, and `compute_metrics` signature change across model families and
> transformers versions. Empirical test: using a static template without augmentation gave 57%
> accuracy; using the live HF image_classification tutorial pattern gave 94% on the same data.
>
> **Live doc URLs to fetch in Phase 4.2:**
>
> | Task | Primary doc URL | Secondary |
> |------|----------------|-----------|
> | image-classification | `https://huggingface.co/docs/transformers/tasks/image_classification` | model card on HF Hub |
> | object-detection | `https://huggingface.co/docs/transformers/tasks/object_detection` | model card |
> | semantic-segmentation | `https://huggingface.co/docs/transformers/tasks/semantic_segmentation` | model card |
> | instance-segmentation | `https://huggingface.co/docs/transformers/tasks/instance_segmentation` | model card |
> | depth-estimation | `https://huggingface.co/docs/transformers/tasks/monocular_depth_estimation` | model card |
>
> Also search GitHub: `site:github.com transformers {model_type} fine-tune train.py`
> and inspect the top result's preprocessing section before writing any transforms.
>
> **Rule:** if the live doc's pattern contradicts anything in this file, the live doc wins.
> Log the discrepancy in PROGRESS.md with the doc URL.

---

## requirements.txt — CV Template

```text
# Core HF stack (unpinned — let the NGC base image's transformers win unless a
# compat-workaround forces a pin in the Dockerfile post-install).
transformers
accelerate
datasets
evaluate

# Vision backbones. `timm` is required by several transformers vision models
# whose default ResNet/ConvNeXt backbones go through timm (DETR family,
# Conditional/Deformable DETR, BEiT, ViTMatte, OneFormer, ...). Cheap to
# include and avoids "ImportError: requires the timm library" on first load.
timm
torchvision

# Detection / segmentation metrics.
torchmetrics
pycocotools

# Reporting.
matplotlib
Pillow
pyyaml
tqdm

# Tests (Phase 4.5).
pytest>=7.0
```

> **Why unpinned core?** The NGC base image ships pinned `torch`/`transformers`/
> `accelerate` for a known-good driver/CUDA combo. Pinning here often forces
> pip to downgrade the NGC versions and break the build. The
> `compat-workarounds.md` registry adds version pins via `dockerfile_block`
> only when a known incompatibility is detected.

---

## config.yaml — CV Template

```yaml
# Model
model_id: google/vit-base-patch16-224
task: image-classification          # image-classification | object-detection | semantic-segmentation
auto_model: AutoModelForImageClassification

# Dataset
dataset_id: imagenet-1k
local_data_dir: ./data
n_train: 10000
n_eval: 1000

# Training
output_dir: ./checkpoints
num_train_epochs: 3
per_device_train_batch_size: 32
per_device_eval_batch_size: 64
learning_rate: 5.0e-5
head_learning_rate: 3.0e-3   # image-classification: faster newly initialized head
warmup_ratio: 0.1
weight_decay: 0.01
lr_scheduler_type: cosine
bf16: true
gradient_checkpointing: false
dataloader_num_workers: 4
dataloader_pin_memory: true
remove_unused_columns: false

# Evaluation
eval_strategy: epoch
save_strategy: epoch
load_best_model_at_end: true
metric_for_best_model: accuracy
greater_is_better: true

# Monitoring
report_to: wandb
logging_steps: 10

# Packaging
model_short_name: vit-base-imagenet
```

---

## model.py

```python
import yaml
import torch
from transformers import (
    AutoConfig,
    AutoImageProcessor,
    AutoModelForImageClassification,
    AutoModelForObjectDetection,
    AutoModelForSemanticSegmentation,
    AutoModelForDepthEstimation,
)

_AUTO_MODEL_MAP = {
    "image-classification": AutoModelForImageClassification,
    "object-detection": AutoModelForObjectDetection,
    "semantic-segmentation": AutoModelForSemanticSegmentation,
    "depth-estimation": AutoModelForDepthEstimation,
}


def load_model_and_processor(cfg: dict):
    model_id = cfg["model_id"]
    task = cfg["task"]
    token = cfg.get("hf_token") or None

    processor = AutoImageProcessor.from_pretrained(model_id, token=token)

    # Build id2label / label2id from dataset feature metadata
    id2label = cfg.get("id2label", {})
    label2id = {v: k for k, v in id2label.items()} if id2label else {}

    AutoModelCls = _AUTO_MODEL_MAP[task]
    # Load in float32 — let TrainingArguments(bf16=True) handle mixed precision.
    # Loading in bfloat16 AND enabling bf16 training causes optimizer underflow.
    model = AutoModelCls.from_pretrained(
        model_id,
        token=token,
        ignore_mismatched_sizes=True,   # safe for label count changes
        **({"id2label": id2label, "label2id": label2id} if id2label else {}),
    )

    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    total = sum(p.numel() for p in model.parameters())
    print(f"Trainable: {trainable / 1e6:.1f}M / {total / 1e6:.1f}M params ({100 * trainable / total:.1f}%)")

    return model, processor
```

---

## dataset.py

```python
import yaml
import torch
from datasets import load_from_disk, Image as HFImage
from torch.utils.data import Dataset
from torchvision.transforms import (
    CenterCrop, Compose, Normalize,
    RandomHorizontalFlip, RandomResizedCrop, RandAugment, Resize, ToTensor,
)


def make_classification_transforms(processor, is_train: bool):
    """Build augmentation pipeline from processor's normalization stats.

    Training uses RandomResizedCrop + RandomHorizontalFlip + RandAugment — critical for
    small datasets and ConvNeXt/ViT fine-tunes. Keep eval deterministic; do not rely on
    AutoImageProcessor resize+normalize alone for paper-level classification accuracy.
    Eval uses deterministic Resize + CenterCrop.
    """
    if "shortest_edge" in processor.size:
        size = processor.size["shortest_edge"]
    else:
        size = processor.size["height"]
    normalize = Normalize(mean=processor.image_mean, std=processor.image_std)

    if is_train:
        return Compose([
            RandomResizedCrop(size),
            RandomHorizontalFlip(),
            RandAugment(num_ops=2, magnitude=9),
            ToTensor(),
            normalize,
        ])
    else:
        return Compose([
            Resize(size),
            CenterCrop(size),
            ToTensor(),
            normalize,
        ])


class CVDataset(Dataset):
    def __init__(self, arrow_path: str, processor, task: str,
                 is_train: bool = False, id2label: dict = None):
        self.ds = load_from_disk(arrow_path)
        if "image" in self.ds.column_names:
            self.ds = self.ds.cast_column("image", HFImage())
        self.processor = processor
        self.task = task
        self.id2label = id2label or {}
        self.label_col = "labels" if "labels" in self.ds.column_names else "label"

        if task == "image-classification":
            self.transform = make_classification_transforms(processor, is_train)
        else:
            self.transform = None

    def __len__(self):
        return len(self.ds)

    def __getitem__(self, idx):
        item = self.ds[idx]
        image = item["image"].convert("RGB")

        if self.task == "image-classification":
            pixel_values = self.transform(image)
            return {
                "pixel_values": pixel_values,
                "labels": torch.tensor(item[self.label_col], dtype=torch.long),
            }

        elif self.task == "object-detection":
            objects = item["objects"]
            annotations = {
                "image_id": idx,
                "annotations": [
                    {
                        "bbox": bbox,
                        "category_id": cat_id,
                        "iscrowd": 0,
                        "area": bbox[2] * bbox[3],  # w * h
                    }
                    for bbox, cat_id in zip(objects["bbox"], objects["category_id"])
                ],
            }
            inputs = self.processor(
                images=image,
                annotations=annotations,
                return_tensors="pt",
            )
            # Detection processors return `pixel_values` with a leading batch dim
            # of 1, but `labels` is already a list-of-1 dict whose tensors have
            # no batch dim. Squeezing the dict uniformly breaks scalar label
            # tensors (shape (1,) → 0-dim scalar → "zero-dimensional tensor
            # cannot be concatenated" in loss). Handle each key explicitly.
            inputs = {
                "pixel_values": inputs["pixel_values"].squeeze(0),
                "labels": inputs["labels"][0],
            }

        elif self.task == "semantic-segmentation":
            mask = item.get("annotation") or item.get("mask")
            inputs = self.processor(images=image, segmentation_maps=mask, return_tensors="pt")
            inputs = {k: v.squeeze(0) for k, v in inputs.items()}

        elif self.task == "depth-estimation":
            depth = item.get("depth") or item.get("depth_map")
            inputs = self.processor(images=image, return_tensors="pt")
            inputs = {k: v.squeeze(0) for k, v in inputs.items()}
            inputs["labels"] = torch.tensor(depth, dtype=torch.float32)

        return inputs


def make_collate_fn_detection(processor):
    """Detection collator factory — version-agnostic manual pad.

    Most object-detection processors (DETR, Conditional/Deformable DETR, RT-DETR,
    Mask2Former, etc.) resize images independently per sample, so naive
    `torch.stack(pixel_values)` fails with "stack expects equal size".

    transformers 4.x exposed `processor.pad(images, return_tensors="pt")` as a
    batch-pad helper; transformers 5.x removed that overload (`pad` is now a
    per-image API: `pad(image, padded_size, ...)`). Doing the pad manually with
    `torch.nn.functional.pad` works on both 4.x and 5.x and produces the same
    output the 4.x batch-pad produced internally. Labels stay as a list-of-dicts
    (variable bbox count per image).
    """
    del processor  # unused — kept for signature stability so callers don't change
    def collate_fn(batch):
        pixel_values = [b["pixel_values"] for b in batch]
        labels = [b["labels"] for b in batch]
        max_h = max(pv.shape[-2] for pv in pixel_values)
        max_w = max(pv.shape[-1] for pv in pixel_values)
        padded, masks = [], []
        for pv in pixel_values:
            c, h, w = pv.shape
            padded.append(torch.nn.functional.pad(pv, (0, max_w - w, 0, max_h - h), value=0.0))
            mask = torch.zeros(max_h, max_w, dtype=torch.long)
            mask[:h, :w] = 1
            masks.append(mask)
        return {
            "pixel_values": torch.stack(padded),
            "pixel_mask": torch.stack(masks),
            "labels": labels,
        }
    return collate_fn
```

---

## train.py

```python
import argparse
import os
import yaml
import evaluate
import numpy as np
import torch
from transformers import TrainingArguments, Trainer
from model import load_model_and_processor
from dataset import CVDataset, make_collate_fn_detection


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--config", default="config.yaml")
    return p.parse_args()


def make_compute_metrics(task: str, processor=None):
    if task == "image-classification":
        acc_metric = evaluate.load("accuracy")
        def compute_metrics(eval_pred):
            logits, labels = eval_pred
            preds = np.argmax(logits, axis=-1)
            acc = acc_metric.compute(predictions=preds, references=labels)
            # top-5
            top5 = np.mean([
                labels[i] in np.argsort(logits[i])[-5:]
                for i in range(len(labels))
            ])
            return {"accuracy": acc["accuracy"], "top5_accuracy": top5}
        return compute_metrics

    elif task == "semantic-segmentation":
        miou_metric = evaluate.load("mean_iou")
        def compute_metrics(eval_pred):
            logits, labels = eval_pred
            preds = np.argmax(logits, axis=1)
            result = miou_metric.compute(
                predictions=preds,
                references=labels,
                num_labels=logits.shape[1],
                ignore_index=255,
                reduce_labels=False,
            )
            return {
                "mean_iou": result["mean_iou"],
                "mean_accuracy": result["mean_accuracy"],
            }
        return compute_metrics

    return None


def main():
    args = parse_args()
    with open(args.config) as f:
        cfg = yaml.safe_load(f)

    cfg["hf_token"] = os.environ.get("HF_TOKEN")

    # Populate id2label from dataset ClassLabel feature before loading model
    from datasets import load_from_disk
    _raw = load_from_disk(f"{cfg['local_data_dir']}/train")
    _label_col = "labels" if "labels" in _raw.column_names else "label"
    if hasattr(_raw.features[_label_col], "names"):
        names = _raw.features[_label_col].names
        cfg["id2label"] = {str(i): n for i, n in enumerate(names)}
        cfg["num_labels"] = len(names)
        print(f"Labels ({len(names)}): {names}")

    model, processor = load_model_and_processor(cfg)
    task = cfg["task"]

    train_ds = CVDataset(f"{cfg['local_data_dir']}/train", processor, task, is_train=True)
    eval_ds  = CVDataset(f"{cfg['local_data_dir']}/eval",  processor, task, is_train=False)

    collator = make_collate_fn_detection(processor) if task == "object-detection" else None
    compute_metrics = make_compute_metrics(task, processor)

    # Smoke-test mode: 1 step, no checkpoint write, wandb off (for Phase 5.5)
    smoke = bool(cfg.get("smoke_test", False))
    if smoke:
        os.environ["WANDB_MODE"] = "disabled"

    training_args = TrainingArguments(
        output_dir=cfg["output_dir"],
        num_train_epochs=cfg["num_train_epochs"],
        per_device_train_batch_size=cfg["per_device_train_batch_size"],
        per_device_eval_batch_size=cfg["per_device_eval_batch_size"],
        learning_rate=cfg["learning_rate"],
        warmup_ratio=cfg.get("warmup_ratio", 0.1),
        weight_decay=cfg.get("weight_decay", 0.01),
        lr_scheduler_type=cfg.get("lr_scheduler_type", "cosine"),
        bf16=cfg.get("bf16", True),
        gradient_checkpointing=cfg.get("gradient_checkpointing", False),
        dataloader_num_workers=cfg.get("dataloader_num_workers", 4),
        dataloader_pin_memory=cfg.get("dataloader_pin_memory", True),
        remove_unused_columns=cfg.get("remove_unused_columns", False),
        eval_strategy="no" if smoke else cfg.get("eval_strategy", "epoch"),
        save_strategy="no" if smoke else cfg.get("save_strategy", "epoch"),
        load_best_model_at_end=False if smoke else cfg.get("load_best_model_at_end", True),
        metric_for_best_model=cfg.get("metric_for_best_model", "accuracy"),
        greater_is_better=cfg.get("greater_is_better", True),
        max_steps=1 if smoke else -1,
        report_to="none" if smoke else cfg.get("report_to", "wandb"),
        logging_steps=1 if smoke else cfg.get("logging_steps", 10),
        run_name=os.environ.get("WANDB_RUN_NAME"),
    )

    optimizer_tuple = (None, None)
    if task == "image-classification" and cfg.get("head_learning_rate"):
        head_prefixes = ("classifier.", "head.")
        head_params = [p for n, p in model.named_parameters() if n.startswith(head_prefixes) and p.requires_grad]
        backbone_params = [p for n, p in model.named_parameters() if not n.startswith(head_prefixes) and p.requires_grad]
        optimizer = torch.optim.AdamW(
            [
                {"params": backbone_params, "lr": cfg["learning_rate"]},
                {"params": head_params, "lr": cfg["head_learning_rate"]},
            ],
            weight_decay=cfg.get("weight_decay", 0.01),
        )
        optimizer_tuple = (optimizer, None)

    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=train_ds,
        eval_dataset=eval_ds,
        data_collator=collator,
        compute_metrics=compute_metrics,
        optimizers=optimizer_tuple,
    )

    trainer.train()

    if smoke:
        # Find the step-level log entry. The final entry of `log_history` is the
        # training summary which has `train_loss` (not `loss`); the step entries
        # have `loss` and `grad_norm`. Searching by key avoids that confusion.
        step_log = next(
            (l for l in reversed(trainer.state.log_history) if "loss" in l),
            None,
        )
        if step_log is None:
            raise RuntimeError("smoke test produced no step-level log entry")
        loss = step_log["loss"]
        grad_norm = step_log.get("grad_norm", 0.0)
        print(f"SMOKE: step={step_log.get('step')} loss={loss:.4f} grad_norm={grad_norm:.4f}")
        if not (loss == loss) or loss == 0.0 or grad_norm == 0.0:  # NaN-safe
            raise RuntimeError(
                f"smoke test failed: loss={loss}, grad_norm={grad_norm} — "
                "labels/masking bug; do not proceed to full training"
            )
        return

    trainer.save_model(f"{cfg['output_dir']}/final")
    processor.save_pretrained(f"{cfg['output_dir']}/final")
    print("Training complete. Model saved to", f"{cfg['output_dir']}/final")


if __name__ == "__main__":
    main()
```

---

## run_eval.py (NOT `evaluate.py` — collides with HF `evaluate` library)

```python
import argparse
import json
import os
import yaml
import evaluate as hf_evaluate
import numpy as np
import torch
from transformers import pipeline
from datasets import load_from_disk, Image as HFImage
from tqdm import tqdm


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--config", default="config.yaml")
    p.add_argument("--checkpoint", required=True)
    p.add_argument("--output", default="reports/eval_results.json")
    return p.parse_args()


def eval_classification(pipe, eval_ds, cfg):
    acc_metric = hf_evaluate.load("accuracy")
    id2label = pipe.model.config.id2label
    label2id = {v: k for k, v in id2label.items()}
    labels, preds, top5_correct = [], [], 0
    for item in tqdm(eval_ds, desc="Evaluating"):
        out = pipe(item["image"].convert("RGB"), top_k=5)
        pred_ids = [label2id.get(p["label"], 0) for p in out]
        preds.append(pred_ids[0])
        labels.append(item["label"])
        if item["label"] in pred_ids:
            top5_correct += 1
    result = acc_metric.compute(predictions=preds, references=labels)
    return {"accuracy": result["accuracy"],
            "top5_accuracy": top5_correct / len(labels),
            "n_eval": len(labels)}


def eval_detection(model, processor, eval_ds, cfg, device):
    """COCO-style mAP via torchmetrics."""
    from torchmetrics.detection import MeanAveragePrecision
    metric = MeanAveragePrecision(box_format="xyxy", iou_type="bbox")
    model.eval()
    for item in tqdm(eval_ds, desc="Evaluating"):
        image = item["image"].convert("RGB")
        w, h = image.size
        inputs = processor(images=image, return_tensors="pt").to(device)
        with torch.no_grad():
            outputs = model(**inputs)
        # Post-process to xyxy absolute coords
        results = processor.post_process_object_detection(
            outputs, target_sizes=torch.tensor([[h, w]]), threshold=0.05)[0]
        preds = [{
            "boxes": results["boxes"].cpu(),
            "scores": results["scores"].cpu(),
            "labels": results["labels"].cpu(),
        }]
        # Ground truth — convert xywh → xyxy
        gt_boxes = torch.tensor([[b[0], b[1], b[0]+b[2], b[1]+b[3]]
                                 for b in item["objects"]["bbox"]])
        gt_labels = torch.tensor(item["objects"]["category_id"])
        target = [{"boxes": gt_boxes, "labels": gt_labels}]
        metric.update(preds, target)
    out = metric.compute()
    return {
        "map_50_95": float(out["map"]),
        "map_50": float(out["map_50"]),
        "map_75": float(out["map_75"]),
        "mar_100": float(out["mar_100"]),
        "n_eval": len(eval_ds),
    }


def eval_segmentation(model, processor, eval_ds, cfg, device):
    """Mean IoU via evaluate library."""
    miou_metric = hf_evaluate.load("mean_iou")
    model.eval()
    num_labels = model.config.num_labels
    for item in tqdm(eval_ds, desc="Evaluating"):
        image = item["image"].convert("RGB")
        gt_mask = item.get("annotation") or item.get("mask")
        gt_arr = np.array(gt_mask)
        inputs = processor(images=image, return_tensors="pt").to(device)
        with torch.no_grad():
            outputs = model(**inputs)
        pred = processor.post_process_semantic_segmentation(
            outputs, target_sizes=[gt_arr.shape[-2:]])[0]
        miou_metric.add(predictions=pred.cpu().numpy(), references=gt_arr)
    result = miou_metric.compute(num_labels=num_labels, ignore_index=255, reduce_labels=False)
    return {
        "mean_iou": float(result["mean_iou"]),
        "mean_accuracy": float(result["mean_accuracy"]),
        "overall_accuracy": float(result["overall_accuracy"]),
        "n_eval": len(eval_ds),
    }


def eval_depth(model, processor, eval_ds, cfg, device):
    """AbsRel, RMSE, δ<1.25."""
    model.eval()
    abs_rels, rmses, deltas = [], [], []
    for item in tqdm(eval_ds, desc="Evaluating"):
        image = item["image"].convert("RGB")
        gt = np.array(item.get("depth") or item.get("depth_map"), dtype=np.float32)
        inputs = processor(images=image, return_tensors="pt").to(device)
        with torch.no_grad():
            outputs = model(**inputs)
        pred = outputs.predicted_depth.squeeze().cpu().numpy()
        # Resize pred to gt shape if needed
        if pred.shape != gt.shape:
            from PIL import Image as PILImage
            pred = np.array(PILImage.fromarray(pred).resize(gt.shape[::-1]))
        valid = gt > 0
        if not valid.any():
            continue
        abs_rel = np.abs(pred[valid] - gt[valid]) / gt[valid]
        rmse = np.sqrt(((pred[valid] - gt[valid])**2).mean())
        ratio = np.maximum(pred[valid] / gt[valid], gt[valid] / pred[valid])
        abs_rels.append(abs_rel.mean()); rmses.append(rmse); deltas.append((ratio < 1.25).mean())
    return {
        "abs_rel": float(np.mean(abs_rels)),
        "rmse": float(np.mean(rmses)),
        "delta_1.25": float(np.mean(deltas)),
        "n_eval": len(eval_ds),
    }


def main():
    args = parse_args()
    with open(args.config) as f:
        cfg = yaml.safe_load(f)

    task = cfg["task"]
    hf_task_map = {
        "image-classification": "image-classification",
        "object-detection": "object-detection",
        "semantic-segmentation": "image-segmentation",
        "depth-estimation": "depth-estimation",
    }

    device = "cuda" if torch.cuda.is_available() else "cpu"

    eval_ds = load_from_disk(f"{cfg['local_data_dir']}/eval")
    if "image" in eval_ds.column_names:
        eval_ds = eval_ds.cast_column("image", HFImage())

    # Load checkpoints in float32 for eval/inference. Training with `bf16=True`
    # writes checkpoints whose weights are bfloat16; image processors emit
    # float32 pixel_values. Loading the checkpoint with `torch_dtype=bfloat16`
    # causes "Input type (float) and bias type (BFloat16) should be the same"
    # at the first conv. float32 is safe for inference of any CV checkpoint.
    eval_dtype = torch.float32
    if task == "image-classification":
        pipe = pipeline("image-classification", model=args.checkpoint, device=0 if device == "cuda" else -1,
                        torch_dtype=eval_dtype, token=os.environ.get("HF_TOKEN"))
        results = eval_classification(pipe, eval_ds, cfg)
    elif task == "object-detection":
        from transformers import AutoImageProcessor, AutoModelForObjectDetection
        processor = AutoImageProcessor.from_pretrained(args.checkpoint, token=os.environ.get("HF_TOKEN"))
        model = AutoModelForObjectDetection.from_pretrained(
            args.checkpoint, torch_dtype=eval_dtype, token=os.environ.get("HF_TOKEN")).to(device)
        results = eval_detection(model, processor, eval_ds, cfg, device)
    elif task == "semantic-segmentation":
        from transformers import AutoImageProcessor, AutoModelForSemanticSegmentation
        processor = AutoImageProcessor.from_pretrained(args.checkpoint, token=os.environ.get("HF_TOKEN"))
        model = AutoModelForSemanticSegmentation.from_pretrained(
            args.checkpoint, torch_dtype=eval_dtype, token=os.environ.get("HF_TOKEN")).to(device)
        results = eval_segmentation(model, processor, eval_ds, cfg, device)
    elif task == "depth-estimation":
        from transformers import AutoImageProcessor, AutoModelForDepthEstimation
        processor = AutoImageProcessor.from_pretrained(args.checkpoint, token=os.environ.get("HF_TOKEN"))
        model = AutoModelForDepthEstimation.from_pretrained(
            args.checkpoint, torch_dtype=eval_dtype, token=os.environ.get("HF_TOKEN")).to(device)
        results = eval_depth(model, processor, eval_ds, cfg, device)
    else:
        raise ValueError(f"Unknown task: {task}")

    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    with open(args.output, "w") as f:
        json.dump(results, f, indent=2)
    print("Eval results:", json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
```

---

## inference.py

```python
import argparse
import json
import os
import yaml
import torch
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path
from transformers import pipeline


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--config", default="config.yaml")
    p.add_argument("--checkpoint", required=True)
    p.add_argument("--n_samples", type=int, default=5)
    p.add_argument("--output", default="reports/inference_samples")
    return p.parse_args()


def draw_detection(image, predictions):
    draw = ImageDraw.Draw(image)
    for pred in predictions:
        box = pred["box"]
        label = pred["label"]
        score = pred["score"]
        x1, y1, x2, y2 = box["xmin"], box["ymin"], box["xmax"], box["ymax"]
        draw.rectangle([x1, y1, x2, y2], outline="red", width=3)
        draw.text((x1, y1 - 15), f"{label} {score:.2f}", fill="red")
    return image


def main():
    args = parse_args()
    with open(args.config) as f:
        cfg = yaml.safe_load(f)

    task = cfg["task"]
    hf_task_map = {
        "image-classification": "image-classification",
        "object-detection": "object-detection",
        "semantic-segmentation": "image-segmentation",
        "depth-estimation": "depth-estimation",
    }

    # Load in float32: checkpoints trained with bf16=True save bfloat16 weights,
    # but image processors emit float32 pixel_values. Loading the model in
    # bfloat16 produces a dtype-mismatch crash on the first conv layer.
    pipe = pipeline(
        hf_task_map[task],
        model=args.checkpoint,
        device=0 if torch.cuda.is_available() else -1,
        torch_dtype=torch.float32,
        token=os.environ.get("HF_TOKEN"),
    )

    from datasets import load_from_disk, Image as HFImage
    eval_ds = load_from_disk(f"{cfg['local_data_dir']}/eval")
    if "image" in eval_ds.column_names:
        eval_ds = eval_ds.cast_column("image", HFImage())

    out_dir = Path(args.output)
    out_dir.mkdir(parents=True, exist_ok=True)

    for i in range(min(args.n_samples, len(eval_ds))):
        item = eval_ds[i]
        image = item["image"].convert("RGB")
        prediction = pipe(image)

        image.save(out_dir / f"sample_{i}_input.jpg")

        if task == "image-classification":
            top_label = prediction[0]["label"]
            top_score = prediction[0]["score"]
            draw = ImageDraw.Draw(image)
            draw.text((10, 10), f"{top_label}: {top_score:.3f}", fill="white")
            meta = {"top_predictions": prediction[:5]}

        elif task == "object-detection":
            image = draw_detection(image, prediction)
            meta = {"detections": prediction}

        elif task == "semantic-segmentation":
            # Overlay mask on image
            meta = {"segments": [{"label": s["label"], "score": s["score"]} for s in prediction]}

        elif task == "depth-estimation":
            depth_map = prediction["predicted_depth"]
            meta = {"depth_shape": list(depth_map.shape) if hasattr(depth_map, "shape") else "N/A"}

        image.save(out_dir / f"sample_{i}_pred.jpg")
        with open(out_dir / f"sample_{i}_meta.json", "w") as f:
            json.dump(meta, f, indent=2, default=str)

        print(f"Sample {i}: {meta}")


if __name__ == "__main__":
    main()
```

---

## Detection-Specific Gotchas

> **Most of the gotchas below are already pre-fixed in the templates above.**
> Listed here for documentation and so smoke-test failures can be traced to
> them quickly. Do not "re-fix" them in generated code.

**HANDLED: variable-sized `pixel_values` in the batch**
Most detection processors resize per sample, so `torch.stack` fails with
`stack expects equal size`. `make_collate_fn_detection(processor)` does a
manual `torch.nn.functional.pad` to the max H, W in the batch and constructs
the cross-attention `pixel_mask`. Version-agnostic across transformers 4.x
and 5.x (5.x's `processor.pad` was rewritten as a per-image API and no longer
takes `return_tensors`).

**HANDLED: dtype mismatch at eval/inference**
Trainer with `bf16=True` saves bfloat16 weights; image processors emit float32
pixel_values. `run_eval.py` and `inference.py` load with `torch_dtype=float32`
to keep the conv input dtype consistent.

**HANDLED: per-sample label dict has no batch dim**
The processor returns `labels` as a list-of-1 dict whose tensors lack a batch
dim (e.g. shape `(1,)` for `class_labels`). Squeezing the dict uniformly turns
those into 0-dim tensors and crashes loss compute. The template extracts
`inputs["labels"][0]` and only squeezes `pixel_values`.

**HANDLED: `timm` backbone import**
Several detection models (DETR, Conditional/Deformable DETR, etc.) use timm
ResNet backbones by default. `timm` is in `requirements.txt`. (No need to set
`revision="no_timm"` — once timm is installed, the default branch works.)

**GOTCHA: Detection datasets need `remove_unused_columns=False`**
Detection labels are dicts of variable-length tensors. The default Trainer
behavior strips unrecognized columns and breaks the labels. Always set:
```python
TrainingArguments(remove_unused_columns=False, ...)
```

**GOTCHA: bbox format — xywh vs xyxy**
Different datasets use different formats. DETR processor expects `xywh` (COCO format).
If your dataset uses `xyxy`, convert in `dataset.py`:
```python
# xyxy → xywh
x1, y1, x2, y2 = bbox
bbox_xywh = [x1, y1, x2 - x1, y2 - y1]
```

**GOTCHA: `dataloader_pin_memory=False` for detection**
Detection collators use variable-length labels (list of dicts). Pin memory requires uniform tensors.
Set `dataloader_pin_memory: false` in `config.yaml` for detection tasks.

**Recommended detection models (small, fast to train):**
- `ustc-community/dfine-small-coco` — D-FINE small, COCO pretrained, 10.4M params
- `hustvl/yolos-tiny` — YOLOS tiny, 6.5M params, fast inference
- `facebook/detr-resnet-50` — classic DETR, widely tested

**Recommended segmentation models:**
- `nvidia/segformer-b0-finetuned-ade-512-512` — SegFormer B0, 3.7M params
- `nvidia/segformer-b2-finetuned-cityscapes-1024-1024` — B2, 24.7M params

**Recommended classification models:**
- `google/vit-base-patch16-224` — ViT-Base, 86M params, strong baseline
- `facebook/convnext-tiny-224` — ConvNeXt-Tiny, 28M params, efficient
- `microsoft/swin-tiny-patch4-window7-224` — Swin-Tiny, 28M params

---

## Per-Task Metrics Summary

| Task | Primary | Eval library | Notes |
|------|---------|-------------|-------|
| classification | top-1 accuracy | `evaluate.load("accuracy")` | Also track top-5 |
| object-detection | mAP@0.5:0.95 | `torchmetrics.detection.MeanAveragePrecision` | COCO-style |
| semantic-seg | mean IoU | `evaluate.load("mean_iou")` | ignore_index=255 |
| instance-seg | mask AP | `torchmetrics` | panoptic quality optional |
| depth-estimation | AbsRel | manual | Also RMSE, δ<1.25 |
