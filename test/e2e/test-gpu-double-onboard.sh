#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# GPU Double-Onboard E2E: Ollama proxy token consistency after re-onboard.
#
# Reproduces the exact scenario from issue #2553 — the Ollama proxy token
# divergence bug where re-running onboard left the proxy running with a
# different token than what was persisted to disk, causing silent HTTP 401
# on all inference.
#
# Flow:
#   1. Prerequisites — Docker, nvidia-smi, env vars
#   2. Install Ollama binary (do NOT start it — onboard handles that)
#   3. First onboard — install.sh --non-interactive with NEMOCLAW_PROVIDER=ollama
#   4. Verify sandbox, proxy, token file, inference through sandbox
#   5. Second onboard (re-onboard) — nemoclaw onboard --non-interactive --yes
#   6. Token consistency verification (the core of this test):
#        - Read ~/.nemoclaw/ollama-proxy-token
#        - Verify proxy accepts that token (not 401)
#        - Verify inference through sandbox succeeds (not 401)
#   7. Destroy and cleanup
#
# Key differences from test-gpu-e2e.sh:
#   - Adds a second onboard + token consistency check
#   - Uses nemoclaw onboard CLI directly for re-onboard (not install.sh)
#   - Distinct sandbox name e2e-gpu-double-onboard
#
# Key differences from test-double-onboard.sh:
#   - Uses NEMOCLAW_PROVIDER=ollama (real GPU inference)
#   - Tests token consistency explicitly
#   - Runs on NVKS ephemeral GPU runner (L40G)
#
# Prerequisites:
#   - NVIDIA GPU with drivers (nvidia-smi works)
#   - Docker
#   - NEMOCLAW_NON_INTERACTIVE=1
#   - NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1
#   - Internet access (ollama.com for install, registry.ollama.ai for model pull)
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
#     bash test/e2e/test-gpu-double-onboard.sh

# ShellCheck cannot see EXIT trap invocations of cleanup helpers in this E2E script.
# shellcheck disable=SC2317
set -uo pipefail

export NEMOCLAW_E2E_DEFAULT_TIMEOUT=1800
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=test/e2e/e2e-timeout.sh
source "${SCRIPT_DIR}/e2e-timeout.sh"

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
# shellcheck disable=SC2329
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
parse_chat_content() {
  python3 -c "
import json, sys
try:
    r = json.load(sys.stdin)
    c = r['choices'][0]['message']
    content = c.get('content') or c.get('reasoning_content') or c.get('reasoning') or ''
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

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-gpu-double-onboard}"
TEST_LOG="/tmp/nemoclaw-gpu-double-onboard-test.log"
INSTALL_LOG="/tmp/nemoclaw-gpu-double-onboard-install.log"
REONBOARD_LOG="/tmp/nemoclaw-gpu-double-onboard-reonboard.log"
PROXY_PORT="${NEMOCLAW_OLLAMA_PROXY_PORT:-11435}"
TOKEN_FILE="$HOME/.nemoclaw/ollama-proxy-token"

# Enforce Ollama provider — this script only tests local GPU inference.
export NEMOCLAW_PROVIDER="${NEMOCLAW_PROVIDER:-ollama}"
if [ "$NEMOCLAW_PROVIDER" != "ollama" ]; then
  echo "ERROR: NEMOCLAW_PROVIDER must be 'ollama' for GPU double-onboard E2E (got: $NEMOCLAW_PROVIDER)"
  exit 1
fi

exec > >(tee -a "$TEST_LOG") 2>&1

# Best-effort cleanup on any exit (prevents dirty state on reused runners)
# shellcheck disable=SC2329 # invoked via trap
cleanup() {
  info "Running exit cleanup..."
  if command -v nemoclaw >/dev/null 2>&1; then
    nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true
  fi
  if command -v openshell >/dev/null 2>&1; then
    openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true
    openshell gateway destroy -g nemoclaw 2>/dev/null || true
  fi
  pkill -f "ollama serve" 2>/dev/null || true
  pkill -f "ollama-auth-proxy" 2>/dev/null || true
}
trap cleanup EXIT

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
pkill -f "ollama serve" 2>/dev/null || true
pkill -f "ollama-auth-proxy" 2>/dev/null || true
sleep 2
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

