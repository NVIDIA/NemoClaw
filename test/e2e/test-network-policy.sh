#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# =============================================================================
# test-network-policy.sh
# NemoClaw Network Policy E2E Tests
#
# Covers:
#   TC-NET-01: Deny-by-default egress (blocked URL returns 403)
#   TC-NET-02: Whitelisted endpoint access (PyPI reachable via pip)
#   TC-NET-03: Live policy-add without restart (slack preset)
#   TC-NET-04: policy-add --dry-run (no changes applied)
#   TC-NET-05: Hot-reload (policy change without sandbox restart)
#   TC-NET-06: Permissive policy mode (open all egress)
#   TC-NET-07: Inference exemption + direct provider blocked
#   TC-NET-09: SSRF validation (dangerous IPs rejected)
#
# Prerequisites:
#   - Docker running
#   - NemoClaw installed (or install.sh available)
#   - NVIDIA_API_KEY for sandbox onboard
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
SANDBOX_NAME="e2e-net-policy"
LOG_FILE="test-network-policy-$(date +%Y%m%d-%H%M%S).log"

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
    NEMOCLAW_POLICY_TIER="restricted" \
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
  install_nemoclaw
  if ! command -v expect >/dev/null 2>&1; then
    log "Installing expect..."
    if ! (sudo apt-get update -qq && sudo apt-get install -y -qq expect >/dev/null 2>&1); then
      log "WARNING: failed to install expect — interactive tests will skip"
    fi
    if ! command -v expect >/dev/null 2>&1; then
      log "WARNING: expect not available — interactive tests will skip"
    fi
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    log "ERROR: python3 is required for JSON parsing"
    exit 1
  fi
  log "nemoclaw: $(nemoclaw --version 2>/dev/null || echo unknown)"
  log "python3: $(python3 --version 2>/dev/null || echo unknown)"
  log "Pre-flight complete"
}

# Apply a network policy preset by name (non-interactive).
apply_preset() {
  local preset_name="$1"
  log "  Applying preset '$preset_name' (non-interactive)..."
  local exit_code=0
  nemoclaw "$SANDBOX_NAME" policy-add "$preset_name" --yes 2>&1 | tee -a "$LOG_FILE" || exit_code=$?
  sleep 3
  return "$exit_code"
}

# Apply a network policy preset via interactive prompts using expect.
apply_preset_interactive() {
  local preset_name="$1"
  if ! command -v expect >/dev/null 2>&1; then
    log "  expect not available — cannot test interactive mode"
    return 2
  fi
  local preset_list preset_num
  preset_list=$(NEMOCLAW_NON_INTERACTIVE='' nemoclaw "$SANDBOX_NAME" policy-add </dev/null 2>&1) || true
  preset_num=$(echo "$preset_list" | grep -oE '[0-9]+\).*'"$preset_name" | grep -oE '^[0-9]+') || true
  if [[ -z "$preset_num" ]]; then
    log "  Could not find '$preset_name' in interactive preset list"
    return 1
  fi
  log "  Applying preset '$preset_name' (#$preset_num) via interactive expect..."
  local exit_code=0
  set +e
  NEMOCLAW_NON_INTERACTIVE='' expect <<EOF 2>&1 | tee -a "$LOG_FILE"
set timeout 30
spawn env NEMOCLAW_NON_INTERACTIVE= nemoclaw $SANDBOX_NAME policy-add
expect "Choose preset*"
send "$preset_num\r"
expect "*Y/n*"
send "Y\r"
expect eof
EOF
  exit_code=${PIPESTATUS[0]}
  set -e
  sleep 3
  return "$exit_code"
}

# Execute a command inside the sandbox via SSH.
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
  result=$(${TIMEOUT_CMD:+$TIMEOUT_CMD 120} ssh -F "$ssh_cfg" \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 -o LogLevel=ERROR \
    "openshell-${SANDBOX_NAME}" "$cmd" 2>&1) || ssh_exit=$?
  rm -f "$ssh_cfg"
  echo "$result"
  return $ssh_exit
}

# ── Onboard sandbox ─────────────────────────────────────────────────────────
setup_sandbox() {
  local api_key="${NVIDIA_API_KEY:-}"
  if [[ -z "$api_key" ]]; then
    log "ERROR: NVIDIA_API_KEY not set"
    exit 1
  fi

  if nemoclaw list 2>/dev/null | grep -q "$SANDBOX_NAME"; then
    log "Removing existing sandbox '$SANDBOX_NAME'..."
    nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true
  fi

  log "=== Onboarding sandbox '$SANDBOX_NAME' with restricted policy ==="
  rm -f "$HOME/.nemoclaw/onboard.lock" 2>/dev/null || true
  NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME" \
    NEMOCLAW_NON_INTERACTIVE=1 \
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
    NEMOCLAW_POLICY_TIER="restricted" \
    ${TIMEOUT_CMD:+$TIMEOUT_CMD 600} nemoclaw onboard --non-interactive --yes-i-accept-third-party-software \
    2>&1 | tee -a "$LOG_FILE" || {
    log "FATAL: Onboard failed"
    exit 1
  }
  log "Sandbox '$SANDBOX_NAME' onboarded with restricted policy"
}

