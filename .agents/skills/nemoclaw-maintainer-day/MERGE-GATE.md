<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Decide Whether to Approve a Pull Request

Approve only when the trusted checker passes and all maintainer judgments pass for the same PR commit and base commit. This workflow never merges.

## Apply the approval rule

See [PR Review Priorities](PR-REVIEW-PRIORITIES.md). Require all conditions:

- An accepted issue or design decision establishes product scope. For a new product surface, it also defines ownership, lifecycle, compatibility, security, and validation expectations.
- The PR body has the contributor's `Signed-off-by:` declaration.
- GitHub marks every commit as `Verified`.
- Required CI passes for the recorded PR commit and base commit.
- The PR remains open, not draft, `MERGEABLE`, and in a permitted merge state.
- No unresolved correctness or security finding remains.
- Risky code has applicable tests from [Risky Areas](RISKY-AREAS.md).

Dependabot does not need the PR-body declaration. Its login must be `dependabot[bot]` or `app/dependabot`. Its commits must still be verified.

## Run the trusted checker

From the clean candidate checkout, refresh canonical `origin/main`, then execute the wrapper source from that ref. The trusted ref—not the candidate checkout—selects the wrapper. It compares the gate source with the candidate checkout, executes the trusted copy, and removes its temporary worktree:

```bash
git fetch --no-tags origin refs/heads/main:refs/remotes/origin/main
bash <(git show origin/main:.agents/skills/nemoclaw-maintainer-day/scripts/run-trusted-check-gates.sh) <pr-number>
```

Read the effective rules for `main` before approval:

```bash
gh api --paginate "repos/NVIDIA/NemoClaw/rules/branches/main"
```

Require every active status and review rule to pass for the recorded PR commit and base commit.

The checker returns `allPass`, gate results, and advisories. It does not decide product scope. The contributor-and-approver overlap advisory does not change `allPass`.

Fail closed when the PR commit, base commit, state, timing, or required evidence is missing, malformed, stale, contradictory, or changed.

## Complete maintainer judgments

### Product scope

Stop when no accepted issue or design decision establishes a new product surface. Tests and successful CI do not establish product approval. Ask for a maintainer decision or route an independent solution through [Community Solutions](../../../docs/resources/community-contributions.mdx).

### CI and review evidence

Use [Follow Up on PR CI and Reviews](../_shared/pr-follow-up.md) to collect and classify CI and review evidence. Treat PR Review Advisor output as review input, not approval authority.

A first-time fork contributor can require an **Approve and run** decision before PR checks appear. Review the complete diff before that approval. Do not expose repository secrets or privileged credentials to candidate code.

### Live E2E

Live E2E is not a default PR merge gate. When a maintainer requires it, use `nemoclaw-maintainer-e2e`. Evaluate its result for this PR.

### Contributor and approver overlap

Report `advisories.contributorApprovalOverlap`. The advisory does not prove independent approval and does not change `allPass`.

The contributor set includes the PR opener, commit authors, and co-authors. Use each account's most recent opinionated review. Warn when pagination or review timestamps are incomplete or conflicting.

## Decide

| Result | Action |
|---|---|
| Product scope is not approved | Stop and request a maintainer decision. |
| Contributor declaration or verification fails | Ask the contributor to correct the body or commit history. Do not amend, sign, or force-push for them. |
| PR or base commit changed | Do not approve. Restart the gate for the new state. |
| CI or review is pending | Wait. |
| A narrow repair or mechanical conflict is required | Follow [Salvage a Pull Request](SALVAGE-PR.md). |
| A required test is missing | Follow [Test Gaps](TEST-GAPS.md). |
| All checker gates and maintainer judgments pass | Approve the commit under review. |

Do not approve a conflicted PR. A branch refresh invalidates the prior approval evidence.

## Recheck and report

After approval, run the trusted checker and read the effective rules again. Confirm that no rule, PR commit, base commit, required check, review decision, or merge state changed.

Report the gate result, required action, advisory output, and PR URL. Report that the PR can proceed to a separate merge decision. Never merge in this workflow.
