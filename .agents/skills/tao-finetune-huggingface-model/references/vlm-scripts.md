<!--
Copyright (c) 2026, NVIDIA CORPORATION.  All rights reserved.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
-->

# VLM / LLM Pipeline Scripts Reference

> **How to use this file**
>
> This file defines two things:
> 1. **Structural scaffolding** (marked `[SCAFFOLD]`) — file names, entry point names, config
>    schema, CLI boilerplate, LoRA target regex patterns, checkpoint saving. Copy these as-is.
> 2. **ML implementation stubs** (marked `[FETCH LIVE]`) — chat template formatting, processor
>    call signatures, collator class, SFTTrainer/DPOTrainer kwargs, LoRA config. **Do NOT copy.**
>    Fetch the live TRL/PEFT documentation and the specific model card instead.
>
> **Why:** VLM APIs change fast. `SFTTrainer` kwargs, the `processing_class` parameter, chat
> template application, and LoRA target module names all vary by model family and TRL version.
> A stale template that worked for PaliGemma will silently break for Qwen2-VL or LLaVA-Next.
>
> **Live doc URLs to fetch in Phase 4.2:**
>
> | Training method | Primary doc URL | Secondary |
> |----------------|----------------|-----------|
> | SFT (VLM/LLM) | `https://huggingface.co/docs/trl/sft_trainer` | model card + model's own fine-tuning guide |
> | LoRA | `https://huggingface.co/docs/peft/quicktour` | `https://huggingface.co/docs/peft/task_guides/image_classification_lora` |
> | DPO | `https://huggingface.co/docs/trl/dpo_trainer` | model card |
> | GRPO | `https://huggingface.co/docs/trl/grpo_trainer` | model card |
>
> Also fetch the **model card** for the specific `model_id`: many VLMs (Qwen2-VL, LLaVA,
> PaliGemma) have their own fine-tuning guides linked from the card with exact processor
> usage, chat template format, and recommended LoRA targets.
>
> Search GitHub: `site:github.com {model_type} SFTTrainer fine-tune` for working examples.
>
> **Rule:** if the live doc's pattern contradicts anything in this file, the live doc wins.
> Log the discrepancy in PROGRESS.md with the doc URL.

---

## config.yaml — VLM Template

```yaml
# Model
model_id: google/paligemma-3b-pt-224
task: image-text-to-text
auto_model: AutoModelForImageTextToText
training_method: sft           # sft | dpo | grpo

# LoRA
use_lora: true
lora_r: 16
lora_alpha: 32
lora_dropout: 0.05
lora_target_modules: ".*language_model.*\\.(q_proj|k_proj|v_proj|o_proj|gate_proj|up_proj|down_proj)"

# Dataset
dataset_id: lmms-lab/VQAv2
local_data_dir: ./data
n_train: 10000
n_eval: 1000

# Training
output_dir: ./checkpoints
num_train_epochs: 1
per_device_train_batch_size: 16
per_device_eval_batch_size: 8
learning_rate: 2.0e-4
warmup_ratio: 0.05
weight_decay: 0.01
lr_scheduler_type: cosine
bf16: true
gradient_checkpointing: false      # disable with LoRA on A100 80GB; enable on smaller GPU
gradient_checkpointing_kwargs:
  use_reentrant: false
max_grad_norm: 1.0
attn_implementation: eager          # "sdpa" on NGC 25.01+, "eager" on 24.09
dataloader_num_workers: 4
dataloader_pin_memory: true
max_seq_length: 1024
image_max_soft_tokens: 140          # 70|140|280|560 — 140 is 2x faster than 280

# Evaluation
eval_strategy: epoch
save_strategy: epoch
load_best_model_at_end: false       # not well-supported for generative models
metric_for_best_model: eval_loss

# Monitoring
report_to: wandb
logging_steps: 10

# Post-training
push_to_hub: false
model_short_name: paligemma-3b-vqa
```

---

## model.py

