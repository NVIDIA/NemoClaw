#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Hermes Discord E2E: onboard --agent hermes with Discord enabled, then verify
# the Hermes sandbox has the schema and placeholder/token isolation required by
# NVIDIA/NemoClaw#3032.
#
# Uses a fake Discord token by default. The fake token should never appear in
# /sandbox/.hermes/config.yaml, /sandbox/.hermes/.env, sandbox env, sandbox
# process args, or sandbox filesystem. The sandbox should hold only the
# OpenShell resolver placeholder.
#
# Environment variables:
#   NEMOCLAW_NON_INTERACTIVE=1             - required
#   NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 - required
#   NEMOCLAW_AGENT=hermes                  - auto-set if not already set
#   NEMOCLAW_POLICY_TIER=open              - auto-set if not already set
#   NEMOCLAW_SANDBOX_NAME                  - sandbox name (default: e2e-hermes-discord)
#   NEMOCLAW_RECREATE_SANDBOX=1            - auto-set
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
  diag_script+='; echo "== hermes runtime status =="; cat /sandbox/.hermes/gateway_state.json 2>&1 || true'
  diag_script+='; echo "== hermes health =="; curl -sf http://localhost:8642/health 2>&1 || true'
  diag_script+='; echo "== hermes-related processes =="'
  # shellcheck disable=SC2016  # script is intentionally evaluated inside the sandbox
  diag_script+='; for p in /proc/[0-9]*; do cmd=$(tr "\000" " " < "$p/cmdline" 2>/dev/null || true); case "$cmd" in *hermes*|*socat*|*nemoclaw-decode-proxy*|*nemoclaw-discord-facade*) echo "$(basename "$p") $cmd" ;; esac; done'
  diag_script+='; echo "== /tmp/nemoclaw-start.log tail =="; tail -n 80 /tmp/nemoclaw-start.log 2>&1 || true'
  diag_script+='; echo "== /tmp/gateway.log tail =="; tail -n 120 /tmp/gateway.log 2>&1 || true'
  diag_script+='; echo "== /tmp/discord-facade.log tail =="; tail -n 120 /tmp/discord-facade.log 2>&1 || true'
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
DISCORD_TOKEN="${DISCORD_BOT_TOKEN:-test-fake-discord-token-hermes-e2e}"
export NEMOCLAW_AGENT="${NEMOCLAW_AGENT:-hermes}"
export NEMOCLAW_POLICY_TIER="${NEMOCLAW_POLICY_TIER:-open}"
export NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME"
export NEMOCLAW_RECREATE_SANDBOX=1
export DISCORD_BOT_TOKEN="$DISCORD_TOKEN"
export DISCORD_SERVER_IDS="${DISCORD_SERVER_IDS:-1491590992753590594}"
export DISCORD_ALLOWED_IDS="${DISCORD_ALLOWED_IDS:-1005536447329222676}"
export DISCORD_REQUIRE_MENTION="${DISCORD_REQUIRE_MENTION:-0}"

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
if command -v openshell >/dev/null 2>&1; then
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

if command -v openshell >/dev/null 2>&1; then
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
    "DISCORD_PROXY=http://127.0.0.1:3129",
    "NEMOCLAW_DISCORD_FACADE_URL=http://127.0.0.1:3130",
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
  pass ".hermes/.env contains Discord placeholder, proxy bridge, and allowed users"
else
  fail ".hermes/.env check failed: ${env_probe:0:400}"
fi

gateway_proxy_log=$(sandbox_exec "grep -F 'Using proxy for Discord: http://127.0.0.1:3129' /tmp/gateway.log 2>/dev/null | tail -1 || true")
if [ -n "$gateway_proxy_log" ]; then
  info "Hermes Discord proxy diagnostic: ${gateway_proxy_log:0:200}"
else
  info "Hermes Discord proxy diagnostic log line not present; relying on env, facade, and REST checks"
fi

facade_health=""
for facade_attempt in $(seq 1 15); do
  facade_health=$(sandbox_exec "curl -sf http://127.0.0.1:3130/health 2>/dev/null || true")
  if echo "$facade_health" | grep -qi '"ok":true'; then
    break
  fi
  if [ "$facade_attempt" -lt 15 ]; then
    info "Facade health check attempt ${facade_attempt}/15 - waiting 4s..."
    sleep 4
  fi
done
if echo "$facade_health" | grep -qi '"ok":true'; then
  pass "Hermes fake Discord facade is healthy inside the sandbox"
else
  fail "Hermes fake Discord facade did not answer health probe: ${facade_health:0:200}"
fi

