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

# Core Rules — tao-finetune-huggingface-model

The non-negotiable behaviors the agent must follow throughout the
six-step workflow. SKILL.md summarises these and points here for the
full text.

---

## Order of authority (highest first)

1. **User input** — explicit `model_id`, `dataset_id`, `training_method`, `config.yaml` overrides.
2. **Live research** — model card, HF repo example, author finetune script, HF task docs, paper. Always fetched. See Step 3 + `research-priorities.md`.
3. **Curated references** (`references/*.md`) — fallback when live research is silent or ambiguous.
4. **Your training-data memory** — last resort. Treat as suspect; cross-check against (2) or (3).

If (2) and (3) conflict on an API call, (2) wins (newer). If they conflict on a
method detail (collator, LoRA targets, augmentation), (2) wins for the *specific*
model; (3) for the generic shape. Note the discrepancy in a comment at the source
line.

---

## Your knowledge of HF libraries is outdated

You do not know current APIs for `transformers`, `trl`, `datasets`, `peft`, or
`accelerate`. Your internal knowledge WILL produce wrong imports, wrong trainer
arguments, wrong collator constructors, and hallucinated config fields. Before
writing any ML code, fetch the live sources listed in
`research-priorities.md` (sibling reference). Never generate training code
from memory alone.

---

## Mistakes you WILL make without research

- **HALLUCINATED IMPORTS** — modules renamed or removed. Read one current
  example script first.
- **WRONG TRAINER ARGUMENTS** — args that don't exist in the installed
  `transformers`/`trl`. Fetch the docs for `TrainingArguments` / `SFTConfig`.
- **WRONG DATASET FORMAT** — assuming columns. Stream 20 rows, print columns
  *before* writing the collator.
- **BATCH FAILURES** — launching multiple runs before verifying one. Smoke-test
  (`--max_steps 1`) on real data before the full run.
- **SILENT DATASET SUBSTITUTION** — requested dataset fails, you quietly switch.
  Stop. Tell the user. Ask.
- **SCOPE-CHANGING FIXES** — on OOM you switch SFT→LoRA, shrink `max_length`,
  disable monitoring. Don't. Fix with the minimal change that preserves the
  request.
- **LOST MODELS** — local disk can be cleared. `push_to_hub=True` always unless
  user explicitly says `False`.
- **HIDDEN LOSS** — `tqdm` bars hide loss. In `TrainingArguments`:
  `disable_tqdm=True`, `logging_strategy="steps"`, `logging_first_step=True`,
  `logging_steps=10`.
- **NO AUGMENTATION (CV)** — `AutoImageProcessor` only resizes+normalizes.
  Without `RandomResizedCrop` + `RandomHorizontalFlip` you can drop ~30-40 points
  on small datasets. Always fetch training transforms from the HF task doc or
  author's script — not memory.

---

## Never without user approval

- Change `model_id`, `dataset_id`, or `training_method`.
- Change task type mid-run (e.g. full → LoRA, classification → detection).
- Skip the smoke test or preflight check.
- Disable monitoring to "fix" an error.

---

## Error recovery — minimal change, same approach

- **OOM**: halve `per_device_train_batch_size`, double
  `gradient_accumulation_steps` (effective batch unchanged), enable
  `gradient_checkpointing=True`. Still OOM → ask user for bigger GPU.
- **NaN loss**: reduce LR 10×, set `max_grad_norm=1.0`.
- **Flat loss**: inspect label masking and LR. Usually a collator bug.
- **Same error 3× in a row**: stop, summarize, ask. Do not loop.
- **Import/API error**: refetch the relevant doc page — the API moved.

---

## Dataset format by task

Verify columns BEFORE writing the collator:

- `image-classification` — `image` + `label` (or `labels`)
- `object-detection` — `image` + `objects` with `bbox` + `category` (or `label`)
- `semantic-segmentation` — `image` + `segmentation` (or `label`, or `mask`)
- `depth-estimation` — `image` + `depth_map`
- `image-text-to-text` (VLM SFT) — `image` + `messages` (conversation), or
  `image` + `text` / `question` + `answer`

Mismatch + rename fixes it → do it in `prepare_data.py`. Restructuring needed →
stop and ask.

---

## Hardware sizing (bf16)

| Model size | GPU |
|---|---|
| ≤3B | 24 GB (A10, L4, T4-medium) |
| 7-13B | 80 GB (A100-80, H100) |
| 30B+ | multi-GPU (2-4× 80 GB) or LoRA on 1× 80 GB |
| 70B+ | 8× 80 GB or LoRA |

Rule of thumb: bf16 weights ≈ 2 B/param; optimizer states add ≈ 3-4× weights for
full finetune, ~0 for LoRA. If full won't fit and user didn't ask for LoRA, ask
before switching.

---

## Communication style

- Terse. No filler, no restating the request. One-word answers when appropriate.
- Always include direct Hub and wandb URLs when referencing artifacts.
- On error: state what went wrong, why, what you changed. No menus.
- Never present "Option A/B/C" for a request that has a clear answer. Act.
