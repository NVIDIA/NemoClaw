# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Run SegFormer on 5 samples; save input + predicted mask overlay + GT mask overlay + meta."""
import argparse, json, os, colorsys
from pathlib import Path
import numpy as np, torch, yaml
from PIL import Image
from datasets import load_from_disk
from transformers import AutoImageProcessor, AutoModelForSemanticSegmentation
from torchvision.transforms import Normalize, ToTensor


def palette(n):
    return [tuple(int(c*255) for c in colorsys.hsv_to_rgb(i/n, 0.6, 0.9)) for i in range(n)]


def colorize(mask_np, n):
    pal = palette(n)
    h, w = mask_np.shape
    out = np.zeros((h, w, 3), dtype=np.uint8)
    for cid in np.unique(mask_np):
        if 0 <= cid < n: out[mask_np == cid] = pal[cid]
    return Image.fromarray(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--n_samples", type=int, default=5)
    ap.add_argument("--output", required=True)
    args = ap.parse_args()
    cfg = yaml.safe_load(open(args.config)); token = os.environ.get("HF_TOKEN")
    out = Path(args.output); out.mkdir(parents=True, exist_ok=True)
    num_labels = int(cfg["num_labels"])

    ip = AutoImageProcessor.from_pretrained(args.checkpoint, token=token)
    ip.size = {"height": 512, "width": 512}
    model = AutoModelForSemanticSegmentation.from_pretrained(args.checkpoint, token=token).eval().cuda()
    norm = Normalize(mean=ip.image_mean, std=ip.image_std)

    ds = load_from_disk("data/eval")
    IC = cfg.get("image_column", "image"); LC = cfg.get("label_column", "label")

    for i, idx in enumerate(range(min(args.n_samples, len(ds)))):
        ex = ds[idx]; img = ex[IC].convert("RGB").resize((512, 512), Image.BILINEAR)
        mask = ex[LC].resize((512, 512), Image.NEAREST)
        x = norm(ToTensor()(img)).unsqueeze(0).cuda()
        with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):
            o = model(pixel_values=x).logits
        o = torch.nn.functional.interpolate(o, size=(512, 512), mode="bilinear", align_corners=False)
        pred = o.argmax(dim=1)[0].cpu().numpy().astype(np.uint8)

        pred_color = colorize(pred, num_labels)
        gt_color = colorize(np.array(mask, dtype=np.uint8), num_labels)

        img.save(out / f"sample_{i}_input.jpg", quality=90)
        # Side-by-side: GT | Pred
        side = Image.new("RGB", (gt_color.width + pred_color.width, max(gt_color.height, pred_color.height)), (0,0,0))
        side.paste(gt_color, (0, 0)); side.paste(pred_color, (gt_color.width, 0))
        side.save(out / f"sample_{i}_pred.jpg", quality=90)

        unique_pred = np.unique(pred).tolist()
        unique_gt = np.unique(np.array(mask)).tolist()
        (out / f"sample_{i}_meta.json").write_text(json.dumps({
            "index": idx, "pred_classes_present": unique_pred,
            "gt_classes_present": unique_gt,
            "pixel_accuracy": float((pred == np.array(mask)).mean()),
        }, indent=2))
        print(f"[infer] sample_{i}: pred_classes={len(unique_pred)} gt_classes={len(unique_gt)} pix_acc={float((pred == np.array(mask)).mean()):.3f}")


if __name__ == "__main__":
    main()