```python
import os
import yaml
import torch
from transformers import AutoProcessor, AutoModelForImageTextToText, AutoModelForCausalLM, BitsAndBytesConfig
from peft import LoraConfig, get_peft_model, TaskType


def load_model_and_processor(cfg: dict):
    model_id = cfg["model_id"]
    task = cfg["task"]
    token = os.environ.get("HF_TOKEN") or cfg.get("hf_token")

    if task == "image-text-to-text":
        ModelCls = AutoModelForImageTextToText
    else:
        ModelCls = AutoModelForCausalLM

    # Dtype rule:
    #   - LoRA path: load base in bfloat16 (frozen base, trainable LoRA in fp32
    #     by default — saves ~2x VRAM, no underflow because gradients flow
    #     through fp32 LoRA weights, not the frozen bf16 base).
    #   - Full fine-tune: load in float32. `TrainingArguments(bf16=True)` does
    #     mixed-precision casting via autocast; loading the base in bfloat16
    #     AND enabling bf16 training causes optimizer-state underflow and the
    #     "loss stays near random" symptom documented in the master gotcha
    #     index.
    use_lora = cfg.get("use_lora", True)
    if use_lora and cfg.get("bf16", True):
        load_dtype = torch.bfloat16
    else:
        load_dtype = torch.float32
    model = ModelCls.from_pretrained(
        model_id,
        torch_dtype=load_dtype,
        device_map="auto",
        attn_implementation=cfg.get("attn_implementation", "eager"),
        token=token,
    )

    if task == "image-text-to-text":
        processor = AutoProcessor.from_pretrained(model_id, token=token)
    else:
        from transformers import AutoTokenizer
        processor = AutoTokenizer.from_pretrained(model_id, token=token)
        if processor.pad_token is None:
            processor.pad_token = processor.eos_token

    if cfg.get("use_lora", True):
        lora_config = LoraConfig(
            task_type=TaskType.CAUSAL_LM,
            r=cfg.get("lora_r", 16),
            lora_alpha=cfg.get("lora_alpha", 32),
            lora_dropout=cfg.get("lora_dropout", 0.05),
            target_modules=cfg.get("lora_target_modules",
                r".*language_model.*\.(q_proj|k_proj|v_proj|o_proj|gate_proj|up_proj|down_proj)"),
            bias="none",
        )
        model = get_peft_model(model, lora_config)

    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    total = sum(p.numel() for p in model.parameters())
    pct = 100 * trainable / total
    print(f"Trainable: {trainable / 1e6:.1f}M / {total / 1e6:.1f}M params ({pct:.2f}%)")
    if pct > 5 and cfg.get("use_lora"):
        print("WARNING: >5% trainable with LoRA — check lora_target_modules regex")

    return model, processor
```

---

## dataset.py

