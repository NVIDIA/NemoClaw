#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Real agent turn latency E2E.
#
# Installs one OpenClaw sandbox and one Hermes sandbox against NVIDIA Endpoints,
# verifies that both are configured for the requested model, and times one real
# model-backed turn through each runtime.
#
# Prerequisites:
#   - Docker running
#   - NVIDIA_API_KEY set (real key, starts with nvapi-)
#   - NEMOCLAW_NON_INTERACTIVE=1
#   - NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1

# Do not use errexit because this test records pass/fail counts and exits
# explicitly after critical failures or at the final summary.
set -uo pipefail

: "${NEMOCLAW_E2E_DEFAULT_TIMEOUT:=7200}"
export NEMOCLAW_E2E_DEFAULT_TIMEOUT

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=test/e2e/e2e-timeout.sh
source "${SCRIPT_DIR}/e2e-timeout.sh"
# shellcheck source=test/e2e/lib/openclaw-json.sh
source "${SCRIPT_DIR}/lib/openclaw-json.sh"
# shellcheck source=test/e2e/lib/sandbox-teardown.sh
source "${SCRIPT_DIR}/lib/sandbox-teardown.sh"
# shellcheck source=test/e2e/lib/install-path-refresh.sh
source "${SCRIPT_DIR}/lib/install-path-refresh.sh"

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

section() {
  echo ""
  printf '\033[1;36m=== %s ===\033[0m\n' "$1"
}

info() { printf '\033[1;34m  [info]\033[0m %s\n' "$1"; }

is_positive_int() {
  [[ "${1:-}" =~ ^[1-9][0-9]*$ ]]
}

monotonic_ms() {
  python3 -c 'import time; print(time.monotonic_ns() // 1000000)'
}

duration_s() {
  python3 - "$1" <<'PY'
import sys

ms = int(sys.argv[1])
print(f"{ms / 1000:.3f}s")
PY
}

strip_ansi() {
  python3 -c 'import re, sys; sys.stdout.write(re.sub(r"\x1b\[[0-9;]*m", "", sys.stdin.read()))'
}

parse_chat_content() {
  python3 -c '
import json
import sys

try:
    r = json.load(sys.stdin)
    c = r["choices"][0]["message"]
    content = c.get("content") or c.get("reasoning_content") or c.get("reasoning") or ""
    print(content.strip())
except Exception as exc:
    print(f"PARSE_ERROR: {exc}", file=sys.stderr)
    sys.exit(1)
'
}

http_status_from_response() {
  sed -n 's/^__NEMOCLAW_HTTP_STATUS__=//p' <<<"$1" | tail -1
}

http_body_from_response() {
  sed '/^__NEMOCLAW_HTTP_STATUS__=/d' <<<"$1"
}

get_route_output() {
  local output
  if output=$(openshell inference get -g nemoclaw 2>&1); then
    printf '%s\n' "$output"
    return 0
  fi
  openshell inference get 2>&1
}

assert_route() {
  local label="$1"
  local output plain_output
  if ! output=$(get_route_output); then
    fail "${label}: openshell inference get failed: ${output:0:240}"
    return
  fi
  plain_output=$(printf '%s' "$output" | strip_ansi)

  if grep -Fq "Provider: ${EXPECTED_ROUTE_PROVIDER}" <<<"$plain_output" \
    && grep -Fq "Model: ${TURN_MODEL}" <<<"$plain_output"; then
    pass "${label}: OpenShell route is ${EXPECTED_ROUTE_PROVIDER} / ${TURN_MODEL}"
  else
    fail "${label}: route is not ${EXPECTED_ROUTE_PROVIDER} / ${TURN_MODEL}: ${plain_output:0:400}"
  fi
}

