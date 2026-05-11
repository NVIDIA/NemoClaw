# Report Template

The skill emits this structure. `scripts/render-report.py` produces it from a list of classified candidates.

```markdown
## Cross-issue scan — PR #<pr> (<pr-title>)

### Adjacent fixes (PR may also close)

- **#4521** (high) — empty-array check in `validateInput()` matches symptom at issue body line 12
  → suggest: add `closes #4521` to PR body
- **#4889** (medium) — same validation path; matches issue's repro at line 7

### Contradicting (coordinate before merge)

- **#4187** (medium) — PR strictly rejects empty input; #4187 requests opt-in allowance at body line 8
  → suggest: discuss approach with #4187's author or close #4187 as "fixed by alternative direction"

### Suppressed

- 7 unrelated candidates (filtered)
- 2 same-issue duplicates of primary #N (filtered)

### Reasoning trace (top 3 by impact)

- #4521 (high): PR diff `src/lib/validate.ts:42` adds `if (input.length === 0) return null` — issue
  body line 12: "validateInput throws when array is empty, expected null". Both cite the same
  function and the same desired behavior. Reverse-link applied: issue mentions PR #2851 in
  comment 4, boosted from medium to high.
- #4889 (medium): PR diff `src/lib/validate.ts:50` enforces non-empty in shared helper — issue
  repro at line 7 shows empty-array path. Match is structural but issue may be a duplicate of
  #4521 (commenters note same).
- #4187 (medium): PR's strict rejection at line 42 directly opposes #4187's "opt-in allow" ask
  at body line 8.
```

If no adjacent or contradicting candidates pass the confidence floor, the report just says:

```markdown
## Cross-issue scan — PR #<pr>

No adjacent fixes or contradictions found above the medium confidence floor.

Suppressed: <N> unrelated, <M> same-issue duplicates.
```