if nvidia-smi >/dev/null 2>&1; then
  VRAM_MB=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1)
  pass "nvidia-smi works (GPU VRAM: ${VRAM_MB:-unknown} MB)"
else
  fail "nvidia-smi failed — no NVIDIA GPU available"
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

# ══════════════════════════════════════════════════════════════════
# Phase 2: Install Ollama binary
# ══════════════════════════════════════════════════════════════════
section "Phase 2: Install Ollama binary"

# Only install the binary — do NOT start Ollama or pull models.
# The nemoclaw onboard flow handles startup and model pull itself.
if command -v ollama >/dev/null 2>&1; then
  pass "Ollama already installed: $(ollama --version 2>/dev/null || echo unknown)"
else
  info "Installing Ollama..."
  if curl -fsSL https://ollama.com/install.sh | sh 2>&1; then
    pass "Ollama installed: $(ollama --version 2>/dev/null || echo unknown)"
  else
    fail "Ollama installation failed"
    exit 1
  fi
fi

# If the Ollama installer started a system service, stop it so onboard
# can restart Ollama on loopback and expose only the authenticated proxy to containers.
if curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  info "Ollama service is running — attempting to stop for clean onboard..."
  systemctl --user stop ollama 2>/dev/null || true
  systemctl stop ollama 2>/dev/null || true
  pkill -f "ollama serve" 2>/dev/null || true
  sleep 2

  if curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    info "Could not stop existing Ollama — onboard will use it as-is"
  else
    pass "Existing Ollama stopped — port 11434 is free for onboard"
  fi
fi

# ══════════════════════════════════════════════════════════════════
# Phase 3: First onboard — install.sh --non-interactive
# ══════════════════════════════════════════════════════════════════
section "Phase 3: First onboard (install.sh --non-interactive)"

cd "$REPO" || {
  fail "Could not cd to repo root: $REPO"
  exit 1
}

info "Running install.sh --non-interactive with NEMOCLAW_PROVIDER=ollama..."
info "Onboard will start Ollama, pull the model, and create the sandbox."

bash install.sh --non-interactive >"$INSTALL_LOG" 2>&1 &
install_pid=$!
tail -f "$INSTALL_LOG" --pid=$install_pid 2>/dev/null &
tail_pid=$!
wait $install_pid
install_exit=$?
kill $tail_pid 2>/dev/null || true
wait $tail_pid 2>/dev/null || true

# Source shell profile to pick up nvm/PATH changes
if [ -f "$HOME/.bashrc" ]; then
  source "$HOME/.bashrc" 2>/dev/null || true
