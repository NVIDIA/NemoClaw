#!/bin/bash
# Full E2E: install → onboard → verify inference (REAL services, no mocks)
#
# Proves the COMPLETE user journey including real inference against
# the NVIDIA Cloud API. Sends prompts through the sandbox and verifies
# that responses come back from the model.
#
# Prerequisites:
#   - Docker running
#   - NVIDIA_API_KEY set (real key, starts with nvapi-)
#   - openshell CLI installed
#   - Network access to integrate.api.nvidia.com
#
# Usage:
#   bash test/e2e/test-full-e2e.sh
#
# See: https://github.com/NVIDIA/NemoClaw/issues/71

set -uo pipefail

PASS=0
FAIL=0
SKIP=0
TOTAL=0

pass() { ((PASS++)); ((TOTAL++)); printf '\033[32m  PASS: %s\033[0m\n' "$1"; }
fail() { ((FAIL++)); ((TOTAL++)); printf '\033[31m  FAIL: %s\033[0m\n' "$1"; }
skip() { ((SKIP++)); ((TOTAL++)); printf '\033[33m  SKIP: %s\033[0m\n' "$1"; }
section() { echo ""; printf '\033[1;36m=== %s ===\033[0m\n' "$1"; }
info()  { printf '\033[1;34m  [info]\033[0m %s\n' "$1"; }

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

SANDBOX_NAME="e2e-full"

# ══════════════════════════════════════════════════════════════════
# Phase 0: Pre-cleanup
# ══════════════════════════════════════════════════════════════════
section "Phase 0: Pre-cleanup"
info "Destroying any leftover sandbox/gateway from previous runs..."
if command -v nemoclaw > /dev/null 2>&1; then
  nemoclaw "$SANDBOX_NAME" destroy 2>/dev/null || true
fi
openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true
openshell gateway destroy -g nemoclaw 2>/dev/null || true
pass "Pre-cleanup complete"

# ══════════════════════════════════════════════════════════════════
# Phase 1: Prerequisites
# ══════════════════════════════════════════════════════════════════
section "Phase 1: Prerequisites"

if docker info > /dev/null 2>&1; then
  pass "Docker is running"
else
  fail "Docker is not running — cannot continue"
  exit 1
fi

if command -v openshell > /dev/null 2>&1; then
  pass "openshell CLI installed ($(openshell --version 2>&1 || echo unknown))"
else
  fail "openshell CLI not found — cannot continue"
  exit 1
fi

if [ -n "${NVIDIA_API_KEY:-}" ] && [[ "${NVIDIA_API_KEY}" == nvapi-* ]]; then
  pass "NVIDIA_API_KEY is set (starts with nvapi-)"
else
  fail "NVIDIA_API_KEY not set or invalid — required for live inference"
  exit 1
fi

if curl -sf --max-time 10 https://integrate.api.nvidia.com/v1/models > /dev/null 2>&1; then
  pass "Network access to integrate.api.nvidia.com"
else
  fail "Cannot reach integrate.api.nvidia.com"
  exit 1
fi

# ══════════════════════════════════════════════════════════════════
# Phase 2: Install
# ══════════════════════════════════════════════════════════════════
section "Phase 2: Install nemoclaw"

cd "$REPO"

# Install from source (same as install.sh's install_nemoclaw does in a repo dir)
if [ -f "./package.json" ] && grep -q '"name": "nemoclaw"' ./package.json 2>/dev/null; then
  info "Installing nemoclaw from source (npm install + npm link)..."
  npm install 2>&1 | tail -3
  npm link 2>&1 | tail -3
else
  info "Installing nemoclaw globally..."
  npm install -g nemoclaw 2>&1 | tail -3
fi

# Source bashrc in case nvm/asdf modified it
if [ -f "$HOME/.bashrc" ]; then
  source "$HOME/.bashrc" 2>/dev/null || true
fi

if command -v nemoclaw > /dev/null 2>&1; then
  pass "nemoclaw installed at $(command -v nemoclaw)"
else
  fail "nemoclaw not found on PATH after install"
  exit 1
fi

nemoclaw --help > /dev/null 2>&1 \
  && pass "nemoclaw --help exits 0" \
  || fail "nemoclaw --help failed"

# ══════════════════════════════════════════════════════════════════
# Phase 3: Onboard (real openshell, real gateway, real sandbox)
# ══════════════════════════════════════════════════════════════════
section "Phase 3: Onboard"

# Non-interactive onboard piped inputs:
#   1. Sandbox name: "e2e-full"
#   2. Inference choice: "" (empty = default = NVIDIA Cloud API)
#   3. Policy presets: "Y" (apply suggested)
# ensureApiKey() does NOT prompt when NVIDIA_API_KEY is in env.
info "Running nemoclaw onboard (non-interactive)..."
info "This may take several minutes on first run (builds sandbox image)..."
# Write to a file instead of $(…) because openshell's background port-forward
# inherits the pipe's file descriptors, which prevents $(…) from returning.
ONBOARD_LOG="$(mktemp)"
printf "${SANDBOX_NAME}\n\nY\n" | nemoclaw onboard > "$ONBOARD_LOG" 2>&1
onboard_exit=$?
onboard_output="$(cat "$ONBOARD_LOG")"
rm -f "$ONBOARD_LOG"

