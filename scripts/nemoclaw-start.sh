#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# NemoClaw sandbox entrypoint. Runs as root (via ENTRYPOINT) to start the
# gateway as the 'gateway' user, then drops to 'sandbox' for agent commands.
#
# SECURITY: The gateway runs as a separate user so the sandboxed agent cannot
# kill it or restart it with a tampered config (CVE: fake-HOME bypass).
# The config hash is verified at startup to detect tampering.
#
# Optional env:
#   NVIDIA_API_KEY   API key for NVIDIA-hosted inference
#   CHAT_UI_URL      Browser origin that will access the forwarded dashboard

set -euo pipefail

# Harden: limit process count to prevent fork bombs (ref: #809)
# Best-effort: some container runtimes (e.g., brev) restrict ulimit
# modification, returning "Invalid argument". Warn but don't block startup.
if ! ulimit -Su 512 2>/dev/null; then
  echo "[SECURITY] Could not set soft nproc limit (container runtime may restrict ulimit)" >&2
fi
if ! ulimit -Hu 512 2>/dev/null; then
  echo "[SECURITY] Could not set hard nproc limit (container runtime may restrict ulimit)" >&2
fi

# SECURITY: Lock down PATH so the agent cannot inject malicious binaries
# into commands executed by the entrypoint or auto-pair watcher.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# ── Drop unnecessary Linux capabilities ──────────────────────────
# CIS Docker Benchmark 5.3: containers should not run with default caps.
# OpenShell manages the container runtime so we cannot pass --cap-drop=ALL
# to docker run. Instead, drop dangerous capabilities from the bounding set
# at startup using capsh. The bounding set limits what caps any child process
# (gateway, sandbox, agent) can ever acquire.
#
# Kept: cap_chown, cap_setuid, cap_setgid, cap_fowner, cap_kill
#   — required by the entrypoint for gosu privilege separation and chown.
# Ref: https://github.com/NVIDIA/NemoClaw/issues/797
if [ "${NEMOCLAW_CAPS_DROPPED:-}" != "1" ] && command -v capsh >/dev/null 2>&1; then
  # capsh --drop requires CAP_SETPCAP in the bounding set. OpenShell's
  # sandbox runtime may strip it, so check before attempting the drop.
  if capsh --has-p=cap_setpcap 2>/dev/null; then
    export NEMOCLAW_CAPS_DROPPED=1
    exec capsh \
      --drop=cap_net_raw,cap_dac_override,cap_sys_chroot,cap_fsetid,cap_setfcap,cap_mknod,cap_audit_write,cap_net_bind_service \
      -- -c 'exec /usr/local/bin/nemoclaw-start "$@"' -- "$@"
  else
    echo "[SECURITY] CAP_SETPCAP not available — runtime already restricts capabilities" >&2
  fi
elif [ "${NEMOCLAW_CAPS_DROPPED:-}" != "1" ]; then
  echo "[SECURITY WARNING] capsh not available — running with default capabilities" >&2
fi

# Filter out self-invocation: openshell sandbox create passes "nemoclaw-start"
# as the command, but since this script is now the ENTRYPOINT, receiving our
# own name as $1 would cause infinite recursion via the NEMOCLAW_CMD exec path.
# Only strip from $1 — later args with this name are legitimate user arguments.
case "${1:-}" in
  nemoclaw-start | /usr/local/bin/nemoclaw-start) shift ;;
esac
NEMOCLAW_CMD=("$@")
CHAT_UI_URL="${CHAT_UI_URL:-http://127.0.0.1:18789}"
PUBLIC_PORT=18789
OPENCLAW="$(command -v openclaw)" # Resolve once, use absolute path everywhere
IMMUTABLE_CONFIG_PATH="/sandbox/.openclaw/openclaw.json"
RUNTIME_CONFIG_DIR="/tmp/nemoclaw"
RUNTIME_CONFIG_PATH="${RUNTIME_CONFIG_DIR}/openclaw.json"
export PERSISTENT_AGENTS_PATH="/sandbox/.nemoclaw/agents-overlay.json"

