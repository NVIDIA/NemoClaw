#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Common Egress Agent E2E
#
# Proves the safe common-egress defaults through real agent turns:
#   C1  OpenClaw balanced includes weather and the agent fetches Open-Meteo.
#   C2  OpenClaw open includes public-reference and the agent fetches REST Countries.
#   C3  Hermes open includes public-reference plus all Hermes Nous policy presets,
#       and the Hermes agent fetches REST Countries through its API-server agent path.
#
# Required env:
#   NVIDIA_API_KEY                         real NVIDIA Endpoints key for inference
#   NEMOCLAW_NON_INTERACTIVE=1             required
#   NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 required
#
# Optional env:
#   NEMOCLAW_COMMON_EGRESS_SKIP_OPENCLAW=1 skip OpenClaw phases
#   NEMOCLAW_COMMON_EGRESS_SKIP_HERMES=1   skip Hermes phase
#   NEMOCLAW_COMMON_EGRESS_KEEP_SANDBOX=1  preserve created sandboxes

set -uo pipefail

export NEMOCLAW_E2E_DEFAULT_TIMEOUT=3600
SCRIPT_DIR_TIMEOUT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=test/e2e/e2e-timeout.sh
. "${SCRIPT_DIR_TIMEOUT}/e2e-timeout.sh"
# shellcheck source=test/e2e/lib/openclaw-json.sh
. "${SCRIPT_DIR_TIMEOUT}/lib/openclaw-json.sh"

PASS=0
FAIL=0
SKIP=0
TOTAL=0
SANDBOXES_TO_CLEAN=""

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
  echo "  Common Egress Agent E2E Results"
  echo "============================================================"
  echo "  PASS: $PASS"
  echo "  FAIL: $FAIL"
  echo "  SKIP: $SKIP"
  echo "  TOTAL: $TOTAL"
  echo "============================================================"
  if [ "$FAIL" -gt 0 ]; then exit 1; fi
}

quote_for_remote_sh() {
  local value="${1:-}"
  printf "'%s'" "$(printf '%s' "$value" | sed "s/'/'\\\\''/g")"
}

load_shell_path() {
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
}

parse_chat_content() {
  python3 -c '
import json
import sys
try:
    doc = json.load(sys.stdin)
    message = doc["choices"][0]["message"]
    content = message.get("content") or message.get("reasoning_content") or ""
    print(content.strip())
except Exception as exc:
    print(f"PARSE_ERROR: {exc}", file=sys.stderr)
    sys.exit(1)
'
}

http_status_from_response() {
  sed -n 's/^__NEMOCLAW_HTTP_STATUS__=//p' | tail -1
}

http_body_from_response() {
  sed '/^__NEMOCLAW_HTTP_STATUS__=/d'
}

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

cli_command_available_from_source() {
  [ -f "$REPO/dist/nemoclaw.js" ] && command -v node >/dev/null 2>&1 && command -v openshell >/dev/null 2>&1
}

run_nemoclaw_cli_with_timeout() {
  local seconds="$1"
  shift
  if cli_command_available_from_source; then
    run_with_timeout "$seconds" node "$REPO/bin/nemoclaw.js" "$@"
  elif command -v nemoclaw >/dev/null 2>&1; then
    run_with_timeout "$seconds" nemoclaw "$@"
  else
    return 127
  fi
}

destroy_sandbox_best_effort() {
  local sandbox="$1"
  if [ "${NEMOCLAW_E2E_KEEP_SANDBOX:-}" = "1" ] || [ "${NEMOCLAW_COMMON_EGRESS_KEEP_SANDBOX:-}" = "1" ]; then
    return 0
  fi
  run_nemoclaw_cli_with_timeout 120 "$sandbox" destroy --yes >/dev/null 2>&1 || true
  if command -v openshell >/dev/null 2>&1; then
    run_with_timeout 60 openshell sandbox delete "$sandbox" >/dev/null 2>&1 || true
  fi
}

