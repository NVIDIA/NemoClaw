#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# =============================================================================
# test-inference-routing.sh
# NemoClaw Inference Error Classification E2E Tests
#
# Validates that onboard produces classified, human-readable error messages
# when inference validation fails — not raw stack traces.
#
# Covers:
#   TC-INF-05: Credential isolation inside sandbox
#   TC-INF-06: Invalid API key → classified "credential" error
#   TC-INF-07: Unreachable endpoint → classified "transport" error
#
# PR-safe: no real API keys or secrets needed. Uses intentionally invalid
# credentials and unreachable endpoints to trigger error paths.
#
# Prerequisites:
#   - NemoClaw installed (nemoclaw on PATH)
#   - Docker running
#   - openshell on PATH
# =============================================================================

set -euo pipefail

# ── Overall timeout ──────────────────────────────────────────────────────────
if [ -z "${NEMOCLAW_E2E_NO_TIMEOUT:-}" ]; then
  export NEMOCLAW_E2E_NO_TIMEOUT=1
  TIMEOUT_SECONDS="${NEMOCLAW_E2E_TIMEOUT_SECONDS:-1200}"
  if command -v gtimeout >/dev/null 2>&1; then
    exec gtimeout -s TERM "$TIMEOUT_SECONDS" bash "$0" "$@"
  elif command -v timeout >/dev/null 2>&1; then
    exec timeout -s TERM "$TIMEOUT_SECONDS" bash "$0" "$@"
  fi
fi

# macOS uses gtimeout (from coreutils); Linux uses timeout
if command -v gtimeout &>/dev/null; then
  TIMEOUT_CMD="gtimeout"
elif command -v timeout &>/dev/null; then
  TIMEOUT_CMD="timeout"
else
  echo "ERROR: Neither timeout nor gtimeout found. Install coreutils: brew install coreutils"
  exit 1
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

PASS=0
FAIL=0
SKIP=0
TOTAL=0

LOG_FILE="test-inference-routing-$(date +%Y%m%d-%H%M%S).log"

