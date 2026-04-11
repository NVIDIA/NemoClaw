// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { spawnSync } = require("child_process");
const fs = require("fs");

const { getCredential } = require("./credentials");
const { resolveOpenshell } = require("./resolve-openshell");
const { ROOT, shellQuote } = require("./runner");

function getTelegramBridgeToken(sandboxName, fsModule = fs) {
  if (!sandboxName || !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(sandboxName)) {
    return null;
  }

  try {
    const pidPath = `/tmp/nemoclaw-services-${sandboxName}/telegram-bridge.pid`;
    if (!fsModule.existsSync(pidPath)) return null;

    const pid = fsModule.readFileSync(pidPath, "utf-8").trim();
    if (!/^\d+$/.test(pid)) return null;

    const environPath = `/proc/${pid}/environ`;
    if (!fsModule.existsSync(environPath)) return null;

    const entries = fsModule.readFileSync(environPath).toString().split("\0").filter(Boolean);
    const tokenEntry = entries.find((entry) => entry.startsWith("TELEGRAM_BOT_TOKEN="));
    return tokenEntry ? tokenEntry.slice("TELEGRAM_BOT_TOKEN=".length) : null;
  } catch {
    return null;
  }
}

function getTelegramProbeToken(env = process.env, getCredentialFn = getCredential, options = {}) {
  return (
    env.TELEGRAM_BOT_TOKEN ||
    getCredentialFn("TELEGRAM_BOT_TOKEN") ||
    getTelegramBridgeToken(options.sandboxName, options.fsModule) ||
    null
  );
}

