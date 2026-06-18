# Setup USD Performance Tuning

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

## When to Use

Use this reference when runtime availability is unknown or the user explicitly asks to set up, verify, switch, or install the Kit, Scene Optimizer, or Asset Validator path.

## Instructions

1. Check for an existing `setup-preflight.json` and verify whether it matches the current target and runtime intent.
2. Probe available Kit, Scene Optimizer, Asset Validator, and standalone USD Python paths without silently choosing between viable alternatives.
3. Ask the user before installing or switching runtimes when no verified path satisfies the request.
4. Write or refresh the preflight artifact with runtime versions, paths, and available Scene Optimizer operations.


## Pre-flight Checklist

Before executing setup/preflight, re-read and confirm:

- [ ] `references/runtime-context-header.md` — runtime context block format.
- [ ] `references/runtime-probe.md` — probe sequence and failure handling.
- [ ] Output workspace policy from parent `references/output-workspace.md`.
- [ ] Write `setup-preflight.json` conforming to `scripts/setup-preflight.schema.json`.
## Output Format

Return the selected runtime route, any user decision needed, and the path to `setup-preflight.json`. The preflight artifact records Kit, Scene Optimizer, Asset Validator, USD Python, and `operationsAvailable` evidence.

Use this reference before running validation, profiling, or optimization from this
skill package in a fresh environment. The goal is to choose and verify one
runtime path before invoking the workflow skills.

## When this is the entry skill

This reference is the **named entry skill** in an agent's response only when no
runtime path is verified at all — that is, when the setup probe reports every
candidate (Kit, standalone Scene Optimizer, standalone Asset Validator) as
unavailable, missing, or unverified. In that case there is no way to route
performance work, so resolving the runtime is the agent's first responsibility.

As soon as **any** runtime path is verified — even partial availability such
as `kit_runtime: available, asset_validator: available, scene_optimizer:
unavailable` — the named entry skill is `omniverse-usd-performance-tuning`, not this one.
Triage then routes to the correct outcome, including blocking on a specific
missing component when needed. This reference still runs in its normal Phase 0
position; it just isn't the entry skill the agent names.

For `omniverse://` assets, `omniverse-authentication` is the named entry skill
ahead of both setup and triage. Authentication preflight precedes runtime
probing for remote assets.

This rule is about **which skill the agent names as the entry**, not about
execution order. Setup, authentication, and triage continue to run in their
normal phase order regardless.

## Purpose

Identify and verify a single Kit or standalone runtime path for profiling,
validation, and Scene Optimizer execution before downstream references run.

## Prerequisites

- Current shell access to probe local installs.
- Any user-provided Kit, USD Composer, Isaac Sim, or standalone library path.
- Permission to run lightweight Python import probes from candidate runtimes.

## Examples

- "Set up this repo before I run validation."
- "Check whether my Kit path can run Scene Optimizer and Asset Validator."

## Runtime choices

**Prefer standalone SO + AV when available.** The standalone path is lighter
(no Kit overhead), deterministic, and sufficient for all optimization and
validation workflows. The SO package includes
`omni.scene.optimizer.validators` with `@register_rule` decorators that
auto-register 25 SO performance validators into OAV when both packages share
the same Python 3.12 environment. No manual `register_all()` call is needed
for rule discovery — just ensure both are importable. Selected runs go through
`usd-validation-runner/scripts/usd_validation_executor.py`, which uses
`ValidationEngine(init_rules=False)` plus `enable_rule()` after resolving each
scope-note **canonical concept** to a rule class by identity.

> Standalone achieves the same validator coverage as Kit: install
> `omniverse-asset-validator` via pip into the same venv where the SO package
> is on PYTHONPATH, and the `@register_rule` decorators register SO validators
> at import time.

Fall back to Kit (USD Composer, Isaac Sim, or Kit SDK) when standalone packages
are not available or the user explicitly requests it. Kit runs OAV and SO in
one runtime and additionally supports render-time profiling. When taking the
Kit path, validation must use `omni.asset_validator.core` from that same Kit
runtime. Do not require `uv` or `omni_asset_validate` on `PATH` for the Kit
path.

