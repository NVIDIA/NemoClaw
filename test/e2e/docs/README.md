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
| Homogeneous target catalogue and execution | [Catalogue Targets](../README.md#catalogue-targets) |
| Main-push and manual selection | `tools/e2e/workflow-plan.mts` |
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

## Selecting One Target

`.github/workflows/e2e.yaml` runs one matrix target by passing its ID through
`TARGET_ID`. The workflow selects the test title with the stable
`-t "^${TARGET_ID}:"` prefix. The title suffix contains the observable outcome,
agent runtime, and environment or inference endpoint. The selector performs the
restriction; `TARGET_ID` alone does not limit which targets run.

The `generate-matrix` job resolves dispatch input through `requireTargets`, so
an unknown id fails there before any target job starts.

`test/e2e/live/registry-targets.test.ts` resolves `TARGET_ID` through the same
registry at module load, which covers a run that sets it another way. An ID no
target declares fails collection with `Unknown target '<id>'. Available
targets: ...`, and an empty ID fails with `Selected target ID '' is not safe
...`. Without those checks, either ID would build a selector that matches
nothing and can exit 0 without executing a target. An unsafe ID also fails with
`Selected target ID '<id>' is not safe ...`; regex-shaped IDs can otherwise
broaden the selector and run unintended live targets. This module-load guard
protects the registry-target catalogue when collection includes
`registry-targets.test.ts`. Both `npm run test:live-e2e` and
`npm run test:e2e-phases:check` include that file, but a collection command that
omits it does not run this guard.

A declared target that is not wired for live fixtures still collects. The
typed-registry matrix reports it as skipped with its `[not wired]` reason and
exits 0. That exit-0 skip is specific to the typed-registry matrix; the
catalogue path sets `NEMOCLAW_E2E_REQUIRE_EXECUTED_TEST=1` and exits nonzero
when its selection runs no tests.

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

The aggregate local command rebuilds the CLI before Vitest starts and runs E2E
test files serially. It does not retry a failed test.

After an eligible `E2E main` push workflow completes, `E2E / Main Retry Evidence` records its conclusion and source-attempt evidence.
It does not request a broad failed-job or workflow rerun.
An E2E test can retry an external operation only through its checked-in bounded policy.
The observer records `passed-first-attempt`, `passed-after-retry`, `failed-no-retry`, or `ignored`.
The `flaky` field is `true` only for `passed-after-retry`.
`Automation / Recover Platform CI Runner` separately owns one rerun of an eligible `CI / Platform Compatibility` push with authenticated GitHub-hosted runner-loss evidence.

After the observer evaluates attempt N, it uploads an artifact named for that
attempt. The artifact contains one `attempts` entry for each source attempt through
N. `totalRunnerMinutes` is the sum across those entries. If evaluation or file
creation fails, the upload step warns that the file is missing and publishes no
evidence artifact. The observer ignores manual PR runs and a run
superseded by a newer `main` push.

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

- `.github/workflows/e2e.yaml` compares the before and candidate commits on each
  push to `main`, then selects the catalogue targets and retained workflow jobs
  that own the changed files. Each trusted push also selects the CPU-only
  `jetson-nvmap-gpu` proof. If no other retained E2E owns a changed file,
  `Relevant E2E` requires only the Jetson proof.
  Push runs skip `llama-cpp-dgx-spark-plan` and
  `llama-cpp-dgx-spark-qualification` because a push event cannot set their
  required workflow dispatch flag.
  Runner, credential, evidence, and cleanup requirements remain job-specific.
  A maintainer can also dispatch the trusted `main` workflow against the latest
  commit from an open internal or fork PR. The manual path validates the actor,
  PR number, PR source repository, candidate commit SHA, base commit SHA,
  workflow SHA, review reason, and allowed jobs, targets, and Launchable
  combination before candidate checkout.
  A trusted `main` native runtime producer run requires the executing workflow
  commit and `workflow_sha` input to equal the exact PR-recorded base commit.
  The producer accepts only a same-repository PR and the first workflow attempt.
  The host-side preparation step receives the long-lived `NVIDIA_API_KEY`
  repository secret in its environment. It creates runner-local registry
  authentication and pulls pinned GPU images. It then deletes the registry
  authentication file and unsets the variable before the separate candidate
  installer or live-test process starts. Cleanup removes runner-local registry
  authentication but does not revoke the key. The key remains valid in the
  issuing NVIDIA service until it expires or that service revokes it.

  For a PR revision run, leave `jobs` and
  `targets` empty. The run selects every default-selected free-standing workflow
  E2E except `Exact staging Brev Launchable`, every catalogue target in the
  `standard` profile, all shared credential-free tests, and these
  controller-selected registry targets:
  `ubuntu-policy-custom-missing-presets-negative`,
  `ubuntu-repo-cloud-langchain-deepagents-code`, `ubuntu-repo-cloud-openclaw`, and
  `ubuntu-repo-docker-post-reboot-recovery`. Keep
  `allow_jetson_dispatch=false` and `allow_dgx_spark_runner_queue=false` for
  this default selection. If the DGX Spark flag is `true`, GitHub can pause the
  qualification job for the `approve-dgx-spark-image-qualification` environment.
  An authorized environment reviewer must approve it before qualification starts.
  Accepted nonempty `jobs` values are:

  - `inference-routing`
  - `managed-image-protected-runtime`
  - `native-runtime-qualification-producer`
  The `jetson-nvmap-gpu` target is also accepted when `allow_jetson_dispatch` is `true`.
  Refer to [NemoClaw E2E CI](../README.md).

- [Jetson dispatch controller](jetson-dispatch.md) defines the NemoClaw-owned
  HTTP contract, trusted GitHub controller, repository configuration, and
  evidence for `jetson-nvmap-gpu`. The service behind that contract is
  operator-owned infrastructure.

- `.github/workflows/e2e.yaml` runs selected or all supported live E2E targets and uploads an explicit artifact allowlist.
  The shared E2E uploader retains per-target JSON summaries and command-evidence directories for 14 days.
  The native runtime aggregate upload retains `native-runtime-qualification-<candidate-sha>` for 30 days.
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
  invocations and suppress PR reporting and scorecards. Each risk signal binds
  its result counts to the expected and tested candidate SHA, correlation ID,
  job ID, and shard ID. The workflow boundary requires every selected job shard
  to upload its evidence artifact.
- `.github/workflows/platform-vitest-main.yaml` publishes `CI / Platform Compatibility`.
  It runs the Ubuntu 26.04 compatibility contracts and four full-suite Vitest shards on each of macOS and WSL.
  Each macOS shard installs the pinned OpenShell formula.
  Shard 1 has a 60-minute budget for live E2E; the other shards have 30 minutes.
  WSL shard 1 has a 180-minute budget for root-required contracts and live E2E; the other shards have 90 minutes.
  On shard 1, the workflow runs focused macOS and WSL live E2E only when the run tests `main` and Docker is available.
  Otherwise, those live tests skip and the platform contracts remain as evidence.
  This conditional result is platform evidence, not `Release qualification`.
  The live steps give candidate test code the job-scoped `GITHUB_TOKEN` and repository `NVIDIA_INFERENCE_API_KEY`.
  The macOS step sets both in its process environment.
  The WSL step uses the trusted PowerShell helper to forward both into the WSL test process.
  The workflow sets these credentials only for the live steps, but candidate code can copy either value while a step runs.
  GitHub invalidates `GITHUB_TOKEN` after the job.
  `NVIDIA_INFERENCE_API_KEY` remains valid until it expires or is revoked; the workflow does not revoke it.
- `.github/workflows/portable-profile-e2e.yaml` provides experimental portable-profile evidence on matching `main` changes or manual dispatches.
- `.github/workflows/podman-cpu-proof.yaml` provides PR-only experimental runtime evidence with Docker disabled.
- `.github/workflows/sandbox-images-and-e2e.yaml` provides reusable image build and test evidence through manual dispatch and `workflow_call`.
  `.github/workflows/e2e.yaml` selects free-standing jobs, including `whatsapp-qr-compact` and `ollama-auth-proxy`.
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
