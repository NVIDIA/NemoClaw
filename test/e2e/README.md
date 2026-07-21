<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw E2E CI

Direct E2E coverage runs through Vitest.

Interactive TUI targets require `expect`. The unified workflow installs it
before those targets run; local runners must provide it themselves.

- `.github/workflows/e2e.yaml` is the scheduled, manually dispatchable, and
  selectively dispatched live target workflow.
- `.github/workflows/pr-e2e-gate.yaml` runs as `E2E / PR Gate Controller` and
  publishes the trusted exact-diff `E2E / PR Gate` required check directly.
- `.github/workflows/e2e-branch-validation.yaml` provisions Brev instances and
  runs focused E2E targets from source on a clean machine.
- Platform workflows such as macOS, WSL, sandbox image, and regression E2E
  call their target E2E tests directly. The Ollama auth proxy target is
  selected through `.github/workflows/e2e.yaml`.

## CI execution shape

On pushes to `main`, the sandbox image workflow starts after static checks and
CLI build/type-checking, in parallel with the remaining core jobs. The final
`checks` gate still waits for both the core jobs and sandbox image/E2E result.

The main platform signal shards the full Vitest suite four ways on both macOS
and WSL. Each shard has a 30-minute job budget and `fail-fast` is disabled so a
single platform failure does not hide the other shard results. The additional
root-required WSL contracts run only on shard 1.

The sandbox image workflow builds the Hermes production image in a dedicated
30-minute producer job with a runner-OS-and-architecture-scoped GitHub Actions
Buildx cache. The build loads the image locally without pushing it, validates
the image boundary, and uploads a one-day image artifact. The 90-minute Hermes
test job and the state-directory metadata job consume that same artifact, so
tests do not rebuild the image. Within the Hermes test job, the secret-boundary
and root-entrypoint steps have 45- and 30-minute budgets respectively.

Brev branch validation allows two bounded provisioning attempts by default.
During SSH readiness polling it stops the current attempt early when
authoritative Brev inventory reports a terminal instance state, or when three
consecutive successful inventory queries no longer report the instance. A
failed attempt is cleaned up before the next create. `BREV_PROVISION_ATTEMPTS`
can override the attempt count. This provisioning retry is inside the fixture's
cleanup boundary; Vitest still does not retry a live test after execution has
started.

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

## PR E2E gate

The controller workflow and required custom check report different parts of
the lifecycle. `E2E / PR Gate Controller` reports whether trusted controller
code handled its event. The controller publishes `E2E / PR Gate` as the
exact-diff required verdict. The default-branch `pull_request_target` path
seeds that check for the observed head and base, and the trusted coordinator
completes the same check after validating prerequisite CI and selected E2E
evidence. No hosted runner waits only to mirror one check into another.
During rollout, maintainer gate inspection still recognizes the former
`E2E / PR Gate Coordination` custom-check name for the same exact-diff
identity; the controller publishes only the new required-check name.

A handled prerequisite-CI failure, selected E2E failure or timeout, stale
revision, or closed PR can leave the controller green while the required check
is failed or cancelled. Only a successful `E2E / PR Gate` for the current head
and base satisfies the requirement. An
eligible prerequisite-CI failure records the versioned retry reason
`prerequisite-ci`. A selected child records `child-cancelled` only when a
trusted hosted-runner-loss marker is present and no terminal classification
was produced; cancellation alone is not retryable. Assertion failures and
other selected-E2E outcomes do not receive a retry reason. An unexpected
controller error still fails the controller workflow and fails the required
check closed.

