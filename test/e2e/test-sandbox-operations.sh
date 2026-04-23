#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# =============================================================================
# test-sandbox-operations.sh
# NemoClaw Sandbox Operations E2E Test Suite
#
# Covers: TC-SBX-01 through TC-SBX-11
# Assumes: NemoClaw is installed, no sandbox is currently onboarded
#
# Test ordering:
#   Phase 1 — Basic operations (sandbox A alive)
#   Phase 2 — Non-destructive recovery (sandbox A alive)
#   Phase 3 — Multi-sandbox (onboards sandbox B alongside A)
#   Phase 4 — Cleanup verification (destroys sandbox B)
#   Phase 5 — Gateway kill recovery (destructive — runs last)
# =============================================================================

set -euo pipefail

# ── Overall timeout (prevents hung CI jobs) ──────────────────────────────────
TIMEOUT_CMD=""
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_CMD="timeout"
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_CMD="gtimeout"
fi

if [ "${NEMOCLAW_E2E_NO_TIMEOUT:-0}" != "1" ] && [ "${NEMOCLAW_E2E_TIMEOUT_WRAPPED:-0}" != "1" ]; then
  TIMEOUT_SECONDS="${NEMOCLAW_E2E_TIMEOUT_SECONDS:-1800}"
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

# ── Config ───────────────────────────────────────────────────────────────────
SANDBOX_A="test-sbx-a"
SANDBOX_B="test-sbx-b"
LOG_FILE="test-sandbox-operations-$(date +%Y%m%d-%H%M%S).log"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# ── Counters ─────────────────────────────────────────────────────────────────
PASS=0
FAIL=0
SKIP=0
TOTAL=0

# ── Helpers ──────────────────────────────────────────────────────────────────
log() { echo -e "${CYAN}[$(date +%H:%M:%S)]${NC} $*" | tee -a "$LOG_FILE"; }
pass() {
  ((PASS += 1))
  ((TOTAL += 1))
  echo -e "${GREEN}  PASS${NC} $1" | tee -a "$LOG_FILE"
}
fail() {
  ((FAIL += 1))
  ((TOTAL += 1))
  echo -e "${RED}  FAIL${NC} $1 — $2" | tee -a "$LOG_FILE"
}
skip() {
  ((SKIP += 1))
  ((TOTAL += 1))
  echo -e "${YELLOW}  SKIP${NC} $1 — $2" | tee -a "$LOG_FILE"
}

# Check that a sandbox is registered; skip the named test case if not.
# Usage: require_sandbox "$SANDBOX_A" "TC-SBX-02" || return
require_sandbox() {
  if ! nemoclaw list 2>/dev/null | grep -q "$1"; then
    skip "$2" "sandbox '$1' not available"
    return 1
  fi
  return 0
}

# Run a command inside a named sandbox via SSH. Returns the command output.
# Logs warnings on SSH config failure, empty config, timeout, or non-zero exit.
sandbox_exec_for() {
  local name="$1" cmd="$2"
  local ssh_cfg
  ssh_cfg="$(mktemp)"
  if ! openshell sandbox ssh-config "$name" >"$ssh_cfg" 2>/dev/null; then
    log "  [sandbox_exec] Failed to get SSH config for '$name'"
    rm -f "$ssh_cfg"
    echo ""
    return 1
  fi
  if [[ ! -s "$ssh_cfg" ]]; then
    log "  [sandbox_exec] SSH config for '$name' is empty"
    rm -f "$ssh_cfg"
    echo ""
    return 1
  fi
  local result exit_code=0
  result=$(run_with_timeout 60 ssh -F "$ssh_cfg" \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 -o LogLevel=ERROR \
    "openshell-${name}" "$cmd" 2>&1) || exit_code=$?
  rm -f "$ssh_cfg"
  if [[ $exit_code -eq 124 ]]; then
    log "  [sandbox_exec] SSH command timed out after 60s for '$name'"
  elif [[ $exit_code -ne 0 && -z "$result" ]]; then
    log "  [sandbox_exec] SSH command failed (exit $exit_code) for '$name'"
  fi
  echo "$result"
}

