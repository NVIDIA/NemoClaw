#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# GPU E2E: Ollama local inference — follows the real user flow.
#
# Mirrors what a user with a GPU would actually do:
#   1. Install Ollama binary
#   2. Run the NemoClaw installer with NEMOCLAW_PROVIDER=ollama
#   3. Onboard starts Ollama (OLLAMA_HOST=0.0.0.0:11434), pulls model, creates sandbox
#   4. Verify inference works through the sandbox
#   5. Destroy + uninstall
#
# The test does NOT pre-start Ollama or pre-pull models — onboard handles that.
#
# Prerequisites:
#   - NVIDIA GPU with drivers (nvidia-smi works)
#   - Docker
#   - NEMOCLAW_NON_INTERACTIVE=1
#   - Internet access (ollama.com for install, registry.ollama.ai for model pull)
#   - No existing Ollama service on port 11434 (ephemeral runners are ideal)
#
# Environment variables:
#   NEMOCLAW_NON_INTERACTIVE=1   — required
#   NEMOCLAW_SANDBOX_NAME        — sandbox name (default: e2e-gpu-ollama)
#   NEMOCLAW_RECREATE_SANDBOX=1  — recreate sandbox if it exists
#   NEMOCLAW_MODEL               — model for onboard (default: auto-selected by onboard)
#   SKIP_UNINSTALL               — set to 1 to skip uninstall (debugging)
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 bash test/e2e/test-gpu-e2e.sh

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
parse_chat_content() {
  python3 -c "
import json, sys
try:
    r = json.load(sys.stdin)
    c = r['choices'][0]['message']
    # Reasoning models (nemotron-3-nano) may put output in 'reasoning' or
    # 'reasoning_content' instead of 'content'. Check all fields.
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

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-gpu-ollama}"
TEST_LOG="/tmp/nemoclaw-gpu-e2e-test.log"
INSTALL_LOG="/tmp/nemoclaw-gpu-e2e-install.log"

# Enforce Ollama provider — this script only tests local GPU inference.
export NEMOCLAW_PROVIDER="${NEMOCLAW_PROVIDER:-ollama}"
if [ "$NEMOCLAW_PROVIDER" != "ollama" ]; then
  echo "ERROR: NEMOCLAW_PROVIDER must be 'ollama' for GPU E2E (got: $NEMOCLAW_PROVIDER)"
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

# Verify port 11434 is free (onboard needs to start Ollama on 0.0.0.0:11434)
if curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then
  info "WARNING: Something is already listening on port 11434."
  info "Onboard may not be able to start Ollama on 0.0.0.0:11434."
  info "On ephemeral runners this should not happen."
  # Don't fail — onboard will detect the running Ollama and use it.
  # The container reachability check in onboard will catch 127.0.0.1 issues.
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
# can start Ollama with OLLAMA_HOST=0.0.0.0:11434 (required for containers).
# This needs the ollama process to be owned by our user, or systemctl access.
if curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then
  info "Ollama service is running — attempting to stop for clean onboard..."
  # Try systemctl first (works if user has permissions)
  systemctl --user stop ollama 2>/dev/null || true
  systemctl stop ollama 2>/dev/null || true
  # Try direct kill (works if process is owned by our user)
  pkill -f "ollama serve" 2>/dev/null || true
  sleep 2

  if curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then
    info "Could not stop existing Ollama — onboard will use it as-is"
  else
    pass "Existing Ollama stopped — port 11434 is free for onboard"
  fi
fi

# ══════════════════════════════════════════════════════════════════
# Phase 3: Install NemoClaw and onboard with Ollama
# ══════════════════════════════════════════════════════════════════
section "Phase 3: Install NemoClaw and onboard with Ollama"

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
# Phase 4: Verify Ollama-based onboard
# ══════════════════════════════════════════════════════════════════
section "Phase 4: Verify Ollama-based onboard"

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

# 4c: Inference provider is ollama-local
if inf_check=$(openshell inference get 2>&1); then
  if echo "$inf_check" | grep -qi "ollama"; then
    pass "Inference provider is Ollama-based"
  else
    fail "Inference provider is not ollama — got: ${inf_check:0:200}"
  fi
else
  fail "openshell inference get failed: ${inf_check:0:200}"
fi

# 4d: Ollama is running and reachable
if curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then
  pass "Ollama running on localhost:11434 (started by onboard)"
else
  fail "Ollama not running — onboard should have started it"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 5: Local inference through sandbox
# ══════════════════════════════════════════════════════════════════
section "Phase 5: Local inference through sandbox"

# Determine the model to test. Prefer NEMOCLAW_MODEL (set by workflow), then
# fall back to querying Ollama's /api/tags (handles auto-selection by onboard).
CONFIGURED_MODEL="${NEMOCLAW_MODEL:-}"
if [ -n "$CONFIGURED_MODEL" ]; then
  # Verify the expected model is actually available in Ollama
  if curl -sf http://localhost:11434/api/tags 2>/dev/null \
    | python3 -c "import json,sys; m=[x['name'] for x in json.load(sys.stdin).get('models',[])]; sys.exit(0 if '$CONFIGURED_MODEL' in m or any('$CONFIGURED_MODEL' in x for x in m) else 1)" 2>/dev/null; then
    info "Using NEMOCLAW_MODEL: $CONFIGURED_MODEL (confirmed in Ollama)"
  else
    info "NEMOCLAW_MODEL=$CONFIGURED_MODEL not found in Ollama tags — querying available models"
    CONFIGURED_MODEL=""
  fi
