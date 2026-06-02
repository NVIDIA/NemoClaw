#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# DuckDuckGo Search E2E (Issue #4559)
#
# Verifies the issue's acceptance end-to-end:
#   D1   Non-interactive onboard with NEMOCLAW_EXPERIMENTAL=1 +
#        NEMOCLAW_WEB_SEARCH_PROVIDER=duckduckgo succeeds
#   D2a  duckduckgo network policy preset is applied
#   D2b  openclaw web-search config selects duckduckgo (no apiKey field)
#   D3   openclaw.json carries no apiKey/credentials for the DDG provider
#   D4a  Real DDG search via openclaw agent
#   D4b  Real DDG search via curl from inside the sandbox (lite endpoint)
#
# Required env (CI injects from secrets):
#   NVIDIA_API_KEY   drives the agent inference turn in D4a (optional;
#                    the agent step self-skips when unavailable)
#
# DuckDuckGo Search is keyless. No secrets are involved on the egress path;
# the script intentionally omits the secret-handling gates present in the
# Brave Search E2E.
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
#     NEMOCLAW_EXPERIMENTAL=1 NEMOCLAW_WEB_SEARCH_PROVIDER=duckduckgo \
#     NVIDIA_API_KEY=... \
#     bash test/e2e/test-duckduckgo-search-e2e.sh

set -uo pipefail

export NEMOCLAW_E2E_DEFAULT_TIMEOUT=1800
SCRIPT_DIR_TIMEOUT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=test/e2e/e2e-timeout.sh
. "${SCRIPT_DIR_TIMEOUT}/e2e-timeout.sh"
# shellcheck source=test/e2e/lib/openclaw-json.sh
. "${SCRIPT_DIR_TIMEOUT}/lib/openclaw-json.sh"

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

summary() {
  echo ""
  echo "============================================================"
  echo "  DuckDuckGo Search E2E Results"
  echo "============================================================"
  echo "  PASS: $PASS"
  echo "  FAIL: $FAIL"
  echo "  SKIP: $SKIP"
  echo "  TOTAL: $TOTAL"
  echo "============================================================"
  if [ "$FAIL" -gt 0 ]; then exit 1; fi
}

# ── Repo root ─────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
if [ -d /workspace ] && [ -f /workspace/install.sh ]; then
  REPO="/workspace"
elif [ -f "${SCRIPT_DIR}/../../install.sh" ]; then
  REPO="$(cd "${SCRIPT_DIR}/../.." && pwd)"
elif [ -f "./install.sh" ]; then
  REPO="$(pwd)"
else
  echo "ERROR: Cannot find repo root."
  exit 1
fi

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-duckduckgo-search}"
ONBOARD_LOG="/tmp/nemoclaw-e2e-duckduckgo-search-onboard.log"

quote_for_remote_sh() {
  local value="${1:-}"
  printf "'%s'" "$(printf '%s' "$value" | sed "s/'/'\\\\''/g")"
}

sandbox_exec_sh_script() {
  local script="$1"
  shift
  local encoded remote_cmd arg
  encoded="$(printf '%s' "$script" | base64 | tr -d '\n')"
  remote_cmd="tmp=\$(mktemp); trap 'rm -f \"\$tmp\"' EXIT; printf %s $(quote_for_remote_sh "$encoded") | base64 -d > \"\$tmp\"; sh \"\$tmp\""
  for arg in "$@"; do
    remote_cmd+=" $(quote_for_remote_sh "$arg")"
  done
  openshell sandbox exec --name "$SANDBOX_NAME" -- sh -lc "$remote_cmd"
}

load_shell_path() {
  local local_bin
  if [ -f "$HOME/.bashrc" ]; then
    # shellcheck source=/dev/null
    source "$HOME/.bashrc" 2>/dev/null || true
  fi
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck source=/dev/null
    . "$NVM_DIR/nvm.sh"
  fi
  local_bin="$HOME/.local/bin"
  if [ -d "$local_bin" ]; then
    PATH=":${PATH}:"
    PATH="${PATH//:${local_bin}:/:}"
    PATH="${PATH#:}"
    PATH="${PATH%:}"
    export PATH="$local_bin:$PATH"
  fi
}

cli_command_available_from_source() {
  [ -f "$REPO/dist/nemoclaw.js" ] && command -v node >/dev/null 2>&1 && command -v openshell >/dev/null 2>&1
}

destroy_sandbox_best_effort() {
  if [ "${NEMOCLAW_E2E_KEEP_SANDBOX:-}" = "1" ]; then
    return 0
  fi
  if cli_command_available_from_source; then
    run_with_timeout 120 node "$REPO/bin/nemoclaw.js" "$SANDBOX_NAME" destroy --yes >/dev/null 2>&1 || true
  elif command -v nemoclaw >/dev/null 2>&1; then
    run_with_timeout 120 nemoclaw "$SANDBOX_NAME" destroy --yes >/dev/null 2>&1 || true
  fi
  if command -v openshell >/dev/null 2>&1; then
    run_with_timeout 60 openshell sandbox delete "$SANDBOX_NAME" >/dev/null 2>&1 || true
  fi
}

