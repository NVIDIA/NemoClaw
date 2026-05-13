#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Polls openclaw/openclaw#81056 (the prompt-bloat regression report we filed
# upstream from NemoClaw#2598) and reports whether the upstream fix has
# landed. When it has, the operator should:
#   1. Look up the openclaw release that contains the fix
#   2. Bump `min_openclaw_version` in `nemoclaw-blueprint/blueprint.yaml`
#      past that version
#   3. Verify a fresh sandbox at the bumped version meets the <5s AC on a
#      trivial agent turn
#   4. Close NemoClaw#2598 (and the linked #2600, #3261 if still relevant)
#
# Distinguishes a real upstream fix (closed by a human or merge bot with a
# linked PR) from a `clawsweeper[bot]` stale-close, since the latter is just
# inbox hygiene and means nothing was fixed.
#
# Usage:
#   scripts/check-openclaw-upstream-fix.sh           # print status
#   scripts/check-openclaw-upstream-fix.sh --check   # exit 0 if no action
#                                                    # needed, exit 1 if a
#                                                    # real fix appears to
#                                                    # have landed

set -euo pipefail

UPSTREAM_REPO="openclaw/openclaw"
UPSTREAM_ISSUE="81056"
TRACKED_BY_PIN="nemoclaw-blueprint/blueprint.yaml"
NEMOCLAW_ISSUES="NemoClaw#2598 NemoClaw#2600 NemoClaw#3261"
# Stale-bot accounts whose closing event does NOT indicate a real fix.
STALE_CLOSERS=("clawsweeper[bot]" "stale[bot]" "github-actions[bot]")

MODE="status"
case "${1:-}" in
  "") MODE="status" ;;
  --check) MODE="check" ;;
  -h | --help)
    sed -n '3,21p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *)
    echo "Usage: $0 [--check]" >&2
    exit 2
    ;;
esac

if ! command -v gh >/dev/null 2>&1; then
  echo "error: 'gh' (GitHub CLI) is required. install: https://cli.github.com/" >&2
  exit 2
fi

if ! issue_state=$(gh api "repos/${UPSTREAM_REPO}/issues/${UPSTREAM_ISSUE}" --jq '.state' 2>/dev/null); then
  echo "error: failed to query ${UPSTREAM_REPO}#${UPSTREAM_ISSUE} (network or auth?)" >&2
  exit 2
fi

closed_by=$(gh api "repos/${UPSTREAM_REPO}/issues/${UPSTREAM_ISSUE}" --jq '.closed_by.login // ""' 2>/dev/null || echo "")

# A real fix lands via a linked PR or commit; stale-bot closes have neither.
closure_has_pr="no"
if [ "$issue_state" = "closed" ]; then
  commit_count=$(gh api "repos/${UPSTREAM_REPO}/issues/${UPSTREAM_ISSUE}/events" --paginate \
    --jq '[.[] | select(.commit_id != null)] | length' 2>/dev/null || echo "0")
  if [ "${commit_count:-0}" -gt 0 ]; then
    closure_has_pr="yes"
  fi
fi

is_stale_close="no"
for stale in "${STALE_CLOSERS[@]}"; do
  if [ "$closed_by" = "$stale" ]; then
    is_stale_close="yes"
    break
  fi
done

case "$issue_state" in
  open)
    if [ "$MODE" = "check" ]; then exit 0; fi
    cat <<EOF
${UPSTREAM_REPO}#${UPSTREAM_ISSUE} is OPEN.

No action needed. ${NEMOCLAW_ISSUES} stay blocked on the upstream fix.

Track: https://github.com/${UPSTREAM_REPO}/issues/${UPSTREAM_ISSUE}
EOF
    exit 0
    ;;
  closed)
    if [ "$is_stale_close" = "yes" ] && [ "$closure_has_pr" = "no" ]; then
      if [ "$MODE" = "check" ]; then exit 0; fi
      cat <<EOF
${UPSTREAM_REPO}#${UPSTREAM_ISSUE} is closed by ${closed_by} with no linked
PR or commit — looks like a stale-bot close, NOT a real fix.

No action needed. ${NEMOCLAW_ISSUES} are still blocked on a real upstream fix.

If you think this is a mistake, reopen at:
  https://github.com/${UPSTREAM_REPO}/issues/${UPSTREAM_ISSUE}
EOF
      exit 0
    fi

    cat <<EOF
${UPSTREAM_REPO}#${UPSTREAM_ISSUE} appears CLOSED with real work
  closed_by=${closed_by:-unknown}, linked-pr/commit=${closure_has_pr}

The prompt-bloat fix likely landed upstream. Next steps:

  1. Read the upstream issue to find the openclaw release tag that
     includes the fix:
       https://github.com/${UPSTREAM_REPO}/issues/${UPSTREAM_ISSUE}

  2. Bump min_openclaw_version in ${TRACKED_BY_PIN} past that version.

  3. Verify the AC on a fresh sandbox (trivial turn <5s).

  4. Close ${NEMOCLAW_ISSUES} once verified.
EOF
    if [ "$MODE" = "check" ]; then exit 1; fi
    exit 0
    ;;
  *)
    echo "error: unexpected issue state '$issue_state' for ${UPSTREAM_REPO}#${UPSTREAM_ISSUE}" >&2
    exit 2
    ;;
esac
