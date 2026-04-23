#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Token rotation E2E test (issue #1903):
#   - prove that rotating a messaging token and re-running onboard propagates
#     the new credential to the sandbox (sandbox is rebuilt automatically)
#   - prove that re-running onboard with the same token reuses the sandbox
#   - prove that rotating each provider in isolation only re-builds for that
#     provider's bridge (no cross-talk between Telegram and Discord detection)
#
# Uses two distinct fake tokens per provider. The test validates that NemoClaw
# detects the rotation and triggers a sandbox rebuild — it does not validate
# the Telegram or Discord API responses.
#
# Prerequisites:
#   - Docker running
#   - NVIDIA_API_KEY set (or fake OpenAI endpoint)
#   - TELEGRAM_BOT_TOKEN_A and TELEGRAM_BOT_TOKEN_B set (can be fake)
#   - DISCORD_BOT_TOKEN_A and DISCORD_BOT_TOKEN_B set (can be fake)
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
#     NVIDIA_API_KEY=nvapi-... \
#     TELEGRAM_BOT_TOKEN_A=fake-a TELEGRAM_BOT_TOKEN_B=fake-b \
#     DISCORD_BOT_TOKEN_A=fake-c DISCORD_BOT_TOKEN_B=fake-d \
#     bash test/e2e/test-token-rotation.sh

set -uo pipefail

TIMEOUT_CMD=""
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_CMD="timeout"
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_CMD="gtimeout"
fi

if [ "${NEMOCLAW_E2E_NO_TIMEOUT:-0}" != "1" ] && [ "${NEMOCLAW_E2E_TIMEOUT_WRAPPED:-0}" != "1" ]; then
  TIMEOUT_SECONDS="${NEMOCLAW_E2E_TIMEOUT_SECONDS:-2400}"
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
INSTALL_OK=1
PREREQS_OK=1

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
print_summary() {
  section "Summary"
  echo "  Total: $TOTAL  Pass: $PASS  Fail: $FAIL  Skip: $SKIP"
  if [ "$FAIL" -gt 0 ]; then
    echo ""
    echo "FAILED"
    exit 1
  fi
  echo ""
  if [ "$SKIP" -gt 0 ]; then
    echo "PASSED (with $SKIP skipped)"
  else
    echo "ALL PASSED"
  fi
}

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
  skip "TELEGRAM_BOT_TOKEN_A and TELEGRAM_BOT_TOKEN_B must both be set"
  PREREQS_OK=0
fi

if [ -z "${DISCORD_BOT_TOKEN_A:-}" ] || [ -z "${DISCORD_BOT_TOKEN_B:-}" ]; then
  skip "DISCORD_BOT_TOKEN_A and DISCORD_BOT_TOKEN_B must both be set"
  PREREQS_OK=0
fi

if [ -n "${TELEGRAM_BOT_TOKEN_A:-}" ] && [ "${TELEGRAM_BOT_TOKEN_A}" = "${TELEGRAM_BOT_TOKEN_B:-}" ]; then
  skip "TELEGRAM_BOT_TOKEN_A and TELEGRAM_BOT_TOKEN_B must be different"
  PREREQS_OK=0
fi

if [ -n "${DISCORD_BOT_TOKEN_A:-}" ] && [ "${DISCORD_BOT_TOKEN_A}" = "${DISCORD_BOT_TOKEN_B:-}" ]; then
  skip "DISCORD_BOT_TOKEN_A and DISCORD_BOT_TOKEN_B must be different"
  PREREQS_OK=0
fi

# Bail to summary if any prereq failed (no phases run, but Summary still prints)
if [ "$PREREQS_OK" != "1" ]; then
  print_summary
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
export DISCORD_BOT_TOKEN="$DISCORD_BOT_TOKEN_A"
# Determinism: clear ambient SLACK_* so onboard doesn't add an extra
# slack-bridge provider (messagingTokenDefs at onboard.ts).
unset SLACK_BOT_TOKEN SLACK_APP_TOKEN
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
  INSTALL_OK=0
  if grep -qE "(Telegram|Discord) network reachability failure" "$INSTALL_LOG" 2>/dev/null; then
    skip "install.sh aborted: messaging API unreachable (likely VPN / corporate proxy)"
    info "Detected '<provider> network reachability failure' in install log."
  else
    fail "install.sh failed (exit $install_exit)"
  fi
  info "Last 30 lines of install log:"
  tail -30 "$INSTALL_LOG" 2>/dev/null || true
fi