# ── Config integrity check ──────────────────────────────────────
# The config hash was pinned at build time. If it doesn't match,
# someone (or something) has tampered with the config.

verify_config_integrity() {
  local hash_file="/sandbox/.openclaw/.config-hash"
  if [ ! -f "$hash_file" ]; then
    echo "[SECURITY] Config hash file missing — refusing to start without integrity verification"
    return 1
  fi
  if ! (cd /sandbox/.openclaw && sha256sum -c "$hash_file" --status 2>/dev/null); then
    echo "[SECURITY] openclaw.json integrity check FAILED — config may have been tampered with"
    echo "[SECURITY] Expected hash: $(cat "$hash_file")"
    echo "[SECURITY] Actual hash:   $(sha256sum /sandbox/.openclaw/openclaw.json)"
    return 1
  fi
}

get_active_config_path() {
  printf '%s\n' "${OPENCLAW_CONFIG_PATH:-$IMMUTABLE_CONFIG_PATH}"
}

prepare_runtime_config() {
  mkdir -p "$RUNTIME_CONFIG_DIR"
  chmod 755 "$RUNTIME_CONFIG_DIR"

  python3 - <<'PYRUNTIME'
import json
import os
import re
import shutil

base_path = '/sandbox/.openclaw/openclaw.json'
selection_path = '/sandbox/.nemoclaw/config.json'
runtime_path = '/tmp/nemoclaw/openclaw.json'
overlay_path = '/sandbox/.nemoclaw/agents-overlay.json'


def normalize_string(value):
  if not isinstance(value, str):
    return None
  value = value.strip()
  return value or None


def normalize_path(value):
  value = normalize_string(value)
  if not value or not value.startswith('/sandbox/'):
    return None
  return value


def sanitize_identity(identity):
  if not isinstance(identity, dict):
    return None
  sanitized = {}
  for key in ('name', 'theme', 'emoji', 'avatar'):
    value = normalize_string(identity.get(key))
    if value:
      sanitized[key] = value
  return sanitized or None


def sanitize_agent_entry(agent):
  if not isinstance(agent, dict):
    return None

  agent_id = normalize_string(agent.get('id'))
  if not agent_id or not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', agent_id):
    return None

  workspace = normalize_path(agent.get('workspace'))
  agent_dir = normalize_path(agent.get('agentDir'))
  if not workspace and not agent_dir:
    return None

  sanitized = {'id': agent_id}
  for key in ('name', 'model'):
    value = normalize_string(agent.get(key))
    if value:
      sanitized[key] = value

  if workspace:
    sanitized['workspace'] = workspace
  if agent_dir:
    sanitized['agentDir'] = agent_dir
  if isinstance(agent.get('default'), bool):
    sanitized['default'] = agent['default']

  identity = sanitize_identity(agent.get('identity'))
  if identity:
    sanitized['identity'] = identity

  return sanitized


def merge_agent_lists(base_agents, overlay_agents):
  merged = []
  positions = {}

  for source in (base_agents, overlay_agents):
    for raw_agent in source:
      agent = sanitize_agent_entry(raw_agent)
      if not agent:
        continue
      agent_id = agent['id']
      if agent_id in positions:
        merged[positions[agent_id]] = agent
        continue
      positions[agent_id] = len(merged)
      merged.append(agent)

  return merged

os.makedirs(os.path.dirname(runtime_path), exist_ok=True)
shutil.copyfile(base_path, runtime_path)

with open(runtime_path) as f:
  cfg = json.load(f)

if os.path.exists(selection_path):
    with open(selection_path) as f:
        selection = json.load(f)

    model = str(selection.get('model') or '').strip()
    endpoint_url = str(selection.get('endpointUrl') or '').strip()
    context_window = selection.get('contextWindow')
    max_tokens = selection.get('maxTokens')

    if model and endpoint_url:
        providers_cfg = cfg.setdefault('models', {}).setdefault('providers', {})
        cfg.setdefault('models', {}).setdefault('mode', 'merge')
        cfg.setdefault('agents', {}).setdefault('defaults', {}).setdefault('model', {})['primary'] = f'inference/{model}'
        providers_cfg['inference'] = {
            'baseUrl': endpoint_url,
            'apiKey': 'unused',
            'api': 'openai-completions',
            'models': [{
                'id': model,
                'name': model,
                'reasoning': False,
                'input': ['text'],
                'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0},
                'contextWindow': context_window if isinstance(context_window, int) and context_window > 0 else 131072,
                'maxTokens': max_tokens if isinstance(max_tokens, int) and max_tokens > 0 else 4096,
            }],
        }

        if os.path.exists(overlay_path):
          with open(overlay_path) as f:
            overlay = json.load(f)
          overlay_agents = []
          if isinstance(overlay, dict):
            overlay_agents = ((overlay.get('agents') or {}).get('list') or [])
          cfg_agents = cfg.setdefault('agents', {})
          existing_agents = cfg_agents.get('list') or []
          cfg_agents['list'] = merge_agent_lists(existing_agents, overlay_agents)

        with open(runtime_path, 'w') as f:
          json.dump(cfg, f, indent=2)

os.chmod(runtime_path, 0o644)
PYRUNTIME

  export OPENCLAW_CONFIG_PATH="$RUNTIME_CONFIG_PATH"
}