# Shorthand: run a command inside sandbox A.
sandbox_exec() {
  sandbox_exec_for "$SANDBOX_A" "$1"
}

# Onboard a sandbox by name. Removes stale locks, runs nemoclaw onboard in
# non-interactive mode, and returns 0 if the sandbox appears in nemoclaw list.
onboard_sandbox() {
  local name="$1"
  log "  Onboarding sandbox '$name'..."

  # Remove stale lock from previous crashed runs
  rm -f "$HOME/.nemoclaw/onboard.lock" 2>/dev/null || true

  local onboard_exit=0
  NEMOCLAW_SANDBOX_NAME="$name" \
    NEMOCLAW_NON_INTERACTIVE=1 \
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
    NEMOCLAW_RECREATE_SANDBOX=1 \
    nemoclaw onboard --non-interactive --yes-i-accept-third-party-software \
    2>&1 | tee -a "$LOG_FILE" || onboard_exit=$?

  if [[ $onboard_exit -ne 0 ]]; then
    log "  [onboard_sandbox] nemoclaw onboard exited with code $onboard_exit"
    return 1
  fi

  if ! nemoclaw list 2>/dev/null | grep -q "$name"; then
    log "  [onboard_sandbox] Sandbox '$name' not found in nemoclaw list after onboard"
    return 1
  fi
  return 0
}

# ── Resolve repo root ────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
if [ -f "$SCRIPT_DIR/../../install.sh" ]; then
  REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
elif [ -f "./install.sh" ]; then
  REPO_ROOT="$(pwd)"
else
  echo "ERROR: Cannot find install.sh — run from the repo root or test/e2e/"
  exit 1
fi

# ── Install NemoClaw if not present ──────────────────────────────────────────
# Matches the pattern from test-sandbox-survival.sh and test-full-e2e.sh:
# each E2E test installs NemoClaw from source so it runs on a fresh CI runner.
install_nemoclaw() {
  if command -v nemoclaw &>/dev/null; then
    log "nemoclaw already installed: $(nemoclaw --version 2>/dev/null || echo 'unknown')"
    return 0
  fi

  log "=== Installing NemoClaw via install.sh ==="

  local install_exit=0
  bash "$REPO_ROOT/install.sh" --non-interactive --yes-i-accept-third-party-software \
    2>&1 | tee -a "$LOG_FILE" || install_exit=$?

  # Source shell profile to pick up PATH changes from install.sh
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

  if [[ $install_exit -ne 0 ]]; then
    echo -e "${RED}FATAL: install.sh failed (exit $install_exit)${NC}"
    exit 1
  fi

  if ! command -v nemoclaw &>/dev/null; then
    echo -e "${RED}FATAL: nemoclaw not found on PATH after install${NC}"
    exit 1
  fi

  log "nemoclaw installed: $(nemoclaw --version 2>/dev/null || echo 'unknown')"

  # Destroy the sandbox that install.sh created (we create our own)
  local install_sandbox
  install_sandbox="${NEMOCLAW_SANDBOX_NAME:-my-assistant}"
  if nemoclaw list 2>/dev/null | grep -q "$install_sandbox"; then
    log "Destroying install sandbox '$install_sandbox'..."
    nemoclaw "$install_sandbox" destroy --yes 2>/dev/null || true
  fi
}

# ── Pre-flight ───────────────────────────────────────────────────────────────
# Verify prerequisites (Docker, API key), install NemoClaw if needed, and
# clean up leftover sandboxes and stale locks from previous crashed runs.
preflight() {
  log "=== Pre-flight checks ==="

  if ! docker info &>/dev/null; then
    echo -e "${RED}ERROR: Docker is not running.${NC}"
    exit 1
  fi
  log "Docker is running"

  if [[ -z "${NVIDIA_API_KEY:-}" && -z "${OPENAI_API_KEY:-}" && -z "${ANTHROPIC_API_KEY:-}" ]]; then
    echo -e "${YELLOW}WARNING: No API key detected.${NC}"
  fi

  install_nemoclaw

  log "nemoclaw: $(nemoclaw --version 2>/dev/null || echo 'unknown')"
  log "openshell: $(openshell --version 2>&1 | head -1 || echo 'unknown')"
  log "timeout: $TIMEOUT_CMD"

  # Remove stale onboard lock from previous crashed runs
  if [[ -f "$HOME/.nemoclaw/onboard.lock" ]]; then
    log "Removing stale onboard lock"
    rm -f "$HOME/.nemoclaw/onboard.lock"
  fi

  for sb in "$SANDBOX_A" "$SANDBOX_B"; do
    if nemoclaw list 2>/dev/null | grep -q "$sb"; then
      log "Cleaning up leftover sandbox: $sb"
      nemoclaw "$sb" destroy --yes 2>/dev/null || true
    fi
  done

  log "Pre-flight complete"
  echo ""
}

