#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Sandbox survival across gateway restart — end-to-end proof.
#
# Validates EVERY complaint from NVIDIA/NemoClaw#486, #888, #859, #1086:
#   1. Sandbox is discoverable after restart (not "No sandboxes registered")
#   2. SSH connectivity resumes (no handshake verification failure)
#   3. Workspace files in /sandbox/ persist
#   4. OpenClaw agent data persists (/sandbox/.openclaw-data/)
#   5. No re-onboard required (nemoclaw <name> status/connect work)
#   6. Live inference works end-to-end after restart
#   7. NemoClaw registry retains sandbox entry
#   8. Gateway stop/start is non-destructive
#
# This test uses NemoClaw's own install.sh to set up everything including
# OpenShell — we are the installer, we test the installer.
#
# Requires OpenShell >= 0.0.24 (gateway resume + SSH secret persistence +
# sandbox state persistence: NVIDIA/OpenShell#488, #739).
#
# Prerequisites:
#   - Docker running
#   - NVIDIA_API_KEY set (real key, starts with nvapi-)
#   - Network access to integrate.api.nvidia.com
#
# Environment variables:
#   NEMOCLAW_NON_INTERACTIVE=1             — required
#   NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 — required
#   NVIDIA_API_KEY                         — required for real NVIDIA Endpoints inference
#   NEMOCLAW_SANDBOX_NAME                  — sandbox name (default: e2e-survival)
#   NEMOCLAW_E2E_TIMEOUT_SECONDS           — overall timeout (default: 900)
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 \
#   NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
#   NVIDIA_API_KEY=nvapi-... \
#     bash test/e2e/test-sandbox-survival.sh

set -uo pipefail

export NEMOCLAW_E2E_DEFAULT_TIMEOUT=900
SCRIPT_DIR_TIMEOUT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=test/e2e/e2e-timeout.sh
source "${SCRIPT_DIR_TIMEOUT}/e2e-timeout.sh"

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

# Compare semver: returns 0 if $1 >= $2
version_gte() {
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]
}

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-survival}"

# shellcheck source=test/e2e/lib/sandbox-teardown.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/sandbox-teardown.sh"
register_sandbox_for_teardown "$SANDBOX_NAME"

REGISTRY="$HOME/.nemoclaw/sandboxes.json"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
MIN_OPENSHELL="0.0.24"
MODEL="nvidia/nemotron-3-super-120b-a12b"

# SSH helper — sets up SSH config and common options for sandbox access
# Sets: ssh_config, SSH_OPTS, SSH_TARGET
setup_ssh() {
  ssh_config="$(mktemp)"
  if ! openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_config" 2>/dev/null; then
    rm -f "$ssh_config"
    ssh_config=""
    return 1
  fi
  SSH_OPTS=(-F "$ssh_config" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -o LogLevel=ERROR)
  SSH_TARGET="openshell-${SANDBOX_NAME}"
  return 0
}

