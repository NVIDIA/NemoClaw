<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Merge Gate Workflow

Run the maintainer check before approval. Never merge.

## Gates

Approve a PR only when all hard gates pass. See [PR-REVIEW-PRIORITIES.md](PR-REVIEW-PRIORITIES.md).

1. **Product scope approved** — Confirm that the PR implements supported behavior or a linked product decision.
   Do not approve a new product surface because it works.
   Require ownership, lifecycle, compatibility, security, and validation requirements.
   Route independent solutions through [Community Solutions](../../../docs/resources/community-contributions.mdx).
2. **Contributor requirements pass** — Require the contributor's `Signed-off-by:` declaration in the PR body.
   Require every commit to appear as `Verified` in GitHub.
   Authors with a case-normalized login of `dependabot[bot]` or `app/dependabot` do not need the PR-body declaration.
   Dependabot commits must still appear as `Verified`.
3. **CI passed for the PR SHA** — Require successful evidence for each check on the PR SHA and base SHA.
4. **PR state did not change** — Require the PR to remain open and not draft.
   During evaluation, its title, body, PR SHA, base branch, base SHA, mergeability, and merge state must not change.
   Require `MERGEABLE` and a merge state that the gate permits.
5. **No major CodeRabbit findings** — Confirm that there is no unresolved correctness or security issue.
   Ignore style comments. Block correctness and security defects.
6. **Risky code has tests** — See [RISKY-AREAS.md](RISKY-AREAS.md). Tests can be new or existing.

## Step 1: Run the gate checker

```bash
node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/check-gates.ts <pr-number>
```

The script checks gates that do not require judgment. It returns JSON with `allPass`, gate results, and advisories.
The contributor and approver overlap advisory does not change `allPass`.
A maintainer must decide product scope. `allPass` does not include that decision.

Use [Follow Up on PR CI and Reviews](../_shared/pr-follow-up.md) to investigate CI or review findings.

## Step 2: Interpret the results

### Product scope

Stop if the PR creates a product surface without an accepted issue or design decision.
Tests, CI, and positive review output do not replace product approval.
Ask a maintainer for a product decision or route the work through [Community Solutions](../../../docs/resources/community-contributions.mdx).

### Required checks

The checker requires these status-rollup entries:

- `checks`
- `check-hash`
- `changes`
- `commit-lint`
- `dco-check`
- `E2E / PR Gate`

A first-time fork contributor might need **Approve and run** before `pull_request` checks appear.
The E2E controller records the PR SHA and base SHA without running fork code.
Do not waive a missing, neutral, or skipped E2E gate.
Do not run fork code with privileged credentials to create a result.

### GitHub Actions evidence

Required PR workflows must identify the PR number, PR SHA, and base SHA.

- The installer-hash workflow runs trusted verification after each `pull_request` `edited` event.
  Its run name records `gate true` and the base SHA. A metadata edit must not create skipped evidence.
- Each `pull_request_target` E2E controller run that performs work must use an immutable `gate true` run name.
  The run name must identify the PR number, PR SHA, and base SHA.
- GitHub usually associates the run with the PR.
  If that association is empty, require the controller path, branch, repository, and run time to match the coordination check.
- Discard a later all-skipped `gate false` metadata run only when a stronger run exists for the same PR SHA and base SHA.
- Fail closed when identity, state, or timing evidence is missing, malformed, stale, contradictory, or changed.

### Controller status and PR status

`E2E / PR Gate Controller` reports whether the controller published an outcome.
It can pass while `E2E / PR Gate Coordination` and the required `E2E / PR Gate` job fail.
Use the required `E2E / PR Gate` job as merge evidence.
Use the coordination check for the verdict and evidence links.

`Superseded by PR update` and `PR closed — gate no longer applies` cancel checks for a prior SHA.
Do not act on those checks. The PR SHA and base SHA still need a successful gate.
The closed-PR outcome also covers a deleted fork repository with no head-repository value.

### Retry an E2E gate

Rerun `CI / Pull Request` only when the failed coordination check has a supported retry reason for its gate version.
The retry must apply to the PR SHA and base SHA.

- `prerequisite-ci` — Rerun CI. Let the controller retry after CI passes.
- `child-cancelled` — Rerun CI when the child workflow was cancelled.
  You can also rerun it when every listed non-passing job was cancelled.
- `evidence-download` — Rerun CI when a successful child's evidence download failed, was cancelled, or was skipped.

The controller keeps each completed coordination check as audit history.
For a retry, it creates an `in_progress` check for the same PR SHA and base SHA.
The controller and observer select the check with the highest ID only when all older duplicates are completed failures with supported retry markers.
Fail closed for an unexpected app, identity mismatch, duplicate ID, unsupported terminal state, or multiple active checks.

Do not retry these terminal failures on the same SHA:

