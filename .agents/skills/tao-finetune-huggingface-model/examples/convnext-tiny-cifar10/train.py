# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""ConvNeXt-tiny fine-tune on CIFAR-10 (subset).

Recipe from:
  - HF repo run_image_classification.py (examples/pytorch/image-classification/)
  - HF task doc (tasks/image_classification.md)
  - ConvNeXt paper arxiv:2201.03545

Key kwargs:
  AutoModelForImageClassification(num_labels=10, id2label=..., ignore_mismatched_sizes=True)
  Transforms: RandomResizedCrop + HFlip + ToTensor + Normalize (train); Resize + CenterCrop (eval)
  Collator: DefaultDataCollator; remove_unused_columns=False
  Metric: accuracy (evaluate.load)
"""
import argparse, os
from pathlib import Path

import evaluate, numpy as np, torch, yaml
from datasets import load_from_disk
from transformers import (
    AutoImageProcessor, AutoModelForImageClassification,
    DefaultDataCollator, Trainer, TrainingArguments,
)
from torchvision.transforms import (
    CenterCrop, Compose, Normalize, RandomHorizontalFlip, RandomResizedCrop, Resize, ToTensor,
)


def build_transforms(ip):
    norm = Normalize(mean=ip.image_mean, std=ip.image_std)
    size_info = ip.size
    size = size_info.get("shortest_edge") or (size_info["height"], size_info["width"])
    size_t = (size, size) if isinstance(size, int) else size
    train_tx = Compose([RandomResizedCrop(size), RandomHorizontalFlip(), ToTensor(), norm])
    eval_tx = Compose([Resize(size_t), CenterCrop(size_t), ToTensor(), norm])
    return train_tx, eval_tx


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--smoke", action="store_true")
    ap.add_argument("--max_steps", type=int, default=None)
    args = ap.parse_args()
    cfg = yaml.safe_load(open(args.config))
    token = os.environ.get("HF_TOKEN")

    ds_tr = load_from_disk("data/train"); ds_ev = load_from_disk("data/eval")
    label_col = cfg.get("label_column", "label")
    names = ds_tr.features[label_col].names
    id2label = {i: n for i, n in enumerate(names)}
    label2id = {n: i for i, n in id2label.items()}
    print(f"[train] {len(names)} labels: {names}")

    ip = AutoImageProcessor.from_pretrained(cfg["model_id"], token=token)
    train_tx, eval_tx = build_transforms(ip)

    def apply_train(ex):
        ex["pixel_values"] = [train_tx(img.convert("RGB")) for img in ex["image"]]
        ex.pop("image", None)
        return ex
    def apply_eval(ex):
        ex["pixel_values"] = [eval_tx(img.convert("RGB")) for img in ex["image"]]
        ex.pop("image", None)
        return ex
    ds_tr = ds_tr.with_transform(apply_train)
    ds_ev = ds_ev.with_transform(apply_eval)

    # Normalize label column name to "labels" for Trainer
    if label_col != "labels":
        ds_tr = ds_tr.rename_column(label_col, "labels")
        ds_ev = ds_ev.rename_column(label_col, "labels")

    model = AutoModelForImageClassification.from_pretrained(
        cfg["model_id"],
        num_labels=len(names), id2label=id2label, label2id=label2id,
        ignore_mismatched_sizes=cfg.get("ignore_mismatched_sizes", True),
        token=token,
    )

    accuracy = evaluate.load("accuracy")
    def compute_metrics(p):
        return accuracy.compute(predictions=np.argmax(p.predictions, axis=1), references=p.label_ids)

    os.environ.setdefault("WANDB_PROJECT", "tao-hf-finetune-5tasks")
    if args.smoke: os.environ["WANDB_MODE"] = "disabled"

    kw = dict(
        output_dir=cfg["output_dir"],
        remove_unused_columns=cfg.get("remove_unused_columns", False),
        eval_strategy=cfg.get("eval_strategy", "epoch"),
        save_strategy=cfg.get("save_strategy", "epoch"),
        save_total_limit=cfg.get("save_total_limit", 1),
        learning_rate=cfg["learning_rate"],
        per_device_train_batch_size=cfg["per_device_train_batch_size"],
        per_device_eval_batch_size=cfg["per_device_eval_batch_size"],
        gradient_accumulation_steps=cfg["gradient_accumulation_steps"],
        num_train_epochs=cfg["num_train_epochs"],
        warmup_ratio=cfg.get("warmup_ratio", 0.1),
        weight_decay=cfg.get("weight_decay", 0.01),
        bf16=cfg.get("bf16", True),
        gradient_checkpointing=cfg.get("gradient_checkpointing", False),
        dataloader_num_workers=cfg.get("dataloader_num_workers", 4),
        load_best_model_at_end=cfg.get("load_best_model_at_end", True),
        metric_for_best_model=cfg.get("metric_for_best_model", "accuracy"),
        greater_is_better=cfg.get("greater_is_better", True),
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

    trainer = Trainer(
        model=model, args=TrainingArguments(**kw),
        data_collator=DefaultDataCollator(),
        train_dataset=ds_tr, eval_dataset=ds_ev,
        processing_class=ip, compute_metrics=compute_metrics,
    )
    trainer.train()

    if not args.smoke:
        final = Path(cfg["output_dir"]) / "final"
        trainer.save_model(str(final)); ip.save_pretrained(str(final))
        print(f"[train] final checkpoint -> {final}")


if __name__ == "__main__":
    main()
