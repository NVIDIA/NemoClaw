# Backtest

Run the sweep retroactively on PRs that turned out to fix or break other issues, measure FP/FN before trusting it on new PRs.

## Selecting historical cases

Find merged PRs that retroactively closed adjacent issues:

```bash
gh search prs --repo OWNER/REPO --merged "closes # in:body" --limit 50 \
  --json number,title,body
```

Look for PRs whose body lists multiple `closes #N` references — those are the ground-truth bundling cases.

For contradictions, search merged PRs whose body mentions another issue that was later closed as wontfix or alternative:

```bash
gh search prs --repo OWNER/REPO --merged "supersedes OR alternative in:body" --limit 30
```

Pick 5-8 cases.

## Running

For each historical PR:

1. Reset the skill's view to the time before the PR merged (use `--state open at:<date>`-style filters where possible)
2. Run `scripts/extract-fingerprint.sh <pr>`, `scripts/search-candidate-issues.sh`, then the LLM judgment
3. Compare adjacent-fix output against PR's actual `closes #N` list
4. Compare contradicting output against issues that were closed as alternative/wontfix near the merge date

## Targets

- **Adjacent recall**: skill found ≥80% of issues the PR actually closed
- **Adjacent precision**: ≥70% of skill-flagged adjacent issues were actually closed by the PR
- **Contradicting precision**: ≥80% of skill-flagged contradictions were actually contested
- **End-to-end runtime**: <60s per PR

## Failure modes to watch

- **Symbol false positives**: a function name appears in the issue but the issue is about a different layer. Mitigation: tighten symbol extraction (drop short/generic names) or require multi-dimension match (symbol + file).
- **Error-string false positives**: same error message appears in unrelated issues. Mitigation: require LLM to cite the specific scenario, not just the matching string.
- **LLM evidence-skipping**: LLM marks ADJACENT_FIX without citing specific lines. Mitigation: stricter prompt; reject responses missing citations.
- **Reverse-link over-boost**: issue mentions PR but the relationship is irrelevant (e.g., user said "unrelated to PR #2851"). Mitigation: detect negation context before applying the boost.
