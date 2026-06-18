# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Merge LoRA adapter into base SmolVLM, save standalone checkpoint."""
import argparse, os
from pathlib import Path
import torch
from peft import PeftModel
from transformers import AutoProcessor, Idefics3ForConditionalGeneration


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base_model", required=True)
    ap.add_argument("--adapter", required=True)
    ap.add_argument("--output", required=True)
    args = ap.parse_args()
    token = os.environ.get("HF_TOKEN")
    base = Idefics3ForConditionalGeneration.from_pretrained(
        args.base_model, torch_dtype=torch.bfloat16, token=token,
        _attn_implementation="eager",
    )
    merged = PeftModel.from_pretrained(base, args.adapter).merge_and_unload()
    out = Path(args.output); out.mkdir(parents=True, exist_ok=True)
    merged.save_pretrained(str(out))
    AutoProcessor.from_pretrained(args.base_model, token=token).save_pretrained(str(out))
    print(f"[merge] merged model -> {out}")


if __name__ == "__main__":
    main()
