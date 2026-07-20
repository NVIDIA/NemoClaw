---
name: nemoclaw-maintainer-cross-issue-sweep
description: Scan open issues to find issues that a PR can also fix or conflict with. Report each relationship with file and line evidence. Use this skill during PR review to find related fixes and risks.
user_invocable: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Cross-Issue Regression Sweep

Find open issues that a PR can affect in addition to its linked issue. Report two relationship types:

- **Adjacent fix** — The PR can also resolve another issue.
- **Conflict** — The PR can prevent the behavior that another issue requests.

## Prerequisites

- `gh` CLI authenticated
- A target repository with open issues
- An open PR to scan

## Repo policy

The defaults use NemoClaw conventions. Edit `repo-policy.md` for another repository.

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

The script collects changed files, changed symbols, error strings, and the linked issue.
See `checks/fingerprint-extraction.md`.

### Step 2: Search candidate issues

```bash
scripts/search-candidate-issues.sh <fingerprint-json>
```

Search these three inputs. Keep no more than 30 candidates:

- Per symbol: top 10 by recency
- Per file path: top 5 by recency
- Per error string: top 5 by recency

Remove duplicates and the linked issue.

### Step 3: Classify each candidate

Classify each candidate with the rules in `checks/relationship-judgment.md`:

- **ADJACENT_FIX** — The PR can resolve this issue.
- **CONTRADICTING** — The PR conflicts with the requested behavior.
- **SAME_ISSUE_DIFF** — same root bug as PR's primary issue (dedup filter)
- **UNRELATED** — no meaningful relationship

For ADJACENT_FIX or CONTRADICTING, cite:

- A PR diff line.
- An issue symptom.
- Confidence: high / medium / low

Classify the issue as UNRELATED if this evidence is not available.

### Step 4: Reverse-link boost

Increase confidence by one level if the issue body or comments mention the PR number.

### Step 5: Filter

- Remove UNRELATED and SAME_ISSUE_DIFF results.
- Remove low-confidence results.
- Keep high- and medium-confidence ADJACENT_FIX and CONTRADICTING results.

### Step 6: Render report

```bash
scripts/render-report.py < classifications.json
```

See `templates/report.md` for the format.

## Reference files

- [repo-policy.md](repo-policy.md) — Repository settings.
- [relationship-rules.md](relationship-rules.md) — Four relationship classes and examples.
- [checks/fingerprint-extraction.md](checks/fingerprint-extraction.md) — Diff evidence by language.
- [checks/relationship-judgment.md](checks/relationship-judgment.md) — Classification and evidence rules.
- [templates/report.md](templates/report.md) — Output template.
- [validation/backtest.md](validation/backtest.md) — Historical test cases for the skill.

## Scripts (execute, do not read)

- `scripts/extract-fingerprint.sh` — symbols, paths, and error strings
- `scripts/search-candidate-issues.sh` — GitHub Search wrapper, dedupe, cap
- `scripts/render-report.py` — report renderer

## Composition with other skills

This skill is an optional follow-up to `nemoclaw-maintainer-pr-comparator`.
The comparator does not run this skill or use its findings in the score.
Run this skill when a maintainer asks for related-issue evidence. Report the evidence separately.

## Limits

The skill does not:

- run PR code against adversarial inputs
- trace data flow with a static analyzer such as CodeQL or Semgrep
- disambiguate symbols across codebases with a machine-learning model
