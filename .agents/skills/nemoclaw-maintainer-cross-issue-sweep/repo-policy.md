<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Repo Policy

Defaults for the target repository.

## Contents

- Search caps
- Symbol-extraction language regex
- Bot-author exclusions
- Confidence threshold

## Search caps

```yaml
per_symbol_top: 10        # top N issues per symbol search
per_file_top: 5           # top N issues per file path search
per_error_string_top: 5   # top N issues per error string search
max_total_candidates: 30  # limit before model judgment
```

The search limits control cost. `max_total_candidates` limits classification calls for each PR.

## Symbol extraction (per-language regex)

Symbols are function/class/exported names extracted from added/modified lines in the diff.

```yaml
typescript:
  - 'function\s+([A-Za-z_$][\w$]*)'      # function foo()
  - 'class\s+([A-Za-z_$][\w$]*)'         # class Foo
  - 'export\s+(?:default\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)'
  - 'const\s+([A-Za-z_$][\w$]*)\s*='     # const foo = ...

python:
  - 'def\s+([A-Za-z_][\w]*)'
  - 'class\s+([A-Za-z_][\w]*)'

go:
  - 'func\s+(?:\([^)]*\)\s+)?([A-Z][\w]*)'  # exported funcs only
  - 'type\s+([A-Z][\w]*)'

shell:
  - '^([a-z_][\w]*)\s*\(\)\s*\{'         # function definitions
```

Change or add languages for another repository.

## Bot-author exclusions

Do not include issues from these automated accounts:

```yaml
excluded_authors:
  - dependabot[bot]
  - renovate[bot]
  - github-actions[bot]
```

## Confidence threshold

Drop judgments below this:

```yaml
confidence_floor: medium
```

Use `low` to include all candidates. Use `high` to include high-confidence results only.
