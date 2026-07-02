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

This checks all gates programmatically and returns structured JSON with `allPass` and per-gate `pass`/`details`, including the PR Review Advisor status. Use [PR CI and Automated Review Follow-Up](../_shared/pr-follow-up.md) for the shared triage loop when individual findings need investigation.

## Step 2: Interpret Results

The script handles the deterministic checks. You handle judgment calls:

- **Missing required checks:** The script verifies that `checks`, `commit-lint`, and `dco-check` are present in the status rollup. If any are missing, **workflows have not been triggered** — this happens on fork PRs from first-time contributors that need "Approve and run" clicked in the Actions tab. Go to the PR's Checks tab, approve the workflows, wait for all checks to complete, then re-run the gate checker. **Never approve a PR with missing checks.**
- **Contributor compliance failed:** Reject the PR and ask the contributor to provide the PR-body DCO declaration or replace unverified commits with a clean verified history. Do not approve, merge, amend, sign, or force-push on the contributor's behalf.
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

**Any fail:**

| Gate | Status | What is needed |
|------|--------|----------------|
| CI | Failing | Fix flaky timeout test |
| Conflicts | DIRTY | Rebase onto main first — approval would be invalidated |

Use full GitHub links.