# ── Setup: Onboard sandbox A ────────────────────────────────────────────────
# Create the primary test sandbox. Exits the script on failure since all
# subsequent test cases depend on sandbox A being available.
setup_sandbox_a() {
  log "=== Setup: Onboarding sandbox '$SANDBOX_A' ==="
  log "This may take a few minutes..."

  if ! onboard_sandbox "$SANDBOX_A"; then
    echo -e "${RED}FATAL: Onboard failed — sandbox '$SANDBOX_A' not found.${NC}"
    exit 1
  fi

  log "Sandbox '$SANDBOX_A' onboarded successfully"
  echo ""
}

# =============================================================================
# Phase 1: Basic operations (sandbox A alive)
# =============================================================================

# ── TC-SBX-01: List Sandboxes ───────────────────────────────────────────────
test_sbx_01_list_sandboxes() {
  log "=== TC-SBX-01: List Sandboxes ==="

  local output
  output=$(nemoclaw list 2>&1)

  if echo "$output" | grep -q "$SANDBOX_A"; then
    pass "TC-SBX-01: nemoclaw list shows '$SANDBOX_A'"
  else
    fail "TC-SBX-01: List Sandboxes" "'$SANDBOX_A' not found in nemoclaw list output"
  fi
}

# ── TC-SBX-02: Connect & Chat ───────────────────────────────────────────────
test_sbx_02_connect_chat() {
  log "=== TC-SBX-02: Connect & Chat ==="
  require_sandbox "$SANDBOX_A" "TC-SBX-02" || return

  log "  Sending one-shot message to agent via SSH..."
  local reply
  reply=$(sandbox_exec "openclaw agent --agent main -m 'Say exactly: HELLO_E2E' --session-id e2e-test" 2>&1) || true

  if echo "$reply" | grep -qi "HELLO_E2E"; then
    pass "TC-SBX-02: Agent replied with expected token"
  else
    fail "TC-SBX-02: Connect & Chat" "Got: $(echo "$reply" | head -3)"
  fi
}

# ── TC-SBX-03: Status Fields ────────────────────────────────────────────────
test_sbx_03_status_fields() {
  log "=== TC-SBX-03: Status Fields ==="
  require_sandbox "$SANDBOX_A" "TC-SBX-03" || return

  local output
  output=$(nemoclaw "$SANDBOX_A" status 2>&1)

  local all_good=true
  for field in "Sandbox" "Model" "Provider" "GPU"; do
    if echo "$output" | grep -qi "$field"; then
      log "  Found field: $field"
    else
      log "  MISSING field: $field"
      all_good=false
    fi
  done

  if $all_good; then
    pass "TC-SBX-03: Status output contains all expected fields"
  else
    fail "TC-SBX-03: Status Fields" "Missing expected fields. Output: $(echo "$output" | head -10)"
  fi
}