# Verify tools are on PATH
if [ "$INSTALL_OK" = "1" ]; then
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
fi

if [ "$INSTALL_OK" != "1" ]; then
  section "Skipping verification phases — initial install did not complete"
  skip "Phase 1: Verify first onboard results"
  skip "Phase 2: Re-onboard with rotated TELEGRAM_BOT_TOKEN_B"
  skip "Phase 3: Re-onboard with same tokens (after Telegram rotation)"
  skip "Phase 4: Re-onboard with rotated DISCORD_BOT_TOKEN_B"
  skip "Phase 5: Re-onboard with same tokens (after Discord rotation)"
else
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

  if openshell provider get "${SANDBOX_NAME}-discord-bridge" >/dev/null 2>&1; then
    pass "Provider ${SANDBOX_NAME}-discord-bridge exists"
  else
    fail "Provider ${SANDBOX_NAME}-discord-bridge not found"
  fi

  # Verify credential hashes are stored for this sandbox in the registry
  if [ -f "$REGISTRY" ] && node -e "
const r = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
const h = (r.sandboxes || {})[process.argv[2]]?.providerCredentialHashes || {};
process.exit('TELEGRAM_BOT_TOKEN' in h ? 0 : 1);
" "$REGISTRY" "$SANDBOX_NAME" 2>/dev/null; then
    pass "Telegram credential hash stored for $SANDBOX_NAME"
  else
    fail "Telegram credential hash not found for $SANDBOX_NAME in registry"
  fi

  if [ -f "$REGISTRY" ] && node -e "
