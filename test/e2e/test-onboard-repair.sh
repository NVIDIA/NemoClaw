#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# E2E: resume repair and invalidation behavior.
#
# Regression coverage for issue #446.
# Validates that:
#   1. Resume recreates a missing recorded sandbox instead of assuming it still exists.
#   2. Resume rejects a different requested sandbox name on the same host.
#   3. Resume rejects explicit provider/model changes that conflict with recorded state.
#
# Prerequisites:
#   - Docker running
#   - openshell CLI installed
#   - Node.js available
#   - NVIDIA_API_KEY set to a valid nvapi-* key before starting the test
#
# Usage:
#   NVIDIA_API_KEY=nvapi-... bash test/e2e/test-onboard-repair.sh

set -uo pipefail

PASS=0
FAIL=0
SKIP=0
TOTAL=0

pass() {
  ((PASS++))
  ((TOTAL++))
  printf '\033[32m  PASS: %s\033[0m\n' "$1"
}
fail() {
  ((FAIL++))
  ((TOTAL++))
  printf '\033[31m  FAIL: %s\033[0m\n' "$1"
}
skip() {
  ((SKIP++))
  ((TOTAL++))
  printf '\033[33m  SKIP: %s\033[0m\n' "$1"
}
section() {
  echo ""
  printf '\033[1;36m=== %s ===\033[0m\n' "$1"
}
info() { printf '\033[1;34m  [info]\033[0m %s\n' "$1"; }

if [ -d /workspace ] && [ -f /workspace/install.sh ]; then
  REPO="/workspace"
elif [ -f "$(cd "$(dirname "$0")/../.." && pwd)/install.sh" ]; then
  REPO="$(cd "$(dirname "$0")/../.." && pwd)"
else
  echo "ERROR: Cannot find repo root."
  exit 1
fi

run_nemoclaw() {
  node "$REPO/bin/nemoclaw.js" "$@"
}

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-repair}"
OTHER_SANDBOX_NAME="${NEMOCLAW_OTHER_SANDBOX_NAME:-e2e-other}"

# Shim so the teardown helper's trap can call `nemoclaw destroy` even when
# this repo-local test run has no globally-installed `nemoclaw` on PATH (it
# drives the CLI via `node "$REPO/bin/nemoclaw.js"` via run_nemoclaw).
if ! command -v nemoclaw >/dev/null 2>&1; then
  nemoclaw() { node "$REPO/bin/nemoclaw.js" "$@"; }
fi

# shellcheck source=test/e2e/lib/sandbox-teardown.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/sandbox-teardown.sh"
register_sandbox_for_teardown "$SANDBOX_NAME"
register_sandbox_for_teardown "$OTHER_SANDBOX_NAME"

SESSION_FILE="$HOME/.nemoclaw/onboard-session.json"
RESTORE_API_KEY="${NVIDIA_API_KEY:-}"

# ══════════════════════════════════════════════════════════════════
# Phase 0: Pre-cleanup
# ══════════════════════════════════════════════════════════════════
section "Phase 0: Pre-cleanup"
info "Destroying any leftover sandbox/gateway from previous runs..."
run_nemoclaw "$SANDBOX_NAME" destroy 2>/dev/null || true
run_nemoclaw "$OTHER_SANDBOX_NAME" destroy 2>/dev/null || true
openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true
openshell sandbox delete "$OTHER_SANDBOX_NAME" 2>/dev/null || true
openshell forward stop 18789 2>/dev/null || true
openshell gateway destroy -g nemoclaw 2>/dev/null || true
rm -f "$SESSION_FILE"
pass "Pre-cleanup complete"

# ══════════════════════════════════════════════════════════════════
# Phase 1: Prerequisites
# ══════════════════════════════════════════════════════════════════
section "Phase 1: Prerequisites"

if docker info >/dev/null 2>&1; then
  pass "Docker is running"
else
  fail "Docker is not running — cannot continue"
  exit 1
fi

if command -v openshell >/dev/null 2>&1; then
  pass "openshell CLI installed"
else
  fail "openshell CLI not found — cannot continue"
  exit 1
fi

if command -v node >/dev/null 2>&1; then
  pass "Node.js available"
else
  fail "Node.js not found — cannot continue"
  exit 1
fi

if [[ -n "$RESTORE_API_KEY" && "$RESTORE_API_KEY" == nvapi-* ]]; then
  pass "NVIDIA_API_KEY is set (starts with nvapi-)"
