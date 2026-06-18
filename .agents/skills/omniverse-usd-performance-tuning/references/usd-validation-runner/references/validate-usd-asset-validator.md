<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Validate USD Asset Validator

## Purpose

Run the selected NVIDIA Omniverse Asset Validator checks from the
`usd-validation-runner` scope note and summarize findings. This reference owns
runtime invocation only; scoping, approval gates, full-sweep policy, masked
spot-check policy, and large-stage thresholds live in
`../README.md`.

## Prerequisites

- `setup-usd-performance-tuning` has selected a Kit or standalone validation
  runtime.
- Minimum USD openability has passed, or the runner explicitly asked this
  reference to perform only that runtime check.
- The Phase 2c scope note names selected rules, target paths or masks,
  skipped/approved full-sweep status, and artifact paths.
- Runtime artifact handling follows `../../runtime-artifact-token-budget.md`.

## Workflow

1. Use the runtime selected by setup; do not invent or switch runtimes.
2. Probe the selected CLI/API help before choosing flags or output formats.
3. Enable only the rules named in the scope note.
4. Ask before full sweep if the runner scope note does not already record
   explicit exhaustive approval.
5. Store raw outputs on disk and write a compact summary before reading results
   into context.
6. Feed summarized findings to `so-interpret-validators` and the optimization
   report.

## Runtime Selection

| Runtime | Use | Notes |
|---|---|---|
| Kit | Setup selected Kit, USD Composer, or a Kit venv; remote `omniverse://` validation; or same-runtime Scene Optimizer validation. | Import `omni.asset_validator.core` inside the selected Kit process. Do not require `uv` or `omni_asset_validate` on `PATH`. |
| Standalone | Setup selected a project-managed `omniverse-asset-validator` environment. | Use the selected Python/CLI. Do not use the Scene Optimizer package's bundled `validator-venv` as the preferred runtime. |

Report `blocked_missing_dependency` only when setup cannot provide either
runtime and the user did not approve installation or selection.

## Runtime detection (not rule selection)

`omni_asset_validate --help` may be used to confirm a runtime exists. Do **not**
use the CLI to select which validators run: CLI `--rule` flags take bare names,
which cannot disambiguate the Scene Optimizer and Asset Validator rules that
share a class name. Concept selection and execution always go through the
canonical executor (`scripts/usd_validation_executor.py`), which resolves by
identity. Prefer CSV when JSON output is not advertised by the selected runtime.

## Kit API Pattern

Inside Kit, start Kit with the validation extension enabled, then run via the
executor — do not hand-roll engine setup or enable rules by name:

```python
from usd_validation_executor import validate_concepts, run_scope_note
```

`validate_concepts` / `run_scope_note` import `omni.asset_validator.core`,
construct the engine with `init_rules=False`, and enable only the resolved rule
classes for the scope note's canonical concepts. Do not construct the engine
with default/all-rule initialization unless exhaustive validation was explicitly
approved.

## Standalone API Pattern

In standalone environments, use the same executor entry points. It imports
`omni.asset_validator.core`, falling back to `omni.asset_validator` if needed,
and fails closed with `ValidationRuntimeUnavailable` when neither is importable.
Concepts come from the scope note; never enable rules by bare name.

## Masks And Load Behavior

When the scope note calls for a representative spot check, use target files or
`Usd.Stage.OpenMasked()`. Preserve the default prim, include material or
relationship closure paths when material rules are selected, and verify the
masked stage still exposes relevant mesh-bearing content.

Do not rely on `LoadNone` as the validator scoping mechanism. See
`../README.md` → `Asset Validator Load Rules`.

## Output Report

Record:

- provider, version, command/API path, and runtime path
- scope, selected rules, target paths, masks, and approvals
- raw artifact paths and compact summary paths
- issue counts grouped by severity and rule; include provider category only as
  lookup metadata when the runtime emits it
- failures, warnings, skipped checks, timeouts, and limitations

Do not paste complete validator rows into the user-facing report.

## Pass/Fail Policy

Fail only for tool/runtime failure, unreadable stage, schema violation, or
explicit conformance failure. Performance opportunities are findings, not
command failures.

## Limitations

- CLI flags and Python APIs vary by installed runtime/version.
- This reference reports Asset Validator findings only; it does not apply
  `--fix` or repair USD content unless the user explicitly asks for auto-repair.
- Scene Optimizer performance validators run through `so-run-validators` when
  setup verifies `omni.scene.optimizer.core`.
- Spot checks are optimization evidence, not formal full conformance coverage.

## Troubleshooting

- If imports fail, return to setup and select or install a supported runtime.
- If the CLI lacks a desired output flag, use an advertised format.
- If validation stalls, stop at the approved budget, keep partial artifacts, and
  narrow the next scope through the runner.

## Next Steps

Pass compact findings to `so-interpret-validators`. Revalidate same-or-narrower
after mutation unless the user approves expansion.
