#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Sandbox survival across gateway restart (REAL inference, no mocks):
#   - prove sandbox pods survive gateway stop/start (laptop close/open)
#   - prove workspace files persist across the restart cycle
#   - prove SSH connectivity resumes without re-onboarding
#   - prove LIVE inference through NVIDIA Endpoints works after gateway resume
#
# Requires OpenShell >= 0.0.22 (deterministic node name + workspace PVC).
#
# Prerequisites:
#   - Docker running
#   - openshell >= 0.0.22 installed
#   - NVIDIA_API_KEY set (real key, starts with nvapi-)
#   - Network access to integrate.api.nvidia.com
#
# Environment variables:
#   NEMOCLAW_NON_INTERACTIVE=1   — required
#   NVIDIA_API_KEY               — required for real NVIDIA Endpoints inference
#   NEMOCLAW_SANDBOX_NAME        — sandbox name (default: e2e-survival)
#   NEMOCLAW_E2E_TIMEOUT_SECONDS — overall timeout (default: 900)
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 NVIDIA_API_KEY=nvapi-... bash test/e2e/test-sandbox-survival.sh

set -uo pipefail

if [ -z "${NEMOCLAW_E2E_NO_TIMEOUT:-}" ]; then
  export NEMOCLAW_E2E_NO_TIMEOUT=1
  TIMEOUT_SECONDS="${NEMOCLAW_E2E_TIMEOUT_SECONDS:-900}"
  if command -v timeout >/dev/null 2>&1; then
    exec timeout -s TERM "$TIMEOUT_SECONDS" bash "$0" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    exec gtimeout -s TERM "$TIMEOUT_SECONDS" bash "$0" "$@"
  fi
fi

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

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-survival}"
REGISTRY="$HOME/.nemoclaw/sandboxes.json"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MIN_OPENSHELL="0.0.22"
MODEL="nvidia/nemotron-3-super-120b-a12b"

# Resolve nemoclaw command — prefer local repo checkout over PATH
if command -v node >/dev/null 2>&1 && [ -f "$REPO_ROOT/bin/nemoclaw.js" ]; then
  NEMOCLAW_CMD=(node "$REPO_ROOT/bin/nemoclaw.js")
else
  NEMOCLAW_CMD=(nemoclaw)
fi

run_nemoclaw() { "${NEMOCLAW_CMD[@]}" "$@"; }

registry_has() {
  local name="$1"
  [ -f "$REGISTRY" ] && python3 - "$REGISTRY" "$name" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as fh:
    sandboxes = json.load(fh).get("sandboxes", [])
sys.exit(0 if any(sb.get("name") == sys.argv[2] for sb in sandboxes) else 1)
PY
}

# Compare semver: returns 0 if $1 >= $2
version_gte() {
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]
}

# ══════════════════════════════════════════════════════════════════
# Phase 0: Prerequisites
# ══════════════════════════════════════════════════════════════════
section "Phase 0: Prerequisites"

if docker info >/dev/null 2>&1; then
  pass "Docker is running"
else
  fail "Docker is not running — cannot continue"
  exit 1
fi

if ! command -v openshell >/dev/null 2>&1; then
  fail "openshell not found on PATH"
  exit 1
fi

