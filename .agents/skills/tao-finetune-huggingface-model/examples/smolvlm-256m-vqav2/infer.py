# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""VLM inference on N samples — input + Q/A overlay + meta.json."""
import argparse, json, os
from pathlib import Path
import torch, yaml
from datasets import load_from_disk
from PIL import ImageDraw, ImageFont
from transformers import AutoProcessor, Idefics3ForConditionalGeneration


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--n_samples", type=int, default=5)
    ap.add_argument("--output", required=True)
    ap.add_argument("--max_new_tokens", type=int, default=32)
    args = ap.parse_args()
    cfg = yaml.safe_load(open(args.config)); token = os.environ.get("HF_TOKEN")
    out = Path(args.output); out.mkdir(parents=True, exist_ok=True)

    processor = AutoProcessor.from_pretrained(args.checkpoint, token=token)
    model = Idefics3ForConditionalGeneration.from_pretrained(
        args.checkpoint, torch_dtype=torch.bfloat16, token=token,
        _attn_implementation=cfg.get("attn_implementation", "eager"),
    ).to("cuda").eval()

    ds = load_from_disk("data/eval")
    for i, idx in enumerate(range(min(args.n_samples, len(ds)))):
        ex = ds[idx]; img = ex["image"]
        if img.mode != "RGB": img = img.convert("RGB")
        q, r = ex["question"], ex["multiple_choice_answer"]
        msgs = [{"role": "user", "content": [
            {"type": "text", "text": "Answer briefly."},
            {"type": "image"},
            {"type": "text", "text": q},
        ]}]
        prompt = processor.apply_chat_template(msgs, add_generation_prompt=True)
        batch = processor(text=[prompt], images=[[img]], return_tensors="pt").to("cuda")
        with torch.inference_mode():
            out_ids = model.generate(**batch, max_new_tokens=args.max_new_tokens, do_sample=False)
        pred = processor.tokenizer.decode(out_ids[:, batch["input_ids"].shape[1]:][0],
                                           skip_special_tokens=True).strip()

        img.save(out / f"sample_{i}_input.jpg", quality=90)
        ov = img.copy(); draw = ImageDraw.Draw(ov)
        text = f"Q: {q}\nA (pred): {pred}\nA (ref): {r}"
        h = min(90, ov.height // 3)
        draw.rectangle([(0,0), (ov.width, h)], fill=(0,0,0,200))
        try: font = ImageFont.load_default()
        except Exception: font = None
        draw.text((8, 6), text, fill=(255,255,255), font=font)
        ov.save(out / f"sample_{i}_pred.jpg", quality=90)
        (out / f"sample_{i}_meta.json").write_text(json.dumps({
            "index": idx, "question": q, "ground_truth": r, "prediction": pred}, indent=2))
        print(f"[infer] sample_{i}: Q='{q[:50]}' ref='{r}' pred='{pred[:50]}'")


if __name__ == "__main__":
    main()
