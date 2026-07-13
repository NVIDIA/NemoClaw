<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw E2E CI

Direct E2E coverage runs through Vitest.

Interactive TUI targets require `expect`. The unified workflow installs it
before those targets run; local runners must provide it themselves.

- `.github/workflows/e2e.yaml` is the scheduled, manually dispatchable, and
  selectively dispatched live target workflow.
- `.github/workflows/pr-e2e-gate.yaml` is the PR controller for
  `E2E / PR Gate`.
- `.github/workflows/e2e-branch-validation.yaml` provisions Brev instances and
  runs focused E2E targets from source on a clean machine.
- Platform workflows such as macOS, WSL, Ollama proxy, sandbox image, and
  regression E2E call their target E2E tests directly.

The former top-level `test/e2e/test-*.sh` suite has been removed. Keep real
shell, installer, process, Docker, OpenShell, `/proc`, and sandbox boundaries in
E2E tests when those boundaries are the behavior under test.

## Credential-free tests

Credential-free tests that can use the standard Ubuntu runner, CLI build, and
artifact policy opt into the shared E2E job with a tag beside the test:

```typescript
// @module-tag e2e/credential-free
```

Discovery reads tagged files from the `e2e-live` and `integration` Vitest
projects. It derives each test ID from the filename and supplies only the ID,
repository-relative file, and Vitest project to the test matrix. Keep the
filename stem unique and lowercase kebab-case. Do not add the test to a separate
catalog or manually maintained workflow matrix.

The E2E workflow owns the shared job's runner, timeout, setup, permissions,
secrets, and artifact handling. Keep a dedicated workflow job when a test needs
different capabilities, such as credentials, a custom runner, additional setup,
or a different timeout.

Both `jobs` and `targets` selectors continue to accept the test ID. Run the
discovery command locally to inspect the generated test matrix:

```bash
npx tsx tools/e2e/credential-free-tests.mts
```

## Scheduled operations

The consolidated workflow keeps its operational reporting in the same job
graph as the live targets:

- GitHub Actions run history is the authoritative record for scheduled and
  manual E2E results.
- Automated issue routing and the workflow's `issues: write` capability are
  retired. Any future issue escalation should use a separately reviewed
  exceptional threshold, such as the same lane failing twice consecutively or
  remaining broken for 24 hours, rather than posting on every failed schedule.
- `scorecard` writes the scheduled/manual result summary, compares the trusted
  cloud-onboard timing summary with the latest prior-release `e2e.yaml` run,
  and posts to the daily or full-run Slack route.
- Selective dispatches remain silent unless they run on `main` with
  `post_to_slack=true`, which uses the preview Slack route. Branch-dispatched
  runs never receive Slack webhook secrets.

Raw cloud-onboard traces stay under the runner temporary directory. Before
artifact upload, `scripts/e2e/sanitize-trace-timing.py` reduces them to the
allowlisted `cloud-onboard-trace-timing-summary.json` timing schema and deletes
the raw directory. Aggregation ratchets require `report-to-pr` and `scorecard`
to wait for the same execution-job set.

Registry-driven Vitest targets also enable onboard trace collection. Each live
matrix target writes raw traces under the runner temporary directory, sanitizes
them before upload, deletes the raw trace directory, and uploads only
`e2e-artifacts/live/<target>/cloud-onboard-trace-timing-summary.json` with the
target artifact. These per-target summaries are artifact evidence only; the
Slack/GitHub scorecard comparison remains tied to the dedicated `cloud-onboard`
artifact so baseline aggregation stays stable.
Older issue references to Vitest target artifacts under `e2e-artifacts/vitest/`
map to this consolidated `e2e-artifacts/live/` registry-target artifact layout.

## PR E2E check

When `CI / Pull Request` completes for a PR from this repository,
`.github/workflows/pr-e2e-gate.yaml` creates `E2E / PR Gate` for the PR head
commit. The controller reads all changed files and builds the deterministic
risk plan. If a runtime risk family matches, it dispatches every selected
`requiredJobs` entry through `e2e.yaml`; otherwise the check passes without an
E2E run.

Before dispatch, the controller verifies that the PR is unchanged and that
`main` still points to its workflow commit. It accepts only an E2E run using
that commit. Each selected job checks out `checkout_sha`. Before preparation or
secret-bearing jobs can run, `e2e.yaml` verifies that the PR remains open,
belongs to `NVIDIA/NemoClaw`, and still has that head commit. The dispatch
includes selected jobs and valid plan and correlation metadata, but not
`targets`. The controller uses GitHub's returned run ID for waiting, evidence
download, and completion.

The Vitest reporter writes one `risk-signal.json` for each selected job and
matrix shard.
The checked workflow boundary requires every policy-selected job to expose its
matching job identity, attach the reporter to every Vitest invocation, and
always upload its evidence artifact.
Each signal binds the observed checkout SHA, expected SHA, plan hash,
correlation ID, and pass, failure, skip, pending, and unhandled-error counts.
The controller retains `pr-e2e-risk-plan-<sha>` for 14 days, while each
signal travels in the selected job's existing E2E artifact.
Its private dispatch state is protected by a SHA-256 digest that is verified
before downloaded evidence is classified.

When the plan selects jobs, the check passes only when the E2E run succeeds and
every expected job shard uploads one complete passing signal with no skips or
pending tests. Every other dispatched outcome fails.
The coordinator has a 180-minute job budget and gives evidence download its
own 10-minute limit, so a stalled download fails instead of consuming the
remaining coordination time.
These dispatches suppress PR comments and the scheduled or manual
scorecard, including scorecard Slack reporting.

Synchronizing, reopening, or closing the PR cancels its active E2E runs. A new
dispatch also cancels the previous run, while the previous controller remains
available to close its check as failed.
The controller does not read PR Review Advisor or E2E Advisor output, so model
availability and recommendations are not part of merge authority.

## Onboard performance budget

The scheduled/manual scorecard evaluates the trusted `cloud-onboard` timing
summary against `ci/onboard-performance-budget.json`. The budget covers the
warm-system path and is advisory: exceeding the total-duration cap or a
regression threshold emits a GitHub Actions warning and adds details to the run
summary, but does not fail the scorecard job.

The config separates the absolute total-duration budget from total and phase
regression thresholds. Phase regressions are diagnostic and are only compared
when the current run and prior-release baseline contain the same known onboard
phase names. Cold image pulls, first-time model downloads, provider outages,
and runner or network incidents can still affect the signal, so maintainers
should inspect the timing table before acting on a warning.

For PRs, E2E Advisor builds a deterministic risk plan from the PR head commit
and changed-file set. It recommends required jobs for known regression families
and still requires `cloud-onboard` when changes affect onboard behavior, trace
timing, scorecard analysis, budget configuration, or the unified E2E workflow.
Model advice is additive and cannot downgrade the deterministic floor. The
scorecard remains the source of truth for advisory warm-system trend evaluation.

The `full-e2e` target enforces a separate hard acceptance contract for the
first fresh onboarding path in that job. It measures from the onboard root span
(a conservative anchor before wizard step `[1/8]`) through the first non-empty
agent response, requires the local BuildKit prebuild for the NemoClaw-generated
context without a gateway-builder fallback, limits the total to 205 seconds,
and limits the longest onboard output gap to 60 seconds. A violation fails
`full-e2e`, and the target writes its evidence to `onboard-progress-budget.json`.

These assertions run inside the existing `full-e2e` lifecycle instead of a
second standalone onboarding run. This keeps the measurement on the job's first
sandbox build, avoids warming Docker layers before a duplicate performance
test, and makes `full-e2e` the source of truth for the hard cold-path contract.
