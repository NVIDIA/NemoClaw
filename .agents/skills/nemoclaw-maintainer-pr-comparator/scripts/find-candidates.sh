#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Discover candidate PRs for an issue using a single default search order
# with stop conditions. Outputs PR numbers, one per line, deduplicated.
#
# Usage: find-candidates.sh <issue-number> [--repo OWNER/REPO]
#
# Algorithm:
#   1. PRs explicitly linking the issue (closes/fixes/refs #N)
#   2. If <2 candidates AND issue body has file paths, expand to PRs touching those files
#   3. If still <2 candidates, expand to PRs with title-token Jaccard >= 0.4
#   4. Stop expanding once at least 2 candidates are found

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <issue-number> [--repo OWNER/REPO]" >&2
  exit 64
fi

issue_number="$1"
shift || true
repo_args=()
if [ "${1:-}" = "--repo" ] && [ -n "${2:-}" ]; then
  repo_args=(--repo "$2")
fi

# Threshold from repo-policy.md, default 0.4. The skill currently does not
# parse YAML; the threshold is duplicated here for transparency. Keep these in sync.
JACCARD_THRESHOLD="0.4"
MAX_CANDIDATES=10

# Step 1: PRs that explicitly link the issue.
# `in:body` is a search qualifier (part of the query string), not a CLI flag.
candidates=$(gh search prs "${repo_args[@]}" --state open \
  "\"#${issue_number}\" in:body" --json number \
  --jq ".[].number" 2>/dev/null | sort -u | head -n "$MAX_CANDIDATES")

count=$(printf '%s\n' "$candidates" | grep -c '^[0-9]' || true)

# Step 2: Expand by files mentioned in issue body.
if [ "$count" -lt 2 ]; then
  issue_body=$(gh issue view "$issue_number" "${repo_args[@]}" --json body --jq .body 2>/dev/null || echo "")
  # Pull file paths shaped like src/foo.ts or path/with/slashes.ext
  file_paths=$(printf '%s\n' "$issue_body" | grep -oE '[a-zA-Z0-9_./-]+\.[a-zA-Z]{1,5}' | sort -u | head -n 5)
  for f in $file_paths; do
    more=$(gh pr list "${repo_args[@]}" --state open \
      --search "$f in:files" --json number --jq ".[].number" 2>/dev/null | sort -u || true)
    candidates=$(printf '%s\n%s\n' "$candidates" "$more" | sort -u)
  done
  count=$(printf '%s\n' "$candidates" | grep -c '^[0-9]' || true)
fi

# Step 3: Expand by title-token Jaccard.
if [ "$count" -lt 2 ]; then
  issue_title=$(gh issue view "$issue_number" "${repo_args[@]}" --json title --jq .title 2>/dev/null || echo "")
  # Extract significant tokens (lowercase, drop short words)
  issue_tokens=$(printf '%s\n' "$issue_title" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '\n' | awk 'length($0) > 3' | sort -u)
  if [ -n "$issue_tokens" ]; then
    # Limit to recent 100 open PRs to bound the search
    candidate_titles=$(gh pr list "${repo_args[@]}" --state open --limit 100 \
      --json number,title --jq '.[] | "\(.number) \(.title)"' 2>/dev/null || true)
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      pr_num=$(printf '%s' "$line" | awk '{print $1}')
      pr_title=$(printf '%s' "$line" | cut -d' ' -f2-)
      pr_tokens=$(printf '%s\n' "$pr_title" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '\n' | awk 'length($0) > 3' | sort -u)
      [ -z "$pr_tokens" ] && continue

      intersection=$(comm -12 <(printf '%s\n' "$issue_tokens") <(printf '%s\n' "$pr_tokens") | wc -l)
      union=$(printf '%s\n%s\n' "$issue_tokens" "$pr_tokens" | sort -u | wc -l)
      [ "$union" -eq 0 ] && continue

      jaccard=$(awk -v i="$intersection" -v u="$union" 'BEGIN{printf "%.3f", i/u}')
      keep=$(awk -v j="$jaccard" -v t="$JACCARD_THRESHOLD" 'BEGIN{print (j+0 >= t+0) ? 1 : 0}')
      if [ "$keep" = "1" ]; then
        candidates=$(printf '%s\n%s\n' "$candidates" "$pr_num" | sort -u)
      fi
    done <<<"$candidate_titles"
  fi
fi

# Output unique, non-empty PR numbers.
printf '%s\n' "$candidates" | grep '^[0-9]' | sort -u | head -n "$MAX_CANDIDATES"