write_auth_profile() {
  if [ -z "${NVIDIA_API_KEY:-}" ]; then
    return
  fi

  python3 - <<'PYAUTH'
import json
import os
path = os.path.expanduser('~/.openclaw/agents/main/agent/auth-profiles.json')
os.makedirs(os.path.dirname(path), exist_ok=True)
json.dump({
    'nvidia:manual': {
        'type': 'api_key',
        'provider': 'nvidia',
        'keyRef': {'source': 'env', 'id': 'NVIDIA_API_KEY'},
        'profileId': 'nvidia:manual',
    }
}, open(path, 'w'))
os.chmod(path, 0o600)
PYAUTH
}

print_dashboard_urls() {
  local token chat_ui_base local_url remote_url
  local config_path
  config_path="$(get_active_config_path)"
  export config_path

  token="$(
    python3 - <<'PYTOKEN'
import json
import os
path = os.environ.get('OPENCLAW_CONFIG_PATH', '/sandbox/.openclaw/openclaw.json')
try:
    cfg = json.load(open(path))
except Exception:
    print('')
else:
    print(cfg.get('gateway', {}).get('auth', {}).get('token', ''))
PYTOKEN
  )"

  chat_ui_base="${CHAT_UI_URL%/}"
  local_url="http://127.0.0.1:${PUBLIC_PORT}/"
  remote_url="${chat_ui_base}/"
  if [ -n "$token" ]; then
    local_url="${local_url}#token=${token}"
    remote_url="${remote_url}#token=${token}"
  fi

  echo "[gateway] Local UI: ${local_url}"
  echo "[gateway] Remote UI: ${remote_url}"
}

start_auto_pair() {
  # Run auto-pair as sandbox user (it talks to the gateway via CLI)
  # SECURITY: Pass resolved openclaw path to prevent PATH hijacking
  # When running as non-root, skip gosu (we're already the sandbox user)
  local run_prefix=()
  if [ "$(id -u)" -eq 0 ]; then
    run_prefix=(gosu sandbox)
  fi
  OPENCLAW_BIN="$OPENCLAW" nohup "${run_prefix[@]}" python3 - <<'PYAUTOPAIR' >>/tmp/auto-pair.log 2>&1 &
import json
import os
import subprocess
import time

OPENCLAW = os.environ.get('OPENCLAW_BIN', 'openclaw')
DEADLINE = time.time() + 600
QUIET_POLLS = 0
APPROVED = 0

def run(*args):
    proc = subprocess.run(args, capture_output=True, text=True)
    return proc.returncode, proc.stdout.strip(), proc.stderr.strip()

while time.time() < DEADLINE:
    rc, out, err = run(OPENCLAW, 'devices', 'list', '--json')
    if rc != 0 or not out:
        time.sleep(1)
        continue
    try:
        data = json.loads(out)
    except Exception:
        time.sleep(1)
        continue

    pending = data.get('pending') or []
    paired = data.get('paired') or []
    has_browser = any((d.get('clientId') == 'openclaw-control-ui') or (d.get('clientMode') == 'webchat') for d in paired if isinstance(d, dict))

    if pending:
        QUIET_POLLS = 0
        for device in pending:
            request_id = (device or {}).get('requestId')
            if not request_id:
                continue
            arc, aout, aerr = run(OPENCLAW, 'devices', 'approve', request_id, '--json')
            if arc == 0:
                APPROVED += 1
                print(f'[auto-pair] approved request={request_id}')
            elif aout or aerr:
                print(f'[auto-pair] approve failed request={request_id}: {(aerr or aout)[:400]}')
        time.sleep(1)
        continue

    if has_browser:
        QUIET_POLLS += 1
        if QUIET_POLLS >= 4:
            print(f'[auto-pair] browser pairing converged approvals={APPROVED}')
            break
    elif APPROVED > 0:
        QUIET_POLLS += 1
    else:
        QUIET_POLLS = 0

    time.sleep(1)
else:
    print(f'[auto-pair] watcher timed out approvals={APPROVED}')
PYAUTOPAIR
  echo "[gateway] auto-pair watcher launched (pid $!)"
}