## Requirement-to-skill map

- Existing Kit or USD Composer runtime: verify in this reference; do not install.
- Missing Kit runtime: invoke `install-kit`.
- Scene Optimizer inside Kit: invoke `install-so-via-kit` when missing.
- Standalone Scene Optimizer operations: invoke `install-so-standalone` when
  the extracted `scene_optimizer_core_...release.zip` package is missing.
- Standalone Omni Asset Validator: invoke `install-asset-validator-standalone`
  when missing. SO validators auto-register when both packages share the same
  Python environment.

## Output workspace contract

Everything this reference writes goes under the user's `output_path` (see
`references/runtime-context-header.md` *Where artifacts live*):

- `<output_path>/setup-preflight.json` — canonical name + location for
  the runtime config consumed by every downstream skill. **Do not write
  it under any other filename or location** (no `probe_result.json`, no
  `_work/`, no temp dirs). Downstream skills check this exact path; a
  different name leaves the session-start gate broken.
- `<output_path>/scripts/probe_setup.py` — the generated Python probe
  driven through Step 3.
- `<output_path>/scripts/probe_setup.log` and
  `<output_path>/scripts/probe_setup.stderr.log` — probe stdout / stderr.

Follow `skills/omniverse-usd-performance-tuning/references/runtime-artifact-token-budget.md`
for all probe logs. Parse the JSON object from stdout, keep the full stdout /
stderr files on disk, and surface only bounded tails or targeted error matches
when troubleshooting Kit launch noise.

If `output_path` is not yet known when this reference is invoked, prompt the
user for it before proceeding. Do not pick a default and do not write
to the working directory.

## Step 1 - Determine standalone runtime

The agent performs setup checks directly from the current shell. Do not rely on
repo-local setup scripts or ask the user to run scripts.

Check for standalone Scene Optimizer and Asset Validator packages first —
they are the preferred runtime (lighter, no Kit overhead, deterministic).
Follow `references/standalone-runtime.md` for discovery and verification.

If standalone packages are found and importable, set
`runtime_route: "standalone"` in `<output_path>/setup-preflight.json` and
continue to Step 1.6.

If standalone packages are not found, fall through to Step 1.5 (Kit discovery).

## Step 1.5 - Determine Kit candidates (fallback)

If standalone is unavailable, look for Kit installations. Follow
`references/kit-discovery.md` for discovery order, path classification,
auto-enumeration, and candidate records.

Always ask before broad filesystem scanning. If one Kit candidate exists, write
it to `runtime_context.kit` and continue. If multiple candidates exist, ask the
user to choose; never silently pick one in an interactive session. The newest
candidate is pre-selected.

Record the chosen candidate and `runtime_context.kit.chosen_by` as described in
`references/kit-discovery.md`.

## Step 1.6 - Probe the chosen Kit for SO and AV versions

Once `runtime_context.kit` is set (or standalone is chosen), run the Python
probe from the chosen launcher and write the probe result to
`<output_path>/setup-preflight.json`. Follow `references/runtime-probe.md` for
the launcher, import-mode, version-source, and `operationsAvailable` contract.

The `runtime_context` object is the literal input to the header template in
`references/runtime-context-header.md`. Downstream skills read from this object,
not from the raw probe `kit` / `sceneOptimizer` / `assetValidator` source
fields.

Downstream skills (`so-run-operations`, `omniverse-usd-performance-tuning`, every
`so-interpret-validators` recommendation) cross-check `operationsAvailable`
against the op key they intend to invoke and refuse to call any op the
runtime does not register.

## Step 2 - Interpret status

- `ready-standalone`: use standalone Scene Optimizer for operations and Omni Asset Validator from Python.
- `ready-kit`: use Kit for Scene Optimizer and `omni.asset_validator.core` validation from the same Kit runtime.
- `needs-runtime-choice`: stop and ask the user for a decision.

When status is `needs-runtime-choice`, ask exactly for one of these paths:

- Provide the path to standalone SO / AV packages or a pip-installable environment.
- Provide the path to an existing Kit or USD Composer install.

