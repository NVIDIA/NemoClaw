# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Inference on N held-out samples; save input + overlay + meta.json per sample."""
import argparse, json, os
from pathlib import Path

import torch, yaml
from datasets import load_from_disk
from PIL import ImageDraw, ImageFont
from transformers import AutoImageProcessor, AutoModelForImageClassification


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--n_samples", type=int, default=5)
    ap.add_argument("--output", required=True)
    args = ap.parse_args()
    cfg = yaml.safe_load(open(args.config)); token = os.environ.get("HF_TOKEN")
    out = Path(args.output); out.mkdir(parents=True, exist_ok=True)

    ip = AutoImageProcessor.from_pretrained(args.checkpoint, token=token)
    model = AutoModelForImageClassification.from_pretrained(args.checkpoint, token=token).eval().cuda()

    label_col = cfg.get("label_column", "label")
    ds = load_from_disk("data/eval"); names = ds.features[label_col].names

    for i, idx in enumerate(range(min(args.n_samples, len(ds)))):
        ex = ds[idx]
        img = ex["image"].convert("RGB")
        inputs = ip(images=img, return_tensors="pt").to("cuda")
        with torch.inference_mode():
            logits = model(**inputs).logits[0].float().cpu()
        probs = torch.softmax(logits, dim=-1).tolist()
        pred_i = int(torch.argmax(logits).item()); gt_i = int(ex[label_col])

        img.save(out / f"sample_{i}_input.jpg", quality=90)
        ov = img.copy(); d = ImageDraw.Draw(ov)
        corr = "✓" if pred_i == gt_i else "✗"
        text = f"GT: {names[gt_i]}\nPred: {names[pred_i]} ({probs[pred_i]*100:.1f}%) {corr}"
        d.rectangle([(0,0), (ov.width, 60)], fill=(0,0,0,180))
        try: font = ImageFont.load_default()
        except Exception: font = None
        d.text((8, 6), text, fill=(255,255,255), font=font)
        ov.save(out / f"sample_{i}_pred.jpg", quality=90)
        (out / f"sample_{i}_meta.json").write_text(json.dumps({
            "index": idx, "ground_truth": names[gt_i], "prediction": names[pred_i],
            "probabilities": {n:p for n,p in zip(names, probs)}, "correct": pred_i == gt_i,
        }, indent=2))
        print(f"[infer] sample_{i}: GT={names[gt_i]} pred={names[pred_i]} conf={probs[pred_i]:.3f} {corr}")


if __name__ == "__main__":
    main()
