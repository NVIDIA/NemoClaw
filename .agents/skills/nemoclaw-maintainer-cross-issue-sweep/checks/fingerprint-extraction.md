# Fingerprint Extraction

What to pull from the PR diff and how. Run `scripts/extract-fingerprint.sh <pr>` to do this mechanically.

## Contents

- Touched files (paths)
- Touched symbols (per-language)
- Error-string tokens
- Primary linked issue

## Touched files

From `gh pr view <pr> --json files`. Filter to source paths (drop test fixtures, generated files, lockfiles).

**Why baseline:** Some issues mention a file path but no symbol. Without file matching, those go uncaught.

## Touched symbols

Per-language regex against added/modified lines in the diff. Defaults live in `repo-policy.md`.

**Why this is the killer angle:** Most matchers stop at file paths. A user issue saying "validateInput rejects empty strings" pinpoints a function — file-path matching alone misses it if the function is in a different module than expected.

**Filtering rules:**

- Only extract symbols from added/modified lines, not deleted lines (those are going away)
- Drop common short names (`do`, `if`, `as`) — too noisy
- Drop language keywords
- Drop test-helper names (`describe`, `it`, `test`) — they match too many issues

## Error-string tokens

Strings inside:

- `throw new Error("...")` / `throw Error("...")`
- `console.error("...")`
- `print(f"...")` / Python f-strings flagged with error-shape (`Error:`, `Failed`)
- Distinctive flag/option names (`--no-color`, `--verbose`)

**Why this catches symptoms:** When a user files an issue, they often paste the error message they saw. That string is high-info and rarely false-matches.

**Filtering rules:**

- Skip strings <8 chars (too generic)
- Skip strings with no alpha chars
- Strip placeholders (`%s`, `${var}`, `{0}`) before searching

## Primary linked issue

From the PR body, parse:

- `closes #N` / `fixes #N` / `resolves #N`
- `Linked Issue: #N` block

Captured for **exclusion** during search. Without this, every PR self-matches its own issue.

## Output

Fingerprint JSON shape:

```json
{
  "pr": 2851,
  "files": ["src/lib/shields.ts", "Dockerfile.base"],
  "symbols": ["normalize_mutable_config_perms", "applyStateDirLockMode"],
  "error_strings": ["EACCES on .openclaw"],
  "primary_issue": 2681
}
```

Consumed by `scripts/search-candidate-issues.sh`.