Do not continue to `so-run-validators`, `so-run-operations`, or deep validation
until this choice is resolved.

## Non-interactive (batch / CI) mode

The "stop and ask" behaviors above — the `output_path` prompt, the multiple-Kit
chooser, and the `needs-runtime-choice` gate — assume an interactive session.
For unattended batch or CI runs the caller can pre-supply those inputs, and the
agent must then proceed without blocking:

- If `output_path`, a runtime preference, and any required candidate paths are
  all supplied, do not prompt.
- When the preference is `auto`, resolve the runtime by deterministic policy:
  1. Standalone Scene Optimizer + Asset Validator, if importable.
  2. A user-supplied Kit / USD Composer / Isaac Sim path.
  3. The newest auto-discovered Kit — only when a broad filesystem scan was
     explicitly authorized for this run.
- Record `runtime_context.kit.chosen_by: auto_policy` (or
  `standalone_preferred`) in `setup-preflight.json` so downstream skills and the
  report can show the runtime was selected unattended rather than confirmed by a
  human.
- If no runtime resolves under this policy, stop with `needs-runtime-choice` and
  name the missing inputs — do not guess a runtime or scan without permission.

## Step 3 - Verify standalone path

If standalone is chosen (Step 1 succeeded), verify each standalone requirement
with its dedicated install reference. Follow `references/standalone-runtime.md` for
the user-facing prompt, Python 3.12 requirement, expected standalone layout,
and handoff rules.

## Step 4 - Verify Kit path (fallback)

For a Kit root (Step 1.5), verify Scene Optimizer and Omni Asset Validator core
both load, and capture the runtime versions that Step 1.6 surfaces to the user.
Use `references/runtime-probe.md` for the exact launcher, import, version, and
log discipline.

Do not pre-check extension folders, `exts/`, `extscache/`, or any other
filesystem layout before running the probe. If the probe fails, ask for a
different Kit path.

## Step 5 - Continue workflow

After setup:

1. `omniverse-usd-performance-tuning` for broad performance requests.
2. `usd-structure-assessment` before choosing optimizations.
3. `usd-validation-runner` for validation; its references own the specific `validate-*` command details.
4. `so-run-validators`, `so-interpret-validators`, and `so-run-operations` only after runtime setup is ready.

Record the chosen runtime path in the response so later commands use the same
Kit or standalone environment.

## Step 6 - Print the runtime context header before continuing

Every downstream user-facing prompt must lead with the runtime context block
defined in `references/runtime-context-header.md`. This reference writes the
canonical `runtime_context` object into
`<output_path>/setup-preflight.json` (see *Output workspace contract*);
downstream references consume it from that exact path.

The header has two formats:

- **Format A (full block)** — required at this reference's runtime-choice prompt,
  at the `restructure-decision` Phase 2e prompt, at the `so-run-operations`
  destructive-op confirmation, and at the first user-facing message of any
  session that starts mid-workflow.
- **Format B (compact one-liner)** — used for routine status messages and
  follow-up prompts once the user has already seen Format A in the session.

When `runtime_context.kit` is set (single candidate or user has picked), print
Format A once as the conclusion of this reference's interaction with the user, before the
agent hands off to `omniverse-usd-performance-tuning`. The user must see exactly which Kit
application, Scene Optimizer, and Asset Validator version will be in effect
for the rest of the session.

## Limitations

- Does not install unless a dedicated install reference is invoked.
- Does not choose optimization operations or validator scope.
- Standalone SO validators auto-register via `@register_rule` decorators when
  both `omniverse-asset-validator` and the SO package are importable in the
  same Python 3.12 environment. Kit auto-registers them via its extension
  session.

## Troubleshooting

- If standalone packages are found but the probe fails (import error, version mismatch), fall through to Kit discovery.
- If multiple valid Kit installs are found, ask the user to choose or record the newest unattended choice.
- If the Kit probe cannot import Scene Optimizer or Asset Validator, try another Kit path.
- If standalone paths are incomplete, invoke the relevant install reference instead of reusing a bundled validator environment.
