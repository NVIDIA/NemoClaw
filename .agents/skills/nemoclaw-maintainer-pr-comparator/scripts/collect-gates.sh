#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Collect Tier 0 gate state for a PR and emit JSON for downstream scoring.
# Covers gates 1-4 (state, CI on latest SHA, mergeable, branch protection).
# Gate 5 (CodeRabbit threads) is handled by check-coderabbit-threads.sh.
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
if [ "${1:-}" = "--repo" ] && [ -n "${2:-}" ]; then
  repo_args=(--repo "$2")
fi

raw=$(gh pr view "$pr" "${repo_args[@]}" \
  --json number,state,headRefOid,statusCheckRollup,mergeable,mergeStateStatus,reviewDecision \
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

# Gate 4: branch protection (proxy via reviewDecision = APPROVED)
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
[ "$gate_branch_protection" = "false" ] && classify_failures+=("substantive:review=$review_decision")

failures_json=$(printf '%s\n' "${classify_failures[@]:-}" | grep -v '^$' | jq -Rs 'split("\n") | map(select(length > 0))' 2>/dev/null || echo '[]')

cat <<JSON
{
  "pr": $pr,
  "head_sha": "$head_sha",
  "gates": {
    "state_open": $gate_state_open,
    "ci_green_latest_sha": $gate_ci_green,
    "mergeable": $gate_mergeable,
    "branch_protection": $gate_branch_protection
  },
  "details": {
    "state": "$state",
    "ci_failure_count": $ci_failure_count,
    "ci_pending_count": $ci_pending_count,
    "mergeable": "$mergeable",
    "merge_state_status": "$merge_state",
    "review_decision": "$review_decision"
  },
  "failures": $failures_json
}
JSON
