# Backtest Harness

Run the comparator retroactively against historical cases to measure false-positive and false-negative rates before trusting it on new decisions.

## Contents

- Selecting historical cases
- Running the backtest
- Interpreting results
- Failure modes to watch

## Selecting historical cases

A historical case is a closed-and-resolved competition between two or more PRs for the same issue. Find them via:

```bash
# PRs closed without merge that explicitly mention being superseded
gh pr list --state closed --search "is:closed -is:merged" --limit 100 \
  --json number,title,closedAt,body \
  --jq '.[] | select(.body | test("supersed|duplicate|fixed by|closed in favor"; "i")) | {number, title}'

# Merged PRs whose body explicitly superseded another
# `in:body` is a search qualifier, not a flag — keep it inside the query string.
gh search prs --repo OWNER/REPO --merged "supersedes in:body" --limit 30
```

Pick 5-10 cases spanning different patterns:

- Both PRs identical, one merged first (timing race)
- Different architectural approaches (workaround vs. root-cause)
- Stalled-PR-replaced-by-fresh chain
- One PR with CI failures and one green
- Author re-cut their own work after DCO/sign-off issue

Record each case as: `(issue, [pr_a, pr_b, ...], actual_winner_pr)`.

## Running the backtest

For each historical case:

1. Run the skill against the issue + candidate PRs
2. Compare the skill's verdict against `actual_winner_pr`
3. Classify:
   - **Match**: skill picked the actual winner → no error
   - **False positive**: skill recommended a PR that was rejected in real life → investigate why
   - **False negative**: skill rejected the PR that actually merged → investigate why
   - **Ambiguous**: skill returned no clear winner when one existed

## Interpreting results

Target rates on 5-10 cases:

- False positive rate: <10%
- False negative rate: <5%
- Ambiguous rate: <10%

If above thresholds, identify the failing tier or check, sharpen the LLM prompt or add a missing tiebreaker, re-run.

Examples of past patches surfaced through backtest:

- Case where two PRs were byte-identical and the older one was closed-then-superseded → added Tier 0 gate "PR state must be OPEN"
- Case where a 3-PR refactor chain had only the freshest mergeable → added Step 2.5 supersession detection and freshness tiebreaker

## Failure modes to watch

- **Tier 0 too strict.** Eliminating PRs for trivial CI flakes that auto-resolve. Mitigation: cross-reference latest commit's CI vs. previous run's CI.
- **Tier 1 LLM hallucination.** LLM claims a test exercises the bug path when it doesn't. Mitigation: require evidence (file:line) and reasoning chain in every judgment.
- **Tier 3 tiebreaker noise.** Tiebreaker fires too aggressively, picks a worse PR. Mitigation: log which tiebreaker decided each case during backtest; if one tiebreaker consistently produces wrong picks, demote or remove it.
- **Description-vs-diff drift false positive.** Author's "Changes" section is terse and the LLM doesn't recognize implied files. Mitigation: train on more "implied counts as covered" examples in `checks/tier-2-quality.md`.
