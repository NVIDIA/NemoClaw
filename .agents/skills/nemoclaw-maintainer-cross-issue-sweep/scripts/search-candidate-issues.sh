#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Search GitHub issues using the fingerprint produced by extract-fingerprint.sh.
# Three search dimensions (symbol / file path / error string), capped at 30
# total candidates after dedupe and primary-issue exclusion.
#
# Usage:
#   scripts/extract-fingerprint.sh <pr> | scripts/search-candidate-issues.sh
#   scripts/search-candidate-issues.sh < fingerprint.json
#
# Output: JSON list of candidate issues to stdout

set -euo pipefail

# Caps (mirror repo-policy.md). Keep in sync.
PER_SYMBOL_TOP=10
PER_FILE_TOP=5
PER_ERROR_TOP=5
MAX_TOTAL=30

repo=""
if [ "${1:-}" = "--repo" ]; then
  if [ -z "${2:-}" ]; then
    echo "Usage: $0 [--repo OWNER/REPO] < fingerprint.json" >&2
    exit 64
  fi
  repo="$2"
  shift 2
fi

fingerprint=$(cat)

if [ -z "$repo" ]; then
  repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || echo "")
fi
if [ -z "$repo" ]; then
  echo "Cannot determine repo. Run inside a repo or pass --repo OWNER/REPO." >&2
  exit 64
fi

primary_issue=$(printf '%s' "$fingerprint" | jq -r '.primary_issue // "null"')

# Collect candidate issue numbers across the three search dimensions.
candidates_file=$(mktemp)
trap 'rm -f "$candidates_file"' EXIT

search_term() {
  # $1 query, $2 limit
  gh search issues --repo "$repo" --state open "$1" --limit "$2" \
    --json number,updatedAt --jq '.[] | "\(.updatedAt) \(.number)"' 2>/dev/null \
    | sort -r \
    | awk '{print $2}'
}

# Per-symbol search. `// []` keeps small/doc-only PRs (missing dimensions) from
# crashing jq; `|| true` keeps an empty `read` loop from tripping pipefail.
printf '%s' "$fingerprint" | jq -r '.symbols // [] | .[]' | while read -r sym; do
  [ -z "$sym" ] && continue
  search_term "\"$sym\" in:body,comments,title" "$PER_SYMBOL_TOP" >>"$candidates_file" || true
done

# Per-file-path search.
printf '%s' "$fingerprint" | jq -r '.files // [] | .[]' | while read -r path; do
  [ -z "$path" ] && continue
  search_term "\"$path\" in:body,comments" "$PER_FILE_TOP" >>"$candidates_file" || true
done

# Per-error-string search. Quote the whole string for exact match.
printf '%s' "$fingerprint" | jq -r '.error_strings // [] | .[]' | while read -r str; do
  [ -z "$str" ] && continue
  search_term "\"$str\" in:body,comments" "$PER_ERROR_TOP" >>"$candidates_file" || true
done

# Dedupe, exclude primary issue, cap total. `grep -v` exits 1 if every line
# matches (i.e., every candidate IS the primary issue) — that's a valid empty
# result, not an error.
candidates=$(sort -u "$candidates_file" \
  | { grep -v "^${primary_issue}$" || true; } \
  | head -n "$MAX_TOTAL")

# Emit JSON: [{number, title, body_excerpt}, ...]. Keep body short for the LLM.
if [ -z "$candidates" ]; then
  echo '{"candidates": []}'
  exit 0
fi

printf '{"candidates": ['
first=1
for n in $candidates; do
  data=$(gh issue view "$n" --repo "$repo" --json number,title,body,updatedAt 2>/dev/null) || continue
  body_excerpt=$(printf '%s' "$data" | jq -r '.body // ""' | head -c 2000 | jq -Rs .)
  title=$(printf '%s' "$data" | jq '.title')
  updated=$(printf '%s' "$data" | jq '.updatedAt')

  [ $first -eq 0 ] && printf ','
  first=0
  printf '{"number":%s,"title":%s,"body_excerpt":%s,"updated_at":%s}' \
    "$n" "$title" "$body_excerpt" "$updated"
done
printf ']}\n'
