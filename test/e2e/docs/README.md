<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw E2E

End-to-end tests organized around **setup scenarios** rather than
one-off shell scripts. A scenario declares *how you got to a working
NemoClaw* (platform + install + runtime + onboarding); a scenario
resolves to an **expected state** contract; once that state validates,
one or more **suites** run functional assertions against it.

```text
setup scenario → expected state → suite sequence
```

The declarative sources of truth live in three files — read these
first, they are short and deliberately not redundant with prose:

- [`../nemoclaw_scenarios/scenarios.yaml`](../nemoclaw_scenarios/scenarios.yaml)
  — platforms, installs, runtimes, onboarding choices, and the
  concrete scenarios that combine them.
- [`../nemoclaw_scenarios/expected-states.yaml`](../nemoclaw_scenarios/expected-states.yaml)
  — reusable structural contracts (gateway health, sandbox status,
  inference routing, etc.).
- [`../validation_suites/suites.yaml`](../validation_suites/suites.yaml)
  — ordered validation steps, each with a `requires_state` predicate.

## Layered scenario model

The E2E source of truth is layered as base environment, onboarding profile,
test plan, expected state, and post-onboard suites. Test plans can also declare
onboarding assertions that run after install/onboard and before expected-state
validation.

Plan-only resolution accepts either an alias or a test plan ID:

```bash
bash test/e2e/runtime/run-scenario.sh ubuntu-repo-cloud-openclaw --plan-only
bash test/e2e/runtime/run-scenario.sh ubuntu-repo-docker__cloud-nvidia-openclaw --plan-only
```

## How to run

```bash
bash test/e2e/runtime/run-scenario.sh <id> --plan-only       # resolve + print plan, no side effects
bash test/e2e/runtime/run-scenario.sh <id> --dry-run         # helpers short-circuit with trace
bash test/e2e/runtime/run-scenario.sh <id> --validate-only   # assume setup done; validate expected state
bash test/e2e/runtime/run-scenario.sh <id>                   # full live run
bash test/e2e/runtime/run-suites.sh <suite-id> [<suite-id>…]
bash test/e2e/runtime/coverage-report.sh                     # Markdown matrix of scenario × suite
```

Override the runtime context dir with `E2E_CONTEXT_DIR=<path>` (default
`.e2e/`, gitignored). The scenario runner and suites communicate only
through `$E2E_CONTEXT_DIR/context.env` — suites do not rediscover
setup state.

## Where things live

```text
test/e2e/
  docs/                              # README.md, MIGRATION.md
  nemoclaw_scenarios/                # declarative scenario inputs + setup machinery
    scenarios.yaml / expected-states.yaml
    install/       # install dispatcher + one file per install profile
    onboard/       # onboard dispatcher + one file per onboarding profile
    fixtures/      # reusable stubs (fake-openai, fake-{telegram,discord,slack}, older-base-image)
    helpers/       # scenario-side shell utilities (e.g. emit-context-from-plan.sh)
  validation_suites/                 # suite definitions and outcome assertions
    suites.yaml
    sandbox-exec.sh
    assert/        # outcome assertions (inference, credentials, policy, messaging)
    smoke/ inference/ hermes/ platform/ security/   # suite scripts grouped by concern
  runtime/                           # entry points + cross-cutting shared libs
    run-scenario.sh / run-suites.sh / coverage-report.sh
    resolver/      # TypeScript: load, plan, validate, coverage (invoked via tsx)
    lib/           # shared shell helpers: context, env, cleanup, logging, artifacts, sandbox-teardown
```

The CI entry point is `.github/workflows/e2e-scenarios.yaml` (manual dispatch). Existing legacy workflows (`nightly-e2e.yaml`, `macos-e2e.yaml`, `wsl-e2e.yaml`, etc.) remain in place during the migration.

Migration coverage is tracked through the layered scenario definitions, suite inventory, and the domain migration issues linked from issue #3588. Do not add a workflow-level parity report or assertion-ledger gate; use focused code review and the scenario coverage report to decide what to migrate next.

## How to add a scenario, state, or suite

Add-a-scenario, add-a-state, and add-a-suite are short edits to the
three YAML files above, plus shell scripts under
`nemoclaw_scenarios/install/`, `nemoclaw_scenarios/onboard/`,
`validation_suites/assert/`, or `validation_suites/<category>/`. The
schemas in
[`../runtime/resolver/schema.ts`](../runtime/resolver/schema.ts)
describe the required shape; `run-scenario.sh <id> --plan-only`
validates your change without running anything destructive.

When adding a suite assertion, emit or preserve a stable `PASS: <id>` /
`FAIL: <id>` log line, and update migration coverage through the scenario coverage report and the domain issues under `#3588`. Sandbox lifecycle assertions should use `validation_suites/lib/sandbox_lifecycle.sh`, consume `$E2E_CONTEXT_DIR/context.env`, and keep destructive snapshot restore checks isolated in the opt-in `snapshot-lifecycle` suite. Platform-specific scenarios such as GPU, macOS, WSL, Brev, or DGX Spark must also list `runner_requirements` in `scenarios.yaml`.

Prefer new scenario-matrix coverage over new legacy-style `test-*.sh` scripts.
