#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Hermes Slack E2E: onboard --agent hermes with Slack enabled, then verify
# the Hermes sandbox keeps the Hermes-specific Slack policy and can reach the
# Slack API through the Python/OpenShell placeholder path.
#
# Uses fake Slack tokens by default. Fake tokens should appear only where the
# sandbox runtime needs them for OpenShell env resolution, not in Hermes config
# files, logs, or process arguments.
#
# Environment variables:
#   NEMOCLAW_NON_INTERACTIVE=1              - required
#   NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 - required
#   NEMOCLAW_AGENT=hermes                  - auto-set if not already set
#   NEMOCLAW_POLICY_TIER=open              - auto-set if not already set
#   NEMOCLAW_SANDBOX_NAME                  - sandbox name (default: e2e-hermes-slack)
#   NEMOCLAW_RECREATE_SANDBOX=1            - auto-set
#   NVIDIA_API_KEY                         - required for Hermes onboarding
#   SLACK_BOT_TOKEN                        - defaults to a fake xoxb- token
#   SLACK_APP_TOKEN                        - defaults to a fake xapp- token
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
#     NVIDIA_API_KEY=nvapi-... bash test/e2e/test-hermes-slack-e2e.sh

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

dump_hermes_slack_diagnostics() {
  info "--- Hermes Slack sandbox diagnostics ---"
  if ! command -v openshell >/dev/null 2>&1; then
    info "openshell is not available for sandbox diagnostics"
    return
  fi

  local sandboxes diag_output diag_script
  sandboxes=$(openshell sandbox list 2>&1 || true)
  info "openshell sandbox list:"
  echo "$sandboxes" | tail -20 | while IFS= read -r line; do
    info "  $line"
  done

  if ! grep -Fq -- "$SANDBOX_NAME" <<<"$sandboxes"; then
    info "sandbox '${SANDBOX_NAME}' is not visible to openshell"
    return
  fi

  diag_script='set +e'
  diag_script+='; echo "== hermes config =="; sed -n "1,120p" /sandbox/.hermes/config.yaml 2>&1 || true'
  diag_script+='; echo "== hermes env keys =="; cut -d= -f1 /sandbox/.hermes/.env 2>&1 || true'
  diag_script+='; echo "== hermes health =="; curl -sf http://localhost:8642/health 2>&1 || true'
  diag_script+='; echo "== hermes-related processes =="'
  # shellcheck disable=SC2016
  diag_script+='; for p in /proc/[0-9]*; do cmd=$(tr "\000" " " < "$p/cmdline" 2>/dev/null || true); case "$cmd" in *hermes*|*socat*|*nemoclaw-decode-proxy*) echo "$(basename "$p") $cmd" ;; esac; done'
  diag_script+='; echo "== /tmp/nemoclaw-start.log tail =="; tail -n 80 /tmp/nemoclaw-start.log 2>&1 || true'
  diag_script+='; echo "== /tmp/gateway.log tail =="; tail -n 120 /tmp/gateway.log 2>&1 || true'
  diag_output=$(openshell sandbox exec -n "$SANDBOX_NAME" -- sh -lc "$diag_script" 2>&1 || true)

  echo "$diag_output" | while IFS= read -r line; do
    info "  $line"
  done
  info "--- End Hermes Slack diagnostics ---"
}

sandbox_exec() {
  local cmd="$1"
  local ssh_config
  ssh_config="$(mktemp)"
  openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_config" 2>/dev/null

  local result
  result=$(run_with_timeout 60 ssh -F "$ssh_config" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 \
    -o LogLevel=ERROR \
    "openshell-${SANDBOX_NAME}" \
    "$cmd" \
    2>&1) || true

  rm -f "$ssh_config"
  echo "$result"
}

sandbox_exec_stdin() {
  local cmd="$1"
  local ssh_config
  ssh_config="$(mktemp)"
  openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_config" 2>/dev/null

  local result
  result=$(run_with_timeout 60 ssh -F "$ssh_config" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 \
    -o LogLevel=ERROR \
    "openshell-${SANDBOX_NAME}" \
    "$cmd" \
    2>/dev/null) || true

  rm -f "$ssh_config"
  echo "$result"
}

if [ -d /workspace ] && [ -f /workspace/install.sh ]; then
  REPO="/workspace"
elif [ -f "$(cd "$(dirname "$0")/../.." && pwd)/install.sh" ]; then
  REPO="$(cd "$(dirname "$0")/../.." && pwd)"
else
  echo "ERROR: Cannot find repo root."
  exit 1