else
  fail "NVIDIA_API_KEY not set or invalid — required for resume completion"
  exit 1
fi

node -e '
const { saveCredential } = require(process.argv[1]);
saveCredential("NVIDIA_API_KEY", process.argv[2]);
' "$REPO/dist/lib/credentials.js" "$RESTORE_API_KEY"
pass "Stored NVIDIA_API_KEY in ~/.nemoclaw/credentials.json for resume hydration"

# ══════════════════════════════════════════════════════════════════
# Phase 2: Create interrupted resumable state
# ══════════════════════════════════════════════════════════════════
section "Phase 2: Create interrupted state"
info "Running onboard with an invalid policy mode to create resumable state..."

FIRST_LOG="$(mktemp)"
NEMOCLAW_NON_INTERACTIVE=1 \
  NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
  NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME" \
  NEMOCLAW_RECREATE_SANDBOX=1 \
  NEMOCLAW_POLICY_MODE=invalid \
  node "$REPO/bin/nemoclaw.js" onboard --non-interactive >"$FIRST_LOG" 2>&1
first_exit=$?
first_output="$(cat "$FIRST_LOG")"
rm -f "$FIRST_LOG"

if [ $first_exit -eq 1 ]; then
  pass "First onboard exited 1 (expected interrupted run)"
else
  fail "First onboard exited $first_exit (expected 1)"
  echo "$first_output"
  exit 1
fi

if [ -f "$SESSION_FILE" ]; then
  pass "Onboard session file created"
else
  fail "Onboard session file missing after interrupted run"
fi

if echo "$first_output" | grep -q "Unsupported NEMOCLAW_POLICY_MODE: invalid"; then
  pass "First run failed at policy setup as intended"
else
  fail "First run did not fail at the expected policy step"
fi

if openshell sandbox get "$SANDBOX_NAME" >/dev/null 2>&1; then
  pass "Sandbox '$SANDBOX_NAME' exists after interrupted run"
else
  fail "Sandbox '$SANDBOX_NAME' not found after interrupted run"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 3: Repair missing sandbox on resume
# ══════════════════════════════════════════════════════════════════
section "Phase 3: Repair missing sandbox"
info "Deleting the recorded sandbox under the session, then resuming..."

openshell sandbox delete "$SANDBOX_NAME" >/dev/null 2>&1 || true
openshell forward stop 18789 >/dev/null 2>&1 || true

if openshell sandbox get "$SANDBOX_NAME" >/dev/null 2>&1; then
  fail "Sandbox '$SANDBOX_NAME' still exists after forced deletion"
else
  pass "Sandbox '$SANDBOX_NAME' removed to simulate stale recorded state"
fi

REPAIR_LOG="$(mktemp)"
env -u NVIDIA_API_KEY \
  NEMOCLAW_NON_INTERACTIVE=1 \
  NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
  NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME" \
  NEMOCLAW_POLICY_MODE=skip \
  node "$REPO/bin/nemoclaw.js" onboard --resume --non-interactive >"$REPAIR_LOG" 2>&1
repair_exit=$?
repair_output="$(cat "$REPAIR_LOG")"
rm -f "$REPAIR_LOG"

if [ $repair_exit -eq 0 ]; then
  pass "Resume completed after repairing missing sandbox"
else
  fail "Resume exited $repair_exit during missing-sandbox repair"
  echo "$repair_output"
  exit 1
fi

if echo "$repair_output" | grep -q "\[resume\] Skipping preflight (cached)"; then
  pass "Repair resume skipped preflight"
else
  fail "Repair resume did not skip preflight"
fi

if echo "$repair_output" | grep -q "\[resume\] Skipping gateway (running)"; then
  pass "Repair resume skipped gateway"
else
  fail "Repair resume did not skip gateway"
fi

if echo "$repair_output" | grep -q "\[resume\] Recorded sandbox state is unavailable; recreating it."; then
  pass "Repair resume detected missing sandbox"
else
  fail "Repair resume did not report missing sandbox recreation"
fi

if echo "$repair_output" | grep -q "\[5/7\] Creating sandbox"; then
  pass "Repair resume recreated sandbox"
else
  fail "Repair resume did not rerun sandbox creation"
fi

if run_nemoclaw "$SANDBOX_NAME" status >/dev/null 2>&1; then
  pass "Repaired sandbox '$SANDBOX_NAME' is manageable"
else
  fail "Repaired sandbox '$SANDBOX_NAME' status failed"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 4: Reject conflicting sandbox
