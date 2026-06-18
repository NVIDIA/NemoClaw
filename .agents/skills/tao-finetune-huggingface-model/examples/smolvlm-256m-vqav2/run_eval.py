# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""VQA eval via .generate() — exact + substring match."""
import argparse, json, os, re
from pathlib import Path
import torch, yaml
from datasets import load_from_disk
from transformers import AutoProcessor, Idefics3ForConditionalGeneration


def normalize(s):
    s = s.lower().strip(); s = re.sub(r"[^a-z0-9\s]", " ", s); return re.sub(r"\s+", " ", s).strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--max_new_tokens", type=int, default=16)
    args = ap.parse_args()
    cfg = yaml.safe_load(open(args.config)); token = os.environ.get("HF_TOKEN")

    processor = AutoProcessor.from_pretrained(args.checkpoint, token=token)
    model = Idefics3ForConditionalGeneration.from_pretrained(
        args.checkpoint, torch_dtype=torch.bfloat16, token=token,
        _attn_implementation=cfg.get("attn_implementation", "eager"),
    ).to("cuda").eval()

    ds = load_from_disk("data/eval")
    preds, refs, questions = [], [], []
    n_exact = 0; n_sub = 0

    with torch.inference_mode():
        for ex in ds:
            img = ex["image"]
            if img.mode != "RGB": img = img.convert("RGB")
            msgs = [{"role": "user", "content": [
                {"type": "text", "text": "Answer briefly."},
                {"type": "image"},
                {"type": "text", "text": ex["question"]},
            ]}]
            prompt = processor.apply_chat_template(msgs, add_generation_prompt=True)
            batch = processor(text=[prompt], images=[[img]], return_tensors="pt", padding=True).to("cuda")
            out = model.generate(**batch, max_new_tokens=args.max_new_tokens, do_sample=False)
            gen = out[:, batch["input_ids"].shape[1]:]
            pred = processor.tokenizer.decode(gen[0], skip_special_tokens=True).strip()
            ref = ex["multiple_choice_answer"]
            preds.append(pred); refs.append(ref); questions.append(ex["question"])
            if normalize(pred) == normalize(ref): n_exact += 1
            if normalize(ref) in normalize(pred) or normalize(pred) in normalize(ref): n_sub += 1

    result = {"checkpoint": args.checkpoint, "n_eval": len(refs),
              "exact_match": n_exact/len(refs), "substring_match": n_sub/len(refs),
              "accuracy": n_exact/len(refs),
              "sample_predictions": [
                  {"question": q, "ref": r, "pred": p}
                  for q, r, p in zip(questions[:10], refs[:10], preds[:10])]}
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(result, indent=2))
    print(f"[eval] exact={result['exact_match']:.3f} substr={result['substring_match']:.3f} n={len(refs)}")


if __name__ == "__main__":
    main()
