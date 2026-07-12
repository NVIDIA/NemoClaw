<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Verdict Template

Render the final scorecard with `scripts/render-verdict.py`. Below is the human-readable shape it produces.

```markdown
## PR Comparison Verdict — Issue #<issue>

### Acceptance Criteria
- [ ] <criterion 1, from issue body>
- [ ] <criterion 2, from issue body>
- [ ] <criterion 3, from comment by @user>

### Per-PR Scorecard

| Check | PR #A | PR #B |
|---|---|---|
| **Tier 0 — gates** | | |
| State OPEN | pass | pass |
| CI green (latest SHA) | pass | fail (stale) |
| Mergeable | pass | pass |
| Contributor compliance | pass | pass |
| Branch protection | pass | pass |
| PR Review Advisor: merge as-is | pass | fail (changes requested) |
| Automated-review threads resolved | pass | fail (2 unresolved) |
| **Tier 1 — correctness** | | |
| Test exercises bug path | pass | pass |
| Comment-as-spec coverage | pass | yellow (misses ask 3) |
| Negative test coverage | fail | pass |
| Coverage shape | pass | pass |
| Refactor-vs-behavior scan | pass | pass |
| Mocking purity | pass | yellow |
| **Tier 2 — quality** | | |
| Description-vs-diff drift | pass | pass |
| Migration completion | pass | yellow (no follow-up link) |
| Public surface preservation | pass | pass |
| **Weighted score** | 14.5 / 16.0 | 9.0 / 16.0 |

### Behavior Coverage Matrix

| Criterion | PR #A | PR #B |
|---|---|---|
| <criterion 1> | covered | covered |
| <criterion 2> | covered | missing |
| <criterion 3> | missing | covered |

### Verdict: MERGE PR #A

Reasoning trace:
- PR #B failed Tier 0 (CI fail on latest SHA after force-push at SHA <hash>)
- PR #A score 18.5 vs PR #B score 14.0
- PR #A misses criterion 3; cherry-pick PR #B's test at <file:line> to cover it

### Suggested action

1. Merge PR #A
2. Cherry-pick test from PR #B at `<file>:<line-range>` to cover criterion 3
3. Close PR #B with comment linking to #A and noting the cherry-pick

### Reasoning evidence
- Tier 0 gate "CI green": PR #A latest SHA <hash>, all 12 required checks passed; PR #B latest SHA <hash>, "test-cli" failed at <log-line>
- Tier 1.1 PR #A: test at `<file>:<line-range>` asserts on <output>; pre-fix code returned <wrong-output>; assertion would have failed
- Tier 1.3 PR #A fail: no test for empty-input edge case despite issue commenter raising it at `issue.comment.4`
- ... <one entry per non-trivial judgment> ...
```

Every judgment in the trace must include:

- File:line reference or SHA/log line
- The fact observed
- The inference made
- The score contributed (full / half / zero)

If the verdict is **degraded mode** ("Neither mergeable yet"), substitute the verdict block:

```markdown
### Verdict: Neither mergeable yet — PR #B is closer

**PR #A — ineligible:**
- Substantive: Rebase against current main (3 conflicts in `<file>`)
- Ineligible: contributor gate failed; the author must fix each failing requirement before re-review
  - Missing PR-body DCO declaration: update the PR body
  - Missing GitHub Verified commit history: replace the branch with compliant history

**PR #B — fix to merge:**
- Substantive: 5 unresolved CodeRabbit threads at `<thread-ids>`
- Substantive: macos-e2e check failing on test "<name>" at `<log-line>`

### Suggested action

1. Ask the PR #A author to fix each failing contributor gate; do not repair or approve the PR on their behalf
2. Salvage PR #B by resolving the substantive failures, then re-run this skill to confirm the winner
```