```python
import os
import yaml
import torch
from datasets import load_from_disk, Image as HFImage
from torch.utils.data import Dataset


class VLMDataset(Dataset):
    """Supports VQA-style datasets with image + question + answer columns."""

    def __init__(self, arrow_path: str, processor, cfg: dict):
        self.ds = load_from_disk(arrow_path)
        if "image" in self.ds.column_names:
            self.ds = self.ds.cast_column("image", HFImage())
        self.processor = processor
        self.cfg = cfg
        self.max_length = cfg.get("max_seq_length", 1024)
        self._verify_collator()

    def _verify_collator(self):
        if len(self.ds) < 2:
            return
        samples = [self.__getitem__(i) for i in range(2)]
        non_masked = (samples[0]["labels"] != -100).sum().item()
        total = samples[0]["labels"].numel()
        print(f"Collator check — non-masked labels: {non_masked}/{total} ({100*non_masked/total:.1f}%)")
        if non_masked == 0:
            raise ValueError("COLLATOR ERROR: all labels are masked (-100). Check prompt/answer boundary logic.")

    def _build_messages(self, item: dict) -> list:
        if "messages" in item:
            return item["messages"]
        # VQA-style: image + question + answer
        question = item.get("question", "")
        answer = item.get("answers", [""])[0] if isinstance(item.get("answers"), list) else item.get("answer", "")
        return [
            {"role": "user", "content": [
                {"type": "image"},
                {"type": "text", "text": question},
            ]},
            {"role": "assistant", "content": answer},
        ]

    def __len__(self):
        return len(self.ds)

    def __getitem__(self, idx):
        """Return a DICT of tensors — DO NOT pad or truncate here. Let `collate_vlm`
        handle batching (images in VLMs like Idefics3 expand to hundreds of image
        tokens; mid-image truncation breaks the processor with:
            ValueError: Mismatch in `image` token count between text and `input_ids`
        )."""
        item = self.ds[idx]
        image = item["image"].convert("RGB")
        messages = self._build_messages(item)

        prompt_msgs = messages[:-1]
        prompt = self.processor.apply_chat_template(prompt_msgs, add_generation_prompt=True, tokenize=False)
        full = self.processor.apply_chat_template(messages, tokenize=False)

        # No padding/truncation at sample level — variable length is fine
        inputs = self.processor(text=full, images=image, return_tensors="pt")
        inputs = {k: v.squeeze(0) for k, v in inputs.items()}

        # Mask prompt tokens
        prompt_enc = self.processor(text=prompt, images=image, return_tensors="pt")
        prompt_len = prompt_enc["input_ids"].shape[1]

        labels = inputs["input_ids"].clone()
        labels[:prompt_len] = -100
        labels[labels == self.processor.tokenizer.pad_token_id] = -100
        inputs["labels"] = labels
        return inputs


def collate_vlm(batch, pad_token_id: int = 0):
    """Batch VLM samples with heterogeneous shapes.

    Text tensors (input_ids, attention_mask, labels) are padded to batch-max length.
    Image tensors (pixel_values, pixel_attention_mask) are padded along both
    `num_images` (variable per sample for models that tile high-res inputs like
    Idefics3) AND spatial dims if they differ.
    """
    import torch

    # --- Text side: pad to longest in batch ---
    max_seq = max(b["input_ids"].shape[0] for b in batch)
    def _pad_1d(t, length, value):
        if t.shape[0] >= length:
            return t[:length]
        return torch.cat([t, torch.full((length - t.shape[0],), value, dtype=t.dtype)])

    out = {
        "input_ids":      torch.stack([_pad_1d(b["input_ids"], max_seq, pad_token_id) for b in batch]),
        "attention_mask": torch.stack([_pad_1d(b["attention_mask"], max_seq, 0) for b in batch]),
        "labels":         torch.stack([_pad_1d(b["labels"], max_seq, -100) for b in batch]),
    }

    # --- Image side: pad num_images, then spatial dims if they differ ---
    if "pixel_values" in batch[0]:
        pvs = [b["pixel_values"] for b in batch]          # each: (n_img, C, H, W) for Idefics3
        # Ensure 4D (n_img, C, H, W) — if 3D (C, H, W), add n_img=1 dim
        pvs = [pv.unsqueeze(0) if pv.ndim == 3 else pv for pv in pvs]
        max_n = max(pv.shape[0] for pv in pvs)
        max_h = max(pv.shape[-2] for pv in pvs)
        max_w = max(pv.shape[-1] for pv in pvs)

        def _pad_img(pv):
            n, c, h, w = pv.shape
            if (h, w) != (max_h, max_w):
                pv = torch.nn.functional.pad(pv, (0, max_w - w, 0, max_h - h), value=0.0)
            if n < max_n:
                pv = torch.cat([pv, torch.zeros(max_n - n, c, max_h, max_w, dtype=pv.dtype)], dim=0)
            return pv
        out["pixel_values"] = torch.stack([_pad_img(pv) for pv in pvs])

    # pixel_attention_mask if processor produced one
    if "pixel_attention_mask" in batch[0]:
        pams = [b["pixel_attention_mask"] for b in batch]
        pams = [p.unsqueeze(0) if p.ndim == 2 else p for p in pams]
        max_n = max(p.shape[0] for p in pams)
        max_h = max(p.shape[-2] for p in pams)
        max_w = max(p.shape[-1] for p in pams)
        def _pad_mask(p):
            n, h, w = p.shape
            if (h, w) != (max_h, max_w):
                p = torch.nn.functional.pad(p, (0, max_w - w, 0, max_h - h), value=0)
            if n < max_n:
                p = torch.cat([p, torch.zeros(max_n - n, max_h, max_w, dtype=p.dtype)], dim=0)
            return p
        out["pixel_attention_mask"] = torch.stack([_pad_mask(p) for p in pams])

    return out


class LLMDataset(Dataset):
    """Text-only SFT dataset for LLM training."""

    def __init__(self, arrow_path: str, tokenizer, max_length: int = 1024):
        self.ds = load_from_disk(arrow_path)
        self.tokenizer = tokenizer
        self.max_length = max_length

    def __len__(self):
        return len(self.ds)

    def __getitem__(self, idx):
        item = self.ds[idx]
        if "messages" in item:
            text = self.tokenizer.apply_chat_template(item["messages"], tokenize=False)
        else:
            text = item.get("text") or item.get("prompt", "") + item.get("completion", "")

        enc = self.tokenizer(text, max_length=self.max_length, truncation=True,
                             padding="max_length", return_tensors="pt")
        enc = {k: v.squeeze(0) for k, v in enc.items()}
        enc["labels"] = enc["input_ids"].clone()
        return enc
```

