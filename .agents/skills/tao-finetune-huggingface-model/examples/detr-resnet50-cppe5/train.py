# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""DETR fine-tune on CPPE-5 (adapted from HF repo run_object_detection.py)."""
import argparse, os
from functools import partial
from pathlib import Path
from typing import Any

import albumentations as A
import numpy as np
import torch, yaml
from datasets import load_from_disk
from torchmetrics.detection.mean_ap import MeanAveragePrecision
from transformers import (
    AutoImageProcessor, AutoModelForObjectDetection,
    Trainer, TrainingArguments,
)


def format_image_annotations_as_coco(image_id, categories, areas, bboxes):
    """Format (image_id, categories, areas, bboxes) as a COCO annotation dict for DETR preprocessing."""
    annotations = [
        {"image_id": image_id, "category_id": cat, "iscrowd": 0, "area": area,
         "bbox": list(bbox)}  # expected: [x, y, w, h]
        for cat, area, bbox in zip(categories, areas, bboxes)
    ]
    return {"image_id": image_id, "annotations": annotations}


def augment_and_transform_batch(examples, transform, image_processor):
    pixel_values, labels = [], []
    for img_id, img, objs in zip(examples["image_id"], examples["image"], examples["objects"]):
        image = np.array(img.convert("RGB"))
        out = transform(image=image, bboxes=objs["bbox"], category_ids=objs["category"])
        formatted = format_image_annotations_as_coco(
            img_id, out["category_ids"], [b[2] * b[3] for b in out["bboxes"]], out["bboxes"])
        encoded = image_processor(images=out["image"], annotations=formatted, return_tensors="pt")
        pixel_values.append(encoded["pixel_values"][0])
        labels.append(encoded["labels"][0])
    return {"pixel_values": pixel_values, "labels": labels}


def make_collate_fn(image_processor):
    def collate_fn(batch):
        pixel_values = [torch.as_tensor(b["pixel_values"]) for b in batch]
        encoding = image_processor.pad(pixel_values, return_tensors="pt")
        labels = [{k: torch.as_tensor(v) for k, v in b["labels"].items()} for b in batch]
        return {"pixel_values": encoding["pixel_values"], "pixel_mask": encoding["pixel_mask"], "labels": labels}
    return collate_fn


