<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw E2E Fixtures

NemoClaw E2E now has one target execution model, Vitest as the harness and
GitHub Actions as the matrix. Vitest owns discovery, filtering, timeouts,
reporters, fixture lifecycle, skips, and CI integration. NemoClaw owns the
domain layer: target metadata, phase fixtures, product clients, evidence
artifacts, redaction, cleanup, expected-state probes, and typed assertion
helpers.

The retired typed-shell target runner is documented in
[`RETIREMENT.md`](./RETIREMENT.md). Do not add new durable behavior to the old
YAML/bash runner shape.

Direct E2E implementations now live in Vitest. The former
`test/e2e/test-*.sh` entry points have been removed.

## Sources Of Truth

| Task | Source |
| --- | --- |
| Live target IDs and metadata | `test/e2e/registry/registry.ts`, `test/e2e/registry/definitions/baseline.ts` |
| GitHub Actions matrix emission | `test/e2e/registry/run.ts --emit-live-matrix` |
| Live target execution | `test/e2e/live/registry-targets.test.ts` |
| Phase fixtures and clients | `test/e2e/fixtures/` |
| Expected-state probes | `test/e2e/registry/expected-states.ts` |
| Product-facing setup/onboarding state | `test/e2e/manifests/*.yaml` |
| Migration status and retirement decisions | GitHub issues and pull requests |

## Target Model

The typed registry still describes targets as layered metadata:

```text
base environment
  -> onboarding profile / manifest
    -> expected state
      -> optional lifecycle profile
        -> suite metadata for migration tracking
```

Live execution happens through shared fixtures:

- `environment` checks CLI/install/runtime readiness.
- `onboard` performs supported onboarding profiles.
- `lifecycle` performs supported post-onboard mutations.
- `stateValidation` probes host-observable expected state.
- `artifacts`, `secrets`, `cleanup`, and `shellProbe` provide shared fixture
  services.

The `test/e2e/fixtures/` path is fixture/support code, not a test
harness or runner. Vitest remains the only test harness.

`suiteIds` remain metadata for reporting and migration planning. They do not
dispatch shell validation suites.

## How To Run

```bash
# List canonical target ids
npx tsx test/e2e/registry/run.ts --list

# Emit the GitHub Actions fan-out matrix payload
npx tsx test/e2e/registry/run.ts --emit-live-matrix

# Emit the matrix for selected target ids
npx tsx test/e2e/registry/run.ts --emit-live-matrix --targets ubuntu-repo-cloud-openclaw

# Fixture/support tests
npx vitest run --project e2e-support --silent=false --reporter=default

# Opt-in live E2E targets
npm run build:cli
NEMOCLAW_RUN_LIVE_E2E=1 npx vitest run --project e2e-live --silent=false --reporter=default

# Force two retries locally (three total attempts) for external-service flakes
NEMOCLAW_RUN_LIVE_E2E=1 NEMOCLAW_E2E_RETRIES=2 npx vitest run --project e2e-live
```

Live E2E projects retry failed tests automatically in CI. The default is
2 retries after the first failure (3 total attempts). Local opt-in runs default
to no full-test retry; set `NEMOCLAW_E2E_RETRIES=<count>` to override either
local or CI behavior. Overrides are capped at 5 retries so a typo cannot create
unbounded credentialed live infrastructure attempts.

The retired `--emit-matrix` and `--plan-only` paths must not be reintroduced.

## Repository Layout

```text
test/e2e/
  docs/                  # Fixture guide, migration notes, retirement record
  fixtures/              # Vitest fixtures, clients, redaction, artifacts, cleanup
  live/                  # Opt-in live E2E target tests
  manifests/             # Product-facing NemoClawInstance desired state
  registry/              # Typed registry, matrix helpers, expected states
  support/               # Fast fixture/support and metadata tests
```

## CI Entry Points

- `.github/workflows/e2e.yaml` runs selected or all supported
  live E2E targets and uploads an explicit artifact allowlist with
  JSON summaries plus action, log, and shell command-evidence directories under
  14-day retention.
- `.github/workflows/e2e-branch-validation.yaml`, `macos-e2e.yaml`,
  `wsl-e2e.yaml`, `ollama-proxy-e2e.yaml`, and `regression-e2e.yaml` call
  focused E2E targets directly for their E2E coverage.
- `vitest.config.ts` contains `e2e-support` for fast fixture/support
  tests and `e2e-live` for opt-in live target execution.

## Migration Tracking

Migration status is tracked outside the repository. GitHub issues and pull
requests are the source of truth for script-by-script state, ownership,
replacement E2E coverage, and retirement decisions.

GitHub issues and PRs own changing migration status. The key issues are:

- #3588: parent layered E2E architecture epic
- #4941: Vitest fixtures as the target execution model
- #4990: phase fixtures and registry-driven live discovery
- #5098: direct former bash-suite migration epic

The former repo-local migration ledger and generated assertion inventories are
removed because they duplicated live GitHub state and drifted quickly. The
durable guardrails are workflow contract tests and source-shape checks that
verify CI calls Vitest directly and the removed shell suite does not come back.

Prefer new E2E coverage in Vitest fixtures. When shell, installer, process,
platform, or full user-flow behavior is the contract, invoke that real boundary
from the E2E test rather than preserving a second durable runner.