function buildTelegramProbeScript(options = {}) {
  const token = options.token ? String(options.token) : "";
  const tokenAssignment =
    token.length > 0 ? `TELEGRAM_BOT_TOKEN=${shellQuote(token)}` : "TELEGRAM_BOT_TOKEN=''";

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
    print('no_proxy_matches_api.telegram.org=false')
    print('http_proxy_target=none')
    raise SystemExit(0)

parsed = urlparse(selected_value)
scheme = parsed.scheme or 'unknown'
hostname = parsed.hostname or 'unknown'
port = parsed.port
target = f'{scheme}://{hostname}' + (f':{port}' if port else '')
no_proxy_value = os.environ.get('NO_PROXY') or os.environ.get('no_proxy') or ''
print('no_proxy_matches_api.telegram.org=' + str(no_proxy_matches('api.telegram.org', no_proxy_value)).lower())
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

  proxy_endpoint_header_file="/tmp/nemoclaw-tg-proxy-endpoint-header-$$.txt"
  proxy_endpoint_error_file="/tmp/nemoclaw-tg-proxy-endpoint-error-$$.txt"
  proxy_endpoint_status_line="$(HTTPS_PROXY= HTTP_PROXY= ALL_PROXY= https_proxy= http_proxy= all_proxy= curl --silent --show-error --no-progress-meter --noproxy '*' -o /dev/null -D "$proxy_endpoint_header_file" --max-time 10 "http://\${proxy_endpoint_host}:\${proxy_endpoint_port}/" 2>"$proxy_endpoint_error_file" && tr -d '\r' < "$proxy_endpoint_header_file" | sed -n '1p' || true)"
  if [ -n "$proxy_endpoint_status_line" ]; then
    printf 'proxy_endpoint_http_status=%s\n' "$proxy_endpoint_status_line"
    pass 'proxy endpoint http'
  else
    proxy_endpoint_error_line="$(grep -m1 '^curl:' "$proxy_endpoint_error_file" || true)"
    if [ -z "$proxy_endpoint_error_line" ]; then
      proxy_endpoint_error_line="$(sed -E '/^$/d' "$proxy_endpoint_error_file" | sed -n '1p')"
    fi
    if [ -n "$proxy_endpoint_error_line" ]; then
      printf 'proxy_endpoint_http_error=%s\n' "$proxy_endpoint_error_line"
    else
      echo 'proxy_endpoint_http_error=none'
    fi
    fail 'proxy endpoint http'
  fi
else
  echo 'proxy_endpoint_target=none'
  warn 'proxy endpoint unavailable; no proxy configured'
fi

section "Proxy Routing"
route_probe_url="https://api.telegram.org/"
route_probe_error_file="/tmp/nemoclaw-tg-probe-route-$$.txt"
route_probe_header_file="/tmp/nemoclaw-tg-probe-route-header-$$.txt"

run_route_probe_for_url() {
  label="$1"
  probe_url="$2"
  shift
  shift
  : > "$route_probe_error_file"
  : > "$route_probe_header_file"
  status_line="$($@ --silent --show-error --no-progress-meter -o /dev/null -D "$route_probe_header_file" --max-time 15 "$probe_url" 2>"$route_probe_error_file" && tr -d '\r' < "$route_probe_header_file" | sed -n '1p' || true)"
  printf '[%s]\n' "$label"
  if [ -n "$status_line" ]; then
    printf 'status=%s\n' "$status_line"
  else
    error_line="$(grep -m1 '^curl:' "$route_probe_error_file" || true)"
    if [ -z "$error_line" ]; then
      error_line="$(sed -E '/^ *% Total/d; /^ *Dload +Upload/d; /^ *0 +0/d; /^ *Current$/d; /^$/d' "$route_probe_error_file" | sed -n '1p')"
    fi
    if [ -n "$error_line" ]; then
      printf 'error=%s\n' "$error_line"
    else
      echo 'error=none'
    fi
  fi
}

run_route_probe() {
  label="$1"
  shift
  run_route_probe_for_url "$label" "$route_probe_url" "$@"
}

run_route_probe default curl
if [ -n "$selected_proxy_target" ]; then
  run_route_probe forced-proxy env NO_PROXY= no_proxy= curl --proxy "$selected_proxy_target" --noproxy ""
else
  echo '[forced-proxy]'
  echo 'skipped=no proxy configured'
fi
run_route_probe forced-bypass env HTTPS_PROXY= HTTP_PROXY= ALL_PROXY= https_proxy= http_proxy= all_proxy= curl --noproxy '*'

section "Proxy Comparison"
comparison_probe_url="https://example.com/"
run_route_probe_for_url comparison-default "$comparison_probe_url" curl
if [ -n "$selected_proxy_target" ]; then
  run_route_probe_for_url comparison-forced-proxy "$comparison_probe_url" env NO_PROXY= no_proxy= curl --proxy "$selected_proxy_target" --noproxy ""
else
  echo '[comparison-forced-proxy]'
  echo 'skipped=no proxy configured'
fi

section "DNS"
if command -v getent >/dev/null 2>&1; then
  echo '[getent ahostsv4]'
  run_with_timeout 5 getent ahostsv4 api.telegram.org 2>/dev/null || true
  echo '[getent ahostsv6]'
  run_with_timeout 5 getent ahostsv6 api.telegram.org 2>/dev/null || true
  echo '[getent hosts]'
  run_with_timeout 5 getent hosts api.telegram.org 2>/dev/null || true
else
  warn 'getent unavailable'
fi

if run_with_timeout 10 python3 - <<'PY'
import socket
import sys

try:
    infos = socket.getaddrinfo('api.telegram.org', 443, proto=socket.IPPROTO_TCP)
except Exception as exc:
    print(f'python_getaddrinfo_error={exc}')
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

print('python_getaddrinfo_families=' + ','.join(ordered))
PY
then
  pass 'dns api.telegram.org'
else
  advisory_fail 'dns api.telegram.org'
fi

section "HTTPS"
curl_header_file="/tmp/nemoclaw-tg-probe-header-$$.txt"
curl_error_file="/tmp/nemoclaw-tg-probe-error-$$.txt"
status_line="$(curl -sS -o /dev/null -D "$curl_header_file" --max-time 15 https://api.telegram.org/ 2>"$curl_error_file" && tr -d '\\r' < "$curl_header_file" | sed -n '1p' || true)"
if [ -n "$status_line" ]; then
  printf '%s\\n' "$status_line"
  pass 'https api.telegram.org'
else
  cat "$curl_error_file" 2>/dev/null || true
  advisory_fail 'https api.telegram.org'
fi

${tokenAssignment}
if [ -n "$TELEGRAM_BOT_TOKEN" ]; then
  section "Bot API (curl)"
  bot_error_file="/tmp/nemoclaw-tg-probe-bot-error-$$.txt"
  bot_response="$(curl -sS --max-time 15 "https://api.telegram.org/bot\${TELEGRAM_BOT_TOKEN}/getMe" 2>"$bot_error_file" || true)"
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

print('bot_api_ok=' + str(bool(data.get('ok'))).lower())
if data.get('ok'):
    result = data.get('result') or {}
    username = result.get('username', '')
    print('bot_username=' + username)
    sys.exit(0)

description = data.get('description', '')
print('bot_api_description=' + str(description))
sys.exit(1)
PY
  bot_status=$?
  if [ "$bot_status" -eq 0 ]; then
    pass 'telegram bot getMe (curl)'
  else
    cat "$bot_error_file" 2>/dev/null || true
    advisory_fail 'telegram bot getMe (curl)'
  fi

  section "Bot API (node)"
  node_bot_output_file="/tmp/nemoclaw-tg-probe-node-bot-out-$$.txt"
  node_bot_error_file="/tmp/nemoclaw-tg-probe-node-bot-error-$$.txt"
  if command -v node >/dev/null 2>&1; then
    if TELEGRAM_BOT_TOKEN="$TELEGRAM_BOT_TOKEN" run_with_timeout 20 node - <<'NODE' >"$node_bot_output_file" 2>"$node_bot_error_file"
const https = require("node:https");

const token = process.env.TELEGRAM_BOT_TOKEN || "";
const url = "https://api.telegram.org/bot" + token + "/getMe";

https.get(url, (response) => {
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
      console.log("node_bot_api_ok=" + String(Boolean(parsed.ok)).toLowerCase());
      if (parsed.ok) {
        const username = parsed.result && parsed.result.username ? parsed.result.username : "";
        console.log("node_bot_username=" + username);
        process.exitCode = 0;
        return;
      }

      console.log("node_bot_api_description=" + String(parsed.description || ""));
      process.exitCode = 1;
    } catch (error) {
      console.log("node_bot_api_json_error=" + error.message);
      console.log(body.slice(0, 400));
      process.exitCode = 1;
    }
  });
}).on("error", (error) => {
  console.error("node_bot_error=" + error.message);
  process.exitCode = 1;
});
NODE
    then
      cat "$node_bot_output_file"
      pass 'telegram bot getMe (node)'
    else
      cat "$node_bot_output_file" 2>/dev/null || true
      cat "$node_bot_error_file" 2>/dev/null || true
      fail 'telegram bot getMe (node)'
    fi
  else
    warn 'node unavailable inside sandbox; skipping Node Bot API probe'
  fi
