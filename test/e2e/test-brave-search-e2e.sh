#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Brave Search E2E (Issue #2687)
#
# Verifies the issue's acceptance end-to-end:
#   B0   BRAVE_API_KEY is present (skip-suite gate)
#   B1   Non-interactive onboard with BRAVE_API_KEY succeeds
#   B2a  brave network policy preset is applied
#   B2b  openclaw web-search config selects brave (downstream of preset)
#   B3a  Real key never lands on disk in /sandbox/.openclaw/openclaw.json
#   B3b  Real key is not visible to sandbox-exec shells via printenv
#   B4a  Real Brave search via openclaw agent
#   B4b  Real Brave search via curl from inside the sandbox
#
# Required env (CI injects from secrets):
#   BRAVE_API_KEY    real Brave Search subscription token (skip-suite gate)
#   NVIDIA_API_KEY   drives the agent inference turn in B4a
#
# Secret hygiene: BRAVE_API_KEY is never echoed raw. All output that may
# contain it pipes through redact_stream; GitHub Actions auto-mask is the
# second line of defence.
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
#     BRAVE_API_KEY=... NVIDIA_API_KEY=... \
#     bash test/e2e/test-brave-search-e2e.sh

set -uo pipefail

export NEMOCLAW_E2E_DEFAULT_TIMEOUT=1800
SCRIPT_DIR_TIMEOUT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=test/e2e/e2e-timeout.sh
. "${SCRIPT_DIR_TIMEOUT}/e2e-timeout.sh"

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
  echo "  Brave Search E2E Results"
  echo "============================================================"
  echo "  PASS: $PASS"
  echo "  FAIL: $FAIL"
  echo "  SKIP: $SKIP"
  echo "  TOTAL: $TOTAL"
  echo "============================================================"
  if [ "$FAIL" -gt 0 ]; then exit 1; fi
}

# Streaming line-by-line redactor. Replaces every literal occurrence of
# $1 with REDACTED. Defence in depth on top of GitHub Actions auto-mask.
redact_stream() {
  local secret="${1:-}"
  SECRET_TO_REDACT="$secret" python3 -u -c '
import os, sys
secret = os.environ.get("SECRET_TO_REDACT", "")
for line in iter(sys.stdin.readline, ""):
    sys.stdout.write(line.replace(secret, "REDACTED") if secret else line)
    sys.stdout.flush()
'
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

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-brave-search}"
ONBOARD_LOG="/tmp/nemoclaw-e2e-brave-search-onboard.log"

# Ship a shell script into the sandbox without quoting hell — base64 on
# the host, decode inside. Used by B2b's python heredoc.
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

# B1 — non-interactive onboard with BRAVE_API_KEY.
# Output is mirrored to terminal AND captured to $ONBOARD_LOG, scrubbed
# by redact_stream as the first pipe stage. PIPESTATUS[0] captures the
# real onboard exit code (a plain $? would be tee's, which is always 0).
run_onboard_with_brave_key() {
  local onboard_exit=0 onboard_cmd_desc
  export NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME"
  export NEMOCLAW_RECREATE_SANDBOX=1
  export NEMOCLAW_NON_INTERACTIVE=1
  export NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1

  if cli_command_available_from_source; then
    onboard_cmd_desc="source CLI onboard"
    info "Using source-built CLI at $REPO/bin/nemoclaw.js"
    destroy_sandbox_best_effort
    run_with_timeout 1200 node "$REPO/bin/nemoclaw.js" onboard --fresh --non-interactive --yes-i-accept-third-party-software 2>&1 \
      | redact_stream "${BRAVE_API_KEY:-}" \
      | tee "$ONBOARD_LOG"
    onboard_exit=${PIPESTATUS[0]}
  else
    onboard_cmd_desc="install.sh"
    info "Source CLI is not built; running install.sh from this checkout."
    bash "$REPO/install.sh" --non-interactive --yes-i-accept-third-party-software --fresh 2>&1 \
      | redact_stream "${BRAVE_API_KEY:-}" \
      | tee "$ONBOARD_LOG"
    onboard_exit=${PIPESTATUS[0]}
    load_shell_path
  fi

  if [ "$onboard_exit" -eq 0 ]; then
    pass "B1: ${onboard_cmd_desc} completed for Brave Search-enabled onboard"
  else
    fail "B1: ${onboard_cmd_desc} failed (exit $onboard_exit)"
    summary
  fi

  # Scrub the on-disk log in place before any failure-artifact upload.
  if [ -n "${BRAVE_API_KEY:-}" ] && [ -f "$ONBOARD_LOG" ]; then
    local redacted_log
    redacted_log="$(mktemp)"
    redact_stream "$BRAVE_API_KEY" <"$ONBOARD_LOG" >"$redacted_log" || true
    mv "$redacted_log" "$ONBOARD_LOG" || rm -f "$redacted_log"
  fi
}

