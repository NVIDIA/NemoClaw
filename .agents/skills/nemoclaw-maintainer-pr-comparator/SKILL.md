---
name: nemoclaw-maintainer-pr-comparator
description: Compares competing PRs that target the same issue and recommends which one to merge. Runs gate, correctness, and quality checks; outputs a deterministic scorecard with reasoning trace. Use when an issue has two or more open PRs and a maintainer needs to decide which to merge.
user_invocable: true
---

# PR Comparator

Picks the merge winner among competing PRs for a single issue. Tier 0 gates eliminate plumbing failures; Tiers 1-2 score correctness and quality; Tier 3 applies deterministic tiebreakers. Degraded mode handles the case where no PR passes gates.

## Prerequisites

- `gh` CLI installed and authenticated
- A target repository with an issue that has 2+ open PRs

## Repo policy

Defaults assume NemoClaw conventions (security CODEOWNERS, DCO, CodeRabbit, `docs/` directory). For other repos, edit `repo-policy.md` to override.

## Workflow

Copy this checklist into your response and check off each step:

```text
PR Comparison Progress:
- [ ] Step 1: Parse issue (body + comments) for acceptance criteria
- [ ] Step 2: Discover candidate PRs (default-order search with stop conditions)
- [ ] Step 3: Detect supersession (parse PR bodies)
- [ ] Step 4: Run Tier 0 gates per PR
- [ ] Step 5: Run Tier 1 correctness checks per PR
- [ ] Step 6: Run Tier 2 quality checks per PR
- [ ] Step 7: Compute weighted scores
- [ ] Step 8: Apply Tier 3 ranking (happy path or degraded mode)
- [ ] Step 9: Emit verdict using templates/verdict.md
```

### Step 1: Parse issue

Extract acceptance criteria from issue body **and all comments**:

```bash
gh issue view <issue-number> --json title,body,comments
```

Read every comment — commenters often add asks the body doesn't capture.

### Step 2: Discover candidate PRs

```bash
scripts/find-candidates.sh <issue-number>
```

Applies a single default order with stop conditions.

### Step 3: Detect supersession

```bash
scripts/parse-supersession.sh <pr-number-1> <pr-number-2> ...
```

Parses each PR body for `supersedes #N`, `replaces #N`, `closes in favor of #N`, `folds in #N`. A PR that supersedes another wins ties immediately.

### Step 4: Tier 0 gates

```bash
scripts/collect-gates.sh <pr-number>
scripts/check-coderabbit-threads.sh <pr-number>
```

Five gates, all mandatory. See `checks/tier-0-gates.md` for the full list and interpretation.

### Step 5: Tier 1 correctness

Six checks, all LLM judgments. See `checks/tier-1-correctness.md` for evidence requirements per check.

### Step 6: Tier 2 quality

Three checks, all LLM judgments. See `checks/tier-2-quality.md`.

### Step 7: Weighted score

- Each pass = full points
- Each yellow = half points
- Each fail = zero
- Tier 1 weight: 2.0× per check
- Tier 2 weight: 1.0× per check

### Step 8: Tier 3 ranking

Branch on whether any PR passes all Tier 0 gates. See `tiebreakers.md` for happy-path tiebreakers, degraded-mode distance-to-ready ranking, and the behavior-coverage matrix.

### Step 9: Emit verdict

Use `templates/verdict.md`. Every judgment must carry evidence (file:line refs, diff snippets), reasoning chain, and the score it contributed.

## Reference files

- `repo-policy.md` — configurable defaults per target repo
- `checks/tier-0-gates.md` — plumbing gates
- `checks/tier-1-correctness.md` — six correctness checks
- `checks/tier-2-quality.md` — three quality checks
- `tiebreakers.md` — Tier 3 ranking and degraded mode
- `templates/verdict.md` — output template
- `validation/backtest.md` — backtest the skill against historical cases

## Scripts (execute, do not read)

- `scripts/find-candidates.sh` — PR discovery
- `scripts/collect-gates.sh` — Tier 0 gate evaluation
- `scripts/check-coderabbit-threads.sh` — GraphQL thread resolution
- `scripts/parse-supersession.sh` — body parsing for supersession refs
- `scripts/render-verdict.py` — verdict scorecard renderer

## What this skill does NOT do

These require infrastructure beyond GitHub API + LLM and are deferred to v2 modules:

- Running each PR's code against adversarial inputs (sandboxed execution)
- Cross-issue regression sweep (separate skill)
- Revert simulation against neighbor PRs
- Static analyzer integration (CodeQL, Semgrep)
