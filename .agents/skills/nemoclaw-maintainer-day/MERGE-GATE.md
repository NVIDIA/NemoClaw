<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Merge Gate Workflow

Use this workflow in two phases: confirm that an eligible reviewer may approve, then confirm that the
resulting independent approval makes the PR merge-ready. Never merge automatically.

## Gates

For the full priority list see [PR-REVIEW-PRIORITIES.md](PR-REVIEW-PRIORITIES.md). The final
merge-ready result requires **all** hard gates to pass:

1. **Contributor compliance** — the PR body contains the contributor's `Signed-off-by:` declaration and every PR commit appears as `Verified` in GitHub. Reject noncompliant PRs; maintainers do not repair contributor history.
2. **Independent human approval** — `independent-human-approval` passes for the latest reviewable push. The qualifying reviewer must not be the PR opener, an author, co-author, committer, pusher, or direct code applier. A generic `reviewDecision: APPROVED` is insufficient.
3. **CI green** — all required checks in `statusCheckRollup`.
4. **No conflicts** — `mergeStateStatus` clean.
5. **No major CodeRabbit** — ignore style nits; block on correctness/security bugs.
6. **PR Review Advisor: merge_as_is** — `check-gates.ts` checks this automatically. The gate passes only when the latest advisor comment has `recommendation: merge_as_is`. All other recommendation values — including `blocked`, `needs_rework`, `merge_after_fixes`, `superseded`, `info_only`, and any unknown value — fail the gate. The referenced Actions run is validated (name, event, head SHA, run attempt, timestamp) before the recommendation is trusted. Correctness, security, acceptance, and test-depth findings block until addressed or explicitly judged false-positive by a maintainer.
7. **Risky code tested** — see [RISKY-AREAS.md](RISKY-AREAS.md). Confirm tests exist (added or pre-existing).

The repository-side Actions result is an interim defense-in-depth signal. It does not provide
tamper-proof contributor storage or a dedicated check identity. Full #6222 enforcement requires the
same check from a dedicated GitHub App or service source pinned in the `main` ruleset.

## Step 1: Run the Gate Checker

```bash
node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/check-gates.ts <pr-number>
```

This checks all gates programmatically and returns structured JSON with `allPass` and per-gate `pass`/`details`, including the PR Review Advisor status. Use [PR CI and Automated Review Follow-Up](../_shared/pr-follow-up.md) for the shared triage loop when individual findings need investigation.

## Step 2: Interpret Results

The script handles the deterministic checks. You handle judgment calls:

- **Missing required checks:** The script verifies that `checks`, `commit-lint`, `dco-check`, and `independent-human-approval` are present in the status rollup. Missing ordinary CI checks can mean that workflows have not been triggered; this happens on fork PRs from first-time contributors that need "Approve and run" clicked in the Actions tab. A missing independent-approval check means the policy service is unavailable or not configured. A same-named result from the interim shared Actions identity is not the final source-isolated gate. Resolve the missing or unqualified check before approval.
- **Contributor compliance failed:** Reject the PR and ask the contributor to provide the PR-body DCO declaration or replace unverified commits with a clean verified history. Do not approve, merge, amend, sign, or force-push on the contributor's behalf.
- **Conflicts (DIRTY):** Do NOT approve. Salvage first (rebase), wait for CI, then re-run the gate checker. A new reviewable push makes the independent-approval gate pending until one eligible human approves; earlier reviews remain recorded. Follow [SALVAGE-PR.md](SALVAGE-PR.md).
- **Current actor contributed code:** Inspect `gates.actorEligibleToApprove`. When it fails, do not approve; keep any existing review as advisory and hand the PR to another eligible human. This actor-specific result controls who may add a review, while `allPass` remains the PR's merge-readiness result after an independent approval already exists. The interim actor check reads PR-comment observations, which are not tamper-proof; full enforcement depends on the dedicated service's durable contributor record.
- **CI failing but narrow:** Follow the salvage workflow in [SALVAGE-PR.md](SALVAGE-PR.md).
- **CI pending:** Wait and re-check. Do not approve while checks are still running.
- **CodeRabbit:** Script flags unresolved major/critical threads. Review the `snippet` to confirm it's a real issue vs style nit. If doubt, leave unapproved.
- **PR Review Advisor blocked:** `gates.prAdvisor.pass` will be false and `allPass` false. Read the full advisor comment on the PR, apply [PR CI and Automated Review Follow-Up](../_shared/pr-follow-up.md), and do not approve until the required findings are addressed or explicitly judged false-positive by a maintainer.
- **Tests:** If `riskyCodeTested.pass` is false, follow [TEST-GAPS.md](TEST-GAPS.md).

## Step 3: Approve, Re-run, or Report

Treat approval readiness and merge readiness as separate states:

- **Approval-ready:** Every non-approval check passes, `gates.actorEligibleToApprove.pass` is true, the independent check is present but waiting for a qualifying approval, and `mergeStateStatus` is not `DIRTY`. The eligible actor may then submit one approval, wait for the policy check, and re-run the gate checker.
- **Merge-ready:** `allPass` is true, `mergeStateStatus` is not `DIRTY`, and the independent check comes from the dedicated source pinned in the ruleset. The PR already has its qualifying approval, so do not add a redundant review. Report it ready for a separate merge decision. If only the interim Actions result exists, report that the defense-in-depth signal passed but full policy enforcement is not active.
- **Blocked:** Any other failure remains unresolved. Report the failed gate and required next action without approving.

`allPass` includes both the independent-human-approval and PR Review Advisor gates. The script
matches the approval check by name; it does not prove the dedicated ruleset source pin. Treat
`allPass` as the final merge-readiness result only after that external source requirement is active.
It is not a prerequisite for an eligible reviewer to submit the qualifying approval.

The correct sequence for a conflicted PR: **salvage (rebase) → CI green → independent human approval → report ready for merge.**

**All pass + no conflicts:** Report merge-ready and summarize why.

**Any fail:**

| Gate | Status | What is needed |
|------|--------|----------------|
| CI | Failing | Fix flaky timeout test |
| Conflicts | DIRTY | Rebase onto main first; the new reviewable push will make the independent gate pending |

Use full GitHub links.