fi
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
if [ -d "$HOME/.local/bin" ] && [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  export PATH="$HOME/.local/bin:$PATH"
fi

if [ $install_exit -eq 0 ]; then
  pass "install.sh completed (exit 0)"
else
  fail "install.sh failed (exit $install_exit)"
  info "Last 30 lines of install log:"
  tail -30 "$INSTALL_LOG"
  exit 1
fi

if command -v nemoclaw >/dev/null 2>&1; then
  pass "nemoclaw on PATH: $(command -v nemoclaw)"
else
  fail "nemoclaw not found on PATH after install"
  exit 1
fi

# ══════════════════════════════════════════════════════════════════
# Phase 4: Verify first onboard
# ══════════════════════════════════════════════════════════════════
section "Phase 4: Verify first onboard"

# 4a: Sandbox exists
if list_output=$(nemoclaw list 2>&1); then
  if echo "$list_output" | grep -Fq -- "$SANDBOX_NAME"; then
    pass "nemoclaw list contains '${SANDBOX_NAME}'"
  else
    fail "nemoclaw list does not contain '${SANDBOX_NAME}'"
  fi
else
  fail "nemoclaw list failed: ${list_output:0:200}"
fi

# 4b: Status ok
if nemoclaw "$SANDBOX_NAME" status >/dev/null 2>&1; then
  pass "nemoclaw ${SANDBOX_NAME} status exits 0"
else
  fail "nemoclaw ${SANDBOX_NAME} status failed"
fi

# 4c: Ollama is running and reachable
if curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  pass "Ollama running on 127.0.0.1:11434"
else
  fail "Ollama not running — onboard should have started it"
fi

# 4d: Auth proxy is running
if curl -sf --connect-timeout 3 "http://127.0.0.1:${PROXY_PORT}/api/tags" >/dev/null 2>&1; then
  pass "Auth proxy running on :${PROXY_PORT}"
else
  fail "Auth proxy not running on :${PROXY_PORT}"
fi

# 4e: Token file exists with correct permissions
if [ -f "$TOKEN_FILE" ]; then
  pass "Proxy token persisted at $TOKEN_FILE"
  PERMS=$(stat -c "%a" "$TOKEN_FILE" 2>/dev/null || stat -f "%Lp" "$TOKEN_FILE" 2>/dev/null)
  if [ "$PERMS" = "600" ]; then
    pass "Token file permissions: 600"
  else
    fail "Token file permissions: expected 600, got $PERMS"
  fi
else
  fail "Proxy token file missing after first onboard"
fi

# 4f: Record the first-onboard token for later comparison
TOKEN_AFTER_FIRST=""
if [ -f "$TOKEN_FILE" ]; then
  TOKEN_AFTER_FIRST=$(tr -d '[:space:]' <"$TOKEN_FILE")
  info "Token after first onboard: ${TOKEN_AFTER_FIRST:0:8}..."
fi

# 4g: Verify proxy accepts first-onboard token
if [ -n "$TOKEN_AFTER_FIRST" ]; then
  FIRST_AUTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $TOKEN_AFTER_FIRST" \
    "http://127.0.0.1:${PROXY_PORT}/v1/models" 2>/dev/null) || FIRST_AUTH_STATUS="000"
  if [ "$FIRST_AUTH_STATUS" = "200" ]; then
    pass "Proxy accepts first-onboard token (200)"
  else
    fail "Proxy rejects first-onboard token (status: $FIRST_AUTH_STATUS)"
  fi
fi

# 4h: Determine model for inference tests
CONFIGURED_MODEL="${NEMOCLAW_MODEL:-}"
if [ -z "$CONFIGURED_MODEL" ]; then
  CONFIGURED_MODEL=$(curl -sf http://127.0.0.1:11434/api/tags 2>/dev/null \
    | python3 -c "import json,sys; m=json.load(sys.stdin).get('models',[]); print(m[0]['name'] if m else '')" 2>/dev/null || echo "")
fi
if [ -n "$CONFIGURED_MODEL" ]; then
  info "Model for inference tests: $CONFIGURED_MODEL"
else
  fail "No models found in Ollama"
fi

# 4i: First-onboard inference through sandbox
info "Testing inference through sandbox after first onboard..."
ssh_config="$(mktemp)"
sandbox_response=""

if openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_config" 2>/dev/null; then
  sandbox_response=$(run_with_timeout 120 ssh -F "$ssh_config" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 \
    -o LogLevel=ERROR \
    "openshell-${SANDBOX_NAME}" \
    "curl -s --max-time 90 https://inference.local/v1/chat/completions \
      -H 'Content-Type: application/json' \
      -d '{\"model\":\"$CONFIGURED_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly one word: PONG\"}],\"max_tokens\":200}'" \
    2>&1) || true
else
  fail "openshell sandbox ssh-config failed"
fi
rm -f "$ssh_config"

if [ -n "$sandbox_response" ]; then
  sandbox_content=$(echo "$sandbox_response" | parse_chat_content 2>/dev/null) || true
  if echo "$sandbox_content" | grep -qi "PONG"; then
    pass "First-onboard sandbox inference succeeded"
  else
    fail "First-onboard sandbox inference: expected PONG, got: ${sandbox_content:0:200}"
  fi
else
  fail "First-onboard sandbox inference: no response"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 5: Second onboard (re-onboard)
# ══════════════════════════════════════════════════════════════════
section "Phase 5: Second onboard (re-onboard via nemoclaw onboard)"

info "Running nemoclaw onboard --non-interactive --yes with NEMOCLAW_RECREATE_SANDBOX=1..."
info "This exercises the exact code path from issue #2553:"
info "  startOllamaAuthProxy() → killStaleProxy() → token generation → persistProxyToken()"

export NEMOCLAW_RECREATE_SANDBOX=1
nemoclaw onboard --non-interactive --yes >"$REONBOARD_LOG" 2>&1 &
reonboard_pid=$!
tail -f "$REONBOARD_LOG" --pid=$reonboard_pid 2>/dev/null &
tail_pid=$!
wait $reonboard_pid
reonboard_exit=$?
kill $tail_pid 2>/dev/null || true
wait $tail_pid 2>/dev/null || true

if [ $reonboard_exit -eq 0 ]; then
  pass "Re-onboard completed (exit 0)"
else
  fail "Re-onboard failed (exit $reonboard_exit)"
  info "Last 30 lines of re-onboard log:"
  tail -30 "$REONBOARD_LOG"
  exit 1
fi

# ══════════════════════════════════════════════════════════════════
# Phase 6: Token consistency verification (core of this test)
# ══════════════════════════════════════════════════════════════════
section "Phase 6: Token consistency verification (#2553 regression check)"

info "This is the exact check that would have caught the token divergence bug."
info "After re-onboard, the token on disk MUST match what the running proxy accepts."

# 6a: Token file still exists
if [ -f "$TOKEN_FILE" ]; then
  pass "Proxy token file exists after re-onboard"
else
  fail "Proxy token file missing after re-onboard"
  exit 1
fi

# 6b: Read the post-re-onboard token
TOKEN_AFTER_SECOND=$(tr -d '[:space:]' <"$TOKEN_FILE")
info "Token after re-onboard: ${TOKEN_AFTER_SECOND:0:8}..."

# 6c: Token file permissions preserved
PERMS=$(stat -c "%a" "$TOKEN_FILE" 2>/dev/null || stat -f "%Lp" "$TOKEN_FILE" 2>/dev/null)
if [ "$PERMS" = "600" ]; then
  pass "Token file permissions preserved: 600"
else
  fail "Token file permissions: expected 600, got $PERMS"
fi

# 6d: Auth proxy is running after re-onboard
if curl -sf --connect-timeout 3 "http://127.0.0.1:${PROXY_PORT}/api/tags" >/dev/null 2>&1; then
  pass "Auth proxy running on :${PROXY_PORT} after re-onboard"
else
  fail "Auth proxy not running after re-onboard"
fi

# 6e: THE CRITICAL CHECK — proxy accepts the persisted token (not 401)
# This is the exact failure mode from #2553: the proxy was running with
# a NEW token in memory, but the OLD token was persisted to disk.
TOKEN_AUTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $TOKEN_AFTER_SECOND" \
  "http://127.0.0.1:${PROXY_PORT}/v1/models" 2>/dev/null) || TOKEN_AUTH_STATUS="000"
if [ "$TOKEN_AUTH_STATUS" = "200" ]; then
  pass "Proxy accepts persisted token after re-onboard (200 — not 401)"
else
  fail "PROXY TOKEN DIVERGENCE DETECTED (#2553 regression)"
  fail "Token on disk does not match running proxy (status: $TOKEN_AUTH_STATUS)"
  info "This is the exact bug from #2553 — the proxy has a different token than what's on disk."
fi

# 6f: Proxy rejects unauthenticated requests (sanity check)
UNAUTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  "http://127.0.0.1:${PROXY_PORT}/api/generate" -d '{}' 2>/dev/null) || UNAUTH_STATUS="000"
if [ "$UNAUTH_STATUS" = "401" ]; then
  pass "Proxy rejects unauthenticated POST after re-onboard (401)"
