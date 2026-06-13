#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# OpenClaw inference switch E2E.
#
# Installs NemoClaw with the default OpenClaw agent, switches the running
# sandbox with `nemoclaw inference set`, verifies OpenShell and OpenClaw config
# state, then sends live requests through inference.local and OpenClaw.
#
# Prerequisites:
#   - Docker running
#   - NVIDIA_INFERENCE_API_KEY set (real key, starts with nvapi-)
#   - NEMOCLAW_NON_INTERACTIVE=1
#   - NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1

# Do not use errexit because this test records pass/fail counts and exits
# explicitly after critical failures or at the final summary.
set -uo pipefail

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

is_transient_live_http_code() {
  case "${1:-}" in
    502 | 503 | 504) return 0 ;;
    *) return 1 ;;
  esac
}

http_status_from_response() {
  sed -n 's/^__NEMOCLAW_HTTP_STATUS__=//p' <<<"$1" | tail -1
}

http_body_from_response() {
  sed '/^__NEMOCLAW_HTTP_STATUS__=/d' <<<"$1"
}

run_with_timeout() {
  local seconds="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$seconds" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$seconds" "$@"
  else
    "$@"
  fi
}

parse_chat_content() {
  python3 -c "
import json, sys
try:
    r = json.load(sys.stdin)
    c = r['choices'][0]['message']
    content = c.get('content') or c.get('reasoning_content') or c.get('reasoning') or ''
    print(content.strip())
except Exception as e:
    print(f'PARSE_ERROR: {e}', file=sys.stderr)
    sys.exit(1)
"
}

openclaw_gateway_pid() {
  # shellcheck disable=SC2016  # awk runs inside the sandbox.
  openshell sandbox exec --name "$SANDBOX_NAME" -- sh -lc \
    'ps -eo pid=,comm=,args= 2>/dev/null | awk '"'"'$2 != "sh" && $2 != "bash" && $2 != "awk" && $0 ~ /openclaw/ && $0 ~ /gateway run/ { print $1; exit }'"'"'' \
    2>/dev/null || true
}

get_route_output() {
  local output
  if output=$(openshell inference get -g nemoclaw 2>&1); then
    printf '%s\n' "$output"
    return 0
  fi
  openshell inference get 2>&1
}

strip_ansi() {
  python3 -c 'import re, sys; sys.stdout.write(re.sub(r"\x1b\[[0-9;]*m", "", sys.stdin.read()))'
}

assert_route() {
  local output plain_output
  if ! output=$(get_route_output); then
    fail "OpenShell inference get failed: ${output:0:240}"
    return
  fi
  plain_output=$(printf '%s' "$output" | strip_ansi)

  if grep -Fq "Provider: ${SWITCH_PROVIDER}" <<<"$plain_output" \
    && grep -Fq "Model: ${SWITCH_MODEL}" <<<"$plain_output"; then
    pass "OpenShell route points at ${SWITCH_PROVIDER} / ${SWITCH_MODEL}"
  else
    fail "OpenShell route did not switch to ${SWITCH_PROVIDER} / ${SWITCH_MODEL}: ${plain_output:0:400}"
  fi
}

