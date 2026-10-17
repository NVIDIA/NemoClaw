#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Helper used by setup-*-e2e-sandboxes.sh to publish sandbox loopback HTTP
# onto the DGX host (one host port per user). This is not a client and does
# not replace client.sh / client_hermes.sh / client_deepagents.sh.
# Those scripts still run from the same DGX in another terminal:
#   E2E_USERS=5 ./scripts/client.sh
# Optional laptop: E2E_CLIENT_HOST=dgx-ip ./scripts/client.sh
#
# Sourced by setup. Do not run this file directly.
#
# Optional OpenClaw web search (sandbox 0 UI only), same knobs as nemoclaw onboard:
#   NEMOCLAW_WEB_SEARCH_ENABLED=1
#   NEMOCLAW_WEB_SEARCH_PROVIDER=brave   # or tavily
#   BRAVE_API_KEY=...                    # or TAVILY_API_KEY
# Keys may live in gitignored secrets.env. Do not print them.

remote_http_load_optional_secrets() {
  local f
  f="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/secrets.env"
  if [[ -f "${f}" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "${f}"
    set +a
  fi
}

remote_http_web_search_wanted() {
  case "${NEMOCLAW_WEB_SEARCH_ENABLED:-0}" in
    1 | true | yes | on) return 0 ;;
    *) return 1 ;;
  esac
}

remote_http_web_search_provider() {
  local provider
  provider="$(printf '%s' "${NEMOCLAW_WEB_SEARCH_PROVIDER:-brave}" | tr '[:upper:]' '[:lower:]')"
  case "${provider}" in
    brave | tavily) printf '%s\n' "${provider}" ;;
    *)
      echo "ERROR: NEMOCLAW_WEB_SEARCH_PROVIDER must be brave or tavily" >&2
      return 1
      ;;
  esac
}

remote_http_web_search_key_env() {
  case "${1:?provider}" in
    brave) printf '%s\n' "BRAVE_API_KEY" ;;
    tavily) printf '%s\n' "TAVILY_API_KEY" ;;
    *) return 1 ;;
  esac
}

remote_http_advertise_host() {
  if [[ -n "${E2E_CLIENT_HOST:-}" ]]; then
    printf '%s\n' "${E2E_CLIENT_HOST}"
    return 0
  fi
  local ip
  ip="$(hostname -I 2>/dev/null | awk '{
    for (i = 1; i <= NF; i++) {
      if ($i ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ && $i !~ /^127\./) {
        print $i
        exit
      }
    }
  }')"
  if [[ -n "${ip}" ]]; then
    printf '%s\n' "${ip}"
    return 0
  fi
  hostname -f 2>/dev/null || hostname
}

remote_http_openclaw_token() {
  local name="${1:?sandbox}"
  local ns="${OPENSHELL_NAMESPACE:-${E2E_SANDBOX_NS:-nemoclaw-sandboxes}}"
  kubectl exec -n "${ns}" "${name}" -c agent -- python3 -c '
import json, sys
try:
    cfg = json.load(open("/sandbox/.openclaw/openclaw.json", encoding="utf-8"))
except Exception:
    sys.exit(1)
token = ((cfg.get("gateway") or {}).get("auth") or {}).get("token")
if not isinstance(token, str) or not token.strip():
    sys.exit(1)
print(token.strip())
' 2>/dev/null
}

remote_http_hermes_token() {
  local name="${1:?sandbox}"
  local ns="${OPENSHELL_NAMESPACE:-${E2E_SANDBOX_NS:-nemoclaw-sandboxes}}"
  kubectl exec -n "${ns}" "${name}" -c agent -- python3 -c '
import sys
path = "/sandbox/.hermes/.env"
try:
    text = open(path, encoding="utf-8").read()
except OSError:
    sys.exit(1)
for line in text.splitlines():
    if line.startswith("API_SERVER_KEY="):
        print(line.split("=", 1)[1].strip().strip('"').strip("'"))
        raise SystemExit(0)
sys.exit(1)
' 2>/dev/null
}

remote_http_stop_port() {
  local port="${1:?port}"
  openshell forward stop "${port}" >/dev/null 2>&1 || true
}

