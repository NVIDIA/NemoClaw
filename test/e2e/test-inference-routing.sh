#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# =============================================================================
# test-inference-routing.sh
# NemoClaw Inference Routing E2E Tests
#
# Validates inference routing through the OpenShell gateway proxy for
# multiple providers, credential isolation, and error classification.
#
# Covers:
#   TC-INF-02: OpenAI provider end-to-end inference (requires OPENAI_API_KEY)
#   TC-INF-03: Anthropic provider end-to-end inference (requires ANTHROPIC_API_KEY)
#   TC-INF-05: Credential isolation inside sandbox (requires NVIDIA_API_KEY)
#   TC-INF-06: Invalid API key → classified "credential" error (PR-safe)
#   TC-INF-07: Unreachable endpoint → classified "transport" error (PR-safe)
#   TC-INF-09: Custom OpenAI-compatible endpoint (requires NEMOCLAW_ENDPOINT_URL + COMPATIBLE_API_KEY)
#
# TC-INF-06 and TC-INF-07 are PR-safe (no real API keys needed).
# TC-INF-02, TC-INF-03, TC-INF-05, TC-INF-09 skip gracefully when
# their required API keys are not set.
#
# Prerequisites:
#   - NemoClaw installed (nemoclaw on PATH)
#   - Docker running
#   - openshell on PATH
# =============================================================================

set -euo pipefail

# ── Overall timeout ──────────────────────────────────────────────────────────
TIMEOUT_CMD=""
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_CMD="timeout"
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_CMD="gtimeout"
fi

if [ "${NEMOCLAW_E2E_NO_TIMEOUT:-0}" != "1" ] && [ "${NEMOCLAW_E2E_TIMEOUT_WRAPPED:-0}" != "1" ]; then
  TIMEOUT_SECONDS="${NEMOCLAW_E2E_TIMEOUT_SECONDS:-1200}"
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