@torch.no_grad()
def compute_metrics(eval_pred, image_processor, id2label, threshold=0.0):
    """Replicate HF repo compute_metrics: post-process + torchmetrics MeanAveragePrecision."""
    predictions, targets = eval_pred.predictions, eval_pred.label_ids
    # predictions is tuple of (logits, pred_boxes) or ModelOutput-like with keys
    if isinstance(predictions, tuple):
        # SequenceClassifierOutput-style — (loss?, logits, pred_boxes, ...)
        # DETR output: [loss, logits, pred_boxes, auxiliary_outputs, last_hidden, ...]
        # Trainer returns .predictions as a tuple in the order of the output dataclass.
        # We pick logits and pred_boxes by shape: logits [B, Q, C+1], boxes [B, Q, 4]
        logits = None; boxes = None
        for p in predictions:
            if p.ndim == 3 and p.shape[-1] == 4:
                boxes = p
            elif p.ndim == 3 and p.shape[-1] > 4:
                logits = p
        if logits is None or boxes is None:
            return {"map": 0.0}
    else:
        logits = predictions.logits
        boxes = predictions.pred_boxes

    image_sizes = []
    post_targets = []
    for target in targets:
        h = target["orig_size"][0].item() if hasattr(target["orig_size"], "item") else int(target["orig_size"][0])
        w = target["orig_size"][1].item() if hasattr(target["orig_size"], "item") else int(target["orig_size"][1])
        image_sizes.append(torch.tensor([h, w]))
        boxes_xyxy = target["boxes"].clone()
        # target boxes are [cx, cy, w, h] normalized; convert to xyxy in pixels for torchmetrics
        cx, cy, bw, bh = boxes_xyxy.unbind(-1)
        x1 = (cx - bw / 2) * w; y1 = (cy - bh / 2) * h
        x2 = (cx + bw / 2) * w; y2 = (cy + bh / 2) * h
        post_targets.append({"boxes": torch.stack([x1, y1, x2, y2], dim=-1),
                             "labels": target["class_labels"]})
    image_sizes = torch.stack(image_sizes)

    outputs = type("O", (), {"logits": torch.tensor(logits), "pred_boxes": torch.tensor(boxes)})()
    post_preds = image_processor.post_process_object_detection(
        outputs, threshold=threshold, target_sizes=image_sizes)

    metric = MeanAveragePrecision(box_format="xyxy", class_metrics=True)
    metric.update(post_preds, post_targets)
    m = metric.compute()
    out = {"map": float(m["map"].item()), "map_50": float(m["map_50"].item()),
           "map_75": float(m["map_75"].item())}
    # per-class
    if "classes" in m and "map_per_class" in m:
        for cls_i, ap in zip(m["classes"].tolist(), m["map_per_class"].tolist()):
            out[f"map_{id2label.get(int(cls_i), cls_i)}"] = float(ap)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--smoke", action="store_true")
    ap.add_argument("--max_steps", type=int, default=None)
    args = ap.parse_args()
    cfg = yaml.safe_load(open(args.config))
    token = os.environ.get("HF_TOKEN")

    ds_tr = load_from_disk("data/train"); ds_ev = load_from_disk("data/eval")
    label_names = cfg["label_names"]
    id2label = {i: n for i, n in enumerate(label_names)}
    label2id = {n: i for i, n in id2label.items()}

    ip = AutoImageProcessor.from_pretrained(cfg["model_id"], token=token, do_resize=True,
                                            size={"shortest_edge": 480, "longest_edge": 640},
                                            do_pad=False)

    # Albumentations transforms (COCO format bboxes); filter_invalid_bboxes drops zero-area
    # boxes that clipping can collapse, which CPPE-5 has a handful of.
    train_tx = A.Compose([
        A.Perspective(p=0.1),
        A.HorizontalFlip(p=0.5),
        A.RandomBrightnessContrast(p=0.5),
        A.HueSaturationValue(p=0.1),
    ], bbox_params=A.BboxParams(format="coco", label_fields=["category_ids"], clip=True,
                                min_area=1, filter_invalid_bboxes=True))
    eval_tx = A.Compose([A.NoOp()],
        bbox_params=A.BboxParams(format="coco", label_fields=["category_ids"], clip=True,
                                 min_area=1, filter_invalid_bboxes=True))

    ds_tr = ds_tr.with_transform(partial(augment_and_transform_batch,
                                          transform=train_tx, image_processor=ip))
    ds_ev = ds_ev.with_transform(partial(augment_and_transform_batch,
                                          transform=eval_tx, image_processor=ip))

    model = AutoModelForObjectDetection.from_pretrained(
        cfg["model_id"], num_labels=len(label_names),
        id2label=id2label, label2id=label2id,
        ignore_mismatched_sizes=cfg.get("ignore_mismatched_sizes", True),
        token=token,
    )

    os.environ.setdefault("WANDB_PROJECT", "tao-hf-finetune-5tasks")
    if args.smoke: os.environ["WANDB_MODE"] = "disabled"

    kw = dict(
        output_dir=cfg["output_dir"], remove_unused_columns=cfg.get("remove_unused_columns", False),
        eval_strategy=cfg.get("eval_strategy", "epoch"),
        save_strategy=cfg.get("save_strategy", "epoch"),
        save_total_limit=cfg.get("save_total_limit", 1),
        learning_rate=cfg["learning_rate"],
        per_device_train_batch_size=cfg["per_device_train_batch_size"],
        per_device_eval_batch_size=cfg["per_device_eval_batch_size"],
        gradient_accumulation_steps=cfg["gradient_accumulation_steps"],
        num_train_epochs=cfg["num_train_epochs"],
        warmup_ratio=cfg.get("warmup_ratio", 0.1),
        weight_decay=cfg.get("weight_decay", 1e-4),
        bf16=cfg.get("bf16", True),
        dataloader_num_workers=cfg.get("dataloader_num_workers", 4),
        load_best_model_at_end=cfg.get("load_best_model_at_end", True),
        metric_for_best_model=cfg.get("metric_for_best_model", "eval_map"),
        greater_is_better=cfg.get("greater_is_better", True),
        report_to=("none" if args.smoke else cfg.get("report_to", "wandb")),
        run_name=cfg.get("model_short_name", "run"),
        logging_steps=cfg.get("logging_steps", 10),
        logging_first_step=cfg.get("logging_first_step", True),
        logging_strategy=cfg.get("logging_strategy", "steps"),
        disable_tqdm=cfg.get("disable_tqdm", True),
        push_to_hub=False,
        label_names=["labels"],
    )
    if args.max_steps is not None:
        kw["max_steps"] = args.max_steps
        kw["eval_strategy"] = "no"; kw["save_strategy"] = "no"; kw["load_best_model_at_end"] = False

    # Use eval loss as selection signal — mAP is computed standalone via run_eval.py.
    trainer = Trainer(
        model=model, args=TrainingArguments(**kw),
        data_collator=make_collate_fn(ip),
        train_dataset=ds_tr, eval_dataset=ds_ev,
        processing_class=ip,
    )
    trainer.train()

    if not args.smoke:
        final = Path(cfg["output_dir"]) / "final"
        trainer.save_model(str(final)); ip.save_pretrained(str(final))
        print(f"[train] final checkpoint -> {final}")


if __name__ == "__main__":
    main()
