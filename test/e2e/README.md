<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw E2E CI

Direct E2E coverage runs through Vitest.

Interactive TUI targets require `expect`. The unified workflow installs it
before those targets run; local runners must provide it themselves.

- `.github/workflows/e2e.yaml` is the scheduled, manually dispatchable, and
  selectively dispatched live target workflow.
- `.github/workflows/required-live-e2e.yaml` is the trusted pull request
  controller that owns the required `E2E / Required Live` check.
- `.github/workflows/e2e-branch-validation.yaml` provisions Brev instances and
  runs focused E2E targets from source on a clean machine.
- Platform workflows such as macOS, WSL, Ollama proxy, sandbox image, and
  regression E2E call their target E2E tests directly.

The former top-level `test/e2e/test-*.sh` suite has been removed. Keep real
shell, installer, process, Docker, OpenShell, `/proc`, and sandbox boundaries in
E2E tests when those boundaries are the behavior under test.

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

## Required live PR check

When `CI / Pull Request` completes for a same-repository pull request, the
trusted `.github/workflows/required-live-e2e.yaml` workflow creates the
`E2E / Required Live` check for that revision.
The model-independent controller resolves the open pull request, reads its
complete changed-file list from GitHub, and builds the deterministic risk plan.
If runtime regression families match, it dispatches every selected
`requiredJobs` entry through `e2e.yaml`.
If no family matches, the check succeeds without dispatching live E2E.

The controller verifies that the pull request did not change while the plan
was prepared.
It records the trusted workflow revision, requires that revision to remain the
current `main` revision immediately before dispatch, and accepts only a child
workflow run created from that same revision.
The `e2e.yaml` workflow definition stays on `main`, while each selected job
checks out the pull request revision supplied through `checkout_sha`.
Before E2E preparation or selected jobs can use repository secrets, the child
workflow verifies that the pull request is still open, comes from
`NVIDIA/NemoClaw`, and still points to that revision.
It also accepts only selective job dispatches without the `targets` input and
valid plan and correlation metadata.
GitHub returns the dispatched workflow's run ID directly, and the controller
uses that ID as the sole child-run selector for waiting, evidence download,
and completion.

The Vitest reporter writes one `risk-signal.json` for each selected job and
matrix shard.
The checked workflow boundary requires every policy-selected job to expose its
matching job identity, attach the reporter to every Vitest invocation, and
always upload its evidence artifact.
Each signal binds the observed checkout SHA, expected SHA, plan hash,
correlation ID, and pass, failure, skip, pending, and unhandled-error counts.
The controller retains `required-live-plan-<sha>` for 14 days, while each
signal travels in the selected job's existing E2E artifact.
Its private dispatch state is protected by a SHA-256 digest that is verified
before downloaded evidence is classified.

The required check has a binary result.
It succeeds only when the correlated E2E workflow succeeds and every expected
job shard produces one complete, unskipped pass.
Workflow or test failures, missing or duplicate signals, skipped or pending
tests, interrupted runs, and controller or evidence-validation errors fail the
check.
The coordinator has a 180-minute job budget and gives evidence download its
own 10-minute limit, so a stalled download fails instead of consuming the
remaining coordination time.
Required-live dispatches suppress PR comments and the scheduled or manual
scorecard, including scorecard Slack reporting.

Pull request synchronization, reopening, or closure cancels active child runs
for that pull request.
The E2E workflow also cancels a superseded child run when a new revision is
dispatched, while the earlier controller remains available to close its check
as failed.
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
context without a gateway-builder fallback, limits the total to 180 seconds,
and limits the longest onboard output gap to 60 seconds. A violation fails
`full-e2e`, and the target writes its evidence to `onboard-progress-budget.json`.

These assertions run inside the existing `full-e2e` lifecycle instead of a
second standalone onboarding run. This keeps the measurement on the job's first
sandbox build, avoids warming Docker layers before a duplicate performance
test, and makes `full-e2e` the source of truth for the hard cold-path contract.