# Safe literal string replacement for redacting secrets in log output.
redact_stream() {
  local secret="${1:-}"
  SECRET_TO_REDACT="$secret" python3 -c '
import os, sys
secret = os.environ.get("SECRET_TO_REDACT", "")
data = sys.stdin.read()
sys.stdout.write(data.replace(secret, "REDACTED") if secret else data)
'
}

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
  result=$(run_with_timeout 60 ssh -F "$ssh_cfg" \
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

  # Always recreate to avoid stale state hiding credential plumbing regressions.
  # Unconditional destroy catches not-ready sandboxes that `nemoclaw list` misses.
  log "  Preflight: destroying any existing '$SANDBOX_NAME' sandbox..."
  nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true

  log "  Onboarding sandbox '$SANDBOX_NAME' for credential test..."
  rm -f "$HOME/.nemoclaw/onboard.lock" 2>/dev/null || true
  local onboard_exit=0
  NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME" \
    NEMOCLAW_NON_INTERACTIVE=1 \
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
    NEMOCLAW_POLICY_TIER="open" \
    nemoclaw onboard --non-interactive --yes-i-accept-third-party-software \
    2>&1 | redact_stream "$real_key" | tee -a "$LOG_FILE" || onboard_exit=$?
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
    run_with_timeout 120 nemoclaw onboard --non-interactive --yes-i-accept-third-party-software \
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
    NEMOCLAW_PROVIDER="custom" \
    NEMOCLAW_ENDPOINT_URL="https://nemoclaw-e2e.invalid/v1" \
    NEMOCLAW_MODEL="test-model" \
    COMPATIBLE_API_KEY="fake-key-for-unreachable-test" \
    run_with_timeout 120 nemoclaw onboard --non-interactive --yes-i-accept-third-party-software \
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

# =============================================================================
# TC-INF-02: OpenAI provider end-to-end inference
# =============================================================================
test_inf_02_openai() {
  log "=== TC-INF-02: OpenAI Provider Inference ==="

  local api_key="${OPENAI_API_KEY:-}"
  if [[ -z "$api_key" ]]; then
    skip "TC-INF-02" "OPENAI_API_KEY not set"
    return
  fi

  local sbx_name="e2e-openai"
  local model="${NEMOCLAW_OPENAI_MODEL:-gpt-4o-mini}"
  rm -f "$HOME/.nemoclaw/onboard.lock" 2>/dev/null || true

  log "  Preflight: destroying any existing '$sbx_name' sandbox..."
  nemoclaw "$sbx_name" destroy --yes 2>/dev/null || true

  log "  Onboarding with OpenAI provider, model: $model"
  local onboard_exit=0
  NEMOCLAW_SANDBOX_NAME="$sbx_name" \
    NEMOCLAW_NON_INTERACTIVE=1 \
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
    NEMOCLAW_POLICY_TIER="open" \
    NEMOCLAW_PROVIDER="openai" \
    NEMOCLAW_MODEL="$model" \
    OPENAI_API_KEY="$api_key" \
    run_with_timeout 300 nemoclaw onboard --non-interactive --yes-i-accept-third-party-software \
    2>&1 | redact_stream "$api_key" | tee -a "$LOG_FILE" || onboard_exit=$?

  if [[ $onboard_exit -ne 0 ]]; then
    fail "TC-INF-02: Onboard" "Onboard with OpenAI failed (exit $onboard_exit)"
    return
  fi
  pass "TC-INF-02: Onboard with OpenAI succeeded"

  local ssh_cfg
  ssh_cfg="$(mktemp)"
  if ! openshell sandbox ssh-config "$sbx_name" >"$ssh_cfg" 2>/dev/null; then
    fail "TC-INF-02: SSH" "Could not get SSH config for sandbox"
    rm -f "$ssh_cfg"
    return
  fi

  log "  Sending test prompt through sandbox inference proxy..."
  local response
  response=$(run_with_timeout 90 ssh -F "$ssh_cfg" \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 -o LogLevel=ERROR \
    "openshell-${sbx_name}" \
    "curl -s --max-time 60 https://inference.local/v1/chat/completions \
      -H 'Content-Type: application/json' \
      -d '{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly one word: PONG\"}],\"max_tokens\":50}'" \
    2>&1) || true
  rm -f "$ssh_cfg"

  log "  Response: ${response:0:300}"

  local content
  content=$(echo "$response" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['choices'][0]['message']['content'])" 2>/dev/null) || true

  if [[ -n "$content" ]] && echo "$content" | grep -qi "PONG"; then
    pass "TC-INF-02: OpenAI inference response received through sandbox proxy"
  elif [[ -n "$content" ]]; then
    pass "TC-INF-02: OpenAI response received (content: ${content:0:100})"
  else
    fail "TC-INF-02: Inference" "No valid response from OpenAI through sandbox: ${response:0:200}"
  fi

  nemoclaw "$sbx_name" destroy --yes 2>/dev/null || true
  rm -f "$HOME/.nemoclaw/onboard.lock" 2>/dev/null || true
}

# =============================================================================
# TC-INF-03: Anthropic provider end-to-end inference
# =============================================================================
test_inf_03_anthropic() {
  log "=== TC-INF-03: Anthropic Provider Inference ==="

  local api_key="${ANTHROPIC_API_KEY:-}"
  if [[ -z "$api_key" ]]; then
    skip "TC-INF-03" "ANTHROPIC_API_KEY not set"
    return
  fi

  local sbx_name="e2e-anthropic"
  local model="${NEMOCLAW_ANTHROPIC_MODEL:-claude-sonnet-4-6}"
  rm -f "$HOME/.nemoclaw/onboard.lock" 2>/dev/null || true

  log "  Preflight: destroying any existing '$sbx_name' sandbox..."
  nemoclaw "$sbx_name" destroy --yes 2>/dev/null || true

  log "  Onboarding with Anthropic provider, model: $model"
  local onboard_exit=0
  NEMOCLAW_SANDBOX_NAME="$sbx_name" \
    NEMOCLAW_NON_INTERACTIVE=1 \
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
    NEMOCLAW_POLICY_TIER="open" \
    NEMOCLAW_PROVIDER="anthropic" \
    NEMOCLAW_MODEL="$model" \
    ANTHROPIC_API_KEY="$api_key" \
    run_with_timeout 300 nemoclaw onboard --non-interactive --yes-i-accept-third-party-software \
    2>&1 | redact_stream "$api_key" | tee -a "$LOG_FILE" || onboard_exit=$?

  if [[ $onboard_exit -ne 0 ]]; then
    fail "TC-INF-03: Onboard" "Onboard with Anthropic failed (exit $onboard_exit)"
    return
  fi
  pass "TC-INF-03: Onboard with Anthropic succeeded"

  local ssh_cfg
  ssh_cfg="$(mktemp)"
  if ! openshell sandbox ssh-config "$sbx_name" >"$ssh_cfg" 2>/dev/null; then
    fail "TC-INF-03: SSH" "Could not get SSH config for sandbox"
    rm -f "$ssh_cfg"
    return
  fi

  log "  Sending test prompt through sandbox inference proxy (Anthropic Messages API)..."
  local response
  response=$(run_with_timeout 90 ssh -F "$ssh_cfg" \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 -o LogLevel=ERROR \
    "openshell-${sbx_name}" \
    "curl -s --max-time 60 https://inference.local/v1/messages \
      -H 'Content-Type: application/json' \
      -d '{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly one word: PONG\"}],\"max_tokens\":50}'" \
    2>&1) || true
  rm -f "$ssh_cfg"

  log "  Response: ${response:0:300}"

  local content
  content=$(printf '%s' "$response" | python3 -c "
import sys, json
d = json.load(sys.stdin)
# Anthropic Messages API returns content as array of blocks
if 'content' in d and isinstance(d['content'], list):
    print(''.join(part.get('text', '') for part in d['content'] if isinstance(part, dict)))
# Fallback: OpenAI-compatible format (gateway may translate)
elif 'choices' in d:
    print(d['choices'][0]['message']['content'])
" 2>/dev/null) || true

  if [[ -n "$content" ]] && echo "$content" | grep -qi "PONG"; then
    pass "TC-INF-03: Anthropic inference response received through sandbox proxy"
  elif [[ -n "$content" ]]; then
    pass "TC-INF-03: Anthropic response received (content: ${content:0:100})"
  else
    fail "TC-INF-03: Inference" "No valid response from Anthropic through sandbox: ${response:0:200}"
  fi

  nemoclaw "$sbx_name" destroy --yes 2>/dev/null || true
  rm -f "$HOME/.nemoclaw/onboard.lock" 2>/dev/null || true
}

# =============================================================================
# TC-INF-09: Custom OpenAI-compatible endpoint inference
# =============================================================================
test_inf_09_compatible_endpoint() {
  log "=== TC-INF-09: Custom OpenAI-Compatible Endpoint ==="

  local endpoint_url="${NEMOCLAW_ENDPOINT_URL:-}"
  local endpoint_model="${NEMOCLAW_COMPAT_MODEL:-}"
  local endpoint_key="${COMPATIBLE_API_KEY:-}"

  if [[ -z "$endpoint_url" || -z "$endpoint_model" || -z "$endpoint_key" ]]; then
    skip "TC-INF-09" "Missing NEMOCLAW_ENDPOINT_URL, NEMOCLAW_COMPAT_MODEL, or COMPATIBLE_API_KEY"
    return
  fi

  local sbx_name="e2e-compat-ep"
  rm -f "$HOME/.nemoclaw/onboard.lock" 2>/dev/null || true

  log "  Preflight: destroying any existing '$sbx_name' sandbox..."
  nemoclaw "$sbx_name" destroy --yes 2>/dev/null || true

  log "  Onboarding with compatible endpoint: $endpoint_url"
  log "  Model: $endpoint_model"
  local onboard_exit=0
  NEMOCLAW_SANDBOX_NAME="$sbx_name" \
    NEMOCLAW_NON_INTERACTIVE=1 \
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
    NEMOCLAW_POLICY_TIER="open" \
    NEMOCLAW_PROVIDER="custom" \
    NEMOCLAW_ENDPOINT_URL="$endpoint_url" \
    NEMOCLAW_MODEL="$endpoint_model" \
    COMPATIBLE_API_KEY="$endpoint_key" \
    run_with_timeout 300 nemoclaw onboard --non-interactive --yes-i-accept-third-party-software \
    2>&1 | redact_stream "$endpoint_key" | tee -a "$LOG_FILE" || onboard_exit=$?

  if [[ $onboard_exit -ne 0 ]]; then
    fail "TC-INF-09: Onboard" "Onboard with compatible endpoint failed (exit $onboard_exit)"
    return
  fi
  pass "TC-INF-09: Onboard with compatible endpoint succeeded"

  # Get SSH config for the sandbox
  local ssh_cfg
  ssh_cfg="$(mktemp)"
  if ! openshell sandbox ssh-config "$sbx_name" >"$ssh_cfg" 2>/dev/null; then
    fail "TC-INF-09: SSH" "Could not get SSH config for sandbox"
    rm -f "$ssh_cfg"
    return
  fi

  # Send a prompt through the inference proxy inside the sandbox
  log "  Sending test prompt through sandbox inference proxy..."
  local response
  response=$(run_with_timeout 90 ssh -F "$ssh_cfg" \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 -o LogLevel=ERROR \
    "openshell-${sbx_name}" \
    "curl -s --max-time 60 https://inference.local/v1/chat/completions \
      -H 'Content-Type: application/json' \
      -d '{\"model\":\"$endpoint_model\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly one word: PONG\"}],\"max_tokens\":50}'" \
    2>&1) || true
  rm -f "$ssh_cfg"

  log "  Response: ${response:0:300}"

  local content
  content=$(echo "$response" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['choices'][0]['message']['content'])" 2>/dev/null) || true

  if [[ -n "$content" ]] && echo "$content" | grep -qi "PONG"; then
    pass "TC-INF-09: Inference response received through sandbox proxy"
  elif [[ -n "$content" ]]; then
    pass "TC-INF-09: Inference response received (content: ${content:0:100})"
  elif [[ -n "$response" ]]; then
    fail "TC-INF-09: Inference" "Got response but could not extract content: ${response:0:200}"
  else
    fail "TC-INF-09: Inference" "No response from inference.local"
  fi

  nemoclaw "$sbx_name" destroy --yes 2>/dev/null || true
  rm -f "$HOME/.nemoclaw/onboard.lock" 2>/dev/null || true
}

# ── Teardown ─────────────────────────────────────────────────────────────────
teardown() {
  # Do not unlink ~/.nemoclaw/onboard.lock: see rationale in
  # test/e2e/lib/sandbox-teardown.sh — the lock is PID-ownership-aware
  # and onboard cleans up stale locks itself.
  set +e
  nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true
  nemoclaw "e2e-openai" destroy --yes 2>/dev/null || true
  nemoclaw "e2e-anthropic" destroy --yes 2>/dev/null || true
  nemoclaw "e2e-invalid-key" destroy --yes 2>/dev/null || true
  nemoclaw "e2e-unreachable" destroy --yes 2>/dev/null || true
  nemoclaw "e2e-compat-ep" destroy --yes 2>/dev/null || true
  set -e
}

# ── Summary ──────────────────────────────────────────────────────────────────
summary() {
  echo ""
  echo "============================================================"
  echo "  NemoClaw Inference Routing E2E Results"
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
  echo "  NemoClaw Inference Routing E2E Tests"
  echo "  $(date)"
  echo "============================================================"
  echo ""

  preflight

  test_inf_02_openai
  test_inf_03_anthropic
  test_inf_05_credential_isolation
  test_inf_06_invalid_api_key
  test_inf_07_unreachable_endpoint
  test_inf_09_compatible_endpoint

  trap - EXIT
  teardown
  summary
}

trap teardown EXIT
main "$@"