OPENSHELL_VERSION=$(openshell --version 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
if version_gte "$OPENSHELL_VERSION" "$MIN_OPENSHELL"; then
  pass "openshell $OPENSHELL_VERSION >= $MIN_OPENSHELL (gateway resume + workspace PVC)"
else
  fail "openshell $OPENSHELL_VERSION < $MIN_OPENSHELL — sandbox survival requires v0.0.22+"
  info "Install latest: curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | OPENSHELL_VERSION=v0.0.22 sh"
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
# Phase 1: Pre-cleanup
# ══════════════════════════════════════════════════════════════════
section "Phase 1: Pre-cleanup"

info "Destroying any leftover sandbox/gateway from previous runs..."
run_nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true
openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true
openshell gateway destroy -g nemoclaw 2>/dev/null || true
rm -f "$HOME/.nemoclaw/onboard.lock" 2>/dev/null || true
pass "Pre-cleanup complete"

# ══════════════════════════════════════════════════════════════════
# Phase 2: Onboard sandbox with real NVIDIA inference
# ══════════════════════════════════════════════════════════════════
section "Phase 2: Onboard sandbox (NVIDIA Endpoints)"

info "Running nemoclaw onboard with real NVIDIA inference..."
info "Model: $MODEL"

ONBOARD_LOG="$(mktemp)"
# Stream output in real-time (avoid buffering that hides progress/hangs).
# Use tail --pid to auto-stop when onboard exits.
env \
  NEMOCLAW_NON_INTERACTIVE=1 \
  NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME" \
  NEMOCLAW_RECREATE_SANDBOX=1 \
  "${NEMOCLAW_CMD[@]}" onboard --non-interactive >"$ONBOARD_LOG" 2>&1 &
onboard_pid=$!
tail -f "$ONBOARD_LOG" --pid=$onboard_pid 2>/dev/null &
tail_pid=$!
wait $onboard_pid
onboard_exit=$?
kill $tail_pid 2>/dev/null || true
wait $tail_pid 2>/dev/null || true
rm -f "$ONBOARD_LOG"

if [ $onboard_exit -eq 0 ]; then
  pass "Onboard completed successfully"
else
  fail "Onboard failed (exit $onboard_exit)"
  exit 1
fi

if registry_has "$SANDBOX_NAME"; then
  pass "Sandbox '$SANDBOX_NAME' registered"
else
  fail "Sandbox '$SANDBOX_NAME' not found in registry"
  exit 1
fi

# ══════════════════════════════════════════════════════════════════
# Phase 3: Prove live inference works BEFORE restart (baseline)
# ══════════════════════════════════════════════════════════════════
section "Phase 3: Baseline — live inference before restart"

ssh_config="$(mktemp)"
if openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_config" 2>/dev/null; then
  pass "Got SSH config for sandbox"
else
  fail "Could not get SSH config"
  rm -f "$ssh_config"
  exit 1
fi

SSH_OPTS=(-F "$ssh_config" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -o LogLevel=ERROR)
SSH_TARGET="openshell-${SANDBOX_NAME}"

# Use timeout if available
TIMEOUT_CMD=""
command -v timeout >/dev/null 2>&1 && TIMEOUT_CMD="timeout 90"
command -v gtimeout >/dev/null 2>&1 && TIMEOUT_CMD="gtimeout 90"

info "[LIVE] Baseline inference: user → sandbox → gateway → NVIDIA Endpoints..."
baseline_response=$($TIMEOUT_CMD ssh "${SSH_OPTS[@]}" "$SSH_TARGET" \
  "curl -s --max-time 60 https://inference.local/v1/chat/completions \
    -H 'Content-Type: application/json' \
    -d '{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly one word: PONG\"}],\"max_tokens\":100}'" \
  2>&1) || true

baseline_content=""
if [ -n "$baseline_response" ]; then
  baseline_content=$(echo "$baseline_response" | parse_chat_content 2>/dev/null) || true
fi

if grep -qi "PONG" <<<"$baseline_content"; then
  pass "[LIVE] Baseline: model responded with PONG through sandbox"
else
  fail "[LIVE] Baseline: expected PONG, got: ${baseline_content:0:200}"
  info "Raw response: ${baseline_response:0:300}"
  info "Cannot establish baseline — aborting (survival test meaningless without it)"
  rm -f "$ssh_config"
  exit 1
fi

# ══════════════════════════════════════════════════════════════════
# Phase 4: Plant marker file inside sandbox
# ══════════════════════════════════════════════════════════════════
section "Phase 4: Plant marker file in sandbox workspace"

MARKER_VALUE="nemoclaw-survival-$(date +%s)"

# Write a marker file into /sandbox (the persistent workspace mount)
# shellcheck disable=SC2029  # client-side expansion is intentional
if ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "echo ${MARKER_VALUE} > /sandbox/.survival-marker" 2>/dev/null; then
  pass "Planted marker file: /sandbox/.survival-marker = $MARKER_VALUE"
else
  fail "Could not plant marker file inside sandbox"
  rm -f "$ssh_config"
  exit 1
fi

# Verify the marker is readable before we restart
readback=$(ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "cat /sandbox/.survival-marker" 2>/dev/null)
if [ "$readback" = "$MARKER_VALUE" ]; then
  pass "Marker file read-back verified before restart"
else
  fail "Marker file read-back mismatch: expected '$MARKER_VALUE', got '$readback'"
fi

rm -f "$ssh_config"

# ══════════════════════════════════════════════════════════════════
# Phase 5: Gateway stop/start cycle (simulates laptop close/open)
# ══════════════════════════════════════════════════════════════════
section "Phase 5: Gateway stop/start cycle"

info "Stopping gateway (simulates laptop close / Docker stop)..."
openshell forward stop 18789 2>/dev/null || true
if openshell gateway stop -g nemoclaw 2>/dev/null; then
  pass "Gateway stopped"
else
  fail "Gateway stop failed"
  # Non-fatal — continue to see what happens
fi

# Verify the Docker container is actually stopped
CONTAINER_NAME="openshell-cluster-nemoclaw"
container_state=$(docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null || echo "missing")
if [ "$container_state" = "false" ]; then
  pass "Docker container confirmed stopped"
elif [ "$container_state" = "missing" ]; then
  info "Container not found (may have been removed) — resume should handle this"
  pass "Docker container not running"
else
  fail "Docker container still running: state=$container_state"
fi

info "Waiting 5 seconds to simulate delay (laptop lid close)..."
sleep 5

info "Starting gateway (simulates laptop open / Docker restart)..."
if openshell gateway start --name nemoclaw 2>&1; then
  pass "Gateway start command succeeded"
else
  # gateway start may exit non-zero but still recover
  info "Gateway start returned non-zero — checking health..."
fi

# Wait for gateway to become healthy — verify both "Connected" status and
# active gateway is "nemoclaw" (matches production health predicate).
info "Waiting for gateway to become healthy..."
HEALTHY=0
for attempt in $(seq 1 60); do
  gw_status=$(openshell status 2>&1)
  if echo "$gw_status" | grep -qi "Connected" && echo "$gw_status" | grep -qi "nemoclaw"; then
    HEALTHY=1
    break
  fi
  sleep 5
done

if [ "$HEALTHY" -eq 1 ]; then
  pass "Gateway healthy after restart (attempt $attempt)"
else
  fail "Gateway did not become healthy within 300 seconds"
  openshell status 2>&1 || true
  exit 1
fi

# ══════════════════════════════════════════════════════════════════
# Phase 6: Verify sandbox survived
# ══════════════════════════════════════════════════════════════════
section "Phase 6: Verify sandbox survived restart"

# 6a: Sandbox exists in openshell
if openshell sandbox list 2>&1 | grep -q "$SANDBOX_NAME"; then
  pass "Sandbox '$SANDBOX_NAME' still listed in openshell after restart"
else
  fail "Sandbox '$SANDBOX_NAME' not found in openshell after restart"
  openshell sandbox list 2>&1 || true
fi

# 6b: Sandbox pod is running (not just listed)
sandbox_phase=""
for attempt in $(seq 1 30); do
  sandbox_phase=$(openshell sandbox list 2>&1 | grep "$SANDBOX_NAME" | grep -oiE 'running|ready' | head -1)
  if [ -n "$sandbox_phase" ]; then
    break
  fi
  sleep 5
done

if [ -n "$sandbox_phase" ]; then
  pass "Sandbox pod is in '$sandbox_phase' state"
else
  fail "Sandbox pod did not reach Running/Ready state after restart"
  openshell sandbox list 2>&1 || true
fi

# 6c: NemoClaw registry still knows about it
if registry_has "$SANDBOX_NAME"; then
  pass "NemoClaw registry still contains '$SANDBOX_NAME'"
else
  fail "NemoClaw registry lost '$SANDBOX_NAME' after restart"
fi

# 6d: nemoclaw status works
if status_output=$(run_nemoclaw "$SANDBOX_NAME" status 2>&1); then
  pass "nemoclaw status exits 0 after restart"
else
  fail "nemoclaw status failed after restart: ${status_output:0:200}"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 7: Verify workspace data persisted
# ══════════════════════════════════════════════════════════════════
section "Phase 7: Verify workspace data persisted"

ssh_config="$(mktemp)"
if openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_config" 2>/dev/null; then
  pass "SSH config available after restart"
else
  fail "Could not get SSH config after restart"
  rm -f "$ssh_config"
  ssh_config=""
fi

SSH_OPTS=(-F "$ssh_config" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -o LogLevel=ERROR)

# 7a: SSH connectivity works
if [ -n "$ssh_config" ]; then
  if ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "echo alive" >/dev/null 2>&1; then
    pass "SSH into sandbox works after restart"
  else
    fail "SSH into sandbox failed after restart"
    rm -f "$ssh_config"
    skip "Marker file check (SSH unavailable)"
    skip "Post-restart inference (SSH unavailable)"
    ssh_config=""
  fi
fi

# 7b: Marker file survived
if [ -n "$ssh_config" ]; then
  post_restart_marker=$(ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "cat /sandbox/.survival-marker" 2>/dev/null)
  if [ "$post_restart_marker" = "$MARKER_VALUE" ]; then
    pass "Marker file survived restart: $MARKER_VALUE"
  else
    fail "Marker file lost or changed: expected '$MARKER_VALUE', got '${post_restart_marker:-<empty>}'"
  fi
fi

# ══════════════════════════════════════════════════════════════════
# Phase 8: Prove live inference works AFTER restart (the real proof)
# ══════════════════════════════════════════════════════════════════
section "Phase 8: Live inference after restart (THE definitive test)"

if [ -n "$ssh_config" ]; then
  info "[LIVE] Post-restart inference: user → sandbox → gateway → NVIDIA Endpoints..."
  post_response=$($TIMEOUT_CMD ssh "${SSH_OPTS[@]}" "$SSH_TARGET" \
    "curl -s --max-time 60 https://inference.local/v1/chat/completions \
      -H 'Content-Type: application/json' \
      -d '{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly one word: PONG\"}],\"max_tokens\":100}'" \
    2>&1) || true

  post_content=""
  if [ -n "$post_response" ]; then
    post_content=$(echo "$post_response" | parse_chat_content 2>/dev/null) || true
  fi

  if grep -qi "PONG" <<<"$post_content"; then
    pass "[LIVE] Post-restart: model responded with PONG through sandbox"
    info "Full path proven: user → sandbox → openshell gateway (resumed) → NVIDIA Endpoints → response"
  else
    fail "[LIVE] Post-restart: expected PONG, got: ${post_content:0:200}"
    info "Raw response: ${post_response:0:300}"
  fi
fi

[ -n "${ssh_config:-}" ] && rm -f "$ssh_config"

# ══════════════════════════════════════════════════════════════════
# Phase 9: Cleanup
# ══════════════════════════════════════════════════════════════════
section "Phase 9: Cleanup"

run_nemoclaw "$SANDBOX_NAME" destroy --yes 2>&1 | tail -3 || true
openshell gateway destroy -g nemoclaw 2>/dev/null || true

if [ -f "$REGISTRY" ] && grep -Fq "\"${SANDBOX_NAME}\"" "$REGISTRY"; then
  fail "Sandbox '$SANDBOX_NAME' still in registry after destroy"
else
  pass "Sandbox '$SANDBOX_NAME' cleaned up"
fi

# ══════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════
echo ""
echo "========================================"
echo "  Sandbox Survival E2E Results:"
echo "    Passed:  $PASS"
echo "    Failed:  $FAIL"
echo "    Skipped: $SKIP"
echo "    Total:   $TOTAL"
echo "========================================"

if [ "$FAIL" -eq 0 ]; then
  printf '\n\033[1;32m  Sandbox survival PASSED — live inference verified before AND after gateway restart.\033[0m\n'
  exit 0
else
  printf '\n\033[1;31m  %d test(s) failed.\033[0m\n' "$FAIL"
  exit 1
fi
