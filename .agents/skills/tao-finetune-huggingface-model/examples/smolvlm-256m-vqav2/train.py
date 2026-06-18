# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""SmolVLM fine-tune on VQAv2-small — LoRA adapter, author-notebook recipe."""
import argparse, os
from pathlib import Path

import torch, yaml
from datasets import load_from_disk
from peft import LoraConfig, get_peft_model
from transformers import AutoProcessor, Idefics3ForConditionalGeneration, Trainer, TrainingArguments


def build_collate_fn(processor, image_token_id):
    def collate_fn(examples):
        texts, images = [], []
        for ex in examples:
            img = ex["image"]
            if img.mode != "RGB": img = img.convert("RGB")
            messages = [
                {"role": "user", "content": [
                    {"type": "text", "text": "Answer briefly."},
                    {"type": "image"},
                    {"type": "text", "text": ex["question"]},
                ]},
                {"role": "assistant", "content": [
                    {"type": "text", "text": ex["multiple_choice_answer"]},
                ]},
            ]
            texts.append(processor.apply_chat_template(messages, add_generation_prompt=False).strip())
            images.append([img])
        batch = processor(text=texts, images=images, return_tensors="pt", padding=True)
        labels = batch["input_ids"].clone()
        labels[labels == processor.tokenizer.pad_token_id] = -100
        labels[labels == image_token_id] = -100
        batch["labels"] = labels
        return batch
    return collate_fn


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--smoke", action="store_true")
    ap.add_argument("--max_steps", type=int, default=None)
    args = ap.parse_args()
    cfg = yaml.safe_load(open(args.config)); token = os.environ.get("HF_TOKEN")

    processor = AutoProcessor.from_pretrained(cfg["model_id"], token=token)
    addl = processor.tokenizer.additional_special_tokens
    image_token_id = processor.tokenizer.additional_special_tokens_ids[addl.index("<image>")]

    model = Idefics3ForConditionalGeneration.from_pretrained(
        cfg["model_id"], token=token,
        torch_dtype=torch.bfloat16 if cfg.get("bf16", True) else torch.float32,
        _attn_implementation=cfg.get("attn_implementation", "eager"),
    )

    if cfg.get("use_lora", True):
        lora_cfg = LoraConfig(
            r=cfg.get("lora_r", 8), lora_alpha=cfg.get("lora_alpha", 8),
            lora_dropout=cfg.get("lora_dropout", 0.1),
            target_modules=cfg.get("lora_target_modules",
                ["down_proj","o_proj","k_proj","q_proj","gate_proj","up_proj","v_proj"]),
            init_lora_weights="gaussian",
        )
        model = get_peft_model(model, lora_cfg)
        model.print_trainable_parameters()
        if cfg.get("gradient_checkpointing", True):
            model.enable_input_require_grads()

    ds_tr = load_from_disk("data/train"); ds_ev = load_from_disk("data/eval")

    if args.smoke: os.environ["WANDB_MODE"] = "disabled"
    os.environ.setdefault("WANDB_PROJECT", "tao-hf-finetune-5tasks")

    kw = dict(
        output_dir=cfg["output_dir"],
        num_train_epochs=cfg["num_train_epochs"],
        per_device_train_batch_size=cfg["per_device_train_batch_size"],
        per_device_eval_batch_size=cfg["per_device_eval_batch_size"],
        gradient_accumulation_steps=cfg["gradient_accumulation_steps"],
        learning_rate=cfg["learning_rate"],
        warmup_steps=cfg.get("warmup_steps", 50),
        weight_decay=cfg.get("weight_decay", 0.01),
        bf16=cfg.get("bf16", True),
        gradient_checkpointing=cfg.get("gradient_checkpointing", True),
        dataloader_num_workers=cfg.get("dataloader_num_workers", 2),
        remove_unused_columns=cfg.get("remove_unused_columns", False),
        save_strategy=cfg.get("save_strategy", "steps"),
        save_steps=cfg.get("save_steps", 125),
        save_total_limit=cfg.get("save_total_limit", 1),
        logging_steps=cfg.get("logging_steps", 5),
        logging_first_step=cfg.get("logging_first_step", True),
        logging_strategy=cfg.get("logging_strategy", "steps"),
        disable_tqdm=cfg.get("disable_tqdm", True),
        optim="adamw_torch",
        report_to=("none" if args.smoke else cfg.get("report_to", "wandb")),
        run_name=cfg.get("model_short_name", "run"),
        push_to_hub=False,
    )
    if args.max_steps is not None:
        kw["max_steps"] = args.max_steps; kw["save_strategy"] = "no"

    trainer = Trainer(
        model=model, args=TrainingArguments(**kw),
        train_dataset=ds_tr,
        data_collator=build_collate_fn(processor, image_token_id),
    )
    trainer.train()

    if not args.smoke:
        final = Path(cfg["output_dir"]) / "final"
        trainer.save_model(str(final)); processor.save_pretrained(str(final))
        print(f"[train] LoRA adapter -> {final}")


if __name__ == "__main__":
    main()
