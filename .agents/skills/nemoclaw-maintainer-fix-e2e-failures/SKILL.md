---
name: nemoclaw-maintainer-fix-e2e-failures
description: Runs a persistent loop that fixes failures from automatic NemoClaw E2E runs on main. Groups failures by root cause, coordinates one claimed fix per PR across maintainers, reviews and approves peer fixes, satisfies current GitHub merge gates, merges eligible fixes, and keeps monitoring for new results. Use for continuous main E2E failure fixing, an always-running E2E fix loop, or coordinated multi-agent E2E maintenance. Do not use to dispatch manual E2E; use nemoclaw-maintainer-e2e instead.
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Fix Main E2E Failures Continuously

Run a persistent, multi-maintainer loop against automatic `main` E2E results. Use GitHub as the shared ownership and merge authority.

## Set the Loop Contract

1. Start without a scheduled endpoint. Do not infer an endpoint from local time, a shift boundary, a passing run, or an empty queue.
2. Keep release operations out of scope. Never change, retag, publish, or otherwise touch a release, tag, or release artifact during this workflow. Route release work to the existing release workflow.
3. Confirm maintainer authority. Merge only when the invocation grants it; otherwise leave the PR approval-ready and continue the loop.
4. Check Git and GitHub access. Follow [Git and GitHub Access Hard Stop](../_shared/git-github-hard-stop.md) on access failure.
5. Fetch trusted `origin/main`. Read its PR-limit policy with `git show origin/main:.github/workflows/pr-limit.yaml`. For a non-exempt author, do not create a claim that would exceed the 10-open-PR limit.

Do not declare success or end because the queue is empty or the newest run passes. Wait for the next automatic `main` result and continue.

## Keep the Queue

Read [Queue and Ownership](references/queue-and-ownership.md) before the first scan. Keep one table grouped by root cause:

| Root cause | Run and jobs | State | Owner and PR | Next action |
|---|---|---|---|---|

Use only these states: `unclaimed`, `active`, `waiting-ci`, `waiting-review`, `approval-ready`, `merged`, `obsolete`, and `blocked`.

Track each observed workflow run by run ID, attempt, status, conclusion, and job set. Re-read an in-progress or queued run when its state changes. Do not reanalyze an unchanged completed run.

## Run the Loop

Repeat these steps continuously while the loop remains authorized:

1. Fetch current `origin/main` and list automatic E2E runs for that SHA and newer `main` SHAs.
2. Inspect only new or changed runs. Read failed job logs and artifacts far enough to identify the earliest actionable product, test, workflow, runner, or cleanup failure.
3. Group failures that share the same causal signature. Do not equate a job name with a root cause.
4. Reconcile each group with open PRs before editing. If another maintainer owns it, record that PR and take the next unowned group.
5. Prefer a peer loop PR that needs review or a final merge decision before starting another fix.
6. Select one unowned root cause. Claim it before the product fix with a draft PR whose initial diff contains evidence for only that root cause.
7. Work on only that root cause. Add the diagnostic or regression evidence that should have caught an escaped defect.
8. When the PR is waiting on CI or peer review, it is no longer active editing work. Review a peer PR or take the next unowned root cause, while keeping only one fix actively edited at a time.
9. Revisit waiting and blocked groups during each scan. Re-scan after every meaningful GitHub state change and each new automatic `main` result.

If nothing is actionable, use the product's wait, loop, or monitoring mechanism and resume. Do not end the task early.

## Apply Common Decisions

- If Linux and macOS jobs have the same stable readiness signature, group them in one claim.
- If the PR head changes, discard the exact-head review. Claim and review the new head before approval.
- If a later automatic `main` run proves that another merge removed the root cause, close the open fix as obsolete. Credit only the superseding fix.

## Claim One Root Cause

Before changing product code:

1. Apply the transport-ambiguity rule in [Review and Merge](references/review-and-merge.md) to every GitHub write.
2. Search open PR titles and bodies using the run ID, job ID, stable error signature, affected component, and likely fix area.
3. Read plausible matches. A different job with the same cause is already owned; a similar symptom with a different cause is not.
4. Create a branch from current `origin/main`.
5. Add one diagnostic or regression test for the root cause when feasible. If no legitimate root-cause-only diagnostic or regression test can be added before the fix, mark the group `blocked` and do not edit product code. Do not manufacture an unrelated placeholder diff.
6. Immediately before creating the draft, re-read open PRs and shared coordination for the root-cause key, then recount the author's open PRs under the policy from refreshed `origin/main`. Treat both checks as one pre-write gate.
7. If a matching claim exists or the new PR would exceed the limit, do not create it. Record the current owner or limit state and rescan.
8. Otherwise, open a draft PR assigned to its author. Follow `nemoclaw-contributor-create-pr` for the template, verified commits, and DCO declaration.
9. Put the root-cause key, source workflow URL, source run ID, failed job names and IDs, and failure signature in the PR body. Fix exactly one root cause in that PR.