cleanup_all() {
  local sandbox
  [ -z "$SANDBOXES_TO_CLEAN" ] && return 0
  while IFS= read -r sandbox; do
    [ -z "$sandbox" ] && continue
    destroy_sandbox_best_effort "$sandbox"
  done <<EOF
$SANDBOXES_TO_CLEAN
EOF
}

register_cleanup() {
  local sandbox="$1"
  case "
$SANDBOXES_TO_CLEAN
" in
    *"
$sandbox
"*) return 0 ;;
  esac
  if [ -z "$SANDBOXES_TO_CLEAN" ]; then
    SANDBOXES_TO_CLEAN="$sandbox"
  else
    SANDBOXES_TO_CLEAN="${SANDBOXES_TO_CLEAN}
${sandbox}"
  fi
}

run_onboard() {
  local sandbox="$1"
  local agent="$2"
  local tier="$3"
  local log="/tmp/nemoclaw-e2e-common-egress-${sandbox}.log"
  local rc=0

  register_cleanup "$sandbox"
  destroy_sandbox_best_effort "$sandbox"

  export NEMOCLAW_SANDBOX_NAME="$sandbox"
  export NEMOCLAW_AGENT="$agent"
  export NEMOCLAW_POLICY_TIER="$tier"
  export NEMOCLAW_POLICY_MODE=suggested
  export NEMOCLAW_RECREATE_SANDBOX=1
  export NEMOCLAW_NON_INTERACTIVE=1
  export NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1

  if cli_command_available_from_source; then
    info "Onboarding ${sandbox} from source CLI (agent=${agent}, tier=${tier})"
    run_with_timeout 1500 node "$REPO/bin/nemoclaw.js" onboard --fresh --non-interactive --yes-i-accept-third-party-software >"$log" 2>&1 || rc=$?
  else
    info "Onboarding ${sandbox} via install.sh (agent=${agent}, tier=${tier})"
    run_with_timeout 1800 bash "$REPO/install.sh" --non-interactive --yes-i-accept-third-party-software --fresh >"$log" 2>&1 || rc=$?
    load_shell_path
  fi

  if [ "$rc" -eq 0 ]; then
    pass "onboard completed for ${sandbox} (${agent}, ${tier})"
  else
    fail "onboard failed for ${sandbox} (${agent}, ${tier}); tail of ${log}:"
    tail -80 "$log" 2>/dev/null || true
    summary
  fi
}

assert_policy_contains() {
  local sandbox="$1"
  shift
  local label="$1"
  shift
  local policy_output rc=0 missing=()
  policy_output=$(openshell policy get --full "$sandbox" 2>&1) || rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "${label}: openshell policy get failed for ${sandbox} (exit ${rc})"
    return
  fi
  local needle
  for needle in "$@"; do
    if ! grep -Fq "$needle" <<<"$policy_output"; then
      missing+=("$needle")
    fi
  done
  if [ "${#missing[@]}" -eq 0 ]; then
    pass "${label}: expected policy endpoints are present"
  else
    fail "${label}: missing policy entries for ${sandbox}: ${missing[*]}"
  fi
}

assert_policy_absent() {
  local sandbox="$1"
  local label="$2"
  local needle="$3"
  local policy_output rc=0
  policy_output=$(openshell policy get --full "$sandbox" 2>&1) || rc=$?
  if [ "$rc" -ne 0 ]; then
    fail "${label}: openshell policy get failed for ${sandbox} (exit ${rc})"
    return
  fi
  if grep -Fq "$needle" <<<"$policy_output"; then
    fail "${label}: unexpected policy entry '${needle}' found in ${sandbox}"
  else
    pass "${label}: '${needle}' is not present"
  fi
}

