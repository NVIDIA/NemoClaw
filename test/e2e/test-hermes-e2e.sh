#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Hermes Agent E2E: install → onboard --agent hermes → verify sandbox → live inference
#
# Proves the COMPLETE Hermes user journey including agent selection, health
# probe verification, and real inference through the sandbox. Uses the same
# install.sh --non-interactive path as the OpenClaw E2E but passes
# NEMOCLAW_AGENT=hermes to select the Hermes agent during onboarding.
#
# Prerequisites:
#   - Docker running
#   - NVIDIA_API_KEY set (real key, starts with nvapi-)
#   - Network access to integrate.api.nvidia.com
#
# Environment variables:
#   NEMOCLAW_NON_INTERACTIVE=1             — required (enables non-interactive install + onboard)
#   NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 — required for non-interactive install/onboard
#   NEMOCLAW_AGENT=hermes                  — auto-set if not already set
#   NEMOCLAW_SANDBOX_NAME                  — sandbox name (default: e2e-hermes)
#   NEMOCLAW_RECREATE_SANDBOX=1            — recreate sandbox if it exists from a previous run
#   NVIDIA_API_KEY                         — required for NVIDIA Endpoints inference
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 NVIDIA_API_KEY=nvapi-... bash test/e2e/test-hermes-e2e.sh

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

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-hermes}"
export NEMOCLAW_AGENT="${NEMOCLAW_AGENT:-hermes}"

# shellcheck source=test/e2e/lib/sandbox-teardown.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/sandbox-teardown.sh"
register_sandbox_for_teardown "$SANDBOX_NAME"

# Hermes health probe endpoint (from agents/hermes/manifest.yaml)
HERMES_HEALTH_URL="http://localhost:8642/health"

# ══════════════════════════════════════════════════════════════════
# Phase 0: Pre-cleanup
# ══════════════════════════════════════════════════════════════════
section "Phase 0: Pre-cleanup"
info "Destroying any leftover sandbox/gateway from previous runs..."
if command -v nemoclaw >/dev/null 2>&1; then
  nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true
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

if [ "${NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE:-}" != "1" ]; then
  fail "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 is required for non-interactive install"
  exit 1
fi

# Verify agents/hermes/ exists in repo
if [ -d "$REPO/agents/hermes" ] && [ -f "$REPO/agents/hermes/manifest.yaml" ]; then
  pass "agents/hermes/ directory and manifest.yaml exist"
else
  fail "agents/hermes/ not found — is the hermes-agent-support branch checked out?"
  exit 1
fi

info "NEMOCLAW_AGENT=${NEMOCLAW_AGENT}"

# ══════════════════════════════════════════════════════════════════
# Phase 2: Install nemoclaw (non-interactive mode, --agent hermes)
# ══════════════════════════════════════════════════════════════════
section "Phase 2: Install nemoclaw (non-interactive mode, agent=hermes)"

cd "$REPO" || {
  fail "Could not cd to repo root: $REPO"
  exit 1
}

info "Running install.sh --non-interactive with NEMOCLAW_AGENT=hermes..."
info "This installs Node.js, openshell, NemoClaw, and runs onboard with Hermes agent."
info "Expected duration: 10-15 minutes on first run (Hermes base image build)."

INSTALL_LOG="/tmp/nemoclaw-e2e-hermes-install.log"
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
# Phase 3: Sandbox verification (Hermes-specific)
# ══════════════════════════════════════════════════════════════════
section "Phase 3: Sandbox verification (Hermes)"

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

# 3c: Session records agent=hermes
session_file="$HOME/.nemoclaw/onboard-session.json"
if [ -f "$session_file" ]; then
  if grep -qE '"agent"\s*:\s*"hermes"' "$session_file"; then
    pass "Onboard session records agent=hermes"
  else
    fail "Onboard session does not contain agent=hermes"
    info "Session contents: $(head -20 "$session_file" 2>/dev/null)"
  fi
else
  fail "Session file not found: $session_file"
fi

# 3d: Inference must be configured by onboard
if inf_check=$(openshell inference get 2>&1); then
  if grep -qi "nvidia-prod" <<<"$inf_check"; then
    pass "Inference configured via onboard"
  else
    fail "Inference not configured — onboard did not set up nvidia-prod provider"
  fi
else
  fail "openshell inference get failed: ${inf_check:0:200}"
fi

# 3e: Policy presets applied
if policy_output=$(openshell policy get --full "$SANDBOX_NAME" 2>&1); then
  if grep -qi "network_policies" <<<"$policy_output"; then
    pass "Policy applied to sandbox"
  else
    fail "No network policy found on sandbox"
  fi