---

## train.py

```python
import argparse
import os
import yaml
import torch
from transformers import TrainingArguments
from trl import SFTTrainer, SFTConfig, DPOTrainer, DPOConfig
from model import load_model_and_processor
from dataset import VLMDataset, LLMDataset


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--config", default="config.yaml")
    return p.parse_args()


def train_sft(cfg, model, processor):
    task = cfg["task"]
    if task == "image-text-to-text":
        DatasetCls = lambda path: VLMDataset(path, processor, cfg)
    else:
        DatasetCls = lambda path: LLMDataset(path, processor, cfg.get("max_seq_length", 1024))

    train_ds = DatasetCls(f"{cfg['local_data_dir']}/train")
    eval_ds = DatasetCls(f"{cfg['local_data_dir']}/eval")

    smoke = bool(cfg.get("smoke_test", False))
    if smoke:
        os.environ["WANDB_MODE"] = "disabled"

    sft_args = SFTConfig(
        output_dir=cfg["output_dir"],
        num_train_epochs=cfg["num_train_epochs"],
        per_device_train_batch_size=cfg["per_device_train_batch_size"],
        per_device_eval_batch_size=cfg.get("per_device_eval_batch_size", 8),
        learning_rate=cfg["learning_rate"],
        warmup_ratio=cfg.get("warmup_ratio", 0.05),
        weight_decay=cfg.get("weight_decay", 0.01),
        lr_scheduler_type=cfg.get("lr_scheduler_type", "cosine"),
        bf16=cfg.get("bf16", True),
        gradient_checkpointing=cfg.get("gradient_checkpointing", False),
        gradient_checkpointing_kwargs=cfg.get("gradient_checkpointing_kwargs", {"use_reentrant": False}),
        max_grad_norm=cfg.get("max_grad_norm", 1.0),
        dataloader_num_workers=cfg.get("dataloader_num_workers", 4),
        dataloader_pin_memory=cfg.get("dataloader_pin_memory", True),
        max_length=cfg.get("max_seq_length", 1024),          # SFTConfig uses max_length
        max_steps=1 if smoke else -1,
        eval_strategy="no" if smoke else cfg.get("eval_strategy", "epoch"),
        save_strategy="no" if smoke else cfg.get("save_strategy", "epoch"),
        report_to="none" if smoke else cfg.get("report_to", "wandb"),
        logging_steps=1 if smoke else cfg.get("logging_steps", 10),
        run_name=os.environ.get("WANDB_RUN_NAME"),
        dataset_kwargs={"skip_prepare_dataset": True},       # use pre-tokenized dataset
    )

    trainer = SFTTrainer(
        model=model,
        args=sft_args,
        train_dataset=train_ds,
        eval_dataset=eval_ds,
    )
    trainer.train()

    if smoke:
        # Find the step-level log entry. The final entry is the training summary
        # which carries `train_loss` (not `loss`); the step entries have `loss`
        # and `grad_norm`. Searching by key avoids the off-by-one.
        step_log = next(
            (l for l in reversed(trainer.state.log_history) if "loss" in l), None
        )
        if step_log is None:
            raise RuntimeError("smoke test produced no step-level log entry")
        loss = step_log["loss"]
        grad_norm = step_log.get("grad_norm", 0.0)
        print(f"SMOKE: step={step_log.get('step')} loss={loss:.4f} grad_norm={grad_norm:.4f}")
        if not (loss == loss) or loss == 0.0 or grad_norm == 0.0:  # NaN-safe
            raise RuntimeError(
                f"smoke test failed: loss={loss}, grad_norm={grad_norm} — "
                "labels/masking bug; do not proceed to full training"
            )
        return

    trainer.save_model(f"{cfg['output_dir']}/final")
    processor.save_pretrained(f"{cfg['output_dir']}/final")


def train_dpo(cfg, model, processor):
    from datasets import load_from_disk
    train_ds = load_from_disk(f"{cfg['local_data_dir']}/train")
    eval_ds = load_from_disk(f"{cfg['local_data_dir']}/eval")

    # DPO requires prompt, chosen, rejected columns
    for col in ["prompt", "chosen", "rejected"]:
        assert col in train_ds.column_names, f"DPO requires '{col}' column"

    dpo_args = DPOConfig(
        output_dir=cfg["output_dir"],
        num_train_epochs=cfg["num_train_epochs"],
        per_device_train_batch_size=cfg["per_device_train_batch_size"],
        learning_rate=cfg.get("learning_rate", 5e-7),
        bf16=cfg.get("bf16", True),
        report_to=cfg.get("report_to", "wandb"),
        logging_steps=cfg.get("logging_steps", 10),
        run_name=os.environ.get("WANDB_RUN_NAME"),
    )

    trainer = DPOTrainer(
        model=model,
        ref_model=None,                # None → uses implicit ref from PEFT frozen params
        args=dpo_args,
        train_dataset=train_ds,
        eval_dataset=eval_ds,
        processing_class=processor,
    )
    trainer.train()
    trainer.save_model(f"{cfg['output_dir']}/final")


def main():
    args = parse_args()
    with open(args.config) as f:
        cfg = yaml.safe_load(f)

    model, processor = load_model_and_processor(cfg)
    method = cfg.get("training_method", "sft")

    if method == "sft":
        train_sft(cfg, model, processor)
    elif method == "dpo":
        train_dpo(cfg, model, processor)
    else:
        raise ValueError(f"Unknown training_method: {method}. Use sft | dpo | grpo")

    print(f"Training complete ({method}). Model saved to {cfg['output_dir']}/final")


if __name__ == "__main__":
    main()
```