assert_registry_session() {
  local probe
  probe=$(
    SANDBOX_NAME="$SANDBOX_NAME" EXPECTED_PROVIDER="$SWITCH_PROVIDER" EXPECTED_MODEL="$SWITCH_MODEL" python3 - <<'PY'
import json
import os
from pathlib import Path

home = Path.home()
name = os.environ["SANDBOX_NAME"]
provider = os.environ["EXPECTED_PROVIDER"]
model = os.environ["EXPECTED_MODEL"]
errors = []

registry_path = home / ".nemoclaw" / "sandboxes.json"
try:
    registry = json.loads(registry_path.read_text(encoding="utf-8"))
    sandbox = (registry.get("sandboxes") or {}).get(name)
except Exception as exc:
    sandbox = None
    errors.append(f"could not read registry: {exc}")

if not sandbox:
    errors.append(f"sandbox {name} missing from registry")
else:
    if sandbox.get("provider") != provider:
        errors.append(f"registry provider={sandbox.get('provider')!r}")
    if sandbox.get("model") != model:
        errors.append(f"registry model={sandbox.get('model')!r}")

session_path = home / ".nemoclaw" / "onboard-session.json"
try:
    session = json.loads(session_path.read_text(encoding="utf-8"))
except Exception as exc:
    session = None
    errors.append(f"could not read onboard session: {exc}")

if session is not None:
    if not isinstance(session, dict) or not session:
        errors.append("onboard session is empty or invalid")
    else:
        if session.get("sandboxName") != name:
            errors.append(f"session sandboxName={session.get('sandboxName')!r}")
        if session.get("provider") != provider:
            errors.append(f"session provider={session.get('provider')!r}")
        if session.get("model") != model:
            errors.append(f"session model={session.get('model')!r}")

if errors:
    print("; ".join(errors))
    raise SystemExit(1)
print("OK")
PY
  ) || {
    fail "Registry/session were not updated for switch: ${probe:0:400}"
    return
  }
  pass "Registry and onboard session record the switched provider/model"
}

assert_openclaw_config() {
  local config probe hash_check
  config=$(openshell sandbox exec --name "$SANDBOX_NAME" -- cat /sandbox/.openclaw/openclaw.json 2>&1) || {
    fail "Could not read /sandbox/.openclaw/openclaw.json: ${config:0:240}"
    return
  }

  probe=$(EXPECTED_MODEL="$SWITCH_MODEL" EXPECTED_INFERENCE_API="$SWITCH_INFERENCE_API" python3 -c '
import json
import os
import sys

expected = os.environ["EXPECTED_MODEL"]
expected_api = os.environ["EXPECTED_INFERENCE_API"]
doc = json.load(sys.stdin)
errors = []
primary = (((doc.get("agents") or {}).get("defaults") or {}).get("model") or {}).get("primary")
expected_provider_key = "anthropic" if expected_api == "anthropic-messages" else "inference"
expected_primary = f"{expected_provider_key}/{expected}"
if primary != expected_primary:
    errors.append(f"primary={primary!r}")

provider = (((doc.get("models") or {}).get("providers") or {}).get(expected_provider_key) or {})
expected_base = "https://inference.local" if expected_api == "anthropic-messages" else "https://inference.local/v1"
if provider.get("baseUrl") != expected_base:
    errors.append("baseUrl={!r}".format(provider.get("baseUrl")))
if provider.get("api") != expected_api:
    errors.append("api={!r}".format(provider.get("api")))
models = provider.get("models") or []
if not models or models[0].get("id") != expected:
    errors.append("model id={!r}".format(models[0].get("id") if models else None))
if not models or models[0].get("name") != expected_primary:
    errors.append("model name={!r}".format(models[0].get("name") if models else None))

if errors:
    print("; ".join(errors))
    raise SystemExit(1)
print("OK")
' <<<"$config" 2>&1) || {
    fail "OpenClaw config was not patched correctly: ${probe:0:400}"
    return
  }
  pass "OpenClaw config uses ${SWITCH_INFERENCE_API} route for ${SWITCH_MODEL}"

  hash_check=$(openshell sandbox exec --name "$SANDBOX_NAME" -- sh -lc \
    'cd /sandbox/.openclaw && sha256sum -c .config-hash --status && echo OK' 2>&1 || true)
  if grep -qx "OK" <<<"$hash_check"; then
    pass "OpenClaw config hash matches openclaw.json"
  else
    fail "OpenClaw config hash check failed: ${hash_check:0:240}"
  fi
}

