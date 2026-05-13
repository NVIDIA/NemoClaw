#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Hermes Discord E2E: onboard --agent hermes with Discord enabled, then verify
# the Hermes sandbox has the schema, placeholder/token isolation, and native
# OpenShell WebSocket Gateway rewrite path required by NVIDIA/NemoClaw#3032.
#
# Uses a fake Discord token by default. The fake token should never appear in
# /sandbox/.hermes/config.yaml, /sandbox/.hermes/.env, sandbox env, sandbox
# process args, or sandbox filesystem. The sandbox should hold only the
# OpenShell resolver placeholder. Gateway proof uses a hermetic fake Discord
# Gateway on the host, not a local in-sandbox facade or live Discord token.
#
# Environment variables:
#   NEMOCLAW_NON_INTERACTIVE=1             - required
#   NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 - required
#   NEMOCLAW_AGENT=hermes                  - auto-set if not already set
#   NEMOCLAW_POLICY_TIER=open              - auto-set if not already set
#   NEMOCLAW_SANDBOX_NAME                  - sandbox name (default: e2e-hermes-discord)
#   NEMOCLAW_RECREATE_SANDBOX=1            - auto-set
#   NEMOCLAW_FRESH=1                       - auto-set to discard interrupted onboard sessions
#   NEMOCLAW_OPENSHELL_BIN                 - optional OpenShell binary under test
#   NVIDIA_API_KEY                         - required for Hermes onboarding
#   DISCORD_BOT_TOKEN                      - defaults to a fake token
#   DISCORD_SERVER_IDS                     - defaults to a fake snowflake
#   DISCORD_ALLOWED_IDS                    - defaults to a fake snowflake
#   DISCORD_REQUIRE_MENTION                - defaults to 0 to verify config propagation
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
#     NVIDIA_API_KEY=nvapi-... bash test/e2e/test-hermes-discord-e2e.sh

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

dump_hermes_discord_diagnostics() {
  info "--- Hermes Discord sandbox diagnostics ---"
  if ! openshell --version >/dev/null 2>&1; then
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
  diag_script+='; echo "== hermes runtime status =="; cat /sandbox/.hermes/gateway_state.json 2>&1 || true'
  diag_script+='; echo "== hermes health =="; curl -sf http://localhost:8642/health 2>&1 || true'
  diag_script+='; echo "== hermes-related processes =="'
  # shellcheck disable=SC2016  # script is intentionally evaluated inside the sandbox
  diag_script+='; for p in /proc/[0-9]*; do cmd=$(tr "\000" " " < "$p/cmdline" 2>/dev/null || true); case "$cmd" in *hermes*|*socat*) echo "$(basename "$p") $cmd" ;; esac; done'
  diag_script+='; echo "== /tmp/nemoclaw-start.log tail =="; tail -n 80 /tmp/nemoclaw-start.log 2>&1 || true'
  diag_script+='; echo "== /tmp/gateway.log tail =="; tail -n 120 /tmp/gateway.log 2>&1 || true'
  diag_output=$(openshell sandbox exec -n "$SANDBOX_NAME" -- sh -lc "$diag_script" 2>&1 || true)

  echo "$diag_output" | while IFS= read -r line; do
    info "  $line"
  done
  info "--- End Hermes Discord diagnostics ---"
}

# Run a command inside the sandbox and capture stdout/stderr.
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

# Run a command inside the sandbox via stdin. This avoids putting sensitive
# values into the remote command line when grepping for leak checks.
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

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-hermes-discord}"
OPENSHELL_BIN="${NEMOCLAW_OPENSHELL_BIN:-openshell}"
DISCORD_TOKEN="${DISCORD_BOT_TOKEN:-test-fake-discord-token-hermes-e2e}"

openshell() {
  if [ "$OPENSHELL_BIN" = "openshell" ]; then
    command openshell "$@"
  else
    "$OPENSHELL_BIN" "$@"
  fi
}
export NEMOCLAW_AGENT="${NEMOCLAW_AGENT:-hermes}"
export NEMOCLAW_POLICY_TIER="${NEMOCLAW_POLICY_TIER:-open}"
export NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME"
export NEMOCLAW_RECREATE_SANDBOX=1
export NEMOCLAW_FRESH=1
export DISCORD_BOT_TOKEN="$DISCORD_TOKEN"
export DISCORD_SERVER_IDS="${DISCORD_SERVER_IDS:-1491590992753590594}"
export DISCORD_ALLOWED_IDS="${DISCORD_ALLOWED_IDS:-1005536447329222676}"
export DISCORD_REQUIRE_MENTION="${DISCORD_REQUIRE_MENTION:-0}"