remote_http_stop_discovery() {
  local pidfile="${1:-}"
  local port="${E2E_DISCOVERY_PORT:-18788}"
  if [[ -n "${pidfile}" && -f "${pidfile}" ]]; then
    kill "$(cat "${pidfile}")" >/dev/null 2>&1 || true
    rm -f "${pidfile}"
  fi
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${port}/tcp" >/dev/null 2>&1 || true
  fi
}

# Laptop clients only set E2E_CLIENT_HOST. This is not a user-facing file.
remote_http_serve_discovery() {
  local json="${1:?json}"
  local port="${2:-${E2E_DISCOVERY_PORT:-18788}}"
  local script
  local pidfile="${json%.json}-discovery.pid"
  local log="${json%.json}-discovery.log"
  script="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/files/e2e-http-discovery.py"
  remote_http_stop_discovery "${pidfile}"
  mkdir -p "$(dirname "${json}")"
  nohup python3 "${script}" "${json}" "${port}" >>"${log}" 2>&1 &
  echo $! >"${pidfile}"
  local i
  for ((i = 0; i < 20; i += 1)); do
    if remote_http_wait_http "http://127.0.0.1:${port}/clients" 1; then
      return 0
    fi
  done
  echo "ERROR: laptop HTTP discovery on :${port} did not start" >&2
  return 1
}

# One ForwardTcp: bind:local_port → sandbox 127.0.0.1:target_port
remote_http_start_forward() {
  local name="${1:?sandbox}"
  local target_port="${2:?target}"
  local local_port="${3:?local}"
  local log="${4:?log}"
  local bind="${5:-${E2E_PUBLISH_BIND:-127.0.0.1}}"
  remote_http_stop_port "${local_port}"
  mkdir -p "$(dirname "${log}")"
  nohup openshell forward service "${name}" \
    --target-port "${target_port}" \
    --target-host 127.0.0.1 \
    --local "${bind}:${local_port}" \
    >>"${log}" 2>&1 &
  echo $! >"${log}.pid"
}

remote_http_stop_ui_shortcut() {
  local pidfile="${1:?pidfile}"
  local port="${2:?port}"
  if [[ -f "${pidfile}" ]]; then
    kill "$(cat "${pidfile}")" >/dev/null 2>&1 || true
    rm -f "${pidfile}"
  fi
  rm -f "${pidfile%.pid}.token"
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${port}/tcp" >/dev/null 2>&1 || true
  fi
}

# Public :18789+i — GET /u/0 redirects to / with no token. The gateway
# token stays in a 0600 file on this host and is injected on the backend hop.
remote_http_start_ui_shortcut() {
  local public_port="${1:?public}"
  local backend_port="${2:?backend}"
  local token="${3:?token}"
  local log="${4:?log}"
  local script pidfile token_file
  script="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/files/e2e-openclaw-ui-shortcut.py"
  pidfile="${log}.pid"
  token_file="${log}.token"
  remote_http_stop_ui_shortcut "${pidfile}" "${public_port}"
  mkdir -p "$(dirname "${log}")"
  local old_umask
  old_umask="$(umask)"
  umask 077
  printf '%s' "${token}" >"${token_file}"
  umask "${old_umask}"
  chmod 600 "${token_file}"
  nohup env E2E_OPENCLAW_GATEWAY_TOKEN_FILE="${token_file}" \
    python3 "${script}" "${public_port}" 127.0.0.1 "${backend_port}" \
    >>"${log}" 2>&1 &
  echo $! >"${pidfile}"
}

remote_http_wait_http() {
  local url="${1:?url}"
  local tries="${2:-20}"
  local i code
  for ((i = 0; i < tries; i += 1)); do
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "${url}" 2>/dev/null || true)"
    case "${code}" in
      200 | 401 | 403) return 0 ;;
    esac
    sleep 1
  done
  return 1
}

