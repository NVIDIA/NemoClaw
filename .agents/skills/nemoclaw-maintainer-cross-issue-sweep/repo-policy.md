# Repo Policy

Configurable defaults that adapt the skill to a specific repository.

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
max_total_candidates: 30  # hard cap before LLM judgment
```

Per-search caps balance recall against cost. The hard cap bounds total LLM calls per PR.

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

Override or add languages here for non-NemoClaw repos.

## Bot-author exclusions

Issues authored by these accounts are skipped during candidate search (they're noise — automated bug reports, dependency bots, etc.):

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

Set to `low` if you want to see every flagged candidate; `high` if you want only the most confident bundling/contradiction signals.