# =============================================================================
# TC-NET-01: Deny-by-default egress
# =============================================================================
test_net_01_deny_default() {
  log "=== TC-NET-01: Deny-by-Default Egress ==="

  local blocked_url="https://example.com/"
  log "  Probing blocked URL from inside sandbox: $blocked_url"

  local response
  response=$(sandbox_exec "node -e \"
fetch('$blocked_url', {signal: AbortSignal.timeout(15000)})
  .then(r => console.log('STATUS_' + r.status))
  .catch(e => console.log('ERROR_' + (e.cause?.code || e.code || e.message)))
\"" 2>&1) || true

  log "  Response: $response"

  if echo "$response" | grep -qE "STATUS_403|ERROR_"; then
    pass "TC-NET-01: Non-whitelisted URL blocked ($response)"
  elif echo "$response" | grep -qE "STATUS_2"; then
    fail "TC-NET-01: Deny default" "Non-whitelisted URL returned success ($response)"
  else
    fail "TC-NET-01: Deny default" "Unexpected response ($response)"
  fi
}

# =============================================================================
# TC-NET-02: Whitelisted endpoint access
# =============================================================================
test_net_02_whitelist_access() {
  log "=== TC-NET-02: Whitelisted Endpoint Access ==="

  log "  Adding pypi preset for whitelist test..."
  if ! apply_preset "pypi"; then
    fail "TC-NET-02: Setup" "Could not apply pypi preset"
    return
  fi

  log "  Probing PyPI from inside sandbox using pip..."

  local response
  response=$(sandbox_exec "rm -rf /tmp/pip-test && pip download --no-deps --no-cache-dir --dest /tmp/pip-test requests 2>&1 && echo PIP_OK || echo PIP_FAIL" 2>&1) || true

  log "  Response: ${response:0:300}"

  if echo "$response" | grep -q "PIP_OK"; then
    pass "TC-NET-02: PyPI reachable via pip after preset applied"
  elif echo "$response" | grep -qiE "Downloading|Successfully"; then
    pass "TC-NET-02: PyPI reachable via pip (download started)"
  else
    fail "TC-NET-02: Whitelist" "pip could not reach PyPI: ${response:0:200}"
  fi
}

# =============================================================================
# TC-NET-03: Live policy-add without restart
# =============================================================================
test_net_03_live_policy_add() {
  log "=== TC-NET-03: Live Policy-Add Without Restart ==="

  local target_url="https://slack.com/"

  log "  Step 1: Verify slack.com is blocked before policy-add..."
  local before
  before=$(sandbox_exec "node -e \"
fetch('$target_url', {signal: AbortSignal.timeout(15000)})
  .then(r => console.log('STATUS_' + r.status))
  .catch(e => console.log('ERROR_' + (e.cause?.code || e.code || e.message)))
\"" 2>&1) || true
  log "  Before policy-add: $before"

  if echo "$before" | grep -qE "STATUS_[23][0-9][0-9]"; then
    skip "TC-NET-03" "slack.com already reachable before policy-add (preset may be pre-applied)"
    return
  fi

  log "  Step 2: Adding slack preset (interactive mode)..."
  local interactive_rc=0
  apply_preset_interactive "slack" || interactive_rc=$?
  if [[ $interactive_rc -eq 2 ]]; then
    log "  Interactive mode unavailable (expect missing) — falling back to non-interactive..."
    if ! apply_preset "slack"; then
      fail "TC-NET-03: Setup" "Could not apply slack preset"
      return
    fi
  elif [[ $interactive_rc -ne 0 ]]; then
    fail "TC-NET-03: Interactive policy-add" "interactive flow failed (exit $interactive_rc)"
    return
  fi

  sleep 5

  log "  Step 3: Verify slack.com is reachable after policy-add..."
  local after
  after=$(sandbox_exec "node -e \"
fetch('$target_url', {signal: AbortSignal.timeout(30000)})
  .then(r => console.log('STATUS_' + r.status))
  .catch(e => console.log('ERROR_' + (e.cause?.code || e.code || e.message)))
\"" 2>&1) || true
  log "  After policy-add: $after"

  if echo "$after" | grep -qE "STATUS_[2-4][0-9][0-9]"; then
    pass "TC-NET-03: Endpoint reachable after live policy-add ($after)"
  elif echo "$after" | grep -qE "ERROR_"; then
    fail "TC-NET-03: Live policy-add" "slack.com still proxy-blocked after policy-add ($after)"
  else
    fail "TC-NET-03: Live policy-add" "Unexpected response after policy-add ($after)"
  fi
}

