# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Evaluate a ConvNeXt checkpoint on data/eval Arrow split."""
import argparse, json, os
from pathlib import Path

import evaluate, numpy as np, torch, yaml
from datasets import load_from_disk
from transformers import AutoImageProcessor, AutoModelForImageClassification
from torchvision.transforms import CenterCrop, Compose, Normalize, Resize, ToTensor


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--output", required=True)
    args = ap.parse_args()
    cfg = yaml.safe_load(open(args.config)); token = os.environ.get("HF_TOKEN")
    label_col = cfg.get("label_column", "label")
    device = "cuda" if torch.cuda.is_available() else "cpu"

    ip = AutoImageProcessor.from_pretrained(args.checkpoint, token=token)
    ds = load_from_disk("data/eval")
    names = ds.features[label_col].names

    is_base = args.checkpoint == cfg["model_id"]
    kw = dict(token=token)
    if is_base:
        kw.update(num_labels=len(names), id2label={i:n for i,n in enumerate(names)},
                  label2id={n:i for i,n in enumerate(names)}, ignore_mismatched_sizes=True)
    model = AutoModelForImageClassification.from_pretrained(args.checkpoint, **kw).to(device).eval()

    size_info = ip.size
    size = size_info.get("shortest_edge") or (size_info["height"], size_info["width"])
    size_t = (size, size) if isinstance(size, int) else size
    tx = Compose([Resize(size_t), CenterCrop(size_t), ToTensor(),
                  Normalize(mean=ip.image_mean, std=ip.image_std)])

    preds, refs = [], []
    with torch.inference_mode():
        batch, labels = [], []
        B = 64
        for i, ex in enumerate(ds):
            batch.append(tx(ex["image"].convert("RGB"))); labels.append(ex[label_col])
            if len(batch) == B or i == len(ds) - 1:
                x = torch.stack(batch).to(device)  # keep fp32 — model weights are fp32, avoid bias dtype mismatch
                with torch.autocast(device_type="cuda", dtype=torch.bfloat16, enabled=cfg.get("bf16", True)):
                    logits = model(pixel_values=x).logits
                logits = logits.float().cpu().numpy()
                preds.extend(np.argmax(logits, axis=1).tolist()); refs.extend(labels)
                batch, labels = [], []

    acc = evaluate.load("accuracy").compute(predictions=preds, references=refs)
    pc = {}
    for ci, cn in enumerate(names):
        cp = [p for p, r in zip(preds, refs) if r == ci]
        if cp: pc[cn] = sum(1 for p in cp if p == ci) / len(cp)

    out = {"checkpoint": args.checkpoint, "n_eval": len(refs),
           "accuracy": acc["accuracy"], "per_class_accuracy": pc}
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(out, indent=2))
    print(f"[eval] accuracy={out['accuracy']:.4f} n={len(refs)}")


if __name__ == "__main__":
    main()
