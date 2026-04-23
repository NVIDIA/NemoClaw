#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# E2E: interrupted onboard -> resume -> verify completion.
#
# Regression test for issue #446.
# Validates that:
#   1. A non-interactive onboard run can fail after sandbox creation while leaving resumable state.
#   2. The onboard session file records the interrupted state safely.
#   3. `nemoclaw onboard --resume --non-interactive` skips cached preflight,
#      gateway, and sandbox work, then completes by hydrating the stored credential.
#
# Prerequisites:
#   - Docker running
#   - openshell CLI installed
#   - Node.js available
#   - NVIDIA_API_KEY set to a valid nvapi-* key before starting the test
#
# Usage:
#   NVIDIA_API_KEY=nvapi-... bash test/e2e/test-onboard-resume.sh

set -uo pipefail

TIMEOUT_CMD=""
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_CMD="timeout"
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_CMD="gtimeout"
fi

if [ "${NEMOCLAW_E2E_NO_TIMEOUT:-0}" != "1" ] && [ "${NEMOCLAW_E2E_TIMEOUT_WRAPPED:-0}" != "1" ]; then
  TIMEOUT_SECONDS="${NEMOCLAW_E2E_TIMEOUT_SECONDS:-600}"
  if [ -n "$TIMEOUT_CMD" ]; then
    export NEMOCLAW_E2E_TIMEOUT_WRAPPED=1
    exec "$TIMEOUT_CMD" -s TERM "$TIMEOUT_SECONDS" "$0" "$@"
  else
    echo "ERROR: 'timeout' not found. Install coreutils (macOS: 'brew install coreutils')" >&2
    echo "       or bypass with NEMOCLAW_E2E_NO_TIMEOUT=1" >&2
    exit 127
  fi
fi

# Run with $TIMEOUT_CMD if set; run directly if empty (NEMOCLAW_E2E_NO_TIMEOUT bypass).
# Avoids `$TIMEOUT_CMD 60 ssh …` becoming `60 ssh …` → "60: command not found".
# Usage: run_with_timeout <seconds> <command> [args...]
run_with_timeout() {
  local seconds="$1"
  shift
  if [ "${NEMOCLAW_E2E_NO_TIMEOUT:-0}" != "1" ] && [ -n "$TIMEOUT_CMD" ]; then
    "$TIMEOUT_CMD" "$seconds" "$@"
  else
    "$@"
  fi
}

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

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-resume}"
SESSION_FILE="$HOME/.nemoclaw/onboard-session.json"
REGISTRY="$HOME/.nemoclaw/sandboxes.json"
RESTORE_API_KEY="${NVIDIA_API_KEY:-}"

# ══════════════════════════════════════════════════════════════════
# Phase 0: Pre-cleanup
# ══════════════════════════════════════════════════════════════════
section "Phase 0: Pre-cleanup"
info "Destroying any leftover sandbox/gateway from previous runs..."
run_nemoclaw "$SANDBOX_NAME" destroy 2>/dev/null || true
openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true
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

if curl -sf --max-time 10 https://integrate.api.nvidia.com/v1/models >/dev/null 2>&1; then
  pass "Network access to integrate.api.nvidia.com"
else
  fail "Cannot reach integrate.api.nvidia.com"
  exit 1
fi

node -e '
const { saveCredential } = require(process.argv[1]);
saveCredential("NVIDIA_API_KEY", process.argv[2]);
' "$REPO/dist/lib/credentials.js" "$RESTORE_API_KEY"
pass "Stored NVIDIA_API_KEY in ~/.nemoclaw/credentials.json for resume hydration"

# ══════════════════════════════════════════════════════════════════
# Phase 2: First onboard (forced failure after sandbox creation)
# ══════════════════════════════════════════════════════════════════
section "Phase 2: First onboard (interrupted)"
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

if echo "$first_output" | grep -q "Sandbox '${SANDBOX_NAME}' created"; then
  pass "Sandbox '$SANDBOX_NAME' created before interruption"
else
  fail "Sandbox creation not confirmed in first run output"
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

if [ -f "$SESSION_FILE" ]; then
  pass "Onboard session file created"
else
  fail "Onboard session file missing after interrupted run"
fi

