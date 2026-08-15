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

A first-time fork contributor might need **Approve and run** before `pull_request` checks appear.
Former PR E2E contexts are advisory and do not affect `allPass`.

### GitHub Actions Evidence

Required PR workflows must identify the PR number, PR SHA, and base SHA.
The installer-hash workflow runs trusted verification after each `pull_request` `edited` event.
Fail closed when identity, state, or timing evidence is missing, malformed, stale, contradictory, or changed.

### Live E2E

Live E2E does not run automatically for pull requests and is not a merge gate.
Each push to `main` selects the E2E targets and jobs that own changed files.
Each trusted push also selects the CPU-only Jetson nvmap proof.
Push runs skip the DGX Spark llama.cpp jobs because push events cannot set their required workflow dispatch flag.
Manual Jetson runs remain opt-in through `allow_jetson_dispatch`, which defaults to `false`.
The workflow has no scheduled trigger.

Use the manual PR mode only when a maintainer requests live evidence before merge.
An empty-selector manual run exposes these values to candidate-controlled job processes:

- Long-lived API keys from repository secrets: `NVIDIA_INFERENCE_API_KEY`, `NVIDIA_API_KEY`, and `BRAVE_API_KEY`.
- Long-lived messaging credentials from repository secrets: `TELEGRAM_BOT_TOKEN_REAL`, `DISCORD_BOT_TOKEN_REAL`, `SLACK_BOT_TOKEN_REAL`, and `SLACK_APP_TOKEN_REAL`.
- The job-scoped `GITHUB_TOKEN` in the `token-rotation` and `openshell-gateway-upgrade` jobs. It has `checks: read`, `contents: read`, and `pull-requests: read` access. Candidate code can use it while either job runs. GitHub Actions invalidates it after the job.
- Messaging account and channel identifiers from repository secrets: `TELEGRAM_ALLOWED_IDS`, `TELEGRAM_AUTHORIZED_CHAT_IDS`, `TELEGRAM_CHAT_ID`, `TELEGRAM_CHAT_ID_E2E`, `DISCORD_CHANNEL_ID_E2E`, and `SLACK_CHANNEL_ID_E2E`.

The workflow does not rotate or revoke these API keys or messaging credentials. To remove later access, rotate or revoke every listed credential in the external service that issued it. The workflow cannot erase identifiers copied by candidate code. Review the complete candidate diff before dispatch.
Live targets can create external resources.
After a failure, inspect the artifacts and remove resources that target cleanup did not remove.

Dispatch the trusted `main` workflow with the current PR number, lowercase 40-character head SHA, head repository, lowercase 40-character base SHA, trusted workflow SHA, and a review reason containing 10 to 500 printable characters.
Leave job and target selectors empty and keep Launchable disabled.
Keep `allow_jetson_dispatch=false` and `allow_dgx_spark_runner_queue=false` for the default PR revision selection.
If the DGX Spark flag is `true`, GitHub can pause `llama-cpp-dgx-spark-qualification` for the `approve-dgx-spark-image-qualification` environment.
An authorized environment reviewer must approve it before qualification starts.
The trusted pre-checkout step requires current `maintain` or `admin` access and validates the exact open PR before candidate code runs.

The manual run is advisory.
Treat it as passing evidence only when the `E2E` workflow concludes with `success` for the recorded PR number, head repository, head SHA, base SHA, and workflow SHA.
A changed head repository, head SHA, or base SHA invalidates the result.

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