On open, synchronization, reopen, transition out of draft, or base retarget,
`.github/workflows/pr-e2e-gate.yaml` reserves `E2E / PR Gate` for the exact PR
head and base commits, including fork heads. Metadata-only edits preserve the
existing exact-diff result instead of publishing a skipped success. A base
retarget fails any still-active earlier
result in that head's lineage, preserves completed audit history, and then
reserves the new PR/base SHA identity. The
`CI / Pull Request` run name binds its PR number, head SHA, base SHA, and gate
eligibility so the trusted controller can authenticate the completed run even
when a fork `workflow_run` payload omits pull-request metadata. The controller
also requires the completed run's workflow path to be
`.github/workflows/pr.yaml`. Metadata-only edits are marked ineligible and are
ignored by the controller and PR Review Advisor; base edits are eligible. PR CI
and advisor concurrency groups include that eligibility, so an ignored
metadata-edit run cannot cancel an eligible run for the same PR. The trusted
controller reads all changed files after eligible PR CI completes and builds
the deterministic risk plan.
Runtime families and changes to workflow-wired live tests select
canonical selectors from the trusted `e2e.yaml` inventory independently of
advisor output. Ordinary internal changes execute those focused selections.
Gate initialization and completed-CI handling share one non-cancelling
concurrency group for the head repository and branch. Before the controller
creates or updates the required check for the current revision, it reads the
live PR and requires the event's exact head and base, including when PR CI
failed. This keeps a stale seed or completed CI run from being applied to a
newer exact diff. A completed CI event for an older revision is handled without
creating or updating the current revision's required check.
If the older revision still has an in-progress required check, the
controller completes it as cancelled with `Superseded by PR update` or
`PR closed — gate no longer applies` and identifies the obsolete head and base.
The closed-PR outcome also applies when a fork repository was deleted and
GitHub consequently returns no head-repository object.
Shared sandbox-boundary changes have a floor of `full-e2e`, `hermes-e2e`, and
`security-posture`. E2E control-plane changes select `cloud-onboard`,
`credential-sanitization`, and `security-posture`. The `e2e-control-plane`
family is a conservative path boundary that includes non-documentation files
under `tools/e2e/` and `test/e2e/`, plus the E2E and PR-CI workflows, risk
policy, dependency and test configuration, and preparation and upload actions.
The Deep Agents Code headless-inference check additionally selects the exact
`ubuntu-repo-cloud-langchain-deepagents-code` typed target. That target is
hashed into the risk plan beside the control-plane floor jobs, so the
controller dispatches both selector types in one correlated workflow run.
An internal revision whose matched control-plane files are drawn only from the
trusted controller boundary—`.github/workflows/pr-e2e-gate.yaml` and
`tools/e2e/pr-e2e-gate.mts`—automatically
dispatches those selected jobs.
Any other or mixed internal control-plane revision requires the exact-SHA
maintainer authorization below before credentialed execution begins. If no job
or target is selected, the required check passes without an E2E run.

Before dispatch, the controller verifies that the live PR still matches the CI
run's PR SHA and base SHA. It uses its own workflow commit when that commit is
still `main`. If `main` advanced, the controller accepts the current commit
only when GitHub reports it as a descendant whose merge base is the workflow
commit, the comparison contains fewer than 300 fully enumerated files, neither
side of a rename enters the `e2e-control-plane` risk family, and a second read
confirms that `main` did not move again. Any divergence, incomplete comparison,
control-plane change, or second advance fails closed. The accepted `main`
commit is recorded as the workflow SHA and passed as `workflow_sha`. Before
matrix or secret-bearing jobs can run, `e2e.yaml` requires
`github.workflow_sha` to match that accepted commit. Each selected job checks
out `checkout_sha`. The same validation verifies that the PR remains open,
belongs to `NVIDIA/NemoClaw`, and still has both the dispatched head and base
commits. The dispatch includes selected jobs, allowlisted typed targets, and
valid plan and correlation metadata. Controller-bound targets are restricted
to the trusted allowlist. Before checking out PR code, the trusted workflow
projects each controller-selected target into a fixed target ID and hosted
runner mapping. The generated live matrix must exactly match those trusted IDs
and runners, and only the trusted projection can configure credential-bearing
typed-target jobs. Ordinary branch dispatch is not an acceptable substitute.
The controller uses GitHub's returned run ID for waiting, evidence download,
and completion, then revalidates that the PR is still open with the live head,
base, and exact-diff required-check identity before recording a final result.