# shellcheck source=test/e2e/lib/sandbox-teardown.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/sandbox-teardown.sh"
register_sandbox_for_teardown "$SANDBOX_NAME"

# shellcheck source=test/e2e/lib/discord-gateway-proof.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/discord-gateway-proof.sh"

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
info "Discord server IDs configured: ${DISCORD_SERVER_IDS}"
info "Discord allowed IDs configured: ${DISCORD_ALLOWED_IDS}"
info "Discord require mention: ${DISCORD_REQUIRE_MENTION}"

section "Phase 1: Install NemoClaw with Hermes Discord"

cd "$REPO" || {
  fail "Could not cd to repo root: $REPO"
  exit 1
}

info "Pre-cleanup..."
if command -v nemoclaw >/dev/null 2>&1; then
  nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true
fi
if openshell --version >/dev/null 2>&1; then
  openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true
  openshell gateway destroy -g nemoclaw 2>/dev/null || true
fi
pass "Pre-cleanup complete"

INSTALL_LOG="/tmp/nemoclaw-e2e-hermes-discord-install.log"
info "Running install.sh --non-interactive with NEMOCLAW_AGENT=hermes and Discord enabled..."
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
  dump_hermes_discord_diagnostics
  exit 1
fi

if command -v nemoclaw >/dev/null 2>&1; then
  pass "nemoclaw installed at $(command -v nemoclaw)"
else
  fail "nemoclaw not found on PATH after install"
  exit 1
fi

if openshell --version >/dev/null 2>&1; then
  pass "openshell installed ($(openshell --version 2>&1 || echo unknown))"
else
  fail "openshell not found on PATH after install"
  exit 1
fi

section "Phase 2: Hermes sandbox and provider"

if list_output=$(nemoclaw list 2>&1); then
  if grep -Fq -- "$SANDBOX_NAME" <<<"$list_output"; then
    pass "nemoclaw list contains '${SANDBOX_NAME}'"
  else
    fail "nemoclaw list does not contain '${SANDBOX_NAME}'"
  fi
else
  fail "nemoclaw list failed: ${list_output:0:200}"
fi

if openshell provider get "${SANDBOX_NAME}-discord-bridge" >/dev/null 2>&1; then
  pass "Discord provider '${SANDBOX_NAME}-discord-bridge' exists in gateway"
else
  fail "Discord provider '${SANDBOX_NAME}-discord-bridge' not found in gateway"
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
  pass "Hermes health probe returned ok with Discord enabled"
else
  fail "Hermes health probe did not return ok after 15 attempts"
  info "Last response: ${health_response:0:200}"
  dump_hermes_discord_diagnostics
fi

section "Phase 4: Hermes Discord config shape"

expected_require_mention="true"
if [ "$DISCORD_REQUIRE_MENTION" = "0" ]; then
  expected_require_mention="false"
fi
expected_allowed_users="${DISCORD_ALLOWED_IDS// /}"
expected_guild_ids="${DISCORD_SERVER_IDS// /}"

config_probe=$(
  sandbox_exec_stdin "EXPECTED_REQUIRE_MENTION=$expected_require_mention python3 -" <<'PY'
import os
import sys, yaml
with open("/sandbox/.hermes/config.yaml", "r", encoding="utf-8") as f:
    text = f.read()
cfg = yaml.safe_load(text) or {}
errors = []
discord = cfg.get("discord")
if not isinstance(discord, dict):
    errors.append("missing top-level discord")
else:
    expected = {
        "require_mention": os.environ["EXPECTED_REQUIRE_MENTION"] == "true",
        "free_response_channels": "",
        "allowed_channels": "",
        "auto_thread": True,
        "reactions": True,
        "channel_prompts": {},
    }
    for key, value in expected.items():
        if discord.get(key) != value:
            errors.append(f"discord.{key}={discord.get(key)!r} expected {value!r}")
platforms = cfg.get("platforms")
if not isinstance(platforms, dict):
    errors.append("missing platforms")
elif "discord" in platforms:
    errors.append("platforms.discord present")
elif not isinstance(platforms.get("api_server"), dict):
    errors.append("platforms.api_server missing")
if "DISCORD_BOT_TOKEN" in text:
    errors.append("config.yaml contains DISCORD_BOT_TOKEN")
if errors:
    print("FAIL " + "; ".join(errors))
else:
    print("OK")
PY
)

