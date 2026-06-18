# Cross-Step Patterns

Use this reference to decide which cross-step guardrails to cite in plans and
README output. Fall back to `src/nemotron/steps/patterns/<id>.md` only when a
pattern's full detail is needed.

## Pattern Index

| Pattern | Trigger | Apply |
|---|---|---|
| `prep-data-is-tokenizer-locked` | Reusing packed Parquet or bin/idx after tokenizer, chat template, or sequence length changes. | Rebuild prepared data; keep prep and train tokenizer/template/seq length aligned. |
| `sft-sequence-packing` / `pack-variable-length` | Variable-length SFT examples, poor padding efficiency, Megatron-Bridge SFT. | Use `data_prep/sft_packing`; inspect loss masks and packed records. |
| `sft-small-dataset-prefer-lora` / `small-dataset-lora` | Fewer than 10K SFT examples, tight GPU budget, narrow behavior change. | Prefer PEFT/LoRA before full SFT. |
| `sft-data-blending` | Mixing capabilities, languages, synthetic, translated, or domain-specific SFT data. | Blend deliberately and re-evaluate after blend changes. |
| `multilingual-tokenizer-check` | Non-English or mixed-script training/translation data. | Audit tokenizer coverage before prep/training. |
| `translate-training-corpus` | Translation produces training data. | Insert `translate/nemo_curator` before prep/training; validate schema and row counts. |
| `prefer-llm-for-structured-chat` | Chat, JSON, tool-call, code, or formatting-heavy data. | Use `backend=llm`, translate natural language fields, preserve structure. |
| `prefer-nmt-for-large-corpora` | Large plain-text corpus and local NMT service available. | Use `backend=nmt`; verify `/health` and `/translate` contract. |
| `enable-faith-for-high-value-data` | Translation quality gates audit, governance, or high-value training data. | Enable FAITH, keep scores/metadata, tell user filtering can drop rows. |
| `data-quality-before-quantity` | More data is proposed to fix behavior, but corpus has noise/duplicates/labels issues. | Curate and inspect quality before scaling size. |
| `sdg-pipeline-versioning` | Synthetic data feeds SFT/RL or must be reproduced. | Version seeds, prompts, models, projection, config, and outputs together. |
| `rl-validate-rewards-before-scale` | DPO/RLVR/RLHF moving beyond tiny reward validation. | Validate reward/data path independently before rollout scale. |
| `eval-before-and-after-training` / `eval-bookends` | Any SFT, RL, optimization, conversion, or quality-changing stage. | Evaluate before and after with the same task set/settings. |
| `byob-benchmark-design` | Sovereign/domain deployment needs held-out evidence. | Build a target-domain BYOB benchmark separate from training data. |
| `custom-mcq-benchmark-byob` | Need MCQ benchmark from private/domain docs or translated benchmark preserving answer indexes. | Route to `byob/mcq`. |
| `checkpoint-before-convert` / `convert-checkpoint-safety` | Converting checkpoints or merging LoRA. | Convert from clean checkpoint dirs; keep source and output dirs distinct. |
| `peft-adapter-merge-discipline` | Adapter will feed deployment/eval as a standalone model. | Preserve exact base; validate adapter-loaded and merged artifacts separately. |
| `pretrain-token-budget-before-scale` | Planning pretraining/CPT beyond smoke. | Write token budget, seq length, GBS, train iters, LR schedule, and checkpoint cadence before launch. |
| `cpt-data-blend-scoping` | Continued pretraining on sovereign/domain corpus. | Scope domain/general blend ratios and forgetting checks. |
| `production-export-trt` | End goal is production serving efficiency. | Consider TensorRT-LLM export after checkpoint quality is proven. |

## Planning Rules

- Cite patterns that changed the DAG or config, not every potentially relevant pattern.
- If a pattern conflicts with a user request, surface it as `WARNING:` and propose the least-disruptive fix.
- Keep pattern names in generated READMEs so reviewers can trace decisions back to catalog rules.
- For source fallbacks, prefer pattern markdown over generic category README because patterns capture cross-step constraints.
