---
name: nemoclaw-maintainer-fix-e2e-failures
description: Fixes failures from automatic NemoClaw E2E runs on main through continuous maintainer coordination. Groups failures by root cause, assigns one PR to each cause, reviews peer changes, satisfies GitHub merge requirements, merges eligible PRs when authorized, and monitors new results. Use for continuous main E2E maintenance or coordinated multi-agent E2E maintenance. Do not use for manual E2E dispatch; use nemoclaw-maintainer-e2e instead.
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Continuously Fix E2E Failures on Main

Continuously inspect automatic E2E results for `main`. Coordinate ownership and merge decisions through GitHub.

## Set the Operating Rules

1. Start without a scheduled end time. Do not infer an end time from local time, a shift change, a passing run, or an empty queue.
2. Keep release operations out of scope. Never change, retag, publish, or otherwise touch a release, tag, or release artifact during this workflow. Route release work to the existing release workflow.
3. Confirm maintainer authorization. Merge only when the request grants it. Otherwise, leave the PR `approval-ready` and continue the loop.
4. Check Git and GitHub access. Follow [Git and GitHub Access Hard Stop](../_shared/git-github-hard-stop.md) on access failure.

Do not declare success or end the loop because the queue is empty or the newest run passes. Wait for the next automatic `main` result.

## Keep the Queue

Read [Queue and Ownership](references/queue-and-ownership.md) before the first scan. Keep one table grouped by root cause:

| Root cause | Run and jobs | State | Owner and PR | Next action |
|---|---|---|---|---|

Use only these states: `unclaimed`, `active`, `waiting-ci`, `waiting-review`, `approval-ready`, `merged`, `obsolete`, and `blocked`.

Track each observed workflow run by run ID, attempt, status, conclusion, and job set. Re-read an in-progress or queued run when its state changes. Do not reanalyze an unchanged completed run.

## Run the Loop

Repeat these steps continuously while the loop remains authorized:

1. Refresh `origin/main`. List automatic E2E runs for that commit SHA and later `main` commit SHAs.
2. Inspect only new or changed runs. Read failed job logs and artifacts far enough to identify the earliest actionable product, test, workflow, runner, or cleanup failure.
3. Group failures that share the same causal signature. Do not equate a job name with a root cause.
4. Reconcile each group with open PRs before editing. If another maintainer owns it, record that PR and take the next unowned group.
5. Prefer a peer E2E maintenance PR that needs review or a final merge decision before starting another fix.
6. Select one unowned root cause. Claim it before the product fix with a draft PR whose initial diff contains evidence for only that root cause.
7. Work on only that root cause. Add the diagnostic or regression evidence that should have caught an escaped defect.
8. When the PR waits for CI or peer review, stop editing it. Review a peer PR or take the next unowned root cause. Edit only one fix at a time.
9. Revisit waiting and blocked groups during each scan. Rescan after a run, check, review, PR, or merge state changes. Rescan for each new automatic `main` result.

If nothing is actionable, use the available wait or monitoring mechanism. Resume when a relevant result changes.

## Apply Common Decisions

- If Linux and macOS jobs have the same stable readiness signature, group them in one claim.
- If the latest PR commit changes, discard the review of the prior commit. Claim and review the latest PR commit before approval.
- If a later automatic `main` run proves that another merge removed the root cause, close the open fix as obsolete. Credit only the superseding fix.

## Claim One Root Cause

Before changing product code:

1. Apply the ambiguous GitHub write rule in [Review and Merge](references/review-and-merge.md) to every GitHub write.
2. Search open PR titles and bodies using the run ID, job ID, stable error signature, affected component, and likely fix area.
3. Read plausible matches. A different job with the same cause is already owned; a similar symptom with a different cause is not.
4. Create a branch from refreshed `origin/main`.
5. Add one diagnostic or regression test for the root cause when feasible. If no test can demonstrate only that root cause before the fix, mark the group `blocked`. Do not edit product code or add an unrelated placeholder diff.
6. Immediately before creating the draft, re-read open PRs and agent coordination for the root-cause key. Recount the author's open PRs under the policy from refreshed `origin/main`. Run both checks immediately before the write.
7. If a matching claim exists or the new PR would exceed the limit, do not create it. Record the existing owner or limit state and rescan.
8. Otherwise, open a draft PR assigned to its author. Follow `nemoclaw-contributor-create-pr` for the template, verified commits, and DCO declaration.
9. Put the root-cause key, source workflow URL, source run ID, failed job names and IDs, and failure signature in the PR body. Fix exactly one root cause in that PR.

