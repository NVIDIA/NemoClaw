# Tier 3 — Ranking and Degraded Mode

Final decision logic. Two paths: happy mode when at least one PR passes all Tier 0 gates, degraded mode when none do.

## Contents

- Happy mode: weighted score + tiebreakers
- Degraded mode: distance-to-ready
- Behavior-coverage matrix

## Happy mode (≥1 PR passes Tier 0)

Eliminate any PR failing Tier 0. Among survivors:

1. Compute weighted score across Tiers 1-2.
2. Build the **behavior-coverage matrix** (see below). If matrix has a clear winner per criterion, that wins.
3. Apply tiebreakers in order. First tiebreaker that distinguishes the PRs picks the winner.

### Tiebreakers (in order)

1. **Supersession.** Any PR whose body declares `supersedes #N` / `replaces #N` / `closes in favor of #N` / `folds in #N` against another candidate wins immediately. (See `scripts/parse-supersession.sh`.)
2. **Smaller diff.** Lines changed proportional to the issue's scope. Bug fixes target <200 LOC.
3. **Better edge-case test coverage.** Compare Tier 1.3 (negative test coverage) outputs.
4. **Most recent activity.** Compare last commit timestamps. Catches stalled-PR-replaced-by-fresh patterns.
5. **Earlier PR (final deterministic fallback).** Use only when nothing above distinguishes — first-mover gets the tie.

If after all five tiebreakers no PR wins: recommend "merge A, cherry-pick relevant tests from B," picking A by lowest PR number deterministically.

## Degraded mode (no PR passes Tier 0)

Don't give up — pick the closest-to-ready and recommend salvage steps.

1. Classify each Tier 0 failure per PR:
   - **Trivial** (auto-fixable): missing sign-off, missing issue link, stale base, force-pushed since last review
   - **Substantive** (real work): CI red, mergeability conflicts, missing CODEOWNERS approvals, unresolved CodeRabbit threads
2. Distance-to-ready ranking:
   - Fewer substantive failures wins
   - Tie → fewer trivial failures wins
   - Tie → higher Tier 1-2 weighted score wins (correctness beneath the broken plumbing)
3. Output:
   - Per-PR Tier 0 failure list
   - Per-PR Tier 1-2 scorecard (so the winner has objective merit beneath the gates)
   - Verdict: "Neither mergeable yet. PR A is closer — fix [substantive list]. PR B has [issues]."
   - Salvage steps per PR (rebase command, sign-off command, CR thread links, etc.)

## Behavior-coverage matrix

For each acceptance criterion (from issue body + comments), build a row showing which PRs cover it:

```text
| Criterion                    | PR #A      | PR #B      |
|------------------------------|------------|------------|
| Empty input rejected         | covered    | covered    |
| Boundary value handled       | covered    | missing    |
| "Don't break Y" (commenter)  | missing    | covered    |
| Error message preserved      | covered    | partial    |
```

**Why the matrix matters:** When neither PR dominates on weighted score, the matrix surfaces the cherry-pick opportunity. The verdict can recommend "merge A for criteria 1+2+4, cherry-pick B's test for criterion 3."

Per-criterion winner cells: `covered` (full), `partial` (yellow), `missing` (red).
