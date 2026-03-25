#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Double onboard: verify that consecutive `nemoclaw onboard` runs recover
# automatically from stale state and do not destructively recreate an
# existing healthy sandbox unless explicitly requested.
#
# Regression test for issues #21, #22, #140, #152, #397.
#
# Key insight: we need a deterministic late failure after sandbox creation
# so each run leaves behind stale gateway/sandbox state to recover from on
# the next onboard attempt.
#
# Prerequisites:
#   - Docker running
#   - openshell CLI installed
#   - nemoclaw CLI installed
#   - Either:
#     - local Ollama available on localhost:11434, or
#     - NVIDIA_API_KEY set to a valid nvapi-* key
#
# Usage:
#   bash test/e2e/test-double-onboard.sh

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

SANDBOX_A="e2e-double-a"
SANDBOX_B="e2e-double-b"
REGISTRY="$HOME/.nemoclaw/sandboxes.json"
ONBOARD_PROVIDER=""
FAILURE_REASON=""

# ══════════════════════════════════════════════════════════════════
# Phase 0: Pre-cleanup
# ══════════════════════════════════════════════════════════════════
section "Phase 0: Pre-cleanup"
info "Destroying any leftover test sandboxes/gateway from previous runs..."
# Use nemoclaw destroy (not just openshell sandbox delete) to also clean
# the nemoclaw registry at ~/.nemoclaw/sandboxes.json.  Stale registry
# entries from a previous run would cause Phase 2 to exit with
# "Sandbox already exists" before the test even starts.
if command -v nemoclaw >/dev/null 2>&1; then
  nemoclaw "$SANDBOX_A" destroy --yes 2>/dev/null || true
  nemoclaw "$SANDBOX_B" destroy --yes 2>/dev/null || true
fi
openshell sandbox delete "$SANDBOX_A" 2>/dev/null || true
openshell sandbox delete "$SANDBOX_B" 2>/dev/null || true
openshell forward stop 18789 2>/dev/null || true
openshell gateway destroy -g nemoclaw 2>/dev/null || true
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

if command -v nemoclaw >/dev/null 2>&1; then
  pass "nemoclaw CLI installed"
else
  fail "nemoclaw CLI not found — cannot continue"
  exit 1
fi

if command -v ollama >/dev/null 2>&1 && curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then
  ONBOARD_PROVIDER="ollama"
  FAILURE_REASON="unsupported policy mode after sandbox creation"
  pass "Local Ollama available for late-failure stale-state setup"
elif [[ -n "${NVIDIA_API_KEY:-}" && "${NVIDIA_API_KEY}" == nvapi-* ]]; then
  ONBOARD_PROVIDER="build"
  FAILURE_REASON="unsupported policy mode after sandbox creation"
  pass "NVIDIA_API_KEY available for late-failure stale-state setup"
else
  skip "Skipping: requires local Ollama or NVIDIA_API_KEY to reach sandbox creation before the intentional failure"
  exit 0
fi

# ══════════════════════════════════════════════════════════════════
# Phase 2: First onboard (e2e-double-a) — leaves stale state
# ══════════════════════════════════════════════════════════════════
section "Phase 2: First onboard ($SANDBOX_A)"
info "Running nemoclaw onboard — expect exit 1 (${FAILURE_REASON})..."

# Write to temp file to avoid openshell FD inheritance blocking $()
ONBOARD_LOG="$(mktemp)"
NEMOCLAW_NON_INTERACTIVE=1 \
  NEMOCLAW_PROVIDER="$ONBOARD_PROVIDER" \
  NEMOCLAW_SANDBOX_NAME="$SANDBOX_A" \
  NEMOCLAW_POLICY_MODE=invalid \
  nemoclaw onboard --non-interactive >"$ONBOARD_LOG" 2>&1
exit1=$?
output1="$(cat "$ONBOARD_LOG")"
rm -f "$ONBOARD_LOG"