ensure_agent_dirs() {
  python3 - <<'PYAGENTDIRS'
import json
import os

config_path = os.environ.get('OPENCLAW_CONFIG_PATH') or os.path.join(os.environ.get('HOME', '/sandbox'), '.openclaw', 'openclaw.json')
if not os.path.exists(config_path):
    exit(0)

with open(config_path) as f:
    cfg = json.load(f)

agents = cfg.get('agents', {})
agent_list = agents.get('list', [])
for agent in agent_list:
    if not isinstance(agent, dict):
        continue
    for key in ('workspace', 'agentDir'):
        dir_path = agent.get(key, '')
        if isinstance(dir_path, str) and dir_path.strip():
            os.makedirs(dir_path.strip(), exist_ok=True)
PYAGENTDIRS
}

ensure_agent_webchat_sessions() {
  python3 - <<'PYSESSIONS'
import json
import os
import uuid

home = os.environ.get('HOME', '/sandbox')
config_path = os.environ.get('OPENCLAW_CONFIG_PATH') or os.path.join(home, '.openclaw', 'openclaw.json')
if not os.path.exists(config_path):
    exit(0)

with open(config_path) as f:
    cfg = json.load(f)

agents = cfg.get('agents', {})
agent_list = agents.get('list', [])
for agent in agent_list:
    if not isinstance(agent, dict) or not agent.get('id'):
        continue
    agent_id = agent['id']
    sessions_dir = os.path.join(home, '.openclaw', 'agents', agent_id, 'sessions')
    os.makedirs(sessions_dir, exist_ok=True)
    store_path = os.path.join(sessions_dir, 'sessions.json')
    store = {}
    if os.path.exists(store_path):
        with open(store_path) as f:
            store = json.load(f)
    session_key = f'agent:{agent_id}:main'
    entry = store.get(session_key, {})
    if entry.get('lastChannel') == 'webchat':
        continue
    entry.setdefault('sessionId', f'init-{agent_id}')
    entry['chatType'] = 'direct'
    entry['deliveryContext'] = {'channel': 'webchat'}
    entry['lastChannel'] = 'webchat'
    entry['origin'] = {'provider': 'webchat', 'surface': 'webchat', 'chatType': 'direct'}
    store[session_key] = entry
    with open(store_path, 'w') as f:
        json.dump(store, f)
    os.chmod(store_path, 0o600)
PYSESSIONS
}

# Legacy hook: some onboarding paths still call fix_openclaw_config before
# starting the gateway. Keep this as a safe no-op so startup does not abort
# when the image uses immutable /sandbox/.openclaw/openclaw.json.
fix_openclaw_config() {
  return 0
}

