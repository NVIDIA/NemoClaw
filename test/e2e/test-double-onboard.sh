#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Double onboard: verify that consecutive `nemoclaw onboard` runs recover
# automatically from stale state (gateway, port forward, registry entries)
# left behind by a previous run.
#
# Regression test for issues #21, #22, #140, #152, #397.
#
# Key insight: running onboard without NVIDIA_API_KEY in non-interactive
# mode causes process.exit(1) at step 4, but steps 1-3 (preflight,
# gateway, sandbox) complete first — naturally simulating an unclean exit.
#
# Prerequisites:
#   - Docker running
#   - openshell CLI installed
#   - nemoclaw CLI installed
#   - NVIDIA_API_KEY must NOT be set
#
# Usage:
#   unset NVIDIA_API_KEY
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
  nemoclaw "$SANDBOX_A" destroy 2>/dev/null || true
  nemoclaw "$SANDBOX_B" destroy 2>/dev/null || true
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

if [ -n "${NVIDIA_API_KEY:-}" ]; then
  fail "NVIDIA_API_KEY is set — this test requires it UNSET (unset NVIDIA_API_KEY)"
  exit 1
else
  pass "NVIDIA_API_KEY is not set (required for controlled step-4 exit)"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 2: First onboard (e2e-double-a) — leaves stale state
# ══════════════════════════════════════════════════════════════════
section "Phase 2: First onboard ($SANDBOX_A)"
info "Running nemoclaw onboard — expect exit 1 (no API key)..."

# Write to temp file to avoid openshell FD inheritance blocking $()
ONBOARD_LOG="$(mktemp)"
NEMOCLAW_NON_INTERACTIVE=1 \
  NEMOCLAW_SANDBOX_NAME="$SANDBOX_A" \
  NEMOCLAW_POLICY_MODE=skip \
  nemoclaw onboard --non-interactive >"$ONBOARD_LOG" 2>&1
exit1=$?
output1="$(cat "$ONBOARD_LOG")"
rm -f "$ONBOARD_LOG"

if [ $exit1 -eq 1 ]; then
  pass "First onboard exited 1 (step 4 failed as expected)"
else
  fail "First onboard exited $exit1 (expected 1)"
fi

echo "$output1" | grep -q "Sandbox '${SANDBOX_A}' created" \
  && pass "Sandbox '$SANDBOX_A' created (step 3 completed)" \
  || fail "Sandbox creation not confirmed in output"

# Verify stale state was left behind
openshell gateway info -g nemoclaw 2>/dev/null | grep -q "nemoclaw" \
  && pass "Gateway is still running (stale state)" \
  || fail "Gateway is not running after first onboard"

openshell sandbox get "$SANDBOX_A" >/dev/null 2>&1 \
  && pass "Sandbox '$SANDBOX_A' exists in openshell" \
  || fail "Sandbox '$SANDBOX_A' not found in openshell"

[ -f "$REGISTRY" ] && grep -q "$SANDBOX_A" "$REGISTRY" \
  && pass "Registry contains '$SANDBOX_A'" \
  || fail "Registry does not contain '$SANDBOX_A'"

info "Stale state confirmed — NOT cleaning up before next onboard"

# ══════════════════════════════════════════════════════════════════
# Phase 3: Second onboard — SAME name (e2e-double-a)
# ══════════════════════════════════════════════════════════════════
section "Phase 3: Second onboard ($SANDBOX_A — same name, stale state)"
info "Running nemoclaw onboard with NEMOCLAW_RECREATE_SANDBOX=1..."

ONBOARD_LOG="$(mktemp)"
NEMOCLAW_NON_INTERACTIVE=1 \
  NEMOCLAW_SANDBOX_NAME="$SANDBOX_A" \
  NEMOCLAW_RECREATE_SANDBOX=1 \
  NEMOCLAW_POLICY_MODE=skip \
  nemoclaw onboard --non-interactive >"$ONBOARD_LOG" 2>&1
exit2=$?
output2="$(cat "$ONBOARD_LOG")"
rm -f "$ONBOARD_LOG"

