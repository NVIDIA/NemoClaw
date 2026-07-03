<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Typed-Shell Runner Retirement

PR #5106 retired the typed-shell target runner as part of #5098 Phase 0.
The follow-up E2E cleanup removed the remaining bash/script entry points,
renamed the Vitest workflow to `.github/workflows/e2e.yaml`, and moved the
target files under `test/e2e/`.

## Current Cleanup

- `.github/workflows/e2e-vitest-scenarios.yaml` moved to
  `.github/workflows/e2e.yaml`.
- `.github/workflows/e2e-script.yaml` and `.github/actions/run-e2e-script/`
  were removed.
- The top-level `test/e2e/test-*.sh` entry points were removed.
- `test/e2e-scenario/` moved under `test/e2e/`.
- `tools/e2e-scenarios/` moved to `tools/e2e/`.
- Vitest projects are `e2e-support` for fixture/support tests and `e2e-live`
  for opt-in live target execution.
- Manual dispatch uses `targets` and `jobs`, and live artifacts are written
  under `e2e-artifacts/live`.

## Helper Cleanup

The closeout audit promoted repeated shell quoting into the shared E2E command
fixture. E2E tests and helper modules that need shell-safe interpolation should
use `shellQuote` from `test/e2e/fixtures/clients/command.ts`, which re-exports
the production implementation in `src/lib/core/shell-quote.ts`.

Other repeated-looking helpers should only move into `test/e2e/fixtures/` when
they share the same input/output contract. Local helpers that format a
test-specific result shape, preserve a target's narrative failure message, or
bind cleanup to one live system boundary should stay with that test.

## Earlier Typed-Shell Removal

- `.github/workflows/e2e-scenarios.yaml`
- `.github/workflows/e2e-all.yaml`
- `test/e2e/registry/compiler.ts`
- `test/e2e/registry/orchestrators/`
- `test/e2e/registry/assertions/`
- `test/e2e/registry/probes/`
- `test/e2e/nemoclaw_registry/`
- `test/e2e/onboarding_assertions/`
- `test/e2e/validation_suites/`
- `test/e2e/runtime/lib/`
- `test/e2e/runtime/reports/`
- `scripts/e2e/lint-conventions.ts`

## Why

The project chose Vitest fixtures as the target execution model in #4941.
Keeping the typed-shell runner meant maintaining a second execution path with
its own compiler, phase orchestration, shell workers, suite dispatcher, and
workflows.

Before deleting that path, the surviving E2E workflow gained the reporting
and artifact shape operators needed from the retired workflows:

- dispatch-time matrix summary with Target, Runner, and Label columns;
- per-target `run-plan.json`;
- per-phase `environment.result.json`, `onboarding.result.json`, and
  `state-validation.result.json`;
- per-target step summary rendered from `run-plan.json`;
- explicit artifact upload allowlist with action, log, shell command-evidence,
  and JSON summary paths plus 14-day retention.

## What Replaced It

- `test/e2e/registry/run.ts --emit-live-matrix` emits the live
  GitHub Actions matrix.
- `.github/workflows/e2e.yaml` runs the live matrix.
- `test/e2e/live/registry-targets.test.ts` executes supported
  registry targets through the E2E workflow.
- `test/e2e/fixtures/` owns fixtures, clients, shell-probe bridges,
  artifact writing, cleanup, and redaction.

## Direct E2E Entry Points

Direct E2E implementations now live in Vitest. The former
`test/e2e/test-*.sh` entry points are removed instead of preserved as a second
suite or script-shaped dispatch layer.

The security, messaging, install, platform, and lifecycle contracts that the
deleted typed-shell validation suites used to mirror now live in E2E tests
under `test/e2e/live/`, focused CLI tests under `test/`, and the shared
fixture layer under `test/e2e/fixtures/`. Workflows invoke those
E2E targets directly.
