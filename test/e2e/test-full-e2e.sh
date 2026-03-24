#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Full E2E: install → onboard → verify inference (REAL services, no mocks)
#
# Proves the COMPLETE user journey including real inference against
# NVIDIA Endpoints. Runs install.sh --non-interactive which handles
# Node.js, openshell, NemoClaw, and onboard setup automatically.
#
# Prerequisites:
#   - Docker running
#   - NVIDIA_API_KEY set (real key, starts with nvapi-)
#   - Network access to integrate.api.nvidia.com
#
# Environment variables:
#   NEMOCLAW_NON_INTERACTIVE=1   — required (enables non-interactive install + onboard)
#   NEMOCLAW_SANDBOX_NAME        — sandbox name (default: e2e-nightly)
#   NEMOCLAW_RECREATE_SANDBOX=1  — recreate sandbox if it exists from a previous run
#   NVIDIA_API_KEY               — required for NVIDIA Endpoints inference
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 NVIDIA_API_KEY=nvapi-... bash test/e2e/test-full-e2e.sh
#
# See: https://github.com/NVIDIA/NemoClaw/issues/71

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

# Parse chat completion response — handles both content and reasoning_content
# (nemotron-3-super is a reasoning model that may put output in reasoning_content)
parse_chat_content() {
  python3 -c "
import json, sys
try:
    r = json.load(sys.stdin)
    c = r['choices'][0]['message']
    content = c.get('content') or c.get('reasoning_content') or ''
    print(content.strip())
except Exception as e:
    print(f'PARSE_ERROR: {e}', file=sys.stderr)
    sys.exit(1)
"
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

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-nightly}"

# ══════════════════════════════════════════════════════════════════
# Phase 0: Pre-cleanup
# ══════════════════════════════════════════════════════════════════
section "Phase 0: Pre-cleanup"
info "Destroying any leftover sandbox/gateway from previous runs..."
if command -v nemoclaw >/dev/null 2>&1; then
  nemoclaw "$SANDBOX_NAME" destroy 2>/dev/null || true
fi
if command -v openshell >/dev/null 2>&1; then
  openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true
  openshell gateway destroy -g nemoclaw 2>/dev/null || true
fi
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

if [ -n "${NVIDIA_API_KEY:-}" ] && [[ "${NVIDIA_API_KEY}" == nvapi-* ]]; then
  pass "NVIDIA_API_KEY is set (starts with nvapi-)"
else
  fail "NVIDIA_API_KEY not set or invalid — required for live inference"
  exit 1
fi

if curl -sf --max-time 10 https://integrate.api.nvidia.com/v1/models >/dev/null 2>&1; then
  pass "Network access to integrate.api.nvidia.com"
else
  fail "Cannot reach integrate.api.nvidia.com"
  exit 1
fi

if [ "${NEMOCLAW_NON_INTERACTIVE:-}" != "1" ]; then
  fail "NEMOCLAW_NON_INTERACTIVE=1 is required"
  exit 1
fi

# ══════════════════════════════════════════════════════════════════
# Phase 2: Install nemoclaw (non-interactive mode)
# ══════════════════════════════════════════════════════════════════
section "Phase 2: Install nemoclaw (non-interactive mode)"

cd "$REPO" || {
  fail "Could not cd to repo root: $REPO"
  exit 1
}

info "Running install.sh --non-interactive..."
info "This installs Node.js, openshell, NemoClaw, and runs onboard."
info "Expected duration: 5-10 minutes on first run."