# ── TC-SBX-04: Log Streaming ────────────────────────────────────────────────
test_sbx_04_log_streaming() {
  log "=== TC-SBX-04: Log Streaming ==="
  require_sandbox "$SANDBOX_A" "TC-SBX-04" || return

  local output logs_exit=0
  output=$(run_with_timeout 10 nemoclaw "$SANDBOX_A" logs 2>&1) || logs_exit=$?

  if [[ $logs_exit -ne 0 ]]; then
    fail "TC-SBX-04: Log Streaming" "nemoclaw logs exited with code $logs_exit"
  elif [[ -n "$output" ]]; then
    pass "TC-SBX-04: Log streaming produced output ($(echo "$output" | wc -l | tr -d ' ') lines)"
  else
    fail "TC-SBX-04: Log Streaming" "nemoclaw logs succeeded but produced no output"
  fi

  run_with_timeout 5 nemoclaw "$SANDBOX_A" logs --follow &>/dev/null &
  local pid=$!
  sleep 3

  if ! ps -p "$pid" &>/dev/null; then
    fail "TC-SBX-04: Log --follow" "Process exited before kill (was not streaming)"
  else
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    if ps -p "$pid" &>/dev/null; then
      fail "TC-SBX-04: Log --follow cleanup" "Orphaned log process still running"
    else
      pass "TC-SBX-04: Log --follow exited cleanly after kill"
    fi
  fi
}

# =============================================================================
# Phase 2: Non-destructive recovery (sandbox A stays alive)
# =============================================================================

# ── TC-SBX-07: Registry Rebuild ─────────────────────────────────────────────
test_sbx_07_registry_rebuild() {
  log "=== TC-SBX-07: Registry Rebuild ==="
  require_sandbox "$SANDBOX_A" "TC-SBX-07" || return

  local registry="$HOME/.nemoclaw/sandboxes.json"
  if [[ ! -f "$registry" ]]; then
    skip "TC-SBX-07" "sandboxes.json not found"
    return
  fi

  cp "$registry" "${registry}.bak"
  log "  Backed up and deleted sandboxes.json"
  rm -f "$registry"

  local output
  output=$(run_with_timeout 60 nemoclaw list 2>&1) || true

  if echo "$output" | grep -q "$SANDBOX_A"; then
    pass "TC-SBX-07: Registry rebuilt — '$SANDBOX_A' found after deletion"
    rm -f "${registry}.bak"
  else
    fail "TC-SBX-07: Registry Rebuild" "Not found after rebuild. Restoring backup."
    mv "${registry}.bak" "$registry"
  fi
}

# ── TC-SBX-08: Process Recovery ─────────────────────────────────────────────
test_sbx_08_process_recovery() {
  log "=== TC-SBX-08: Process Recovery ==="
  require_sandbox "$SANDBOX_A" "TC-SBX-08" || return

  log "  Killing OpenClaw gateway process inside sandbox..."
  local kill_output
  kill_output=$(sandbox_exec "pkill -9 -f 'openclaw gateway' 2>/dev/null || kill -9 \$(pgrep -f 'openclaw gateway') 2>/dev/null || kill -9 \$(ps aux | grep 'openclaw.*gateway' | grep -v grep | awk '{print \$2}') 2>/dev/null; echo EXIT_\$?" 2>&1) || true

  if echo "$kill_output" | grep -q "EXIT_0"; then
    log "  Process kill confirmed"
  else
    log "  WARNING: Could not confirm process was killed (output: $kill_output)"
  fi
  sleep 5

  log "  Running nemoclaw status (expect process recovery)..."
  local status_output status_exit=0
  status_output=$(run_with_timeout 120 nemoclaw "$SANDBOX_A" status 2>&1) || status_exit=$?

  if [[ $status_exit -ne 0 ]]; then
    fail "TC-SBX-08: Process Recovery (status)" "nemoclaw status exited with code $status_exit"
  elif echo "$status_output" | grep -qiE "recover|running|healthy|OpenClaw"; then
    pass "TC-SBX-08: Status detected and recovered dead OpenClaw process"
  else
    fail "TC-SBX-08: Process Recovery (status)" "Output: $(echo "$status_output" | head -5)"
  fi

  log "  Verifying SSH still works..."
  local check
  check=$(sandbox_exec "echo process-recovery-ok" 2>&1) || true
  if echo "$check" | grep -q "process-recovery-ok"; then
    pass "TC-SBX-08: SSH works after process recovery"
  else
    fail "TC-SBX-08: Process Recovery (SSH)" "Cannot SSH after recovery"
  fi
}