An internal revision whose control-plane matches include a file outside the
trusted controller boundary leaves `E2E / PR Gate` in progress with
`Maintainer authorization required to run E2E`. No selected job or target runs
and no repository secret is exposed. After reviewing the exact revision, a repository
maintainer or administrator chooses **Run workflow** on `main`, selects
`run-control-plane`, and supplies the PR number, current 40-character head SHA
as `expected_head_sha`, current 40-character base SHA as `expected_base_sha`,
and a specific 10–500-character `review_reason`. The authorization requires the
first workflow attempt and revalidates the actor's `maintain` or `admin`
permission, internal repository origin, open PR, exact head and base, risk
plan, matching pending required-check state, compatible trusted controller
commit, and final live revision. It then updates the required check to
`Running <count> E2E check(s)` and dispatches the selected jobs and targets in
one workflow run. If authorization
fails before a child run is dispatched, the controller restores the
authorization title and leaves the required check in progress so a maintainer
can correct the problem and launch a fresh first-attempt authorization. After
a child is dispatched, a startup failure requests cancellation. Whether or not
cancellation is confirmed, the controller completes the required check as
`Authorized E2E run requires reconciliation`; that exact-diff authorization
cannot be retried because the child may still execute and a retry could start
duplicate credential-bearing work. Inspect the linked run, then update the PR
and run fresh CI before authorizing again.
Authorization and running titles are intermediate states while the exact-diff
required check remains in progress. A completed failure remains immutable and
cannot be changed by manual authorization. A
later eligible `CI / Pull Request` run can create a fresh required check for
the same unchanged open head and base only when the newest failed required
check carries a current-version retry reason:
`prerequisite-ci` after the later CI run succeeds, `child-cancelled` after a
conclusively cancelled child, or `evidence-download` after a successful child
whose evidence download failed, was cancelled, or was skipped. The trusted
controller leaves the completed check as audit history, creates and validates a
new `in_progress` check with the same PR/base SHA external identity, and rebuilds
the deterministic plan before exposing a fresh authorization state. The
controller selects the highest check-run ID only when every
older duplicate is a completed failure with a recognized versioned retry
marker. An unexpected app or mismatched mutation identity, duplicate ID, older
unmarked or otherwise non-retryable terminal state, or multiple active
candidates fails closed. Selected-job product or
assertion failures, evidence policy or integrity failures, schema or identity
mismatches, traversal or provenance failures, reconciliation, controller
errors, unknown states, and failures recorded before retry reasons existed
remain terminal for that PR/base SHA pair. Fork approval failures are not retried by
PR CI; follow the protected or manual skip path, or update the PR to create a
new head. Update the PR and run fresh CI for the other terminal outcomes. The
normal wait, evidence download, and finish path is the only path that can record
success; the authorization itself cannot make the gate green. A changed head or
base requires a new authorization.

A fork revision that selects jobs or typed targets keeps the required check in
the skip-approval flow. The controller does not dispatch the selected
credential-bearing jobs or targets or expose repository secrets.
Non-secret PR CI remains required. The failed required-check summary
embeds an explicit link to the same `E2E / PR Gate Controller` run; maintainers
follow that link rather than relying on the required check's **Details**
destination. The required check publishes only allowlisted skip-approval
metadata for its PR number, mode, head SHA, and base SHA. That controller run starts
`Approve credentialed E2E skip for fork PR`, which waits on the protected
`approve-credentialed-e2e-skip-for-fork-pr` environment. With
`deployment: false`, the job does not create a deployment record. A maintainer
opens the linked run, chooses **Review deployments**, selects that environment,
and approves it. The approval records that the selected credential-bearing
jobs and targets will not run; it does not authorize fork code to run with
repository secrets. The comment is optional, and the workflow reads both the
reviewer and comment from GitHub's run approval history rather than accepting
an actor supplied by the job.

Before rollout, create `approve-credentialed-e2e-skip-for-fork-pr` in the
repository with one or more required reviewers whose approving members have
repository `maintain` or `admin` permission. Do not add environment secrets,
variables, or custom protection apps; this job records the skip approval and
runs no PR-controlled code. Prefer disabling administrator bypass so every
decision appears in the approval history. If **Review deployments** is absent,
the environment may be missing or unprotected, or the run may no longer be
waiting. Configure the environment, update the PR to create a new head, and
trigger fresh upstream PR CI to create a new gate run, or use the manual
fallback described below. GitHub approval
history is not bound to a run attempt, so the controller rejects reruns of an
approval run. Per-PR approval concurrency cancels an older waiting job when a
newer revision reaches the gate.

For the fork button path, the controller requires a first-attempt, in-progress run
of this exact workflow on `main`, at the trusted workflow SHA and with the
`workflow_run` event. It requires exactly one approved review that names only
the exact environment, then verifies that the recorded reviewer still has
repository `maintain` or `admin` permission. The shared resolver revalidates
the open PR, repository origin, exact head and base SHAs, deterministic plan,
matching failed required check, and that the controller commit is either
still `main` or
has only a compatible safe descendant as described above. Immediately before
recording success, it reads the live PR again and requires the same PR SHA and
base SHA. The result records the reviewer, bounded optional comment, validated
approval-run URL, plan hash, and jobs and targets that did not run. The
successful skip required check is titled
`Credentialed E2E skipped for fork PR — approved by @<maintainer>` and begins
with `Outcome: APPROVED SKIP — credentialed E2E did not run.` It never claims
that the selected checks passed. The required check records this approved-skip
success directly.

