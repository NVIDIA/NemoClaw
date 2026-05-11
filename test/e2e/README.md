<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# E2E Setup Scenario Matrix

This directory hosts NemoClaw's end-to-end tests, organized around
**setup scenarios** rather than per-workflow shell scripts.

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

## Scenario catalog (current)

| Scenario | Platform | Install | Runtime | Onboarding | Expected state |
|---|---|---|---|---|---|
| `ubuntu-repo-cloud-openclaw` | `ubuntu-local` | `repo-current` | `docker-running` | `cloud-openclaw` | `cloud-openclaw-ready` |
| `ubuntu-repo-cloud-hermes` | `ubuntu-local` | `repo-current` | `docker-running` | `cloud-hermes` | `cloud-hermes-ready` |
| `gpu-repo-local-ollama-openclaw` | `gpu-runner` | `repo-current` | `gpu-docker-cdi` | `local-ollama-openclaw` | `local-ollama-openclaw-ready` |
| `macos-repo-cloud-openclaw` | `macos-local` | `repo-current` | `docker-running` | `cloud-openclaw` | `cloud-openclaw-ready` |
| `wsl-repo-cloud-openclaw` | `wsl-local` | `repo-current` | `docker-running` | `cloud-openclaw` | `cloud-openclaw-ready` |
| `brev-launchable-cloud-openclaw` | `brev-launchable` | `launchable` | `docker-running` | `cloud-openclaw` | `cloud-openclaw-ready` |
| `ubuntu-no-docker-preflight-negative` | `ubuntu-local` | `repo-current` | `docker-missing` | `cloud-openclaw` | `preflight-failure-no-sandbox` |

The matrix is deliberately not Cartesian — each scenario exists because a
real current coverage path needs it. Additional scenarios (e.g. onboard
resume, rebuild-preserves-presets) land incrementally; see
[`suites/*/README.md`](suites) for the roadmap informed by the UAT / NV QA
bug hotspot analysis.

## File layout

```text
test/e2e/
  scenarios.yaml          # platforms, installs, runtimes, onboarding, scenarios
  expected-states.yaml    # reusable expected state contracts
  suites.yaml             # ordered suite definitions
  README.md               # this file

  run-scenario.sh         # main entry; resolve → plan → setup → validate
  run-suites.sh           # suite step runner
  coverage-report.sh      # Markdown coverage matrix

  resolver/               # TypeScript plan + validator + coverage
    index.ts load.ts plan.ts schema.ts validator.ts coverage.ts
    js-yaml.d.ts

  lib/                    # shared shell scaffolding, organized by role
    artifacts.sh          # best-effort artifact collection
    cleanup.sh            # trap helpers (wraps sandbox-teardown.sh)
    context.sh            # .e2e/context.env key/value store
    emit-context-from-plan.sh
    env.sh                # non-interactive env + trace + dry-run
    install-path-refresh.sh   # (existing helper; preserved)
    sandbox-teardown.sh       # (existing helper; preserved)

    setup/                # dimension dispatchers
      install.sh          # e2e_install: repo-checkout | curl-install-script | ...
      onboard.sh          # e2e_onboard: cloud-openclaw | cloud-hermes | ...

    assert/               # outcome assertions
      gateway-alive.sh
      sandbox-alive.sh
      # (fixtures for inference-works, no-credentials-leaked, policy-preset-applied
      #  land with their first consuming suite.)

    fixtures/             # reusable scenario fixtures (see README for roadmap)

  suites/                 # functional suites, grouped by scenario area
    smoke/                # baseline: cli, gateway, sandbox, shell
    onboarding/           # onboarding lifecycle (Hermes today; more on the way)
    inference/            # cloud, ollama-gpu, ollama-auth-proxy
    security/             # credentials today; shields / rebuild-preserves-presets planned
    platform/             # macos, wsl (spark planned)
    # lifecycle/ sandbox/ messaging/ — dir + README committed; suites to land
```

## Runner contracts

- `run-scenario.sh <id> [--plan-only|--dry-run]`
  - `--plan-only`: resolve and print plan, write
    `${E2E_CONTEXT_DIR:-.e2e}/plan.json`. No install/onboard/suites.
  - `--dry-run` (`E2E_DRY_RUN=1`): helpers short-circuit; each one writes a
    trace line to `$E2E_TRACE_FILE` if set. The expected-state validator
    runs with `--probes-from-state` so the declared state acts as a fake
    probe source; targeted probe failures are simulated with
    `E2E_PROBE_OVERRIDE_<KEY>=value`.
  - Live mode (no flags): runs the full setup path. The validator requires
    real probe values; it fails closed rather than self-validating against
    the declared state.
- `run-suites.sh <suite-id> ...`: reads `.e2e/context.env`, runs one or
  more suites' ordered step scripts, fails fast on the first non-zero
  step, prints a PASS/FAIL summary.
- `coverage-report.sh`: prints a Markdown coverage report. The
  `e2e-scenarios` workflow appends the same report to
  `GITHUB_STEP_SUMMARY`.

The TypeScript resolver is invoked via
`tsx resolver/index.ts {plan|validate-state|coverage}`. Shell wrappers
call it so runners and CI need only `bash` + a lockfile-pinned `tsx`.

Override the artifact directory with `E2E_CONTEXT_DIR=<path>` so local
runs and tests do not clobber the repo-root `.e2e/`. The directory is
gitignored.

## Adding a new setup scenario

1. Pick (or add) profiles for platform, install, runtime, and onboarding
   in `scenarios.yaml`. Reuse existing profiles when possible.
2. Add a scenario entry under `setup_scenarios:` with a kebab-case ID that
   encodes the distinguishing dimensions. **The first segment must be the
   platform prefix** (e.g. `ubuntu-`, `macos-`, `wsl-`, `gpu-`, `brev-`)
   so the `e2e-scenarios.yaml` workflow can route the run to the correct
   runner.
3. Reference exactly one `expected_state` (singular; string key).
4. List the `suites` to run, in execution order.
5. If an appropriate expected state does not exist, add one to
   `expected-states.yaml`. Keep keys structural, not behavioral.
6. If an appropriate suite does not exist, add one to `suites.yaml` and
   land its scripts under `suites/<category>/<suite>/`. Suites must
   consume `.e2e/context.env`, not rediscover scenario state.
7. Validate references with `bash test/e2e/run-scenario.sh <id> --plan-only`.

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

## Roadmap (from UAT / NV QA bug hotspot analysis)

Placeholder READMEs under `lib/{setup,assert,fixtures}/` and
`suites/{onboarding,sandbox,lifecycle,security,messaging}/` track the
scenarios that migrate in next, informed by the 446 UAT / NV QA issues
traced during planning. Each README names the originating bug class and
the legacy script (where one exists) so rewiring and coverage gaps remain
visible in the repo.