check_sandbox_inference() {
  local payload payload_arg response rc content attempt last_fail http_code body remote transient=0
  payload=$(SWITCH_MODEL="$SWITCH_MODEL" SWITCH_INFERENCE_API="$SWITCH_INFERENCE_API" python3 -c '
import json
import os
if os.environ["SWITCH_INFERENCE_API"] == "anthropic-messages":
    print(json.dumps({
        "model": os.environ["SWITCH_MODEL"],
        "messages": [{"role": "user", "content": "Reply with exactly one word: PONG"}],
        "max_tokens": 32,
    }))
else:
    print(json.dumps({
        "model": os.environ["SWITCH_MODEL"],
        "messages": [{"role": "user", "content": "Reply with exactly one word: PONG"}],
        "max_tokens": 100,
    }))
')
  payload_arg="$(printf '%q' "$payload")"
  if [ "$SWITCH_INFERENCE_API" = "anthropic-messages" ]; then
    remote="tmp=\$(mktemp); code=\$(curl -sS -o \"\$tmp\" -w '%{http_code}' --max-time 90 https://inference.local/v1/messages -H 'Content-Type: application/json' -H 'anthropic-version: 2023-06-01' -d $payload_arg); rc=\$?; cat \"\$tmp\"; rm -f \"\$tmp\"; printf '\n__NEMOCLAW_HTTP_STATUS__=%s\n' \"\${code:-000}\"; exit \"\$rc\""
  else
    remote="tmp=\$(mktemp); code=\$(curl -sS -o \"\$tmp\" -w '%{http_code}' --max-time 90 https://inference.local/v1/chat/completions -H 'Content-Type: application/json' -d $payload_arg); rc=\$?; cat \"\$tmp\"; rm -f \"\$tmp\"; printf '\n__NEMOCLAW_HTTP_STATUS__=%s\n' \"\${code:-000}\"; exit \"\$rc\""
  fi
  last_fail=""

  for attempt in 1 2 3; do
    rc=0
    transient=0
    response=$(openshell sandbox exec --name "$SANDBOX_NAME" -- sh -lc "$remote" 2>&1) || rc=$?
    http_code=$(http_status_from_response "$response")
    [ -n "$http_code" ] || http_code="000"
    body=$(http_body_from_response "$response")

    if [ "$rc" -ne 0 ]; then
      [ "$rc" -eq 28 ] && transient=1
      last_fail="curl failed with exit ${rc}; HTTP ${http_code}: ${body:0:300}"
    elif is_transient_live_http_code "$http_code"; then
      transient=1
      last_fail="transient HTTP ${http_code}: ${body:0:300}"
    elif [ "$http_code" != "200" ]; then
      last_fail="HTTP ${http_code}: ${body:0:300}"
    else
      if [ "$SWITCH_INFERENCE_API" = "anthropic-messages" ]; then
        content=$(printf '%s' "$body" | parse_anthropic_content 2>/dev/null) || content=""
      else
        content=$(printf '%s' "$body" | parse_chat_content 2>/dev/null) || content=""
      fi
      if grep -qi "PONG" <<<"$content"; then
        pass "Sandbox inference.local returned PONG with ${SWITCH_MODEL}"
        return
      fi
      last_fail="expected PONG, got ${content:0:300}"
    fi

    [ "$attempt" -ge 3 ] || {
      info "Sandbox inference attempt ${attempt}/3 failed: ${last_fail}"
      sleep 5
    }
  done

  if [ "$transient" -eq 1 ]; then
    skip "Sandbox inference.local transient failure after switch; route/config checks already passed"
  else
    fail "Sandbox inference.local did not work after switch: ${last_fail}"
  fi
}

check_openclaw_agent_turn() {
  local ssh_config session_id raw stderr_file rc reply warnings
  ssh_config="$(mktemp)"
  if ! openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_config" 2>/dev/null; then
    rm -f "$ssh_config"
    fail "Could not get SSH config for OpenClaw agent turn"
    return
  fi

  session_id="e2e-inference-switch-openclaw-$(date +%s)-$$"
  stderr_file="$(mktemp)"
  rc=0
  raw=$(run_with_timeout 120 ssh -F "$ssh_config" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 \
    -o LogLevel=ERROR \
    "openshell-${SANDBOX_NAME}" \
    "openclaw agent --agent main --json --session-id '${session_id}' -m 'Reply with exactly one word: PONG'" \
    2>"$stderr_file") || rc=$?
  warnings="$(cat "$stderr_file" 2>/dev/null || true)"
  rm -f "$ssh_config"
  rm -f "$stderr_file"

  reply=$(printf '%s' "$raw" | parse_openclaw_agent_text 2>/dev/null) || true

  if [ "$rc" -eq 0 ] && grep -qi "PONG" <<<"$reply"; then
    pass "OpenClaw agent answered through the switched inference route"
  elif [ "$rc" -eq 124 ]; then
    skip "OpenClaw agent turn timed out after switch; route/config checks already passed"
  else
    fail "OpenClaw agent turn failed after switch (exit ${rc}); reply='${reply:0:200}', raw='${raw:0:200}', stderr='${warnings:0:200}'"
  fi
}

if [ -d /workspace ] && [ -f /workspace/install.sh ]; then
  REPO="/workspace"
elif [ -f "$(cd "$(dirname "$0")/../.." && pwd)/install.sh" ]; then
  REPO="$(cd "$(dirname "$0")/../.." && pwd)"
else
  echo "ERROR: Cannot find repo root."
  exit 1
fi

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=test/e2e/lib/openclaw-json.sh
. "${E2E_DIR}/lib/openclaw-json.sh"
# shellcheck source=test/e2e/lib/inference-switch-retry.sh
. "${E2E_DIR}/lib/inference-switch-retry.sh"
# shellcheck source=test/e2e/lib/anthropic-switch-provider.sh
. "${E2E_DIR}/lib/anthropic-switch-provider.sh"
SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-openclaw-inference-switch}"
SWITCH_PROVIDER="${NEMOCLAW_SWITCH_PROVIDER:-nvidia-prod}"
SWITCH_MODEL="${NEMOCLAW_SWITCH_MODEL:-z-ai/glm-5.1}"
SWITCH_INFERENCE_API="${NEMOCLAW_SWITCH_INFERENCE_API:-openai-completions}"
# shellcheck disable=SC2034  # consumed by anthropic-switch-provider.sh helpers
SWITCH_ENDPOINT_URL="${NEMOCLAW_SWITCH_ENDPOINT_URL:-}"
# shellcheck disable=SC2034  # consumed by anthropic-switch-provider.sh helpers
SWITCH_MOCK_ANTHROPIC="${NEMOCLAW_SWITCH_MOCK_ANTHROPIC:-0}"
# shellcheck disable=SC2034  # consumed by anthropic-switch-provider.sh helpers
SWITCH_MOCK_PORT="${NEMOCLAW_SWITCH_MOCK_PORT:-18767}"
INSTALL_LOG="/tmp/nemoclaw-e2e-openclaw-inference-switch-install.log"