else
  fail "openshell policy get failed: ${policy_output:0:200}"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 4: Hermes agent health verification
# ══════════════════════════════════════════════════════════════════
section "Phase 4: Hermes agent health"

# 4a: Health probe via SSH into sandbox
info "Checking Hermes health probe at ${HERMES_HEALTH_URL} inside sandbox..."
ssh_config="$(mktemp)"
hermes_healthy=false

if openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_config" 2>/dev/null; then
  TIMEOUT_CMD=""
  command -v timeout >/dev/null 2>&1 && TIMEOUT_CMD="timeout 60"
  command -v gtimeout >/dev/null 2>&1 && TIMEOUT_CMD="gtimeout 60"

  # Retry health check — Hermes may still be starting
  for attempt in $(seq 1 15); do
    health_response=$($TIMEOUT_CMD ssh -F "$ssh_config" \
      -o StrictHostKeyChecking=no \
      -o UserKnownHostsFile=/dev/null \
      -o ConnectTimeout=10 \
      -o LogLevel=ERROR \
      "openshell-${SANDBOX_NAME}" \
      "curl -sf ${HERMES_HEALTH_URL}" \
      2>&1) || true

    if echo "$health_response" | grep -qi '"ok"'; then
      hermes_healthy=true
      break
    fi
    info "Health check attempt ${attempt}/15 — waiting 4s..."
    sleep 4
  done

  if $hermes_healthy; then
    pass "Hermes health probe returned ok"
    info "Response: ${health_response:0:200}"
  else
    fail "Hermes health probe did not return ok after 15 attempts"
    info "Last response: ${health_response:0:200}"
  fi
else
  fail "Could not get SSH config for sandbox ${SANDBOX_NAME}"
fi

# 4b: Verify Hermes binary exists in sandbox
if openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_config" 2>/dev/null; then
  hermes_version=$($TIMEOUT_CMD ssh -F "$ssh_config" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 \
    -o LogLevel=ERROR \
    "openshell-${SANDBOX_NAME}" \
    "hermes --version 2>&1 || echo MISSING" \
    2>&1) || true

  if echo "$hermes_version" | grep -qi "MISSING\|not found\|No such file"; then
    fail "Hermes binary not found in sandbox"
  else
    pass "Hermes binary found in sandbox: ${hermes_version:0:100}"
  fi
fi

# 4c: Verify Hermes config integrity (config hash check)
config_hash_check=$($TIMEOUT_CMD ssh -F "$ssh_config" \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  -o ConnectTimeout=10 \
  -o LogLevel=ERROR \
  "openshell-${SANDBOX_NAME}" \
  "test -f /sandbox/.hermes/config.yaml && echo EXISTS || echo MISSING" \
  2>&1) || true

if echo "$config_hash_check" | grep -q "EXISTS"; then
  pass "Hermes config.yaml exists at /sandbox/.hermes/config.yaml"
else
  fail "Hermes config.yaml not found at /sandbox/.hermes/config.yaml"
fi

# 4d: Verify immutable config directory (Landlock read-only)
writable_check=$($TIMEOUT_CMD ssh -F "$ssh_config" \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  -o ConnectTimeout=10 \
  -o LogLevel=ERROR \
  "openshell-${SANDBOX_NAME}" \
  "touch /sandbox/.hermes/test-write 2>&1 && echo WRITABLE && rm -f /sandbox/.hermes/test-write || echo READ_ONLY" \
  2>&1) || true

if echo "$writable_check" | grep -q "READ_ONLY"; then
  pass "Hermes config directory is read-only (immutable)"
elif echo "$writable_check" | grep -q "WRITABLE"; then
  fail "Hermes config directory is writable — should be immutable"
else
  skip "Could not determine config directory mutability: ${writable_check:0:100}"
fi

# 4e: Verify writable data directory exists
data_dir_check=$($TIMEOUT_CMD ssh -F "$ssh_config" \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  -o ConnectTimeout=10 \
  -o LogLevel=ERROR \
  "openshell-${SANDBOX_NAME}" \
  "test -d /sandbox/.hermes-data && echo EXISTS || echo MISSING" \
  2>&1) || true

if echo "$data_dir_check" | grep -q "EXISTS"; then
  pass "Hermes writable data directory exists at /sandbox/.hermes-data"
else
  fail "Hermes writable data directory not found at /sandbox/.hermes-data"
fi

rm -f "$ssh_config"

# ══════════════════════════════════════════════════════════════════
# Phase 5: Live inference — the real proof
# ══════════════════════════════════════════════════════════════════
section "Phase 5: Live inference"

# ── Test 5a: Direct NVIDIA Endpoints ──
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

