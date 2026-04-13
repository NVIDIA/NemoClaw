# Merge Gate Workflow

Run the last maintainer check before approval. Never merge automatically.

## Gates

For the full priority list see [PR-REVIEW-PRIORITIES.md](PR-REVIEW-PRIORITIES.md). A PR is approval-ready only when **all** hard gates pass:

1. **CI green** — all required checks in `statusCheckRollup`.
2. **No conflicts** — `mergeStateStatus` clean.
3. **No major CodeRabbit** — ignore style nits; block on correctness/security bugs.
4. **Risky code tested** — see [RISKY-AREAS.md](RISKY-AREAS.md). Confirm tests exist (added or pre-existing).

## Step 1: Run the Gate Checker

```bash
node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/check-gates.ts <pr-number>
```

This checks all 4 gates programmatically and returns structured JSON with `allPass` and per-gate `pass`/`details`.

## Step 2: Interpret Results

The script handles the deterministic checks. You handle judgment calls:

- **Missing required checks:** The script verifies that `checks`, `commit-lint`, and `dco-check` are present in the status rollup. If any are missing, **workflows have not been triggered** — this happens on fork PRs from first-time contributors that need "Approve and run" clicked in the Actions tab. Go to the PR's Checks tab, approve the workflows, wait for all checks to complete, then re-run the gate checker. **Never approve a PR with missing checks.**
- **Conflicts (DIRTY):** Do NOT approve — GitHub invalidates approvals when new commits are pushed. Salvage first (rebase), wait for CI, then re-run the gate checker. Follow [SALVAGE-PR.md](SALVAGE-PR.md).
- **CI failing but narrow:** Follow the salvage workflow in [SALVAGE-PR.md](SALVAGE-PR.md).
- **CI pending:** Wait and re-check. Do not approve while checks are still running.
- **CodeRabbit:** Script flags unresolved major/critical threads. Review the `snippet` to confirm it's a real issue vs style nit. If doubt, leave unapproved.
- **Tests:** If `riskyCodeTested.pass` is false, follow [TEST-GAPS.md](TEST-GAPS.md).

## Step 3: Approve or Report

**Approve only when:** `allPass` is true AND `mergeStateStatus` is not DIRTY. Approving a PR with conflicts is wasted effort — the rebase will invalidate the approval.

The correct sequence for a conflicted PR: **salvage (rebase) → CI green → approve → report ready for merge.**

**All pass + no conflicts:** Approve and summarize why.

**Any fail:**

| Gate | Status | What is needed |
|------|--------|----------------|
| CI | Failing | Fix flaky timeout test |
| Conflicts | DIRTY | Rebase onto main first — approval would be invalidated |

Use full GitHub links.