# D1 — non-interactive onboard with DuckDuckGo provider gated by EXPERIMENTAL.
run_onboard_with_duckduckgo() {
  local onboard_exit=0 onboard_cmd_desc
  export NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME"
  export NEMOCLAW_RECREATE_SANDBOX=1
  export NEMOCLAW_NON_INTERACTIVE=1
  export NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1
  export NEMOCLAW_EXPERIMENTAL=1
  export NEMOCLAW_WEB_SEARCH_PROVIDER=duckduckgo

  if cli_command_available_from_source; then
    onboard_cmd_desc="source CLI onboard"
    info "Using source-built CLI at $REPO/bin/nemoclaw.js"
    destroy_sandbox_best_effort
    run_with_timeout 1200 node "$REPO/bin/nemoclaw.js" onboard --fresh --non-interactive --yes-i-accept-third-party-software 2>&1 \
      | tee "$ONBOARD_LOG"
    onboard_exit=${PIPESTATUS[0]}
  else
    onboard_cmd_desc="install.sh"
    info "Source CLI is not built; running install.sh from this checkout."
    bash "$REPO/install.sh" --non-interactive --yes-i-accept-third-party-software --fresh 2>&1 \
      | tee "$ONBOARD_LOG"
    onboard_exit=${PIPESTATUS[0]}
    load_shell_path
  fi

  if [ "$onboard_exit" -eq 0 ]; then
    pass "D1: ${onboard_cmd_desc} completed for DuckDuckGo-enabled onboard"
  else
    fail "D1: ${onboard_cmd_desc} failed (exit $onboard_exit)"
    summary
  fi
}

# D2 — duckduckgo preset is applied.
check_duckduckgo_preset_applied() {
  local policy_output rc=0 config_check config_rc=0 config_script

  policy_output=$(openshell policy get --full "$SANDBOX_NAME" 2>&1) || rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "D2a: openshell policy get failed (exit $rc)"
  elif printf '%s' "$policy_output" | grep -q "duckduckgo.com" \
    && printf '%s' "$policy_output" | grep -q "lite.duckduckgo.com"; then
    pass "D2a: duckduckgo preset applied — duckduckgo.com and lite.duckduckgo.com are in the loaded gateway policy"
  else
    fail "D2a: duckduckgo preset NOT applied — duckduckgo hosts missing from the gateway policy"
  fi

  config_script=$(
    cat <<'SH'
python3 <<'PY'
import json
with open("/sandbox/.openclaw/openclaw.json") as f:
    cfg = json.load(f)
s = cfg.get("tools", {}).get("web", {}).get("search", {})
print(f"enabled={s.get('enabled')}")
print(f"provider={s.get('provider')}")
print(f"has_api_key={'apiKey' in s}")
PY
SH
  )
  config_check=$(sandbox_exec_sh_script "$config_script" 2>&1) || config_rc=$?

  if [ "$config_rc" -ne 0 ]; then
    fail "D2b: could not read openclaw web-search config (exit $config_rc)"
  elif printf '%s' "$config_check" | grep -q "^enabled=True$" \
    && printf '%s' "$config_check" | grep -q "^provider=duckduckgo$"; then
    pass "D2b: duckduckgo preset wired through to openclaw — tools.web.search.provider=duckduckgo and enabled=true"
  else
    fail "D2b: openclaw web-search config does not select duckduckgo (got: $(printf '%s' "$config_check" | tr '\n' ' '))"
  fi
}

# D3 — no API key field of any kind is emitted for DuckDuckGo.
check_no_api_key_emitted() {
  local config_dump

  config_dump=$(openshell sandbox exec --name "$SANDBOX_NAME" -- sh -lc \
    'cat /sandbox/.openclaw/openclaw.json 2>/dev/null || true' 2>&1) || true

  if printf '%s' "$config_dump" | python3 -c '
import json, sys
try:
    cfg = json.load(sys.stdin)
except Exception:
    sys.exit(2)
search = (((cfg or {}).get("tools") or {}).get("web") or {}).get("search") or {}
if search.get("provider") != "duckduckgo":
    sys.exit(3)
if "apiKey" in search or "api_key" in search:
    sys.exit(4)
sys.exit(0)
' >/dev/null 2>&1; then
    pass "D3: openclaw.json has provider=duckduckgo with no apiKey/api_key field"
  else
    fail "D3: openclaw.json either is unparseable, missing the duckduckgo provider, or carries an unexpected apiKey field"
  fi
}