cleanup_ssh() {
  [ -n "${ssh_config:-}" ] && rm -f "$ssh_config"
  ssh_config=""
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
  fail "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 is required"
  exit 1
fi

if [ ! -f "$REPO_ROOT/install.sh" ]; then
  fail "Cannot find install.sh at $REPO_ROOT/install.sh"
  exit 1
fi
pass "Repo root found: $REPO_ROOT"

# ══════════════════════════════════════════════════════════════════
# Phase 1: Pre-cleanup
# ══════════════════════════════════════════════════════════════════
section "Phase 1: Pre-cleanup"

info "Destroying any leftover sandbox/gateway from previous runs..."
if command -v nemoclaw >/dev/null 2>&1; then
  nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true
fi
if command -v openshell >/dev/null 2>&1; then
  openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true
  openshell gateway destroy -g nemoclaw 2>/dev/null || true
fi
rm -f "$HOME/.nemoclaw/onboard.lock" 2>/dev/null || true
pass "Pre-cleanup complete"

# ══════════════════════════════════════════════════════════════════
# Phase 2: Install NemoClaw (which installs OpenShell)
# ══════════════════════════════════════════════════════════════════
section "Phase 2: Install NemoClaw via install.sh"

info "Running install.sh --non-interactive (installs Node.js, OpenShell, NemoClaw, runs onboard)..."

cd "$REPO_ROOT" || {
  fail "Could not cd to repo root: $REPO_ROOT"
  exit 1
}

INSTALL_LOG="$(mktemp)"
env \
  NEMOCLAW_NON_INTERACTIVE=1 \
  NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
  NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME" \
  NEMOCLAW_RECREATE_SANDBOX=1 \
  bash install.sh --non-interactive >"$INSTALL_LOG" 2>&1 &
install_pid=$!
tail -f "$INSTALL_LOG" --pid=$install_pid 2>/dev/null &
tail_pid=$!
wait $install_pid
install_exit=$?
kill $tail_pid 2>/dev/null || true
wait $tail_pid 2>/dev/null || true
rm -f "$INSTALL_LOG"

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
  exit 1
fi

# Verify nemoclaw is on PATH
if command -v nemoclaw >/dev/null 2>&1; then
  pass "nemoclaw on PATH: $(command -v nemoclaw)"
else
  fail "nemoclaw not found on PATH after install"
  exit 1
fi

# Verify openshell was installed and meets minimum version
if ! command -v openshell >/dev/null 2>&1; then
  fail "openshell not found on PATH after install"
  exit 1
fi

OPENSHELL_VERSION=$(openshell --version 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
if version_gte "$OPENSHELL_VERSION" "$MIN_OPENSHELL"; then
  pass "openshell $OPENSHELL_VERSION >= $MIN_OPENSHELL (gateway resume + SSH secret + state persistence)"
else
  fail "openshell $OPENSHELL_VERSION < $MIN_OPENSHELL — sandbox survival requires $MIN_OPENSHELL+"
  exit 1
fi

# ══════════════════════════════════════════════════════════════════
# Phase 3: Verify sandbox is live after install
# ══════════════════════════════════════════════════════════════════
section "Phase 3: Post-install verification"

# 3a: NemoClaw registry has it
if [ -f "$REGISTRY" ] && grep -Fq "\"${SANDBOX_NAME}\"" "$REGISTRY"; then
  pass "NemoClaw registry contains '$SANDBOX_NAME'"
else
  fail "NemoClaw registry missing '$SANDBOX_NAME' — onboard may have failed"
  exit 1
fi

# 3b: nemoclaw list shows it
if list_output=$(nemoclaw list 2>&1) && grep -Fq "$SANDBOX_NAME" <<<"$list_output"; then
  pass "nemoclaw list shows '$SANDBOX_NAME'"
else
  fail "nemoclaw list doesn't show '$SANDBOX_NAME': ${list_output:0:200}"
  exit 1
fi

# 3c: openshell sandbox list shows it
if os_list=$(openshell sandbox list 2>&1) && grep -q "$SANDBOX_NAME" <<<"$os_list"; then
  pass "openshell sandbox list shows '$SANDBOX_NAME'"
else
  fail "openshell sandbox list doesn't show '$SANDBOX_NAME': ${os_list:0:200}"
  exit 1
fi

# 3d: nemoclaw status works
if status_output=$(nemoclaw "$SANDBOX_NAME" status 2>&1); then
  pass "nemoclaw $SANDBOX_NAME status exits 0"
else
  fail "nemoclaw $SANDBOX_NAME status failed: ${status_output:0:200}"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 4: Baseline — prove live inference BEFORE restart
# ══════════════════════════════════════════════════════════════════
section "Phase 4: Baseline — live inference before restart"

if ! setup_ssh; then
  fail "Could not get SSH config for sandbox"
  exit 1
fi
pass "SSH config obtained"

# 4a: SSH connectivity
if ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "echo alive" >/dev/null 2>&1; then
  pass "SSH into sandbox works (baseline)"
else
  fail "SSH into sandbox failed (baseline) — cannot continue"
  cleanup_ssh
  exit 1
fi

# 4b: Live inference through sandbox
info "[LIVE] Baseline inference: user → sandbox → gateway → NVIDIA Endpoints..."
# shellcheck disable=SC2029  # client-side expansion is intentional
baseline_response=$(run_with_timeout 90 ssh "${SSH_OPTS[@]}" "$SSH_TARGET" \
  "curl -s --max-time 60 https://inference.local/v1/chat/completions \
    -H 'Content-Type: application/json' \
    -d '{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly one word: PONG\"}],\"max_tokens\":100}'" \
  2>&1) || true

# Retry baseline inference up to 3 times — live models are not deterministic
# and the gateway proxy can return unexpected responses on first attempt. (#1969)
baseline_content=""
pong_ok=false
for pong_attempt in 1 2 3; do
  baseline_content=""
  if [ -n "$baseline_response" ]; then
    baseline_content=$(echo "$baseline_response" | parse_chat_content 2>/dev/null) || true
  fi
  if grep -qi "PONG" <<<"$baseline_content"; then
    pong_ok=true
    break
  fi
  info "Baseline attempt ${pong_attempt}/3: got '${baseline_content:0:80}', retrying in 5s..."
  [ "$pong_attempt" -lt 3 ] || break
  sleep 5
  # shellcheck disable=SC2029
  baseline_response=$(run_with_timeout 90 ssh "${SSH_OPTS[@]}" "$SSH_TARGET" \
    "curl -s --max-time 60 https://inference.local/v1/chat/completions \
      -H 'Content-Type: application/json' \
      -d '{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly one word: PONG\"}],\"max_tokens\":100}'" \
    2>&1) || true
done
if $pong_ok; then
  pass "[LIVE] Baseline: model responded with PONG through sandbox"
else
  fail "[LIVE] Baseline: expected PONG after 3 attempts, got: ${baseline_content:0:200}"
  info "Raw response: ${baseline_response:0:300}"
  info "Cannot establish baseline — aborting (survival test meaningless without it)"
  cleanup_ssh
  exit 1
fi

# ══════════════════════════════════════════════════════════════════
# Phase 5: Plant state markers inside sandbox
# ══════════════════════════════════════════════════════════════════
section "Phase 5: Plant state markers in sandbox"

MARKER_VALUE="nemoclaw-survival-$(date +%s)"

# 5a: Workspace file in /sandbox/
# shellcheck disable=SC2029
if ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "echo ${MARKER_VALUE} > /sandbox/.survival-marker" 2>/dev/null; then
  pass "Planted workspace marker: /sandbox/.survival-marker"
else
  fail "Could not plant workspace marker"
fi

# Verify read-back before restart
readback=$(ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "cat /sandbox/.survival-marker" 2>/dev/null)
if [ "$readback" = "$MARKER_VALUE" ]; then
  pass "Workspace marker verified before restart"
else
  fail "Workspace marker read-back mismatch: expected '$MARKER_VALUE', got '$readback'"
fi

# 5b: Agent data directory — plant marker in .openclaw-data if it exists
# This tests the complaint from #1086 and @Koneisto: agent state loss
# shellcheck disable=SC2029
agent_data_exists=$(ssh "${SSH_OPTS[@]}" "$SSH_TARGET" \
  "[ -d /sandbox/.openclaw-data ] && echo yes || echo no" 2>/dev/null)
if [ "$agent_data_exists" = "yes" ]; then
  # shellcheck disable=SC2029
  if ssh "${SSH_OPTS[@]}" "$SSH_TARGET" \
    "echo ${MARKER_VALUE} > /sandbox/.openclaw-data/.survival-marker" 2>/dev/null; then
    pass "Planted agent data marker: /sandbox/.openclaw-data/.survival-marker"
  else
    fail "Could not plant agent data marker"
  fi
else
  info "No .openclaw-data directory yet — will check if sandbox itself survives"
fi

# 5c: Snapshot which agent identity files exist (to verify they survive)
agent_files_before=$(ssh "${SSH_OPTS[@]}" "$SSH_TARGET" \
  "ls -la /sandbox/.openclaw-data/ 2>/dev/null | head -20" 2>/dev/null) || true
if [ -n "$agent_files_before" ]; then
  info "Agent data directory contents before restart:"
  echo "$agent_files_before" | while IFS= read -r line; do
    info "  $line"
  done
fi

# 5d: Record a deeper workspace file to test nested persistence
# shellcheck disable=SC2029
if ssh "${SSH_OPTS[@]}" "$SSH_TARGET" \
  "mkdir -p /sandbox/test-data && echo ${MARKER_VALUE} > /sandbox/test-data/nested-marker.txt" \
  2>/dev/null; then
  pass "Planted nested marker: /sandbox/test-data/nested-marker.txt"
else
  fail "Could not plant nested workspace marker"
fi

cleanup_ssh

# ══════════════════════════════════════════════════════════════════
# Phase 6: Gateway stop/start cycle (simulates reboot)
# ══════════════════════════════════════════════════════════════════
section "Phase 6: Gateway stop/start cycle (simulates host reboot)"

# Stop any port forwards first
openshell forward stop 18789 2>/dev/null || true

info "Stopping gateway (simulates laptop close / VM shutdown)..."
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

info "Waiting 5 seconds to simulate delay (laptop lid close / VM hibernate)..."
sleep 5

info "Starting gateway (simulates laptop open / VM boot)..."
if openshell gateway start --name nemoclaw 2>&1; then
  pass "Gateway start command succeeded"
else
  # gateway start may exit non-zero but still recover
  info "Gateway start returned non-zero — checking health..."
fi

# Wait for gateway to become healthy
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
# Phase 7: Verify sandbox survived — every complaint from #486/#888/#859/#1086
# ══════════════════════════════════════════════════════════════════
section "Phase 7: Verify sandbox survived restart"

# 7a: openshell sandbox list — #486 "No sandboxes found"
if openshell sandbox list 2>&1 | grep -q "$SANDBOX_NAME"; then
  pass "openshell sandbox list shows '$SANDBOX_NAME' after restart"
else
  fail "openshell sandbox list: '$SANDBOX_NAME' NOT FOUND after restart (#486)"
  openshell sandbox list 2>&1 || true
fi

# 7b: Sandbox pod is running, not just listed
sandbox_phase=""
for attempt in $(seq 1 30); do
  sandbox_phase=$(openshell sandbox list 2>&1 | grep "$SANDBOX_NAME" | grep -oiE 'running|ready' | head -1)
  if [ -n "$sandbox_phase" ]; then
    break
  fi
  sleep 5
done

if [ -n "$sandbox_phase" ]; then
  pass "Sandbox pod is '$sandbox_phase' after restart"
else
  fail "Sandbox pod did not reach Running/Ready after restart"
  openshell sandbox list 2>&1 || true
fi

# 7c: NemoClaw registry still has it — #486 "No sandboxes registered"
if [ -f "$REGISTRY" ] && grep -Fq "\"${SANDBOX_NAME}\"" "$REGISTRY"; then
  pass "NemoClaw registry still contains '$SANDBOX_NAME' after restart"
else
  fail "NemoClaw registry lost '$SANDBOX_NAME' after restart (#486)"
fi

# 7d: nemoclaw list shows it — the actual user-facing command
if list_output=$(nemoclaw list 2>&1) && grep -Fq "$SANDBOX_NAME" <<<"$list_output"; then
  pass "nemoclaw list shows '$SANDBOX_NAME' after restart"
else
  fail "nemoclaw list doesn't show '$SANDBOX_NAME' after restart: ${list_output:0:200}"
fi

# 7e: nemoclaw status works — #859 "unclear CLI behavior"
# No special intervention should be required after gateway restart.
# If nemoclaw status hangs, that IS the bug — use timeout to detect it.
# Write to a temp file instead of $() to avoid pipe FD inheritance:
# nemoclaw's SSH recovery can spawn background processes that hold the
# pipe open, preventing $() from returning even after timeout kills nemoclaw.
STATUS_TMP="$(mktemp)"
TIMEOUT_STATUS=""
command -v timeout >/dev/null 2>&1 && TIMEOUT_STATUS="timeout 120"
command -v gtimeout >/dev/null 2>&1 && TIMEOUT_STATUS="gtimeout 120"
$TIMEOUT_STATUS nemoclaw "$SANDBOX_NAME" status >"$STATUS_TMP" 2>&1
status_exit=$?
status_output=$(cat "$STATUS_TMP")
rm -f "$STATUS_TMP"
if [ "$status_exit" -eq 0 ]; then
  pass "nemoclaw $SANDBOX_NAME status exits 0 after restart (no re-onboard needed)"
elif [ "$status_exit" -eq 124 ]; then
  fail "nemoclaw $SANDBOX_NAME status TIMED OUT after restart (port forward or SSH recovery hung)"
else
  fail "nemoclaw $SANDBOX_NAME status failed after restart (exit $status_exit): ${status_output:0:200}"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 8: Verify SSH connectivity — #888/#1086 handshake failure
# ══════════════════════════════════════════════════════════════════
section "Phase 8: Verify SSH connectivity after restart"

if ! setup_ssh; then
  fail "Could not get SSH config after restart (#888 handshake failure?)"
  skip "Workspace marker check (SSH unavailable)"
  skip "Agent data marker check (SSH unavailable)"
  skip "Nested marker check (SSH unavailable)"
  skip "Post-restart inference (SSH unavailable)"

  # Jump to cleanup
  section "Phase 11: Cleanup"
  [[ "${NEMOCLAW_E2E_KEEP_SANDBOX:-}" = "1" ]] || nemoclaw "$SANDBOX_NAME" destroy --yes 2>&1 | tail -3 || true
  openshell gateway destroy -g nemoclaw 2>/dev/null || true
  echo ""
  echo "========================================"
  echo "  Sandbox Survival E2E Results:"
  echo "    Passed:  $PASS"
  echo "    Failed:  $FAIL"
  echo "    Skipped: $SKIP"
  echo "    Total:   $TOTAL"
  echo "========================================"
  printf '\n\033[1;31m  %d test(s) failed.\033[0m\n' "$FAIL"
  exit 1
fi
pass "SSH config available after restart"

# 8a: Raw SSH connectivity — the #888/#1086 handshake test
# The sandbox SSH agent may take a few seconds to become reachable after
# the gateway reports healthy (especially with newer OpenClaw versions that
# do more startup work). Retry up to 30 seconds before declaring failure.
SSH_OK=0
for ssh_attempt in $(seq 1 6); do
  if ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "echo alive" >/dev/null 2>&1; then
    SSH_OK=1
    break
  fi
  [ "$ssh_attempt" -lt 6 ] && sleep 5
done

if [ "$SSH_OK" -eq 1 ]; then
  pass "SSH into sandbox works after restart (attempt $ssh_attempt, no handshake failure — #888/#1086)"
else
  fail "SSH into sandbox FAILED after restart — handshake verification likely failed (#888/#1086)"
  info "This is the core bug: gateway regenerated secrets, sandbox has stale ones"
  # Do NOT call cleanup_ssh here — subsequent phases need the config file
  # to attempt marker reads and produce meaningful diagnostics.
  nemoclaw "$SANDBOX_NAME" logs 2>&1 | grep -i "handshake" | head -5 || true
fi

# ══════════════════════════════════════════════════════════════════
# Phase 9: Verify workspace and agent state persisted — #1086/@Koneisto
# ══════════════════════════════════════════════════════════════════
section "Phase 9: Verify state persisted across restart"

# 9a: Workspace marker
post_restart_marker=$(ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "cat /sandbox/.survival-marker" 2>/dev/null)
if [ "$post_restart_marker" = "$MARKER_VALUE" ]; then
  pass "Workspace marker survived restart: $MARKER_VALUE"
else
  fail "Workspace marker LOST: expected '$MARKER_VALUE', got '${post_restart_marker:-<empty>}' (#1086 state loss)"
fi

# 9b: Agent data marker
if [ "$agent_data_exists" = "yes" ]; then
  agent_marker=$(ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "cat /sandbox/.openclaw-data/.survival-marker" 2>/dev/null)
  if [ "$agent_marker" = "$MARKER_VALUE" ]; then
    pass "Agent data marker survived restart"
  else
    fail "Agent data marker LOST: expected '$MARKER_VALUE', got '${agent_marker:-<empty>}' (agent state destroyed)"
  fi
fi

# 9c: Nested workspace file
nested_marker=$(ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "cat /sandbox/test-data/nested-marker.txt" 2>/dev/null)
if [ "$nested_marker" = "$MARKER_VALUE" ]; then
  pass "Nested workspace marker survived restart"
else
  fail "Nested workspace marker LOST: expected '$MARKER_VALUE', got '${nested_marker:-<empty>}'"
fi

# 9d: Agent data directory still populated (not wiped to image defaults)
if [ "$agent_data_exists" = "yes" ]; then
  agent_files_after=$(ssh "${SSH_OPTS[@]}" "$SSH_TARGET" \
    "ls -la /sandbox/.openclaw-data/ 2>/dev/null | head -20" 2>/dev/null) || true
  if [ -n "$agent_files_after" ]; then
    info "Agent data directory contents after restart:"
    echo "$agent_files_after" | while IFS= read -r line; do
      info "  $line"
    done
    pass "Agent data directory still populated after restart"
  else
    fail "Agent data directory is empty after restart (@Koneisto overlay wipe)"
  fi
fi

# ══════════════════════════════════════════════════════════════════
# Phase 10: Prove live inference works AFTER restart (the definitive proof)
# ══════════════════════════════════════════════════════════════════
section "Phase 10: Live inference after restart (THE definitive test)"

info "[LIVE] Post-restart inference: user → sandbox → gateway → NVIDIA Endpoints..."
# shellcheck disable=SC2029
post_response=$(run_with_timeout 90 ssh "${SSH_OPTS[@]}" "$SSH_TARGET" \
  "curl -s --max-time 60 https://inference.local/v1/chat/completions \
    -H 'Content-Type: application/json' \
    -d '{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly one word: PONG\"}],\"max_tokens\":100}'" \
  2>&1) || true

# Retry post-restart inference up to 3 times. (#1969)
post_content=""
pong_ok=false
for pong_attempt in 1 2 3; do
  post_content=""
  if [ -n "$post_response" ]; then
    post_content=$(echo "$post_response" | parse_chat_content 2>/dev/null) || true
  fi
  if grep -qi "PONG" <<<"$post_content"; then
    pong_ok=true
    break
  fi
  info "Post-restart attempt ${pong_attempt}/3: got '${post_content:0:80}', retrying in 5s..."
  [ "$pong_attempt" -lt 3 ] || break
  sleep 5
  # shellcheck disable=SC2029
  post_response=$(run_with_timeout 90 ssh "${SSH_OPTS[@]}" "$SSH_TARGET" \
    "curl -s --max-time 60 https://inference.local/v1/chat/completions \
      -H 'Content-Type: application/json' \
      -d '{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly one word: PONG\"}],\"max_tokens\":100}'" \
    2>&1) || true
done
if $pong_ok; then
  pass "[LIVE] Post-restart: model responded with PONG through sandbox"
  info "Full path proven: user → sandbox → openshell gateway (resumed) → NVIDIA Endpoints → response"
  info "This proves #859's ask: reliable non-destructive gateway lifecycle with working inference"
else
  fail "[LIVE] Post-restart: expected PONG after 3 attempts, got: ${post_content:0:200}"
  info "Raw response: ${post_response:0:300}"
fi

cleanup_ssh

# ══════════════════════════════════════════════════════════════════
# Phase 11: Cleanup
# ══════════════════════════════════════════════════════════════════
section "Phase 11: Cleanup"

[[ "${NEMOCLAW_E2E_KEEP_SANDBOX:-}" = "1" ]] || nemoclaw "$SANDBOX_NAME" destroy --yes 2>&1 | tail -3 || true
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
  printf '\n\033[1;32m  Sandbox survival PASSED — all state persisted, live inference verified before AND after gateway restart.\033[0m\n'
  printf '\033[1;32m  Issues validated: #486, #888, #859, #1086\033[0m\n'
  exit 0
else
  printf '\n\033[1;31m  %d test(s) failed.\033[0m\n' "$FAIL"
  exit 1
fi
