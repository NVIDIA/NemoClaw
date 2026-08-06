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
  each `e2e-live` case. Normal output contains the target/scenario identity,
  immediate phase starts and completions, and phase plus total durations. The
  harness appends `release registered E2E resources` to cover registered
  cleanup. After five minutes in one phase, a content-free stall diagnostic
  adds child-output age, current redacted command or cleanup activity, and
  runner resources; it repeats every ten minutes while the phase remains
  active.
- Credential-free integration tests selected by the shared E2E planner use the
  lightweight `workflow-e2e-test` fixture for the same progress and artifact
  contract without depending on the stateful live fixture services.

The `test/e2e/fixtures/` path is fixture/support code, not a test
harness or runner. Vitest remains the only test harness.

`suiteIds` remain metadata for reporting and migration planning. They do not
dispatch shell validation suites.

## Cross-Runtime Foundation

The registry contains an inert foundation for describing the same behavior on
more than one execution provider:

- `scenario.ts` owns provider-neutral desired state and explicit support
  obligations, an ordered semantic user journey, and normalized assertions.
- `execution-profile.ts` describes provider, host platform and architecture,
  root mode, acceleration, capabilities, and bounded runner capacity. Provider
  IDs are open; adding one does not require editing a central union.
- `runtime-matrix.ts` binds every scenario obligation to a registered callable
  fixture adapter, rejects incompatible capabilities, keeps full-profile
  preparation batches atomic, schedules those batches within a host-wide shard
  ceiling, and derives isolated resource identities.
- `fixtures/runtime-provider.ts` is the provider-command boundary for
  readiness, exact workload identity, obligation execution, lifecycle evidence,
  and cleanup. Its fixture-only executor exercises compiled cases without
  crossing the legacy Docker phase-fixture path.
- `parity-evidence.ts` compares normalized lifecycle traces, desired-state
  fingerprints, terminal outcomes, and user-visible projections. It retains
  exact head/base, engine, architecture, workload, managed-image, capability,
  and opaque provider receipt evidence without comparing provider internals.

Compile one registry-wide `RuntimeMatrixDefinition`, then attach only a
`scenarioId`/`profileId` reference with `TargetBuilder.runtimeCase(...)` in fast
compiler tests today. The existing target compiler resolves the reference but
does not dispatch its adapter IDs. Support tests execute the same compiled case
through Docker-shaped and fake-MXC providers; no canonical target, workflow
selector, live scenario, or production runtime registration consumes this
metadata yet. Existing legacy Docker command fixtures, their ordering, and
their output contracts are unchanged.
Execution evidence must be published with
`ArtifactSink.writeExecutionEvidence(...)` so normal artifact redaction still
applies.

When extending the foundation, keep product intent in the scenario, runtime
mechanics in obligation bindings, and support facts in capabilities. A binding
must cover every obligation explicitly; a missing adapter or capability is a
compile error rather than a skip.

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

# Validate every live test and workflow-selected integration test without running bodies
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
phase with its duration and outcome. Push and ordinary manual workflows
publish the current run's table in the GitHub Actions scorecard summary. The
summary reads the target identity from `E2E_TARGET_ID`, falling back to the
Actions `GITHUB_JOB`, and reads `NEMOCLAW_E2E_SHARD` when set. It retains
overall start, finish, and duration, and records each declared or harness-owned
phase's start, finish, duration, outcome, child-output event count, and
last-output timestamp. Use several recent workflow artifact directories to
distinguish a consistently expensive test from a variable one.

Normal phase output repeats the workflow target and test scenario because a
long-running Actions step may not expose Vitest's final report yet. It reports
the current position and semantic label, total and phase elapsed time, and the
outcome when that phase ends:

```text
[e2e target="token-rotation" scenario="rotates a live sandbox credential"] [phase 1/4] started: provision a clean sandbox (total 0s; phase 0s)
[e2e target="token-rotation" scenario="rotates a live sandbox credential"] [phase 1/4] completed: provision a clean sandbox — passed in 48s (total 48s)
[e2e target="token-rotation" scenario="rotates a live sandbox credential"] [phase 2/4] still running: exercise token rotation (total 5m 48s; phase 5m; child output 12s ago; activity command: credential-rotation; ...)
[e2e target="token-rotation" scenario="rotates a live sandbox credential"] [phase 4/4] event: cleanup started: destroy sandbox e2e-token-rotation (total 6m; phase 0s)
[e2e target="token-rotation" scenario="rotates a live sandbox credential"] [phase 4/4] completed: release registered E2E resources — passed in 6s (total 6m 6s)
```

