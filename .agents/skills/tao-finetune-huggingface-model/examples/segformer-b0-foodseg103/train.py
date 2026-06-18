# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""SegFormer (MiT-B0) fine-tune on FoodSeg103 (semantic-segmentation).

Recipe from HF repo run_semantic_segmentation.py + task doc.
Key: AutoModelForSemanticSegmentation + SegFormer-size-aware Jaccard loss (via Trainer default),
     resize to 512x512, num_labels=104 (103 food + background), ignore_mismatched_sizes.
"""
import argparse, os
from pathlib import Path
from functools import partial

import numpy as np, torch, yaml
from datasets import load_from_disk
from transformers import (
    AutoImageProcessor, AutoModelForSemanticSegmentation,
    Trainer, TrainingArguments,
)
from torchvision.transforms import (
    ColorJitter, Compose, Normalize, ToTensor, RandomHorizontalFlip,
)
from PIL import Image


def build_processor(cfg, token):
    ip = AutoImageProcessor.from_pretrained(cfg["model_id"], token=token,
                                            do_reduce_labels=False)
    # Ensure fixed size
    ip.size = {"height": 512, "width": 512}
    return ip


def make_transforms(ip, is_train):
    norm = Normalize(mean=ip.image_mean, std=ip.image_std)
    size = 512
    def tfm(ex):
        images, masks = [], []
        for img, mask in zip(ex[IMAGE_COL], ex[LABEL_COL]):
            img = img.convert("RGB").resize((size, size), Image.BILINEAR)
            m = mask.resize((size, size), Image.NEAREST)
            if is_train and np.random.rand() < 0.5:
                img = img.transpose(Image.FLIP_LEFT_RIGHT); m = m.transpose(Image.FLIP_LEFT_RIGHT)
            images.append(norm(ToTensor()(img)))
            masks.append(torch.as_tensor(np.array(m), dtype=torch.long))
        ex["pixel_values"] = images
        ex["labels"] = masks
        # drop originals
        ex.pop(IMAGE_COL, None); ex.pop(LABEL_COL, None)
        ex.pop("classes_on_image", None); ex.pop("id", None)
        return ex
    return tfm


IMAGE_COL = "image"   # populated from config in main()
LABEL_COL = "label"


def compute_metrics(eval_pred, num_labels, ignore_index=255):
    """Compute mean IoU from logits + masks. Does not assume torchmetrics."""
    preds, labels = eval_pred.predictions, eval_pred.label_ids
    # preds: [B, C, H/4, W/4] — need to upsample to mask size
    preds_t = torch.as_tensor(preds)
    labels_t = torch.as_tensor(labels)
    H, W = labels_t.shape[-2:]
    preds_up = torch.nn.functional.interpolate(preds_t, size=(H, W), mode="bilinear", align_corners=False)
    pred_cls = preds_up.argmax(dim=1)

    # Build confusion matrix
    valid = labels_t != ignore_index
    pred_flat = pred_cls[valid].flatten()
    label_flat = labels_t[valid].flatten()
    k = (label_flat * num_labels + pred_flat).long()
    bincount = torch.bincount(k, minlength=num_labels ** 2).reshape(num_labels, num_labels).float()
    # Per-class IoU
    intersection = torch.diag(bincount)
    gt_per_class = bincount.sum(1)
    pred_per_class = bincount.sum(0)
    union = gt_per_class + pred_per_class - intersection
    iou = intersection / union.clamp(min=1)
    present = gt_per_class > 0
    miou = iou[present].mean().item() if present.any() else 0.0
    acc = (pred_cls[valid] == labels_t[valid]).float().mean().item()
    return {"mean_iou": float(miou), "pixel_accuracy": float(acc)}


def main():
    global IMAGE_COL, LABEL_COL
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--smoke", action="store_true")
    ap.add_argument("--max_steps", type=int, default=None)
    args = ap.parse_args()
    cfg = yaml.safe_load(open(args.config))
    token = os.environ.get("HF_TOKEN")

    IMAGE_COL = cfg.get("image_column", "image")
    LABEL_COL = cfg.get("label_column", "label")

    ds_tr = load_from_disk("data/train"); ds_ev = load_from_disk("data/eval")
    num_labels = int(cfg["num_labels"])

    ip = build_processor(cfg, token)
    ds_tr = ds_tr.with_transform(make_transforms(ip, is_train=True))
    ds_ev = ds_ev.with_transform(make_transforms(ip, is_train=False))

    model = AutoModelForSemanticSegmentation.from_pretrained(
        cfg["model_id"], num_labels=num_labels,
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
        weight_decay=cfg.get("weight_decay", 0.0),
        bf16=cfg.get("bf16", True),
        dataloader_num_workers=cfg.get("dataloader_num_workers", 4),
        load_best_model_at_end=cfg.get("load_best_model_at_end", True),
        metric_for_best_model=cfg.get("metric_for_best_model", "eval_loss"),
        greater_is_better=cfg.get("greater_is_better", False),
        report_to=("none" if args.smoke else cfg.get("report_to", "wandb")),
        run_name=cfg.get("model_short_name", "run"),
        logging_steps=cfg.get("logging_steps", 10),
        logging_first_step=cfg.get("logging_first_step", True),
        logging_strategy=cfg.get("logging_strategy", "steps"),
        disable_tqdm=cfg.get("disable_tqdm", True),
        push_to_hub=False,
    )
    if args.max_steps is not None:
        kw["max_steps"] = args.max_steps
        kw["eval_strategy"] = "no"; kw["save_strategy"] = "no"; kw["load_best_model_at_end"] = False

    def data_collator(batch):
        return {
            "pixel_values": torch.stack([b["pixel_values"] for b in batch]),
            "labels": torch.stack([b["labels"] for b in batch]),
        }

    trainer = Trainer(
        model=model, args=TrainingArguments(**kw),
        data_collator=data_collator,
        train_dataset=ds_tr, eval_dataset=ds_ev,
        processing_class=ip,
        compute_metrics=partial(compute_metrics, num_labels=num_labels),
    )
    trainer.train()

    if not args.smoke:
        final = Path(cfg["output_dir"]) / "final"
        trainer.save_model(str(final)); ip.save_pretrained(str(final))
        print(f"[train] final checkpoint -> {final}")


if __name__ == "__main__":
    main()