# ── TC-SBX-05: Destroy Cleanup ──────────────────────────────────────────────
test_sbx_05_destroy_cleanup() {
  log "=== TC-SBX-05: Destroy Cleanup ==="
  local target="$1"

  if ! nemoclaw list 2>/dev/null | grep -q "$target"; then
    skip "TC-SBX-05" "Sandbox '$target' not present"
    return
  fi

  log "  Destroying sandbox '$target'..."
  local destroy_exit=0
  nemoclaw "$target" destroy --yes 2>&1 | tee -a "$LOG_FILE" || destroy_exit=$?

  if [[ $destroy_exit -ne 0 ]]; then
    fail "TC-SBX-05: Destroy ($target)" "nemoclaw destroy exited with code $destroy_exit"
  fi

  if nemoclaw list 2>/dev/null | grep -q "$target"; then
    fail "TC-SBX-05: Destroy ($target)" "Still in nemoclaw list after destroy (exit $destroy_exit)"
  else
    pass "TC-SBX-05: '$target' removed from nemoclaw list"
  fi

  if openshell sandbox list 2>/dev/null | grep -q "$target"; then
    fail "TC-SBX-05: Destroy ($target)" "Still in openshell sandbox list after destroy"
  else
    pass "TC-SBX-05: '$target' removed from openshell sandbox list"
  fi
}

# =============================================================================
# Phase 5: Gateway kill recovery (destructive — runs last)
# =============================================================================

test_sbx_06_gateway_recovery() {
  log "=== TC-SBX-06: Gateway Auto-Recovery ==="
  require_sandbox "$SANDBOX_A" "TC-SBX-06" || return

  local container="openshell-cluster-nemoclaw"
  if ! docker ps -q --filter "name=$container" | grep -q .; then
    skip "TC-SBX-06" "Gateway container '$container' not running"
    return
  fi

  log "  Killing gateway container (simulates Docker crash)..."
  docker kill "$container" 2>/dev/null || true
  sleep 5

  local container_state
  container_state=$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null || echo "removed")
  log "  Container state after kill: $container_state"
  if [[ "$container_state" == "true" ]]; then
    skip "TC-SBX-06" "Container still running after docker kill"
    return
  fi

  local status_output
  status_output=$(mktemp /tmp/sbx06-status-output.XXXXXX)

  log "  Running nemoclaw status in background..."
  nemoclaw "$SANDBOX_A" status >"$status_output" 2>&1 &
  local status_pid=$!

  local recovered=false
  local docker_restarted=false
  for i in $(seq 1 40); do
    sleep 15
    local cstate
    cstate=$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null || echo "removed")
    [[ "$cstate" == "true" ]] && docker_restarted=true

    if ! kill -0 "$status_pid" 2>/dev/null; then
      local exit_code=0
      wait "$status_pid" 2>/dev/null || exit_code=$?
      log "  nemoclaw status exited with code $exit_code after $((i * 15))s"
      if [[ $exit_code -eq 0 ]]; then
        recovered=true
      fi
      break
    fi
    log "  [${i}] +$((i * 15))s | container: $cstate"
  done

  if kill -0 "$status_pid" 2>/dev/null; then
    log "  nemoclaw status still running after 10 min — killing"
    kill "$status_pid" 2>/dev/null || true
    wait "$status_pid" 2>/dev/null || true
  fi

  log "  Output:"
  head -20 "$status_output" 2>/dev/null | while IFS= read -r line; do log "    $line"; done
  rm -f "$status_output"

  if $recovered; then
    pass "TC-SBX-06: Gateway recovered after docker kill"
  elif ! $docker_restarted; then
    skip "TC-SBX-06" "Docker did not restart gateway container on this runner"
  else
    fail "TC-SBX-06: Gateway Recovery" "nemoclaw status did not recover the gateway"
  fi
}

# =============================================================================
# Phase 3: Multi-sandbox (onboards sandbox B alongside A)
# =============================================================================

