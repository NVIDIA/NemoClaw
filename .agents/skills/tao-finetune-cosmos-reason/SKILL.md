---
name: tao-finetune-cosmos-reason
description: Cosmos-Reason2-8B video QA supervised fine-tuning with FSDP parallelism. Use when training or evaluating video
  question-answering models, fine-tuning Cosmos-Reason2 with SFT, or working with Cosmos-RL. Trigger phrases include
  "fine-tune Cosmos-Reason", "Cosmos-RL SFT", "video QA fine-tune", "Cosmos-Reason2-8B training".
license: Apache-2.0
compatibility: Requires docker + nvidia-container-toolkit.
metadata:
  author: NVIDIA Corporation
  version: "0.1.0"
allowed-tools: Read Bash
tags:
- video
- qa
- cosmos
- sft
- reasoning
- vlm
---

# Cosmos-RL

Supervised fine-tuning (SFT) of **nvidia/Cosmos-Reason2-8B** on video reasoning tasks. Pretrained weights are sourced from HuggingFace, not NGC. This is a **gated model** — requires `HF_TOKEN`.

Uses FSDP-based parallelism with `dp_shard_size` for GPU count and `dp_replicate_size` for node count (not the standard `num_gpus`/`num_nodes`).

## When to Use

Use this skill to train, evaluate, quantize, or run inference on Cosmos-Reason2-8B for video question-answering and video reasoning. The core workflow is: confirm `HF_TOKEN` gating, sample annotations for `video_fps`, load the spec template, apply the critical train overrides below, then launch through the platform skill (or AutoML when enabled).

## Dataclass Schemas

Generated TAO Core schemas are packaged in `schemas/<action>.schema.json`, with `schemas/manifest.json` listing available actions. Each generated schema also emits `references/spec_template_<action>.yaml` from the schema top-level `default` field. AutoML enablement is declared at the model layer in `references/skill_info.yaml` via `automl_enabled`. Runnable AutoML still requires `schemas/train.schema.json` and `references/spec_template_train.yaml` to exist and parse. Use the packaged train schema for `automl_default_parameters`, `automl_disabled_parameters`, defaults, min/max bounds, enums, option weights, math conditions, dependencies, and popular parameters. Do not expect `~/tao-core` at runtime; maintainers regenerate schemas/templates before packaging the skill bank.

## Train Action Policy

This model is AutoML-enabled at the model layer. Before handling any train-stage request, read `references/skill_info.yaml` and resolve the run override from either an explicit `automl_policy` value or the user's workflow request. Treat phrases like "turn off AutoML", "disable AutoML", "no HPO", or "plain training" as `automl_policy: off` for this run only; otherwise default to `auto`. When `automl_policy: auto`, `automl_enabled: true`, and both `schemas/train.schema.json` and `references/spec_template_train.yaml` are packaged, route the train action through `tao-skill-bank:tao-run-automl` by default with this model's `skill_dir`. Preserve workflow/application overrides for datasets, specs, output directories, GPU/platform settings, parent checkpoints, and `automl_policy`. Use direct model training only when `automl_policy: off` or the packaged train schema/template is missing; in the missing-schema case, report that AutoML is enabled but not runnable for this model until schemas are generated.

Non-train actions such as `evaluate`, `inference`, `export`, and deploy flows stay in this model skill. The per-run `automl_policy` override does not change model metadata.

## Credentials

- **HF_TOKEN** (required): HuggingFace access token. The user must accept the model agreement at <https://huggingface.co/nvidia/Cosmos-Reason2-8B> and provide a token with read access. Passed to the container as a `docker_env_var`.

## Datasets

Dataset type is **vlm** in **llava** format; accepted intents are training, evaluation, and testing. Inputs may be dataset roots (root mode maps `<root>/annotations.json` plus `<root>` as the media path) or direct spec-key paths (when annotations and media live in different locations). Before launching train/AutoML/evaluate, sample the annotation JSON and require `video_fps` in each record — missing `video_fps` makes the Cosmos-RL SFT loader fail with `Error processing sample: 'video_fps'` after the job starts. Stop before runner generation if it is absent and ask the user to fix the annotation files; do not start AutoML to discover this inside torchrun.

See `references/datasets.md` for the full training requirements, the launch intake reminder (spec-key options, root-mode mapping, container-image confirmation, and the `check_tao_launch_preflight.py` invocation), the Per-Action Dataset Requirements table, the `data_sources` mapping with direct-override examples, and the eval-dataset / auto-split policy.

## Spec Construction