---

## merge_lora.py

```python
import argparse
import os
import torch
from peft import PeftModel
from transformers import AutoModelForImageTextToText, AutoModelForCausalLM, AutoProcessor, AutoTokenizer


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--base_model", required=True)
    p.add_argument("--adapter_path", required=True)
    p.add_argument("--output_path", required=True)
    p.add_argument("--task", default="image-text-to-text")
    return p.parse_args()


def main():
    args = parse_args()
    token = os.environ.get("HF_TOKEN")

    print(f"Loading base model: {args.base_model}")
    if args.task == "image-text-to-text":
        base = AutoModelForImageTextToText.from_pretrained(
            args.base_model, torch_dtype=torch.bfloat16, device_map="auto", token=token)
        proc = AutoProcessor.from_pretrained(args.base_model, token=token)
    else:
        base = AutoModelForCausalLM.from_pretrained(
            args.base_model, torch_dtype=torch.bfloat16, device_map="auto", token=token)
        proc = AutoTokenizer.from_pretrained(args.base_model, token=token)

    print(f"Loading LoRA adapter: {args.adapter_path}")
    model = PeftModel.from_pretrained(base, args.adapter_path)

    print("Merging LoRA weights into base model...")
    merged = model.merge_and_unload()

    print(f"Saving merged model to: {args.output_path}")
    merged.save_pretrained(args.output_path, safe_serialization=True)
    proc.save_pretrained(args.output_path)
    print("Merge complete.")


if __name__ == "__main__":
    main()
```

