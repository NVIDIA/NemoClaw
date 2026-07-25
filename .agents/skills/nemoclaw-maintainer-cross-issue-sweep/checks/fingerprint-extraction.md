<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Fingerprint Extraction

Run `scripts/extract-fingerprint.sh <pr>` to collect the PR fingerprint.

## Contents

- Touched files (paths)
- Touched symbols (per-language)
- Error-string tokens
- Primary linked issue

## Touched files

Read the paths from `gh pr view <pr> --json files`.
Keep source paths. Remove test fixtures, generated files, and lockfiles.

File matching finds issues that name a file but do not name a symbol.

## Touched symbols

Apply each language pattern to added and modified diff lines. `repo-policy.md` contains the defaults.

Symbol matching finds issues that name a function but not its file.

Apply these filters:

- Extract symbols from added and modified lines. Do not extract them from deleted lines.
- Remove common short names such as `do`, `if`, and `as`.
- Remove language keywords.
- Remove test-helper names such as `describe`, `it`, and `test`.

## Error-string tokens

Strings inside:

- `throw new Error("...")` / `throw Error("...")`
- `console.error("...")`
- `print(f"...")` / Python f-strings flagged with error-shape (`Error:`, `Failed`)
- Distinctive flag/option names (`--no-color`, `--verbose`)

Error-string matching finds issues that contain output from the changed code.

Apply these filters:

- Remove strings with fewer than eight characters.
- Remove strings that have no letters.
- Remove placeholders such as `%s`, `${var}`, and `{0}` before the search.

## Primary linked issue

From the PR body, parse:

- `closes #N` / `fixes #N` / `resolves #N`
- `Linked Issue: #N` block

Exclude this issue from the search results.

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

Pass this output to `scripts/search-candidate-issues.sh`.