cosmos-rl is `mode: config`. **Always start from `references/spec_template_train.yaml`** (or `spec_template_evaluate.yaml` for evaluate) — load it via `yaml.safe_load(...)` and apply user overrides on top. The spec the model consumes is **nested dicts**, not flat dotted keys; the dotted override notation denotes paths into the nested spec, so walk the path and assign at the leaf. Data source overrides are **mandatory for every action** and must be built from the Per-Action Dataset Requirements table in `references/datasets.md`.

See `references/spec-construction.md` for the load-template-then-override pattern and the full typical override blocks for train (including `policy.model_max_length=81920`, `dp_shard_size`/`dp_replicate_size`, and LoRA `lora_alpha`/`r`/`lora_dropout`), evaluate, quantize, and inference, plus the note that `custom.val_dataset` leaf keys are valid even when absent from the default spec object.

## Critical Overrides (Train)

These are the keys whose template defaults are wrong or where omission flips the run into a different mode:

| Parameter | Template Default | Required Value | Why |
|---|---|---|---|
| `policy.model_name_or_path` | `nvidia/Cosmos-Reason2-8B` | `hf_model://nvidia/Cosmos-Reason2-8B` (or local checkpoint) | The bare HF id makes cosmos-rl fetch from HF Hub at runtime; the `hf_model://` URI form pre-downloads the weights before the training command starts |
| `policy.model_max_length` | 40960 | Keep at 40960 or higher | Smaller than ~40k causes `vision_embeds` shape mismatch on video inputs |
| `train.train_batch_per_replica` | 32 | Any multiple of `train.train_policy.mini_batch` | Mismatch raises an immediate AssertionError |
| `train.train_policy.type` | `"sft"` | Keep as `"sft"` for SFT workflows | If dropped during agent regeneration, cosmos-rl flips to RL mode → rollout replica allocated → multi-node attempted → hostname errors when `num_nodes=1` |

## Parameters

`train.train_batch_per_replica` must be divisible by `train.train_policy.mini_batch`; `policy.model_max_length` must be 40960 or higher for video SFT; `policy.parallelism.dp_shard_size` should equal GPUs per node and `dp_replicate_size` the node count; `custom.vision.fps` and `custom.vision.nframes` are mutually exclusive (set exactly one). Cosmos-RL models are 8B parameters and benefit from multi-GPU FSDP sharding — recommended: 8x A100 or H100 (80GB each).

See `references/parameters.md` for the complete parameter reference: training loop, model & policy, parallelism (including multi-node guidance and platform-skill pointers), optimization & data loading, vision encoders (fps vs nframes details and the decord/torchvision failure mode), checkpointing, validation, logging, and hardware.

## Evaluate

The evaluator reads a **flat TOML** config with top-level keys `dataset`, `model`, `task`, `evaluation`, `vision`, `generation`, `metrics`, `results`, `num_gpus`, `results_dir`. Task type is `""` (General Evaluator, auto-detects binary yes/no classification and computes TP/FP/TN/FN/accuracy/precision/recall/F1) or `"its_directionality"` (left/right/straight; do NOT use for collision detection). The `actions.evaluate` block in `references/skill_info.yaml` declares inputs and outputs; for SDK invocation see `skills/platform/tao-run-platform/SKILL.md`.

See `references/evaluate.md` for the config-format detail, task-type notes, LoRA evaluation (checkpoint path via `spec_overrides` with `model.enable_lora`/`model.base_model_path` and adapter merge behavior), selective download (`{annotation, format, keys}` partial media pull), and the results format and metrics.

## Error Patterns

Common failures include CUDA OOM in train (reduce `mini_batch` or raise `dp_shard_size`), OOM during LoRA evaluation, NaN loss, the `vision_embeds` shape mismatch (raise `model_max_length` to 40960), `train_batch_per_replica` not divisible by `mini_batch`, `train_batch_per_replica` larger than samples per rank (the `'NoneType' object has no attribute 'state_dict'` 0-step crash), stale dataset cache after changing fps/total_pixels, and the gated-repo authentication loop.

See `references/troubleshooting.md` for the full diagnosis and fix for each error pattern.

## DEFT Support and Parent-Model Inference

Cosmos-RL implements the DEFT workflow contract for video QA tasks (see `config.json` and `workflow/deft/deft.md`). Gap analysis via `scripts/analyze_gaps.py` reads cosmos-rl `results.json`, compares predictions by exact string match after `.lower().strip()`, and emits a parquet of failure cases — so eval prompts must force short constrained answers. Model-specific parent-model inference mappings (evaluate/inference/quantize/train spec fields → inference functions, checkpoint metadata, and `parent_job_id` handling) live in the reference, not in `config.json`.

See `references/deft-and-inference-mappings.md` for the gap-analysis detail and limitation, and the full parent-model inference mapping table.