# D4a — real DuckDuckGo search via openclaw agent.
check_real_ddg_search_via_agent() {
  local session_id raw ssh_cfg reply rc=0 ssh_cmd
  if [ -z "${NVIDIA_API_KEY:-}" ]; then
    skip "D4a: NVIDIA_API_KEY not set — skipping agent web-search turn"
    return
  fi
  session_id="e2e-ddg-agent-$(date +%s)-$$"
  ssh_cfg="$(mktemp)"

  if ! openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_cfg" 2>/dev/null; then
    rm -f "$ssh_cfg"
    fail "D4a: agent web-search turn — could not get SSH config"
    return
  fi

  ssh_cmd="openclaw agent --agent main --json --session-id '${session_id}' -m 'Use the web search tool to find one result for the query: NVIDIA. Reply with only the title of the top result.'"
  raw=$(run_with_timeout 120 ssh -F "$ssh_cfg" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 \
    -o LogLevel=ERROR \
    "openshell-${SANDBOX_NAME}" \
    "$ssh_cmd" \
    2>/dev/null) || rc=$?
  rm -f "$ssh_cfg"

  if printf '%s' "$raw" | grep -qiE "SsrFBlockedError|Blocked hostname|ECONNREFUSED|EAI_AGAIN|gateway unavailable|network connection error"; then
    fail "D4a: agent web-search failed with provider/transport error (exit ${rc}): ${raw:0:300}"
    return
  fi

  reply=$(printf '%s' "$raw" | parse_openclaw_agent_text 2>/dev/null) || true

  if [ "$rc" -eq 0 ] && printf '%s' "$reply" | grep -qiE "nvidia|geforce|cuda|gpu"; then
    pass "D4a: openclaw agent web-search returned a recognizable DuckDuckGo result"
  else
    fail "D4a: agent web-search did not return a recognizable DuckDuckGo result (exit ${rc}, reply='${reply:0:200}')"
  fi
}

# D4b — real DuckDuckGo search via curl from inside the sandbox. Uses the
# keyless lite endpoint; HTTP 200 with a non-empty body proves egress is
# permitted by the duckduckgo preset and that no auth header is required.
check_real_ddg_search_via_curl() {
  local response status_code body rc=0
  response=$(openshell sandbox exec --name "$SANDBOX_NAME" -- sh -lc \
    "curl -sS --max-time 20 -A 'Mozilla/5.0 (NemoClaw E2E)' -G 'https://lite.duckduckgo.com/lite/' \
      --data-urlencode 'q=NVIDIA' \
      -w '\nHTTP_STATUS:%{http_code}\n'" \
    2>&1) || rc=$?

  status_code=$(printf '%s' "$response" | grep -m1 -oE 'HTTP_STATUS:[0-9]+' | head -1 | cut -d: -f2)
  body=$(printf '%s' "$response" | sed '/^HTTP_STATUS:/d')

  if [ "$status_code" = "200" ]; then
    if printf '%s' "$body" | grep -qiE "nvidia|geforce|cuda|gpu"; then
      pass "D4b: real DuckDuckGo search via curl returned HTTP 200 with NVIDIA-related content"
    else
      fail "D4b: HTTP 200 but body had no NVIDIA-related content (head: $(printf '%s' "${body:0:200}"))"
    fi
  elif [ "$status_code" = "000" ] || [ -z "$status_code" ]; then
    fail "D4b: curl never completed an HTTP transaction — check curl is in duckduckgo.yaml binaries allowlist. ${response:0:300}"
  else
    fail "D4b: unexpected HTTP status '${status_code:-<none>}' from DuckDuckGo (exit $rc)"
  fi
}

trap destroy_sandbox_best_effort EXIT

echo ""
echo "============================================================"
echo "  DuckDuckGo Search E2E (#4559)"
echo "  $(date)"
echo "============================================================"

section "Phase 0: Prerequisites"
if ! docker info >/dev/null 2>&1; then
  fail "Docker is not running"
  summary
fi
pass "Docker is running"

if ! command -v python3 >/dev/null 2>&1; then
  fail "python3 not found"
  summary
fi
pass "python3 is available"

load_shell_path
info "Repo: $REPO"
info "Sandbox: $SANDBOX_NAME"

section "Phase 1: Non-interactive onboard with DuckDuckGo (experimental)"
run_onboard_with_duckduckgo

section "Phase 2: DuckDuckGo preset is applied to the sandbox"
check_duckduckgo_preset_applied

section "Phase 3: No API key is emitted for DuckDuckGo"
check_no_api_key_emitted

section "Phase 4a: Real DuckDuckGo search via openclaw agent"
check_real_ddg_search_via_agent

section "Phase 4b: Real DuckDuckGo search via curl from inside the sandbox"
check_real_ddg_search_via_curl

trap - EXIT
destroy_sandbox_best_effort
summary