else
  fail "Proxy should reject unauthenticated POST, got $UNAUTH_STATUS"
fi

# 6g: Proxy rejects a wrong token (sanity check)
WRONG_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer wrong-token-$(date +%s)" \
  -X POST "http://127.0.0.1:${PROXY_PORT}/api/generate" -d '{}' 2>/dev/null) || WRONG_STATUS="000"
if [ "$WRONG_STATUS" = "401" ]; then
  pass "Proxy rejects wrong token after re-onboard (401)"
else
  fail "Proxy should reject wrong token, got $WRONG_STATUS"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 7: Inference through sandbox after re-onboard
# ══════════════════════════════════════════════════════════════════
section "Phase 7: Inference through sandbox after re-onboard"

info "Verifying end-to-end inference still works after re-onboard..."
info "Path: sandbox → openshell gateway → auth proxy (:${PROXY_PORT}) → Ollama GPU (:11434)"

ssh_config="$(mktemp)"
sandbox_response=""

if openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_config" 2>/dev/null; then
  sandbox_response=$(run_with_timeout 120 ssh -F "$ssh_config" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 \
    -o LogLevel=ERROR \
    "openshell-${SANDBOX_NAME}" \
    "curl -s --max-time 90 https://inference.local/v1/chat/completions \
      -H 'Content-Type: application/json' \
      -d '{\"model\":\"$CONFIGURED_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly one word: PONG\"}],\"max_tokens\":200}'" \
    2>&1) || true