node -e '
const fs = require("fs");
const file = process.argv[1];
const data = JSON.parse(fs.readFileSync(file, "utf8"));
if (data.status !== "failed") process.exit(1);
if (data.lastCompletedStep !== "openclaw") process.exit(2);
if (!data.failure || data.failure.step !== "policies") process.exit(3);
' "$SESSION_FILE"
case $? in
  0) pass "Session file recorded openclaw completion and policy failure" ;;
  *) fail "Session file did not record the expected interrupted state" ;;
esac

# ══════════════════════════════════════════════════════════════════
# Phase 3: Resume and complete
# ══════════════════════════════════════════════════════════════════
section "Phase 3: Resume"
info "Running onboard --resume with NVIDIA_API_KEY removed from env..."

RESUME_LOG="$(mktemp)"
env -u NVIDIA_API_KEY \
  NEMOCLAW_NON_INTERACTIVE=1 \
  NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
  NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME" \
  NEMOCLAW_POLICY_MODE=skip \
  node "$REPO/bin/nemoclaw.js" onboard --resume --non-interactive >"$RESUME_LOG" 2>&1
resume_exit=$?
resume_output="$(cat "$RESUME_LOG")"
rm -f "$RESUME_LOG"

if [ $resume_exit -eq 0 ]; then
  pass "Resume completed successfully"
else
  fail "Resume exited $resume_exit (expected 0)"
  echo "$resume_output"
  exit 1
fi

if echo "$resume_output" | grep -q "\[resume\] Skipping preflight (cached)"; then
  pass "Resume skipped preflight"
else
  fail "Resume did not skip preflight"
fi

if echo "$resume_output" | grep -q "\[resume\] Skipping gateway (running)"; then
  pass "Resume skipped gateway"
else
  fail "Resume did not skip gateway"
fi

if echo "$resume_output" | grep -q "\[resume\] Skipping sandbox (${SANDBOX_NAME})"; then
  pass "Resume skipped sandbox"
else
  fail "Resume did not skip sandbox"
fi

if echo "$resume_output" | grep -q "\[1/7\] Preflight checks"; then
  fail "Resume reran preflight unexpectedly"
else
  pass "Resume did not rerun preflight"
fi

if echo "$resume_output" | grep -q "\[2/7\] Starting OpenShell gateway"; then
  fail "Resume reran gateway startup unexpectedly"
else
  pass "Resume did not rerun gateway startup"
fi

if echo "$resume_output" | grep -q "\[5/7\] Creating sandbox"; then
  fail "Resume reran sandbox creation unexpectedly"
else
  pass "Resume did not rerun sandbox creation"
fi

if echo "$resume_output" | grep -q "\[4/7\] Setting up inference provider"; then
  pass "Resume continued with inference setup"
else
  fail "Resume did not continue with inference setup"
fi

if run_nemoclaw "$SANDBOX_NAME" status >/dev/null 2>&1; then
  pass "Sandbox '$SANDBOX_NAME' is manageable after resume"
else
  fail "Sandbox '$SANDBOX_NAME' status failed after resume"
fi

node -e '
const fs = require("fs");
const file = process.argv[1];
const data = JSON.parse(fs.readFileSync(file, "utf8"));
if (data.status !== "complete") process.exit(1);
if (data.provider !== "nvidia-prod") process.exit(2);
if (data.steps.preflight.status !== "complete") process.exit(3);
if (data.steps.gateway.status !== "complete") process.exit(4);
if (data.steps.sandbox.status !== "complete") process.exit(5);
if (data.steps.provider_selection.status !== "complete") process.exit(6);
if (data.steps.inference.status !== "complete") process.exit(7);
if (data.steps.openclaw.status !== "complete") process.exit(8);
if (data.steps.policies.status !== "complete") process.exit(9);
' "$SESSION_FILE"
case $? in
  0) pass "Session file recorded full completion after resume" ;;
  *) fail "Session file did not record the expected completed state after resume" ;;
esac

if [ -f "$REGISTRY" ] && grep -q "$SANDBOX_NAME" "$REGISTRY"; then
  pass "Registry contains resumed sandbox entry"
else
  fail "Registry does not contain resumed sandbox entry"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 4: Final cleanup
# ══════════════════════════════════════════════════════════════════
section "Phase 4: Final cleanup"

run_nemoclaw "$SANDBOX_NAME" destroy 2>/dev/null || true
openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true
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