const r = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
const h = (r.sandboxes || {})[process.argv[2]]?.providerCredentialHashes || {};
process.exit('DISCORD_BOT_TOKEN' in h ? 0 : 1);
" "$REGISTRY" "$SANDBOX_NAME" 2>/dev/null; then
    pass "Discord credential hash stored for $SANDBOX_NAME"
  else
    fail "Discord credential hash not found for $SANDBOX_NAME in registry"
  fi

  # ── Phase 2: Rotate Telegram token only (re-onboard with token B) ─

  section "Phase 2: Re-onboard with rotated TELEGRAM_BOT_TOKEN_B (Discord unchanged)"

  export TELEGRAM_BOT_TOKEN="$TELEGRAM_BOT_TOKEN_B"
  export DISCORD_BOT_TOKEN="$DISCORD_BOT_TOKEN_A"
  # Determinism: clear ambient SLACK_* so onboard doesn't add an extra
  # slack-bridge provider (messagingTokenDefs at onboard.ts).
  unset SLACK_BOT_TOKEN SLACK_APP_TOKEN
  unset NEMOCLAW_RECREATE_SANDBOX

  ONBOARD_OUTPUT=$(nemoclaw onboard --non-interactive 2>&1)
  onboard_exit=$?

  if [ $onboard_exit -ne 0 ]; then
    fail "Phase 2 onboard failed (exit $onboard_exit)"
    echo "$ONBOARD_OUTPUT" | tail -30
  fi

  if echo "$ONBOARD_OUTPUT" | grep -q "credential(s) rotated"; then
    pass "Credential rotation detected"
  else
    fail "Credential rotation not detected in onboard output"
    info "Onboard output:"
    echo "$ONBOARD_OUTPUT" | tail -20
  fi

  # Rotation message must name only the telegram-bridge provider — Discord
  # token is unchanged, so a stray discord-bridge entry would indicate a
  # false-positive in detectMessagingCredentialRotation.
  if echo "$ONBOARD_OUTPUT" | grep -q "credential(s) rotated:.*telegram-bridge"; then
    pass "Rotation message identifies telegram-bridge"
  else
    fail "Rotation message did not identify telegram-bridge"
    info "Onboard output:"
    echo "$ONBOARD_OUTPUT" | grep "credential(s) rotated" || true
  fi

  if echo "$ONBOARD_OUTPUT" | grep -q "credential(s) rotated:.*discord-bridge"; then
    fail "Rotation message unexpectedly named discord-bridge (Discord token did not change)"
    info "Onboard output:"
    echo "$ONBOARD_OUTPUT" | grep "credential(s) rotated" || true
  else
    pass "Rotation message did not name discord-bridge (Discord unchanged)"
  fi

  if echo "$ONBOARD_OUTPUT" | grep -q "Rebuilding sandbox"; then
    pass "Sandbox rebuild triggered by rotation"
  else
    fail "Sandbox rebuild not triggered"
    info "Onboard output:"
    echo "$ONBOARD_OUTPUT" | tail -20
  fi

  if openshell sandbox list 2>/dev/null | grep -q "$SANDBOX_NAME"; then
    pass "Sandbox running after Telegram rotation"
  else
    fail "Sandbox not running after Telegram rotation"
  fi

  # ── Phase 3: Re-onboard with same tokens (no change) ─────────────

  section "Phase 3: Re-onboard with same tokens (no rotation expected)"

  ONBOARD_OUTPUT=$(nemoclaw onboard --non-interactive 2>&1)
  onboard_exit=$?

  if [ $onboard_exit -ne 0 ]; then
    fail "Phase 3 onboard failed (exit $onboard_exit)"
    echo "$ONBOARD_OUTPUT" | tail -30
  fi

  if echo "$ONBOARD_OUTPUT" | grep -q "reusing it"; then
    pass "Sandbox reused when tokens unchanged"
  else
    fail "Sandbox was not reused (unexpected rebuild)"
    info "Onboard output:"
    echo "$ONBOARD_OUTPUT" | tail -20
  fi

  # ── Phase 4: Rotate Discord token only (re-onboard with token B) ─

  section "Phase 4: Re-onboard with rotated DISCORD_BOT_TOKEN_B (Telegram unchanged)"

  export TELEGRAM_BOT_TOKEN="$TELEGRAM_BOT_TOKEN_B"
  export DISCORD_BOT_TOKEN="$DISCORD_BOT_TOKEN_B"
  # Determinism: clear ambient SLACK_* so onboard doesn't add an extra
  # slack-bridge provider (messagingTokenDefs at onboard.ts).
  unset SLACK_BOT_TOKEN SLACK_APP_TOKEN

  ONBOARD_OUTPUT=$(nemoclaw onboard --non-interactive 2>&1)
  onboard_exit=$?

  if [ $onboard_exit -ne 0 ]; then
    fail "Phase 4 onboard failed (exit $onboard_exit)"
    echo "$ONBOARD_OUTPUT" | tail -30
  fi

  if echo "$ONBOARD_OUTPUT" | grep -q "credential(s) rotated"; then
    pass "Credential rotation detected"
  else
    fail "Credential rotation not detected in onboard output"
    info "Onboard output:"
    echo "$ONBOARD_OUTPUT" | tail -20
  fi

  # Symmetric assertion to Phase 2: only the discord-bridge entry should appear.
  if echo "$ONBOARD_OUTPUT" | grep -q "credential(s) rotated:.*discord-bridge"; then
    pass "Rotation message identifies discord-bridge"
  else
    fail "Rotation message did not identify discord-bridge"
    info "Onboard output:"
    echo "$ONBOARD_OUTPUT" | grep "credential(s) rotated" || true
  fi

  if echo "$ONBOARD_OUTPUT" | grep -q "credential(s) rotated:.*telegram-bridge"; then
    fail "Rotation message unexpectedly named telegram-bridge (Telegram token did not change)"
    info "Onboard output:"
    echo "$ONBOARD_OUTPUT" | grep "credential(s) rotated" || true
  else
    pass "Rotation message did not name telegram-bridge (Telegram unchanged)"
  fi

  if echo "$ONBOARD_OUTPUT" | grep -q "Rebuilding sandbox"; then
    pass "Sandbox rebuild triggered by rotation"
  else
    fail "Sandbox rebuild not triggered"
    info "Onboard output:"
    echo "$ONBOARD_OUTPUT" | tail -20
  fi

  if openshell sandbox list 2>/dev/null | grep -q "$SANDBOX_NAME"; then
    pass "Sandbox running after Discord rotation"
  else
    fail "Sandbox not running after Discord rotation"
  fi

  # ── Phase 5: Re-onboard with same tokens (no change) ─────────────

  section "Phase 5: Re-onboard with same tokens (no rotation expected)"

  ONBOARD_OUTPUT=$(nemoclaw onboard --non-interactive 2>&1)
  onboard_exit=$?

  if [ $onboard_exit -ne 0 ]; then
    fail "Phase 5 onboard failed (exit $onboard_exit)"
    echo "$ONBOARD_OUTPUT" | tail -30
  fi

  if echo "$ONBOARD_OUTPUT" | grep -q "reusing it"; then
    pass "Sandbox reused when tokens unchanged"
  else
    fail "Sandbox was not reused (unexpected rebuild)"
    info "Onboard output:"
    echo "$ONBOARD_OUTPUT" | tail -20
  fi
fi

# ── Summary ───────────────────────────────────────────────────────

print_summary
