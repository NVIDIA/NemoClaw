// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { spawnSync } = require("child_process");
const fs = require("fs");

const { getCredential } = require("./credentials");
const { resolveOpenshell } = require("./resolve-openshell");
const { ROOT, shellQuote } = require("./runner");

function getDiscordBridgeToken(sandboxName, fsModule = fs) {
  if (!sandboxName || !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(sandboxName)) {
    return null;
  }

  try {
    const pidPath = `/tmp/nemoclaw-services-${sandboxName}/discord-bridge.pid`;
    if (!fsModule.existsSync(pidPath)) return null;

    const pid = fsModule.readFileSync(pidPath, "utf-8").trim();
    if (!/^\d+$/.test(pid)) return null;

    const environPath = `/proc/${pid}/environ`;
    if (!fsModule.existsSync(environPath)) return null;

    const entries = fsModule.readFileSync(environPath).toString().split("\0").filter(Boolean);
    const tokenEntry = entries.find((entry) => entry.startsWith("DISCORD_BOT_TOKEN="));
    return tokenEntry ? tokenEntry.slice("DISCORD_BOT_TOKEN=".length) : null;
  } catch {
    return null;
  }
}

function getDiscordProbeToken(env = process.env, getCredentialFn = getCredential, options = {}) {
  return (
    env.DISCORD_BOT_TOKEN ||
    getCredentialFn("DISCORD_BOT_TOKEN") ||
    getDiscordBridgeToken(options.sandboxName, options.fsModule) ||
    null
  );
}