Do not begin a second active fix for the same agent. Waiting PRs may accumulate only within the open-PR limit.

## Review and Merge Peer PRs

Read [Review and Merge](references/review-and-merge.md) before reviewing, approving, refreshing, or merging an E2E maintenance PR.

- Never approve your own PR. After an independent approval of the latest PR commit, either the author or another maintainer may perform the final merge.
- Independently review another maintainer's commit under review. Do not exchange approvals without reviewing correctness, security, tests, and scope.
- Do not duplicate an active peer review. Respect an explicit review claim for the same commit SHA in agent coordination, a PR comment, or a submitted review.
- Do not manually request reviewers unless the current user or repository-owned configuration authorizes the request. Follow [Follow Up on PR CI and Reviews](../_shared/pr-follow-up.md).
- Require at least one approval of the latest PR commit from an account that did not open, author, or co-author the PR.
- Require the maintainer gate checker, all GitHub-required checks, and any applicable security review to pass.
- Refresh a branch only at the final merge gate and only when the decision table requires it. Refresh before approval because the new commit invalidates earlier approval and CI evidence.
- Re-read the PR and rules immediately before merge. Never use an administrator bypass.

## Do Not Duplicate E2E

Observe automatic push runs and replacement attempts that the workflow starts. Never use `gh run rerun`, `gh workflow run .github/workflows/e2e.yaml`, or local live E2E to duplicate an automatic run.

Approving a first-time contributor's ordinary `pull_request` workflow after trust review is not a manual E2E dispatch. Environment approval for a secret-bearing or hardware E2E job is different: follow `nemoclaw-maintainer-e2e` only when the maintainer explicitly requests that run.

Never weaken, skip, delete, relabel, or narrow coverage to make a failure disappear. Do not freeze `main`, block unrelated merges, or ask other maintainers to wait.

## Close Obsolete Work

Before each fix push and merge decision, check whether `main` or another PR already removed the root cause. When it did:

1. Verify the superseding change against the original failure signature.
2. Stop editing the obsolete fix.
3. Close its PR with the superseding PR or commit and the verification evidence. Re-read the PR after the write.
4. Mark the queue item `obsolete`; do not count it as this loop's verified fix.

## Contain a Failed Merge

Treat an automatic `main` run as a post-merge failure when either condition is true:

- The run preserves the claimed root-cause signature.
- The run shows a regression caused by the merged fix.

1. The loop agent that confirms the failure becomes the containment owner until an acknowledged
   handoff names another owner.
2. Mark the root cause `blocked`. Pause merge writes for the failed root cause and for fixes that
   depend on the affected `origin/main` commit.
3. Run the `post-merge-e2e` state through the write policy evaluator in
   [Review and Merge](references/review-and-merge.md).
4. Never revert `main` directly. If the request explicitly authorizes creation of a rollback PR,
   open one draft revert PR that the policy evaluator permits. Include the merge SHA, first parent, failed
   run and jobs, original signature, regression signature, and containment scope.
5. If authorization to create a rollback PR is absent or attribution is uncertain, make no rollback write. Route the
   evidence to a maintainer with explicit authorization and continue unrelated queue reads.
6. Apply the ordinary independent review, required checks, commit SHA, and merge authorization gates
   to the revert PR. A merge grant for the loop does not grant a bypass or direct rollback.

Resume related merge writes only after an authorized revert or corrective PR merges and a later automatic
`main` run proves that the original failure and the regression are absent. Operator authorization may
choose a different action, but it must name the affected merge and the new containment owner.

## Transfer Without Ending the Loop

The loop has no scheduled end time. An agent may leave only after the operator cancels the loop or another active agent acknowledges ownership of monitoring and every open item.

Before leaving after a transfer or cancellation, finish only a non-destructive read already in progress. Perform the required read-only reconciliation for each ambiguous GitHub write. Start no other read. Preserve source edits. Delete each owned temporary-evidence directory and verify its absence. Produce the [Continuity Handoff](references/continuity-handoff.md). For a transfer, continue monitoring until the receiving agent acknowledges ownership.

A passing automatic run verifies only its tested `main` commit SHA. It does not complete the loop. Do not report `main` as passing when its newest relevant E2E run is queued, running, cancelled, stale, or failing.