# NO_PROXY is limited to 127.0.0.1,localhost,::1 — missing the gateway IP.
# The gateway IP itself must bypass the proxy to avoid proxy loops.
#
# Do NOT add inference.local here. OpenShell intentionally routes that hostname
# through the proxy path; bypassing the proxy forces a direct DNS lookup inside
# the sandbox, which breaks inference.local resolution.
#
# NEMOCLAW_PROXY_HOST / NEMOCLAW_PROXY_PORT can be overridden at sandbox
# creation time if the gateway IP or port changes in a future OpenShell release.
# Ref: https://github.com/NVIDIA/NemoClaw/issues/626
PROXY_HOST="${NEMOCLAW_PROXY_HOST:-10.200.0.1}"
PROXY_PORT="${NEMOCLAW_PROXY_PORT:-3128}"
_PROXY_URL="http://${PROXY_HOST}:${PROXY_PORT}"
_NO_PROXY_VAL="localhost,127.0.0.1,::1,${PROXY_HOST}"
export HTTP_PROXY="$_PROXY_URL"
export HTTPS_PROXY="$_PROXY_URL"
export NO_PROXY="$_NO_PROXY_VAL"
export http_proxy="$_PROXY_URL"
export https_proxy="$_PROXY_URL"
export no_proxy="$_NO_PROXY_VAL"

# OpenShell re-injects narrow NO_PROXY/no_proxy=127.0.0.1,localhost,::1 every
# time a user connects via `openshell sandbox connect`.  The connect path spawns
# `/bin/bash -i` (interactive, non-login), which sources ~/.bashrc — NOT
# ~/.profile or /etc/profile.d/*.  Write the full proxy config to ~/.bashrc so
# interactive sessions see the correct values.
#
# Both uppercase and lowercase variants are required: Node.js undici prefers
# lowercase (no_proxy) over uppercase (NO_PROXY) when both are set.
# curl/wget use uppercase.  gRPC C-core uses lowercase.
#
# Also write to ~/.profile for login-shell paths (e.g. `sandbox create -- cmd`
# which spawns `bash -lc`).
#
# Idempotency: begin/end markers delimit the block so it can be replaced
# on restart if NEMOCLAW_PROXY_HOST/PORT change, without duplicating.
_PROXY_MARKER_BEGIN="# nemoclaw-proxy-config begin"
_PROXY_MARKER_END="# nemoclaw-proxy-config end"
_PROXY_SNIPPET="${_PROXY_MARKER_BEGIN}
export HTTP_PROXY=\"$_PROXY_URL\"
export HTTPS_PROXY=\"$_PROXY_URL\"
export NO_PROXY=\"$_NO_PROXY_VAL\"
export http_proxy=\"$_PROXY_URL\"
export https_proxy=\"$_PROXY_URL\"
export no_proxy=\"$_NO_PROXY_VAL\"
${_PROXY_MARKER_END}"

if [ "$(id -u)" -eq 0 ]; then
  _SANDBOX_HOME=$(getent passwd sandbox 2>/dev/null | cut -d: -f6)
  _SANDBOX_HOME="${_SANDBOX_HOME:-/sandbox}"
else
  _SANDBOX_HOME="${HOME:-/sandbox}"
fi

_write_proxy_snippet() {
  local target="$1"
  if [ -f "$target" ] && grep -qF "$_PROXY_MARKER_BEGIN" "$target" 2>/dev/null; then
    local tmp
    tmp="$(mktemp)"
    awk -v b="$_PROXY_MARKER_BEGIN" -v e="$_PROXY_MARKER_END" \
      '$0==b{s=1;next} $0==e{s=0;next} !s' "$target" >"$tmp"
    printf '%s\n' "$_PROXY_SNIPPET" >>"$tmp"
    cat "$tmp" >"$target"
    rm -f "$tmp"
    return 0
  fi
  printf '\n%s\n' "$_PROXY_SNIPPET" >>"$target"
}

if [ -w "$_SANDBOX_HOME" ]; then
  _write_proxy_snippet "${_SANDBOX_HOME}/.bashrc"
  _write_proxy_snippet "${_SANDBOX_HOME}/.profile"
fi

# ── Main ─────────────────────────────────────────────────────────