fi
if [ -z "$CONFIGURED_MODEL" ]; then
  CONFIGURED_MODEL=$(curl -sf http://localhost:11434/api/tags 2>/dev/null \
    | python3 -c "import json,sys; m=json.load(sys.stdin).get('models',[]); print(m[0]['name'] if m else '')" 2>/dev/null || echo "")
  if [ -n "$CONFIGURED_MODEL" ]; then
    info "Auto-detected Ollama model: $CONFIGURED_MODEL"
  else
    fail "No models found in Ollama"
  fi
fi

# 5a: Direct Ollama inference (host-side, OpenAI-compatible)
info "[LOCAL] Direct Ollama test → localhost:11434/v1/chat/completions..."
direct_response=$(curl -s --max-time 120 \
  -X POST http://localhost:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"$CONFIGURED_MODEL\",
    \"messages\": [{\"role\": \"user\", \"content\": \"Reply with exactly one word: PONG\"}],
    \"max_tokens\": 200
  }" 2>/dev/null) || true

if [ -n "$direct_response" ]; then
  direct_content=$(echo "$direct_response" | parse_chat_content 2>/dev/null) || true
  if echo "$direct_content" | grep -qi "PONG"; then
    pass "[LOCAL] Direct Ollama: model responded with PONG"
  else
    fail "[LOCAL] Direct Ollama: expected PONG, got: ${direct_content:0:200}"
  fi
else
  fail "[LOCAL] Direct Ollama: empty response"
fi

# 5b: Inference through sandbox → openshell gateway → host.openshell.internal:11434 → Ollama
info "[LOCAL] Sandbox inference test → sandbox → gateway → Ollama on GPU..."
ssh_config="$(mktemp)"
sandbox_response=""

if openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_config" 2>/dev/null; then
  TIMEOUT_CMD=""
  command -v timeout >/dev/null 2>&1 && TIMEOUT_CMD="timeout 120"
  sandbox_response=$($TIMEOUT_CMD ssh -F "$ssh_config" \
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
    pass "[LOCAL] Sandbox inference: Ollama responded through sandbox"
    info "Full path proven: sandbox → openshell gateway → host.openshell.internal:11434 → Ollama GPU"
  else
    fail "[LOCAL] Sandbox inference: expected PONG, got: ${sandbox_content:0:200}"
  fi
else
  fail "[LOCAL] Sandbox inference: no response from inference.local inside sandbox"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 6: Destroy and uninstall
# ══════════════════════════════════════════════════════════════════
section "Phase 6: Destroy and uninstall"

# 6a: Destroy sandbox
info "Destroying sandbox ${SANDBOX_NAME}..."
nemoclaw "$SANDBOX_NAME" destroy --yes 2>&1 | tail -5 || true

# Verify against the registry file directly.  `nemoclaw list` triggers
# gateway recovery which can restart a destroyed gateway and re-import stale
# sandbox entries — that's a separate issue (#TBD), so avoid it here.
registry_file="${HOME}/.nemoclaw/sandboxes.json"
if [ -f "$registry_file" ] && grep -Fq "\"${SANDBOX_NAME}\"" "$registry_file"; then
  fail "Sandbox ${SANDBOX_NAME} still in registry after destroy"
else
  pass "Sandbox ${SANDBOX_NAME} removed from registry"
fi

openshell gateway destroy -g nemoclaw 2>/dev/null || true

# 6b: Uninstall with --delete-models (Ollama-specific flag)
if [ "${SKIP_UNINSTALL:-}" = "1" ]; then
  skip "Uninstall skipped (SKIP_UNINSTALL=1)"
else
  info "Running uninstall.sh --yes --delete-models..."
  if bash "$REPO/uninstall.sh" --yes --delete-models 2>&1 | tail -20; then
    pass "uninstall.sh --delete-models completed"
  else
    fail "uninstall.sh failed"
  fi

  if [ -d "$HOME/.nemoclaw" ]; then
    fail "$HOME/.nemoclaw directory still exists after uninstall"
  else
    pass "$HOME/.nemoclaw removed"
  fi
fi

# 6c: Stop Ollama (started by onboard)
info "Stopping Ollama..."
pkill -f "ollama serve" 2>/dev/null || true
pass "Cleanup complete"

# ══════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════
echo ""
echo "========================================"
echo "  GPU E2E Results (Ollama Local Inference):"
echo "    Passed:  $PASS"
echo "    Failed:  $FAIL"
echo "    Skipped: $SKIP"
echo "    Total:   $TOTAL"
echo "========================================"
echo ""
echo "  What this tested (real user flow):"
echo "    - GPU detection (nvidia-smi)"
echo "    - Ollama binary install"
echo "    - install.sh --non-interactive with NEMOCLAW_PROVIDER=ollama"
echo "    - Onboard: starts Ollama, pulls model, creates sandbox"
echo "    - Local inference: direct + sandbox → gateway → Ollama on GPU"
echo "    - Destroy + uninstall --delete-models"
echo ""

if [ "$FAIL" -eq 0 ]; then
  printf '\n\033[1;32m  GPU E2E PASSED — Ollama local inference verified end-to-end.\033[0m\n'
  exit 0
else
  printf '\n\033[1;31m  %d test(s) failed.\033[0m\n' "$FAIL"
  exit 1
fi
