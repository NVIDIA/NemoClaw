#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Cron preflight inference.local E2E.
#
# Onboards a fresh sandbox against the managed cloud provider (whose base URL
# resolves through `inference.local`), schedules an isolated agentTurn cron
# job, force-triggers it via `openclaw cron run --wait`, and asserts the
# provider preflight does not skip the run with `EAI_AGAIN` or the
# "local provider endpoint is not reachable" message.
#
# Prerequisites:
#   - Docker running
#   - NVIDIA_API_KEY set (real key, starts with nvapi-)
#   - NEMOCLAW_NON_INTERACTIVE=1, NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1
#
# Environment:
#   NEMOCLAW_SANDBOX_NAME                  — sandbox name (default: e2e-cron-preflight)
#   NEMOCLAW_RECREATE_SANDBOX=1            — destroy + recreate if exists
#   NEMOCLAW_CRON_PREFLIGHT_MODEL          — cloud model (default: nvidia/nemotron-3-super-120b-a12b)
#   NEMOCLAW_CRON_PREFLIGHT_WAIT           — --wait-timeout for cron run (default: 90s)
#   NEMOCLAW_CRON_PREFLIGHT_KEEP=1         — keep the sandbox after the test for inspection
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
#     NVIDIA_API_KEY=nvapi-... bash test/e2e/test-cron-preflight-inference-local-e2e.sh

set -uo pipefail

PASS=0
FAIL=0
SKIP=0
TOTAL=0

pass() {
  PASS=$((PASS + 1))
  TOTAL=$((TOTAL + 1))
  printf '\033[32m  PASS: %s\033[0m\n' "$1"
}
fail() {
  FAIL=$((FAIL + 1))
  TOTAL=$((TOTAL + 1))
  printf '\033[31m  FAIL: %s\033[0m\n' "$1"
}
skip() {
  SKIP=$((SKIP + 1))
  TOTAL=$((TOTAL + 1))
  printf '\033[33m  SKIP: %s\033[0m\n' "$1"
}
section() {
  echo ""
  printf '\033[1;36m=== %s ===\033[0m\n' "$1"
}
info() { printf '\033[1;34m  [info]\033[0m %s\n' "$1"; }

# ── Repo root ──
_script_dir="$(cd "$(dirname "$0")" && pwd)"
_candidate="$(cd "${_script_dir}/../.." && pwd)"
if [ -d /workspace ] && [ -f /workspace/package.json ] && [ -d /workspace/test/e2e ]; then
  REPO="/workspace"
elif [ -f "${_candidate}/package.json" ] && [ -d "${_candidate}/test/e2e" ]; then
  REPO="${_candidate}"
else
  echo "ERROR: Cannot find repo root."
  exit 1
fi
cd "$REPO" || {
  echo "ERROR: Cannot cd into repo root '$REPO'."
  exit 1
}

SANDBOX="${NEMOCLAW_SANDBOX_NAME:-e2e-cron-preflight}"
MODEL="${NEMOCLAW_CRON_PREFLIGHT_MODEL:-nvidia/nemotron-3-super-120b-a12b}"
WAIT_TIMEOUT="${NEMOCLAW_CRON_PREFLIGHT_WAIT:-90s}"

# ── Prereqs ──
section "Prerequisites"
if ! command -v docker >/dev/null 2>&1; then
  skip "docker not installed"
  echo "  Total: $TOTAL  Pass: $PASS  Fail: $FAIL  Skip: $SKIP"
  exit 0
fi
if ! command -v jq >/dev/null 2>&1; then
  skip "jq not installed"
  echo "  Total: $TOTAL  Pass: $PASS  Fail: $FAIL  Skip: $SKIP"
  exit 0
fi
if [ -z "${NVIDIA_API_KEY:-}" ]; then
  skip "NVIDIA_API_KEY not set"
  echo "  Total: $TOTAL  Pass: $PASS  Fail: $FAIL  Skip: $SKIP"
  exit 0
fi
if [ "${NVIDIA_API_KEY:0:6}" != "nvapi-" ]; then
  skip "NVIDIA_API_KEY does not start with nvapi-"
  echo "  Total: $TOTAL  Pass: $PASS  Fail: $FAIL  Skip: $SKIP"
  exit 0
fi
if [ "${NEMOCLAW_NON_INTERACTIVE:-}" != "1" ]; then
  skip "NEMOCLAW_NON_INTERACTIVE must be 1; refusing to risk an interactive onboard prompt"
  echo "  Total: $TOTAL  Pass: $PASS  Fail: $FAIL  Skip: $SKIP"
  exit 0
fi
if [ "${NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE:-}" != "1" ]; then
  skip "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE must be 1; refusing to risk an interactive onboard prompt"
  echo "  Total: $TOTAL  Pass: $PASS  Fail: $FAIL  Skip: $SKIP"
  exit 0
