#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Check whether all CodeRabbit (or configured automated reviewer) review
# threads on a PR are resolved. Uses GraphQL on pullRequest.reviewThreads
# because GitHub's REST /comments endpoint does not expose thread state.
#
# Usage: check-coderabbit-threads.sh <pr-number> [--repo OWNER/REPO] [--bot LOGIN]
# Default bot login: coderabbitai. Override with --bot for other reviewers.

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <pr-number> [--repo OWNER/REPO] [--bot LOGIN]" >&2
  exit 64
fi

pr="$1"
shift || true
owner=""
name=""
bot_login="coderabbitai"

while [ $# -gt 0 ]; do
  case "$1" in
    --repo)
      IFS='/' read -r owner name <<<"$2"
      shift 2
      ;;
    --bot)
      bot_login="$2"
      shift 2
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 64
      ;;
  esac
done

# Resolve owner/name if not provided.
if [ -z "$owner" ] || [ -z "$name" ]; then
  remote_url=$(git config --get remote.origin.url 2>/dev/null || echo "")
  if [[ "$remote_url" =~ github\.com[:/]([^/]+)/([^/.]+) ]]; then
    owner="${BASH_REMATCH[1]}"
    name="${BASH_REMATCH[2]}"
  else
    echo "Cannot determine owner/repo. Pass --repo OWNER/REPO." >&2
    exit 64
  fi
fi

# Query review threads with their resolution state and the first comment's
# author. We only count threads whose first comment is from the configured bot.
# shellcheck disable=SC2016  # GraphQL body uses literal $vars; gh substitutes via -F
query='
query($owner: String!, $name: String!, $pr: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          comments(first: 1) {
            nodes {
              author { login }
            }
          }
        }
      }
    }
  }
}'

result=$(gh api graphql \
  -F owner="$owner" -F name="$name" -F pr="$pr" \
  -f query="$query" 2>/dev/null) || {
  printf '{"pr":%s,"error":"graphql_failed"}\n' "$pr"
  exit 0
}

# Filter threads where first comment author == bot_login.
# Output: total_bot_threads, unresolved_bot_threads, list of unresolved IDs.
counts=$(printf '%s' "$result" | jq --arg bot "$bot_login" '
  .data.repository.pullRequest.reviewThreads.nodes
  | map(select(.comments.nodes[0].author.login == $bot))
  | {
      total_bot_threads: length,
      unresolved_bot_threads: map(select(.isResolved == false)) | length,
      unresolved_ids: map(select(.isResolved == false) | .id)
    }
')

unresolved=$(printf '%s' "$counts" | jq -r .unresolved_bot_threads)
gate_pass=$([ "$unresolved" = "0" ] && echo true || echo false)

cat <<JSON
{
  "pr": $pr,
  "bot_login": "$bot_login",
  "gate_coderabbit_threads_resolved": $gate_pass,
  "details": $counts
}
JSON