# =============================================================================
# TC-NET-04: policy-add --dry-run
# =============================================================================
test_net_04_dry_run() {
  log "=== TC-NET-04: Policy-Add --dry-run ==="

  local target_url="https://api.atlassian.com/"

  log "  Step 1: Verify api.atlassian.com is blocked..."
  local before
  before=$(sandbox_exec "node -e \"
fetch('$target_url', {signal: AbortSignal.timeout(15000)})
  .then(r => console.log('STATUS_' + r.status))
  .catch(e => console.log('ERROR_' + (e.cause?.code || e.code || e.message)))
\"" 2>&1) || true
  log "  Before dry-run: $before"

  log "  Step 2: Running policy-add --dry-run jira..."
  local dry_output dry_rc=0
  dry_output=$(nemoclaw "$SANDBOX_NAME" policy-add jira --dry-run 2>&1) || dry_rc=$?
  log "  Dry-run output (exit $dry_rc): ${dry_output:0:300}"

  if [[ $dry_rc -eq 0 ]] && echo "$dry_output" | grep -qiE "atlassian|would be opened"; then
    pass "TC-NET-04: Dry-run printed endpoint info"
  else
    fail "TC-NET-04: Dry-run output" "Expected endpoint info in output: ${dry_output:0:200}"
  fi

  log "  Step 3: Verify api.atlassian.com is still blocked after dry-run..."
  local after
  after=$(sandbox_exec "node -e \"
fetch('$target_url', {signal: AbortSignal.timeout(15000)})
  .then(r => console.log('STATUS_' + r.status))
  .catch(e => console.log('ERROR_' + (e.cause?.code || e.code || e.message)))
\"" 2>&1) || true
  log "  After dry-run: $after"

  if echo "$after" | grep -qE "STATUS_403|ERROR_"; then
    pass "TC-NET-04: Policy unchanged after dry-run (blocked: $after)"
  elif echo "$after" | grep -qE "STATUS_[23]"; then
    fail "TC-NET-04: Dry-run side effect" "api.atlassian.com reachable after dry-run (policy was modified)"
  else
    fail "TC-NET-04: Dry-run verification" "Unexpected response ($after)"
  fi
}

# =============================================================================
# TC-NET-07: Inference exemption + direct provider blocked
# =============================================================================
test_net_07_inference_exemption() {
  log "=== TC-NET-07: Inference Exemption + Direct Provider Blocked ==="

  log "  Step 1: Send prompt via inference.local (should succeed)..."
  local inference_response
  inference_response=$(sandbox_exec "curl -s --max-time 60 https://inference.local/v1/chat/completions \
    -H 'Content-Type: application/json' \
    -d '{\"model\":\"nvidia/nemotron-3-super-120b-a12b\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly one word: PONG\"}],\"max_tokens\":50}'" 2>&1) || true

  log "  Inference response: ${inference_response:0:200}"

  local content
  content=$(echo "$inference_response" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['choices'][0]['message']['content'])" 2>/dev/null) || true

  if [[ -n "$content" ]]; then
    pass "TC-NET-07: Inference via inference.local succeeded"
  else
    fail "TC-NET-07: Inference" "No response from inference.local: ${inference_response:0:200}"
    return
  fi

  log "  Step 2: Attempt direct connection to provider (should be blocked)..."
  local direct_response
  direct_response=$(sandbox_exec "node -e \"
fetch('https://integrate.api.nvidia.com/v1/models', {signal: AbortSignal.timeout(15000)})
  .then(r => console.log('STATUS_' + r.status))
  .catch(e => console.log('ERROR_' + (e.cause?.code || e.code || e.message)))
\"" 2>&1) || true

  log "  Direct provider response: $direct_response"

  if echo "$direct_response" | grep -qE "STATUS_403|ERROR_"; then
    pass "TC-NET-07: Direct provider access blocked ($direct_response)"
  elif echo "$direct_response" | grep -qE "STATUS_[23]"; then
    fail "TC-NET-07: Direct provider" "Direct access to provider succeeded ($direct_response)"
  else
    fail "TC-NET-07: Direct provider" "Unexpected response ($direct_response)"
  fi
}

