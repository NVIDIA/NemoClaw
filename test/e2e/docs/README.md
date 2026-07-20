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
npm run test:live-e2e -- --silent=false --reporter=default
```

The aggregate live command rebuilds the CLI before Vitest starts and runs live
test files serially.
Live E2E projects do not retry an entire failed test.
These tests mutate host, Docker, gateway, and sandbox state, so re-entering one
on the same runner can replace the original failure with stale-lock,
storage-exhaustion, or ownership noise. A target may retry a transient operation
only inside its own cleanup boundary.
Retry a full target by starting a fresh workflow run and runner.

The retired `--emit-matrix` and `--plan-only` paths must not be reintroduced.

When adding or changing a live test, update `test/e2e/mock-parity.json` with
the fast PR-collected test that covers its mockable contract. If the behavior
cannot be reproduced without real infrastructure, record a concise
`liveOnlyReason` instead. The PR and `main` CLI coverage shards enforce this
changed-file policy alongside the `e2e-support` project without requiring an
immediate backfill of untouched tests.

## Repository Layout

```text
test/e2e/
  docs/                  # Fixture guide, migration notes, retirement record
  fixtures/              # Vitest fixtures, clients, redaction, artifacts, cleanup
  live/                  # Opt-in live E2E target tests
  manifests/             # Product-facing NemoClawInstance desired state
  mock-parity.json        # Changed live-test to fast-test parity decisions
  registry/              # Typed registry, matrix helpers, expected states
  support/               # Fast fixture/support and metadata tests
```

## CI Entry Points

- `tools/advisors/risk-plan.mts` is the small deterministic selection policy
  shared by PR Review Advisor and the PR E2E controller. It maps
  changed runtime surfaces to invariant families and
  canonical `e2e.yaml` jobs; it is not a second test runner or migration-status
  ledger. The advisor uses it as recommendation context, while the controller
  applies it independently without model output.

- `.github/workflows/pr-e2e-gate.yaml` reserves the internal
  `E2E / PR Gate Coordination` check on every exact PR head, including forks,
  before `CI / Pull Request` completes. Its default-branch
  `pull_request_target` path also publishes the native GitHub Actions job named
  `E2E / PR Gate`. The read-only observer runs from `github.workflow_sha`,
  validates the live PR head and base, waits for the matching trusted
  coordination identity, and mirrors the terminal verdict into the required
  job. Its summary is static, while the job log includes the validated trusted
  controller-run link. Authorization states remain pending while the maintainer
  decision is recorded. During rollout, the observer also accepts the former
  `E2E / PR Gate` custom-check name for the same exact-diff identity. The
  controller builds the risk plan from GitHub's complete file list. Internal
  revisions normally dispatch every selected job and verify each expected
  `risk-signal.json`; this remains automatic when their `e2e-control-plane`
  matches are drawn only from the trusted controller workflow and scripts.
  Other or mixed internal
  control-plane revisions require a maintainer-authorized exact-SHA run; only
  its verified evidence can pass coordination. Risky forks retain the audited
  credentialed-E2E skip approval. See [NemoClaw E2E CI](../README.md) for the
  full lifecycle.

- `.github/workflows/e2e.yaml` runs selected or all supported
  live E2E targets and uploads an explicit artifact allowlist with
  JSON summaries plus action, log, and shell command-evidence directories under
  14-day retention.
  The allowlist includes each target's sanitized onboard timing summary at
  `e2e-artifacts/live/<target>/cloud-onboard-trace-timing-summary.json`.
  Raw onboard traces stay under the runner temporary directory and are deleted
  before artifact upload.
  These per-target timing summaries are artifact evidence only.
  The Slack and GitHub scorecard timing comparison remains scoped to the
  dedicated `cloud-onboard` artifact.
  PR E2E dispatches validate the PR head commit and controller metadata before
  preparation, attach `test/e2e/risk-signal-reporter.ts` to live Vitest
  invocations, and suppress PR reporting and scorecards. The workflow boundary
  requires every selected job shard to upload its evidence artifact.
- `.github/workflows/e2e-branch-validation.yaml`, `macos-e2e.yaml`,
  `wsl-e2e.yaml`, and `regression-e2e.yaml` call focused E2E targets directly
  for their E2E coverage. Individual repository-hosted targets, including
  `ollama-auth-proxy`, are selected through `.github/workflows/e2e.yaml`.
- `vitest.config.ts` contains `e2e-support` for fast fixture/support tests and
  `e2e-live` for opt-in live target execution. The PR and `main` CLI coverage
  shards include `e2e-support` for code changes; they never opt into live
  targets.

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
