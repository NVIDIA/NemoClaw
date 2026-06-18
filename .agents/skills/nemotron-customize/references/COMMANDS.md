# Run Command Reference

Use this file after the catalog selects a step. Keep answers short by reading
only the section that matches the selected step and then verifying live repo
details only when execution accuracy depends on them.

## Source Tiers

- **Verified**: CLI manifest/config/profile were read and a dry-run or render check succeeded.
- **Repo-grounded**: manifest/config/profile were read, but no dry-run was run.
- **Reference-grounded**: bundled references identify the right step and run shape, but exact repo files or profiles were not verified.
- **Blocked**: a required repo file, config, profile, runtime variable name, or
  user input is missing. Name the blocker and stop before guessing.

## Discovery

1. Confirm repo root has `pyproject.toml` and `src/nemotron/steps/`.
2. If `CATALOG.md` identifies one step, verify that step directly and skip
   broad listing.

```bash
uv run nemotron steps list --json
uv run nemotron steps list --json --category <category>
uv run nemotron steps show <step_id>
```

3. If CLI discovery is unavailable, use `CATALOG.md` first and fall back to
   `src/nemotron/steps/STEPS.md` only for current live details.
4. For exact command output, read the selected checked-in config or user overlay
   before finalizing.

## Required Inputs

Collect only fields needed by the selected step:

- All runs: selected step ID, config alias or config path, input path, output
  path, and local vs remote execution intent.
- Training/prep/RL: model or checkpoint, data schema, tokenizer/template where
  relevant, sequence length when packing/training, hardware/GPU count, and
  checkpoint save/load paths.
- Translation/eval with hosted services: endpoint/model identifiers, source
  and target task settings, runtime-visible paths, and the variable name the
  runtime uses for service access. Name the variable, never its value.
- Conversion/optimization: source checkpoint layout, output path, model/config
  source, target hardware, and calibration/distillation data when quality is in
  scope.

If a required value is missing, ask for it or return `Blocked`.

For user-provided paths, preserve the exact value including globs, extensions,
and mount prefixes. Do not simplify `/data/news/*.jsonl` to `/data/news`.

## Run Shapes

Do not present these as runnable until every placeholder has a user-provided or
repo-verified value.

```bash
uv run nemotron steps run <step_id> -c <config-or-path> --dry-run
uv run nemotron steps run <step_id> -c <config-or-path> --dry-run --batch <profile>
uv run nemotron steps run <step_id> -c <config-or-path> --batch <profile>
```

For direct CLI overrides, append `key=value` pairs after the command:

```bash
uv run nemotron steps run <step_id> -c <config-or-path> --dry-run key=value nested.key=value
```

Use `uv run --no-sync` only when the local environment has already been synced
and current project docs recommend avoiding sync overhead.

### Required callouts in every command answer

- Hosted services (translation, hosted eval): name the auth env-var (for
  example `NVIDIA_API_KEY`) and state that its value must be exported in the
  environment, never inlined in the command, config, or commit. Never print the
  value.
- Remote execution (`--batch`/`--run`): an env TOML profile is a prerequisite.
  State the profile name and source (`NEMOTRON_ENV_FILE` or `env*.toml`). If no
  profile exists, return `Blocked` or fall back to a local `--dry-run` shape and
  say so explicitly.
- Expensive or destructive launches: confirm before recommending execution
  without `--dry-run`.

## Profile Rules

- Do not invent `--batch` names.
- Read `NEMOTRON_ENV_FILE` when set; otherwise inspect repo-root `env.toml` or
  `env.*.toml` candidates.
- Pick an actual section whose backend/resources match the selected step.
- Remote execution requires a profile. If none exists, return `Blocked` or emit
  a local dry-run command without `--batch`, and state the prerequisite.
- Follow `SKILL.md` Safety before inspecting hosted-service or private runtime
  settings.
- Never run or recommend broad environment dumps such as `env`, `printenv`,
  `set`, or broad `export` listings.

## Step Command Patterns

These are base patterns, not guaranteed runnable commands. Verify live fields
and replace placeholders before final output.