if [ "$config_probe" = "OK" ]; then
  pass "config.yaml uses top-level discord and no platforms.discord"
else
  fail "config.yaml schema check failed: ${config_probe:0:400}"
fi

env_probe=$(
  sandbox_exec_stdin "EXPECTED_ALLOWED_USERS=$expected_allowed_users EXPECTED_GUILD_IDS=$expected_guild_ids python3 -" <<'PY'
import os
from pathlib import Path
text = Path("/sandbox/.hermes/.env").read_text(encoding="utf-8")
errors = []
required = [
    "DISCORD_BOT_TOKEN=openshell:resolve:env:DISCORD_BOT_TOKEN",
    f"NEMOCLAW_DISCORD_GUILD_IDS={os.environ['EXPECTED_GUILD_IDS']}",
    f"DISCORD_ALLOWED_USERS={os.environ['EXPECTED_ALLOWED_USERS']}",
]
for line in required:
    if line not in text.splitlines():
        errors.append(f"missing {line}")
if "API_SERVER_PORT=18642" not in text.splitlines():
    errors.append("missing API_SERVER_PORT")
if errors:
    print("FAIL " + "; ".join(errors))
else:
    print("OK")
PY
)

if [ "$env_probe" = "OK" ]; then
  pass ".hermes/.env contains Discord placeholder and allowed users"
else
  fail ".hermes/.env check failed: ${env_probe:0:400}"
fi

fake_gateway_ready=0
if start_fake_discord_gateway "$DISCORD_TOKEN"; then
  fake_gateway_ready=1
  pass "Hermetic fake Discord Gateway started on host port ${FAKE_DISCORD_GATEWAY_PORT}"
else
  fail "Failed to start hermetic fake Discord Gateway"
fi

if [ "$fake_gateway_ready" = "1" ] \
  && apply_fake_discord_gateway_policy "$SANDBOX_NAME" "$FAKE_DISCORD_GATEWAY_PORT" >/tmp/nemoclaw-hermes-fake-discord-policy.log 2>&1; then
  pass "Applied native WebSocket policy with credential rewrite for Hermes fake Discord Gateway"
else
  fail "Failed to apply Hermes fake Discord Gateway policy: $(tail -20 /tmp/nemoclaw-hermes-fake-discord-policy.log 2>/dev/null | tr '\n' ' ' | cut -c1-300)"
fi

native_gateway_protocol=""
if [ "$fake_gateway_ready" = "1" ]; then
  native_gateway_protocol=$(run_fake_discord_gateway_python_client "$FAKE_DISCORD_GATEWAY_PORT" || true)
fi
info "Hermes native Discord Gateway protocol probe: ${native_gateway_protocol:0:400}"
if echo "$native_gateway_protocol" | grep -q "^UPGRADE$" \
  && echo "$native_gateway_protocol" | grep -q "^HELLO$" \
  && echo "$native_gateway_protocol" | grep -q "^IDENTIFY_SENT_PLACEHOLDER$" \
  && echo "$native_gateway_protocol" | grep -q "^READY$" \
  && echo "$native_gateway_protocol" | grep -q "^HEARTBEAT_ACK$"; then
  pass "Hermes Python Discord Gateway path reaches READY through native OpenShell WebSocket policy"
elif echo "$native_gateway_protocol" | grep -q "IMPORT_DISCORD_FAILED"; then
  fail "Hermes native Gateway probe could not import discord.py: ${native_gateway_protocol:0:300}"
else
  fail "Hermes native Gateway protocol probe failed: ${native_gateway_protocol:0:300}"
fi