# =============================================================================
# TC-NET-05: Hot-reload — policy takes effect without sandbox restart
# =============================================================================
test_net_05_hot_reload() {
  log "=== TC-NET-05: Hot-Reload (no sandbox restart) ==="

  log "  Capturing sandbox start time before policy change..."
  local starttime_before
  starttime_before=$(sandbox_exec "cat /proc/1/stat 2>/dev/null | awk '{print \$22}'" 2>&1) || true
  log "  Start time before: $starttime_before"

  log "  Adding npm preset..."
  if ! apply_preset "npm"; then
    fail "TC-NET-05: Setup" "Could not apply npm preset"
    return
  fi

  log "  Capturing sandbox start time after policy change..."
  local starttime_after
  starttime_after=$(sandbox_exec "cat /proc/1/stat 2>/dev/null | awk '{print \$22}'" 2>&1) || true
  log "  Start time after: $starttime_after"

  if [[ -n "$starttime_before" && -n "$starttime_after" && "$starttime_before" == "$starttime_after" ]]; then
    pass "TC-NET-05: Sandbox start time unchanged after policy-add (no restart)"
  elif [[ -z "$starttime_before" || -z "$starttime_after" ]]; then
    skip "TC-NET-05" "Could not capture sandbox start time"
  else
    fail "TC-NET-05: Hot-reload" "Sandbox start time changed ($starttime_before → $starttime_after) — sandbox was restarted"
  fi
}

# =============================================================================
# TC-NET-06: Permissive policy mode
# =============================================================================
test_net_06_permissive_mode() {
  log "=== TC-NET-06: Permissive Policy Mode ==="

  log "  Step 1: Verify npm registry is blocked under restricted policy..."
  local before
  before=$(sandbox_exec "npm ping 2>&1 && echo NPM_OK || echo NPM_FAIL" 2>&1) || true
  log "  Before permissive: ${before:0:200}"

  if echo "$before" | grep -q "NPM_OK"; then
    log "  npm already reachable (preset may be applied from earlier test)"
  fi

  log "  Step 2: Applying permissive policy via openshell..."
  local permissive_path="$REPO_ROOT/nemoclaw-blueprint/policies/openclaw-sandbox-permissive.yaml"
  if ! openshell policy set --policy "$permissive_path" --wait "$SANDBOX_NAME" 2>&1 | tee -a "$LOG_FILE"; then
    fail "TC-NET-06: Setup" "Could not apply permissive policy ($permissive_path)"
    return
  fi
  sleep 5

  log "  Step 3: Verify npm registry is reachable under permissive policy..."
  local during
  during=$(sandbox_exec "npm ping 2>&1 && echo NPM_OK || echo NPM_FAIL" 2>&1) || true
  log "  During permissive: ${during:0:200}"

  if echo "$during" | grep -q "NPM_OK"; then
    pass "TC-NET-06: npm reachable under permissive policy"
  else
    fail "TC-NET-06: Permissive" "npm still blocked under permissive policy (${during:0:200})"
  fi
}

# =============================================================================
# TC-NET-09: SSRF validation
# =============================================================================
test_net_09_ssrf_validation() {
  log "=== TC-NET-09: SSRF Validation ==="

  log "  Testing SSRF validation via Node.js..."
  local result
  result=$(node -e "
const { isPrivateIp } = require('$REPO_ROOT/nemoclaw/dist/blueprint/ssrf');
const dangerous = ['169.254.169.254', '127.0.0.1', '10.0.0.1', '192.168.1.1', '0.0.0.0'];
const safe = ['8.8.8.8', '142.250.80.46'];
let pass = true;
for (const ip of dangerous) {
  if (!isPrivateIp(ip)) { console.log('FAIL: ' + ip + ' not blocked'); pass = false; }
}
for (const ip of safe) {
  if (isPrivateIp(ip)) { console.log('FAIL: ' + ip + ' incorrectly blocked'); pass = false; }
}
console.log(pass ? 'SSRF_PASS' : 'SSRF_FAIL');
" 2>&1) || true

  log "  Result: $result"

  if echo "$result" | grep -q "SSRF_PASS"; then
    pass "TC-NET-09: SSRF validation correctly blocks dangerous IPs"
  else
    fail "TC-NET-09: SSRF" "Validation failed: $result"
  fi
}

# ── Teardown ─────────────────────────────────────────────────────────────────
teardown() {
  set +e
  rm -f "$HOME/.nemoclaw/onboard.lock" 2>/dev/null || true
  nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true
  set -e
}

# ── Summary ──────────────────────────────────────────────────────────────────
summary() {
  echo ""
  echo "============================================================"
  echo "  Network Policy E2E Results"
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
  echo "  NemoClaw Network Policy E2E Tests"
  echo "  $(date)"
  echo "============================================================"
  echo ""

  preflight
  setup_sandbox

  test_net_01_deny_default
  test_net_02_whitelist_access
  test_net_03_live_policy_add
  test_net_04_dry_run
  test_net_05_hot_reload
  test_net_07_inference_exemption
  test_net_09_ssrf_validation
  test_net_06_permissive_mode # last — opens all egress, affects subsequent tests

  trap - EXIT
  teardown
  summary
}

trap teardown EXIT
main "$@"