---

## run_eval.py (NOT `evaluate.py` — collides with HF `evaluate` library)

```python
import argparse
import json
import os
import re
import yaml
import torch
from datasets import load_from_disk, Image as HFImage
from transformers import AutoProcessor, AutoModelForImageTextToText, AutoModelForCausalLM
from tqdm import tqdm


def normalize_answer(s: str) -> str:
    s = s.lower().strip()
    s = re.sub(r"[^\w\s]", "", s)
    s = re.sub(r"\b(a|an|the)\b", " ", s)
    return " ".join(s.split())


def vqa_accuracy(predicted: str, human_answers: list) -> float:
    pred_norm = normalize_answer(predicted)
    count = sum(1 for a in human_answers if normalize_answer(a) == pred_norm)
    return min(1.0, count / 3.0)


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--config", default="config.yaml")
    p.add_argument("--checkpoint", required=True)
    p.add_argument("--output", default="reports/eval_results.json")
    return p.parse_args()


def main():
    args = parse_args()
    with open(args.config) as f:
        cfg = yaml.safe_load(f)

    token = os.environ.get("HF_TOKEN")
    task = cfg["task"]

    if task == "image-text-to-text":
        model = AutoModelForImageTextToText.from_pretrained(
            args.checkpoint, torch_dtype=torch.bfloat16, device_map="auto", token=token)
        processor = AutoProcessor.from_pretrained(args.checkpoint, token=token)
    else:
        from transformers import AutoTokenizer
        model = AutoModelForCausalLM.from_pretrained(
            args.checkpoint, torch_dtype=torch.bfloat16, device_map="auto", token=token)
        processor = AutoTokenizer.from_pretrained(args.checkpoint, token=token)

    model.eval()

    eval_ds = load_from_disk(f"{cfg['local_data_dir']}/eval")
    if "image" in eval_ds.column_names:
        eval_ds = eval_ds.cast_column("image", HFImage())

    scores = []
    for item in tqdm(eval_ds, desc="Evaluating"):
        image = item["image"].convert("RGB") if task == "image-text-to-text" else None
        question = item.get("question", "")
        ground_truth = item.get("answers", [item.get("answer", "")])
        if isinstance(ground_truth, str):
            ground_truth = [ground_truth]

        if task == "image-text-to-text":
            messages = [{"role": "user", "content": [
                {"type": "image"}, {"type": "text", "text": question}]}]
            prompt = processor.apply_chat_template(messages, add_generation_prompt=True, tokenize=False)
            inputs = processor(text=prompt, images=image, return_tensors="pt").to(model.device)
        else:
            inputs = processor(question, return_tensors="pt").to(model.device)

        with torch.no_grad():
            out_ids = model.generate(
                **inputs,
                max_new_tokens=32,
                do_sample=False,        # greedy — deterministic for eval
                pad_token_id=processor.tokenizer.pad_token_id if hasattr(processor, "tokenizer") else processor.pad_token_id,
            )
        prompt_len = inputs["input_ids"].shape[1]
        answer = processor.decode(out_ids[0][prompt_len:], skip_special_tokens=True).strip()
        score = vqa_accuracy(answer, ground_truth)
        scores.append(score)

    results = {
        "vqa_accuracy": sum(scores) / len(scores),
        "n_eval": len(scores),
        "method": cfg.get("training_method", "sft"),
        "model_id": cfg["model_id"],
        "checkpoint": args.checkpoint,
    }

    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    with open(args.output, "w") as f:
        json.dump(results, f, indent=2)
    print("Eval results:", json.dumps(results, indent=2))
    print(f"\nVQA Accuracy: {results['vqa_accuracy']:.4f} ({results['vqa_accuracy']*100:.2f}%)")


if __name__ == "__main__":
    main()
```

---

## inference.py