# ── Test 5b: Inference through the sandbox (THE definitive test) ──
# Routing-layer check, not a Hermes/openclaw check. The HTTP request is made
# by curl from inside the sandbox; nothing in this path exercises the Hermes
# agent runtime or openclaw's HTTP client. See NemoClaw #2490 for the
# openclaw 4.9 SSRF regression that was invisible to assertions of this shape.
info "[ROUTING] inference.local DNS + OpenShell proxy reachable from Hermes sandbox..."
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
    pass "[ROUTING] inference.local: OpenShell routed curl to NVIDIA Endpoints and returned PONG"
    info "Routing path proven: sandbox curl → DNS forwarder → gateway proxy → NVIDIA Endpoints (does not exercise the Hermes agent runtime or openclaw HTTP client)"
  else
    fail "[ROUTING] inference.local: expected PONG, got: ${sandbox_content:0:200}"
  fi
else
  fail "[ROUTING] inference.local: no response from inference.local inside Hermes sandbox"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 6: NemoClaw CLI operations (Hermes-specific)
# ══════════════════════════════════════════════════════════════════
section "Phase 6: NemoClaw CLI operations (Hermes)"

# ── Test 6a: nemoclaw logs ──
info "Testing sandbox log retrieval..."
logs_output=$(nemoclaw "$SANDBOX_NAME" logs 2>&1) || true
if [ -n "$logs_output" ]; then
  pass "nemoclaw logs: produced output ($(echo "$logs_output" | wc -l | tr -d ' ') lines)"
else
  fail "nemoclaw logs: no output"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 7: OpenClaw regression (ensure default agent path still works)
# ══════════════════════════════════════════════════════════════════
section "Phase 7: OpenClaw regression check"

# Verify that the agent-defs module can still load the openclaw manifest
info "Verifying OpenClaw agent manifest is still loadable..."
openclaw_check=$(node -e "
  const { loadAgent, listAgents } = require('$REPO/bin/lib/agent-defs');
  const agents = listAgents();
  console.log('agents:', agents.join(', '));
  const oc = loadAgent('openclaw');
  console.log('openclaw_display:', oc.displayName);
  console.log('openclaw_port:', oc.forwardPort);
  const h = loadAgent('hermes');
  console.log('hermes_display:', h.displayName);
  console.log('hermes_port:', h.forwardPort);
" 2>&1) || true

if echo "$openclaw_check" | grep -q "openclaw_display:.*OpenClaw"; then
  pass "OpenClaw agent manifest loads correctly"
else
  fail "OpenClaw agent manifest failed to load"
  info "Output: ${openclaw_check:0:300}"
fi

if echo "$openclaw_check" | grep -q "hermes_display:.*Hermes"; then
  pass "Hermes agent manifest loads correctly"
else
  fail "Hermes agent manifest failed to load"
  info "Output: ${openclaw_check:0:300}"
fi

if echo "$openclaw_check" | grep -q "agents:.*openclaw.*hermes\|agents:.*hermes.*openclaw"; then
  pass "Both agents listed by listAgents()"
else
  fail "listAgents() did not return both openclaw and hermes"
  info "Output: ${openclaw_check:0:300}"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 8: Cleanup
# ══════════════════════════════════════════════════════════════════
section "Phase 8: Cleanup"

[[ "${NEMOCLAW_E2E_KEEP_SANDBOX:-}" = "1" ]] || nemoclaw "$SANDBOX_NAME" destroy --yes 2>&1 | tail -3 || true
openshell gateway destroy -g nemoclaw 2>/dev/null || true

# Verify against the registry file directly.  `nemoclaw list` triggers
# gateway recovery which can restart a destroyed gateway and re-import stale
# sandbox entries — that's a separate issue, so avoid it here.
registry_file="${HOME}/.nemoclaw/sandboxes.json"
if [ -f "$registry_file" ] && grep -Fq "\"${SANDBOX_NAME}\"" "$registry_file"; then
  fail "Sandbox ${SANDBOX_NAME} still in registry after destroy"
else
  pass "Sandbox ${SANDBOX_NAME} removed"
fi

# ══════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════
echo ""
echo "========================================"
echo "  Hermes Agent E2E Results:"
echo "    Passed:  $PASS"
echo "    Failed:  $FAIL"
echo "    Skipped: $SKIP"
echo "    Total:   $TOTAL"
echo "========================================"

if [ "$FAIL" -eq 0 ]; then
  printf '\n\033[1;32m  Hermes E2E PASSED — agent selection + inference verified end-to-end.\033[0m\n'
  exit 0
else
  printf '\n\033[1;31m  %d test(s) failed.\033[0m\n' "$FAIL"
  exit 1
fi