# Step 4 still fails (no API key), but steps 1-3 should succeed
if [ $exit2 -eq 1 ]; then
  pass "Second onboard exited 1 (step 4 failed as expected)"
else
  fail "Second onboard exited $exit2 (expected 1)"
fi

echo "$output2" | grep -q "Cleaning up previous NemoClaw session" \
  && pass "Stale session cleanup fired on second onboard" \
  || fail "Stale session cleanup did NOT fire (regression: #397)"

echo "$output2" | grep -q "Port 8080 is not available" \
  && fail "Port 8080 conflict detected (regression: #21)" \
  || pass "No port 8080 conflict"

echo "$output2" | grep -q "Port 18789 is not available" \
  && fail "Port 18789 conflict detected" \
  || pass "No port 18789 conflict"

echo "$output2" | grep -q "Sandbox '${SANDBOX_A}' created" \
  && pass "Sandbox '$SANDBOX_A' recreated" \
  || fail "Sandbox '$SANDBOX_A' was not recreated"

openshell gateway info -g nemoclaw 2>/dev/null | grep -q "nemoclaw" \
  && pass "Gateway running after second onboard" \
  || fail "Gateway not running after second onboard"

# ══════════════════════════════════════════════════════════════════
# Phase 4: Third onboard — DIFFERENT name (e2e-double-b)
# ══════════════════════════════════════════════════════════════════
section "Phase 4: Third onboard ($SANDBOX_B — different name, stale state)"
info "Running nemoclaw onboard with new sandbox name..."

ONBOARD_LOG="$(mktemp)"
NEMOCLAW_NON_INTERACTIVE=1 \
  NEMOCLAW_SANDBOX_NAME="$SANDBOX_B" \
  NEMOCLAW_POLICY_MODE=skip \
  nemoclaw onboard --non-interactive >"$ONBOARD_LOG" 2>&1
exit3=$?
output3="$(cat "$ONBOARD_LOG")"
rm -f "$ONBOARD_LOG"

if [ $exit3 -eq 1 ]; then
  pass "Third onboard exited 1 (step 4 failed as expected)"
else
  fail "Third onboard exited $exit3 (expected 1)"
fi

echo "$output3" | grep -q "Cleaning up previous NemoClaw session" \
  && pass "Stale session cleanup fired on third onboard" \
  || fail "Stale session cleanup did NOT fire on third onboard"

echo "$output3" | grep -q "Port 8080 is not available" \
  && fail "Port 8080 conflict on third onboard (regression)" \
  || pass "No port 8080 conflict on third onboard"

echo "$output3" | grep -q "Port 18789 is not available" \
  && fail "Port 18789 conflict on third onboard" \
  || pass "No port 18789 conflict on third onboard"

echo "$output3" | grep -q "Sandbox '${SANDBOX_B}' created" \
  && pass "Sandbox '$SANDBOX_B' created" \
  || fail "Sandbox '$SANDBOX_B' was not created"

# ══════════════════════════════════════════════════════════════════
# Phase 5: Final cleanup
# ══════════════════════════════════════════════════════════════════
section "Phase 5: Final cleanup"

nemoclaw "$SANDBOX_A" destroy 2>/dev/null || true
nemoclaw "$SANDBOX_B" destroy 2>/dev/null || true
openshell sandbox delete "$SANDBOX_A" 2>/dev/null || true
openshell sandbox delete "$SANDBOX_B" 2>/dev/null || true
openshell forward stop 18789 2>/dev/null || true
openshell gateway destroy -g nemoclaw 2>/dev/null || true

openshell sandbox get "$SANDBOX_A" >/dev/null 2>&1 \
  && fail "Sandbox '$SANDBOX_A' still exists after cleanup" \
  || pass "Sandbox '$SANDBOX_A' cleaned up"

openshell sandbox get "$SANDBOX_B" >/dev/null 2>&1 \
  && fail "Sandbox '$SANDBOX_B' still exists after cleanup" \
  || pass "Sandbox '$SANDBOX_B' cleaned up"

[ -f "$REGISTRY" ] && grep -q "$SANDBOX_A\|$SANDBOX_B" "$REGISTRY" \
  && fail "Registry still contains test sandbox entries" \
  || pass "Registry cleaned up"

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