fi

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-hermes-slack}"
SLACK_BOT="${SLACK_BOT_TOKEN:-xoxb-test-hermes-slack-token}"
SLACK_APP="${SLACK_APP_TOKEN:-xapp-test-hermes-slack-app-token}"
export NEMOCLAW_AGENT="${NEMOCLAW_AGENT:-hermes}"
export NEMOCLAW_POLICY_TIER="${NEMOCLAW_POLICY_TIER:-open}"
export NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME"
export NEMOCLAW_RECREATE_SANDBOX=1
export SLACK_BOT_TOKEN="$SLACK_BOT"
export SLACK_APP_TOKEN="$SLACK_APP"

# shellcheck source=test/e2e/lib/sandbox-teardown.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/sandbox-teardown.sh"
register_sandbox_for_teardown "$SANDBOX_NAME"

section "Phase 0: Prerequisites"

if docker info >/dev/null 2>&1; then
  pass "Docker is running"
else
  fail "Docker is not running"
  exit 1
fi

if [ -n "${NVIDIA_API_KEY:-}" ] && [[ "${NVIDIA_API_KEY}" == nvapi-* ]]; then
  pass "NVIDIA_API_KEY is set (starts with nvapi-)"
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
  pass "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1"
else
  fail "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 is required"
  exit 1
fi

info "Sandbox name: $SANDBOX_NAME"
info "Agent: $NEMOCLAW_AGENT"
info "Policy tier: $NEMOCLAW_POLICY_TIER"

section "Phase 1: Install NemoClaw with Hermes Slack"

cd "$REPO" || {
  fail "Could not cd to repo root: $REPO"
  exit 1
}

info "Pre-cleanup..."
if command -v nemoclaw >/dev/null 2>&1; then
  nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true
fi
if command -v openshell >/dev/null 2>&1; then
  openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true
  openshell provider delete "${SANDBOX_NAME}-slack-bridge" 2>/dev/null || true
  openshell provider delete "${SANDBOX_NAME}-slack-app" 2>/dev/null || true
  openshell gateway destroy -g nemoclaw 2>/dev/null || true
fi
pass "Pre-cleanup complete"

INSTALL_LOG="/tmp/nemoclaw-e2e-hermes-slack-install.log"
info "Running install.sh --non-interactive with NEMOCLAW_AGENT=hermes and Slack enabled..."
bash install.sh --non-interactive >"$INSTALL_LOG" 2>&1 &
install_pid=$!
tail -f "$INSTALL_LOG" --pid=$install_pid 2>/dev/null &
tail_pid=$!
wait $install_pid
install_exit=$?
kill $tail_pid 2>/dev/null || true
wait $tail_pid 2>/dev/null || true

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

if [ $install_exit -eq 0 ]; then
  pass "install.sh completed (exit 0)"
else
  fail "install.sh failed (exit $install_exit)"
  info "Last 40 lines of install log:"
  tail -40 "$INSTALL_LOG" 2>/dev/null || true
  dump_hermes_slack_diagnostics
  exit 1
fi

if command -v nemoclaw >/dev/null 2>&1; then
  pass "nemoclaw installed at $(command -v nemoclaw)"
else
  fail "nemoclaw not found on PATH after install"
  exit 1
fi

if command -v openshell >/dev/null 2>&1; then
  pass "openshell installed ($(openshell --version 2>&1 || echo unknown))"
else
  fail "openshell not found on PATH after install"
  exit 1
fi

section "Phase 2: Hermes sandbox and Slack providers"

if list_output=$(nemoclaw list 2>&1); then
  if grep -Fq -- "$SANDBOX_NAME" <<<"$list_output"; then
    pass "nemoclaw list contains '${SANDBOX_NAME}'"
  else
    fail "nemoclaw list does not contain '${SANDBOX_NAME}'"
  fi
else
  fail "nemoclaw list failed: ${list_output:0:200}"
fi

if openshell provider get "${SANDBOX_NAME}-slack-bridge" >/dev/null 2>&1; then
  pass "Slack bot provider '${SANDBOX_NAME}-slack-bridge' exists in gateway"
else
  fail "Slack bot provider '${SANDBOX_NAME}-slack-bridge' not found in gateway"
fi

if openshell provider get "${SANDBOX_NAME}-slack-app" >/dev/null 2>&1; then
  pass "Slack app provider '${SANDBOX_NAME}-slack-app' exists in gateway"
else
  fail "Slack app provider '${SANDBOX_NAME}-slack-app' not found in gateway"
fi

section "Phase 3: Hermes health"