run_openclaw_agent_assertion() {
  local sandbox="$1"
  local label="$2"
  local prompt="$3"
  local expected="$4"
  local ssh_cfg raw reply rc=0 session_id remote_cmd stderr_file stderr_text combined log_file attempt last_fail recover_rc
  log_file="/tmp/nemoclaw-e2e-common-egress-${sandbox}-agent.log"

  ssh_cfg="$(mktemp)"
  if ! openshell sandbox ssh-config "$sandbox" >"$ssh_cfg" 2>/dev/null; then
    rm -f "$ssh_cfg"
    fail "${label}: could not get SSH config"
    return
  fi

  last_fail=""
  for attempt in 1 2 3; do
    rc=0
    stderr_file="$(mktemp)"
    session_id="e2e-common-egress-$(date +%s)-$$-${attempt}"
    remote_cmd="rm -f /sandbox/.openclaw/agents/main/sessions/$(quote_for_remote_sh "${session_id}.jsonl.lock") /sandbox/.openclaw/agents/main/sessions/$(quote_for_remote_sh "${session_id}.trajectory.jsonl") 2>/dev/null || true; openclaw agent --agent main --json --thinking off --session-id $(quote_for_remote_sh "$session_id") -m $(quote_for_remote_sh "$prompt")"
    raw=$(run_with_timeout 180 ssh -F "$ssh_cfg" \
      -o StrictHostKeyChecking=no \
      -o UserKnownHostsFile=/dev/null \
      -o ConnectTimeout=10 \
      -o LogLevel=ERROR \
      "openshell-${sandbox}" \
      "$remote_cmd" \
      2>"$stderr_file") || rc=$?
    stderr_text="$(cat "$stderr_file" 2>/dev/null || true)"
    combined="${raw}
${stderr_text}"
    {
      printf '=== %s attempt=%s rc=%s ===\n' "$label" "$attempt" "$rc"
      printf '%s\n' '--- stdout ---'
      printf '%s\n' "$raw"
      printf '%s\n' '--- stderr ---'
      printf '%s\n' "$stderr_text"
    } >>"$log_file"
    rm -f "$stderr_file"

    if printf '%s' "$combined" | grep -qiE "SsrFBlockedError|Blocked hostname"; then
      rm -f "$ssh_cfg"
      fail "${label}: agent hit policy block (exit ${rc}): ${combined:0:300}"
      return
    fi

    reply=$(printf '%s' "$raw" | parse_openclaw_agent_text 2>/dev/null) || true
    if [ "$rc" -eq 0 ] && grep -Fq "$expected" <<<"$reply"; then
      rm -f "$ssh_cfg"
      pass "${label}: OpenClaw agent returned ${expected}"
      return
    fi
    last_fail="reply='${reply:0:240}' (exit ${rc}, raw='${raw:0:240}', stderr='${stderr_text:0:240}')"

    if [ "$attempt" -lt 3 ] && printf '%s' "$combined" | grep -qiE "scope upgrade pending approval|pairing required: device is asking for more scopes"; then
      info "${label}: pending OpenClaw scope upgrade detected; running recover before retry"
      recover_rc=0
      {
        printf '=== %s recover after attempt=%s ===\n' "$label" "$attempt"
      } >>"$log_file"
      run_nemoclaw_cli_with_timeout 120 "$sandbox" recover >>"$log_file" 2>&1 || recover_rc=$?
      if [ "$recover_rc" -ne 0 ]; then
        info "${label}: recover exited ${recover_rc}; retrying agent turn"
      fi
      sleep $((attempt * 15))
      continue
    fi

    if [ "$attempt" -lt 3 ] && printf '%s' "$combined" | grep -qiE "ECONNREFUSED|EAI_AGAIN|ECONNRESET|ETIMEDOUT|gateway unavailable|network connection error|DNS error|fetch failed|LLM request timed out|FailoverError|inference service unavailable|rawError=503"; then
      info "${label}: transient agent/inference error detected; retrying after backoff"
      sleep $((attempt * 15))
      continue
    fi

    [ "$attempt" -ge 3 ] || sleep 5
  done

  rm -f "$ssh_cfg"
  fail "${label}: expected ${expected}, got ${last_fail}"
}