if [ $exit1 -eq 1 ]; then
  pass "First onboard exited 1 (intentional late failure)"
else
  fail "First onboard exited $exit1 (expected 1)"
fi

if grep -q "Sandbox '${SANDBOX_A}' created" <<<"$output1"; then
  pass "Sandbox '$SANDBOX_A' created (step 3 completed)"
else
  fail "Sandbox creation not confirmed in output"
fi

# Verify stale state was left behind
if openshell gateway info -g nemoclaw 2>/dev/null | grep -q "nemoclaw"; then
  pass "Gateway is still running (stale state)"
else
  fail "Gateway is not running after first onboard"
fi

if openshell sandbox get "$SANDBOX_A" >/dev/null 2>&1; then
  pass "Sandbox '$SANDBOX_A' exists in openshell"
else
  fail "Sandbox '$SANDBOX_A' not found in openshell"
fi

if [ -f "$REGISTRY" ] && grep -q "$SANDBOX_A" "$REGISTRY"; then
  pass "Registry contains '$SANDBOX_A'"
else
  fail "Registry does not contain '$SANDBOX_A'"
fi

info "Stale state confirmed — NOT cleaning up before next onboard"

# ══════════════════════════════════════════════════════════════════
# Phase 3: Second onboard — SAME name (e2e-double-a)
# ══════════════════════════════════════════════════════════════════
section "Phase 3: Second onboard ($SANDBOX_A — same name, safe reuse)"
info "Running nemoclaw onboard again with the same sandbox name..."

ONBOARD_LOG="$(mktemp)"
NEMOCLAW_NON_INTERACTIVE=1 \
  NEMOCLAW_PROVIDER="$ONBOARD_PROVIDER" \
  NEMOCLAW_SANDBOX_NAME="$SANDBOX_A" \
  NEMOCLAW_POLICY_MODE=invalid \
  nemoclaw onboard --non-interactive >"$ONBOARD_LOG" 2>&1
exit2=$?
output2="$(cat "$ONBOARD_LOG")"
rm -f "$ONBOARD_LOG"

if [ $exit2 -eq 1 ]; then
  pass "Second onboard exited 1 (intentional late failure)"
else
  fail "Second onboard exited $exit2 (expected 1)"
fi

if grep -q "Reusing healthy NemoClaw gateway." <<<"$output2"; then
  pass "Second onboard reused the healthy gateway without teardown"
else
  fail "Second onboard did not report healthy gateway reuse"
fi

if grep -q "Port 8080 is not available" <<<"$output2"; then
  fail "Port 8080 conflict detected (regression: #21)"
else
  pass "No port 8080 conflict"
fi

if grep -q "Port 18789 is not available" <<<"$output2"; then
  fail "Port 18789 conflict detected"
else
  pass "No port 18789 conflict"
fi

if grep -q "\[non-interactive\] Sandbox '${SANDBOX_A}' exists and is ready — reusing it" <<<"$output2"; then
  pass "Second onboard reused existing sandbox by default"
else
  fail "Second onboard did not report safe sandbox reuse"
fi

if grep -q "Sandbox '${SANDBOX_A}' created" <<<"$output2"; then
  fail "Sandbox '$SANDBOX_A' was recreated unexpectedly"
else
  pass "Second onboard did not recreate the healthy sandbox"
fi

if openshell gateway info -g nemoclaw 2>/dev/null | grep -q "nemoclaw"; then
  pass "Gateway running after second onboard"
else
  fail "Gateway not running after second onboard"
fi

if openshell sandbox get "$SANDBOX_A" >/dev/null 2>&1; then
  pass "Sandbox '$SANDBOX_A' still exists after second onboard"
else
  fail "Sandbox '$SANDBOX_A' missing after second onboard"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 4: Third onboard — DIFFERENT name (e2e-double-b)