| Route | Step | Base command |
|---|---|---|
| Env profile generation | `env/env_toml` | `uv run nemotron steps run env/env_toml -c <lepton-or-slurm-or-dgxcloud> output_path=<env-file>` |
| Curator JSONL cleaning | `curate/nemo_curator` | `uv run nemotron steps run curate/nemo_curator -c <config> --dry-run input_glob=<raw-jsonl-glob> output_dir=<cleaned-output-dir>` |
| Corpus translation | `translate/nemo_curator` | `uv run nemotron steps run translate/nemo_curator input_path=<input> output_dir=<output> source_language=<src> target_language=<tgt> backend=<backend>` |
| BYOB MCQ benchmark | `byob/mcq` | `uv run nemotron steps run byob/mcq -c <config> --dry-run stage=<prepare-generate-translate-or-all> family=mcq` |
| SFT packing | `data_prep/sft_packing` | `uv run nemotron steps run data_prep/sft_packing -c <config> --dry-run` |
| Pretrain prep | `data_prep/pretrain_prep` | `uv run nemotron steps run data_prep/pretrain_prep -c <config> --dry-run` |
| RL prep | `data_prep/rl_prep` | `uv run nemotron steps run data_prep/rl_prep -c <config> --dry-run` |
| AutoModel SFT/PEFT | `sft/automodel`, `peft/automodel` | `uv run nemotron steps run <step-id> -c <config> --dry-run` |
| Megatron-Bridge SFT/PEFT | `sft/megatron_bridge`, `peft/megatron_bridge` | `uv run nemotron steps run <step-id> -c <config> --dry-run` |
| Pretraining/CPT | `pretrain/automodel`, `pretrain/megatron_bridge` | `uv run nemotron steps run <step-id> -c <config> --dry-run` |
| RL alignment | `rl/nemo_rl/dpo`, `rl/nemo_rl/rlvr`, `rl/nemo_rl/rlhf` | `uv run nemotron steps run <step-id> -c <config> --dry-run` |
| Checkpoint conversion | `convert/hf_to_megatron`, `convert/megatron_to_hf`, `convert/merge_lora` | `uv run nemotron steps run <step-id> -c default --dry-run` |
| ModelOpt | `optimize/modelopt/quantize`, `optimize/modelopt/prune`, `optimize/modelopt/distill` | `uv run nemotron steps run <step-id> -c <config> --dry-run` |
| Evaluation | `eval/model_eval` | `uv run nemotron steps run eval/model_eval -c <config> --dry-run` |

## Translation Examples

These are high-signal examples for the non-obvious translation flags. Replace
paths, languages, model, and service URL with user-provided or repo-verified
values before final output.

If the user gives all required values and asks only for the command, emit only
the command block.

Plain text records:

```bash
uv run --no-sync nemotron steps run translate/nemo_curator \
  input_path="$TR_ROOT/news_en" \
  output_dir="$TR_ROOT/out_llm_hi" \
  source_language=en \
  target_language=hi \
  backend=llm \
  text_field=text \
  output_mode=replaced \
  merge_scores=false \
  reconstruct_messages=false \
  faith_eval.enabled=false \
  server.url="$TRANSLATION_BASE_URL" \
  server.model="$TRANSLATION_MODEL" \
  server.api_key_env=NVIDIA_API_KEY
```

Chat records:

```bash
uv run --no-sync nemotron steps run translate/nemo_curator \
  input_path="$TR_ROOT/chat_en.jsonl" \
  output_dir="$TR_ROOT/out_chat_hi" \
  source_language=en \
  target_language=hi \
  backend=llm \
  text_field='messages.*.content' \
  output_mode=replaced \
  merge_scores=false \
  reconstruct_messages=true \
  faith_eval.enabled=false \
  server.url="$TRANSLATION_BASE_URL" \
  server.model="$TRANSLATION_MODEL" \
  server.api_key_env=NVIDIA_API_KEY
```

For FAITH quality checks, keep the same run shape and add a short handoff:
state whether `faith_eval.enabled` is true, where quality scores will be
written, and whether low-score rows should be kept, filtered, or sent for
review.

## Evaluation Examples

Hosted/existing endpoint smoke test (no training, `deployment.type=none`). Use
`tiny_chat` for chat endpoints; replace URL, model id, and task IDs with
user-provided or verified values. Name the key env-var, never its value.

```bash
uv run nemotron steps run eval/model_eval -c tiny_chat --dry-run \
  target.api_endpoint.url="$EVAL_ENDPOINT_URL" \
  target.api_endpoint.model_id=<hosted-model-id> \
  target.api_endpoint.type=chat \
  target.api_endpoint.api_key_name=NVIDIA_API_KEY \
  'evaluation.tasks=[{name: <exact-launcher-task-id>}]' \
  evaluation.nemo_evaluator_config.config.params.limit_samples=1
```

Megatron checkpoint evaluation uses `-c default` with
`deployment.checkpoint_path=<iter_*>`. Logprob/multiple-choice tasks also need
`...extra.tokenizer=<tokenizer>`; chat tasks need a chat endpoint. Task IDs must
come from `nemo-evaluator-launcher ls tasks` or the checked-in config, never
guessed.

## Common Sequences

Build sequences by artifact matching, not fixed recipes: chain a step only when
the next step consumes an artifact type that nothing upstream already produces
(see `ARTIFACTS.md`). The items below are hard prerequisites that follow from
the artifact graph, not discretionary combinations.

- A step that consumes `packed_parquet` (Megatron-Bridge SFT/PEFT) requires
  `data_prep/sft_packing` first; AutoModel consumes JSONL directly and needs no
  packing.
- A step that consumes `binidx` (pretraining/CPT) requires
  `data_prep/pretrain_prep` first; preserve the emitted `blend.json`.
- Insert a converter only when adjacent stages disagree on checkpoint type.
- Add `eval/model_eval` around a stage only when a quality claim is being made.
