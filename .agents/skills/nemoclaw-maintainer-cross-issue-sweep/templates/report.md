<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Report Template

`scripts/render-report.py` uses classified candidates to produce this structure.

```markdown
## Cross-issue scan — PR #<pr> (<pr-title>)

### Adjacent fixes (PR may also close)

- **#4521** (high) — empty-array check in `validateInput()` matches the symptom at issue body line 12.
  Suggested action: Add `closes #4521` to the PR body.
- **#4889** (medium) — same validation path. It matches the issue reproduction at line 7.

### Contradicting (coordinate before merge)

- **#4187** (medium) — PR rejects empty input. Issue #4187 requests opt-in allowance at body line 8.
  Suggested action: Discuss the approach with the author of #4187. Close #4187 only if the maintainer selects the PR behavior.

### Suppressed

- 7 unrelated candidates (filtered)
- 2 same-issue duplicates of primary #N (filtered)

### Reasoning trace (top 3 by impact)

- #4521 (high): `src/lib/validate.ts:42` adds `if (input.length === 0) return null`.
  Issue body line 12 reports that `validateInput` throws for an empty array.
  Issue comment 4 mentions PR #2851, so confidence increased from medium to high.
- #4889 (medium): `src/lib/validate.ts:50` rejects an empty value in a shared helper.
  The issue reproduction reaches that path. Comments indicate that #4889 can duplicate #4521.
- #4187 (medium): The rejection at line 42 conflicts with the opt-in request at issue body line 8.
```

If no results meet the confidence threshold, use this report:

```markdown
## Cross-issue scan — PR #<pr>

No adjacent fixes or contradictions found above the medium confidence floor.

Suppressed: <N> unrelated, <M> same-issue duplicates.
```