INSTALL_LOG="/tmp/nemoclaw-e2e-install.log"
# Write to a file instead of piping through tee. openshell's background
# port-forward inherits pipe file descriptors, which prevents tee from exiting.
# Use tail -f in the background for real-time output in CI logs.
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
# Ensure nvm is loaded in current shell
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
fi
# Ensure ~/.local/bin is on PATH (openshell may be installed there in non-interactive mode)
if [ -d "$HOME/.local/bin" ] && [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  export PATH="$HOME/.local/bin:$PATH"
fi

if [ $install_exit -eq 0 ]; then
  pass "install.sh completed (exit 0)"
else
  fail "install.sh failed (exit $install_exit)"
  exit 1
fi

# Verify nemoclaw is on PATH
if command -v nemoclaw >/dev/null 2>&1; then
  pass "nemoclaw installed at $(command -v nemoclaw)"
else
  fail "nemoclaw not found on PATH after install"
  exit 1
fi

# Verify openshell was installed
if command -v openshell >/dev/null 2>&1; then
  pass "openshell installed ($(openshell --version 2>&1 || echo unknown))"
else
  fail "openshell not found on PATH after install"
  exit 1
fi

if nemoclaw --help >/dev/null 2>&1; then
  pass "nemoclaw --help exits 0"
else
  fail "nemoclaw --help failed"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 3: Sandbox verification
# ══════════════════════════════════════════════════════════════════
section "Phase 3: Sandbox verification"

# 3a: nemoclaw list
if list_output=$(nemoclaw list 2>&1); then
  if grep -Fq -- "$SANDBOX_NAME" <<<"$list_output"; then
    pass "nemoclaw list contains '${SANDBOX_NAME}'"
  else
    fail "nemoclaw list does not contain '${SANDBOX_NAME}'"
  fi
else
  fail "nemoclaw list failed: ${list_output:0:200}"
fi

# 3b: nemoclaw status
if status_output=$(nemoclaw "$SANDBOX_NAME" status 2>&1); then
  pass "nemoclaw ${SANDBOX_NAME} status exits 0"
else
  fail "nemoclaw ${SANDBOX_NAME} status failed: ${status_output:0:200}"
fi

# 3c: Inference must be configured by onboard (no fallback — if onboard
# failed to configure it, that's a bug we want to catch)
if inf_check=$(openshell inference get 2>&1); then
  if grep -qi "nvidia-prod" <<<"$inf_check"; then
    pass "Inference configured via onboard"
  else
    fail "Inference not configured — onboard did not set up nvidia-prod provider"
  fi
else
  fail "openshell inference get failed: ${inf_check:0:200}"
fi

# 3d: Policy presets applied
if policy_output=$(openshell policy get --full "$SANDBOX_NAME" 2>&1); then
  if grep -qi "network_policies" <<<"$policy_output"; then
    pass "Policy applied to sandbox"
  else
    fail "No network policy found on sandbox"
  fi

  # Check that at least npm or pypi preset endpoints are present (onboard auto-suggests these)
  if grep -qi "registry.npmjs.org\|pypi.org" <<<"$policy_output"; then
    pass "Policy presets (npm/pypi) detected in sandbox policy"
  else
    skip "Could not confirm npm/pypi presets in policy (may vary by environment)"
  fi
else
  fail "openshell policy get failed: ${policy_output:0:200}"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 4: Live inference — the real proof
# ══════════════════════════════════════════════════════════════════
section "Phase 4: Live inference"

# ── Test 4a: Direct NVIDIA Endpoints ──
info "[LIVE] Direct API test → integrate.api.nvidia.com..."
api_response=$(curl -s --max-time 30 \
  -X POST https://integrate.api.nvidia.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $NVIDIA_API_KEY" \
  -d '{
    "model": "nvidia/nemotron-3-super-120b-a12b",
    "messages": [{"role": "user", "content": "Reply with exactly one word: PONG"}],
    "max_tokens": 100
  }' 2>/dev/null) || true

if [ -n "$api_response" ]; then
  api_content=$(echo "$api_response" | parse_chat_content 2>/dev/null) || true
  if grep -qi "PONG" <<<"$api_content"; then
    pass "[LIVE] Direct API: model responded with PONG"
  else
    fail "[LIVE] Direct API: expected PONG, got: ${api_content:0:200}"
  fi
else
  fail "[LIVE] Direct API: empty response from curl"
fi

# ── Test 4b: Inference through the sandbox (THE definitive test) ──
info "[LIVE] Sandbox inference test → user → sandbox → gateway → NVIDIA API..."
ssh_config="$(mktemp)"
sandbox_response=""

if openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_config" 2>/dev/null; then
  # Use timeout if available (Linux, Homebrew), fall back to plain ssh
  TIMEOUT_CMD=""
  command -v timeout >/dev/null 2>&1 && TIMEOUT_CMD="timeout 90"
  command -v gtimeout >/dev/null 2>&1 && TIMEOUT_CMD="gtimeout 90"
  sandbox_response=$($TIMEOUT_CMD ssh -F "$ssh_config" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 \
    -o LogLevel=ERROR \
    "openshell-${SANDBOX_NAME}" \
    "curl -s --max-time 60 https://inference.local/v1/chat/completions \
      -H 'Content-Type: application/json' \
      -d '{\"model\":\"nvidia/nemotron-3-super-120b-a12b\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly one word: PONG\"}],\"max_tokens\":100}'" \
    2>&1) || true
fi
rm -f "$ssh_config"

if [ -n "$sandbox_response" ]; then
  sandbox_content=$(echo "$sandbox_response" | parse_chat_content 2>/dev/null) || true
  if grep -qi "PONG" <<<"$sandbox_content"; then
    pass "[LIVE] Sandbox inference: model responded with PONG through sandbox"
    info "Full path proven: user → sandbox → openshell gateway → NVIDIA Endpoints → response"
  else
    fail "[LIVE] Sandbox inference: expected PONG, got: ${sandbox_content:0:200}"
  fi
else
  fail "[LIVE] Sandbox inference: no response from inference.local inside sandbox"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 5: NemoClaw CLI operations
# ══════════════════════════════════════════════════════════════════
section "Phase 5: NemoClaw CLI operations"

# Note: Policy enforcement (proxy blocking, L4/L7 rules, SSRF protection)
# and sandbox command execution are tested extensively in OpenShell's own
# E2E suite (e2e/python/test_sandbox_policy.py, test_sandbox_api.py).
# NemoClaw tests only that its onboard correctly *configured* the policies
# (Phase 3d above), not that OpenShell *enforces* them.

# ── Test 5a: nemoclaw logs ──
info "Testing sandbox log retrieval..."
logs_output=$(nemoclaw "$SANDBOX_NAME" logs 2>&1) || true
if [ -n "$logs_output" ]; then
  pass "nemoclaw logs: produced output ($(echo "$logs_output" | wc -l | tr -d ' ') lines)"
else
  fail "nemoclaw logs: no output"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 6: Cleanup
# ══════════════════════════════════════════════════════════════════
section "Phase 6: Cleanup"

nemoclaw "$SANDBOX_NAME" destroy 2>&1 | tail -3 || true
openshell gateway destroy -g nemoclaw 2>/dev/null || true

list_after=$(nemoclaw list 2>&1)
if grep -Fq -- "$SANDBOX_NAME" <<<"$list_after"; then
  fail "Sandbox ${SANDBOX_NAME} still in list after destroy"
else
  pass "Sandbox ${SANDBOX_NAME} removed"
fi

# ══════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════
echo ""
echo "========================================"
echo "  Full E2E Results:"
echo "    Passed:  $PASS"
echo "    Failed:  $FAIL"
echo "    Skipped: $SKIP"
echo "    Total:   $TOTAL"
echo "========================================"

if [ "$FAIL" -eq 0 ]; then
  printf '\n\033[1;32m  Full E2E PASSED — real inference verified end-to-end.\033[0m\n'
  exit 0
else
  printf '\n\033[1;31m  %d test(s) failed.\033[0m\n' "$FAIL"
  exit 1
fi
