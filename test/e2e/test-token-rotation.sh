#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Token rotation E2E test (issue #1903):
#   - prove that rotating a messaging token and re-running onboard propagates
#     the new credential to the sandbox (sandbox is rebuilt automatically)
#   - prove that re-running onboard with the same token reuses the sandbox
#
# Uses two distinct fake tokens. The test validates that NemoClaw detects the
# rotation and triggers a sandbox rebuild, not the Telegram API response.
#
# Prerequisites:
#   - Docker running
#   - NVIDIA_API_KEY set (or fake OpenAI endpoint)
#   - TELEGRAM_BOT_TOKEN_A and TELEGRAM_BOT_TOKEN_B set (can be fake)
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
#     NVIDIA_API_KEY=nvapi-... \
#     TELEGRAM_BOT_TOKEN_A=fake-a TELEGRAM_BOT_TOKEN_B=fake-b \
#     bash test/e2e/test-token-rotation.sh

set -uo pipefail

if [ -z "${NEMOCLAW_E2E_NO_TIMEOUT:-}" ]; then
  export NEMOCLAW_E2E_NO_TIMEOUT=1
  TIMEOUT_SECONDS="${NEMOCLAW_E2E_TIMEOUT_SECONDS:-900}"
  exec timeout -s TERM "$TIMEOUT_SECONDS" "$0" "$@"
fi

PASS=0
FAIL=0
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
section() {
  echo ""
  printf '\033[1;36m=== %s ===\033[0m\n' "$1"
}
info() { printf '\033[1;34m  [info]\033[0m %s\n' "$1"; }

# Determine repo root
if [ -d /workspace ] && [ -f /workspace/install.sh ]; then
  REPO="/workspace"
elif [ -f "$(cd "$(dirname "$0")/../.." && pwd)/install.sh" ]; then
  REPO="$(cd "$(dirname "$0")/../.." && pwd)"
else
  echo "ERROR: Cannot find repo root."
  exit 1
fi

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-token-rotation}"
REGISTRY="$HOME/.nemoclaw/sandboxes.json"
INSTALL_LOG="/tmp/nemoclaw-e2e-install.log"

# ── Prerequisite checks ──────────────────────────────────────────

if [ -z "${TELEGRAM_BOT_TOKEN_A:-}" ] || [ -z "${TELEGRAM_BOT_TOKEN_B:-}" ]; then
  echo "SKIP: TELEGRAM_BOT_TOKEN_A and TELEGRAM_BOT_TOKEN_B must both be set"
  exit 0
fi

if [ "$TELEGRAM_BOT_TOKEN_A" = "$TELEGRAM_BOT_TOKEN_B" ]; then
  echo "SKIP: TELEGRAM_BOT_TOKEN_A and TELEGRAM_BOT_TOKEN_B must be different"
  exit 0
fi

# ── Helpers ───────────────────────────────────────────────────────

cleanup() {
  openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true
}
trap cleanup EXIT

# ── Phase 0: Install NemoClaw with token A ────────────────────────

section "Phase 0: Install NemoClaw and first onboard with token A"

# Pre-clean
openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true
openshell gateway destroy -g nemoclaw 2>/dev/null || true

export TELEGRAM_BOT_TOKEN="$TELEGRAM_BOT_TOKEN_A"
export NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME"
export NEMOCLAW_POLICY_TIER="open"
export NEMOCLAW_RECREATE_SANDBOX=1

info "Running install.sh --non-interactive (includes first onboard)..."
cd "$REPO" || exit 1
touch "$INSTALL_LOG"
bash install.sh --non-interactive >"$INSTALL_LOG" 2>&1 &
install_pid=$!
tail -f "$INSTALL_LOG" --pid=$install_pid 2>/dev/null &
tail_pid=$!
wait $install_pid
install_exit=$?
kill $tail_pid 2>/dev/null || true
wait $tail_pid 2>/dev/null || true

# Source shell profile to pick up nvm/PATH changes from install.sh
if [ -f "$HOME/.bashrc" ]; then
  # shellcheck source=/dev/null
  source "$HOME/.bashrc" 2>/dev/null || true