# ══════════════════════════════════════════════════════════════════
section "Phase 4: Reject conflicting sandbox"
info "Attempting resume with a different sandbox name..."

SANDBOX_CONFLICT_LOG="$(mktemp)"
env -u NVIDIA_API_KEY \
  NEMOCLAW_NON_INTERACTIVE=1 \
  NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
  NEMOCLAW_SANDBOX_NAME="$OTHER_SANDBOX_NAME" \
  NEMOCLAW_POLICY_MODE=skip \
  node "$REPO/bin/nemoclaw.js" onboard --resume --non-interactive >"$SANDBOX_CONFLICT_LOG" 2>&1
sandbox_conflict_exit=$?
sandbox_conflict_output="$(cat "$SANDBOX_CONFLICT_LOG")"
rm -f "$SANDBOX_CONFLICT_LOG"

if [ $sandbox_conflict_exit -eq 1 ]; then
  pass "Resume rejected conflicting sandbox name"
else
  fail "Resume exited $sandbox_conflict_exit for conflicting sandbox (expected 1)"
fi

if echo "$sandbox_conflict_output" | grep -q "Resumable state belongs to sandbox '${SANDBOX_NAME}', not '${OTHER_SANDBOX_NAME}'."; then
  pass "Conflicting sandbox message is explicit"
else
  fail "Conflicting sandbox message missing or incorrect"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 5: Reject conflicting provider/model
# ══════════════════════════════════════════════════════════════════
section "Phase 5: Reject conflicting provider and model"
info "Attempting resume with conflicting provider/model inputs..."

PROVIDER_CONFLICT_LOG="$(mktemp)"
env -u NVIDIA_API_KEY \
  NEMOCLAW_NON_INTERACTIVE=1 \
  NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
  NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME" \
  NEMOCLAW_PROVIDER=openai \
  NEMOCLAW_MODEL=gpt-5.4 \
  NEMOCLAW_POLICY_MODE=skip \
  node "$REPO/bin/nemoclaw.js" onboard --resume --non-interactive >"$PROVIDER_CONFLICT_LOG" 2>&1
provider_conflict_exit=$?
provider_conflict_output="$(cat "$PROVIDER_CONFLICT_LOG")"
rm -f "$PROVIDER_CONFLICT_LOG"

if [ $provider_conflict_exit -eq 1 ]; then
  pass "Resume rejected conflicting provider/model"
else
  fail "Resume exited $provider_conflict_exit for conflicting provider/model (expected 1)"
fi

if echo "$provider_conflict_output" | grep -Eq "Resumable state recorded provider '.*', not '.*'\."; then
  pass "Conflicting provider message is explicit"
else
  fail "Conflicting provider message missing or incorrect"
fi

if echo "$provider_conflict_output" | grep -Eq "Resumable state recorded model '.*', not 'gpt-5.4'\."; then
  pass "Conflicting model message is explicit"
else
  fail "Conflicting model message missing or incorrect"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 6: Final cleanup
# ══════════════════════════════════════════════════════════════════
section "Phase 6: Final cleanup"

if [[ "${NEMOCLAW_E2E_KEEP_SANDBOX:-}" != "1" ]]; then
  run_nemoclaw "$SANDBOX_NAME" destroy 2>/dev/null || true
  run_nemoclaw "$OTHER_SANDBOX_NAME" destroy 2>/dev/null || true
fi
openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true
openshell sandbox delete "$OTHER_SANDBOX_NAME" 2>/dev/null || true
openshell forward stop 18789 2>/dev/null || true
openshell gateway destroy -g nemoclaw 2>/dev/null || true
rm -f "$SESSION_FILE"

if openshell sandbox get "$SANDBOX_NAME" >/dev/null 2>&1; then
  fail "Sandbox '$SANDBOX_NAME' still exists after cleanup"
else
  pass "Sandbox '$SANDBOX_NAME' cleaned up"
fi

if [ -f "$SESSION_FILE" ]; then
  fail "Onboard session file still exists after cleanup"
else
  pass "Onboard session file cleaned up"
fi

pass "Final cleanup complete"

# ══════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════
echo ""
echo "========================================"
echo "  PASS: $PASS"
echo "  FAIL: $FAIL"
echo "  SKIP: $SKIP"
echo " TOTAL: $TOTAL"
echo "========================================"
echo ""

if [ $FAIL -ne 0 ]; then
  exit 1
fi