facade_protocol=$(
  cat <<'PY' | sandbox_exec_stdin 'NEMOCLAW_DISCORD_FACADE_URL=http://127.0.0.1:3130 PYTHONPATH=/opt/nemoclaw-hermes-discord-preload python3 - 2>&1' 2>/dev/null || true
import asyncio
import json

from aiohttp import ClientSession, WSMsgType

PLACEHOLDER = "openshell:resolve:env:DISCORD_BOT_TOKEN"


async def receive_json(ws, label):
    msg = await ws.receive(timeout=5)
    if msg.type != WSMsgType.TEXT:
        raise AssertionError(f"{label}: expected text frame, got {msg.type} {msg.data!r}")
    return json.loads(msg.data)


async def main():
    async with ClientSession() as session:
        async with session.get("https://discord.com/api/v10/gateway") as response:
            data = await response.json()
            assert response.status == 200, data
            assert data["url"] == "ws://127.0.0.1:3130/gateway", data

        async with session.ws_connect("wss://gateway.discord.gg/?v=10&encoding=json") as ws:
            hello = await receive_json(ws, "HELLO")
            assert hello["op"] == 10, hello

            await ws.send_json({
                "op": 2,
                "d": {
                    "token": PLACEHOLDER,
                    "intents": 0,
                    "properties": {
                        "os": "linux",
                        "browser": "nemoclaw-e2e",
                        "device": "nemoclaw-e2e",
                    },
                },
            })
            ready = await receive_json(ws, "READY")
            assert ready["op"] == 0 and ready["t"] == "READY", ready
            assert ready["d"]["resume_gateway_url"] == "ws://127.0.0.1:3130/gateway", ready

            await ws.send_json({"op": 1, "d": ready.get("s")})
            ack = await receive_json(ws, "HEARTBEAT_ACK")
            assert ack["op"] == 11, ack

        async with session.ws_connect("wss://gateway.discord.gg/?v=10&encoding=json") as ws:
            hello = await receive_json(ws, "reject HELLO")
            assert hello["op"] == 10, hello
            await ws.send_json({
                "op": 2,
                "d": {
                    "token": "not-the-openshell-placeholder",
                    "intents": 0,
                    "properties": {
                        "os": "linux",
                        "browser": "nemoclaw-e2e",
                        "device": "nemoclaw-e2e",
                    },
                },
            })
            close = await ws.receive(timeout=5)
            assert close.type in (WSMsgType.CLOSE, WSMsgType.CLOSED, WSMsgType.CLOSING), close
            assert ws.close_code == 4004 or close.data == 4004, (ws.close_code, close.data)

        async with session.post("http://127.0.0.1:3130/interactions", json={"type": 1}) as response:
            assert response.status == 401, await response.text()

    print("OK preload_rest=local preload_gateway=ready heartbeat=ack reject=4004 unsigned_interaction=401")


asyncio.run(main())
PY
)
info "Fake Discord facade protocol probe: ${facade_protocol:0:300}"
if echo "$facade_protocol" | grep -q "OK preload_rest=local preload_gateway=ready heartbeat=ack reject=4004 unsigned_interaction=401"; then
  pass "Hermes Discord preload and fake Gateway protocol path work inside the sandbox"
elif echo "$facade_protocol" | grep -q "ModuleNotFoundError"; then
  fail "Hermes Discord facade protocol probe could not import required Python modules: ${facade_protocol:0:300}"
else
  fail "Hermes Discord facade protocol probe failed: ${facade_protocol:0:300}"
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
elif ! echo "$sandbox_env_all" | grep -qx "DISCORD_PROXY=http://127.0.0.1:3129"; then
  fail "Sandbox environment missing DISCORD_PROXY bridge setting"
elif ! echo "$sandbox_env_all" | grep -qx "NEMOCLAW_DISCORD_FACADE_URL=http://127.0.0.1:3130"; then
  fail "Sandbox environment missing fake Discord facade setting"
else
  pass "Raw Discord token absent from sandbox environment; Discord proxy and facade settings are present"
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

section "Phase 7: Discord gateway auth boundary"

gateway_connected_status=""
for gw_attempt in $(seq 1 10); do
  gateway_connected_status=$(
    sandbox_exec_stdin 'python3 -' <<'PY'
import json
from pathlib import Path

path = Path("/sandbox/.hermes/gateway_state.json")
try:
    payload = json.loads(path.read_text(encoding="utf-8"))
except FileNotFoundError:
    print("MISSING /sandbox/.hermes/gateway_state.json")
except Exception as exc:
    print(f"ERROR reading gateway_state.json: {type(exc).__name__}: {exc}")
else:
    platforms = payload.get("platforms") if isinstance(payload, dict) else {}
    discord = platforms.get("discord") if isinstance(platforms, dict) else {}
    if isinstance(discord, dict) and discord.get("state") == "connected":
        print("CONNECTED")
    else:
        print(json.dumps(
            {
                "gateway_state": payload.get("gateway_state") if isinstance(payload, dict) else None,
                "discord": discord if isinstance(discord, dict) else None,
            },
            sort_keys=True,
        ))
PY
  )
  [ "$gateway_connected_status" = "CONNECTED" ] && break
  if [ "$gw_attempt" -lt 10 ]; then
    info "Gateway runtime status check attempt ${gw_attempt}/10 - waiting 3s..."
    sleep 3
  fi
done
if [ "$gateway_connected_status" = "CONNECTED" ]; then
  pass "Hermes Discord gateway reached READY through the fake local Gateway"
else
  info "Hermes Discord runtime status: ${gateway_connected_status:0:400}"
  fail "Hermes Discord gateway did not reach READY through the fake local Gateway"
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
  printf '\n\033[1;32m  Hermes Discord E2E PASSED - schema, placeholder, provider, and sandbox boot verified.\033[0m\n'
  exit 0
else
  printf '\n\033[1;31m  %d test(s) failed.\033[0m\n' "$FAIL"
  exit 1
fi