run_hermes_agent_assertion() {
  local sandbox="$1"
  local label="$2"
  local prompt="$3"
  local expected="$4"
  local payload response reply rc=0 model remote attempt last_fail http_code body log_file
  model="${NEMOCLAW_MODEL:-nvidia/nemotron-3-super-120b-a12b}"
  log_file="/tmp/nemoclaw-e2e-common-egress-${sandbox}-agent.log"
  payload=$(
    MODEL="$model" PROMPT="$prompt" python3 - <<'PY'
import json
import os

print(json.dumps({
    "model": os.environ["MODEL"],
    "messages": [{"role": "user", "content": os.environ["PROMPT"]}],
    "max_tokens": 300,
}))
PY
  )
  remote="set -a; [ ! -f /sandbox/.hermes/.env ] || . /sandbox/.hermes/.env; set +a; tmp=\$(mktemp); if [ -n \"\${API_SERVER_KEY:-}\" ]; then code=\$(curl -sS -o \"\$tmp\" -w '%{http_code}' --max-time 120 http://localhost:8642/v1/chat/completions -H 'Content-Type: application/json' -H \"Authorization: Bearer \${API_SERVER_KEY}\" -d $(quote_for_remote_sh "$payload")); else code=\$(curl -sS -o \"\$tmp\" -w '%{http_code}' --max-time 120 http://localhost:8642/v1/chat/completions -H 'Content-Type: application/json' -d $(quote_for_remote_sh "$payload")); fi; rc=\$?; cat \"\$tmp\"; rm -f \"\$tmp\"; printf '\n__NEMOCLAW_HTTP_STATUS__=%s\n' \"\${code:-000}\"; exit \"\$rc\""
  last_fail=""

  for attempt in 1 2 3; do
    rc=0
    response=$(run_with_timeout 150 openshell sandbox exec --name "$sandbox" -- sh -lc "$remote" 2>&1) || rc=$?
    http_code=$(printf '%s' "$response" | http_status_from_response)
    [ -n "$http_code" ] || http_code="000"
    body=$(printf '%s' "$response" | http_body_from_response)
    reply=$(printf '%s' "$body" | parse_chat_content 2>/dev/null) || true
    {
      printf '=== %s attempt=%s rc=%s http=%s ===\n' "$label" "$attempt" "$rc" "$http_code"
      printf '%s\n' "$response"
    } >>"$log_file"

    if [ "$rc" -eq 0 ] && [ "$http_code" = "200" ] && grep -Fq "$expected" <<<"$reply"; then
      pass "${label}: Hermes agent returned ${expected}"
      return
    fi
    last_fail="exit ${rc}, HTTP ${http_code}, reply='${reply:0:240}', raw='${body:0:240}'"
    [ "$attempt" -ge 3 ] || sleep 5
  done

  fail "${label}: expected ${expected}, got ${last_fail}"
}

trap cleanup_all EXIT

echo ""
echo "============================================================"
echo "  Common Egress Agent E2E"
echo "  $(date)"
echo "============================================================"

section "Phase 0: Prerequisites"
load_shell_path
info "Repo: $REPO"

if ! docker info >/dev/null 2>&1; then
  fail "Docker is not running"
  summary
fi
pass "Docker is running"

if [ -z "${NVIDIA_API_KEY:-}" ] || [[ "${NVIDIA_API_KEY}" != nvapi-* ]]; then
  fail "NVIDIA_API_KEY not set or invalid"
  summary
fi
pass "NVIDIA_API_KEY is set"

if [ "${NEMOCLAW_NON_INTERACTIVE:-}" != "1" ]; then
  fail "NEMOCLAW_NON_INTERACTIVE=1 is required"
  summary
fi
pass "NEMOCLAW_NON_INTERACTIVE=1"

if [ "${NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE:-}" != "1" ]; then
  fail "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 is required"
  summary
fi
pass "Third-party software acceptance env is set"