# Pin already enables Control UI. Add this user's host origin; restart only
# if :18789 is not serving the dashboard yet.
remote_http_enable_openclaw_ui() {
  local name="${1:?sandbox}"
  local origin="${2:?origin}"
  local ns="${OPENSHELL_NAMESPACE:-${E2E_SANDBOX_NS:-nemoclaw-sandboxes}}"
  kubectl exec -n "${ns}" "${name}" -c agent -- python3 -c '
import json, pathlib, sys
origin = sys.argv[1]
root = pathlib.Path("/sandbox/.openclaw")
paths = [root / "openclaw.json"]
paths += sorted(root.glob("openclaw.json.bak*"))
paths += sorted(root.glob("openclaw.json.last-good*"))
for path in paths:
    try:
        cfg = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        continue
    ui = cfg.setdefault("gateway", {}).setdefault("controlUi", {})
    if not isinstance(ui, dict):
        continue
    ui["enabled"] = True
    ui["allowInsecureAuth"] = True
    ui["dangerouslyDisableDeviceAuth"] = True
    origins = ui.get("allowedOrigins")
    if not isinstance(origins, list):
        origins = []
    for item in (origin, "http://127.0.0.1:18789", "http://localhost:18789"):
        if item not in origins:
            origins.append(item)
    ui["allowedOrigins"] = origins
    path.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")
' "${origin}" >/dev/null
}

# Official OpenClaw shape from generate-openclaw-config.mts. Sandbox 0 only.
remote_http_enable_openclaw_web_search() {
  local name="${1:?sandbox}"
  local provider="${2:?provider}"
  local cred_env="${3:?cred_env}"
  local ns="${OPENSHELL_NAMESPACE:-${E2E_SANDBOX_NS:-nemoclaw-sandboxes}}"
  kubectl exec -n "${ns}" "${name}" -c agent -- python3 -c '
import json, pathlib, sys
provider, cred_env = sys.argv[1], sys.argv[2]
root = pathlib.Path("/sandbox/.openclaw")
paths = [root / "openclaw.json"]
paths += sorted(root.glob("openclaw.json.bak*"))
paths += sorted(root.glob("openclaw.json.last-good*"))
for path in paths:
    try:
        cfg = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        continue
    tools = cfg.setdefault("tools", {})
    if not isinstance(tools, dict):
        continue
    web = tools.setdefault("web", {})
    if not isinstance(web, dict):
        web = {}
        tools["web"] = web
    web["search"] = {"enabled": True, "provider": provider}
    web["fetch"] = {"enabled": True, "useTrustedEnvProxy": True}
    plugins = cfg.setdefault("plugins", {})
    if not isinstance(plugins, dict):
        continue
    entries = plugins.setdefault("entries", {})
    if not isinstance(entries, dict):
        entries = {}
        plugins["entries"] = entries
    entries[provider] = {
        "enabled": True,
        "config": {"webSearch": {"apiKey": "openshell:resolve:env:" + cred_env}},
    }
    allow = plugins.get("allow")
    if isinstance(allow, list):
        for item in ("nemoclaw", provider):
            if item not in allow:
                allow.append(item)
        plugins["allow"] = allow
    path.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")
' "${provider}" "${cred_env}" >/dev/null
}

