---
name: nemoclaw-maintainer-cross-issue-sweep
description: Scans other open issues to find ones a given PR may also fix or accidentally break. Outputs adjacent-fix opportunities and contradiction risks with file:line evidence. Use when reviewing a PR to discover bundling opportunities or downstream impact across the issue queue.
user_invocable: true
---

# Cross-Issue Regression Sweep

Surfaces the issues a single PR may also fix or accidentally break beyond the one it claims to address. Two outputs:

- **Adjacent fixes** — "PR may also close #X" → bundling intel (ship one PR, close multiple issues)
- **Contradicting risks** — "PR may break what #Y wants" → coordination needed before merge

## Prerequisites

- `gh` CLI authenticated
- A target repository with open issues
- An open PR to scan

## Repo policy

Defaults assume NemoClaw conventions. Edit `repo-policy.md` to override per-repo (bot logins, candidate caps, language regex).

## Workflow

Copy this checklist into your response and check off each step:

```text
Cross-issue sweep progress:
- [ ] Step 1: Extract fingerprint (files, symbols, error strings, primary issue)
- [ ] Step 2: Search candidate issues (capped at 30, primary excluded)
- [ ] Step 3: Classify each candidate (4-class with evidence)
- [ ] Step 4: Apply reverse-link boost
- [ ] Step 5: Filter (drop UNRELATED, SAME_ISSUE_DIFF, low-confidence)
- [ ] Step 6: Render report using templates/report.md
```

### Step 1: Extract fingerprint

```bash
scripts/extract-fingerprint.sh <pr-number>
```

Pulls four dimensions: touched files, touched symbols (per-language regex), error-string tokens, and the PR's primary linked issue (for exclusion). See `checks/fingerprint-extraction.md`.

### Step 2: Search candidate issues

```bash
scripts/search-candidate-issues.sh <fingerprint-json>
```

Three search dimensions, capped at 30 total candidates:

- Per symbol: top 10 by recency
- Per file path: top 5 by recency
- Per error string: top 5 by recency

Dedupes; excludes the PR's primary linked issue.

### Step 3: Classify each candidate

For each candidate, the LLM classifies as one of four classes per `checks/relationship-judgment.md`:

- **ADJACENT_FIX** — PR's changes likely also resolve this issue
- **CONTRADICTING** — PR's approach blocks what this issue wants
- **SAME_ISSUE_DIFF** — same root bug as PR's primary issue (dedup filter)
- **UNRELATED** — no meaningful relationship

Required for ADJACENT_FIX or CONTRADICTING:

- Cite specific PR diff line
- Cite specific issue symptom
- Confidence: high / medium / low

If no specific evidence can be cited, the LLM must answer UNRELATED. This floors hallucination.

### Step 4: Reverse-link boost

If the candidate issue's body or comments already mention this PR's number, the relationship is already in someone's mental model. Boost confidence by one tier (low → medium, medium → high).

### Step 5: Filter

- Suppress UNRELATED + SAME_ISSUE_DIFF
- Drop low-confidence judgments
- Keep ADJACENT_FIX and CONTRADICTING with high or medium confidence

### Step 6: Render report

```bash
scripts/render-report.py < classifications.json
```

See `templates/report.md` for the format.

## Reference files

- `repo-policy.md` — configurable per-repo defaults
- `relationship-rules.md` — 4-class definitions with worked examples
- `checks/fingerprint-extraction.md` — what to pull from the diff, per language
- `checks/relationship-judgment.md` — LLM judgment criteria + evidence requirement
- `templates/report.md` — output template
- `validation/backtest.md` — backtest the skill against historical PRs

## Scripts (execute, do not read)

- `scripts/extract-fingerprint.sh` — symbols + paths + error strings, deterministic
- `scripts/search-candidate-issues.sh` — GitHub Search wrapper, dedupe, cap
- `scripts/render-report.py` — report renderer

## Composition with other skills

The pr-comparator (`nemoclaw-maintainer-pr-comparator`) calls this skill as a sub-step when comparing competing PRs. Adjacent-fix counts feed Tier 3 tiebreakers; contradicting hits factor into Tier 2 quality scoring.

## What this skill does NOT do (deferred)

These would raise the ceiling but require infrastructure beyond GitHub API + LLM:

- Run PR code against adversarial inputs (sandboxed)
- Static-analyzer dataflow tracing (CodeQL, Semgrep)
- ML-based symbol disambiguation across codebases
