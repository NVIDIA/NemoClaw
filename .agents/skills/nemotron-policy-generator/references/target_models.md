<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: CC-BY-4.0
-->

# Target Models

The skill produces **one policy artifact** that works with **both** NVIDIA Nemotron content-safety guardrails. The Markdown is the canonical source of truth; the JSON taxonomy records both models' metadata; the system prompt template ships emit modes for each model.

## Model A — `nvidia/Nemotron-Content-Safety-Reasoning-4B`

- **Modality / language:** text only · English.
- **Base:** Gemma-3-4B-it, finetune.
- **Inference modes:** `/think` (reasoning on, emits `<think>…</think>` trace) and `/no_think` (low-latency direct classification).
- **Output:** `Prompt harm: harmful/unharmful` and `Response harm: harmful/unharmful`.
- **Taxonomy:** 22-category Nemotron Content Safety V2 (`S1 Violence` … `S22 Immoral/Unethical`).
- **Custom-policy support:** shipped — BYO policy is the model's headline feature.
- **Three deployment patterns:** vanilla safety / custom safety / topic-following.
- **Runtime:** vLLM · SGLang · TRTLLM. Ampere / Hopper / Blackwell. Linux / Windows.
- **Source:** [HuggingFace model card](https://huggingface.co/nvidia/Nemotron-Content-Safety-Reasoning-4B), [EMNLP 2025 paper](https://arxiv.org/abs/2505.20087).

## Model B — `nvidia/Nemotron-3-Content-Safety`

- **Modality / languages:** **multimodal** (text + image; SigLIP vision encoder, 896×896 square images) · **12 languages** (English, Arabic, German, Spanish, French, Hindi, Japanese, Thai, Dutch, Italian, Korean, Chinese).
- **Base:** Gemma-3-4B-it, LoRA-finetune merged.
- **Inference modes:** `/categories` (emit `Safety Categories: <comma-list>`) and `/no_categories` (omit category list), via the Transformers / vLLM chat-template kwarg `request_categories`; plus `/think` (reasoning on, emits `<think>…</think>` trace before classification) and `/no_think` (no trace, low latency). The two flag families are combinable — e.g., `/think` + `/categories` produces a reasoning trace plus the category list. Skill emits each combination cleanly.
- **Output:** `User Safety: safe/unsafe`, `Response Safety: safe/unsafe`, optional `Safety Categories: <list>`, optional `<think>…</think>` trace (when `/think` is set).
- **Taxonomy:** 23-category superset of V2 — same as Reasoning-4B plus `Other` inserted between `Needs Caution` and `Manipulation`. The model emits category *names*, not `Sn:` labels.
- **Custom-policy support:** supported — this skill produces policy artifacts customers can drop in directly. Combined with reasoning, Nemotron-3 is a multimodal + multilingual + reasoning + BYO-policy guardrail in one model.
- **Runtime:** Transformers · vLLM ≥ 0.11. RTX PRO 6000 BSE · H100 · A100. Linux.
- **Source:** [HuggingFace model card](https://huggingface.co/nvidia/Nemotron-3-Content-Safety).

## Differences the skill abstracts away

| Aspect | Reasoning-4B | Nemotron-3 (stock) | Nemotron-3 (+ this skill) |
|--------|--------------|--------------------|---------------------------|
| Modality | text | text + image | text + image |
| Languages | English | 12 | 12 |
| Reasoning flag | `/think` ↔ `/no_think` | `/think` ↔ `/no_think` | `/think` ↔ `/no_think` |
| Categories flag | (not applicable) | `/categories` ↔ `/no_categories` | `/categories` ↔ `/no_categories` |
| Combined modes | `/think` or `/no_think` only | any pair: e.g., `/think` + `/categories` | any pair, emitted cleanly per policy |
| Category labels | `S1`–`S22` | category names (no `Sn`) | category names (no `Sn`) |
| Output keys | `Prompt harm` / `Response harm` | `User Safety` / `Response Safety` / `Safety Categories` | same + optional `<think>` trace |
| Truthy value | `harmful` / `unharmful` | `unsafe` / `safe` | `unsafe` / `safe` |
| BYO custom policy | shipped | hand-authored | generated drop-in artifact |
| Image carve-outs | N/A | author manually per category | skill populates `modality_notes` per category |
| Locale carve-outs | one (US default) | author manually | skill populates per-locale |

The generated policy is **emit-mode-aware**: the JSON taxonomy records every category's name, V2 Sn label (when canonical), severity (runtime concept), and modality/locale carve-outs. The system prompt template emits the right format for the chosen `target_model`.

## Severity (runtime concept, not model output)

Neither model emits severity directly; both return only a binary harmful/unsafe verdict plus a category label or list. For how the skill's S0–S4 bands are recorded and consumed at runtime, see [How severity maps to model output](content_safety_taxonomy.md#how-severity-maps-to-model-output).