fi
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
fi
if [ -d "$HOME/.local/bin" ] && [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  export PATH="$HOME/.local/bin:$PATH"
fi

if [ $install_exit -eq 0 ]; then
  pass "install.sh completed (exit 0)"
else
  fail "install.sh failed (exit $install_exit)"
  info "Last 30 lines of install log:"
  tail -30 "$INSTALL_LOG" 2>/dev/null || true
  exit 1
fi

# Verify tools are on PATH
if ! command -v openshell >/dev/null 2>&1; then
  fail "openshell not found on PATH after install"
  exit 1
fi
pass "openshell installed ($(openshell --version 2>&1 || echo unknown))"

if ! command -v nemoclaw >/dev/null 2>&1; then
  fail "nemoclaw not found on PATH after install"
  exit 1
fi
pass "nemoclaw installed at $(command -v nemoclaw)"

# ── Phase 1: Verify first onboard with token A ──────────────────

section "Phase 1: Verify first onboard results"

if openshell sandbox list 2>/dev/null | grep -q "$SANDBOX_NAME"; then
  pass "Sandbox $SANDBOX_NAME created and running"
else
  fail "Sandbox $SANDBOX_NAME not running after first onboard"
fi

if openshell provider get "${SANDBOX_NAME}-telegram-bridge" >/dev/null 2>&1; then
  pass "Provider ${SANDBOX_NAME}-telegram-bridge exists"
else
  fail "Provider ${SANDBOX_NAME}-telegram-bridge not found"
fi

# Verify credential hashes are stored for this sandbox in the registry
if [ -f "$REGISTRY" ] && node -e "
const r = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
const h = (r.sandboxes || {})[process.argv[2]]?.providerCredentialHashes || {};
process.exit('TELEGRAM_BOT_TOKEN' in h ? 0 : 1);
" "$REGISTRY" "$SANDBOX_NAME" 2>/dev/null; then
  pass "Credential hash stored for $SANDBOX_NAME"
else
  fail "Credential hash not found for $SANDBOX_NAME in registry"
fi

# ── Phase 2: Rotate token (re-onboard with token B) ──────────────

section "Phase 2: Re-onboard with rotated TELEGRAM_BOT_TOKEN_B"

export TELEGRAM_BOT_TOKEN="$TELEGRAM_BOT_TOKEN_B"
unset NEMOCLAW_RECREATE_SANDBOX

ONBOARD_OUTPUT=$(nemoclaw onboard --non-interactive 2>&1)
onboard_exit=$?

if [ $onboard_exit -ne 0 ]; then
  fail "Phase 2 onboard failed (exit $onboard_exit)"
  echo "$ONBOARD_OUTPUT" | tail -30
  exit 1
fi

if echo "$ONBOARD_OUTPUT" | grep -q "credential(s) rotated"; then
  pass "Credential rotation detected"
else
  fail "Credential rotation not detected in onboard output"
  info "Onboard output:"
  echo "$ONBOARD_OUTPUT" | tail -20
fi

if echo "$ONBOARD_OUTPUT" | grep -q "Rebuilding sandbox"; then
  pass "Sandbox rebuild triggered by rotation"
else
  fail "Sandbox rebuild not triggered"
  info "Onboard output:"
  echo "$ONBOARD_OUTPUT" | tail -20
fi

if openshell sandbox list 2>/dev/null | grep -q "$SANDBOX_NAME"; then
  pass "Sandbox running after rotation"
else
  fail "Sandbox not running after rotation"
fi

# ── Phase 3: Re-onboard with same token B (no change) ────────────

section "Phase 3: Re-onboard with same token (no rotation expected)"

ONBOARD_OUTPUT=$(nemoclaw onboard --non-interactive 2>&1)
onboard_exit=$?

if [ $onboard_exit -ne 0 ]; then
  fail "Phase 3 onboard failed (exit $onboard_exit)"
  echo "$ONBOARD_OUTPUT" | tail -30
  exit 1
fi

if echo "$ONBOARD_OUTPUT" | grep -q "reusing it"; then
  pass "Sandbox reused when token unchanged"
else
  fail "Sandbox was not reused (unexpected rebuild)"
  info "Onboard output:"
  echo "$ONBOARD_OUTPUT" | tail -20
fi

# ── Summary ───────────────────────────────────────────────────────

section "Summary"
echo "  Total: $TOTAL  Pass: $PASS  Fail: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "FAILED"
  exit 1
fi
echo ""
echo "ALL PASSED"
