#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Hermes inference switch E2E.
#
# Installs NemoClaw with Hermes, switches the running sandbox with
# `nemohermes inference set`, verifies OpenShell and Hermes config state, and
# sends live requests after the switch without restarting Hermes.
#
# Prerequisites:
#   - Docker running
#   - NVIDIA_API_KEY set (real key, starts with nvapi-)
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

hermes_gateway_pid() {
  # shellcheck disable=SC2016  # awk runs inside the sandbox.
  openshell sandbox exec --name "$SANDBOX_NAME" -- sh -lc \
    'ps -eo pid=,comm=,args= 2>/dev/null | awk '"'"'$2 != "sh" && $2 != "bash" && $2 != "awk" && $0 ~ /hermes/ && $0 ~ /gateway run/ { print $1; exit }'"'"'' \
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
    if sandbox.get("agent") != "hermes":
        errors.append(f"registry agent={sandbox.get('agent')!r}")
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
        if session.get("agent") != "hermes":
            errors.append(f"session agent={session.get('agent')!r}")
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
  pass "Registry and onboard session record the switched Hermes provider/model"
}

assert_hermes_health() {
  local health_response attempt
  for attempt in 1 2 3 4 5; do
    health_response=$(openshell sandbox exec --name "$SANDBOX_NAME" -- \
      curl -sf --max-time 10 http://localhost:8642/health 2>&1) || true
    if grep -qi '"ok"' <<<"$health_response"; then
      pass "Hermes health endpoint returns ok"
      return
    fi
    [ "$attempt" -ge 5 ] || sleep 4
  done
  fail "Hermes health endpoint did not return ok: ${health_response:0:240}"
}

assert_hermes_config() {
  local config probe
  config=$(openshell sandbox exec --name "$SANDBOX_NAME" -- cat /sandbox/.hermes/config.yaml 2>&1) || {
    fail "Could not read /sandbox/.hermes/config.yaml: ${config:0:240}"
    return
  }

  # Keep this parser dependency-free for the E2E runner: it only reads the
  # simple model block and should move to PyYAML if nested or multiline values
  # become relevant.
  probe=$(
    CONFIG_TEXT="$config" EXPECTED_MODEL="$SWITCH_MODEL" python3 - <<'PY'
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
    fail "Hermes config.yaml was not patched correctly: ${probe:0:400}"
    return
  }
  pass "Hermes config.yaml model block uses ${SWITCH_MODEL} via inference.local"
}

assert_hermes_hashes() {
  local strict_check compat_check perms_probe
  strict_check=$(openshell sandbox exec --name "$SANDBOX_NAME" -- sh -lc \
    'sha256sum -c /etc/nemoclaw/hermes.config-hash --status && echo OK' 2>&1 || true)
  if grep -qx "OK" <<<"$strict_check"; then
    pass "Hermes strict config hash matches config.yaml and .env"
  else
    fail "Hermes strict config hash check failed: ${strict_check:0:240}"
  fi

  compat_check=$(openshell sandbox exec --name "$SANDBOX_NAME" -- sh -lc \
    'sha256sum -c /sandbox/.hermes/.config-hash --status && echo OK' 2>&1 || true)
  if grep -qx "OK" <<<"$compat_check"; then
    pass "Hermes compatibility config hash matches config.yaml and .env"
  else
    fail "Hermes compatibility config hash check failed: ${compat_check:0:240}"
  fi

  perms_probe=$(openshell sandbox exec --name "$SANDBOX_NAME" -- sh -lc \
    "stat -c '%u %a' /etc/nemoclaw/hermes.config-hash" 2>&1 || true)
  if PERMS_PROBE="$perms_probe" python3 - <<'PY'; then
import os
import sys

parts = os.environ.get("PERMS_PROBE", "").split()
if len(parts) != 2:
    raise SystemExit(1)
uid = int(parts[0])
mode = int(parts[1], 8)
if uid != 0 or mode & 0o222:
    raise SystemExit(1)
PY
    pass "Hermes strict hash is root-owned and not writable"
  else
    fail "Hermes strict hash permissions are wrong: ${perms_probe:0:120}"
  fi
}

assert_env_hash_unchanged() {
  local after
  after=$(openshell sandbox exec --name "$SANDBOX_NAME" -- sha256sum /sandbox/.hermes/.env 2>/dev/null | awk '{print $1}') || true
  if [ -n "$ENV_HASH_BEFORE" ] && [ "$after" = "$ENV_HASH_BEFORE" ]; then
    pass "Hermes .env was not rewritten by inference set"
  else
    fail "Hermes .env hash changed during inference set (${ENV_HASH_BEFORE:-missing} -> ${after:-missing})"
  fi
}

check_inference_local() {
  local payload payload_arg response rc content attempt last_fail
  payload=$(SWITCH_MODEL="$SWITCH_MODEL" python3 -c '
import json
import os
print(json.dumps({
    "model": os.environ["SWITCH_MODEL"],
    "messages": [{"role": "user", "content": "Reply with exactly one word: PONG"}],
    "max_tokens": 100,
}))
')
  payload_arg="$(printf '%q' "$payload")"
  last_fail=""

  for attempt in 1 2 3; do
    rc=0
    response=$(openshell sandbox exec --name "$SANDBOX_NAME" -- sh -lc \
      "curl -sS --max-time 90 https://inference.local/v1/chat/completions -H 'Content-Type: application/json' -d $payload_arg" \
      2>&1) || rc=$?

    if [ "$rc" -ne 0 ]; then
      last_fail="curl failed with exit ${rc}: ${response:0:300}"
    else
      content=$(printf '%s' "$response" | parse_chat_content 2>/dev/null) || content=""
      if grep -qi "PONG" <<<"$content"; then
        pass "Hermes sandbox inference.local returned PONG with ${SWITCH_MODEL}"
        return
      fi
      last_fail="expected PONG, got ${content:0:300}"
    fi

    [ "$attempt" -ge 3 ] || {
      info "Hermes inference.local attempt ${attempt}/3 failed: ${last_fail}"
      sleep 5
    }
  done

  fail "Hermes sandbox inference.local did not work after switch: ${last_fail}"
}

check_hermes_api_chat() {
  local payload payload_arg response rc content remote attempt last_fail
  payload=$(SWITCH_MODEL="$SWITCH_MODEL" python3 -c '
import json
import os
print(json.dumps({
    "model": os.environ["SWITCH_MODEL"],
    "messages": [{"role": "user", "content": "Reply with exactly one word: PONG"}],
    "max_tokens": 100,
}))
')
  payload_arg="$(printf '%q' "$payload")"
  remote="set -a; [ ! -f /sandbox/.hermes/.env ] || . /sandbox/.hermes/.env; set +a; if [ -n \"\${API_SERVER_KEY:-}\" ]; then curl -sS --max-time 120 http://localhost:8642/v1/chat/completions -H 'Content-Type: application/json' -H \"Authorization: Bearer \${API_SERVER_KEY}\" -d $payload_arg; else curl -sS --max-time 120 http://localhost:8642/v1/chat/completions -H 'Content-Type: application/json' -d $payload_arg; fi"
  last_fail=""

  for attempt in 1 2 3; do
    rc=0
    response=$(openshell sandbox exec --name "$SANDBOX_NAME" -- sh -lc "$remote" 2>&1) || rc=$?
    if [ "$rc" -ne 0 ]; then
      last_fail="Hermes API curl failed with exit ${rc}: ${response:0:300}"
    else
      content=$(printf '%s' "$response" | parse_chat_content 2>/dev/null) || content=""
      if grep -qi "PONG" <<<"$content"; then
        pass "Hermes API chat works after inference switch"
        return
      fi
      last_fail="expected PONG from Hermes API, got ${content:0:300}; response=${response:0:300}"
    fi

    [ "$attempt" -ge 3 ] || {
      info "Hermes API chat attempt ${attempt}/3 failed: ${last_fail}"
      sleep 5
    }
  done

  fail "Hermes API chat did not work after switch: ${last_fail}"
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
SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-hermes-inference-switch}"
SWITCH_PROVIDER="${NEMOCLAW_SWITCH_PROVIDER:-nvidia-prod}"
SWITCH_MODEL="${NEMOCLAW_SWITCH_MODEL:-z-ai/glm-5.1}"
INSTALL_LOG="/tmp/nemoclaw-e2e-hermes-inference-switch-install.log"
ENV_HASH_BEFORE=""

export NEMOCLAW_AGENT="${NEMOCLAW_AGENT:-hermes}"

# shellcheck source=test/e2e/lib/sandbox-teardown.sh
. "${E2E_DIR}/lib/sandbox-teardown.sh"
# shellcheck source=test/e2e/lib/install-path-refresh.sh
. "${E2E_DIR}/lib/install-path-refresh.sh"
register_sandbox_for_teardown "$SANDBOX_NAME"

section "Phase 0: Pre-cleanup"
if command -v nemohermes >/dev/null 2>&1; then
  nemohermes "$SANDBOX_NAME" destroy --yes 2>/dev/null || true
elif command -v nemoclaw >/dev/null 2>&1; then
  NEMOCLAW_AGENT=hermes nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true
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

if [ -n "${NVIDIA_API_KEY:-}" ] && [[ "${NVIDIA_API_KEY}" == nvapi-* ]]; then
  pass "NVIDIA_API_KEY is set"
else
  fail "NVIDIA_API_KEY not set or invalid"
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

section "Phase 2: Install and onboard Hermes"
cd "$REPO" || {
  fail "Could not cd to repo root: $REPO"
  exit 1
}

export NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME"
export NEMOCLAW_RECREATE_SANDBOX="${NEMOCLAW_RECREATE_SANDBOX:-1}"

info "Running install.sh --non-interactive for Hermes sandbox ${SANDBOX_NAME}..."
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

command -v nemohermes >/dev/null 2>&1 || {
  fail "nemohermes not found on PATH"
  exit 1
}
command -v openshell >/dev/null 2>&1 || {
  fail "openshell not found on PATH"
  exit 1
}
pass "nemohermes and openshell are on PATH"
assert_hermes_health

section "Phase 3: Switch inference"
pid_before="$(hermes_gateway_pid)"
ENV_HASH_BEFORE=$(openshell sandbox exec --name "$SANDBOX_NAME" -- sha256sum /sandbox/.hermes/.env 2>/dev/null | awk '{print $1}') || true

info "Switching Hermes to ${SWITCH_PROVIDER} / ${SWITCH_MODEL} with nemohermes inference set..."
switch_output=$(nemohermes inference set --provider "$SWITCH_PROVIDER" --model "$SWITCH_MODEL" 2>&1)
switch_rc=$?
if [ "$switch_rc" -eq 0 ]; then
  pass "nemohermes inference set completed without --sandbox"
else
  fail "nemohermes inference set failed (exit ${switch_rc}): ${switch_output:0:500}"
  exit 1
fi

pid_after="$(hermes_gateway_pid)"
if [ -n "$pid_before" ] && [ -n "$pid_after" ]; then
  if [ "$pid_before" = "$pid_after" ]; then
    pass "Hermes gateway process stayed running during switch"
  else
    fail "Hermes gateway process changed during switch (${pid_before} -> ${pid_after})"
  fi
else
  skip "Could not capture Hermes gateway PID before and after switch"
fi

assert_hermes_health
assert_route
assert_hermes_config
assert_env_hash_unchanged
assert_hermes_hashes
assert_registry_session

section "Phase 4: Live requests after switch"
check_inference_local
check_hermes_api_chat

section "Phase 5: Cleanup"
if [ "${NEMOCLAW_E2E_KEEP_SANDBOX:-}" != "1" ]; then
  nemohermes "$SANDBOX_NAME" destroy --yes 2>&1 | tail -3 || true
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
echo "  Hermes inference switch E2E Results:"
echo "    Passed:  $PASS"
echo "    Failed:  $FAIL"
echo "    Skipped: $SKIP"
echo "    Total:   $TOTAL"
echo "========================================"

if [ "$FAIL" -eq 0 ]; then
  printf '\n\033[1;32m  Hermes inference switch E2E PASSED.\033[0m\n'
  exit 0
fi

printf '\n\033[1;31m  %d test(s) failed.\033[0m\n' "$FAIL"
exit 1