else
  warn 'TELEGRAM_BOT_TOKEN unavailable on host; skipping authenticated Bot API probe'
fi

rm -f "$curl_header_file" "$curl_error_file" "/tmp/nemoclaw-tg-probe-bot-error-$$.txt" "$route_probe_error_file" "$route_probe_header_file" "$proxy_endpoint_header_file" "$proxy_endpoint_error_file" "/tmp/nemoclaw-tg-probe-node-bot-out-$$.txt" "/tmp/nemoclaw-tg-probe-node-bot-error-$$.txt"
printf 'telegram_probe_advisory=%s\\n' "$advisory"
printf '\\ntelegram_probe_exit=%s\\n' "$overall"
exit "$overall"
`.trim();
}

function buildTelegramProbeCommand(sandboxName, options = {}) {
  const script = buildTelegramProbeScript(options);
  const openshellPath = options.openshellPath || resolveOpenshell() || "openshell";
  const sshHost = `openshell-${sandboxName}`;
  return `probe_ssh_config="$(mktemp /tmp/nemoclaw-tg-probe-XXXXXX.conf)" && trap 'rm -f "$probe_ssh_config"' EXIT && ${shellQuote(openshellPath)} sandbox ssh-config ${shellQuote(sandboxName)} > "$probe_ssh_config" && cat <<'EOF_NEMOCLAW_TELEGRAM_PROBE' | ssh -T -F "$probe_ssh_config" ${shellQuote(sshHost)} bash -s\n${script}\nEOF_NEMOCLAW_TELEGRAM_PROBE`;
}

function runTelegramProbe(sandboxName, options = {}) {
  const token =
    options.token ??
    getTelegramProbeToken(options.env, options.getCredential, {
      sandboxName,
      fsModule: options.fsModule,
    });
  const command = buildTelegramProbeCommand(sandboxName, { token });
  return spawnSync("bash", ["-lc", command], {
    stdio: "inherit",
    cwd: ROOT,
    env: options.env || process.env,
  });
}

module.exports = {
  getTelegramBridgeToken,
  buildTelegramProbeCommand,
  buildTelegramProbeScript,
  getTelegramProbeToken,
  runTelegramProbe,
};
