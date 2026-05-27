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
#   TC-NET-08: Jira per-binary policy enforcement
#   TC-NET-09: SSRF validation (dangerous IPs rejected)
#   TC-NET-10: OpenClaw web_fetch can reach approved host gateway target,
#              while OpenShell still denies unapproved host gateway ports
#
# Prerequisites:
#   - Docker running
#   - NemoClaw installed (or install.sh available)
#   - NVIDIA_API_KEY for sandbox onboard
# =============================================================================

set -euo pipefail

# ── Overall timeout ──────────────────────────────────────────────────────────
export NEMOCLAW_E2E_DEFAULT_TIMEOUT=3600
SCRIPT_DIR_TIMEOUT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=test/e2e/e2e-timeout.sh
source "${SCRIPT_DIR_TIMEOUT}/e2e-timeout.sh"
# shellcheck source=test/e2e/lib/install-path-refresh.sh
source "${SCRIPT_DIR_TIMEOUT}/lib/install-path-refresh.sh"
# ── Config ───────────────────────────────────────────────────────────────────
SANDBOX_NAME="e2e-net-policy"
LOG_FILE="test-network-policy-$(date +%Y%m%d-%H%M%S).log"

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
  nemoclaw_ensure_local_bin_on_path

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
  nemoclaw_refresh_install_env
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
  result=$(run_with_timeout 120 ssh -F "$ssh_cfg" \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 -o LogLevel=ERROR \
    "openshell-${SANDBOX_NAME}" "$cmd" 2>&1) || ssh_exit=$?
  rm -f "$ssh_cfg"
  echo "$result"
  return $ssh_exit
}

start_e2e_http_server() {
  local docroot="$1"
  local port_file="$2"
  local log_file="$3"
  python3 - "$docroot" "$port_file" >"$log_file" 2>&1 <<'PYHTTP' &
import functools
import http.server
import socketserver
import sys

docroot = sys.argv[1]
port_file = sys.argv[2]

class ReusableTCPServer(socketserver.TCPServer):
    allow_reuse_address = True

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=docroot)
with ReusableTCPServer(("0.0.0.0", 0), handler) as server:
    with open(port_file, "w", encoding="utf-8") as handle:
        handle.write(str(server.server_address[1]))
        handle.flush()
    print(f"serving {docroot} on port {server.server_address[1]}", flush=True)
    server.serve_forever()
PYHTTP
  echo "$!"
}

wait_for_e2e_http_port() {
  local port_file="$1"
  local pid="$2"
  local _
  for _ in {1..50}; do
    if [ -s "$port_file" ]; then
      tr -d '[:space:]' <"$port_file"
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      return 1
    fi
    sleep 0.1
  done
  return 1
}