# ══════════════════════════════════════════════════════════════════
section "Phase 4: Third onboard ($SANDBOX_B — different name, stale state)"
info "Running nemoclaw onboard with new sandbox name..."

ONBOARD_LOG="$(mktemp)"
NEMOCLAW_NON_INTERACTIVE=1 \
  NEMOCLAW_PROVIDER="$ONBOARD_PROVIDER" \
  NEMOCLAW_SANDBOX_NAME="$SANDBOX_B" \
  NEMOCLAW_POLICY_MODE=invalid \
  nemoclaw onboard --non-interactive >"$ONBOARD_LOG" 2>&1
exit3=$?
output3="$(cat "$ONBOARD_LOG")"
rm -f "$ONBOARD_LOG"

if [ $exit3 -eq 1 ]; then
  pass "Third onboard exited 1 (intentional late failure)"
else
  fail "Third onboard exited $exit3 (expected 1)"
fi

if grep -q "Reusing healthy NemoClaw gateway." <<<"$output3"; then
  pass "Third onboard reused the healthy gateway without teardown"
else
  fail "Third onboard did not report healthy gateway reuse"
fi

if grep -q "Port 8080 is not available" <<<"$output3"; then
  fail "Port 8080 conflict on third onboard (regression)"
else
  pass "No port 8080 conflict on third onboard"
fi

if grep -q "Port 18789 is not available" <<<"$output3"; then
  fail "Port 18789 conflict on third onboard"
else
  pass "No port 18789 conflict on third onboard"
fi

if grep -q "Sandbox '${SANDBOX_B}' created" <<<"$output3"; then
  pass "Sandbox '$SANDBOX_B' created"
else
  fail "Sandbox '$SANDBOX_B' was not created"
fi

if openshell sandbox get "$SANDBOX_A" >/dev/null 2>&1; then
  pass "Original sandbox '$SANDBOX_A' preserved when onboarding '$SANDBOX_B'"
else
  fail "Original sandbox '$SANDBOX_A' was disturbed by onboarding '$SANDBOX_B'"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 5: Final cleanup
# ══════════════════════════════════════════════════════════════════
section "Phase 5: Final cleanup"

nemoclaw "$SANDBOX_A" destroy --yes 2>/dev/null || true
nemoclaw "$SANDBOX_B" destroy --yes 2>/dev/null || true
openshell sandbox delete "$SANDBOX_A" 2>/dev/null || true
openshell sandbox delete "$SANDBOX_B" 2>/dev/null || true
openshell forward stop 18789 2>/dev/null || true
openshell gateway destroy -g nemoclaw 2>/dev/null || true

if openshell sandbox get "$SANDBOX_A" >/dev/null 2>&1; then
  fail "Sandbox '$SANDBOX_A' still exists after cleanup"
else
  pass "Sandbox '$SANDBOX_A' cleaned up"
fi

if openshell sandbox get "$SANDBOX_B" >/dev/null 2>&1; then
  fail "Sandbox '$SANDBOX_B' still exists after cleanup"
else
  pass "Sandbox '$SANDBOX_B' cleaned up"
fi

if [ -f "$REGISTRY" ] && grep -q "$SANDBOX_A\|$SANDBOX_B" "$REGISTRY"; then
  fail "Registry still contains test sandbox entries"
else
  pass "Registry cleaned up"
fi

pass "Final cleanup complete"

# ══════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════
echo ""
echo "========================================"
echo "  Double Onboard E2E Results:"
echo "    Passed:  $PASS"
echo "    Failed:  $FAIL"
echo "    Skipped: $SKIP"
echo "    Total:   $TOTAL"
echo "========================================"

if [ "$FAIL" -eq 0 ]; then
  printf '\n\033[1;32m  Double onboard PASSED — stale state recovery verified.\033[0m\n'
  exit 0
else
  printf '\n\033[1;31m  %d test(s) failed.\033[0m\n' "$FAIL"
  exit 1
fi