Do not begin a second active fix for the same agent. Waiting PRs may accumulate only within the open-PR limit.

## Review and Merge as an Ecosystem

Read [Review and Merge](references/review-and-merge.md) before reviewing, approving, refreshing, or merging a loop PR.

- Never approve your own PR. After an independent current-head approval, either the author or another maintainer may perform the final gated merge.
- Review another maintainer's exact PR head independently. Do not exchange approvals without reviewing correctness, security, tests, and scope.
- Do not duplicate an active peer review. Respect an explicit review claim for the same head in agent coordination, a PR comment, or a submitted review.
- Do not manually request reviewers unless the current user or repository-owned configuration authorizes the exact request. Follow [Follow Up on PR CI and Reviews](../_shared/pr-follow-up.md).
- Require at least one current-head approval from an account that did not open, author, or co-author the PR.
- Require the existing maintainer gate, all current GitHub-required checks, and any applicable security review to pass.
- Refresh a branch only at the final merge gate and only when the decision table requires it. Refresh before approval because a new head invalidates earlier approval and CI evidence.
- Re-read the PR and rules immediately before merge. Never use an administrator bypass.

## Do Not Duplicate E2E

Observe automatic push runs and workflow-owned replacement attempts. Never use `gh run rerun`, `gh workflow run .github/workflows/e2e.yaml`, or local live E2E to duplicate an automatic run.

Approving a first-time contributor's ordinary `pull_request` workflow after trust review is not a manual E2E dispatch. Environment approval for a secret-bearing or hardware E2E job is different: follow `nemoclaw-maintainer-e2e` only when the maintainer explicitly requests that run.

Never weaken, skip, delete, relabel, or narrow coverage to make a failure disappear. Do not freeze `main`, block unrelated merges, or ask other maintainers to wait.

## Close Obsolete Work

Before each fix push and merge decision, check whether `main` or another PR already removed the root cause. When it did:

1. Verify the superseding change against the original failure signature.
2. Stop editing the obsolete fix.
3. Close its PR with the superseding PR or commit and the verification evidence. Re-read the PR after the write.
4. Mark the queue item `obsolete`; do not count it as this loop's verified fix.

## Contain a Failed Merge

Treat an automatic `main` run as a post-merge failure when it preserves the claimed root-cause
signature or introduces a regression attributable to the merged fix.

1. The loop agent that confirms the failure becomes the containment owner until an acknowledged
   handoff names another owner.
2. Mark the root cause `blocked`. Pause merge writes for the failed root cause and for fixes that
   depend on the affected `main` state.
3. Run the `post-merge-e2e` state through the executable write guard in
   [Review and Merge](references/review-and-merge.md).
4. Never revert `main` directly. If the invocation explicitly grants rollback-PR creation authority,
   open one guarded draft revert PR for the exact merge. Include the merge SHA, first parent, failed
   run and jobs, original signature, regression signature, and containment scope.
5. If rollback-PR authority is absent or attribution is uncertain, make no rollback write. Route the
   evidence to a maintainer with explicit rollback-PR authority and continue unrelated queue reads.
6. Apply the ordinary independent review, required checks, exact-head, and merge authorization gates
   to the revert PR. A merge grant for the loop does not grant a bypass or direct rollback.

Resume related merge writes only after a guarded revert or forward fix merges and a later automatic
`main` run proves that the original failure and the regression are absent. Operator authorization may
choose a different disposition, but it must name the affected merge and the new containment owner.

## Transfer Without Ending the Loop

The loop has no scheduled endpoint. An agent may leave only after the operator cancels the loop or another active agent acknowledges ownership of monitoring and every open item.

Before leaving after a transfer or cancellation, finish only a non-destructive read already in progress. Perform the required read-only reconciliation for each ambiguous GitHub write, but start no other read. Preserve source edits. Delete each owned temporary-evidence directory and verify its absence. Produce the [Continuity Handoff](references/continuity-handoff.md). For a transfer, continue monitoring until the receiving agent acknowledges ownership.

A passing automatic run verifies only its tested `main` SHA. It does not complete the loop. Do not report `main` as passing when its newest relevant E2E run is queued, running, cancelled, stale, or failing.
