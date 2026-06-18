# Calibration Examples

Three reference interactions showing expected tone, pacing, and phase
discipline. Read when you're unsure how to pace a conversation or how much to
say at each phase. Don't read on every turn.

---

## Example 1 — Minimal interaction, simple SFT

```
user: Fine-tune Nano3 on my JSONL dataset

A: Two options for Nano3 SFT:

| | Megatron-Bridge | AutoModel |
|---|---|---|
| Min GPUs | 8 H100 | 4 |
| Data format | Packed Parquet (needs data_prep step) | JSONL directly |
| LoRA support | Config flag | Built-in |

Which fits your setup? And how many GPUs do you have?

user: I have 8 H100s, let's use Megatron-Bridge

A: Got it. I'll build a 3-stage pipeline:
1. data_prep/sft_packing → pack your JSONL to Parquet
2. sft/megatron_bridge → Nano3 SFT (tp=4, pp=1, cp=2)
3. eval/model_eval → benchmark the result

Let me read the step manifests and draft the plan.
[reads manifests, produces plan, waits for approval]
```

---

## Example 2 — Complex interaction with strategy firing

```
user: I need to translate English data to Thai, then fine-tune Nano3,
      then run RL with GRPO

A: That's a 6-stage pipeline. Let me read the bundled catalog, artifact graph,
and patterns, then verify the selected live manifests.

[reads references/CATALOG.md, references/ARTIFACTS.md, references/PATTERNS.md,
then relevant live step.toml/config files for verification]

Here's the plan:

# Pipeline Plan: thai-nano3-sft-rl
## Stages
1. curate/nemo_curator   → filtered_jsonl
2. translate/nemo_curator → translated_jsonl
3. data_prep/sft_packing → packed_parquet
4. sft/megatron_bridge   → checkpoint_megatron
5. rl/nemo_rl/rlvr       → checkpoint_megatron (RL-tuned)
6. eval/model_eval       → eval_results

## Validation
✓ All artifact types chain
✓ Tokenizer consistent (Nano3 across data_prep + SFT + RL)
WARNING: RL needs 16+ GPUs (2 nodes) — do you have that?
WARNING: translate needs an LLM endpoint (NIM or vLLM) — do you have one?

Approve this plan, or want changes?
```

---

## Example 3 — Explorer mode, no pre-built step

```
user: I want to distill Llama-70B into 8B

A: There's no pre-built distillation step in the catalog. Let me check the libraries.

[reads Megatron-Bridge/LIBRARY.md]

Megatron-Bridge supports distillation — see docs/training/distillation.md and
examples/distillation/. I'll build this in Explorer mode: the distillation
stage will be written from library docs rather than a catalog step, so it'll
need more validation.

What's your target architecture for the 8B model? And what GPUs do you have?
```
