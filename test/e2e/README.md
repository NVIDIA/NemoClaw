<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# E2E Setup Scenario Matrix

This directory hosts NemoClaw's end-to-end tests, organized around **setup
scenarios** rather than per-workflow shell scripts.

## Core model

```text
setup scenario → expected state config → suite sequence
```

- A **setup scenario** describes how a user reaches a completed NemoClaw
  environment: platform, install method, runtime prerequisites, and
  onboarding choices. Defined in [`scenarios.yaml`](scenarios.yaml).
- An **expected state config** describes the observable contract the
  completed environment should satisfy. Defined in
  [`expected-states.yaml`](expected-states.yaml). Multiple scenarios can
  share one expected state.
- A **functional suite** is an ordered list of validation scripts run
  after setup completes and the expected state validates. Defined in
  [`suites.yaml`](suites.yaml). Suites consume `.e2e/context.env` and do
  not re-run install or onboarding.

The runner resolves a scenario, prints a plan, runs setup/install/
onboarding once, validates the expected state, and then runs the scenario's
ordered suites against the resulting environment.

## Sparse matrix

The initial matrix is deliberately sparse — three scenarios covering three
common setup paths:

| Scenario | Platform | Install | Runtime | Onboarding | Expected state |
|---|---|---|---|---|---|
| `ubuntu-repo-cloud-openclaw` | `ubuntu-local` | `repo-current` | `docker-running` | `cloud-openclaw` | `cloud-openclaw-ready` |
| `ubuntu-repo-cloud-hermes` | `ubuntu-local` | `repo-current` | `docker-running` | `cloud-hermes` | `cloud-hermes-ready` |
| `gpu-repo-local-ollama-openclaw` | `gpu-runner` | `repo-current` | `gpu-docker-cdi` | `local-ollama-openclaw` | `local-ollama-openclaw-ready` |

Additional scenarios (macOS, WSL, Brev/launchable, DGX Spark, negative
preflight) are migrated incrementally in later phases. The matrix is not
meant to be Cartesian — each scenario should exist because a real current
coverage path needs it.

## Files

```text
test/e2e/
  scenarios.yaml          # platforms, installs, runtimes, onboarding, scenarios
  expected-states.yaml    # reusable expected state contracts
  suites.yaml             # ordered suite definitions
  README.md               # this file
```

Runner scripts live alongside the metadata:

- `run-scenario.sh <id> [--plan-only|--dry-run]` resolves a scenario,
  prints the plan, writes `${E2E_CONTEXT_DIR:-.e2e}/plan.json`, and (in
  non-plan-only mode) drives setup → install → onboard → gateway check
  → sandbox check → expected-state validation. In `--dry-run` mode each
  helper short-circuits and emits a trace line to `E2E_TRACE_FILE` if
  set — useful for integration tests and for reviewing scenario wiring.
- `run-suites.sh <suite-id> ...` reads `.e2e/context.env` and runs one
  or more suites' ordered step scripts, failing fast on the first
  non-zero step and printing a PASS/FAIL summary.
- `coverage-report.sh` prints a Markdown coverage report. The
  `e2e-scenarios` workflow appends the same report to
  `GITHUB_STEP_SUMMARY`.

The TypeScript resolver lives under `resolver/` and is invoked via
`tsx resolver/index.ts {plan|validate-state|coverage}`. Shell wrappers
call it so runners and CI need only `bash`.

Overriding the artifact directory: set `E2E_CONTEXT_DIR=<path>` so local
runs and tests do not clobber the repo-root `.e2e/`. The directory is
gitignored.

## Adding a new setup scenario

1. Pick (or add) profiles for platform, install, runtime, and onboarding
   in `scenarios.yaml`. Reuse existing profiles when possible.
2. Add a scenario entry under `setup_scenarios:` with a kebab-case ID that
   encodes the distinguishing dimensions.
3. Reference exactly one `expected_state` (singular; string key).
4. List the `suites` to run, in execution order.
5. If an appropriate expected state does not exist, add one to
   `expected-states.yaml`. Keep keys structural, not behavioral.
6. If an appropriate suite does not exist, add one to `suites.yaml` and
   land its scripts under `suites/<suite-id>/`. Suites must consume
   `.e2e/context.env`, not rediscover scenario state.
7. Validate references with `bash test/e2e/run-scenario.sh <id> --plan-only`
   (once the resolver lands).

## Adding a new expected state

Add a new key under `expected_states:` in `expected-states.yaml`. Use
structural keys (e.g. `gateway.health`, `sandbox.status`, `inference.route`)
that suites can reference via `requires_state`. Negative / preflight states
are introduced only when a concrete scenario consumes them.

## Adding a new suite

Add a new key under `suites:` in `suites.yaml`:

- `requires_state`: dotted paths into an expected state that must be
  satisfied for the suite to run.
- `steps`: ordered list of `{ id, script }` entries with paths relative to
  this directory.

Keep suites narrowly scoped and idempotent. Suites must not install,
onboard, or otherwise mutate setup state.
