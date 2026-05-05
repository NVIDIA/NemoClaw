#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Parse PR bodies for supersession references and emit edges:
#   <superseder_pr> -> <superseded_pr>
#
# Patterns matched (case-insensitive): "supersedes #N", "replaces #N",
# "closes in favor of #N", "closed in favor of #N", "folds in #N".
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
for pr in "${prs[@]}"; do
  body=$(gh pr view "$pr" "${repo_args[@]}" --json body --jq .body 2>/dev/null || echo "")
  [ -z "$body" ] && continue

  # Extract referenced PR numbers from supersession patterns.
  while IFS= read -r ref; do
    # Only emit edges where the target is also a candidate.
    if printf '%s\n' "$candidates_set" | grep -q "^${ref}$"; then
      edges+=("$pr -> $ref")
    fi
  done < <(printf '%s' "$body" | grep -oiE '(supersed[a-z]*|replac[a-z]*|clos[a-z]* in favor of|fold[a-z]* in)[^#]*#([0-9]+)' \
    | grep -oE '#[0-9]+' \
    | tr -d '#' \
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