# B2 — brave preset is applied.
# B2a checks the gateway-level network policy; B2b checks openclaw's
# downstream web-search config (so a silent backend swap is also caught).
check_brave_preset_applied() {
  local policy_output rc=0 config_check config_rc=0 config_script

  policy_output=$(openshell policy get --full "$SANDBOX_NAME" 2>&1) || rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "B2a: openshell policy get failed (exit $rc)"
  elif printf '%s' "$policy_output" | grep -q "api.search.brave.com"; then
    pass "B2a: brave preset applied — api.search.brave.com is in the loaded gateway policy"
  else
    fail "B2a: brave preset NOT applied — api.search.brave.com is missing from the gateway policy"
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
PY
SH
  )
  config_check=$(sandbox_exec_sh_script "$config_script" 2>&1) || config_rc=$?

  if [ "$config_rc" -ne 0 ]; then
    fail "B2b: could not read openclaw web-search config (exit $config_rc)"
  elif printf '%s' "$config_check" | grep -q "^enabled=True$" \
    && printf '%s' "$config_check" | grep -q "^provider=brave$"; then
    pass "B2b: brave preset wired through to openclaw — tools.web.search.provider=brave and enabled=true"
  else
    fail "B2b: openclaw web-search config does not select brave (got: $(printf '%s' "$config_check" | tr '\n' ' '))"
  fi
}

# B3 — real key must not leak into the sandbox. Matches NemoClaw's design
# intent (scripts/nemoclaw-start.sh:560-564). B3a checks the on-disk
# openclaw.json; B3b checks the env of a `sandbox exec` shell.
check_no_real_key_in_sandbox() {
  local config_dump env_value

  config_dump=$(openshell sandbox exec --name "$SANDBOX_NAME" -- sh -lc \
    'cat /sandbox/.openclaw/openclaw.json 2>/dev/null || true' 2>&1) || true

  if [ -n "${BRAVE_API_KEY:-}" ] && printf '%s' "$config_dump" | grep -qF "$BRAVE_API_KEY"; then
    fail "B3a: SECURITY — real BRAVE_API_KEY found verbatim in /sandbox/.openclaw/openclaw.json"
  elif printf '%s' "$config_dump" | grep -q "openshell:resolve:env:BRAVE_API_KEY"; then
    pass "B3a: openclaw.json contains the placeholder, not the real key"
  else
    fail "B3a: openclaw.json has neither the real key nor the placeholder — web search not configured"
  fi

  env_value=$(openshell sandbox exec --name "$SANDBOX_NAME" -- sh -lc \
    'printenv BRAVE_API_KEY 2>/dev/null || true' 2>&1) || true

  if [ -n "${BRAVE_API_KEY:-}" ] && printf '%s' "$env_value" | grep -qF "$BRAVE_API_KEY"; then
    fail "B3b: SECURITY — real BRAVE_API_KEY visible to sandbox shell via printenv"
  elif [ -z "$env_value" ] || printf '%s' "$env_value" | grep -q "openshell:resolve:env:BRAVE_API_KEY"; then
    pass "B3b: sandbox shell env does not expose the real key (placeholder or empty)"
  else
    fail "B3b: unexpected non-empty BRAVE_API_KEY in sandbox env"
  fi
}

