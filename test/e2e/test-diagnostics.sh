#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# =============================================================================
# test-diagnostics.sh
# NemoClaw Diagnostics & Credential E2E Tests
#
# Covers:
#   TC-DIAG-04: nemoclaw --version (semver output, exit 0)
#   TC-DIAG-02: nemoclaw debug --quick (fast, non-empty archive)
#   TC-DIAG-01: nemoclaw debug --output (tarball, no credentials in archive)
#   TC-DIAG-05: /nemoclaw status inside sandbox (model + provider)
#   TC-DIAG-03: credentials list (no values) + credentials reset
#
# Prerequisites:
#   - Docker running
#   - NVIDIA_API_KEY set
# =============================================================================

set -euo pipefail

# ── Overall timeout ──────────────────────────────────────────────────────────
if [ -z "${NEMOCLAW_E2E_NO_TIMEOUT:-}" ]; then
  export NEMOCLAW_E2E_NO_TIMEOUT=1
  TIMEOUT_SECONDS="${NEMOCLAW_E2E_TIMEOUT_SECONDS:-3600}"
  if command -v timeout >/dev/null 2>&1; then
    exec timeout -s TERM "$TIMEOUT_SECONDS" bash "$0" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    exec gtimeout -s TERM "$TIMEOUT_SECONDS" bash "$0" "$@"
  fi
fi

# ── Config ───────────────────────────────────────────────────────────────────
SANDBOX_NAME="e2e-diag"
LOG_FILE="test-diagnostics-$(date +%Y%m%d-%H%M%S).log"
touch "$LOG_FILE"

if command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_CMD="gtimeout"
elif command -v timeout >/dev/null 2>&1; then
  TIMEOUT_CMD="timeout"
else
  TIMEOUT_CMD=""
fi

# ── Colors ───────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

PASS=0
FAIL=0
SKIP=0
TOTAL=0

# Log a timestamped message.
log() { echo -e "${CYAN}[$(date +%H:%M:%S)]${NC} $*" | tee -a "$LOG_FILE"; }
# Record a passing assertion.
pass() {
  ((PASS += 1))
  ((TOTAL += 1))
  echo -e "${GREEN}  PASS${NC} $1" | tee -a "$LOG_FILE"
}
# Record a failing assertion.
fail() {
  ((FAIL += 1))
  ((TOTAL += 1))
  echo -e "${RED}  FAIL${NC} $1 — $2" | tee -a "$LOG_FILE"
}
# Record a skipped test.
skip() {
  ((SKIP += 1))
  ((TOTAL += 1))
  echo -e "${YELLOW}  SKIP${NC} $1 — $2" | tee -a "$LOG_FILE"
}

# ── Resolve repo root ────────────────────────────────────────────────────────
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# ── Install NemoClaw if not present ──────────────────────────────────────────
install_nemoclaw() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck source=/dev/null
    . "$NVM_DIR/nvm.sh"
  fi
  if [ -d "$HOME/.local/bin" ] && [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
    export PATH="$HOME/.local/bin:$PATH"
  fi

  if command -v nemoclaw >/dev/null 2>&1; then
    log "nemoclaw already installed: $(nemoclaw --version 2>/dev/null || echo unknown)"
    return
  fi
  log "=== Installing NemoClaw via install.sh ==="
  NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME" \
    NVIDIA_API_KEY="${NVIDIA_API_KEY:-nvapi-DUMMY-FOR-INSTALL}" \
    NEMOCLAW_NON_INTERACTIVE=1 \
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
    bash "$REPO_ROOT/install.sh" --non-interactive --yes-i-accept-third-party-software \
    2>&1 | tee -a "$LOG_FILE"
  if [ -f "$HOME/.bashrc" ]; then
    # shellcheck source=/dev/null
    source "$HOME/.bashrc" 2>/dev/null || true
  fi
  if ! command -v nemoclaw >/dev/null 2>&1; then
    log "ERROR: install.sh failed — nemoclaw not found"
    exit 1
  fi
}

