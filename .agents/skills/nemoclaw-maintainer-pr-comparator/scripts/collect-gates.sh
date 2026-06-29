#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Collect Tier 0 gate state for a PR and emit JSON for downstream scoring.
# Covers gates 1-5 (state, CI on latest SHA, mergeable, contributor compliance,
# branch protection). Gate 6 (CodeRabbit threads) is handled by
# check-coderabbit-threads.sh.
#
# Usage: collect-gates.sh <pr-number> [--repo OWNER/REPO]

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <pr-number> [--repo OWNER/REPO]" >&2
  exit 64
fi

pr="$1"
shift || true
repo_args=()
repo_name=""
if [ "${1:-}" = "--repo" ] && [ -n "${2:-}" ]; then
  repo_args=(--repo "$2")
  repo_name="$2"
else
  repo_name=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null) || {
    printf '{"pr":%s,"error":"repo_resolution_failed"}\n' "$pr"
    exit 0
  }
fi

raw=$(gh pr view "$pr" "${repo_args[@]}" \
  --json number,state,body,headRefOid,statusCheckRollup,mergeable,mergeStateStatus,reviewDecision \
  2>/dev/null) || {
  printf '{"pr":%s,"error":"fetch_failed"}\n' "$pr"
  exit 0
}

# Gate 1: state OPEN
state=$(printf '%s' "$raw" | jq -r .state)
gate_state_open=$([ "$state" = "OPEN" ] && echo true || echo false)

# Gate 2: CI green on latest head SHA. statusCheckRollup contains the latest run.
# Count failures and pendings; gate passes only when all are SUCCESS or SKIPPED.
ci_failure_count=$(printf '%s' "$raw" | jq '[(.statusCheckRollup // [])[] | select((.conclusion // .state) == "FAILURE" or (.conclusion // .state) == "CANCELLED" or (.conclusion // .state) == "TIMED_OUT")] | length')
ci_pending_count=$(printf '%s' "$raw" | jq '[(.statusCheckRollup // [])[] | select(.status == "IN_PROGRESS" or .status == "QUEUED" or .status == "PENDING")] | length')
gate_ci_green=$([ "$ci_failure_count" = "0" ] && [ "$ci_pending_count" = "0" ] && echo true || echo false)

# Gate 3: mergeable
mergeable=$(printf '%s' "$raw" | jq -r .mergeable)
merge_state=$(printf '%s' "$raw" | jq -r .mergeStateStatus)
gate_mergeable=$([ "$mergeable" = "MERGEABLE" ] && [ "$merge_state" = "CLEAN" ] && echo true || echo false)

# Gate 4: contributor compliance (PR-body DCO + every commit GitHub Verified)
if printf '%s' "$raw" | jq -r '.body // ""' | grep -Eq '^Signed-off-by:[[:space:]]+.+[[:space:]]+<[^<>[:space:]]+@[^<>[:space:]]+>[[:space:]]*$'; then
  dco_declaration_present=true
else
  dco_declaration_present=false
fi

commits_fetch_failed=false
commits_raw=$(gh api "repos/$repo_name/pulls/$pr/commits" --paginate \
  --jq '.[] | {sha, verified: (.commit.verification.verified // false), reason: (.commit.verification.reason // "unknown")}' \
  2>/dev/null) || commits_fetch_failed=true

if [ "$commits_fetch_failed" = "true" ] || [ -z "$commits_raw" ]; then
  commit_count=0
  unverified_commits='[]'
  gate_contributor_compliance=false
else
  commit_count=$(printf '%s\n' "$commits_raw" | jq -s 'length')
  unverified_commits=$(printf '%s\n' "$commits_raw" | jq -s '[.[] | select(.verified != true) | {sha, reason}]')
  unverified_count=$(printf '%s' "$unverified_commits" | jq 'length')
  gate_contributor_compliance=$(
    [ "$dco_declaration_present" = "true" ] && [ "$unverified_count" = "0" ] && echo true || echo false
  )
fi

# Gate 5: branch protection (proxy via reviewDecision = APPROVED)
review_decision=$(printf '%s' "$raw" | jq -r .reviewDecision)
gate_branch_protection=$([ "$review_decision" = "APPROVED" ] && echo true || echo false)

head_sha=$(printf '%s' "$raw" | jq -r .headRefOid)

# Classify failures as trivial vs substantive (used by degraded mode).
# Substantive: CI red/cancelled, merge conflict, missing approvals.
# Trivial: stale base only (everything else here is substantive).
classify_failures=()
[ "$gate_state_open" = "false" ] && classify_failures+=("substantive:not_open")
[ "$gate_ci_green" = "false" ] && classify_failures+=("substantive:ci_failures=$ci_failure_count,pending=$ci_pending_count")
[ "$gate_mergeable" = "false" ] && classify_failures+=("substantive:mergeable=$mergeable,state=$merge_state")
[ "$gate_contributor_compliance" = "false" ] && classify_failures+=("substantive:contributor_compliance")
[ "$gate_branch_protection" = "false" ] && classify_failures+=("substantive:review=$review_decision")

failures_json=$(printf '%s\n' "${classify_failures[@]:-}" | jq -Rs 'split("\n") | map(select(length > 0))')

cat <<JSON
{
  "pr": $pr,
  "head_sha": "$head_sha",
  "gates": {
    "state_open": $gate_state_open,
    "ci_green_latest_sha": $gate_ci_green,
    "mergeable": $gate_mergeable,
    "contributor_compliance": $gate_contributor_compliance,
    "branch_protection": $gate_branch_protection
  },
  "details": {
    "state": "$state",
    "ci_failure_count": $ci_failure_count,
    "ci_pending_count": $ci_pending_count,
    "mergeable": "$mergeable",
    "merge_state_status": "$merge_state",
    "dco_declaration_present": $dco_declaration_present,
    "commit_count": $commit_count,
    "unverified_commits": $unverified_commits,
    "review_decision": "$review_decision"
  },
  "failures": $failures_json
}
JSON