if [ "${NEMOCLAW_COMMON_EGRESS_SKIP_OPENCLAW:-}" != "1" ]; then
  section "Phase 1: OpenClaw balanced weather"
  OPENCLAW_BALANCED_SANDBOX="${NEMOCLAW_COMMON_EGRESS_OPENCLAW_BALANCED_SANDBOX:-e2e-common-egress-openclaw-balanced}"
  run_onboard "$OPENCLAW_BALANCED_SANDBOX" "openclaw" "balanced"
  assert_policy_contains "$OPENCLAW_BALANCED_SANDBOX" "C1 policy" "api.open-meteo.com" "geocoding-api.open-meteo.com"
  assert_policy_absent "$OPENCLAW_BALANCED_SANDBOX" "C1 balanced scope" "restcountries.com"
  WEATHER_AGENT_PROMPT=$(
    cat <<'PROMPT'
Use the web_fetch tool to fetch exactly this URL:
https://api.open-meteo.com/v1/forecast?latitude=47.4979&longitude=19.0402&current=temperature_2m
After web_fetch returns, reply exactly WEATHER_AGENT_OK if the fetched response contains temperature_2m. Do not fetch any other URL.
PROMPT
  )
  run_openclaw_agent_assertion "$OPENCLAW_BALANCED_SANDBOX" "C1 agent weather" "$WEATHER_AGENT_PROMPT" "WEATHER_AGENT_OK"

  section "Phase 2: OpenClaw open public reference"
  OPENCLAW_OPEN_SANDBOX="${NEMOCLAW_COMMON_EGRESS_OPENCLAW_OPEN_SANDBOX:-e2e-common-egress-openclaw-open}"
  run_onboard "$OPENCLAW_OPEN_SANDBOX" "openclaw" "open"
  assert_policy_contains "$OPENCLAW_OPEN_SANDBOX" "C2 policy" "restcountries.com" "nominatim.openstreetmap.org" "query.wikidata.org"
  REFERENCE_AGENT_PROMPT=$(
    cat <<'PROMPT'
Use the web_fetch tool to fetch exactly this URL:
https://restcountries.com/v3.1/alpha/US?fields=name,cca3
After web_fetch returns, reply exactly REFERENCE_AGENT_OK if the fetched response says the common name is United States and cca3 is USA. Do not fetch any other URL.
PROMPT
  )
  run_openclaw_agent_assertion "$OPENCLAW_OPEN_SANDBOX" "C2 agent reference" "$REFERENCE_AGENT_PROMPT" "REFERENCE_AGENT_OK"
else
  skip "OpenClaw common-egress phases skipped by NEMOCLAW_COMMON_EGRESS_SKIP_OPENCLAW=1"
fi

if [ "${NEMOCLAW_COMMON_EGRESS_SKIP_HERMES:-}" != "1" ]; then
  section "Phase 3: Hermes open public reference"
  HERMES_SANDBOX="${NEMOCLAW_COMMON_EGRESS_HERMES_SANDBOX:-e2e-common-egress-hermes-open}"
  run_onboard "$HERMES_SANDBOX" "hermes" "open"
  assert_policy_contains "$HERMES_SANDBOX" "C3 common policy" "restcountries.com" "api.open-meteo.com"
  assert_policy_contains "$HERMES_SANDBOX" "C3 Hermes Nous policy" "/firecrawl" "/fal-queue" "/openai-audio" "/browser-use" "/modal"
  HERMES_REFERENCE_AGENT_PROMPT=$(
    cat <<'PROMPT'
Use your terminal tool to run this Python check exactly once:
python3 - <<'PY'
import json
import urllib.request

url = "https://restcountries.com/v3.1/alpha/US?fields=name,cca3"
with urllib.request.urlopen(url, timeout=20) as response:
    doc = json.load(response)
country = doc[0] if isinstance(doc, list) else doc
ok = country.get("name", {}).get("common") == "United States" and country.get("cca3") == "USA"
print("HERMES_REFERENCE_AGENT_OK" if ok else "HERMES_REFERENCE_AGENT_BAD")
PY
After the command completes, reply exactly HERMES_REFERENCE_AGENT_OK if that exact token appeared. Do not fetch any other URL.
PROMPT
  )
  run_hermes_agent_assertion "$HERMES_SANDBOX" "C3 agent reference" "$HERMES_REFERENCE_AGENT_PROMPT" "HERMES_REFERENCE_AGENT_OK"
else
  skip "Hermes common-egress phase skipped by NEMOCLAW_COMMON_EGRESS_SKIP_HERMES=1"
fi

trap - EXIT
cleanup_all
summary