else
  fail "openshell sandbox ssh-config failed after re-onboard"
fi
rm -f "$ssh_config"

if [ -n "$sandbox_response" ]; then
  sandbox_content=$(echo "$sandbox_response" | parse_chat_content 2>/dev/null) || true
  if echo "$sandbox_content" | grep -qi "PONG"; then
    pass "Sandbox inference after re-onboard succeeded"
    info "Full path proven: sandbox → gateway → auth proxy (:${PROXY_PORT}) → Ollama GPU (:11434)"
  else
    # Check if the failure is specifically a 401 (token divergence)
    if echo "$sandbox_response" | grep -q "401"; then
      fail "SANDBOX INFERENCE RETURNED 401 — token divergence (#2553 regression)"
    else
      fail "Sandbox inference after re-onboard: expected PONG, got: ${sandbox_content:0:200}"
    fi
  fi
else
  fail "Sandbox inference after re-onboard: no response"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 8: Destroy and cleanup
# ══════════════════════════════════════════════════════════════════
section "Phase 8: Destroy and cleanup"

info "Destroying sandbox ${SANDBOX_NAME}..."
nemoclaw "$SANDBOX_NAME" destroy --yes 2>&1 | tail -5 || true

# Verify against the registry file directly (see test-gpu-e2e.sh comment).
registry_file="${HOME}/.nemoclaw/sandboxes.json"
if [ -f "$registry_file" ] && grep -Fq "\"${SANDBOX_NAME}\"" "$registry_file"; then
  fail "Sandbox ${SANDBOX_NAME} still in registry after destroy"
else
  pass "Sandbox ${SANDBOX_NAME} removed from registry"
fi

openshell gateway destroy -g nemoclaw 2>/dev/null || true

info "Stopping Ollama..."
pkill -f "ollama serve" 2>/dev/null || true
pkill -f "ollama-auth-proxy" 2>/dev/null || true
pass "Cleanup complete"

# ══════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════
echo ""
echo "========================================"
echo "  GPU Double-Onboard E2E Results (Ollama Token Consistency):"
echo "    Passed:  $PASS"
echo "    Failed:  $FAIL"
echo "    Skipped: $SKIP"
echo "    Total:   $TOTAL"
echo "========================================"
echo ""
echo "  What this tested (issue #2553 regression):"
echo "    - GPU detection (nvidia-smi)"
echo "    - Ollama binary install"
echo "    - First onboard: install.sh → Ollama + auth proxy + sandbox + inference"
echo "    - Second onboard (re-onboard): nemoclaw onboard --non-interactive --yes"
echo "    - TOKEN CONSISTENCY: persisted token matches running proxy after re-onboard"
echo "    - Proxy auth enforcement: accept correct token, reject unauth + wrong token"
echo "    - End-to-end inference through sandbox after re-onboard"
echo "    - Destroy + cleanup"
echo ""

if [ "$FAIL" -eq 0 ]; then
  printf '\n\033[1;32m  GPU DOUBLE-ONBOARD E2E PASSED — Ollama proxy token consistency verified.\033[0m\n'
  exit 0
else
  printf '\n\033[1;31m  %d test(s) failed.\033[0m\n' "$FAIL"
  exit 1
fi