echo 'Setting up NemoClaw...'
[ -f .env ] && chmod 600 .env
openclaw doctor --fix >/dev/null 2>&1 || true
export CHAT_UI_URL PUBLIC_PORT
prepare_runtime_config
fix_openclaw_config
ensure_agent_dirs
ensure_agent_webchat_sessions
openclaw plugins install /opt/nemoclaw >/dev/null 2>&1 || true

# ── Non-root fallback ──────────────────────────────────────────
# OpenShell runs containers with --security-opt=no-new-privileges, which
# blocks gosu's setuid syscall. When we're not root, skip privilege
# separation and run everything as the current user (sandbox).
# Gateway process isolation is not available in this mode.
if [ "$(id -u)" -ne 0 ]; then
  echo "[gateway] Running as non-root (uid=$(id -u)) — privilege separation disabled"
  export HOME=/sandbox
  if ! verify_config_integrity; then
    echo "[SECURITY WARNING] Config integrity check failed — proceeding anyway (non-root mode)"
  fi
  write_auth_profile

  if [ ${#NEMOCLAW_CMD[@]} -gt 0 ]; then
    exec "${NEMOCLAW_CMD[@]}"
  fi

  # In non-root mode, detach gateway stdout/stderr from the sandbox-create
  # stream so openshell sandbox create can return once the container is ready.
  touch /tmp/gateway.log
  chmod 600 /tmp/gateway.log

  # Separate log for auto-pair in non-root mode as well.
  touch /tmp/auto-pair.log
  chmod 600 /tmp/auto-pair.log

  # Start gateway in background, auto-pair, then wait
  nohup "$OPENCLAW" gateway run >/tmp/gateway.log 2>&1 &
  GATEWAY_PID=$!
  echo "[gateway] openclaw gateway launched (pid $GATEWAY_PID)"
  start_auto_pair
  print_dashboard_urls
  wait "$GATEWAY_PID"
  exit $?
fi

# ── Root path (full privilege separation via gosu) ─────────────

# Verify config integrity before starting anything
verify_config_integrity

# Write auth profile as sandbox user (needs writable .openclaw-data)
gosu sandbox bash -c "$(declare -f write_auth_profile); write_auth_profile"

# If a command was passed (e.g., "openclaw agent ..."), run it as sandbox user
if [ ${#NEMOCLAW_CMD[@]} -gt 0 ]; then
  exec gosu sandbox "${NEMOCLAW_CMD[@]}"
fi

# SECURITY: Protect gateway log from sandbox user tampering
touch /tmp/gateway.log
chown gateway:gateway /tmp/gateway.log
chmod 600 /tmp/gateway.log

# Separate log for auto-pair so sandbox user can write to it
touch /tmp/auto-pair.log
chown sandbox:sandbox /tmp/auto-pair.log
chmod 600 /tmp/auto-pair.log

# Verify ALL symlinks in .openclaw point to expected .openclaw-data targets.
# Dynamic scan so future OpenClaw symlinks are covered automatically.
for entry in /sandbox/.openclaw/*; do
  [ -L "$entry" ] || continue
  name="$(basename "$entry")"
  target="$(readlink -f "$entry" 2>/dev/null || true)"
  expected="/sandbox/.openclaw-data/$name"
  if [ "$target" != "$expected" ]; then
    echo "[SECURITY] Symlink $entry points to unexpected target: $target (expected $expected)"
    exit 1
  fi
done

# Start the gateway as the 'gateway' user.
# SECURITY: The sandbox user cannot kill this process because it runs
# under a different UID. The fake-HOME attack no longer works because
# the agent cannot restart the gateway with a tampered config.
nohup gosu gateway env OPENCLAW_CONFIG_PATH="$OPENCLAW_CONFIG_PATH" "$OPENCLAW" gateway run >/tmp/gateway.log 2>&1 &
GATEWAY_PID=$!
echo "[gateway] openclaw gateway launched as 'gateway' user (pid $GATEWAY_PID)"

start_auto_pair
print_dashboard_urls

# Keep container running by waiting on the gateway process.
# This script is PID 1 (ENTRYPOINT); if it exits, Docker kills all children.
wait "$GATEWAY_PID"
