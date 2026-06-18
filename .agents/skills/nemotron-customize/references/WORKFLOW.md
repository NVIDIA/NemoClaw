# Nemotron Customize Workflow

Use this reference when `SKILL.md` says to run the full pipeline workflow or
Explorer mode. Start from bundled references; use `src/nemotron/steps/...` only
to verify exact live manifests, checked-in configs, runner imports, or details
missing from the references.

## Table Of Contents

- [Phase 1: Orient](#phase-1-orient)
- [Phase 2: Plan](#phase-2-plan)
- [Phase 3: Act](#phase-3-act)
- [Explorer Mode](#explorer-mode)
- [Phase 4: Verify](#phase-4-verify)

## Phase 1: Orient

Goal: enumerate candidate steps and gather constraints in one pass.

Read these first:

- `CATALOG.md`
- `ARTIFACTS.md`
- `PATTERNS.md`
- `HARDWARE.md` when hardware is in scope
- `COMMANDS.md` when the user asks for runnable commands

Verify via the CLI when available. If `CATALOG.md` already identifies a single
step, skip broad list calls and go straight to `steps show <step_id>`.

```bash
uv run nemotron steps list --json
uv run nemotron steps list --json --category sft
uv run nemotron steps list --json --consumes training_jsonl
uv run nemotron steps list --json --produces checkpoint_megatron
uv run nemotron steps show <step_id>
```

For each candidate step, verify the live `step.toml` only when you are about to
write YAML, emit a final command, or resolve a field missing from
`CATALOG.md`. Focus on `[[consumes]]`, `[[produces]]`,
`[[parameters]]`, `[[strategies]]`, `[[errors]]`, and `[reference]`. Read
category/step READMEs only as fallback for nuance not already captured in
bundled references.

Before planning, collect the selected-step constraints from `COMMANDS.md` and
the user's goal. Ask for missing values instead of assuming them.

## Phase 2: Plan

Produce a markdown plan the user reviews before code or config changes.

Include:

- `Intent`
- `Stages`
- `Validation`
- `Infrastructure`

For each stage, list the step id, input source, output artifact, 2-3 key
parameters, matched `step.toml` strategies, and matched patterns. Use a Mermaid
graph for artifact flow.

Hard checks:

- Artifact types chain via `ARTIFACTS.md`; verify with
  `types.toml` before execution-sensitive changes.
- Tokenizer, chat template, and sequence length align across prep and train.
- RL stages warm-start from an SFT-compatible checkpoint.
- GPU count satisfies the selected model and training stack.
- Applicable patterns from `PATTERNS.md` are cited.

If a check fails, surface it as `WARNING:` and propose a fix. For too-small
hardware, suggest smaller model, then AutoModel, then LoRA, before full
Megatron-Bridge fine-tuning.

Wait for user approval before Act. If new code is necessary, name the missing
repo capability and get approval for Explorer mode.

## Phase 3: Act

Prefer YAML-only changes for existing steps. No placeholders or TODOs.

Before creating code, identify the existing execution path:

- CLI commands under `src/nemotron/cli/`
- Step entrypoints in `src/nemotron/steps/<cat>/<step>/step.py`
- Shared runners in `src/nemotron/steps/_runners/`
- Existing configs under the selected step, recipe, or runner directory

For Catalog-mode customization, write each stage's config as a NEW file inside
that step's own `config/` directory:

```text
src/nemotron/steps/<cat>/<step>/config/<descriptive-name>.yaml
```

For example a Super3 SFT run adds
`src/nemotron/steps/sft/megatron_bridge/config/my_super3.yaml`. Never edit the
checked-in `default.yaml`/`tiny.yaml` or other shipped step files; only add new
config files beside them. Always stay within the step catalog under
`src/nemotron/steps/`; do not route to alternate recipe CLIs such as
`src/nemotron/cli/commands/super3/`.

YAML must match fields read by the existing `step.py` and runner, base on the
checked-in `default.yaml` schema rather than inventing keys, use user-provided
paths and environment choices, and preserve artifact compatibility from the
approved plan.

## Explorer Mode

Use Explorer mode only when no existing callable step, runner, CLI, recipe, or
YAML config surface can satisfy the request.

Load:

- `references/act/PROJECT.md`
- `references/act/STAGE.md`
- The relevant context pack from `references/context/index.toml`, if mapped
- The closest `src/nemotron/steps/<cat>/<step>/step.py`
- The relevant shared runner, if the step imports one

Implement the narrowest missing stage. Mirror existing `step.py` shape, type
consumes/produces with `ARTIFACTS.md` plus live `types.toml`
verification, and report files written, exposed knobs, UPSTREAM notes, and
followed strategies. If the same Explorer build keeps appearing, suggest
contributing a catalog step under `src/nemotron/steps/`.

## Phase 4: Verify

Check before reporting completion:

- Every generated YAML file parses and uses fields supported by the step/runner.
- Stage output artifact types match the next stage's input types.
- Existing CLI or runner commands can consume the generated configs.
- Exceptional code has valid Python syntax and imports real repo modules.
- README commands, if written, match actual configs.
- Smoke configs use reduced iters, batch sizes, or max steps.
- Tokenizer and sequence length align across prep and training configs.
- Standalone YAML does not leak `${art:...}` references unless a recipe path
  explicitly requires them.

Fix verification issues before reporting completion.