test_sbx_10_multi_sandbox_metadata() {
  log "=== TC-SBX-10: Multi-Sandbox Metadata ==="
  require_sandbox "$SANDBOX_A" "TC-SBX-10" || return

  log "  Onboarding second sandbox '$SANDBOX_B'..."
  if ! CHAT_UI_URL="http://127.0.0.1:18790" onboard_sandbox "$SANDBOX_B"; then
    fail "TC-SBX-10: Multi-Sandbox" "Sandbox '$SANDBOX_B' failed to onboard"
    return
  fi

  local output
  output=$(nemoclaw list 2>&1)

  local found_a=false found_b=false
  echo "$output" | grep -q "$SANDBOX_A" && found_a=true
  echo "$output" | grep -q "$SANDBOX_B" && found_b=true

  if $found_a && $found_b; then
    pass "TC-SBX-10: Both sandboxes visible in nemoclaw list"
  else
    fail "TC-SBX-10: Multi-Sandbox" "Missing sandbox (A=$found_a, B=$found_b)"
    return
  fi

  local meta_ok=true
  for sb in "$SANDBOX_A" "$SANDBOX_B"; do
    local sb_meta
    sb_meta=$(echo "$output" | grep -A1 "$sb" | tail -1)
    if [[ -z "$sb_meta" ]] || ! echo "$sb_meta" | grep -q "model:"; then
      log "  $sb: metadata line missing or no model field"
      meta_ok=false
    elif echo "$sb_meta" | grep -q "model: unknown"; then
      log "  $sb: model is unknown"
      meta_ok=false
    fi
    if [[ -z "$sb_meta" ]] || ! echo "$sb_meta" | grep -q "provider:"; then
      log "  $sb: metadata line missing or no provider field"
      meta_ok=false
    elif echo "$sb_meta" | grep -q "provider: unknown"; then
      log "  $sb: provider is unknown"
      meta_ok=false
    fi
  done

  if $meta_ok; then
    pass "TC-SBX-10: Both sandboxes have non-empty metadata"
  else
    fail "TC-SBX-10: Multi-Sandbox Metadata" "One or more sandboxes have unknown model/provider"
  fi
}

test_sbx_11_network_isolation() {
  log "=== TC-SBX-11: Sandbox Network Isolation ==="
  require_sandbox "$SANDBOX_A" "TC-SBX-11" || return
  require_sandbox "$SANDBOX_B" "TC-SBX-11" || return

  # Use node (always available) instead of curl (removed by hardening).
  # Isolation is enforced by the OpenShell proxy — blocked requests return
  # HTTP 403. Connection errors (ENOTFOUND, ECONNREFUSED, TIMEOUT) also
  # count as isolation. Only HTTP 200 would indicate a breach.
  log "  Testing: sandbox A cannot reach sandbox B by hostname..."
  local probe_a
  probe_a=$(sandbox_exec_for "$SANDBOX_A" "node -e \"
const http = require('http');
const req = http.get('http://${SANDBOX_B}:18789/', (res) => {
  console.log('STATUS_' + res.statusCode);
  res.resume();
});
req.on('error', (e) => console.log('ERROR: ' + e.message));
req.setTimeout(5000, () => { req.destroy(); console.log('TIMEOUT'); });
\"" 2>&1) || true

  if [[ -z "$probe_a" ]]; then
    fail "TC-SBX-11: Isolation (A→B)" "Empty response — SSH or infrastructure failure"
  elif echo "$probe_a" | grep -qiE "STATUS_403|ERROR|TIMEOUT"; then
    pass "TC-SBX-11: Sandbox A cannot reach sandbox B ($(echo "$probe_a" | grep -oE 'STATUS_[0-9]+|ERROR|TIMEOUT' | head -1))"
  elif echo "$probe_a" | grep -qE "STATUS_[0-9]+"; then
    fail "TC-SBX-11: Isolation (A→B)" "Sandbox A reached sandbox B ($(echo "$probe_a" | grep -oE 'STATUS_[0-9]+' | head -1))"
  else
    fail "TC-SBX-11: Isolation (A→B)" "Unexpected probe output: $(echo "$probe_a" | head -3)"
  fi

  log "  Testing reverse: sandbox B cannot reach sandbox A..."
  local probe_b
  probe_b=$(sandbox_exec_for "$SANDBOX_B" "node -e \"
const http = require('http');
const req = http.get('http://${SANDBOX_A}:18789/', (res) => {
  console.log('STATUS_' + res.statusCode);
  res.resume();
});
req.on('error', (e) => console.log('ERROR: ' + e.message));
req.setTimeout(5000, () => { req.destroy(); console.log('TIMEOUT'); });
\"" 2>&1) || true

  if [[ -z "$probe_b" ]]; then
    fail "TC-SBX-11: Isolation (B→A)" "Empty response — SSH or infrastructure failure"
  elif echo "$probe_b" | grep -qiE "STATUS_403|ERROR|TIMEOUT"; then
    pass "TC-SBX-11: Sandbox B cannot reach sandbox A ($(echo "$probe_b" | grep -oE 'STATUS_[0-9]+|ERROR|TIMEOUT' | head -1))"
  elif echo "$probe_b" | grep -qE "STATUS_[0-9]+"; then
    fail "TC-SBX-11: Isolation (B→A)" "Sandbox B reached sandbox A ($(echo "$probe_b" | grep -oE 'STATUS_[0-9]+' | head -1))"
  else
    fail "TC-SBX-11: Isolation (B→A)" "Unexpected probe output: $(echo "$probe_b" | head -3)"
  fi
}