assert_openclaw_config() {
  local sandbox="$1"
  local config probe
  config=$(openshell sandbox exec --name "$sandbox" -- cat /sandbox/.openclaw/openclaw.json 2>&1) || {
    fail "OpenClaw config: could not read /sandbox/.openclaw/openclaw.json: ${config:0:240}"
    return
  }

  probe=$(EXPECTED_MODEL="$TURN_MODEL" python3 -c '
import json
import os
import sys

expected = os.environ["EXPECTED_MODEL"]
doc = json.load(sys.stdin)
errors = []
primary = (((doc.get("agents") or {}).get("defaults") or {}).get("model") or {}).get("primary")
if primary != f"inference/{expected}":
    errors.append(f"primary={primary!r}")

provider = (((doc.get("models") or {}).get("providers") or {}).get("inference") or {})
if provider.get("baseUrl") != "https://inference.local/v1":
    errors.append("baseUrl={!r}".format(provider.get("baseUrl")))
models = provider.get("models") or []
if not models or models[0].get("id") != expected:
    errors.append("model id={!r}".format(models[0].get("id") if models else None))
if not models or models[0].get("name") != f"inference/{expected}":
    errors.append("model name={!r}".format(models[0].get("name") if models else None))

if errors:
    print("; ".join(errors))
    raise SystemExit(1)
print("OK")
' <<<"$config" 2>&1) || {
    fail "OpenClaw config: expected Ultra model via inference.local: ${probe:0:400}"
    return
  }
  pass "OpenClaw config uses inference/${TURN_MODEL}"
}

assert_hermes_config() {
  local sandbox="$1"
  local config probe
  config=$(openshell sandbox exec --name "$sandbox" -- cat /sandbox/.hermes/config.yaml 2>&1) || {
    fail "Hermes config: could not read /sandbox/.hermes/config.yaml: ${config:0:240}"
    return
  }

  probe=$(
    CONFIG_TEXT="$config" EXPECTED_MODEL="$TURN_MODEL" python3 - <<'PY'
import os
import re

text = os.environ["CONFIG_TEXT"]
expected = os.environ["EXPECTED_MODEL"]
errors = []

model = {}
in_model = False
for line in text.splitlines():
    if re.match(r"^model:\s*$", line):
        in_model = True
        continue
    if in_model and re.match(r"^[A-Za-z0-9_-]+:", line):
        break
    if in_model:
        match = re.match(r"^\s+([A-Za-z0-9_-]+):\s*(.*?)\s*$", line)
        if match:
            value = match.group(2).strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            model[match.group(1)] = value

if model.get("default") != expected:
    errors.append(f"model.default={model.get('default')!r}")
if model.get("base_url") != "https://inference.local/v1":
    errors.append(f"model.base_url={model.get('base_url')!r}")
if model.get("provider") != "custom":
    errors.append(f"model.provider={model.get('provider')!r}")

if re.search(r"(?ms)^models:\s*\n(?:[ \t].*\n)*?[ \t]+providers:", text):
    errors.append("OpenClaw-style models.providers block present")

if errors:
    print("; ".join(errors))
    raise SystemExit(1)
print("OK")
PY
  ) || {
    fail "Hermes config: expected Ultra model via inference.local: ${probe:0:400}"
    return
  }
  pass "Hermes config.yaml model block uses ${TURN_MODEL} via inference.local"
}