remote_http_openclaw_root_ok() {
  local name="${1:?sandbox}"
  local ns="${OPENSHELL_NAMESPACE:-${E2E_SANDBOX_NS:-nemoclaw-sandboxes}}"
  kubectl exec -n "${ns}" "${name}" -c agent -- bash -c '
    for ns in /run/netns/*; do
      [ -e "$ns" ] || continue
      body="$(nsenter --net="$ns" curl -sS --max-time 2 http://127.0.0.1:18789/ 2>/dev/null || true)"
      case "$body" in
        *html*|*OpenClaw*|*openclaw*|*DOCTYPE*) exit 0 ;;
      esac
    done
    exit 1
  ' >/dev/null 2>&1
}

remote_http_openclaw_health_ok() {
  local name="${1:?sandbox}"
  local ns="${OPENSHELL_NAMESPACE:-${E2E_SANDBOX_NS:-nemoclaw-sandboxes}}"
  kubectl exec -n "${ns}" "${name}" -c agent -- bash -c '
    for ns in /run/netns/*; do
      [ -e "$ns" ] || continue
      code="$(nsenter --net="$ns" curl -sS -o /dev/null -w "%{http_code}" --max-time 2 http://127.0.0.1:18789/health 2>/dev/null || true)"
      case "$code" in 200|401) exit 0 ;; esac
    done
    exit 1
  ' >/dev/null 2>&1
}

remote_http_restart_openclaw() {
  local name="${1:?sandbox}"
  local ns="${OPENSHELL_NAMESPACE:-${E2E_SANDBOX_NS:-nemoclaw-sandboxes}}"
  local killer script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  killer="${script_dir}/../files/e2e-stop-openclaw.sh"
  if [[ -f "${killer}" ]]; then
    kubectl cp "${killer}" "${ns}/${name}:/tmp/e2e-stop-openclaw.sh" -c agent >/dev/null 2>&1 || true
    kubectl exec -n "${ns}" "${name}" -c agent -- sh /tmp/e2e-stop-openclaw.sh >/dev/null 2>&1 || true
  fi
  local -a start_envs=(
    --env "NEMOCLAW_MODEL_OVERRIDE=${INFERENCE_MODEL:-llama3.2:3b}"
    --env "NEMOCLAW_MINIMAL_BOOTSTRAP=1"
  )
  if remote_http_web_search_wanted; then
    local provider key_env
    provider="$(remote_http_web_search_provider)" || true
    if [[ -n "${provider}" ]]; then
      key_env="$(remote_http_web_search_key_env "${provider}")"
      start_envs+=(--env "NEMOCLAW_WEB_SEARCH_ENABLED=1")
      start_envs+=(--env "NEMOCLAW_WEB_SEARCH_PROVIDER=${provider}")
      if [[ -n "${!key_env:-}" ]]; then
        start_envs+=(--env "${key_env}=${!key_env}")
      fi
    fi
  fi
  openshell sandbox exec -n "${name}" --no-tty \
    "${start_envs[@]}" -- \
    /usr/local/bin/nemoclaw-start >/dev/null 2>&1 &
  local i
  for ((i = 0; i < 90; i += 1)); do
    if remote_http_openclaw_health_ok "${name}"; then
      return 0
    fi
    sleep 2
  done
  echo "ERROR: ${name} did not come back after enabling Control UI" >&2
  return 1
}

# OpenClaw: one Control UI per user (own host port). CLI uses the same ports.
# This publish path is the remote-host opt-in, so public ports bind 0.0.0.0
# unless E2E_PUBLISH_BIND is set. Inner OpenClaw forwards stay on 127.0.0.1.
# Published HTTP does not include gateway tokens.
remote_http_publish_openclaw() {
  local count="${1:?count}"
  local prefix="${2:?prefix}"
  local out="${3:?json}"
  local host port name token i
  local -a users_json=()
  local restart_ui=0
  export E2E_PUBLISH_BIND="${E2E_PUBLISH_BIND:-0.0.0.0}"
  remote_http_load_optional_secrets
  host="$(remote_http_advertise_host)"
  for ((i = 0; i < count; i += 1)); do
    name="$(printf '%s%04d' "${prefix}" "${i}")"
    port=$((18789 + i))
    restart_ui=0
    remote_http_enable_openclaw_ui "${name}" "http://${host}:${port}" \
      || echo "WARNING: could not enable OpenClaw Control UI on ${name}" >&2
    if ((i == 0)) && remote_http_web_search_wanted; then
      local provider key_env
      provider="$(remote_http_web_search_provider)" || return 1
      key_env="$(remote_http_web_search_key_env "${provider}")"
      if [[ -z "${!key_env:-}" ]]; then
        echo "WARNING: NEMOCLAW_WEB_SEARCH_ENABLED=1 but ${key_env} is empty; web search stays off" >&2
      else
        if [[ "${provider}" == "tavily" ]]; then
          echo "  note: the managed image bundles Brave, not Tavily; tavily may fail to load"
        fi
        remote_http_enable_openclaw_web_search "${name}" "${provider}" "${key_env}" \
          || echo "WARNING: could not enable OpenClaw web search on ${name}" >&2
        restart_ui=1
      fi
    fi
    if ((restart_ui)); then
      remote_http_restart_openclaw "${name}" || return 1
    elif ! remote_http_openclaw_root_ok "${name}" && ! remote_http_openclaw_health_ok "${name}"; then
      remote_http_restart_openclaw "${name}" || return 1
    fi
    token="$(remote_http_openclaw_token "${name}")" \
      || {
        echo "ERROR: could not read OpenClaw token from ${name}" >&2
        return 1
      }
    local inner=$((28789 + i))
    remote_http_start_forward "${name}" 18789 "${inner}" \
      "${out%.json}-forward-${name}.log" "127.0.0.1"
    remote_http_start_ui_shortcut "${port}" "${inner}" "${token}" \
      "${out%.json}-ui-shortcut-${name}.log"
    if ! remote_http_wait_http "http://127.0.0.1:${port}/health"; then
      echo "ERROR: OpenClaw HTTP :${port} for ${name} did not answer /health" >&2
      return 1
    fi
    users_json+=("$(python3 -c '
import json,sys
print(json.dumps({
  "user_id": int(sys.argv[1]),
  "sandbox": sys.argv[2],
  "dashboard_url": sys.argv[3],
  "ui_url": sys.argv[3],
  "cli_url": sys.argv[4],
  "ws_host": sys.argv[5],
  "ws_port": int(sys.argv[6]),
}))
' "${i}" "${name}" "http://${host}:${port}/u/0" \
      "http://${host}:${port}" "${host}" "${port}")")
  done
  mkdir -p "$(dirname "${out}")"
  python3 -c '
import json,sys
host, count, path = sys.argv[1], int(sys.argv[2]), sys.argv[3]
users = [json.loads(line) for line in sys.stdin if line.strip()]
json.dump({"kind": "openclaw", "host": host, "users": users}, open(path, "w"), indent=2)
open(path, "a").write("\n")
' "${host}" "${count}" "${out}" <<<"$(printf '%s\n' "${users_json[@]}")"
  remote_http_serve_discovery "${out}"
}

# Hermes: one dashboard UI (sandbox 0) plus OpenAI HTTP API per user.
remote_http_publish_hermes() {
  local count="${1:?count}"
  local prefix="${2:?prefix}"
  local out="${3:?json}"
  local host dash_port api_port name i
  local -a users_json=()
  export E2E_PUBLISH_BIND="${E2E_PUBLISH_BIND:-0.0.0.0}"
  host="$(remote_http_advertise_host)"
  for ((i = 0; i < count; i += 1)); do
    name="$(printf '%s%04d' "${prefix}" "${i}")"
    dash_port=$((18789 + i))
    api_port=$((8642 + i))
    remote_http_start_forward "${name}" 18789 "${dash_port}" \
      "${out%.json}-ui-${name}.log"
    remote_http_start_forward "${name}" 8642 "${api_port}" \
      "${out%.json}-api-${name}.log"
    remote_http_wait_http "http://127.0.0.1:${dash_port}/" || true
    if ! remote_http_wait_http "http://127.0.0.1:${api_port}/health"; then
      echo "ERROR: Hermes API :${api_port} for ${name} did not answer /health" >&2
      return 1
    fi
    users_json+=("$(python3 -c '
import json,sys
print(json.dumps({
  "user_id": int(sys.argv[1]),
  "sandbox": sys.argv[2],
  "dashboard_url": sys.argv[3],
  "api_url": sys.argv[4],
  "host": sys.argv[5],
  "api_port": int(sys.argv[6]),
}))
' "${i}" "${name}" "http://${host}:${dash_port}/" \
      "http://${host}:${api_port}/v1" "${host}" "${api_port}")")
  done
  mkdir -p "$(dirname "${out}")"
  python3 -c '
import json,sys
host, path = sys.argv[1], sys.argv[2]
users = [json.loads(line) for line in sys.stdin if line.strip()]
json.dump({"kind": "hermes", "host": host, "users": users}, open(path, "w"), indent=2)
open(path, "a").write("\n")
' "${host}" "${out}" <<<"$(printf '%s\n' "${users_json[@]}")"
  remote_http_serve_discovery "${out}"
}

remote_http_stop_e2e_forwards() {
  local port
  echo "Stopping laptop HTTP forwards (dashboard / API)"
  remote_http_stop_discovery
  for port in $(seq 18789 18799); do
    if command -v fuser >/dev/null 2>&1; then
      fuser -k "${port}/tcp" >/dev/null 2>&1 || true
    fi
    remote_http_stop_port "${port}"
  done
  for port in $(seq 28789 28799) $(seq 8642 8652); do
    remote_http_stop_port "${port}"
  done
}
