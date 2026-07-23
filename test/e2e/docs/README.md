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
- The automatic `progress` fixture reports the ordered semantic phase plan for
  each `e2e-live` case. Normal output contains phase transitions, outcomes, and
  durations. The harness appends `release registered E2E resources` to cover
  registered cleanup. After five minutes in one phase, a content-free stall
  diagnostic adds child-output age, current redacted command activity, and
  runner resources; it repeats every ten minutes while the phase remains
  active.

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

# Validate every live test's semantic phase metadata without running live bodies
npm run test:e2e-phases:check

# Opt-in live E2E targets
npm run test:live-e2e -- --silent=false --reporter=default

# Rank one or more downloaded/extracted live artifact directories
npm run test:runtime-audit -- e2e-artifacts/run-1 e2e-artifacts/run-2
```

The aggregate live command rebuilds the CLI before Vitest starts and runs live
test files serially.
Live E2E projects do not retry an entire failed test.
These tests mutate host, Docker, gateway, and sandbox state, so re-entering one
on the same runner can replace the original failure with stale-lock,
storage-exhaustion, or ownership noise. A target may retry a transient operation
only inside its own cleanup boundary.
Retry a full target by starting a fresh workflow run and runner.

During fixture teardown, every passing or failing live test writes
`test-progress.json` beside its other target artifacts. The runtime audit
groups those files by target, optional shard, and test name, then reports
median, p95, maximum, p95-minus-median variability, and the slowest observed
phase with its duration and outcome. Scheduled and ordinary manual workflows
publish the current run's table in the GitHub Actions scorecard summary. The
summary reads the matrix identity from `E2E_TARGET_ID` and
`NEMOCLAW_E2E_SHARD` when set. It retains overall start, finish, and duration,
and records each declared or harness-owned phase's start, finish, duration,
outcome, output-event count, and last-output timestamp. Use several recent
workflow artifact directories to distinguish a consistently expensive test
from a variable one.

Normal phase output intentionally omits test identity and test-level timing
because Vitest and GitHub Actions already provide them. It reports the current
position and semantic label, then the outcome and duration when that phase
ends:

```text
[e2e phase 1/4] provision a clean sandbox
[e2e phase 1/4] provision a clean sandbox — passed in 48s; next 2/4: exercise token rotation
[e2e phase 2/4] still running: exercise token rotation (phase 5m; child output 12s ago; activity command: rotate-token; ...)
[e2e phase 3/4] verify the rotated credential — passed in 9s; next 4/4: release registered E2E resources
[e2e phase 4/4] release registered E2E resources — passed in 6s
```

The `still running` line first appears after five minutes in the same phase and
then every ten minutes. Shell probes update child-output liveness and redacted
command activity automatically, but that detail remains hidden until the stall
threshold. The progress fixture never forwards child output contents.
The harness-owned final phase captures registered cleanup duration, failures,
and stalls. Soft assertion failures are recorded against the semantic phase
where they occurred, while successful resource release retains its own
`passed` outcome.

Every `e2e-live` test must declare two to twelve behavior-specific phases and
transition through them in order. For example:

```typescript
const PHASES = [
  "provision a clean sandbox",
  "exercise token rotation",
  "verify the rotated credential",
] as const;

test(
  "rotates a live sandbox credential",
  { meta: { e2ePhases: PHASES } },
  async ({ progress }) => {
    await provisionSandbox();
    progress.phase("exercise token rotation");
    await rotateCredential();
    progress.phase("verify the rotated credential");
    await verifyCredential();
  },
);
```

Use phases for meaningful scenario boundaries, not individual commands. Labels
must be unique within the plan; generic labels such as `setup`, `execute`,
`verify`, and `test body` are rejected. Pass each phase label as a string
literal so the collection-only checker can validate the transition without
executing the test body; variables and array lookups are rejected. A phase
transition may skip optional intermediate phases, which are recorded with a
`skipped` outcome, but it cannot move backward or select an undeclared label.
When a module has multiple tests, including tests with the same phase plan,
keep each literal transition inside its owning test callback so the checker can
attribute it to that case. A helper may own the operational boundary by
accepting a callback that performs the transition.
Completed phases use `passed`, `failed`, or `skipped` outcomes. A passing path
must enter the final declared phase before returning, or fixture teardown fails
the test. Do not declare or enter `release registered E2E resources`; the
harness appends and enters it automatically after the test's phase plan.
`npm run test:e2e-phases:check` collects the `e2e-live` project and rejects
missing or invalid plans without executing live test bodies.

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
  `E2E / PR Gate Coordination` check for every PR SHA, including forks,
  before `CI / Pull Request` completes. Its default-branch
  `pull_request_target` path also publishes the native GitHub Actions job named
  `E2E / PR Gate`. The read-only observer runs from `github.workflow_sha`,
  validates the live PR head and base, waits for the matching trusted
  coordination identity, and mirrors the terminal verdict into the required
  job. Its summary is static, while the job log includes the validated trusted
  controller-run link. Authorization states remain pending while the maintainer
  decision is recorded. During rollout, the observer also accepts the former
  `E2E / PR Gate` custom-check name for the same PR/base SHA identity. The
  controller builds the risk plan from GitHub's complete file list. Internal
  revisions normally dispatch every selected job and verify each expected
  `risk-signal.json`; this remains automatic when their `e2e-control-plane`
  matches are drawn only from the trusted controller workflow and scripts.
  Other or mixed internal
  control-plane revisions require a maintainer-authorized run for the PR SHA; only
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
  PR E2E dispatches validate the PR SHA and controller metadata before
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