The manual fork skip approval on `main` remains available as a fallback. Choose
`approve-fork-e2e-skip` and provide the PR number, current `expected_head_sha`,
current `expected_base_sha`, a 10–500-character `review_reason`, and optionally
an Actions run URL in the exact form
`https://github.com/NVIDIA/NemoClaw/actions/runs/<run-id>`. Leave
`evidence_url` blank when no supporting run exists. PR, issue, comment, job, and
external URLs are rejected. The controller validates the optional URL's shape
but does not inspect that run's contents. It applies the same PR, role, plan,
failed-check, compatible-`main`, and final stale-revision checks. Any new commit
receives a different gate and requires a new decision; a base change also
invalidates the decision.

The Vitest reporter writes one `risk-signal.json` for each selected job shard
and typed target. Typed targets bind the signal identity to the exact matrix ID
and use the `default` evidence shard. The checked workflow boundary requires
every policy-selected execution path to expose its matching identity, attach
the reporter to every Vitest invocation, and always upload its evidence
artifact.
Each signal binds the observed checkout SHA, expected SHA, plan hash,
correlation ID, and pass, failure, skip, pending, and unhandled-error counts.
The controller retains `pr-e2e-risk-plan-<sha>` for 14 days, while each
signal travels in the selected job or target's existing E2E artifact.
Its private dispatch state is protected by a SHA-256 digest that is verified
before downloaded evidence is classified.

When the plan selects jobs or targets, the required check passes only when the
E2E run succeeds and every expected job shard and target uploads one complete
passing signal with no skips or pending tests. For the current exact diff,
every other dispatched outcome fails. A failed required-check result links the
selected E2E run and up to 10
non-passing jobs, including up to three failed step names per job. If GitHub
truncates the job listing or the controller cannot load it, the required
check directs the maintainer to the complete run.
The coordinator has a 120-minute job budget and gives the selected E2E run 105
minutes to finish. When that limit expires, finalization cancels the child and
records the non-passing result in the required check. Evidence download has its
own 10-minute limit. If the selected child
succeeds but the `Download evidence` step fails, is cancelled, or is skipped,
the controller cannot authenticate the child's artifacts. It fails the
required check closed as
`Evidence could not be verified` and leaves `E2E / PR Gate Controller` red so
maintainers inspect that infrastructure failure. This download-only outcome
records `evidence-download`, so a later successful eligible PR CI run can create
a fresh required check for the same exact diff. If the download step
succeeds but signals are missing, duplicated, skipped, pending, or report a test
failure, the controller has
completed its work: it publishes the handled red PR verdict and remains green
without a retry reason. Malformed or unsafe evidence, schema or exact-identity
mismatches, and traversal-limit violations remain terminal controller
verification errors, so the required check and controller fail closed.
These dispatches suppress PR comments and the scheduled or manual
scorecard, including scorecard Slack reporting.

Synchronizing, reopening, or closing an internal PR cancels its active E2E
runs. A new dispatch also cancels the previous run. The previous controller
then completes the old exact-diff required check as cancelled when the PR
revision moved or closed, or as failed when the current revision's selected E2E
did not pass. A configured non-closed PR event seeds the current exact-diff
identity. Revision changes cancel superseded child E2E runs and seed the new
identity; the prior coordinator remains active long enough to close its check.
The controller does not read PR Review Advisor output, so model availability
and recommendations are not part of merge authority.

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

For PRs, the unified PR Review Advisor builds and renders guidance from the
deterministic risk plan for the PR SHA and changed-file set. It
recommends jobs for known regression families and includes `cloud-onboard` when
changes affect onboard behavior, trace timing, scorecard analysis, budget
configuration, or the unified E2E workflow. Compatibility schema fields may
classify that guidance as required, but rendered advisor guidance remains
non-authoritative. Model advice is additive and cannot downgrade the
deterministic floor. The independent PR E2E controller rebuilds the plan rather
than consuming those recommendations, and the scorecard remains the source of
truth for advisory warm-system trend evaluation.

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
