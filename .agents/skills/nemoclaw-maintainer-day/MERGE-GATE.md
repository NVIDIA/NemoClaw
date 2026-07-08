<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Merge Gate Workflow

Run the last maintainer check before approval. Never merge automatically.

## Gates

For the full priority list see [PR-REVIEW-PRIORITIES.md](PR-REVIEW-PRIORITIES.md). A PR is approval-ready only when **all** hard gates pass:

1. **Contributor compliance** — the PR body contains the contributor's `Signed-off-by:` declaration and every PR commit appears as `Verified` in GitHub. Reject noncompliant PRs; maintainers do not repair contributor history.
2. **CI green** — all required checks in `statusCheckRollup`.
3. **No conflicts** — `mergeStateStatus` clean.
4. **No major CodeRabbit** — ignore style nits; block on correctness/security bugs.
5. **PR Review Advisor: merge_as_is** — `check-gates.ts` checks this automatically. The gate passes only when the latest advisor comment has `recommendation: merge_as_is`. All other recommendation values — including `blocked`, `needs_rework`, `merge_after_fixes`, `superseded`, `info_only`, and any unknown value — fail the gate. The referenced Actions run is validated (name, event, head SHA, run attempt, timestamp) before the recommendation is trusted. Correctness, security, acceptance, and test-depth findings block until addressed or explicitly judged false-positive by a maintainer.
6. **Risky code tested** — see [RISKY-AREAS.md](RISKY-AREAS.md). Confirm tests exist (added or pre-existing).

## Step 1: Run the Gate Checker

```bash
node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/check-gates.ts <pr-number>
```

This checks all gates programmatically and returns structured JSON with `allPass`, per-gate `pass`/`details`, and non-blocking `advisories`, including contributor/approver overlap. Use [PR CI and Automated Review Follow-Up](../_shared/pr-follow-up.md) for the shared triage loop when individual findings need investigation.

## Step 2: Interpret Results

The script handles the deterministic checks. You handle judgment calls:

- **Missing required checks:** The script verifies that `checks`, `commit-lint`, and `dco-check` are present in the status rollup. If any are missing, **workflows have not been triggered** — this happens on fork PRs from first-time contributors that need "Approve and run" clicked in the Actions tab. Go to the PR's Checks tab, approve the workflows, wait for all checks to complete, then re-run the gate checker. **Never approve a PR with missing checks.**
- **Contributor compliance failed:** Reject the PR and ask the contributor to provide the PR-body DCO declaration or replace unverified commits with a clean verified history. Do not approve, merge, amend, sign, or force-push on the contributor's behalf.
- **Contributor/approver overlap:** Surface `advisories.contributorApprovalOverlap` when the same account not recognized as automated by the supported login conventions appears as the current PR opener, commit author, or co-author and its latest opinionated review is approved. The invalid state detected here is contributor and approver identity overlap in the current GitHub PR metadata; the source boundary is the current opener plus all commit-author and review pages fetched through GitHub's GraphQL API. The advisory includes contributors whose commits remain in the current PR head at check time; it does not retain original push actors or authors removed when history is rebased, squashed, or fixed up. A clear result is not proof of independent approval. Missing, invalid, or conflicting review timestamps, or failure to retrieve complete paginated history, produce a warning because the latest opinion cannot be selected reliably.

  This is intentionally diagnostic-only under the maintainer scope decision recorded in the #6233 discussion; #6222 remains the broader proposal context. It is not an independent-approval policy, required check, branch-protection rule, or substitute for explicit human merge authorization, so it does not invalidate approval, require another reviewer, or change `allPass` or merge readiness. Mocked-GitHub regression tests cover opener and commit-author/co-author overlap, bot filtering, case normalization, latest-review transitions across API pages, timestamp ordering, incomplete timestamps, and incomplete paginated history. Remove this advisory if GitHub or a maintainer-approved authoritative control provides the same overlap signal, or replace it if the project adopts an enforced independent-approval policy.
- **Conflicts (DIRTY):** Do NOT approve — GitHub invalidates approvals when new commits are pushed. Salvage first (rebase), wait for CI, then re-run the gate checker. Follow [SALVAGE-PR.md](SALVAGE-PR.md).
- **CI failing but narrow:** Follow the salvage workflow in [SALVAGE-PR.md](SALVAGE-PR.md).
- **CI pending:** Wait and re-check. Do not approve while checks are still running.
- **CodeRabbit:** Script flags unresolved major/critical threads. Review the `snippet` to confirm it's a real issue vs style nit. If doubt, leave unapproved.
- **PR Review Advisor blocked:** `gates.prAdvisor.pass` will be false and `allPass` false. Read the full advisor comment on the PR, apply [PR CI and Automated Review Follow-Up](../_shared/pr-follow-up.md), and do not approve until the required findings are addressed or explicitly judged false-positive by a maintainer.
- **Tests:** If `riskyCodeTested.pass` is false, follow [TEST-GAPS.md](TEST-GAPS.md).

## Step 3: Approve or Report

**Approve only when:** `allPass` is true and `mergeStateStatus` is not DIRTY. `allPass` now includes the PR Review Advisor gate, so a blocked advisor comment alone prevents approval. Approving a PR with conflicts is wasted effort — the rebase will invalidate the approval.

The correct sequence for a conflicted PR: **salvage (rebase) → CI green → approve → report ready for merge.**

**All pass + no conflicts:** Approve and summarize why.

After submitting an approval, re-run the gate checker before reporting the PR ready. This captures an approval that creates contributor/approver overlap during the current maintainer pass.

If the contributor/approver advisory is present, include it in the summary without converting it into a failed gate.

**Any fail:**

| Gate | Status | What is needed |
|------|--------|----------------|
| CI | Failing | Fix flaky timeout test |
| Conflicts | DIRTY | Rebase onto main first — approval would be invalidated |

Use full GitHub links.