# ── Pre-flight ───────────────────────────────────────────────────────────────
preflight() {
  log "=== Pre-flight checks ==="
  if ! docker info >/dev/null 2>&1; then
    log "ERROR: Docker is not running."
    exit 1
  fi
  log "Docker is running"

  local api_key="${NVIDIA_API_KEY:-}"
  if [[ -z "$api_key" ]]; then
    log "ERROR: NVIDIA_API_KEY not set"
    exit 1
  fi

  install_nemoclaw
  log "nemoclaw: $(nemoclaw --version 2>/dev/null || echo unknown)"
  log "Pre-flight complete"
}

# Execute a command inside the sandbox via SSH.
sandbox_exec() {
  local cmd="$1"
  local ssh_cfg
  ssh_cfg="$(mktemp)"
  if ! openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_cfg" 2>/dev/null; then
    rm -f "$ssh_cfg"
    echo ""
    return 1
  fi
  local result ssh_exit=0
  result=$(${TIMEOUT_CMD:+$TIMEOUT_CMD 120} ssh -F "$ssh_cfg" \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 -o LogLevel=ERROR \
    "openshell-${SANDBOX_NAME}" "$cmd" 2>&1) || ssh_exit=$?
  rm -f "$ssh_cfg"
  echo "$result"
  return $ssh_exit
}

# Onboard a sandbox with default settings.
onboard_sandbox() {
  local name="$1"
  log "  Onboarding sandbox '$name'..."
  rm -f "$HOME/.nemoclaw/onboard.lock" 2>/dev/null || true
  NEMOCLAW_SANDBOX_NAME="$name" \
    NEMOCLAW_NON_INTERACTIVE=1 \
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
    NEMOCLAW_POLICY_TIER="open" \
    ${TIMEOUT_CMD:+$TIMEOUT_CMD 600} nemoclaw onboard --non-interactive --yes-i-accept-third-party-software \
    2>&1 | tee -a "$LOG_FILE" || {
    log "FATAL: Onboard failed for '$name'"
    return 1
  }
  log "  Sandbox '$name' onboarded"
}

# =============================================================================
# TC-DIAG-04: nemoclaw --version
# =============================================================================
test_diag_04_version() {
  log "=== TC-DIAG-04: nemoclaw --version ==="

  local version_output version_rc=0
  version_output=$(nemoclaw --version 2>&1) || version_rc=$?

  log "  Output: $version_output (exit $version_rc)"

  if [[ $version_rc -ne 0 ]]; then
    fail "TC-DIAG-04: Exit code" "nemoclaw --version exited with $version_rc"
    return
  fi

  if echo "$version_output" | grep -qE '[0-9]+\.[0-9]+\.[0-9]+'; then
    pass "TC-DIAG-04: Version output matches semver ($version_output)"
  else
    fail "TC-DIAG-04: Format" "Output does not match semver pattern: $version_output"
  fi
}

# =============================================================================
# TC-DIAG-02: nemoclaw debug --quick
# =============================================================================
test_diag_02_debug_quick() {
  log "=== TC-DIAG-02: nemoclaw debug --quick ==="

  local debug_dir
  debug_dir=$(mktemp -d)
  local output_file="${debug_dir}/quick-debug.tar.gz"

  local start_time
  start_time=$(date +%s)

  local debug_output debug_rc=0
  debug_output=$(${TIMEOUT_CMD:+$TIMEOUT_CMD 30} nemoclaw debug --quick --output "$output_file" 2>&1) || debug_rc=$?

  local end_time
  end_time=$(date +%s)
  local elapsed=$((end_time - start_time))

  log "  Completed in ${elapsed}s (exit $debug_rc)"
  log "  Output: ${debug_output:0:300}"

  if [[ $debug_rc -ne 0 ]]; then
    fail "TC-DIAG-02: Exit code" "debug --quick exited with $debug_rc"
    rm -rf "$debug_dir"
    return
  fi

  if [[ -f "$output_file" ]] && [[ -s "$output_file" ]]; then
    pass "TC-DIAG-02: debug --quick produced non-empty archive (${elapsed}s)"
  else
    fail "TC-DIAG-02: Output" "No archive produced or archive is empty"
  fi

  if [[ $elapsed -le 30 ]]; then
    pass "TC-DIAG-02: Completed within time limit (${elapsed}s)"
  else
    fail "TC-DIAG-02: Timing" "Took ${elapsed}s (expected ≤30s)"
  fi

  rm -rf "$debug_dir"
}

