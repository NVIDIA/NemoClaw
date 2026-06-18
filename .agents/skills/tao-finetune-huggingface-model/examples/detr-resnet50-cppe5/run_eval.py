# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Standalone eval: run DETR on data/eval, compute mAP."""
import argparse, json, os
from pathlib import Path

import numpy as np, torch, yaml
from datasets import load_from_disk
from torchmetrics.detection.mean_ap import MeanAveragePrecision
from transformers import AutoImageProcessor, AutoModelForObjectDetection


@torch.inference_mode()
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--threshold", type=float, default=0.0)
    args = ap.parse_args()
    cfg = yaml.safe_load(open(args.config)); token = os.environ.get("HF_TOKEN")

    label_names = cfg["label_names"]
    id2label = {i: n for i, n in enumerate(label_names)}

    ip = AutoImageProcessor.from_pretrained(args.checkpoint, token=token,
                                            do_resize=True,
                                            size={"shortest_edge": 480, "longest_edge": 640},
                                            do_pad=True)
    is_base = args.checkpoint == cfg["model_id"]
    kw = dict(token=token)
    if is_base:
        kw.update(num_labels=len(label_names), id2label=id2label,
                  label2id={n:i for i,n in enumerate(label_names)},
                  ignore_mismatched_sizes=True)
    model = AutoModelForObjectDetection.from_pretrained(args.checkpoint, **kw).cuda().eval()

    ds = load_from_disk("data/eval")
    metric = MeanAveragePrecision(box_format="xyxy", class_metrics=True)

    for ex in ds:
        img = ex["image"].convert("RGB")
        inputs = ip(images=img, return_tensors="pt").to("cuda")
        with torch.autocast(device_type="cuda", dtype=torch.bfloat16, enabled=cfg.get("bf16", True)):
            outputs = model(**inputs)
        h, w = img.size[1], img.size[0]
        post = ip.post_process_object_detection(
            outputs, threshold=args.threshold, target_sizes=torch.tensor([[h, w]]).cuda())[0]
        preds = {"boxes": post["boxes"].cpu(), "scores": post["scores"].cpu(), "labels": post["labels"].cpu()}
        # Ground truth (COCO format → xyxy pixels)
        bbs, cats = [], []
        for bbox, c in zip(ex["objects"]["bbox"], ex["objects"]["category"]):
            x, y, bw, bh = bbox
            bbs.append([x, y, x + bw, y + bh]); cats.append(c)
        tgt = {"boxes": torch.tensor(bbs, dtype=torch.float32) if bbs else torch.zeros((0,4)),
               "labels": torch.tensor(cats, dtype=torch.long) if cats else torch.zeros((0,), dtype=torch.long)}
        metric.update([preds], [tgt])

    m = metric.compute()
    result = {
        "checkpoint": args.checkpoint, "n_eval": len(ds),
        "map": float(m["map"].item()),
        "map_50": float(m["map_50"].item()),
        "map_75": float(m["map_75"].item()),
        "map_small": float(m["map_small"].item()),
        "map_medium": float(m["map_medium"].item()),
        "map_large": float(m["map_large"].item()),
    }
    if "classes" in m and "map_per_class" in m:
        result["per_class_ap"] = {
            id2label.get(int(c), str(c)): float(v)
            for c, v in zip(m["classes"].tolist(), m["map_per_class"].tolist())
        }
    # primary accuracy = mAP for reporting
    result["accuracy"] = result["map"]
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(result, indent=2))
    print(f"[eval] map={result['map']:.4f} map_50={result['map_50']:.4f} n={len(ds)}")


if __name__ == "__main__":
    main()