if [ "$fake_gateway_ready" = "1" ] \
  && grep -Fq "\"token\":\"$DISCORD_TOKEN\"" "$FAKE_DISCORD_GATEWAY_CAPTURE_FILE" \
  && ! grep -Fq "openshell:resolve:env:DISCORD_BOT_TOKEN" "$FAKE_DISCORD_GATEWAY_CAPTURE_FILE"; then
  pass "Hermes fake Gateway received host-side Discord token while sandbox sent only the placeholder"
else
  if [ "$fake_gateway_ready" = "1" ]; then
    info "Hermes fake Gateway capture: $(tail -20 "$FAKE_DISCORD_GATEWAY_CAPTURE_FILE" 2>/dev/null | tr '\n' ' ' | cut -c1-500)"
  fi
  fail "Hermes fake Gateway did not prove WebSocket placeholder rewrite"
fi

token_file_hits=$(printf '%s' "$DISCORD_TOKEN" | sandbox_exec_stdin 'grep -Fq -f - /sandbox/.hermes/config.yaml /sandbox/.hermes/.env 2>/dev/null && echo LEAK || echo OK')
if [ "$token_file_hits" = "OK" ]; then
  pass "Raw Discord token absent from Hermes config.yaml and .env"
else
  fail "Raw Discord token found in Hermes config files"
fi

section "Phase 5: Sandbox token isolation"

sandbox_env_all=$(sandbox_exec "env 2>/dev/null")
if [ -z "$sandbox_env_all" ]; then
  skip "Sandbox environment dump is empty"
elif echo "$sandbox_env_all" | grep -qF "$DISCORD_TOKEN"; then
  fail "Raw Discord token found in sandbox environment"
elif echo "$sandbox_env_all" | grep -q "^DISCORD_PROXY="; then
  fail "Sandbox environment still contains DISCORD_PROXY bridge setting"
else
  pass "Raw Discord token absent from sandbox environment; no DISCORD_PROXY bridge setting"
fi

sandbox_ps=$(sandbox_exec 'cat /proc/[0-9]*/cmdline 2>/dev/null | tr "\0" "\n"')
if [ -z "$sandbox_ps" ]; then
  skip "Sandbox process list is empty"
elif echo "$sandbox_ps" | grep -qF "$DISCORD_TOKEN"; then
  fail "Raw Discord token found in sandbox process list"
else
  pass "Raw Discord token absent from sandbox process list"
fi

sandbox_fs_hits=$(printf '%s' "$DISCORD_TOKEN" | sandbox_exec_stdin 'grep -rFlm1 -f - /sandbox /home /etc /tmp /var 2>/dev/null || true')
if [ -n "$sandbox_fs_hits" ]; then
  fail "Raw Discord token found on sandbox filesystem: ${sandbox_fs_hits:0:200}"
else
  pass "Raw Discord token absent from sandbox filesystem"
fi

section "Phase 6: Discord REST placeholder egress"