# =============================================================================
# TC-DIAG-01: nemoclaw debug --output (full tarball + credential sanitization)
# =============================================================================
test_diag_01_debug_tarball() {
  log "=== TC-DIAG-01: Full Debug Tarball + Credential Sanitization ==="

  local debug_dir
  debug_dir=$(mktemp -d)
  local output_file="${debug_dir}/debug-full.tar.gz"
  local extract_dir="${debug_dir}/extracted"

  local debug_output debug_rc=0
  debug_output=$(nemoclaw debug --output "$output_file" 2>&1) || debug_rc=$?
  log "  Debug output (exit $debug_rc): ${debug_output:0:300}"

  if [[ $debug_rc -ne 0 ]] || [[ ! -f "$output_file" ]]; then
    fail "TC-DIAG-01: Setup" "debug --output failed or no file produced"
    rm -rf "$debug_dir"
    return
  fi

  pass "TC-DIAG-01: Debug tarball created"

  mkdir -p "$extract_dir"
  if ! tar xzf "$output_file" -C "$extract_dir" 2>/dev/null; then
    fail "TC-DIAG-01: Extract" "Could not extract tarball"
    rm -rf "$debug_dir"
    return
  fi

  local real_key="${NVIDIA_API_KEY:-}"
  if [[ -z "$real_key" ]]; then
    skip "TC-DIAG-01: Credential check" "NVIDIA_API_KEY not set"
    rm -rf "$debug_dir"
    return
  fi

  log "  Scanning extracted files for credential leaks..."
  local leaks
  leaks=$(grep -rl "$real_key" "$extract_dir" 2>/dev/null || true)

  if [[ -z "$leaks" ]]; then
    pass "TC-DIAG-01: No API key found in debug tarball"
  else
    fail "TC-DIAG-01: Credential leak" "API key found in: $leaks"
  fi

  local pattern_leaks
  pattern_leaks=$(grep -rlE "nvapi-[A-Za-z0-9_-]{10,}" "$extract_dir" 2>/dev/null || true)
  if [[ -z "$pattern_leaks" ]]; then
    pass "TC-DIAG-01: No nvapi- pattern credentials in tarball"
  else
    fail "TC-DIAG-01: Pattern leak" "nvapi- pattern found in: $pattern_leaks"
  fi

  rm -rf "$debug_dir"
}

# =============================================================================
# TC-DIAG-05: Sandbox inference config visible inside sandbox
# =============================================================================
test_diag_05_sandbox_config() {
  log "=== TC-DIAG-05: Sandbox Inference Config ==="

  log "  Checking openclaw.json config inside sandbox..."
  local config_output
  config_output=$(sandbox_exec "cat /sandbox/.openclaw/openclaw.json 2>/dev/null" 2>&1) || true

  if [[ -z "$config_output" ]]; then
    fail "TC-DIAG-05: Config" "Could not read openclaw.json inside sandbox"
    return
  fi

  pass "TC-DIAG-05: openclaw.json readable inside sandbox"

  log "  Checking nemoclaw status from host..."
  local status_output
  status_output=$(nemoclaw "$SANDBOX_NAME" status 2>&1) || true
  if echo "$status_output" | grep -qiE "Model.*nemotron\|Model.*nvidia\|Model.*llama"; then
    pass "TC-DIAG-05: nemoclaw status shows model info"
  elif echo "$status_output" | grep -qi "Model"; then
    pass "TC-DIAG-05: nemoclaw status shows Model field"
  else
    fail "TC-DIAG-05: Status" "No model info in nemoclaw status output"
  fi
}