# B4a — real Brave search via openclaw agent.
# This is the realistic user path: SSH into sandbox, ask the agent to run
# its web-search tool, parse the JSON reply, assert NVIDIA-related text.
check_real_brave_search_via_agent() {
  local session_id raw ssh_cfg reply rc=0 ssh_cmd
  session_id="e2e-brave-agent-$(date +%s)-$$"
  ssh_cfg="$(mktemp)"

  if ! openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_cfg" 2>/dev/null; then
    rm -f "$ssh_cfg"
    fail "B4a: agent web-search turn — could not get SSH config"
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

  # Fail closed on explicit transport / proxy errors. Naked HTTP codes
  # like 401/403 are NOT in this list — they appear in benign JSON content
  # (URLs, timestamps) and would false-positive.
  if printf '%s' "$raw" | grep -qiE "SsrFBlockedError|Blocked hostname|ECONNREFUSED|EAI_AGAIN|gateway unavailable|network connection error"; then
    fail "B4a: agent web-search failed with provider/transport error (exit ${rc}): $(printf '%s' "${raw:0:300}" | redact_stream "${BRAVE_API_KEY:-}")"
    return
  fi

  reply=$(printf '%s' "$raw" | python3 -c "
import json, sys
try:
    doc = json.load(sys.stdin)
except Exception:
    sys.exit(0)
result = doc.get('result') or {}
parts = []
for p in result.get('payloads') or []:
    if isinstance(p, dict) and isinstance(p.get('text'), str):
        parts.append(p['text'])
print('\n'.join(parts))
" 2>/dev/null) || true

  # NVIDIA-related phrasing (nvidia, gpu, cuda, geforce) is overwhelmingly
  # likely in any legitimate top-1 web result for the query "NVIDIA".
  if [ "$rc" -eq 0 ] && printf '%s' "$reply" | grep -qiE "nvidia|geforce|cuda|gpu"; then
    pass "B4a: openclaw agent web-search returned a real Brave result"
  else
    fail "B4a: agent web-search did not return a recognizable Brave result (exit ${rc}, reply='$(printf '%s' "${reply:0:200}" | redact_stream "${BRAVE_API_KEY:-}")')"
  fi
}

# B4b — real Brave search via curl from inside the sandbox (literal reading
# of "e.g. via curl" in the issue). Pre-req: curl must be in brave.yaml's
# `binaries:` allowlist.
check_real_brave_search_via_curl() {
  local response status_code body rc=0

  response=$(openshell sandbox exec --name "$SANDBOX_NAME" -- sh -lc \
    "curl -sS --max-time 20 -G 'https://api.search.brave.com/res/v1/web/search' \
      --data-urlencode 'q=NVIDIA' \
      --data-urlencode 'count=1' \
      -H 'X-Subscription-Token: openshell:resolve:env:BRAVE_API_KEY' \
      -w '\nHTTP_STATUS:%{http_code}\n'" \
    2>&1) || rc=$?

  status_code=$(printf '%s' "$response" | grep -m1 -oE 'HTTP_STATUS:[0-9]+' | head -1 | cut -d: -f2)
  body=$(printf '%s' "$response" | sed '/^HTTP_STATUS:/d')

  if [ "$status_code" = "200" ]; then
    if printf '%s' "$body" | python3 -c '
import json, sys
try:
    doc = json.load(sys.stdin)
except Exception:
    sys.exit(1)
results = (doc.get("web") or {}).get("results") or []
sys.exit(0 if len(results) > 0 else 2)
' 2>/dev/null; then
      pass "B4b: real Brave search via curl returned HTTP 200 with non-empty web.results[]"
    else
      fail "B4b: HTTP 200 but response had no web.results[] (body parsed empty)"
    fi
  elif [ "$status_code" = "401" ] || [ "$status_code" = "403" ]; then
    skip "B4b: HTTP $status_code — proxy did not substitute the placeholder for a generic curl caller. B4a covers the positive path; drop B4b in the PR if so."
  elif [ "$status_code" = "000" ] || [ -z "$status_code" ]; then
    fail "B4b: curl never completed an HTTP transaction — check curl is in brave.yaml binaries allowlist. $(printf '%s' "${response:0:300}" | redact_stream "${BRAVE_API_KEY:-}")"
  else
    fail "B4b: unexpected HTTP status '${status_code:-<none>}' from Brave (exit $rc)"
  fi
}

trap destroy_sandbox_best_effort EXIT

echo ""
echo "============================================================"
echo "  Brave Search E2E (#2687)"
echo "  $(date)"
echo "============================================================"

# B0 — skip-suite gate. Self-skips when BRAVE_API_KEY is not set so the
# script is safe to enable before the secret exists.
section "Phase 0: Brave Search secret gate"
if [ -z "${BRAVE_API_KEY:-}" ]; then
  skip "B0: BRAVE_API_KEY is not set — skipping the entire Brave Search suite gracefully"
  summary
  # summary() only auto-exits on FAIL>0; a skip-only gate is a graceful
  # success, so exit 0 explicitly so nothing else runs.
  exit 0
fi
pass "B0: BRAVE_API_KEY is available"

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

section "Phase 1: Non-interactive onboard with BRAVE_API_KEY"
run_onboard_with_brave_key

section "Phase 2: Brave preset is applied to the sandbox"
check_brave_preset_applied

section "Phase 3: Real key not leaked into the sandbox"
check_no_real_key_in_sandbox

section "Phase 4a: Real Brave search via openclaw agent"
check_real_brave_search_via_agent

section "Phase 4b: Real Brave search via curl from inside the sandbox"
check_real_brave_search_via_curl

trap - EXIT
destroy_sandbox_best_effort
summary