dc_api=$(sandbox_exec 'NODE_NO_WARNINGS=1 node -e "
const fs = require(\"fs\");
const https = require(\"https\");
const env = fs.readFileSync(\"/sandbox/.hermes/.env\", \"utf8\");
const line = env.split(/\\n/).find((entry) => entry.startsWith(\"DISCORD_BOT_TOKEN=\"));
const token = line ? line.slice(\"DISCORD_BOT_TOKEN=\".length) : \"\";
if (!token) {
  console.log(JSON.stringify({ error: \"missing_token\" }));
  process.exit(0);
}
const req = https.request({
  hostname: \"discord.com\",
  path: \"/api/v10/users/@me\",
  method: \"GET\",
  headers: { \"Authorization\": \"Bot \" + token },
}, (res) => {
  let body = \"\";
  res.on(\"data\", (d) => body += d);
  res.on(\"end\", () => console.log(JSON.stringify({
    statusCode: res.statusCode,
    body: body.slice(0, 200),
  })));
});
req.on(\"error\", (e) => console.log(JSON.stringify({ error: e.message })));
req.setTimeout(20000, () => { req.destroy(); console.log(JSON.stringify({ error: \"timeout\" })); });
req.end();
"' 2>/dev/null || true)

info "Discord users/@me response: ${dc_api:0:300}"
dc_status=$(echo "$dc_api" | python3 -c 'import json,sys
lines = [line.strip() for line in sys.stdin if line.strip().startswith("{")]
try:
    print(json.loads(lines[-1]).get("statusCode", "") if lines else "")
except Exception:
    print("")
' 2>/dev/null || true)
dc_error=$(echo "$dc_api" | python3 -c 'import json,sys
lines = [line.strip() for line in sys.stdin if line.strip().startswith("{")]
try:
    print(json.loads(lines[-1]).get("error", "") if lines else "")
except Exception:
    print("")
' 2>/dev/null || true)

if [ "$dc_status" = "200" ]; then
  pass "Discord users/@me returned 200 with configured token"
elif [ "$dc_status" = "401" ]; then
  pass "Discord users/@me returned 401 - REST path reached Discord; this is not gateway IDENTIFY auth proof"
elif [ "$dc_error" = "timeout" ]; then
  skip "Discord API timed out"
elif [ -n "$dc_error" ]; then
  fail "Discord API call failed: ${dc_error:0:200}"
else
  fail "Unexpected Discord API response: ${dc_api:0:300}"
fi

section "Phase 7: No local Discord bridge"

# shellcheck disable=SC2016  # Remote script is intentionally single-quoted for sandbox execution.
facade_residue=$(sandbox_exec 'set +e
env_needle="$(printf "%s%s" "NEMOCLAW_DISCORD_" "FACADE_URL")"
name_needle="$(printf "%s%s" "nemoclaw-discord-" "facade")"
proxy_needle="$(printf "%s" "DISCORD_PROXY")"
decode_needle="$(printf "%s%s%s" "nemoclaw-" "decode" "-proxy")"
if env | grep -q "$env_needle"; then echo ENV_FACADE; fi
if env | grep -q "^${proxy_needle}="; then echo ENV_DISCORD_PROXY; fi
if grep -Fq "$env_needle" /sandbox/.hermes/.env /sandbox/.hermes/config.yaml /tmp/nemoclaw-proxy-env.sh /tmp/gateway.env 2>/dev/null; then echo FILE_FACADE; fi
if grep -Fq "$proxy_needle" /sandbox/.hermes/.env /sandbox/.hermes/config.yaml /tmp/nemoclaw-proxy-env.sh /tmp/gateway.env 2>/dev/null; then echo FILE_DISCORD_PROXY; fi
if find /tmp -maxdepth 1 -type f \( -name "discord-facade.log" -o -name "nemoclaw-discord-facade*" \) 2>/dev/null | grep -q .; then echo FILE_FACADE; fi
if command -v "$decode_needle" >/dev/null 2>&1; then echo BIN_DECODE_PROXY; fi
current_pid="$$"
for p in /proc/[0-9]*; do
  pid=$(basename "$p")
  [ "$pid" = "$current_pid" ] && continue
  cmd=$(tr "\000" " " < "$p/cmdline" 2>/dev/null || true)
  case "$cmd" in *"name_needle="*|*"for p in /proc/"*) continue ;; esac
  case "$cmd" in *"$name_needle"*) echo PROCESS_FACADE ;; esac
  case "$cmd" in *"$decode_needle"*) echo PROCESS_DECODE_PROXY ;; esac
done')
if [ -z "$facade_residue" ]; then
  pass "Hermes Discord proof used native WebSocket policy with no local facade, decode proxy, or DISCORD_PROXY residue"
else
  fail "Local Discord bridge residue found after native Gateway proof: ${facade_residue:0:300}"
  dump_hermes_discord_diagnostics
fi

section "Phase 8: Cleanup"

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

echo ""
echo "========================================"
echo "  Hermes Discord E2E Results:"
echo "    Passed:  $PASS"
echo "    Failed:  $FAIL"
echo "    Skipped: $SKIP"
echo "    Total:   $TOTAL"
echo "========================================"

if [ "$FAIL" -eq 0 ]; then
  printf '\n\033[1;32m  Hermes Discord E2E PASSED - schema, placeholder, provider, sandbox boot, and native Gateway rewrite verified.\033[0m\n'
  exit 0
else
  printf '\n\033[1;31m  %d test(s) failed.\033[0m\n' "$FAIL"
  exit 1
fi