if [ $onboard_exit -eq 0 ]; then
  pass "nemoclaw onboard completed (exit 0)"
else
  fail "nemoclaw onboard failed (exit $onboard_exit)"
  echo "$onboard_output" | tail -30
fi

echo "$onboard_output" | grep -qi "Sandbox.*${SANDBOX_NAME}.*created\|Sandbox '${SANDBOX_NAME}' created" \
  && pass "Onboard: sandbox '${SANDBOX_NAME}' created" \
  || fail "Onboard: sandbox creation not confirmed in output"

echo "$onboard_output" | grep -qi "nvidia-nim\|NVIDIA Cloud API" \
  && pass "Onboard: NVIDIA Cloud API selected" \
  || fail "Onboard: cloud API not selected"

# ══════════════════════════════════════════════════════════════════
# Phase 4: Sandbox verification + inference setup
# ══════════════════════════════════════════════════════════════════
section "Phase 4: Sandbox verification"

list_output=$(nemoclaw list 2>&1)
echo "$list_output" | grep -q "$SANDBOX_NAME" \
  && pass "nemoclaw list contains '${SANDBOX_NAME}'" \
  || fail "nemoclaw list does not contain '${SANDBOX_NAME}'"

status_output=$(nemoclaw "$SANDBOX_NAME" status 2>&1)
[ $? -eq 0 ] \
  && pass "nemoclaw ${SANDBOX_NAME} status exits 0" \
  || fail "nemoclaw ${SANDBOX_NAME} status failed"

# Ensure inference is configured (onboard's openshell inference set may have
# failed due to --no-verify flag incompatibility — configure it directly)
inf_check=$(openshell inference get 2>&1)
if echo "$inf_check" | grep -qi "nvidia-nim"; then
  pass "Inference already configured via onboard"
else
  info "Inference not configured by onboard — setting it directly..."
  openshell provider create --name nvidia-nim --type openai \
    --credential "NVIDIA_API_KEY=$NVIDIA_API_KEY" \
    --config "OPENAI_BASE_URL=https://integrate.api.nvidia.com/v1" 2>&1 || true
  openshell inference set --provider nvidia-nim --model nvidia/nemotron-3-super-120b-a12b 2>&1
  inf_verify=$(openshell inference get 2>&1)
  echo "$inf_verify" | grep -qi "nvidia-nim" \
    && pass "Inference configured (direct setup)" \
    || fail "Failed to configure inference"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 5: Live inference — the real proof
# ══════════════════════════════════════════════════════════════════
section "Phase 5: Live inference"

# ── Test 5a: Direct NVIDIA Cloud API ──
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
  if echo "$api_content" | grep -qi "PONG"; then
    pass "[LIVE] Direct API: model responded with PONG"
  else
    fail "[LIVE] Direct API: expected PONG, got: ${api_content:0:200}"
  fi
else
  fail "[LIVE] Direct API: empty response from curl"
fi

# ── Test 5b: Inference through the sandbox (THE definitive test) ──
info "[LIVE] Sandbox inference test → user → sandbox → gateway → NVIDIA API..."
ssh_config="$(mktemp)"
sandbox_response=""

if openshell sandbox ssh-config "$SANDBOX_NAME" > "$ssh_config" 2>/dev/null; then
  # Use timeout if available (Linux, Homebrew), fall back to plain ssh
  TIMEOUT_CMD=""
  command -v timeout > /dev/null 2>&1 && TIMEOUT_CMD="timeout 90"
  command -v gtimeout > /dev/null 2>&1 && TIMEOUT_CMD="gtimeout 90"
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
  if echo "$sandbox_content" | grep -qi "PONG"; then
    pass "[LIVE] Sandbox inference: model responded with PONG through sandbox"
    info "Full path proven: user → sandbox → openshell gateway → NVIDIA Cloud API → response"
  else
    fail "[LIVE] Sandbox inference: expected PONG, got: ${sandbox_content:0:200}"
  fi
else
  fail "[LIVE] Sandbox inference: no response from inference.local inside sandbox"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 6: Cleanup
# ══════════════════════════════════════════════════════════════════
section "Phase 6: Cleanup"

nemoclaw "$SANDBOX_NAME" destroy 2>&1 | tail -3 || true
openshell gateway destroy -g nemoclaw 2>/dev/null || true

list_after=$(nemoclaw list 2>&1)
echo "$list_after" | grep -q "$SANDBOX_NAME" \
  && fail "Sandbox ${SANDBOX_NAME} still in list after destroy" \
  || pass "Sandbox ${SANDBOX_NAME} removed"

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