hermes_healthy=false
health_response=""
for attempt in $(seq 1 15); do
  health_response=$(sandbox_exec "curl -sf http://localhost:8642/health")
  if echo "$health_response" | grep -qi '"ok"'; then
    hermes_healthy=true
    break
  fi
  info "Health check attempt ${attempt}/15 - waiting 4s..."
  sleep 4
done

if $hermes_healthy; then
  pass "Hermes health probe returned ok with Slack enabled"
else
  fail "Hermes health probe did not return ok after 15 attempts"
  info "Last response: ${health_response:0:200}"
  dump_hermes_slack_diagnostics
fi

section "Phase 4: Hermes Slack config shape"

config_probe=$(
  sandbox_exec_stdin "python3 -" <<'PY'
import sys
from pathlib import Path
try:
    import yaml
except Exception as exc:
    print(f"FAIL cannot import yaml: {exc}")
    sys.exit(0)

config_text = Path("/sandbox/.hermes/config.yaml").read_text(encoding="utf-8")
cfg = yaml.safe_load(config_text) or {}
errors = []
platforms = cfg.get("platforms")
if isinstance(platforms, dict) and "slack" in platforms:
    errors.append("platforms.slack present")
if "SLACK_BOT_TOKEN" in config_text or "SLACK_APP_TOKEN" in config_text:
    errors.append("config.yaml contains Slack token env keys")
if errors:
    print("FAIL " + "; ".join(errors))
else:
    print("OK")
PY
)

if [ "$config_probe" = "OK" ]; then
  pass "config.yaml has no generic platforms.slack block or Slack token keys"
else
  fail "config.yaml check failed: ${config_probe:0:400}"
fi

env_probe=$(
  sandbox_exec_stdin "python3 -" <<'PY'
from pathlib import Path
text = Path("/sandbox/.hermes/.env").read_text(encoding="utf-8")
lines = set(text.splitlines())
required = {
    "SLACK_BOT_TOKEN=openshell:resolve:env:SLACK_BOT_TOKEN",
    "SLACK_APP_TOKEN=openshell:resolve:env:SLACK_APP_TOKEN",
    "API_SERVER_PORT=18642",
}
missing = sorted(required - lines)
if missing:
    print("FAIL missing " + ", ".join(missing))
else:
    print("OK")
PY
)

if [ "$env_probe" = "OK" ]; then
  pass ".hermes/.env contains Slack resolver placeholders"
else
  fail ".hermes/.env check failed: ${env_probe:0:400}"
fi

token_file_hits=$(printf '%s\n%s\n' "$SLACK_BOT" "$SLACK_APP" | sandbox_exec_stdin 'grep -Fq -f - /sandbox/.hermes/config.yaml /sandbox/.hermes/.env /tmp/nemoclaw-start.log /tmp/gateway.log 2>/dev/null && echo LEAK || echo OK')
if [ "$token_file_hits" = "OK" ]; then
  pass "Raw Slack tokens absent from Hermes config files and logs"
else
  fail "Raw Slack token found in Hermes config files or logs"
fi

sandbox_ps=$(sandbox_exec 'cat /proc/[0-9]*/cmdline 2>/dev/null | tr "\0" "\n"')
if [ -z "$sandbox_ps" ]; then
  skip "Sandbox process list is empty"
elif echo "$sandbox_ps" | grep -qF "$SLACK_BOT" || echo "$sandbox_ps" | grep -qF "$SLACK_APP"; then
  fail "Raw Slack token found in sandbox process list"
else
  pass "Raw Slack tokens absent from sandbox process list"
fi

section "Phase 5: Hermes Slack policy"