- Selected-job or typed-target product failures.
- Assertion failures.
- Evidence policy or integrity failures.
- Reconciliation or controller errors.
- Unknown states.
- Failures recorded before retry reasons existed.

Push a change to create another SHA, and then run CI again.
A passing controller does not override a failing required job.

### Evidence download failures

If a selected child passes but `Download evidence` fails, the gate fails closed.
This also applies when the step is cancelled or skipped.
The coordination check records `evidence-download`, and the controller fails.

Inspect the download step before you rerun eligible PR CI.
Do not use the successful child by itself as evidence.

A completed download can still produce a failing PR verdict.
This occurs when signals are missing, duplicated, skipped, pending, or failing.
In this case, the controller can pass without a retry reason.

Malformed or unsafe evidence is a terminal controller error.
Schema mismatches, identity mismatches, and traversal-limit errors are also terminal.
The coordination check, required job, and controller must fail closed.

### Approve an E2E skip for a fork PR

Use the protected-environment path when the coordination check reports `Maintainer approval required to skip credentialed E2E`.

1. Follow the `E2E / PR Gate Controller run <id>` link in the coordination summary.
2. Select **Review deployments**.
3. Select `approve-credentialed-e2e-skip-for-fork-pr`.
4. Add a comment when useful, and approve.

This approval records that credential-bearing jobs and targets did not run.
It does not authorize fork code to use repository secrets.
The waiting job has `deployment: false`, no secrets, and no PR-controlled execution.

The controller reads the approval history and requires one approval for that environment.
The reviewer must still have `maintain` or `admin` access.
The controller also checks the PR number, PR SHA, base SHA, plan, failed check, compatible `main`, and PR state.

An accepted approval completes the coordination check with this result:
`Credentialed E2E skipped for fork PR — approved by @<maintainer>`.
The summary starts with `Outcome: APPROVED SKIP — credentialed E2E did not run.`
Treat this result as an audited skip, not as E2E evidence.

Configure the environment before rollout.
Require reviewers with `maintain` or `admin` access.
Do not add secrets, variables, or a protection app. Disable administrator bypass when possible.

If **Review deployments** is absent, the environment might be missing, unprotected, or no longer waiting.
Configure it, push a change, and run PR CI again. You can also use the manual fallback below.
Do not rerun the waiting workflow. The controller accepts an environment approval only on the first attempt.
Per-PR concurrency cancels a waiting approval when another SHA reaches the gate.

### Use the manual fork-skip fallback

Use this fallback only after the gate reports `Maintainer approval required to skip credentialed E2E`.
Review the fork change and non-secret PR CI first. Prefer the protected-environment path.

The controller rejects these states:

- The PR is closed.
- The PR SHA or base SHA changed.
- The PR is internal.
- The E2E plan is empty.
- The gate did not fail.
- The controller commit is not `main` or a validated ancestor of `main`.
- The reviewer does not have maintainer access.

A permitted `main` advance must keep the controller commit as its merge base.
It must contain fewer than 300 listed changed files and no `e2e-control-plane` changes.
Other advances fail closed.
Immediately before it writes success, the controller confirms that the PR is open and that the PR SHA, base SHA, and coordination identity still match.
It fails closed if any value changed or does not match.
Its result records the reviewer, optional comment, approval-run URL, plan, and work that did not run.

To use the fallback, select **Run workflow** on `main` and then select `approve-fork-e2e-skip`.
Provide these inputs:

- The fork PR number.
- The 40-character PR SHA as `expected_head_sha`.
- The 40-character base SHA as `expected_base_sha`.
- A reason of 10 to 500 characters.

Read both SHAs before dispatch.
You can give an `evidence_url` that matches `https://github.com/NVIDIA/NemoClaw/actions/runs/<run-id>`.
Leave it blank when no supporting run exists.
The workflow rejects PR, issue, comment, job, and external URLs.
It validates the repository and run-ID format. It does not inspect that run's SHA, jobs, targets, or result.

### Authorize E2E control-plane changes

The `e2e-control-plane` path group includes these areas:

- E2E and PR-CI workflows.
- Risk policy.
- Dependency and test configuration.
- Preparation and upload actions.
- Non-documentation files under `tools/e2e/` and `test/e2e/`.
- Shell and Python support files in those directories.

An internal PR can run automatically when it changes only these files:

- `.github/workflows/pr-e2e-gate.yaml`
- `tools/e2e/pr-e2e-gate.mts`
- `tools/e2e/pr-e2e-required.mts`

Another control-plane change fails with `Maintainer authorization required to run E2E`.
The gate must not run selected jobs or expose secrets before authorization.

Review the PR SHA and non-secret CI.
Then, select **Run workflow** on `main` and select `run-control-plane`.
Provide the PR number, 40-character `expected_head_sha`, 40-character `expected_base_sha`, and a `review_reason` of 10 to 500 characters.
Read both SHAs before dispatch.