fi
pass "prerequisites satisfied"

CREATED_SANDBOX=0

# shellcheck disable=SC2317,SC2329 # invoked via trap
cleanup() {
  if [ "${NEMOCLAW_CRON_PREFLIGHT_KEEP:-0}" = "1" ]; then
    info "NEMOCLAW_CRON_PREFLIGHT_KEEP=1 set; leaving sandbox $SANDBOX in place"
    return
  fi
  if [ "$CREATED_SANDBOX" != "1" ]; then
    info "sandbox $SANDBOX was pre-existing and not recreated; leaving it alone"
    return
  fi
  info "destroying sandbox $SANDBOX"
  nemoclaw "$SANDBOX" destroy --yes >/dev/null 2>&1 || true
}
trap cleanup EXIT

# ── Onboard ──
section "Onboard sandbox '$SANDBOX'"
if [ "${NEMOCLAW_RECREATE_SANDBOX:-0}" = "1" ]; then
  info "NEMOCLAW_RECREATE_SANDBOX=1 set; destroying existing sandbox first"
  nemoclaw "$SANDBOX" destroy --yes >/dev/null 2>&1 || true
  CREATED_SANDBOX=1
fi

NEMOCLAW_SANDBOX_NAME="$SANDBOX" \
  NEMOCLAW_PROVIDER=build \
  NEMOCLAW_MODEL="$MODEL" \
  nemoclaw onboard \
  --non-interactive \
  --yes-i-accept-third-party-software 2>&1 | sed 's/^/    /'
ONBOARD_RC=${PIPESTATUS[0]}
if [ "$ONBOARD_RC" -ne 0 ]; then
  fail "onboard exited $ONBOARD_RC"
  echo "  Total: $TOTAL  Pass: $PASS  Fail: $FAIL  Skip: $SKIP"
  exit 1
fi
CREATED_SANDBOX=1
pass "onboard completed"

# ── Schedule cron job ──
section "Schedule isolated agentTurn cron job"
JOB_NAME="preflight-$(date +%s)"
ADD_OUT="$(nemoclaw "$SANDBOX" exec -- openclaw cron add \
  --name "$JOB_NAME" \
  --agent main \
  --session isolated \
  --every 12h \
  --message "Reply with the single word: ok." \
  --keep-after-run \
  --json 2>&1)"
ADD_RC=$?
if [ "$ADD_RC" -ne 0 ]; then
  fail "cron add exited $ADD_RC"
  printf '%s\n' "$ADD_OUT" | sed 's/^/    /'
  echo "  Total: $TOTAL  Pass: $PASS  Fail: $FAIL  Skip: $SKIP"
  exit 1
fi

JOB_ID="$(printf '%s' "$ADD_OUT" | jq -r '.id // empty' 2>/dev/null || true)"
if [ -z "$JOB_ID" ]; then
  fail "cron add returned no id"
  printf '%s\n' "$ADD_OUT" | sed 's/^/    /'
  echo "  Total: $TOTAL  Pass: $PASS  Fail: $FAIL  Skip: $SKIP"
  exit 1
fi
pass "scheduled job $JOB_NAME ($JOB_ID)"

# ── Force-trigger + wait ──
section "Force-trigger and wait"
RUN_OUT="$(nemoclaw "$SANDBOX" exec -- openclaw cron run "$JOB_ID" \
  --wait --wait-timeout "$WAIT_TIMEOUT" --json 2>&1)"
RUN_RC=$?
info "raw cron run output (rc=$RUN_RC):"
printf '%s\n' "$RUN_OUT" | sed 's/^/    /'

STATUS="$(printf '%s' "$RUN_OUT" | jq -r '.run.status // .status // empty' 2>/dev/null || true)"
REASON="$(printf '%s' "$RUN_OUT" | jq -r '.run.reason // .reason // ""' 2>/dev/null || true)"

# ── Assertions ──
section "Assertions"
if printf '%s' "$REASON" | grep -qi "EAI_AGAIN"; then
  fail "preflight raised EAI_AGAIN; reason='$REASON'"
elif printf '%s' "$REASON" | grep -qi "local provider endpoint is not reachable"; then
  fail "preflight reported endpoint unreachable; reason='$REASON'"
elif [ "$STATUS" = "skipped" ]; then
  fail "cron run reported status=skipped; reason='$REASON'"
elif [ "$STATUS" = "ok" ]; then
  pass "cron run status=ok"
else
  fail "unexpected cron run status='$STATUS' rc=$RUN_RC reason='$REASON'"
fi

section "Summary"
echo "  Total: $TOTAL  Pass: $PASS  Fail: $FAIL  Skip: $SKIP"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