# ── Onboard sandbox ─────────────────────────────────────────────────────────
setup_sandbox() {
  local api_key="${NVIDIA_API_KEY:-}"
  if [[ -z "$api_key" ]]; then
    log "ERROR: NVIDIA_API_KEY not set"
    exit 1
  fi

  # Unconditional destroy — `nemoclaw list` does not always surface sandboxes
  # stuck in a not-ready state, and a not-ready sandbox blocks onboard with
  # "already exists but is not ready" before NEMOCLAW_RECREATE_SANDBOX=1 kicks in.
  log "Preflight: destroying any existing '$SANDBOX_NAME' sandbox..."
  nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true

  log "=== Onboarding sandbox '$SANDBOX_NAME' with restricted policy ==="
  rm -f "$HOME/.nemoclaw/onboard.lock" 2>/dev/null || true
  NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME" \
    NEMOCLAW_NON_INTERACTIVE=1 \
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
    NEMOCLAW_POLICY_TIER="restricted" \
    NEMOCLAW_WEB_SEARCH_ENABLED=1 \
    NEMOCLAW_RECREATE_SANDBOX=1 \
    run_with_timeout 600 nemoclaw onboard --non-interactive --yes-i-accept-third-party-software \
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
# TC-NET-08: Jira per-binary policy enforcement
# =============================================================================
test_net_08_jira_per_binary_enforcement() {
  log "=== TC-NET-08: Jira Per-Binary Policy Enforcement ==="

  log "  Step 1: Applying jira preset..."
  if ! apply_preset "jira"; then
    fail "TC-NET-08: Setup" "Could not apply jira preset"
    return
  fi

  log "  Step 2: Verify Node HTTPS can reach Atlassian API..."
  local node_response
  node_response=$(sandbox_exec "node -e \"
const https = require('https');
const req = https.get('https://api.atlassian.com', (res) => {
  console.log('NODE_STATUS_' + res.statusCode);
  res.resume();
});
req.setTimeout(30000, () => {
  console.log('NODE_ERROR_TIMEOUT');
  req.destroy();
});
req.on('error', (error) => console.log('NODE_ERROR_' + (error.code || error.message)));
\"" 2>&1) || true
  log "  Node response: $node_response"

  if echo "$node_response" | grep -qE "NODE_STATUS_[23][0-9][0-9]"; then
    pass "TC-NET-08: Node reaches Atlassian API after jira preset ($node_response)"
  elif echo "$node_response" | grep -qE "NODE_STATUS_403|NODE_ERROR_"; then
    fail "TC-NET-08: Node policy" "Node did not reach Atlassian API after jira preset ($node_response)"
    return
  else
    fail "TC-NET-08: Node policy" "Unexpected Node response ($node_response)"
    return
  fi

  log "  Step 3: Verify curl remains blocked by the Jira preset..."
  local curl_before
  curl_before=$(sandbox_exec "set +e
OUT=\$(curl -sS -o /dev/null -w 'CURL_STATUS_%{http_code} CURL_APPCONNECT_%{time_appconnect}' --max-time 10 https://auth.atlassian.com 2>&1)
RC=\$?
echo \"\$OUT CURL_RC_\$RC\"
" 2>&1) || true
  log "  Curl before explicit approval: $curl_before"

  if echo "$curl_before" | grep -qE "CURL_STATUS_[23][0-9][0-9]"; then
    fail "TC-NET-08: Curl pre-approval" "curl reached Atlassian without explicit approval ($curl_before)"
    return
  elif echo "$curl_before" | grep -qE "CURL_STATUS_000|CURL_STATUS_403|CURL_RC_[1-9]|denied|policy|forbidden"; then
    if echo "$curl_before" | grep -qE "CURL_APPCONNECT_0(\.0+)?( |$)"; then
      pass "TC-NET-08: curl blocked before explicit approval and before outbound TLS ($curl_before)"
    else
      fail "TC-NET-08: Curl pre-approval" "curl was denied but appeared to establish outbound TLS ($curl_before)"
      return
    fi
  else
    fail "TC-NET-08: Curl pre-approval" "Unexpected curl denial signal ($curl_before)"
    return
  fi

  log "  Step 4: Explicitly allow curl to auth.atlassian.com via OpenShell policy update..."
  if ! openshell policy update "$SANDBOX_NAME" \
    --add-endpoint auth.atlassian.com:443:read-only:rest:enforce \
    --binary /usr/bin/curl \
    --binary /usr/local/bin/curl \
    --wait 2>&1 | tee -a "$LOG_FILE"; then
    fail "TC-NET-08: Curl approval" "Could not apply explicit curl approval"
    return
  fi
  sleep 5

  log "  Step 5: Verify curl reaches Atlassian after explicit approval..."
  local curl_after
  curl_after=$(sandbox_exec "set +e
OUT=\$(curl -sS -o /dev/null -w 'CURL_STATUS_%{http_code}' --max-time 10 https://auth.atlassian.com 2>&1)
RC=\$?
echo \"\$OUT CURL_RC_\$RC\"
" 2>&1) || true
  log "  Curl after explicit approval: $curl_after"

  if echo "$curl_after" | grep -qE "CURL_STATUS_[23][0-9][0-9]"; then
    pass "TC-NET-08: curl reaches Atlassian after explicit approval ($curl_after)"
  else
    fail "TC-NET-08: Curl post-approval" "curl did not reach Atlassian after explicit approval ($curl_after)"
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

# =============================================================================
# TC-NET-10: OpenClaw web_fetch host gateway compatibility
# =============================================================================
test_net_10_openclaw_web_fetch_host_gateway() {
  log "=== TC-NET-10: OpenClaw web_fetch Host Gateway ==="

  local host_dir server_log port port_file server_pid marker
  local deny_host_dir deny_server_log deny_port deny_port_file deny_server_pid deny_marker
  marker="NEMOCLAW_HOST_GATEWAY_WEB_FETCH_OK"
  deny_marker="NEMOCLAW_HOST_GATEWAY_WEB_FETCH_DENIED_PORT_SHOULD_NOT_LEAK"
  host_dir="$(mktemp -d)"
  deny_host_dir="$(mktemp -d)"
  server_log="$host_dir/http.log"
  deny_server_log="$deny_host_dir/http.log"
  port_file="$host_dir/port"
  deny_port_file="$deny_host_dir/port"
  printf '<html><body>%s</body></html>\n' "$marker" >"$host_dir/index.html"
  printf '<html><body>%s</body></html>\n' "$deny_marker" >"$deny_host_dir/index.html"

  server_pid="$(start_e2e_http_server "$host_dir" "$port_file" "$server_log")"
  deny_server_pid="$(start_e2e_http_server "$deny_host_dir" "$deny_port_file" "$deny_server_log")"
  if ! port="$(wait_for_e2e_http_port "$port_file" "$server_pid")"; then
    fail "TC-NET-10: Setup" "host HTTP server failed to publish a port ($(cat "$server_log" 2>/dev/null))"
    kill "$server_pid" "$deny_server_pid" 2>/dev/null || true
    wait "$server_pid" "$deny_server_pid" 2>/dev/null || true
    rm -rf "$host_dir" "$deny_host_dir"
    return
  fi
  if ! deny_port="$(wait_for_e2e_http_port "$deny_port_file" "$deny_server_pid")"; then
    fail "TC-NET-10: Setup" "deny host HTTP server failed to publish a port ($(cat "$deny_server_log" 2>/dev/null))"
    kill "$server_pid" "$deny_server_pid" 2>/dev/null || true
    wait "$server_pid" "$deny_server_pid" 2>/dev/null || true
    rm -rf "$host_dir" "$deny_host_dir"
    return
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    fail "TC-NET-10: Setup" "host HTTP server failed to start ($(cat "$server_log" 2>/dev/null))"
    rm -rf "$host_dir"
    kill "$deny_server_pid" 2>/dev/null || true
    wait "$deny_server_pid" 2>/dev/null || true
    rm -rf "$deny_host_dir"
    return
  fi
  if ! kill -0 "$deny_server_pid" 2>/dev/null; then
    fail "TC-NET-10: Setup" "deny host HTTP server failed to start ($(cat "$deny_server_log" 2>/dev/null))"
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
    rm -rf "$host_dir" "$deny_host_dir"
    return
  fi

  cleanup_host_server() {
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
    kill "$deny_server_pid" 2>/dev/null || true
    wait "$deny_server_pid" 2>/dev/null || true
    rm -rf "$host_dir" "$deny_host_dir"
  }

  log "  Allowing node/openclaw access to host.openshell.internal:${port}..."
  local host_gateway_policy
  host_gateway_policy="$(mktemp "${TMPDIR:-/tmp}/nemoclaw-host-gateway-policy.XXXXXX.yaml")"
  cat >"$host_gateway_policy" <<EOF_POLICY
preset:
  name: e2e-host-gateway-web-fetch
  description: "Network-policy E2E host-gateway web_fetch probe"

network_policies:
  e2e_host_gateway_web_fetch:
    name: e2e_host_gateway_web_fetch
    endpoints:
      - host: host.openshell.internal
        port: ${port}
        protocol: rest
        enforcement: enforce
        allowed_ips:
          - 10.0.0.0/8
          - 172.16.0.0/12
          - 192.168.0.0/16
        rules:
          - allow: { method: GET, path: "/**" }
    binaries:
      - { path: /usr/local/bin/openclaw }
      - { path: /usr/local/bin/node }
      - { path: /usr/bin/node }
EOF_POLICY
  if ! NEMOCLAW_NON_INTERACTIVE=1 nemoclaw "$SANDBOX_NAME" policy-add --from-file "$host_gateway_policy" --yes 2>&1 | tee -a "$LOG_FILE"; then
    rm -f "$host_gateway_policy"
    fail "TC-NET-10: Setup" "Could not allow host.openshell.internal:${port}"
    cleanup_host_server
    return
  fi
  rm -f "$host_gateway_policy"
  sleep 5

  local direct
  direct=$(sandbox_exec "node -e \"
fetch('http://host.openshell.internal:${port}/', {signal: AbortSignal.timeout(15000)})
  .then(async r => console.log('STATUS_' + r.status + ' ' + (await r.text()).slice(0, 120)))
  .catch(e => console.log('ERROR_' + (e.cause?.code || e.code || e.message)))
\"" 2>&1) || true
  log "  Direct Node host-gateway fetch: $direct"
  if ! echo "$direct" | grep -q "$marker"; then
    fail "TC-NET-10: Setup" "host gateway policy/proxy probe failed before OpenClaw web_fetch ($direct)"
    cleanup_host_server
    return
  fi

  log "  Verifying unapproved host.openshell.internal:${deny_port} remains denied..."
  local denied_direct
  denied_direct=$(sandbox_exec "node -e \"
fetch('http://host.openshell.internal:${deny_port}/', {signal: AbortSignal.timeout(15000)})
  .then(async r => console.log('STATUS_' + r.status + ' ' + (await r.text()).slice(0, 120)))
  .catch(e => console.log('ERROR_' + (e.cause?.code || e.code || e.message)))
\"" 2>&1) || true
  log "  Direct Node denied-port probe: $denied_direct"
  if echo "$denied_direct" | grep -q "$deny_marker"; then
    fail "TC-NET-10: OpenShell policy" "unapproved host gateway port was reachable before OpenClaw web_fetch deny-case ($denied_direct)"
    cleanup_host_server
    return
  fi
  if echo "$denied_direct" | grep -qiE "STATUS_403|ERROR_|denied|policy|forbidden|not allowed|not permitted"; then
    pass "TC-NET-10: OpenShell policy denies unapproved host gateway port"
  else
    fail "TC-NET-10: OpenShell policy" "unexpected denied-port response before OpenClaw web_fetch deny-case ($denied_direct)"
    cleanup_host_server
    return
  fi

  local web_fetch_probe_script web_fetch_probe_b64 web_fetch_output web_fetch_rc=0
  web_fetch_probe_script="$(
    cat <<'NODE'
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [approvedUrl, deniedUrl, marker, denyMarker] = process.argv.slice(2);
const distDir = "/usr/local/lib/node_modules/openclaw/dist";

function fail(code, detail) {
  console.log(`E2E_FAIL_${code}: ${String(detail || "").slice(0, 1200)}`);
  process.exitCode = 1;
}

function findDistFile(prefix) {
  const candidates = fs
    .readdirSync(distDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".js"))
    .sort();
  if (candidates.length !== 1) {
    throw new Error(`expected one ${prefix}*.js file, found ${candidates.length}: ${candidates.join(", ")}`);
  }
  return path.join(distDir, candidates[0]);
}

function summarize(value) {
  return JSON.stringify(value, (_key, inner) => {
    if (typeof inner === "string" && inner.length > 1200) return `${inner.slice(0, 1200)}...`;
    return inner;
  });
}

async function main() {
  const configPath = process.env.OPENCLAW_CONFIG_PATH || "/sandbox/.openclaw/openclaw.json";
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const fetchConfig = config?.tools?.web?.fetch;
  if (fetchConfig?.useTrustedEnvProxy !== true) {
    fail("CONFIG_MISSING_TRUSTED_ENV_PROXY", `tools.web.fetch.useTrustedEnvProxy=${fetchConfig?.useTrustedEnvProxy}`);
    return;
  }

  const mod = await import(pathToFileURL(findDistFile("openclaw-tools-")).href);
  const createOpenClawTools = mod.t || mod.createOpenClawTools;
  if (typeof createOpenClawTools !== "function") {
    fail("OPENCLAW_TOOLS_EXPORT_MISSING", Object.keys(mod).join(","));
    return;
  }

  const tools = createOpenClawTools({
    config,
    sandboxed: true,
    workspaceDir: "/sandbox/.openclaw/workspace-main",
    wrapBeforeToolCallHook: false,
    disablePluginTools: true,
    disableMessageTool: true,
  });
  const webFetch = tools.find((tool) => tool?.name === "web_fetch");
  if (!webFetch || typeof webFetch.execute !== "function") {
    fail("WEB_FETCH_TOOL_MISSING", tools.map((tool) => tool?.name).filter(Boolean).join(","));
    return;
  }

  let approvedRaw = "";
  try {
    const approved = await webFetch.execute("e2e-approved-host-gateway", {
      url: approvedUrl,
      extractMode: "text",
      maxChars: 2000,
    });
    approvedRaw = summarize(approved);
  } catch (error) {
    const detail = error && (error.stack || error.message) ? error.stack || error.message : error;
    if (/SsrFBlockedError|Blocked hostname|private\/internal\/special-use/i.test(String(detail))) {
      fail("SSRF_BLOCKED_HOST_GATEWAY_APPROVED", detail);
      return;
    }
    fail("APPROVED_FETCH_ERROR", detail);
    return;
  }
  if (!approvedRaw.includes(marker)) {
    fail("APPROVED_MARKER_MISSING", approvedRaw);
    return;
  }
  console.log("E2E_WEB_FETCH_APPROVED_OK");

  try {
    const denied = await webFetch.execute("e2e-denied-host-gateway", {
      url: deniedUrl,
      extractMode: "text",
      maxChars: 2000,
    });
    const deniedRaw = summarize(denied);
    if (deniedRaw.includes(denyMarker)) {
      fail("DENIED_PORT_REACHED", deniedRaw);
      return;
    }
    fail("DENIED_PORT_UNEXPECTED_SUCCESS", deniedRaw);
  } catch (error) {
    const detail = String(error && (error.stack || error.message) ? error.stack || error.message : error);
    if (/SsrFBlockedError|Blocked hostname|private\/internal\/special-use/i.test(detail)) {
      fail("SSRF_BLOCKED_HOST_GATEWAY_DENIED", detail);
      return;
    }
    if (/Web fetch failed \\(403\\)|\\b403\\b|policy|denied|forbidden|fetch failed|ECONN|UND_ERR|proxy/i.test(detail)) {
      console.log(`E2E_WEB_FETCH_DENIED_OK ${detail.split("\n")[0].slice(0, 300)}`);
      return;
    }
    fail("DENIED_PORT_UNEXPECTED_ERROR", detail);
  }
}

main().catch((error) => {
  fail("UNCAUGHT", error && (error.stack || error.message) ? error.stack || error.message : error);
});
NODE
  )"
  web_fetch_probe_b64="$(printf '%s' "$web_fetch_probe_script" | base64 | tr -d '\n')"
  web_fetch_output=$(sandbox_exec "printf '%s' '${web_fetch_probe_b64}' | base64 -d > /tmp/nemoclaw-web-fetch-e2e.mjs
nemoclaw-start node /tmp/nemoclaw-web-fetch-e2e.mjs 'http://host.openshell.internal:${port}/' 'http://host.openshell.internal:${deny_port}/' '${marker}' '${deny_marker}'" 2>&1) || web_fetch_rc=$?
  cleanup_host_server

  log "  OpenClaw web_fetch probe: ${web_fetch_output:0:1000}"
  if printf '%s' "$web_fetch_output" | grep -q "E2E_FAIL_SSRF_BLOCKED_HOST_GATEWAY"; then
    fail "TC-NET-10: OpenClaw web_fetch" "OpenClaw SSRF guard blocked host gateway before OpenShell policy (${web_fetch_output:0:500})"
    return
  fi

  if printf '%s' "$web_fetch_output" | grep -q "E2E_FAIL_DENIED_PORT_REACHED"; then
    fail "TC-NET-10: OpenClaw web_fetch policy" "web_fetch reached unapproved host gateway port (${web_fetch_output:0:500})"
    return
  fi

  if printf '%s' "$web_fetch_output" | grep -q "E2E_WEB_FETCH_APPROVED_OK"; then
    pass "TC-NET-10: OpenClaw web_fetch reached approved host.openshell.internal target"
  else
    fail "TC-NET-10: OpenClaw web_fetch" "approved marker not returned (exit ${web_fetch_rc}, output='${web_fetch_output:0:500}')"
    return
  fi

  if printf '%s' "$web_fetch_output" | grep -q "E2E_WEB_FETCH_DENIED_OK"; then
    pass "TC-NET-10: OpenClaw web_fetch cannot reach unapproved host gateway port"
  else
    fail "TC-NET-10: OpenClaw web_fetch policy" "unapproved host gateway port did not produce a policy denial signal (exit ${web_fetch_rc}, output='${web_fetch_output:0:500}')"
  fi
}

# ── Teardown ─────────────────────────────────────────────────────────────────
teardown() {
  # Do not unlink ~/.nemoclaw/onboard.lock: that lock is global and PID-
  # ownership-aware in src/lib/onboard-session.ts (acquireOnboardLock
  # verifies the holder's PID liveness and inode), so an unconditional rm
  # here could yank a concurrent run's live lock. A crashed process leaves
  # a stale lock that the next onboard cleans up automatically.
  set +e
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
  test_net_08_jira_per_binary_enforcement
  test_net_05_hot_reload
  test_net_07_inference_exemption
  test_net_09_ssrf_validation
  test_net_10_openclaw_web_fetch_host_gateway
  test_net_06_permissive_mode # last — opens all egress, affects subsequent tests

  trap - EXIT
  teardown
  summary
}

trap teardown EXIT
main "$@"