The first attempt requires the actor to have `maintain` or `admin` access.
The workflow rejects forks, stale or closed PRs, plans that need no authorization, and empty selections.
It also rejects a missing coordination check, an identity mismatch, or an incompatible controller commit.
It reads the PR SHA and base SHA before dispatch.
Before any result reaches success, it confirms that the PR is open and that the PR SHA, base SHA, and coordination identity still match.
It fails closed if any value changed or does not match.

Authorization returns `E2E / PR Gate Coordination` to `in_progress`.
It runs selected jobs through the wait, evidence-download, and finish process.
Authorization cannot record success by itself.
Only verified evidence for the PR SHA can make `E2E / PR Gate` pass.

### Authorize a typed target

The risk plan can select a target from the allowlist for a workflow check.
It can dispatch jobs and targets in one child run.
Apply all authorization, selection, secret, skip, evidence, and finish rules to jobs and targets.

### Roll out a required E2E context

Use this order:

1. Deploy the E2E check producer and its fork handling.
2. Rerun `CI / Pull Request` for each open PR SHA and base SHA.
   Approve a first-time fork run when necessary.
3. Verify that `E2E / PR Gate` is attached to that PR SHA and base SHA.
4. Use the gate checker to find PRs that still need a check.

Do not enable the required context before the producer is ready.
GitHub does not create a context for prior runs.
If you enable the rule first, open PRs can wait for a status that does not exist.

Do not use the shared GitHub Actions app identity as the security boundary.
It cannot distinguish this workflow from another workflow.
First use a dedicated GitHub App or an organization required-workflow rule.
Then enable strict, up-to-date status checks.
Without this setting, a successful PR SHA can remain mergeable after `main` changes the merge result.
Keep the control-plane review and gate checks after rollout.

### Contributor requirement failure

Reject a PR that lacks the PR-body DCO declaration or has an unverified commit.
Ask the contributor to correct the PR body or replace the commit history.
Only the two Dependabot logins above do not need the PR-body declaration.
They still need verified commits.
Do not approve, merge, amend, sign, or force-push for the contributor.

### Contributor and approver overlap

Report `advisories.contributorApprovalOverlap` when the same non-bot account contributes and approves.
The contributor set contains the PR opener, commit authors, and co-authors.
Use the account's most recent opinionated review.

Read all GraphQL pages for contributors and reviews.
The advisory includes contributors whose commits remain in the PR SHA.
It does not retain push actors or authors removed from the history.
If review timestamps are missing, invalid, or conflicting, report a warning.
Also report a warning if all pages cannot be read.

The advisory does not prove that approval is independent.
It is not a policy, required check, or branch-protection rule.
It does not change `allPass`, approval, or merge readiness.
This scope follows the maintainer decision in issue #6233. Issue #6222 contains the related proposal.

Tests cover opener, author, and co-author overlap.
They also cover bot filtering, case normalization, review changes, pagination, and timestamp errors.
Remove the advisory if GitHub or approved policy provides the same signal.
Replace it if the project adopts an independent-approval requirement.

### Other results

- **Base or PR changed:** Do not approve.
  Refresh the branch when needed, wait for CI, and run the checker again.
  Follow [SALVAGE-PR.md](SALVAGE-PR.md).
- **CI failure with a small fix:** Follow [SALVAGE-PR.md](SALVAGE-PR.md).
- **CI pending:** Wait and check again. Do not approve.
- **CodeRabbit finding:** Read the snippet. Decide whether it reports a correctness or security problem, or a style comment.
- **PR Review Advisor finding:** Treat it as review input, not merge authority.
  Verify each claim against code, tests, and workflow evidence.
  Apply confirmed problems to a gate. Ask the user about ambiguous or design-changing advice.
  Advisor labels, absence, and source do not affect `check-gates.ts` or `allPass`.
- **Missing tests:** Follow [TEST-GAPS.md](TEST-GAPS.md).

## Step 3: Approve or report

Approve only when all these conditions are true:

- The product-scope gate passes.
- `allPass` is true for the PR SHA and base SHA.
- GitHub reports `MERGEABLE` and a permitted merge state.
- No correctness or security problem remains.

The advisor cannot authorize a merge or change readiness.
Do not approve a stale or conflicted PR. A later refresh invalidates the approval.

For a conflicted PR, use this order:

1. Rebase and resolve conflicts.
2. Wait for CI to pass.
3. Approve.
4. Report that the PR is ready for a merge decision.

After approval, run the gate checker again.
This check can find contributor and approver overlap created by the approval.
Report that advisory. Do not treat it as a failed gate.

If a gate fails, report the gate and the required action:

| Gate | Status | Required action |
|------|--------|-----------------|
| CI | Failing | Fix the named job or test. |
| Conflicts | GitHub does not report `MERGEABLE`, or the merge state is not permitted for the base SHA. | Rebase before approval. |

Use GitHub links.
