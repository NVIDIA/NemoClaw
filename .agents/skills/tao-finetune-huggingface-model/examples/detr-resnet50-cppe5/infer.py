# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Run DETR inference on N samples; save input + bbox overlay + meta.json."""
import argparse, json, os
from pathlib import Path

import torch, yaml
from datasets import load_from_disk
from PIL import ImageDraw, ImageFont
from transformers import AutoImageProcessor, AutoModelForObjectDetection


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--n_samples", type=int, default=5)
    ap.add_argument("--output", required=True)
    ap.add_argument("--threshold", type=float, default=0.3)
    args = ap.parse_args()
    cfg = yaml.safe_load(open(args.config)); token = os.environ.get("HF_TOKEN")
    out = Path(args.output); out.mkdir(parents=True, exist_ok=True)

    ip = AutoImageProcessor.from_pretrained(args.checkpoint, token=token,
                                            do_resize=True,
                                            size={"shortest_edge": 480, "longest_edge": 640},
                                            do_pad=True)
    model = AutoModelForObjectDetection.from_pretrained(args.checkpoint, token=token).eval().cuda()
    ds = load_from_disk("data/eval")
    id2label = {i: n for i, n in enumerate(cfg["label_names"])}
    colors = [(230,25,75), (60,180,75), (255,225,25), (0,130,200), (245,130,48)]

    for i, idx in enumerate(range(min(args.n_samples, len(ds)))):
        ex = ds[idx]; img = ex["image"].convert("RGB")
        inputs = ip(images=img, return_tensors="pt").to("cuda")
        with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):
            outputs = model(**inputs)
        h, w = img.size[1], img.size[0]
        post = ip.post_process_object_detection(
            outputs, threshold=args.threshold,
            target_sizes=torch.tensor([[h, w]]).cuda())[0]

        img.save(out / f"sample_{i}_input.jpg", quality=90)
        ov = img.copy(); draw = ImageDraw.Draw(ov)
        try: font = ImageFont.load_default()
        except Exception: font = None

        preds = []
        for score, lbl, box in zip(post["scores"].cpu().tolist(),
                                    post["labels"].cpu().tolist(),
                                    post["boxes"].cpu().tolist()):
            name = id2label.get(lbl, str(lbl))
            color = colors[lbl % len(colors)]
            x1, y1, x2, y2 = [int(v) for v in box]
            draw.rectangle([(x1,y1), (x2,y2)], outline=color, width=3)
            draw.text((x1, max(0, y1-12)), f"{name}:{score:.2f}", fill=color, font=font)
            preds.append({"label": name, "score": float(score), "bbox_xyxy": [x1,y1,x2,y2]})

        gt = []
        for bbox, c in zip(ex["objects"]["bbox"], ex["objects"]["category"]):
            x, y, bw, bh = bbox
            draw.rectangle([(x,y), (x+bw,y+bh)], outline=(255,255,255), width=1)
            gt.append({"label": id2label.get(c, str(c)), "bbox_xywh": [x, y, bw, bh]})

        ov.save(out / f"sample_{i}_pred.jpg", quality=90)
        (out / f"sample_{i}_meta.json").write_text(json.dumps({
            "index": idx, "predictions": preds, "ground_truth": gt,
        }, indent=2))
        print(f"[infer] sample_{i}: {len(preds)} preds vs {len(gt)} gt (threshold={args.threshold})")


if __name__ == "__main__":
    main()
