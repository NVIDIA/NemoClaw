<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw E2E CI

Direct E2E coverage runs through Vitest.

Interactive TUI targets require `expect`. The unified workflow installs it
before those targets run; local runners must provide it themselves.

- `.github/workflows/e2e.yaml` is the scheduled and manually
  dispatchable live target workflow.
- `.github/workflows/post-merge-e2e-risk-gate-shadow.yaml` is the trusted post-merge
  controller that selects and dispatches a bounded exact-commit subset after
  pushes to `main`.
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

## Post-merge risk shadow

Every push to the `main` branch of `NVIDIA/NemoClaw` starts a model-independent
shadow controller. It builds the deterministic risk plan from the exact
`github.event.before` and `github.event.after` range after confirming that its checkout
matches the pushed commit. If the plan matches runtime regression families,
the controller dispatches at most three `automaticJobs` through `e2e.yaml`.
The workflow definition stays on `main`, while every E2E checkout uses the
merged commit supplied through `checkout_sha`. GitHub returns the
dispatched workflow's run ID directly, and the controller uses that ID as the
sole child-run selector for waiting, evidence download, and completion.

Before E2E preparation or selected jobs can use repository secrets,
`e2e.yaml` verifies that the requested SHA equals the workflow's own current
`main` commit, confirms that checked-out `HEAD` matches it, proves reachability,
and accepts only selective job dispatch with valid plan and correlation
metadata. If `main` advances before an older controller dispatches, that child
fails closed and the controller records failure instead of running historical
code with current secrets. The shadow-only Vitest
reporter then writes a `risk-signal.json` for each selected job and matrix
shard. Each signal binds the observed checkout SHA, expected SHA, plan hash,
correlation ID, and pass, failure, skip, pending, and unhandled-error counts.
The controller retains `post-merge-risk-plan-<sha>` for 14 days, while each
signal travels in the selected job's existing E2E artifact.

The controller reports `E2E / Post-merge Risk Gate (shadow)` on the merged
commit. It reports success only when every expected shard produces a complete,
unskipped pass and the three-job cap did not omit required jobs. Selected E2E
workflow or test failures for the merged commit report failure. Missing, partial, skipped,
ambiguous, or manual-expansion evidence reports neutral. A plan with no matched
runtime risk reports success without dispatching live E2E. This shadow check runs
after merge and is not a required PR check. It disables PR comments and the
scheduled/manual scorecard, including scorecard Slack reporting.
Controller or evidence-verification errors close an already-created check as
neutral so incomplete evidence cannot appear successful.

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
