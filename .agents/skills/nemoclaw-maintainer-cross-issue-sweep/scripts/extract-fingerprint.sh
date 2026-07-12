#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Extract the four fingerprint dimensions from a PR diff:
#   - touched files
#   - touched symbols (per-language regex)
#   - error-string tokens
#   - primary linked issue (for exclusion)
#
# Usage: extract-fingerprint.sh <pr-number> [--repo OWNER/REPO]
# Output: JSON to stdout

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <pr-number> [--repo OWNER/REPO]" >&2
  exit 64
fi

pr="$1"
if ! [[ "$pr" =~ ^[0-9]+$ ]]; then
  echo "Usage: $0 <pr-number> [--repo OWNER/REPO]" >&2
  echo "Error: <pr-number> must be numeric (got '$pr')." >&2
  exit 64
fi
shift || true
repo_args=()
if [ "${1:-}" = "--repo" ]; then
  if [ -z "${2:-}" ]; then
    echo "Usage: $0 <pr-number> [--repo OWNER/REPO]" >&2
    exit 64
  fi
  repo_args=(--repo "$2")
fi

# Touched files (drop test fixtures, lockfiles, generated outputs). Fail
# fast if `gh pr view` errors — auth/repo/PR-not-found should not silently
# produce an empty fingerprint that downstream consumers treat as "valid
# but no candidates."
files=$(gh pr view "$pr" "${repo_args[@]+"${repo_args[@]}"}" --json files --jq '[.files[].path] | map(select(
    test("/(fixtures|generated|node_modules)/") | not
  )) | map(select(
    (endswith("package-lock.json") or endswith("yarn.lock") or endswith("pnpm-lock.yaml")) | not
  ))' 2>/dev/null) || {
  echo "Failed to fetch PR files for #$pr (auth, repo, or PR number)" >&2
  exit 65
}

# Diff for symbol + error-string extraction.
diff=$(gh pr diff "$pr" "${repo_args[@]+"${repo_args[@]}"}" 2>/dev/null) || {
  echo "Failed to fetch PR diff for #$pr" >&2
  exit 65
}

# Touched symbols. Extract from added/modified lines (start with `+`, not `+++`).
# Per-language regex; defaults match TypeScript/JavaScript/Python/Go/shell.
# Use `sed -n` instead of `grep | sed` so deletion-only diffs don't trip pipefail.
added_lines=$(printf '%s\n' "$diff" | sed -n '/^\+[^+]/s/^+//p')

# Each `grep` is followed by `|| true` so PRs touching only docs/comments
# (no symbols, no error strings) don't abort the script under pipefail.
# Two `export` patterns instead of one keep `export default function foo`
# resolving to `foo` rather than the `function` keyword.
extract_symbols() {
  printf '%s' "$1" | grep -oE 'function [A-Za-z_$][A-Za-z0-9_$]*' | awk '{print $2}' || true
  printf '%s' "$1" | grep -oE 'class [A-Za-z_$][A-Za-z0-9_$]*' | awk '{print $2}' || true
  printf '%s' "$1" | grep -oE 'def [A-Za-z_][A-Za-z0-9_]*' | awk '{print $2}' || true
  printf '%s' "$1" | grep -oE 'func [A-Z][A-Za-z0-9_]*' | awk '{print $2}' || true
  # Go receiver methods: `func (r *Repo) GetIssue(...)` — capture the method name.
  printf '%s' "$1" | grep -oE 'func \([^)]+\) [A-Z][A-Za-z0-9_]*' | awk '{print $NF}' || true
  # Go exported types: `type ExportedName struct/interface/...`.
  printf '%s' "$1" | grep -oE 'type [A-Z][A-Za-z0-9_]*' | awk '{print $2}' || true
  printf '%s' "$1" | grep -oE 'const [A-Za-z_$][A-Za-z0-9_$]*' | awk '{print $2}' || true
  printf '%s' "$1" | grep -oE 'export default (function|class) [A-Za-z_$][A-Za-z0-9_$]*' | awk '{print $4}' || true
  printf '%s' "$1" | grep -oE 'export (function|class|const|let|var) [A-Za-z_$][A-Za-z0-9_$]*' | awk '{print $3}' || true
  # POSIX shell function declarations: `name() { ... }`.
  printf '%s\n' "$1" | sed -nE 's/^([a-z_][A-Za-z0-9_]*)[[:space:]]*\(\)[[:space:]]*\{.*/\1/p' || true
}

# Drop common short / language-keyword names. Keep symbols >= 4 chars.
# Use awk for both filters so empty input doesn't trigger grep's exit-1.
symbols=$(extract_symbols "$added_lines" \
  | awk 'length($0) >= 4 && $0 !~ /^(if|for|let|var|const|new|do|of|as|in|is|to|on|at|by|or|and|the|set|get|map|run|all|any)$/' \
  | sort -u \
  | head -n 50 \
  | jq -Rn '[inputs | select(length > 0)]')

# Error-string tokens. Look for content inside throw new Error("..."), console.error("..."),
# distinctive error-shaped strings starting with capital + 'Error'/'Failed'/etc.
extract_error_strings() {
  printf '%s' "$1" | grep -oE 'throw new Error\("[^"]+"\)' | sed -E 's/throw new Error\("([^"]+)"\)/\1/' || true
  # `throw Error("...")` without `new` — also valid JS.
  printf '%s' "$1" | grep -oE 'throw Error\("[^"]+"\)' | sed -E 's/throw Error\("([^"]+)"\)/\1/' || true
  printf '%s' "$1" | grep -oE 'console\.error\("[^"]+"\)' | sed -E 's/console\.error\("([^"]+)"\)/\1/' || true
  printf '%s' "$1" | grep -oE '"[A-Z][^"]*\b(Error|Failed|Cannot|Unable|Invalid|Missing|Unsupported)\b[^"]*"' | tr -d '"' || true
  # Python f-strings printed via print(f"...") containing error-shape keywords.
  printf '%s\n' "$1" | sed -nE 's/.*print\(f"([^"]*(Error:|Failed|Cannot|Unable|Invalid|Missing|Unsupported)[^"]*)"\).*/\1/p' || true
  # Flag/option tokens — high-info, rarely false-match (e.g. --no-color, --verbose).
  printf '%s' "$1" | grep -oE -- '--[a-z0-9][a-z0-9-]+' || true
}

error_strings=$(extract_error_strings "$added_lines" \
  | awk 'length($0) >= 8 && /[A-Za-z]/' \
  | sed 's/%[sd]/X/g; s/\${[^}]*}/X/g; s/{[0-9]*}/X/g' \
  | sort -u \
  | head -n 20 \
  | jq -Rn '[inputs | select(length > 0)]')

# Primary linked issue — first match in body for closes/fixes/resolves #N.
body=$(gh pr view "$pr" "${repo_args[@]+"${repo_args[@]}"}" --json body --jq .body 2>/dev/null) || {
  echo "Failed to fetch PR body for #$pr" >&2
  exit 65
}
primary_issue=$(
  {
    printf '%s' "$body" | grep -oiE '(closes|fixes|resolves|fix)\s+#[0-9]+' || true
    printf '%s' "$body" | grep -oiE 'linked[[:space:]]+issue:[[:space:]]*#[0-9]+' || true
  } \
    | { grep -oE '[0-9]+' || true; } \
    | head -n 1
)
primary_issue="${primary_issue:-null}"

cat <<JSON
{
  "pr": $pr,
  "files": $files,
  "symbols": $symbols,
  "error_strings": $error_strings,
  "primary_issue": $primary_issue
}
JSON