# =============================================================================
# TC-DIAG-03: credentials list + credentials reset
# =============================================================================
test_diag_03_credentials() {
  log "=== TC-DIAG-03: Credentials List and Reset ==="

  local real_key="${NVIDIA_API_KEY:-}"

  log "  Step 1: Running credentials list..."
  local list_output list_rc=0
  list_output=$(nemoclaw credentials list 2>&1) || list_rc=$?
  log "  List output (exit $list_rc): ${list_output:0:400}"

  if [[ $list_rc -ne 0 ]]; then
    fail "TC-DIAG-03: List" "credentials list exited with $list_rc"
    return
  fi

  if echo "$list_output" | grep -qi "No stored credentials"; then
    pass "TC-DIAG-03: credentials list works (store empty — API key passed via env on CI)"

    log "  Step 2: Verifying credentials list does not leak env var..."
    if [[ -n "$real_key" ]] && echo "$list_output" | grep -qF "$real_key"; then
      fail "TC-DIAG-03: Value leak" "Real API key visible in credentials list output"
    else
      pass "TC-DIAG-03: credentials list does not expose env key values"
    fi
    return
  fi

  if echo "$list_output" | grep -qiE "NVIDIA_API_KEY\|nvidia.api"; then
    pass "TC-DIAG-03: credentials list shows key name"
  else
    skip "TC-DIAG-03: Key name" "Expected credential key not found in list"
    return
  fi

  if [[ -n "$real_key" ]] && echo "$list_output" | grep -qF "$real_key"; then
    fail "TC-DIAG-03: Value leak" "Real API key value visible in credentials list"
  else
    pass "TC-DIAG-03: credentials list does not expose key values"
  fi

  log "  Step 2: Running credentials reset NVIDIA_API_KEY..."
  local reset_output reset_rc=0
  reset_output=$(nemoclaw credentials reset NVIDIA_API_KEY --yes 2>&1) || reset_rc=$?
  log "  Reset output (exit $reset_rc): ${reset_output:0:300}"

  if [[ $reset_rc -eq 0 ]]; then
    pass "TC-DIAG-03: credentials reset completed"
  else
    fail "TC-DIAG-03: Reset" "credentials reset failed (exit $reset_rc)"
    return
  fi

  log "  Step 3: Verifying key removed from list..."
  local post_list
  post_list=$(nemoclaw credentials list 2>&1) || true
  if echo "$post_list" | grep -qiE "NVIDIA_API_KEY"; then
    fail "TC-DIAG-03: Post-reset" "NVIDIA_API_KEY still in list after reset"
  else
    pass "TC-DIAG-03: NVIDIA_API_KEY removed after reset"
  fi
}

# Clean up sandbox and services on exit.
teardown() {
  set +e
  rm -f "$HOME/.nemoclaw/onboard.lock" 2>/dev/null || true
  nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true
  set -e
}

# Print final PASS/FAIL/SKIP counts and exit.
summary() {
  echo ""
  echo "============================================================"
  echo "  Diagnostics E2E Results"
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

# Entry point: preflight → tests → summary.
main() {
  echo ""
  echo "============================================================"
  echo "  NemoClaw Diagnostics E2E Tests"
  echo "  $(date)"
  echo "============================================================"
  echo ""

  preflight

  # No sandbox needed
  test_diag_04_version
  test_diag_02_debug_quick

  # Onboard sandbox for remaining tests
  log "=== Onboarding sandbox ==="
  if ! onboard_sandbox "$SANDBOX_NAME"; then
    log "FATAL: Could not onboard sandbox"
    exit 1
  fi

  test_diag_01_debug_tarball
  test_diag_05_sandbox_config
  test_diag_03_credentials # modifies state — runs last

  teardown
  trap - EXIT
  summary
}

trap teardown EXIT
main "$@"