if policy_output=$(openshell policy get --full "$SANDBOX_NAME" 2>&1); then
  slack_block=$(awk '
    /^  slack:/ { in_slack = 1; print; next }
    in_slack && /^  [A-Za-z0-9_-]+:/ { exit }
    in_slack { print }
  ' <<<"$policy_output")

  if [ -n "$slack_block" ]; then
    pass "Sandbox policy contains Slack network policy"
  else
    fail "Sandbox policy missing Slack network policy"
  fi

  if echo "$slack_block" | grep -Fq "/usr/local/bin/hermes" \
    && echo "$slack_block" | grep -Fq "/usr/bin/python3.11" \
    && echo "$slack_block" | grep -Fq "/opt/hermes/.venv/bin/python"; then
    pass "Slack policy is scoped to Hermes and Python binaries"
  else
    fail "Slack policy missing Hermes/Python binary allowlist"
  fi

  if echo "$slack_block" | grep -Fq "/usr/local/bin/node" \
    || echo "$slack_block" | grep -Fq "/usr/bin/node"; then
    fail "Slack policy was replaced by or widened to Node"
  else
    pass "Slack policy does not allow Node"
  fi

  if echo "$slack_block" | grep -Fq "wss-primary.slack.com" \
    && echo "$slack_block" | grep -Fq "wss-backup.slack.com"; then
    pass "Slack policy includes Socket Mode websocket hosts"
  else
    fail "Slack policy missing Socket Mode websocket hosts"
  fi
else
  fail "openshell policy get failed: ${policy_output:0:200}"
fi

section "Phase 6: Slack placeholder egress from Python"

slack_probe=$(
  sandbox_exec_stdin "/usr/bin/python3.11 -" <<'PY'
import json
import socket
import sys
import urllib.error
import urllib.request

def call(label, path, env_key, allowed_errors):
    token = f"openshell:resolve:env:{env_key}"
    req = urllib.request.Request(
        f"https://slack.com/api/{path}",
        data=b"",
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            status = resp.status
            body = resp.read().decode("utf-8", errors="replace")
    except socket.timeout:
        print(f"TIMEOUT {label}")
        return False
    except urllib.error.URLError as exc:
        reason = str(getattr(exc, "reason", exc))
        if "timed out" in reason.lower():
            print(f"TIMEOUT {label}: {reason}")
            return False
        print(f"ERROR {label}: {reason}")
        return False

    print(json.dumps({"label": label, "status": status, "body": body[:300]}))
    try:
        parsed = json.loads(body)
    except Exception as exc:
        print(f"FAIL {label}: non-json body {exc}")
        return False
    error = parsed.get("error")
    if status == 200 and (parsed.get("ok") is True or error in allowed_errors):
        print(f"OK {label}: {error or 'ok'}")
        return True
    print(f"FAIL {label}: status={status} error={error!r}")
    return False

ok = True
ok = call("auth.test", "auth.test", "SLACK_BOT_TOKEN", {"invalid_auth", "not_authed"}) and ok
ok = call(
    "apps.connections.open",
    "apps.connections.open",
    "SLACK_APP_TOKEN",
    {"invalid_auth", "not_authed", "not_allowed_token_type"},
) and ok
sys.exit(0 if ok else 2)
PY
)

info "Slack Python probe response: ${slack_probe:0:500}"
if echo "$slack_probe" | grep -q "^OK auth.test:" \
  && echo "$slack_probe" | grep -q "^OK apps.connections.open:"; then
  pass "Slack API reached from Python through OpenShell placeholder substitution"
elif echo "$slack_probe" | grep -q "^TIMEOUT"; then
  skip "Slack API timed out"
elif echo "$slack_probe" | grep -qE "^(FAIL|ERROR)"; then
  fail "Slack Python API probe failed: ${slack_probe:0:400}"
  dump_hermes_slack_diagnostics
else
  fail "Unexpected Slack Python API response: ${slack_probe:0:400}"
fi

section "Phase 7: Cleanup"

if [[ "${NEMOCLAW_E2E_KEEP_SANDBOX:-}" != "1" ]]; then
  nemoclaw "$SANDBOX_NAME" destroy --yes 2>&1 | tail -3 || true
  openshell gateway destroy -g nemoclaw 2>/dev/null || true
fi

registry_file="${HOME}/.nemoclaw/sandboxes.json"
if [ -f "$registry_file" ] && grep -Fq "\"${SANDBOX_NAME}\"" "$registry_file"; then
  fail "Sandbox ${SANDBOX_NAME} still in registry after destroy"
else
  pass "Sandbox ${SANDBOX_NAME} removed"
fi

if openshell provider get "${SANDBOX_NAME}-slack-app" >/dev/null 2>&1; then
  fail "Slack app provider still exists after destroy"
  openshell provider delete "${SANDBOX_NAME}-slack-app" 2>/dev/null || true
else
  pass "Slack app provider removed"
fi

echo ""
echo "========================================"
echo "  Hermes Slack E2E Results:"
echo "    Passed:  $PASS"
echo "    Failed:  $FAIL"
echo "    Skipped: $SKIP"
echo "    Total:   $TOTAL"
echo "========================================"

if [ "$FAIL" -eq 0 ]; then
  printf '\n\033[1;32m  Hermes Slack E2E PASSED - policy, placeholder, provider, and sandbox boot verified.\033[0m\n'
  exit 0
else
  printf '\n\033[1;31m  %d test(s) failed.\033[0m\n' "$FAIL"
  exit 1
fi