function buildDiscordProbeScript(options = {}) {
  const token = options.token ? String(options.token) : "";
  const tokenAssignment =
    token.length > 0 ? `DISCORD_BOT_TOKEN=${shellQuote(token)}` : "DISCORD_BOT_TOKEN=''";

  return `
set -u
overall=0
advisory=0
TIMEOUT_BIN=''

if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_BIN='timeout'
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_BIN='gtimeout'
fi

pass() { printf 'PASS %s\\n' "$1"; }
warn() { printf 'WARN %s\\n' "$1"; }
fail() { printf 'FAIL %s\\n' "$1"; overall=1; }
advisory_fail() { printf 'WARN %s\\n' "$1"; advisory=1; }
section() { printf '\\n== %s ==\\n' "$1"; }
run_with_timeout() {
  limit="$1"
  shift
  if [ -n "$TIMEOUT_BIN" ]; then
    "$TIMEOUT_BIN" "$limit" "$@"
  else
    "$@"
  fi
}

section "Runtime"
printf 'date=%s\\n' "$(date -Is 2>/dev/null || date)"
printf 'hostname=%s\\n' "$(hostname 2>/dev/null || echo unknown)"
printf 'node=%s\\n' "$(node --version 2>/dev/null || echo missing)"
printf 'python3=%s\\n' "$(python3 --version 2>/dev/null || echo missing)"
printf 'curl=%s\\n' "$(curl --version 2>/dev/null | head -1 || echo missing)"
proxy_env="$(env | grep -i -E '^(http|https|all|no)_proxy=' | tr '\\n' ';' || true)"
printf 'proxy_env=%s\n' "\${proxy_env:-none}"

section "Proxy"
proxy_lines="$(env | grep -E '^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|http_proxy|https_proxy|all_proxy|no_proxy)=' | sort || true)"
if [ -n "$proxy_lines" ]; then
  printf '%s\n' "$proxy_lines"
else
  echo 'proxy_env_lines=none'
fi

python3 - <<'PY'
import os
from urllib.parse import urlparse

proxy_order = [
    'HTTPS_PROXY', 'https_proxy',
    'HTTP_PROXY', 'http_proxy',
    'ALL_PROXY', 'all_proxy',
]

selected_name = None
selected_value = None
for name in proxy_order:
    value = os.environ.get(name)
    if value:
        selected_name = name
        selected_value = value
        break

def no_proxy_matches(hostname, raw_value):
    if not raw_value:
        return False
    hostname = hostname.lower()
    for part in raw_value.replace(' ', ',').split(','):
        token = part.strip().lower()
        if not token:
            continue
        if token == '*':
            return True
        if token.startswith('.'):
            token = token[1:]
        host_only = token.split(':', 1)[0]
        if hostname == host_only or hostname.endswith('.' + host_only):
            return True
    return False

if not selected_value:
    print('no_proxy_matches_discord.com=false')
    print('http_proxy_target=none')
    raise SystemExit(0)

parsed = urlparse(selected_value)
scheme = parsed.scheme or 'unknown'
hostname = parsed.hostname or 'unknown'
port = parsed.port
target = f'{scheme}://{hostname}' + (f':{port}' if port else '')
no_proxy_value = os.environ.get('NO_PROXY') or os.environ.get('no_proxy') or ''
print('no_proxy_matches_discord.com=' + str(no_proxy_matches('discord.com', no_proxy_value)).lower())
print(f'http_proxy_source={selected_name}')
print(f'http_proxy_target={target}')
PY
selected_proxy_target="$(python3 - <<'PY'
import os

for name in ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']:
    value = os.environ.get(name)
    if value:
        print(value)
        break
PY
)"

section "Proxy Endpoint"
if [ -n "$selected_proxy_target" ]; then
  proxy_endpoint_host="$(SELECTED_PROXY_TARGET="$selected_proxy_target" python3 - <<'PY'
import os
from urllib.parse import urlparse

parsed = urlparse(os.environ.get('SELECTED_PROXY_TARGET', ''))
print(parsed.hostname or '')
PY
)"
  proxy_endpoint_port="$(SELECTED_PROXY_TARGET="$selected_proxy_target" python3 - <<'PY'
import os
from urllib.parse import urlparse

parsed = urlparse(os.environ.get('SELECTED_PROXY_TARGET', ''))
if parsed.port:
    print(parsed.port)
elif parsed.scheme == 'https':
    print(443)
else:
    print(80)
PY
)"
  printf 'proxy_endpoint_host=%s\n' "$proxy_endpoint_host"
  printf 'proxy_endpoint_port=%s\n' "$proxy_endpoint_port"

  if SELECTED_PROXY_TARGET="$selected_proxy_target" run_with_timeout 5 python3 - <<'PY'
import os
import socket
import sys
from urllib.parse import urlparse

parsed = urlparse(os.environ.get('SELECTED_PROXY_TARGET', ''))
host = parsed.hostname
port = parsed.port or (443 if parsed.scheme == 'https' else 80)
if not host:
    print('proxy_tcp_error=missing-host')
    sys.exit(1)

try:
    with socket.create_connection((host, port), timeout=5):
        print('proxy_tcp_connect=ok')
except Exception as exc:
    print(f'proxy_tcp_error={exc}')
    sys.exit(1)
PY
  then
    pass 'proxy endpoint tcp connect'
  else
    fail 'proxy endpoint tcp connect'
  fi
else
  echo 'proxy_endpoint_target=none'
  warn 'proxy endpoint unavailable; no proxy configured'
fi

section "DNS"
if command -v getent >/dev/null 2>&1; then
  echo '[getent ahostsv4 discord.com]'
  run_with_timeout 5 getent ahostsv4 discord.com 2>/dev/null || true
  echo '[getent hosts gateway.discord.gg]'
  run_with_timeout 5 getent hosts gateway.discord.gg 2>/dev/null || true
else
  warn 'getent unavailable'
fi

if run_with_timeout 10 python3 - <<'PY'
import socket
import sys

hosts = ['discord.com', 'gateway.discord.gg']
for host in hosts:
    try:
        infos = socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)
    except Exception as exc:
        print(f'python_getaddrinfo_error_{host}={exc}')
        sys.exit(1)
    families = []
    for family, *_rest in infos:
        if family == socket.AF_INET:
            families.append('ipv4')
        elif family == socket.AF_INET6:
            families.append('ipv6')
    ordered = []
    for family in families:
        if family not in ordered:
            ordered.append(family)
    print(f'python_getaddrinfo_families_{host}=' + ','.join(ordered))
PY
then
  pass 'dns discord'
else
  advisory_fail 'dns discord'
fi

section "HTTPS"
curl_header_file="/tmp/nemoclaw-dc-probe-header-$$.txt"
curl_error_file="/tmp/nemoclaw-dc-probe-error-$$.txt"
status_line="$(curl -sS -o /dev/null -D "$curl_header_file" --max-time 15 https://discord.com/api/v10/gateway 2>"$curl_error_file" && tr -d '\\r' < "$curl_header_file" | sed -n '1p' || true)"
if [ -n "$status_line" ]; then
  printf '%s\\n' "$status_line"
  pass 'https discord gateway endpoint'
else
  cat "$curl_error_file" 2>/dev/null || true
  advisory_fail 'https discord gateway endpoint'
fi

${tokenAssignment}
if [ -n "$DISCORD_BOT_TOKEN" ]; then
  section "Bot API (curl)"
  bot_error_file="/tmp/nemoclaw-dc-probe-bot-error-$$.txt"
  bot_response="$(curl -sS --max-time 15 -H "Authorization: Bot $DISCORD_BOT_TOKEN" https://discord.com/api/v10/users/@me 2>"$bot_error_file" || true)"
  printf '%s' "$bot_response" | python3 - <<'PY'
import json
import sys

payload = sys.stdin.read()
if not payload:
    print('bot_api_response=empty')
    sys.exit(1)

try:
    data = json.loads(payload)
except Exception as exc:
    print(f'bot_api_json_error={exc}')
    print(payload[:400])
    sys.exit(1)

print('bot_api_id=' + str(data.get('id', '')))
print('bot_api_username=' + str(data.get('username', '')))
if data.get('id'):
    sys.exit(0)

print('bot_api_error=' + str(data))
sys.exit(1)
PY
  bot_status=$?
  if [ "$bot_status" -eq 0 ]; then
    pass 'discord bot users me (curl)'
  else
    cat "$bot_error_file" 2>/dev/null || true
    advisory_fail 'discord bot users me (curl)'
  fi

  section "Bot API (node)"
  node_bot_output_file="/tmp/nemoclaw-dc-probe-node-bot-out-$$.txt"
  node_bot_error_file="/tmp/nemoclaw-dc-probe-node-bot-error-$$.txt"
  if command -v node >/dev/null 2>&1; then
    if DISCORD_BOT_TOKEN="$DISCORD_BOT_TOKEN" run_with_timeout 20 node - <<'NODE' >"$node_bot_output_file" 2>"$node_bot_error_file"
const https = require("node:https");

const token = process.env.DISCORD_BOT_TOKEN || "";
const req = https.request(
  {
    hostname: "discord.com",
    path: "/api/v10/users/@me",
    method: "GET",
    headers: {
      Authorization: "Bot " + token,
      "User-Agent": "NemoClaw Discord Probe/1.0",
    },
  },
  (response) => {
    let body = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => {
      body += chunk;
    });
    response.on("end", () => {
      console.log("node_bot_http_status=" + String(response.statusCode || 0));
      if (!body) {
        console.log("node_bot_api_response=empty");
        process.exitCode = 1;
        return;
      }

      try {
        const parsed = JSON.parse(body);
        console.log("node_bot_id=" + String(parsed.id || ""));
        console.log("node_bot_username=" + String(parsed.username || ""));
        process.exitCode = parsed.id ? 0 : 1;
      } catch (error) {
        console.log("node_bot_api_json_error=" + error.message);
        console.log(body.slice(0, 400));
        process.exitCode = 1;
      }
    });
  },
);

req.on("error", (error) => {
  console.error("node_bot_error=" + error.message);
  process.exitCode = 1;
});
req.end();
NODE
    then
      cat "$node_bot_output_file"
      pass 'discord bot users me (node)'
    else
      cat "$node_bot_output_file" 2>/dev/null || true
      cat "$node_bot_error_file" 2>/dev/null || true
      fail 'discord bot users me (node)'
    fi
  else
    warn 'node unavailable inside sandbox; skipping Node Bot API probe'
  fi
else
  warn 'DISCORD_BOT_TOKEN unavailable on host; skipping authenticated Bot API probe'
fi

rm -f "$curl_header_file" "$curl_error_file" "/tmp/nemoclaw-dc-probe-bot-error-$$.txt" "/tmp/nemoclaw-dc-probe-node-bot-out-$$.txt" "/tmp/nemoclaw-dc-probe-node-bot-error-$$.txt"
printf 'discord_probe_advisory=%s\\n' "$advisory"
printf '\\ndiscord_probe_exit=%s\\n' "$overall"
exit "$overall"
`.trim();
}

