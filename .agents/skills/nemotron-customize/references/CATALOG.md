# Nemotron Step Catalog

Use this as the first-line routing reference for `/nemotron-customize`.
After selecting a likely step here, verify the exact live contract with the
CLI and source files only when you need current fields, checked-in config names,
or runner behavior.

## Table Of Contents

- [Selection Rules](#selection-rules)
- [Step Summary](#step-summary)
- [Category Notes](#category-notes)
- [Fallbacks](#fallbacks)

## Selection Rules

- Pick an existing catalog step before considering new code.
- Route by artifact contract first: downstream `consumes` decides upstream `produces`.
- Compose multi-step pipelines by artifact matching, not by fixed recipes:
  start from the requested end goal, then walk backward through `ARTIFACTS.md`,
  inserting whichever step produces the input type the next step consumes. Add
  prerequisite steps (data cleaning, packing/prep, conversion, eval) only when a
  downstream `consumes` type is not already available upstream. Do not hardcode
  named step combinations; derive every chain from the goal and the artifact graph.
- Each step is independent and selected on its own merits; the agent stitches
  steps together. A given step never implies a fixed predecessor or successor.
- Use AutoModel for HF-native JSONL, small GPU counts, quick LoRA, and direct HF output.
- Use Megatron-Bridge for packed Parquet, bin/idx, multi-node parallelism, Nano3/Super3 recipe parity, and Megatron checkpoints.
- LoRA/PEFT on a HuggingFace base with a small GPU count (about 1-8 GPUs) routes
  to `peft/automodel`. Use `peft/megatron_bridge` only when the base is a
  Megatron checkpoint or the run needs packed Parquet plus multi-node
  parallelism. When the user says LoRA/PEFT + HF model + few GPUs and gives no
  Megatron signal, the answer is `peft/automodel` (do not offer Megatron-Bridge
  as the default).
- Use `data_prep/sft_packing` before `sft/megatron_bridge` or `peft/megatron_bridge`; skip it for AutoModel SFT/PEFT.
- Use `data_prep/pretrain_prep` before either pretraining backend.
- Use `data_prep/rl_prep` when RL data starts as HF references, blends, or needs sharding/materialization.
- Route light Curator smoke tests, cleaned local JSONL output, permissive
  filtering, and first-pass IO/schema validation to `curate/nemo_curator`.
  Require concrete `input_glob` and `output_dir` before a runnable command.
- Route direct corpus translation to `translate/nemo_curator`. It consumes
  `filtered_jsonl`, so any upstream producing translation-ready JSONL (curation,
  SDG, or a user corpus) satisfies it; insert an upstream step only when the
  input is not yet translation-ready.
- HARD GUARD (overrides artifact composition): MCQ, multiple-choice, or any
  benchmark/evaluation dataset routes to `byob/mcq` for BOTH creation and
  translation — never `translate/nemo_curator`, even when the user says
  "translate". `translate/nemo_curator` is for plain training corpora only; it
  flattens MCQ structure (question/options/answer_index) and breaks the
  benchmark. Trigger on: "MCQ", "multiple choice", "benchmark", "eval set",
  "questions and options", or any `answer`/`answer_index` schema. When unsure
  whether data is a benchmark, ask before routing.
- Insert conversion only when adjacent stages disagree on checkpoint type.
- Bookend quality-changing stages with `eval/model_eval`.

## Step Summary

| Step | Use When | Consumes | Produces | Configs | Key Knobs / Notes |
|---|---|---|---|---|---|
| `byob/mcq` | Generate or translate domain MCQ benchmarks while preserving answer indexes and row identity. | `benchmark_source_corpus`; optional `benchmark_parquet` | `mcq_benchmark_parquet`; optional `translated_mcq_benchmark_parquet` | `default`, `tiny`, `translate` | `family=mcq`, `stage=prepare/generate/translate/all`, `target_source_mapping`, translation settings. Final rows keep `question_id`, `question`, `options`, `answer_index`, `answer`, `cot_content`, `src`, `category`. |
| `curate/nemo_curator` | Filter raw/local/HF JSONL before translation, SFT prep, or pretrain prep; use for light Curator smoke tests and cleaned local JSONL output. | `raw_jsonl` | `filtered_jsonl` | `default`, `tiny` | Start with `dataset=null`, `language_codes=[]`, `domains=[]`, and `quality_filters={}` until reader/writer IO and schema are verified. |
| `translate/nemo_curator` | Translate plain JSONL/Parquet training corpora or chat messages. NOT for MCQ/benchmark/eval datasets -> those go to `byob/mcq`. | `filtered_jsonl` | `translated_jsonl` | `default` | Require source/target language, input/output paths, format, `text_field`, backend, and auth env-var names. Preserve user-provided globs exactly. Use `messages.*.content` with `reconstruct_messages=true` for chat. |
| `sdg/data_designer` | Generate synthetic SFT, tool-call SFT, or DPO preference data from seeds and declarative columns. | optional `training_jsonl` | `synthetic_jsonl` | `default`, `customer_support_tools`, `rl_pref`, `tiny` | Use preview/tiny before scale. `default` emits OpenAI messages, `customer_support_tools` emits tool-call records, `rl_pref` emits DPO preference rows. |
| `data_prep/sft_packing` | Pack chat JSONL for Megatron-Bridge SFT/PEFT. | `training_jsonl` | `packed_parquet` | `default`, `tiny` | `tokenizer`, `pack_size`, `chat_template`, split ratios, shard counts. `pack_size` must match downstream seq length. |
| `data_prep/pretrain_prep` | Tokenize text blends into Megatron bin/idx shards and `blend.json`. | `filtered_jsonl` | `binidx` | `default`, `tiny` | `blend_path`, tokenizer, shards, splits, `text_field`. Rebuild if tokenizer changes. |
| `data_prep/rl_prep` | Resolve HF references and shard prompt/preference data for RL. | `training_jsonl` | `training_jsonl` | `default`, `tiny` | Validate DPO chosen/rejected ordering and RLVR verifier fields before training. |
| `sft/automodel` | HF-format SFT on OpenAI-style chat JSONL, smaller GPU counts, direct HF output. | `training_jsonl` | `checkpoint_hf` | `default`, `tiny` | `model.pretrained_model_name_or_path`, `dataset.path_or_dataset_id`, `peft=null/lora`. Do not feed packed Parquet. |
| `sft/megatron_bridge` | Distributed SFT with packed Parquet and Megatron checkpoints. | `packed_parquet`; optional `checkpoint_megatron` | `checkpoint_megatron` | `default`, `tiny` | Nano3 default min 8 GPUs; Super3 min 32. Keep packed sequence size, data prep pack size, and model seq length identical. |
| `peft/automodel` | LoRA adapter tuning with HF base and direct JSONL, especially 1-4 GPUs. | `training_jsonl` | `checkpoint_lora` | `default`, `tiny` | Keep base model/tokenizer/rank/alpha provenance for later merge. |
| `peft/megatron_bridge` | LoRA over a Megatron base with packed Parquet and distributed parallelism. | `packed_parquet`, `checkpoint_megatron` | `checkpoint_lora` | `default`, `tiny` | Plan merge/export path up front; keep base, adapter, merged outputs separate. |
| `pretrain/automodel` | HF-native pretraining/CPT over bin/idx data. | `binidx` | `checkpoint_hf` | `default`, `tiny` | `load_weights=true` for CPT with lower LR; set dataset paths to emitted `blend.json`. |
| `pretrain/megatron_bridge` | Large distributed pretraining/CPT with TP/PP/CP/EP and Megatron output. | `binidx`; optional `checkpoint_megatron` | `checkpoint_megatron` | `default`, `tiny` | Use for large token budgets and recipe parity; keep token budget, seq length, and blend fixed. |
| `rl/nemo_rl/dpo` | Static preference-pair alignment. | `training_jsonl`, `checkpoint_megatron` | `checkpoint_megatron` | `default`, `tiny` | Data requires `prompt`, `chosen`, `rejected`; validate pair ordering. |
| `rl/nemo_rl/rlvr` | GRPO/RLVR with deterministic/verifiable rewards. | `training_jsonl`, `checkpoint_megatron` | `checkpoint_megatron` | `default`, `nemo_gym`, `tiny` | Data needs verifier fields such as answer/tests/env metadata. Use `nemo_gym` for resource-server rewards. |
| `rl/nemo_rl/rlhf` | RLHF with learned judge/GenRM reward model. | `training_jsonl`, `checkpoint_megatron`, `checkpoint_hf` | `checkpoint_megatron` | `default`, `tiny` | Keep policy, reference, reward model, NeMo-Gym server config, and prompt data separate. |
| `convert/hf_to_megatron` | A Megatron consumer needs an HF checkpoint. | `checkpoint_hf` | `checkpoint_megatron` | `default` | Convert clean model dirs, not logs/optimizer/adapters. Merge LoRA first when needed. |
| `convert/megatron_to_hf` | HF-native eval/deploy/optimize needs a Megatron checkpoint. | `checkpoint_megatron` | `checkpoint_hf` | `default` | Point at a concrete `iter_*` checkpoint, not the parent run directory. |
| `convert/merge_lora` | Produce a standalone checkpoint from a LoRA adapter and exact base. | `checkpoint_lora`, `checkpoint_hf`; optional `checkpoint_megatron` | `checkpoint_hf`; optional `checkpoint_megatron` | `default` | Merge only into the exact base used for adapter training. Evaluate adapter and merged outputs separately. |
| `optimize/modelopt/quantize` | FP8/NVFP4/PTQ for deployment footprint. | `checkpoint_hf` | `checkpoint_megatron` | `default`, `fp8`, `nvfp4`, `tiny` | H100/Hopper -> `fp8`; B200/Blackwell -> `nvfp4`; representative calibration is required for quality. |
| `optimize/modelopt/prune` | Structured architecture pruning or target-parameter search. | `checkpoint_hf` | `checkpoint_hf` | `default`, `tiny` | Use target params or exact export config, not both. Distill afterward if quality matters. |
| `optimize/modelopt/distill` | Teacher-student recovery or standalone distillation. | `checkpoint_hf`; optional `binidx` | `checkpoint_megatron` | `default`, `tiny` | Mock data is launch validation only. Teacher is usually the original BF16 checkpoint. |
| `eval/model_eval` | Hosted endpoint smoke/benchmark or Megatron checkpoint evaluation. | optional `checkpoint_megatron` | `eval_results` | `default`, `tiny_chat` | Use exact Launcher task IDs. Chat tasks need chat endpoints; logprob tasks need compatible completions/tokenizer support. |
| `env/env_toml` | Generate Lepton, Slurm, or DGX Cloud env profile TOML. | - | `env_toml` | `lepton`, `slurm`, `dgxcloud` | Keep site logistics in env TOML and step runtime flags in YAML. Export `NEMOTRON_ENV_FILE` for non-default env files. |

## Category Notes

### Curation, Translation, And Data Generation

- Curation is lightweight JSONL filtering: cleaning, language/word/domain
  filtering, smoke testing, or quality gating. It is a standalone step that
  stands on its own and feeds any downstream consumer of `filtered_jsonl`. Full
  crawling/dedup pipelines belong in dedicated Curator recipes unless a catalog
  step is added.
- Translation is a data step, not benchmark translation for MCQ artifacts. For chat/tool/code data prefer the `llm` backend; for large plain text and local service prefer `nmt`; for high-value data enable FAITH and keep scores.
- SDG must project to the downstream schema: OpenAI messages for SFT, structured messages for tool-call SFT, DPO preference rows for DPO.

### SFT And PEFT

- AutoModel paths consume JSONL directly and produce HF-format outputs or HF adapters.
- Megatron-Bridge paths consume packed Parquet and produce Megatron checkpoints or Megatron adapters.
- For small datasets, tight memory, or narrow changes, try LoRA before full SFT.
- Deterministic LoRA backend choice: HuggingFace base + LoRA/PEFT + about 1-8
  GPUs -> `peft/automodel`. Megatron base, packed Parquet, or multi-node scale
  -> `peft/megatron_bridge`. Do not present Megatron-Bridge as the default for
  the small-GPU HuggingFace LoRA case.
- Preserve tokenizer, chat template, base checkpoint, LoRA rank/alpha, and data blend provenance through merge/eval.

### Pretraining And CPT

- Data prep is mandatory: both backends consume bin/idx plus `blend.json`.
- CPT is a lower-LR, blend-sensitive run from existing weights; from-scratch pretraining uses a full token-budget schedule.
- Record target tokens, seq length, global batch size, train iters, LR schedule, checkpoint cadence, and validation slices before launch.

### RL

- DPO: static preference pairs only.
- RLVR: deterministic/programmatic verifier, tests, answers, or resource-server reward.
- RLHF: learned reward/judge model or GenRM path.
- All RL stages warm-start from a validated SFT `checkpoint_megatron`.

### Conversion, Optimization, Evaluation

- Convert only at real format boundaries.
- Optimization happens after source checkpoint eval, never before the customization is proven.
- Evaluation should surround SFT, RL, conversion, and optimization whenever quality is being claimed.

## Fallbacks

Use bundled references first:

1. This catalog for routing and step fit.
2. `ARTIFACTS.md` for type compatibility.
3. `COMMANDS.md` for run shapes, profile rules, and source tiers.
4. `PATTERNS.md` for cross-step guardrails.
5. `HARDWARE.md` for GPU/backend heuristics.

Fall back to source files only when:

- The bundled reference is missing a needed field or looks stale.
- You need exact current parameter names, config fields, smoke config names, or runner imports.
- You are about to write YAML or emit a command that must match the checked-in repo.

Source fallback order for a selected step: CLI `steps show/list` when available,
then `src/nemotron/steps/<step>/step.toml`, checked-in config YAML, step
README, `step.py`, and shared runner code.