The `still running` line first appears after five minutes in the same phase and
then every ten minutes. Shell probes update child-output liveness and redacted
command activity automatically, but that detail remains hidden until the stall
threshold. Automatic child-output observation forwards only the event timestamp
and stream name, never the output contents.
Use `progress.event("literal content-free status")` only for immediate semantic
events such as an operation timeout, retry cleanup, backoff, or the next
attempt. Event labels are logged, so never include child output, request data,
credentials, or tokens.
For the stateful live fixture, the harness-owned final phase captures registered
cleanup duration, failures, and stalls; each registry entry reports a redacted
start/outcome event and is shown as the active cleanup operation in a stall
heartbeat. Workflow-selected integration tests declare their own final release
phase. Soft assertion failures are recorded against the semantic phase where
they occurred, while successful resource release retains its own `passed`
outcome.

Every `e2e-live` test and every credential-free integration test selected by
the shared E2E planner must declare two to twelve behavior-specific phases and
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
the test. In `e2e-live`, do not declare or enter
`release registered E2E resources`; the stateful harness appends and enters it
automatically after the test's phase plan. Workflow-selected integration tests
own and enter their final release phase.
`npm run test:e2e-phases:check` collects every `e2e-live` module plus the
workflow-selected integration modules from the authoritative shared-job plan.
It rejects missing or invalid plans without executing test bodies. Live modules
must import `fixtures/e2e-test.ts`; selected integration modules must import
`fixtures/workflow-e2e-test.ts` and declare their final release phase explicitly.
The same check audits direct child-process boundaries reachable through shared
E2E helpers. Prefer `ShellProbe`; a long-lived process that cannot use it must
live in an explicitly audited progress-aware boundary, close its activity on
exit, and report child output only as `{ stream, atMs }`. Blocking child-process
calls require a positive timeout shorter than the first heartbeat plus
`killSignal: "SIGKILL"`, so that timeout cannot be ignored. Raw output belongs
only in redacted artifacts.

Audited subprocess helpers require the fixture-provided frozen, canonical
`progress` capability. Forward that exact object unchanged instead of copying
it or constructing a look-alike or no-op adapter. A module-private brand,
runtime registry, frozen-object check, type system, and semantic checker enforce
this boundary.

Progress callbacks are diagnostic-only: callback failures must not change
command execution, test outcomes, or registered resource release.

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

- `tools/advisors/risk-plan.mts` is the small deterministic recommendation policy
  used by PR Review Advisor. It maps changed runtime surfaces to invariant
  families and canonical `e2e.yaml` jobs; it does not dispatch E2E.

- `.github/workflows/e2e.yaml` runs the default suite on every push to `main`.
  A maintainer can also dispatch the trusted `main` workflow against the exact
  head of an open internal or fork PR. The manual path validates the actor, PR
  number, head repository, head SHA, base SHA, workflow SHA, review reason, and
  selected mode before candidate checkout. Empty `jobs` and `targets` run the
  default suite. The only accepted nonempty `jobs` value is
  `managed-image-protected-runtime`; `targets` must remain empty. Refer to
  [NemoClaw E2E CI](../README.md).

- `.github/workflows/e2e.yaml` runs selected or all supported
  live E2E targets and uploads an explicit artifact allowlist with
  JSON summaries plus action, log, and shell command-evidence directories under
  14-day retention.
  Final OpenShell gateway-auth artifacts pass a fail-closed safety scan after
  cleanup. The scanner copies safe files into a private staging directory,
  scans that copy again, and adds a marker bound to the current Actions run ID
  and attempt. Unsafe source files are quarantined or deleted. The workflow
  uploads only the staged copy, so later changes to the source directory cannot
  alter the approved payload.
  The allowlist includes each target's sanitized onboard timing summary at
  `e2e-artifacts/live/<target>/cloud-onboard-trace-timing-summary.json`.
  Raw onboard traces stay under the runner temporary directory and are deleted
  before artifact upload.
  These per-target timing summaries are artifact evidence only.
  The Slack and GitHub scorecard timing comparison remains scoped to the
  dedicated `cloud-onboard` artifact.
  Manual PR runs attach `test/e2e/risk-signal-reporter.ts` to live Vitest
  invocations and suppress PR reporting and scorecards. The workflow boundary
  requires every selected job shard to upload its evidence artifact.
- `.github/workflows/platform-vitest-main.yaml` runs the full Vitest suite in
  four independent shards on each of macOS and WSL, with `fail-fast` disabled.
  Each macOS shard installs the pinned OpenShell formula and has a 30-minute
  budget. Each WSL shard has a 90-minute budget, and WSL runs its additional
  root-required contracts on shard 1 only.
  `macos-e2e.yaml`, `wsl-e2e.yaml`, and `regression-e2e.yaml` call focused E2E
  targets directly for their platform coverage.
  Repository-hosted targets, including `ollama-auth-proxy`, are selected
  through `.github/workflows/e2e.yaml`.
- The `staging-brev-launchable` job validates the exact baked candidate in
  preinstalled mode. Generic Brev VMs with source overlays are not a
  qualification boundary.
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