# shellcheck source=test/e2e/lib/sandbox-teardown.sh
. "${E2E_DIR}/lib/sandbox-teardown.sh"
trap 'stop_mock_anthropic_switch_provider; _nemoclaw_sandbox_teardown' EXIT
# shellcheck source=test/e2e/lib/install-path-refresh.sh
. "${E2E_DIR}/lib/install-path-refresh.sh"
register_sandbox_for_teardown "$SANDBOX_NAME"

section "Phase 0: Pre-cleanup"
if command -v nemoclaw >/dev/null 2>&1; then
  nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true
fi
if command -v openshell >/dev/null 2>&1; then
  openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true
  openshell gateway destroy -g nemoclaw 2>/dev/null || true
fi
pass "Pre-cleanup complete"

section "Phase 1: Prerequisites"
if docker info >/dev/null 2>&1; then
  pass "Docker is running"
else
  fail "Docker is not running"
  exit 1
fi

if [ -n "${NVIDIA_INFERENCE_API_KEY:-}" ] && [[ "${NVIDIA_INFERENCE_API_KEY}" == nvapi-* ]]; then
  pass "NVIDIA_INFERENCE_API_KEY is set"
else
  fail "NVIDIA_INFERENCE_API_KEY not set or invalid"
  exit 1
fi

if [ "${NEMOCLAW_NON_INTERACTIVE:-}" = "1" ]; then
  pass "NEMOCLAW_NON_INTERACTIVE=1"
else
  fail "NEMOCLAW_NON_INTERACTIVE=1 is required"
  exit 1
fi

if [ "${NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE:-}" = "1" ]; then
  pass "Third-party software acceptance is set"