```python
import argparse
import json
import os
import yaml
import torch
from datasets import load_from_disk, Image as HFImage
from pathlib import Path
from transformers import AutoProcessor, AutoModelForImageTextToText


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--config", default="config.yaml")
    p.add_argument("--checkpoint", required=True)
    p.add_argument("--n_samples", type=int, default=5)
    p.add_argument("--output", default="reports/inference_samples")
    return p.parse_args()


def main():
    args = parse_args()
    with open(args.config) as f:
        cfg = yaml.safe_load(f)

    token = os.environ.get("HF_TOKEN")
    model = AutoModelForImageTextToText.from_pretrained(
        args.checkpoint, torch_dtype=torch.bfloat16, device_map="auto", token=token)
    processor = AutoProcessor.from_pretrained(args.checkpoint, token=token)
    model.eval()

    eval_ds = load_from_disk(f"{cfg['local_data_dir']}/eval")
    if "image" in eval_ds.column_names:
        eval_ds = eval_ds.cast_column("image", HFImage())

    out_dir = Path(args.output)
    out_dir.mkdir(parents=True, exist_ok=True)

    for i in range(min(args.n_samples, len(eval_ds))):
        item = eval_ds[i]
        image = item["image"].convert("RGB")
        question = item.get("question", "Describe this image.")
        ground_truth = item.get("answers", [item.get("answer", "")])

        messages = [{"role": "user", "content": [
            {"type": "image"}, {"type": "text", "text": question}]}]
        prompt = processor.apply_chat_template(messages, add_generation_prompt=True, tokenize=False)
        inputs = processor(text=prompt, images=image, return_tensors="pt").to(model.device)

        with torch.no_grad():
            out_ids = model.generate(**inputs, max_new_tokens=64, do_sample=False)
        prompt_len = inputs["input_ids"].shape[1]
        answer = processor.decode(out_ids[0][prompt_len:], skip_special_tokens=True).strip()

        image.save(out_dir / f"sample_{i}_input.jpg")
        meta = {
            "question": question,
            "ground_truth": ground_truth,
            "predicted": answer,
        }
        with open(out_dir / f"sample_{i}_meta.json", "w") as f:
            json.dump(meta, f, indent=2)
        print(f"Sample {i}: Q={question!r} | GT={ground_truth} | Pred={answer!r}")


if __name__ == "__main__":
    main()
```

---

## VLM-Specific Gotchas

**GOTCHA: `dtype=` vs `torch_dtype=`**
Use `torch_dtype=torch.bfloat16`, NOT `dtype=`. Wrong key silently loads in float32.

**HANDLED: dtype rule for full fine-tune vs LoRA**
The template loads the base in `bfloat16` only when `use_lora=True` and
`bf16=True`. For full fine-tune (`use_lora=False`), the base loads in
`float32` so `TrainingArguments(bf16=True)` autocast works correctly.
Loading the base in bfloat16 AND enabling bf16 training causes
optimizer-state underflow ("loss stays near random") for full fine-tunes.

**GOTCHA: LoRA on VLMs — exclude vision encoder**
Many VLMs (Gemma4, LLaVA, PaliGemma) use custom linear types in the vision encoder that PEFT cannot wrap.
Always use regex: `".*language_model.*\\.(q_proj|k_proj|v_proj|o_proj|gate_proj|up_proj|down_proj)"`

**GOTCHA: `transformers>=5.0` for 2024+ VLMs**
PaliGemma 2, Gemma 3/4, LLaVA-Next, Qwen2-VL require `transformers>=5.0.0`.

**GOTCHA: SFTConfig uses `max_length`, not `max_seq_length`**
TRL SFTConfig parameter is `max_length`. Using `max_seq_length` is silently ignored.

**GOTCHA: trl >= 1.0 breaking API**
Pin `trl>=0.18.0,<1.0.0` for stability. TRL 1.0+ has breaking changes to SFTTrainer/DPOTrainer.

**GOTCHA: `dataset_kwargs={"skip_prepare_dataset": True}`**
When using pre-tokenized datasets (VLMDataset returns tensors), pass this to SFTTrainer to prevent
it from trying to tokenize again (it doesn't know about vision inputs).

**Expected baselines (VQA v2, 10K train samples, 1 epoch):**
- Zero-shot (no finetuning): 55-65% accuracy
- After LoRA SFT: 58-73% accuracy (+3-8%)
- Full finetune on 443K samples: 75-80% accuracy
