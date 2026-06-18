# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Eval SegFormer on FoodSeg103 eval split — mean IoU + pixel accuracy."""
import argparse, json, os
from pathlib import Path
import numpy as np, torch, yaml
from PIL import Image
from datasets import load_from_disk
from transformers import AutoImageProcessor, AutoModelForSemanticSegmentation


@torch.inference_mode()
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--output", required=True)
    args = ap.parse_args()
    cfg = yaml.safe_load(open(args.config)); token = os.environ.get("HF_TOKEN")
    num_labels = int(cfg["num_labels"])

    ip = AutoImageProcessor.from_pretrained(args.checkpoint, token=token)
    ip.size = {"height": 512, "width": 512}

    is_base = args.checkpoint == cfg["model_id"]
    kw = dict(token=token)
    if is_base:
        kw.update(num_labels=num_labels, ignore_mismatched_sizes=True)
    model = AutoModelForSemanticSegmentation.from_pretrained(args.checkpoint, **kw).cuda().eval()

    ds = load_from_disk("data/eval")
    IC = cfg.get("image_column", "image"); LC = cfg.get("label_column", "label")

    from torchvision.transforms import Normalize, ToTensor
    norm = Normalize(mean=ip.image_mean, std=ip.image_std)

    bincount = torch.zeros(num_labels, num_labels, dtype=torch.float32)
    for ex in ds:
        img = ex[IC].convert("RGB").resize((512, 512), Image.BILINEAR)
        mask = ex[LC].resize((512, 512), Image.NEAREST)
        x = norm(ToTensor()(img)).unsqueeze(0).cuda()
        with torch.autocast("cuda", dtype=torch.bfloat16, enabled=cfg.get("bf16", True)):
            out = model(pixel_values=x).logits
        out = torch.nn.functional.interpolate(out, size=(512, 512), mode="bilinear", align_corners=False)
        pred = out.argmax(dim=1)[0].cpu()
        gt = torch.as_tensor(np.array(mask), dtype=torch.long)
        valid = gt != 255
        pf, gf = pred[valid].flatten(), gt[valid].flatten()
        k = (gf * num_labels + pf).long()
        bincount += torch.bincount(k, minlength=num_labels**2).reshape(num_labels, num_labels).float()

    intersection = torch.diag(bincount)
    gt_per_class = bincount.sum(1); pred_per_class = bincount.sum(0)
    union = gt_per_class + pred_per_class - intersection
    iou = (intersection / union.clamp(min=1))
    present = gt_per_class > 0
    miou = iou[present].mean().item() if present.any() else 0.0
    total_correct = bincount.diag().sum().item(); total = bincount.sum().item()
    pix_acc = total_correct / max(total, 1)

    out = {"checkpoint": args.checkpoint, "n_eval": len(ds),
           "mean_iou": float(miou), "pixel_accuracy": float(pix_acc),
           "accuracy": float(miou)}   # primary = mIoU
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(out, indent=2))
    print(f"[eval] mean_iou={miou:.4f} pixel_acc={pix_acc:.4f} n={len(ds)}")


if __name__ == "__main__":
    main()