function buildDiscordProbeCommand(sandboxName, options = {}) {
  const script = buildDiscordProbeScript(options);
  const openshellPath = options.openshellPath || resolveOpenshell() || "openshell";
  const sshHost = `openshell-${sandboxName}`;
  return `probe_ssh_config="$(mktemp /tmp/nemoclaw-dc-probe-XXXXXX.conf)" && trap 'rm -f "$probe_ssh_config"' EXIT && ${shellQuote(openshellPath)} sandbox ssh-config ${shellQuote(sandboxName)} > "$probe_ssh_config" && cat <<'EOF_NEMOCLAW_DISCORD_PROBE' | ssh -T -F "$probe_ssh_config" ${shellQuote(sshHost)} bash -s\n${script}\nEOF_NEMOCLAW_DISCORD_PROBE`;
}

function runDiscordProbe(sandboxName, options = {}) {
  const token =
    options.token ??
    getDiscordProbeToken(options.env, options.getCredential, {
      sandboxName,
      fsModule: options.fsModule,
    });
  const command = buildDiscordProbeCommand(sandboxName, { token });
  return spawnSync("bash", ["-lc", command], {
    stdio: "inherit",
    cwd: ROOT,
    env: options.env || process.env,
  });
}

module.exports = {
  getDiscordBridgeToken,
  buildDiscordProbeCommand,
  buildDiscordProbeScript,
  getDiscordProbeToken,
  runDiscordProbe,
};