# Log a timestamped message to stdout and the log file.
log() { echo -e "${CYAN}[$(date +%H:%M:%S)]${NC} $*" | tee -a "$LOG_FILE"; }
# Record a passing test assertion.
pass() {
  ((PASS += 1))
  ((TOTAL += 1))
  echo -e "${GREEN}  PASS${NC} $1" | tee -a "$LOG_FILE"
}
# Record a failing test assertion with a reason.
fail() {
  ((FAIL += 1))
  ((TOTAL += 1))
  echo -e "${RED}  FAIL${NC} $1 — $2" | tee -a "$LOG_FILE"
}
# Record a skipped test with a reason.
skip() {
  ((SKIP += 1))
  ((TOTAL += 1))
  echo -e "${YELLOW}  SKIP${NC} $1 — $2" | tee -a "$LOG_FILE"
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
install_nemoclaw() {
  if command -v nemoclaw &>/dev/null; then
    log "nemoclaw already installed: $(nemoclaw --version 2>/dev/null || echo 'unknown')"
    return 0
  fi

  log "=== Installing NemoClaw via install.sh ==="

  # Use a dummy key so install.sh doesn't prompt — the key will fail
  # validation, but install.sh only needs it for the onboard step which
  # we control separately in each test case.
  NVIDIA_API_KEY="nvapi-DUMMY-FOR-INSTALL" \
    NEMOCLAW_NON_INTERACTIVE=1 \
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
    bash "$REPO_ROOT/install.sh" --non-interactive --yes-i-accept-third-party-software \
    2>&1 | tee -a "$LOG_FILE" || true

  # Source shell profile to pick up PATH changes
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

  # Install may fail at onboard (bad key) but CLI should still be available
  if ! command -v nemoclaw &>/dev/null; then
    echo -e "${RED}FATAL: nemoclaw not found on PATH after install${NC}"
    exit 1
  fi

  log "nemoclaw installed: $(nemoclaw --version 2>/dev/null || echo 'unknown')"

  # Clean up any sandbox the installer might have partially created
  rm -f "$HOME/.nemoclaw/onboard.lock" 2>/dev/null || true
}

# ── Pre-flight ───────────────────────────────────────────────────────────────
preflight() {
  log "=== Pre-flight checks ==="

  if ! docker info &>/dev/null; then
    echo -e "${RED}ERROR: Docker is not running.${NC}"
    exit 1
  fi
  log "Docker is running"

  install_nemoclaw

  log "nemoclaw: $(nemoclaw --version 2>/dev/null || echo 'unknown')"
  log "timeout: $TIMEOUT_CMD"
  log "Pre-flight complete"
  echo ""
}

# ── Sandbox helpers ───────────────────────────────────────────────────────────
SANDBOX_NAME="e2e-inf-cred"

# Execute a command inside the sandbox via nemoclaw connect.
sandbox_exec() {
  local cmd="$1"
  local ssh_cfg
  ssh_cfg="$(mktemp)"
  if ! openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_cfg" 2>/dev/null; then
    log "  [sandbox_exec] Failed to get SSH config"
    rm -f "$ssh_cfg"
    echo ""
    return 1
  fi
  local result ssh_exit=0
  result=$($TIMEOUT_CMD 60 ssh -F "$ssh_cfg" \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 -o LogLevel=ERROR \
    "openshell-${SANDBOX_NAME}" "$cmd" 2>&1) || ssh_exit=$?
  rm -f "$ssh_cfg"
  if [[ $ssh_exit -ne 0 ]]; then
    log "  [sandbox_exec] SSH command failed (exit $ssh_exit)"
  fi
  echo "$result"
  return $ssh_exit
}

# =============================================================================
# TC-INF-05: Credential not visible inside sandbox
# =============================================================================
test_inf_05_credential_isolation() {
  log "=== TC-INF-05: Credential Isolation ==="

  # Determine the real API key to search for
  local real_key="${NVIDIA_API_KEY:-}"
  if [[ -z "$real_key" ]]; then
    skip "TC-INF-05" "NVIDIA_API_KEY not set — cannot test credential isolation"
    return
  fi

  # Always recreate to avoid stale state hiding credential plumbing regressions
  if nemoclaw list 2>/dev/null | grep -q "$SANDBOX_NAME"; then
    log "  Removing existing sandbox '$SANDBOX_NAME' to avoid stale state..."
    nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true
  fi

  log "  Onboarding sandbox '$SANDBOX_NAME' for credential test..."
  rm -f "$HOME/.nemoclaw/onboard.lock" 2>/dev/null || true
  local onboard_exit=0
  local escaped_key
  escaped_key=$(printf '%s\n' "$real_key" | sed 's/[&/\]/\\&/g')
  NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME" \
    NEMOCLAW_NON_INTERACTIVE=1 \
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
    NEMOCLAW_POLICY_TIER="open" \
    nemoclaw onboard --non-interactive --yes-i-accept-third-party-software \
    2>&1 | sed "s/${escaped_key}/REDACTED/g" | tee -a "$LOG_FILE" || onboard_exit=$?
  if [[ $onboard_exit -ne 0 ]]; then
    fail "TC-INF-05: Setup" "Onboard failed (exit $onboard_exit)"
    return
  fi

  # Capture sandbox environment and process list once
  log "  Capturing sandbox environment..."
  local sandbox_env
  sandbox_env=$(sandbox_exec "env 2>/dev/null") || true
  if [[ -z "$sandbox_env" ]]; then
    fail "TC-INF-05: Setup" "Could not capture sandbox environment (SSH failure)"
    return
  fi

  log "  Capturing sandbox process list..."
  local sandbox_ps ps_exit=0
  sandbox_ps=$(sandbox_exec "ps aux 2>/dev/null || ps -ef 2>/dev/null") || ps_exit=$?

  # TC-INF-05a: Real API key not in environment variables
  if echo "$sandbox_env" | grep -qF "$real_key"; then
    fail "TC-INF-05a: Env vars" "Real API key found in sandbox environment"
  else
    pass "TC-INF-05a: Real API key absent from sandbox environment"
  fi

  # TC-INF-05b: Real API key not in process list
  if [[ $ps_exit -ne 0 || -z "$sandbox_ps" ]]; then
    skip "TC-INF-05b: Process list" "ps not available in hardened sandbox"
  elif echo "$sandbox_ps" | grep -qF "$real_key"; then
    fail "TC-INF-05b: Process list" "Real API key found in sandbox process list"
  else
    pass "TC-INF-05b: Real API key absent from sandbox process list"
  fi

  # TC-INF-05c: Real API key not on filesystem
  # Pass key via base64 to avoid shell escaping issues and command-line exposure
  log "  Scanning sandbox filesystem..."
  local key_b64
  key_b64=$(printf '%s' "$real_key" | base64 | tr -d '\n')
  local fs_scan
  fs_scan=$(sandbox_exec "node -e \"
const fs = require('fs');
const { execSync } = require('child_process');
const key = Buffer.from('$key_b64', 'base64').toString('utf8');
if (!key) { console.log('NO_KEY_PROVIDED'); process.exit(0); }
try {
  const out = execSync('find /sandbox /home /tmp -type f -size -1M 2>/dev/null | head -200', { encoding: 'utf8' });
  const files = out.trim().split('\\n').filter(Boolean);
  for (const f of files) {
    try {
      const content = fs.readFileSync(f, 'utf8');
      if (content.includes(key)) { console.log('FOUND:' + f); }
    } catch {}
  }
  console.log('SCAN_DONE');
} catch { console.log('SCAN_ERROR'); }
\"") || true

  if echo "$fs_scan" | grep -q "FOUND:"; then
    local found_files
    found_files=$(echo "$fs_scan" | grep "FOUND:" | sed 's/FOUND://')
    fail "TC-INF-05c: Filesystem" "Real API key found in: $found_files"
  elif echo "$fs_scan" | grep -q "NO_KEY_PROVIDED"; then
    fail "TC-INF-05c: Filesystem" "Key was not passed to the scanner"
  elif echo "$fs_scan" | grep -q "SCAN_DONE"; then
    pass "TC-INF-05c: Real API key absent from sandbox filesystem"
  else
    fail "TC-INF-05c: Filesystem" "Scan failed: ${fs_scan:0:200}"
  fi

  # TC-INF-05d: Placeholder token IS present in environment
  local placeholder
  placeholder=$(sandbox_exec "printenv NVIDIA_API_KEY 2>/dev/null || true") || true
  if [[ -n "$placeholder" && "$placeholder" != "$real_key" ]]; then
    pass "TC-INF-05d: Placeholder token present in sandbox (not the real key)"
  elif [[ "$placeholder" == "$real_key" ]]; then
    fail "TC-INF-05d: Placeholder" "Sandbox has the REAL key, not a placeholder"
  else
    skip "TC-INF-05d: Placeholder" "NVIDIA_API_KEY not set in sandbox (placeholder injection may not be active)"
  fi
}

# =============================================================================
# TC-INF-06: Invalid API key → classified error message
# =============================================================================
test_inf_06_invalid_api_key() {
  log "=== TC-INF-06: Invalid API Key → Classified Error ==="

  rm -f "$HOME/.nemoclaw/onboard.lock" 2>/dev/null || true

  local output exit_code=0
  output=$(NVIDIA_API_KEY="nvapi-INTENTIONALLY-INVALID-KEY-FOR-E2E-TEST" \
    NEMOCLAW_NON_INTERACTIVE=1 \
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
    NEMOCLAW_SANDBOX_NAME="e2e-invalid-key" \
    $TIMEOUT_CMD 120 nemoclaw onboard --non-interactive --yes-i-accept-third-party-software \
    2>&1) || exit_code=$?

  # 1. Exit code should be non-zero (onboard should fail)
  if [[ $exit_code -eq 0 ]]; then
    fail "TC-INF-06: Exit code" "Onboard succeeded with invalid key (expected failure)"
    return
  fi
  pass "TC-INF-06: Onboard failed as expected (exit $exit_code)"

  # 2. Output should contain a classified error keyword
  if echo "$output" | grep -qiE "authorization|credential|invalid|401|Unauthorized|api[._-]key"; then
    pass "TC-INF-06: Output contains classified error message"
  else
    fail "TC-INF-06: Error classification" "No classified error keyword found in output"
    log "  First 10 lines of output:"
    echo "$output" | head -10 | while IFS= read -r line; do log "    $line"; done
  fi

  # 3. Output should NOT contain a raw Node.js stack trace
  local stack_count
  stack_count=$(echo "$output" | grep -cE "at Object\.|at Module\.|at node:internal|at process\." || true)
  if [[ $stack_count -gt 0 ]]; then
    fail "TC-INF-06: Stack trace" "Raw Node.js stack trace found ($stack_count lines)"
  else
    pass "TC-INF-06: No raw stack trace in output"
  fi

  # 4. The invalid API key should not appear in plain text in output
  if echo "$output" | grep -qF "INTENTIONALLY-INVALID-KEY-FOR-E2E-TEST"; then
    fail "TC-INF-06: Key exposure" "Invalid API key visible in plain text in output"
  else
    pass "TC-INF-06: API key not exposed in output"
  fi

  # 5. No sandbox should have been created
  if nemoclaw list 2>/dev/null | grep -q "e2e-invalid-key"; then
    fail "TC-INF-06: Sandbox cleanup" "Sandbox was created despite invalid key"
    nemoclaw "e2e-invalid-key" destroy --yes 2>/dev/null || true
  else
    pass "TC-INF-06: No sandbox created (correct)"
  fi

  rm -f "$HOME/.nemoclaw/onboard.lock" 2>/dev/null || true
}

# =============================================================================
# TC-INF-07: Unreachable endpoint → classified error message
# =============================================================================
test_inf_07_unreachable_endpoint() {
  log "=== TC-INF-07: Unreachable Endpoint → Classified Error ==="

  rm -f "$HOME/.nemoclaw/onboard.lock" 2>/dev/null || true

  # Use an RFC 2606 invalid domain — deterministic DNS failure across runners
  local output exit_code=0
  output=$(NVIDIA_API_KEY="nvapi-valid-format-but-fake-key-1234567890" \
    NEMOCLAW_NON_INTERACTIVE=1 \
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
    NEMOCLAW_SANDBOX_NAME="e2e-unreachable" \
    NEMOCLAW_PROVIDER="compatible-endpoint" \
    NEMOCLAW_COMPATIBLE_ENDPOINT_URL="https://nemoclaw-e2e.invalid/v1" \
    NEMOCLAW_COMPATIBLE_ENDPOINT_MODEL="test-model" \
    COMPATIBLE_API_KEY="fake-key-for-unreachable-test" \
    $TIMEOUT_CMD 120 nemoclaw onboard --non-interactive --yes-i-accept-third-party-software \
    2>&1) || exit_code=$?

  # 1. Exit code should be non-zero
  if [[ $exit_code -eq 0 ]]; then
    fail "TC-INF-07: Exit code" "Onboard succeeded with unreachable endpoint (expected failure)"
    return
  fi
  pass "TC-INF-07: Onboard failed as expected (exit $exit_code)"

  # 2. Output should contain transport/connection error keywords
  if echo "$output" | grep -qiE "unreachable|timeout|connect|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN|No route to host|transport|network|endpoint|dns"; then
    pass "TC-INF-07: Output contains transport error classification"
  else
    fail "TC-INF-07: Error classification" "No transport error keyword found"
    log "  First 10 lines of output:"
    echo "$output" | head -10 | while IFS= read -r line; do log "    $line"; done
  fi

  # 3. No raw stack trace
  local stack_count
  stack_count=$(echo "$output" | grep -cE "at Object\.|at Module\.|at node:internal|at process\." || true)
  if [[ $stack_count -gt 0 ]]; then
    fail "TC-INF-07: Stack trace" "Raw Node.js stack trace found ($stack_count lines)"
  else
    pass "TC-INF-07: No raw stack trace in output"
  fi

  # 4. No sandbox should have been created
  if nemoclaw list 2>/dev/null | grep -q "e2e-unreachable"; then
    fail "TC-INF-07: Sandbox cleanup" "Sandbox was created despite unreachable endpoint"
    nemoclaw "e2e-unreachable" destroy --yes 2>/dev/null || true
  else
    pass "TC-INF-07: No sandbox created (correct)"
  fi

  rm -f "$HOME/.nemoclaw/onboard.lock" 2>/dev/null || true
}

# ── Teardown ─────────────────────────────────────────────────────────────────
teardown() {
  set +e
  rm -f "$HOME/.nemoclaw/onboard.lock" 2>/dev/null || true
  nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true
  nemoclaw "e2e-invalid-key" destroy --yes 2>/dev/null || true
  nemoclaw "e2e-unreachable" destroy --yes 2>/dev/null || true
  set -e
}

# ── Summary ──────────────────────────────────────────────────────────────────
summary() {
  echo ""
  echo "============================================================"
  echo "  Inference Error Classification E2E Results"
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
  echo "  NemoClaw Inference Error Classification E2E Tests"
  echo "  $(date)"
  echo "============================================================"
  echo ""

  preflight

  test_inf_05_credential_isolation
  test_inf_06_invalid_api_key
  test_inf_07_unreachable_endpoint

  trap - EXIT
  teardown
  summary
}

trap teardown EXIT
main "$@"