assert_hermes_health() {
  local sandbox="$1"
  local health_response attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    health_response=$(openshell sandbox exec --name "$sandbox" -- \
      curl -sf --max-time 10 http://localhost:8642/health 2>&1) || true
    if grep -qi '"ok"' <<<"$health_response"; then
      pass "Hermes health endpoint returns ok"
      return
    fi
    [ "$attempt" -ge 10 ] || sleep 5
  done
  fail "Hermes health endpoint did not return ok: ${health_response:0:240}"
}

assert_latency_under_cap() {
  local label="$1"
  local elapsed_ms="$2"
  local cap_ms=$((MAX_TURN_SECONDS * 1000))

  if [ "$elapsed_ms" -le "$cap_ms" ]; then
    pass "${label}: turn latency $(duration_s "$elapsed_ms") is within ${MAX_TURN_SECONDS}s cap"
  else
    fail "${label}: turn latency $(duration_s "$elapsed_ms") exceeded ${MAX_TURN_SECONDS}s cap"
  fi
}

destroy_sandbox() {
  local sandbox="$1"
  if command -v openshell >/dev/null 2>&1; then
    openshell forward stop 8642 >/dev/null 2>&1 || true
    openshell sandbox delete "$sandbox" >/dev/null 2>&1 || true
    openshell gateway destroy -g nemoclaw >/dev/null 2>&1 || true
  fi
  if command -v nemoclaw >/dev/null 2>&1; then
    nemoclaw "$sandbox" destroy --yes >/dev/null 2>&1 || true
    NEMOCLAW_AGENT=hermes nemoclaw "$sandbox" destroy --yes >/dev/null 2>&1 || true
  fi
}

run_install() {
  local label="$1"
  local sandbox="$2"
  local agent="$3"
  local log_path="$4"
  local install_pid tail_pid install_exit

  section "Install ${label}"
  info "Pre-cleaning sandbox ${sandbox} and the nemoclaw gateway..."
  destroy_sandbox "$sandbox"

  cd "$REPO" || {
    fail "${label}: could not cd to repo root: $REPO"
    return 1
  }

  export NEMOCLAW_SANDBOX_NAME="$sandbox"
  export NEMOCLAW_RECREATE_SANDBOX=1
  export NEMOCLAW_PROVIDER="$TURN_PROVIDER_KEY"
  export NEMOCLAW_MODEL="$TURN_MODEL"
  export NEMOCLAW_NON_INTERACTIVE="${NEMOCLAW_NON_INTERACTIVE:-1}"
  export NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE="${NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE:-1}"
  if [ "$agent" = "hermes" ]; then
    export NEMOCLAW_AGENT=hermes
  else
    unset NEMOCLAW_AGENT
  fi

  info "Running install.sh for ${label} with ${TURN_PROVIDER_KEY} / ${TURN_MODEL}..."
  bash install.sh --non-interactive --yes-i-accept-third-party-software >"$log_path" 2>&1 &
  install_pid=$!
  tail -f "$log_path" --pid="$install_pid" 2>/dev/null &
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

  if [ "$install_exit" -ne 0 ]; then
    fail "${label}: install.sh failed (exit ${install_exit})"
    tail -80 "$log_path" || true
    return 1
  fi
  pass "${label}: install.sh completed"

  command -v nemoclaw >/dev/null 2>&1 || {
    fail "${label}: nemoclaw not found on PATH"
    return 1
  }
  command -v openshell >/dev/null 2>&1 || {
    fail "${label}: openshell not found on PATH"
    return 1
  }
  pass "${label}: nemoclaw and openshell are on PATH"
}

run_openclaw_turn() {
  local sandbox="$1"
  local ssh_config stderr_file session_id start_ms end_ms raw rc reply stderr_text

  section "OpenClaw Turn Latency"
  assert_route "OpenClaw"
  assert_openclaw_config "$sandbox"

  ssh_config="$(mktemp)"
  stderr_file="$(mktemp)"
  if ! openshell sandbox ssh-config "$sandbox" >"$ssh_config" 2>/dev/null; then
    rm -f "$ssh_config" "$stderr_file"
    fail "OpenClaw: could not get SSH config for ${sandbox}"
    return
  fi

  session_id="e2e-openclaw-turn-latency-$(date +%s)-$$"
  rc=0
  start_ms="$(monotonic_ms)"
  raw=$(run_with_timeout "$COMMAND_TIMEOUT_SECONDS" ssh -F "$ssh_config" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 \
    -o LogLevel=ERROR \
    "openshell-${sandbox}" \
    "openclaw agent --agent main --json --thinking off --session-id '${session_id}' -m 'What is 6 multiplied by 7? Reply with only the integer, no extra words.'" \
    2>"$stderr_file") || rc=$?
  end_ms="$(monotonic_ms)"
  OPENCLAW_TURN_MS=$((end_ms - start_ms))
  stderr_text="$(<"$stderr_file")"
  rm -f "$ssh_config" "$stderr_file"

  reply=$(printf '%s' "$raw" | parse_openclaw_agent_text 2>/dev/null) || reply=""
  OPENCLAW_REPLY="$reply"

  if [ "$rc" -ne 0 ]; then
    fail "OpenClaw: real agent turn failed (exit ${rc}); stdout='${raw:0:240}'; stderr='${stderr_text:0:240}'"
    return
  fi

  if printf '%s\n%s\n' "$raw" "$stderr_text" | grep -qiE 'SsrFBlockedError|transport error|ECONNREFUSED|EAI_AGAIN|gateway unavailable|network connection error'; then
    fail "OpenClaw: real agent turn hit a provider or transport error"
    return
  fi

  if grep -qE '(^|[^0-9])42([^0-9]|$)' <<<"$reply"; then
    pass "OpenClaw: real agent turn returned 42 in $(duration_s "$OPENCLAW_TURN_MS")"
    assert_latency_under_cap "OpenClaw" "$OPENCLAW_TURN_MS"
  else
    fail "OpenClaw: expected 42 from real agent turn; reply='${reply:0:240}'; raw='${raw:0:240}'"
  fi
}

run_hermes_turn() {
  local sandbox="$1"
  local payload payload_arg remote start_ms end_ms response rc http_code body content

  section "Hermes Turn Latency"
  assert_route "Hermes"
  assert_hermes_config "$sandbox"
  assert_hermes_health "$sandbox"

  payload=$(TURN_MODEL="$TURN_MODEL" python3 -c '
import json
import os

print(json.dumps({
    "model": os.environ["TURN_MODEL"],
    "messages": [{"role": "user", "content": "What is 6 multiplied by 7? Reply with only the integer, no extra words."}],
    "max_tokens": 64,
}))
')
  payload_arg="$(printf '%q' "$payload")"
  remote="set -a; [ ! -f /sandbox/.hermes/.env ] || . /sandbox/.hermes/.env; set +a; tmp=\$(mktemp); if [ -n \"\${API_SERVER_KEY:-}\" ]; then code=\$(curl -sS -o \"\$tmp\" -w '%{http_code}' --max-time ${COMMAND_TIMEOUT_SECONDS} http://localhost:8642/v1/chat/completions -H 'Content-Type: application/json' -H \"Authorization: Bearer \${API_SERVER_KEY}\" -d $payload_arg); else code=\$(curl -sS -o \"\$tmp\" -w '%{http_code}' --max-time ${COMMAND_TIMEOUT_SECONDS} http://localhost:8642/v1/chat/completions -H 'Content-Type: application/json' -d $payload_arg); fi; rc=\$?; cat \"\$tmp\"; rm -f \"\$tmp\"; printf '\n__NEMOCLAW_HTTP_STATUS__=%s\n' \"\${code:-000}\"; exit \"\$rc\""

  rc=0
  start_ms="$(monotonic_ms)"
  response=$(run_with_timeout "$COMMAND_TIMEOUT_SECONDS" openshell sandbox exec --name "$sandbox" -- sh -lc "$remote" 2>&1) || rc=$?
  end_ms="$(monotonic_ms)"
  HERMES_TURN_MS=$((end_ms - start_ms))

  http_code=$(http_status_from_response "$response")
  [ -n "$http_code" ] || http_code="000"
  body=$(http_body_from_response "$response")
  content=$(printf '%s' "$body" | parse_chat_content 2>/dev/null) || content=""
  HERMES_REPLY="$content"

  if [ "$rc" -ne 0 ]; then
    fail "Hermes: real daemon turn failed (exit ${rc}); HTTP ${http_code}: ${body:0:300}"
    return
  fi
  if [ "$http_code" != "200" ]; then
    fail "Hermes: real daemon turn returned HTTP ${http_code}: ${body:0:300}"
    return
  fi

  if grep -qE '(^|[^0-9])42([^0-9]|$)' <<<"$content"; then
    pass "Hermes: real daemon turn returned 42 in $(duration_s "$HERMES_TURN_MS")"
    assert_latency_under_cap "Hermes" "$HERMES_TURN_MS"
  else
    fail "Hermes: expected 42 from real daemon turn; content='${content:0:240}'; body='${body:0:240}'"
  fi
}

write_results_json() {
  OPENCLAW_TURN_MS="${OPENCLAW_TURN_MS:-}" \
    HERMES_TURN_MS="${HERMES_TURN_MS:-}" \
    OPENCLAW_REPLY="${OPENCLAW_REPLY:-}" \
    HERMES_REPLY="${HERMES_REPLY:-}" \
    TURN_MODEL="$TURN_MODEL" \
    TURN_PROVIDER_KEY="$TURN_PROVIDER_KEY" \
    EXPECTED_ROUTE_PROVIDER="$EXPECTED_ROUTE_PROVIDER" \
    MAX_TURN_SECONDS="$MAX_TURN_SECONDS" \
    OPENCLAW_SANDBOX_NAME="$OPENCLAW_SANDBOX_NAME" \
    HERMES_SANDBOX_NAME="$HERMES_SANDBOX_NAME" \
    PASS="$PASS" FAIL="$FAIL" SKIP="$SKIP" TOTAL="$TOTAL" \
    python3 - <<'PY' >"$RESULTS_JSON"
import json
import os

def maybe_int(name):
    value = os.environ.get(name, "")
    return int(value) if value.isdigit() else None

doc = {
    "model": os.environ["TURN_MODEL"],
    "provider_key": os.environ["TURN_PROVIDER_KEY"],
    "route_provider": os.environ["EXPECTED_ROUTE_PROVIDER"],
    "max_turn_seconds": int(os.environ["MAX_TURN_SECONDS"]),
    "sandboxes": {
        "openclaw": os.environ["OPENCLAW_SANDBOX_NAME"],
        "hermes": os.environ["HERMES_SANDBOX_NAME"],
    },
    "turns": {
        "openclaw": {
            "elapsed_ms": maybe_int("OPENCLAW_TURN_MS"),
            "reply_excerpt": os.environ.get("OPENCLAW_REPLY", "")[:200],
        },
        "hermes": {
            "elapsed_ms": maybe_int("HERMES_TURN_MS"),
            "reply_excerpt": os.environ.get("HERMES_REPLY", "")[:200],
        },
    },
    "summary": {
        "pass": int(os.environ["PASS"]),
        "fail": int(os.environ["FAIL"]),
        "skip": int(os.environ["SKIP"]),
        "total": int(os.environ["TOTAL"]),
    },
}
print(json.dumps(doc, indent=2, sort_keys=True))
PY
}

finish() {
  section "Summary"
  write_results_json
  [ -n "${OPENCLAW_TURN_MS:-}" ] && info "OpenClaw turn: $(duration_s "$OPENCLAW_TURN_MS")"
  [ -n "${HERMES_TURN_MS:-}" ] && info "Hermes turn: $(duration_s "$HERMES_TURN_MS")"
  info "Results JSON: ${RESULTS_JSON}"
  echo ""
  echo "========================================"
  echo "Real Agent Turn Latency E2E Summary"
  echo "========================================"
  echo "Total:  $TOTAL"
  echo "Passed: $PASS"
  echo "Failed: $FAIL"
  echo "Skipped: $SKIP"
  echo "========================================"

  if [ "$FAIL" -gt 0 ]; then
    exit 1
  fi
  exit 0
}

if [ -d /workspace ] && [ -f /workspace/install.sh ]; then
  REPO="/workspace"
elif [ -f "$(cd "${SCRIPT_DIR}/../.." && pwd)/install.sh" ]; then
  REPO="$(cd "${SCRIPT_DIR}/../.." && pwd)"
else
  echo "ERROR: Cannot find repo root."
  exit 1
fi

TURN_MODEL="${NEMOCLAW_TURN_LATENCY_MODEL:-${NEMOCLAW_MODEL:-nvidia/nemotron-3-ultra-550b-a55b}}"
TURN_PROVIDER_KEY="${NEMOCLAW_TURN_LATENCY_PROVIDER:-build}"
EXPECTED_ROUTE_PROVIDER="${NEMOCLAW_TURN_LATENCY_ROUTE_PROVIDER:-nvidia-prod}"
OPENCLAW_SANDBOX_NAME="${NEMOCLAW_OPENCLAW_TURN_LATENCY_SANDBOX_NAME:-e2e-openclaw-turn-latency}"
HERMES_SANDBOX_NAME="${NEMOCLAW_HERMES_TURN_LATENCY_SANDBOX_NAME:-e2e-hermes-turn-latency}"
OPENCLAW_INSTALL_LOG="/tmp/nemoclaw-e2e-openclaw-turn-latency-install.log"
HERMES_INSTALL_LOG="/tmp/nemoclaw-e2e-hermes-turn-latency-install.log"
RESULTS_JSON="/tmp/nemoclaw-e2e-agent-turn-latency.json"

MAX_TURN_SECONDS="${NEMOCLAW_TURN_LATENCY_MAX_SECONDS:-300}"
is_positive_int "$MAX_TURN_SECONDS" || MAX_TURN_SECONDS=300
COMMAND_TIMEOUT_SECONDS="${NEMOCLAW_TURN_LATENCY_COMMAND_TIMEOUT_SECONDS:-$((MAX_TURN_SECONDS + 30))}"
is_positive_int "$COMMAND_TIMEOUT_SECONDS" || COMMAND_TIMEOUT_SECONDS=$((MAX_TURN_SECONDS + 30))

OPENCLAW_TURN_MS=""
HERMES_TURN_MS=""
OPENCLAW_REPLY=""
HERMES_REPLY=""

register_sandbox_for_teardown "$OPENCLAW_SANDBOX_NAME"
register_sandbox_for_teardown "$HERMES_SANDBOX_NAME"
nemoclaw_ensure_local_bin_on_path

section "Prerequisites"
if docker info >/dev/null 2>&1; then
  pass "Docker is running"
else
  fail "Docker is not running"
  finish
fi

if [ -n "${NVIDIA_API_KEY:-}" ] && [[ "${NVIDIA_API_KEY}" == nvapi-* ]]; then
  pass "NVIDIA_API_KEY is set"
else
  fail "NVIDIA_API_KEY not set or invalid"
  finish
fi

if [ "${NEMOCLAW_NON_INTERACTIVE:-}" = "1" ] && [ "${NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE:-}" = "1" ]; then
  pass "Non-interactive install flags are set"
else
  fail "NEMOCLAW_NON_INTERACTIVE=1 and NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 are required"
  finish
fi

command -v python3 >/dev/null 2>&1 || {
  fail "python3 not found on PATH"
  finish
}
pass "python3 is available"

info "Repo: ${REPO}"
info "Model: ${TURN_MODEL}"
info "Turn cap: ${MAX_TURN_SECONDS}s"

run_install "OpenClaw" "$OPENCLAW_SANDBOX_NAME" "openclaw" "$OPENCLAW_INSTALL_LOG" || finish
run_openclaw_turn "$OPENCLAW_SANDBOX_NAME"

if [ "${NEMOCLAW_E2E_KEEP_SANDBOX:-}" != "1" ]; then
  section "Cleanup OpenClaw Sandbox"
  destroy_sandbox "$OPENCLAW_SANDBOX_NAME"
  pass "OpenClaw sandbox pre-Hermes cleanup completed"
fi

run_install "Hermes" "$HERMES_SANDBOX_NAME" "hermes" "$HERMES_INSTALL_LOG" || finish
run_hermes_turn "$HERMES_SANDBOX_NAME"

if [ "${NEMOCLAW_E2E_KEEP_SANDBOX:-}" != "1" ]; then
  section "Cleanup Hermes Sandbox"
  destroy_sandbox "$HERMES_SANDBOX_NAME"
  pass "Hermes sandbox cleanup completed"
fi

finish
