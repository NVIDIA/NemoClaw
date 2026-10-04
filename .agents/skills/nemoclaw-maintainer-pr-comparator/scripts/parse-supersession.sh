#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Parse PR bodies for supersession references and emit edges:
#   <superseder_pr> -> <superseded_pr>
#
# Patterns matched case-insensitively. Active forms such as "supersedes #N",
# "replaces #N", and "folds in #N" point from the current PR to #N. Passive
# forms such as "superseded by #N", "replaced by #N", "closed in favor of
# #N", and "folded into #N" point from #N to the current PR.
#
# Usage: parse-supersession.sh <pr-1> <pr-2> [...] [--repo OWNER/REPO]

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <pr-1> <pr-2> [...] [--repo OWNER/REPO]" >&2
  exit 64
fi

prs=()
repo_args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --repo)
      repo_args=(--repo "$2")
      shift 2
      ;;
    *)
      prs+=("$1")
      shift
      ;;
  esac
done

# Build a set of candidate PR numbers so we only emit edges within this comparison.
candidates_set=$(printf '%s\n' "${prs[@]}" | sort -u)

edges=()
append_edge() {
  local candidate="$1"
  local existing

  for existing in "${edges[@]}"; do
    [ "$existing" = "$candidate" ] && return
  done
  edges+=("$candidate")
}

reverse_pattern='(supersed[a-z]*[[:space:]]+by|replac[a-z]*[[:space:]]+by|clos[a-z]*[[:space:]]+in[[:space:]]+favor[[:space:]]+of|fold[a-z]*[[:space:]]+into)'
for pr in "${prs[@]}"; do
  body=$(gh pr view "$pr" "${repo_args[@]}" --json body --jq .body 2>/dev/null || echo "")
  [ -z "$body" ] && continue

  # Extract supersession statements and orient passive forms toward this PR.
  while IFS= read -r statement; do
    ref="${statement##*#}"
    # Only emit edges where the target is also a candidate.
    if printf '%s\n' "$candidates_set" | grep -q "^${ref}$"; then
      normalized=$(printf '%s' "$statement" | tr '[:upper:]' '[:lower:]')
      if [[ $normalized =~ $reverse_pattern ]]; then
        append_edge "$ref -> $pr"
      else
        append_edge "$pr -> $ref"
      fi
    fi
  done < <(printf '%s' "$body" | grep -oiE '(supersed[a-z]*|replac[a-z]*|clos[a-z]* in favor of|fold[a-z]* in)[^#]*#([0-9]+)' \
    | sort -u)
done

if [ ${#edges[@]} -eq 0 ]; then
  echo '{"edges": []}'
else
  printf '{"edges": ['
  first=1
  for edge in "${edges[@]}"; do
    [ $first -eq 0 ] && printf ','
    first=0
    superseder="${edge%% -> *}"
    superseded="${edge##* -> }"
    printf '{"superseder":%s,"superseded":%s}' "$superseder" "$superseded"
  done
  printf ']}\n'
fi
