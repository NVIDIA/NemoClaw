<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw E2E scenario framework

NemoClaw's scenario E2E framework is currently a **hybrid** migration model.
It combines typed scenario builders, product-facing setup manifests, YAML
runtime metadata, and reusable shell suites while the older live E2E scripts
continue to run in parallel.

## Current sources of truth

Use the source that matches the task:

| Task | Current source |
| --- | --- |
| Scenario workflow fan-out and dry-run planning | `test/e2e-scenario/scenarios/registry.ts`, `test/e2e-scenario/scenarios/scenarios/baseline.ts`, and `test/e2e-scenario/scenarios/run.ts` |
| Product-facing desired setup/onboarding state | `test/e2e-scenario/manifests/*.yaml` |
| Shell runner scenario resolution and live scenario execution | `test/e2e-scenario/nemoclaw_scenarios/scenarios.yaml`, `expected-states.yaml`, and `validation_suites/suites.yaml` |
| Reusable live suite assertions | `test/e2e-scenario/validation_suites/` |
| Existing nightly and platform E2E coverage | legacy `test/e2e/test-*.sh` scripts and their workflows |

The migration goal is to keep these surfaces aligned while progressively moving
coverage into scenario contracts and suites. Do not add new legacy-style
`test/e2e/test-*.sh` entrypoints unless there is a specific maintainer-approved
reason.

## Layered scenario model

The conceptual model is layered:

```text
base environment
  → onboarding profile / manifest
    → onboarding assertions
      → expected state
        → post-onboard suites
```

The YAML shell runner expresses this through:

- `base_scenarios`: platform + install + runtime
- `onboarding_profiles`: user onboarding choices
- `test_plans`: base + onboarding + expected state + suites
- `setup_scenarios`: friendly aliases and compatibility metadata
- `onboarding_assertions`: setup/onboarding checks that run before suites

The typed scenario registry expresses the same intent as deterministic code and
is used by the scenario workflow matrix and dry-run plan artifacts.

## How to run

```bash
# YAML/shell scenario runner
bash test/e2e-scenario/runtime/run-scenario.sh <id> --plan-only
bash test/e2e-scenario/runtime/run-scenario.sh <id> --dry-run
bash test/e2e-scenario/runtime/run-scenario.sh <id> --validate-only
bash test/e2e-scenario/runtime/run-scenario.sh <id>

# Suite runner against an existing scenario context
bash test/e2e-scenario/runtime/run-suites.sh <suite-id> [<suite-id>...]

# Scenario metadata coverage report
bash test/e2e-scenario/runtime/coverage-report.sh

# Typed scenario registry / workflow dry-run path
npx tsx test/e2e-scenario/scenarios/run.ts --list
npx tsx test/e2e-scenario/scenarios/run.ts --scenarios <id> --plan-only
npx tsx test/e2e-scenario/scenarios/run.ts --scenarios <id> --dry-run
npx tsx test/e2e-scenario/scenarios/run.ts --emit-matrix
```

Override the runtime context directory with `E2E_CONTEXT_DIR=<path>` (default
`.e2e/`, gitignored). The shell scenario runner and suites communicate through
`$E2E_CONTEXT_DIR/context.env`; suites should not rediscover setup state.

## Repository layout

```text
test/e2e-scenario/
  docs/                              # This guide and migration notes
  manifests/                         # Product-facing NemoClawInstance desired state
  scenarios/                         # Typed builders, registry, compiler, assertions, dry-run orchestration
  nemoclaw_scenarios/                # YAML runtime metadata and setup helpers
    scenarios.yaml
    expected-states.yaml
    install/
    onboard/
    fixtures/
    helpers/
  validation_suites/                 # Suite definitions and shell assertion steps
    suites.yaml
    smoke/
    inference/
    messaging/
    platform/
    security/
    sandbox/
  runtime/                           # Shell runner, suite runner, resolver, coverage report, shared libs
    run-scenario.sh
    run-suites.sh
    coverage-report.sh
    resolver/
    lib/
```

## CI entry points

- `.github/workflows/e2e-scenarios.yaml` runs typed scenario dry-runs for
  manually selected scenario IDs.
- `.github/workflows/e2e-scenarios-all.yaml` fans out typed scenario dry-runs
  from the typed registry matrix.
- Existing workflows such as `nightly-e2e.yaml`, `e2e-branch-validation.yaml`,
  `macos-e2e.yaml`, `wsl-e2e.yaml`, `ollama-proxy-e2e.yaml`, and
  `regression-e2e.yaml` still run legacy live E2E scripts during the migration.
- `vitest.config.ts` contains the `e2e-scenario-framework` project for framework
  and metadata tests.

## Migration tracking

Migration status is tracked outside the repository in GitHub issues and PRs,
not in repo-local checklists. The parent architecture issue is #3588. Active
audit-coverage work is tracked by the #4347–#4357 issue set, with focused
follow-ups such as #4378 for specific drift fixes.

The old workflow-level parity report has been removed. Use scenario framework
tests, the coverage report, PR review, and the audit issues to decide what to
migrate next.

When adding a suite assertion, emit or preserve a stable `PASS: <id>` /
`FAIL: <id>` log line, and record migration evidence or follow-up state in the
owning issue or PR. Sandbox lifecycle assertions should use
`validation_suites/lib/sandbox_lifecycle.sh`, consume
`$E2E_CONTEXT_DIR/context.env`, and keep destructive snapshot restore checks
isolated in the opt-in `snapshot-lifecycle` suite. Platform-specific scenarios
such as GPU, macOS, WSL, Brev, or DGX Spark must also list
`runner_requirements` in `scenarios.yaml`.

Prefer new scenario-matrix coverage over new legacy-style `test-*.sh` scripts.