else
  fail "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 is required"
  exit 1
fi

section "Phase 2: Install and onboard OpenClaw"
cd "$REPO" || {
  fail "Could not cd to repo root: $REPO"
  exit 1
}

export NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME"
export NEMOCLAW_RECREATE_SANDBOX="${NEMOCLAW_RECREATE_SANDBOX:-1}"

info "Running install.sh --non-interactive for sandbox ${SANDBOX_NAME}..."
bash install.sh --non-interactive --yes-i-accept-third-party-software >"$INSTALL_LOG" 2>&1 &
install_pid=$!
tail -f "$INSTALL_LOG" --pid=$install_pid 2>/dev/null &
tail_pid=$!
wait "$install_pid"
install_exit=$?
kill "$tail_pid" 2>/dev/null || true
wait "$tail_pid" 2>/dev/null || true

nemoclaw_refresh_install_env
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck source=/dev/null
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nemoclaw_ensure_local_bin_on_path

if [ "$install_exit" -eq 0 ]; then
  pass "install.sh completed"
else
  fail "install.sh failed (exit ${install_exit})"
  tail -80 "$INSTALL_LOG" || true
  exit 1
fi

command -v nemoclaw >/dev/null 2>&1 || {
  fail "nemoclaw not found on PATH"
  exit 1
}
command -v openshell >/dev/null 2>&1 || {
  fail "openshell not found on PATH"
  exit 1
}
pass "nemoclaw and openshell are on PATH"
ensure_compatible_anthropic_switch_provider || exit 1

section "Phase 3: Switch inference"
pid_before="$(openclaw_gateway_pid)"
info "Switching ${SANDBOX_NAME} to ${SWITCH_PROVIDER} / ${SWITCH_MODEL}..."
switch_output=$(run_inference_set_with_retry nemoclaw inference set --provider "$SWITCH_PROVIDER" --model "$SWITCH_MODEL" --sandbox "$SANDBOX_NAME")
switch_rc=$?
if [ "$switch_rc" -eq 0 ]; then
  pass "nemoclaw inference set completed"
else
  fail "nemoclaw inference set failed (exit ${switch_rc}): ${switch_output:0:500}"
  exit 1
fi

pid_after="$(openclaw_gateway_pid)"
if [ -n "$pid_before" ] && [ -n "$pid_after" ]; then
  if [ "$pid_before" = "$pid_after" ]; then
    pass "OpenClaw gateway process stayed running during switch"
  else
    fail "OpenClaw gateway process changed during switch (${pid_before} -> ${pid_after})"
  fi
else
  skip "Could not capture OpenClaw gateway PID before and after switch"
fi

assert_route
assert_openclaw_config
assert_registry_session

section "Phase 4: Live requests after switch"
check_sandbox_inference
check_openclaw_agent_turn

section "Phase 5: Cleanup"
if [ "${NEMOCLAW_E2E_KEEP_SANDBOX:-}" != "1" ]; then
  nemoclaw "$SANDBOX_NAME" destroy --yes 2>&1 | tail -3 || true
  openshell gateway destroy -g nemoclaw 2>/dev/null || true

  registry_file="${HOME}/.nemoclaw/sandboxes.json"
  if [ -f "$registry_file" ] && grep -Fq "\"${SANDBOX_NAME}\"" "$registry_file"; then
    fail "Sandbox ${SANDBOX_NAME} still in registry after destroy"
  else
    pass "Sandbox ${SANDBOX_NAME} removed"
  fi
else
  skip "Sandbox ${SANDBOX_NAME} kept; removal check skipped"
fi

echo ""
echo "========================================"
echo "  OpenClaw inference switch E2E Results:"
echo "    Passed:  $PASS"
echo "    Failed:  $FAIL"
echo "    Skipped: $SKIP"
echo "    Total:   $TOTAL"
echo "========================================"

if [ "$FAIL" -eq 0 ]; then
  printf '\n\033[1;32m  OpenClaw inference switch E2E PASSED.\033[0m\n'
  exit 0
fi

printf '\n\033[1;31m  %d test(s) failed.\033[0m\n' "$FAIL"
exit 1