# ── Teardown ─────────────────────────────────────────────────────────────────
teardown() {
  # Disable errexit during teardown — cleanup must be best-effort
  set +e
  log ""
  log "=== Teardown ==="
  for sb in "$SANDBOX_B" "$SANDBOX_A"; do
    if nemoclaw list 2>/dev/null | grep -q "$sb"; then
      log "Destroying sandbox '$sb'..."
      nemoclaw "$sb" destroy --yes 2>/dev/null || true
    fi
  done
  # Clean up gateway if no sandboxes remain
  openshell gateway destroy -g nemoclaw 2>/dev/null || true
  # Do not unlink ~/.nemoclaw/onboard.lock: see rationale in
  # test/e2e/lib/sandbox-teardown.sh — the lock is PID-ownership-aware
  # and onboard cleans up stale locks itself.
  log "Teardown complete"
  set -e
}

# ── Summary ──────────────────────────────────────────────────────────────────
summary() {
  echo ""
  echo "============================================================"
  echo "  TEST SUMMARY"
  echo "============================================================"
  echo -e "  ${GREEN}PASS: $PASS${NC}"
  echo -e "  ${RED}FAIL: $FAIL${NC}"
  echo -e "  ${YELLOW}SKIP: $SKIP${NC}"
  echo "  TOTAL: $TOTAL"
  echo "============================================================"
  echo "  Log: $LOG_FILE"
  echo "============================================================"
  echo ""

  if [[ $FAIL -gt 0 ]]; then
    exit 1
  fi
  exit 0
}

# ── Main ─────────────────────────────────────────────────────────────────────
main() {
  echo ""
  echo "============================================================"
  echo "  NemoClaw Sandbox Operations E2E Test Suite"
  echo "  $(date)"
  echo "============================================================"
  echo ""

  preflight
  setup_sandbox_a

  # Phase 1: Basic operations (sandbox A alive)
  test_sbx_01_list_sandboxes
  test_sbx_02_connect_chat
  test_sbx_03_status_fields
  test_sbx_04_log_streaming

  # Phase 2: Non-destructive recovery (sandbox A stays alive)
  test_sbx_07_registry_rebuild
  test_sbx_08_process_recovery

  # Phase 3: Multi-sandbox (onboards sandbox B alongside A)
  test_sbx_10_multi_sandbox_metadata
  test_sbx_11_network_isolation

  # Phase 4: Cleanup verification (destroys sandbox B)
  test_sbx_05_destroy_cleanup "$SANDBOX_B"

  # Phase 5: Gateway kill recovery (destructive — runs last)
  test_sbx_06_gateway_recovery

  # Report — teardown runs via EXIT trap, no need to call explicitly
  trap - EXIT
  teardown
  summary
}

trap teardown EXIT
main "$@"
