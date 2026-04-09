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
#   NVIDIA_API_KEY                API key for NVIDIA-hosted inference
#   CHAT_UI_URL                   Browser origin that will access the forwarded dashboard
#   NEMOCLAW_DISABLE_DEVICE_AUTH  Build-time only. Set to "1" to skip device-pairing auth
#                                 (development/headless). Has no runtime effect — openclaw.json
#                                 is baked at image build and verified by hash at startup.

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

# Redirect tool caches and state to /tmp so they don't fail on the read-only
# /sandbox home directory (#804). Without these, tools would try to create
# dotfiles (~/.npm, ~/.cache, ~/.bash_history, ~/.gitconfig, ~/.local, ~/.claude)
# in the Landlock read-only home and fail.
#
# IMPORTANT: This array is the single source of truth for tool-cache redirects.
# The same entries are emitted into /tmp/nemoclaw-proxy-env.sh (see below) so
# that `openshell sandbox connect` sessions also pick up the redirects.
_TOOL_REDIRECTS=(
  'npm_config_cache=/tmp/.npm-cache'
  'XDG_CACHE_HOME=/tmp/.cache'
  'XDG_CONFIG_HOME=/tmp/.config'
  'XDG_DATA_HOME=/tmp/.local/share'
  'XDG_STATE_HOME=/tmp/.local/state'
  'XDG_RUNTIME_DIR=/tmp/.runtime'
  'NODE_REPL_HISTORY=/tmp/.node_repl_history'
  'HISTFILE=/tmp/.bash_history'
  'GIT_CONFIG_GLOBAL=/tmp/.gitconfig'
  'GNUPGHOME=/tmp/.gnupg'
  'PYTHONUSERBASE=/tmp/.local'
  'PYTHONHISTFILE=/tmp/.python_history'
  'CLAUDE_CONFIG_DIR=/tmp/.claude'
  'npm_config_prefix=/tmp/npm-global'
)
for _redir in "${_TOOL_REDIRECTS[@]}"; do
  export "${_redir?}"
done

# Pre-create redirected directories to prevent ownership conflicts.
# In root mode: the gateway starts first (as gateway user) and inherits these
# env vars — if it creates a dir first, it would be gateway:gateway 755 and
# the sandbox user couldn't write subdirs later. Creating them as root with
# explicit sandbox ownership ensures the sandbox user always has write access.
# In non-root mode: we're already the sandbox user, so mkdir -p is sufficient —
# directories are owned by us automatically. Using install -o would fail with
# EPERM because only root can chown. Ref: #804
if [ "$(id -u)" -eq 0 ]; then
  install -d -o sandbox -g sandbox -m 755 \
    /tmp/.npm-cache /tmp/.cache /tmp/.config /tmp/.local/share \
    /tmp/.local/state /tmp/.runtime /tmp/.gnupg /tmp/.claude \
    /tmp/npm-global
else
  mkdir -p /tmp/.npm-cache /tmp/.cache /tmp/.config /tmp/.local/share \
    /tmp/.local/state /tmp/.runtime /tmp/.gnupg /tmp/.claude \
    /tmp/npm-global
fi

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

# Normalize the sandbox-create bootstrap wrapper. Onboard launches the
# container as `env CHAT_UI_URL=... nemoclaw-start`, but this script is already
# the ENTRYPOINT. If we treat that wrapper as a real command, the root path will
# try `gosu sandbox env ... nemoclaw-start`, which fails on Spark/arm64 when
# no-new-privileges blocks gosu. Consume only the self-wrapper form and promote
# the env assignments into the current process.
if [ "${1:-}" = "env" ]; then
  _raw_args=("$@")
  _self_wrapper_index=""
  for ((i = 1; i < ${#_raw_args[@]}; i += 1)); do
    case "${_raw_args[$i]}" in
      *=*) ;;
      nemoclaw-start | /usr/local/bin/nemoclaw-start)
        _self_wrapper_index="$i"
        break
        ;;
      *)
        break
        ;;
    esac
  done
  if [ -n "$_self_wrapper_index" ]; then
    for ((i = 1; i < _self_wrapper_index; i += 1)); do
      export "${_raw_args[$i]}"
    done
    set -- "${_raw_args[@]:$((_self_wrapper_index + 1))}"
  fi
fi

# Filter out direct self-invocation too. Since this script is the ENTRYPOINT,
# receiving our own name as $1 would otherwise recurse via the NEMOCLAW_CMD
# exec path. Only strip from $1 — later args with this name are legitimate.
case "${1:-}" in
  nemoclaw-start | /usr/local/bin/nemoclaw-start) shift ;;
esac
NEMOCLAW_CMD=("$@")
CHAT_UI_URL="${CHAT_UI_URL:-http://127.0.0.1:18789}"
PUBLIC_PORT=18789
OPENCLAW="$(command -v openclaw)" # Resolve once, use absolute path everywhere
_SANDBOX_HOME="/sandbox"          # Home dir for the sandbox user (useradd -d /sandbox in Dockerfile.base)

# ── Config integrity check ──────────────────────────────────────
# The config hash was pinned at build time. If it doesn't match,
# someone (or something) has tampered with the config.

verify_config_integrity() {
  local hash_file="/sandbox/.openclaw/.config-hash"
  if [ ! -f "$hash_file" ]; then
    echo "[SECURITY] Config hash file missing — refusing to start without integrity verification" >&2
    return 1
  fi
  if ! (cd /sandbox/.openclaw && sha256sum -c "$hash_file" --status 2>/dev/null); then
    echo "[SECURITY] openclaw.json integrity check FAILED — config may have been tampered with" >&2
    echo "[SECURITY] Expected hash: $(cat "$hash_file")" >&2
    echo "[SECURITY] Actual hash:   $(sha256sum /sandbox/.openclaw/openclaw.json)" >&2
    return 1
  fi
}

_read_gateway_token() {
  python3 - <<'PYTOKEN'
import json
try:
    with open('/sandbox/.openclaw/openclaw.json') as f:
        cfg = json.load(f)
    print(cfg.get('gateway', {}).get('auth', {}).get('token', ''))
except Exception:
    print('')
PYTOKEN
}

export_gateway_token() {
  local token
  token="$(_read_gateway_token)"
  local marker_begin="# nemoclaw-gateway-token begin"
  local marker_end="# nemoclaw-gateway-token end"

  if [ -z "$token" ]; then
    # Remove any stale marker blocks from rc files so revoked/old tokens
    # are not re-exported in later interactive sessions.
    unset OPENCLAW_GATEWAY_TOKEN
    for rc_file in "${_SANDBOX_HOME}/.bashrc" "${_SANDBOX_HOME}/.profile"; do
      if [ -f "$rc_file" ] && grep -qF "$marker_begin" "$rc_file" 2>/dev/null; then
        local tmp
        tmp="$(mktemp)"
        awk -v b="$marker_begin" -v e="$marker_end" \
          '$0==b{s=1;next} $0==e{s=0;next} !s' "$rc_file" >"$tmp"
        cat "$tmp" >"$rc_file"
        rm -f "$tmp"
      fi
    done
    return
  fi
  export OPENCLAW_GATEWAY_TOKEN="$token"

  # Persist to .bashrc/.profile so interactive sessions (openshell sandbox
  # connect) also see the token — same pattern as the proxy config above.
  # Shell-escape the token so quotes/dollars/backticks cannot break the
  # sourced snippet or allow code injection.
  local escaped_token
  escaped_token="$(printf '%s' "$token" | sed "s/'/'\\\\''/g")"
  local snippet
  snippet="${marker_begin}
export OPENCLAW_GATEWAY_TOKEN='${escaped_token}'
${marker_end}"

  for rc_file in "${_SANDBOX_HOME}/.bashrc" "${_SANDBOX_HOME}/.profile"; do
    if [ -f "$rc_file" ] && grep -qF "$marker_begin" "$rc_file" 2>/dev/null; then
      local tmp
      tmp="$(mktemp)"
      awk -v b="$marker_begin" -v e="$marker_end" \
        '$0==b{s=1;next} $0==e{s=0;next} !s' "$rc_file" >"$tmp"
      printf '%s\n' "$snippet" >>"$tmp"
      cat "$tmp" >"$rc_file"
      rm -f "$tmp"
    elif [ -w "$rc_file" ] || [ -w "$(dirname "$rc_file")" ]; then
      printf '\n%s\n' "$snippet" >>"$rc_file"
    fi
  done
}

install_configure_guard() {
  # Installs a shell function that intercepts `openclaw configure` inside the
  # sandbox. The config is Landlock read-only — atomic writes to
  # /sandbox/.openclaw/ fail with EACCES. Instead of a cryptic error, guide
  # the user to the correct host-side workflow.
  local marker_begin="# nemoclaw-configure-guard begin"
  local marker_end="# nemoclaw-configure-guard end"
  local snippet
  read -r -d '' snippet <<'GUARD' || true
# nemoclaw-configure-guard begin
openclaw() {
  case "$1" in
    configure)
      echo "Error: 'openclaw configure' cannot modify config inside the sandbox." >&2
      echo "The sandbox config is read-only (Landlock enforced) for security." >&2
      echo "" >&2
      echo "To change your configuration, exit the sandbox and run:" >&2
      echo "  nemoclaw onboard --resume" >&2
      echo "" >&2
      echo "This rebuilds the sandbox with your updated settings." >&2
      return 1
      ;;
  esac
  command openclaw "$@"
}
# nemoclaw-configure-guard end
GUARD

  for rc_file in "${_SANDBOX_HOME}/.bashrc" "${_SANDBOX_HOME}/.profile"; do
    if [ -f "$rc_file" ] && grep -qF "$marker_begin" "$rc_file" 2>/dev/null; then
      local tmp
      tmp="$(mktemp)"
      awk -v b="$marker_begin" -v e="$marker_end" \
        '$0==b{s=1;next} $0==e{s=0;next} !s' "$rc_file" >"$tmp"
      printf '%s\n' "$snippet" >>"$tmp"
      cat "$tmp" >"$rc_file"
      rm -f "$tmp"
    elif [ -w "$rc_file" ] || [ -w "$(dirname "$rc_file")" ]; then
      printf '\n%s\n' "$snippet" >>"$rc_file"
    fi
  done
}

validate_openclaw_symlinks() {
  local entry name target expected
  for entry in /sandbox/.openclaw/*; do
    [ -L "$entry" ] || continue
    name="$(basename "$entry")"
    target="$(readlink -f "$entry" 2>/dev/null || true)"
    expected="/sandbox/.openclaw-data/$name"
    if [ "$target" != "$expected" ]; then
      echo "[SECURITY] Symlink $entry points to unexpected target: $target (expected $expected)" >&2
      return 1
    fi
  done
}

harden_openclaw_symlinks() {
  local entry hardened failed
  hardened=0
  failed=0

  if ! command -v chattr >/dev/null 2>&1; then
    echo "[SECURITY] chattr not available — relying on DAC + Landlock for .openclaw hardening" >&2
    return 0
  fi

  if chattr +i /sandbox/.openclaw 2>/dev/null; then
    hardened=$((hardened + 1))
  else
    failed=$((failed + 1))
  fi

  for entry in /sandbox/.openclaw/*; do
    [ -L "$entry" ] || continue
    if chattr +i "$entry" 2>/dev/null; then
      hardened=$((hardened + 1))
    else
      failed=$((failed + 1))
    fi
  done

  if [ "$failed" -gt 0 ]; then
    echo "[SECURITY] Immutable hardening applied to $hardened path(s); $failed path(s) could not be hardened — continuing with DAC + Landlock" >&2
  elif [ "$hardened" -gt 0 ]; then
    echo "[SECURITY] Immutable hardening applied to /sandbox/.openclaw and validated symlinks" >&2
  fi
}

# Write an auth profile JSON for the NVIDIA API key so the gateway can authenticate.
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

configure_messaging_channels() {
  # Channel entries are baked into openclaw.json at image build time via
  # NEMOCLAW_MESSAGING_CHANNELS_B64 (see Dockerfile). Placeholder tokens
  # (openshell:resolve:env:*) flow through to API calls where the L7 proxy
  # rewrites them with real secrets at egress. Real tokens are never visible
  # inside the sandbox.
  #
  # Runtime patching of /sandbox/.openclaw/openclaw.json is not possible:
  # Landlock enforces read-only on /sandbox/.openclaw/ at the kernel level,
  # regardless of DAC (file ownership/chmod). Writes fail with EPERM.
  [ -n "${TELEGRAM_BOT_TOKEN:-}" ] || [ -n "${DISCORD_BOT_TOKEN:-}" ] || [ -n "${SLACK_BOT_TOKEN:-}" ] || return 0

  echo "[channels] Messaging channels active (baked at build time):" >&2
  [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && echo "[channels]   telegram (native)" >&2
  [ -n "${DISCORD_BOT_TOKEN:-}" ] && echo "[channels]   discord (native)" >&2
  [ -n "${SLACK_BOT_TOKEN:-}" ] && echo "[channels]   slack (native)" >&2
  return 0
}

# Print the local and remote dashboard URLs, appending the auth token if available.
print_dashboard_urls() {
  local token chat_ui_base local_url remote_url

  token="$(_read_gateway_token)"

  chat_ui_base="${CHAT_UI_URL%/}"
  local_url="http://127.0.0.1:${PUBLIC_PORT}/"
  remote_url="${chat_ui_base}/"
  if [ -n "$token" ]; then
    local_url="${local_url}#token=${token}"
    remote_url="${remote_url}#token=${token}"
  fi

  echo "[gateway] Local UI: ${local_url}" >&2
  echo "[gateway] Remote UI: ${remote_url}" >&2
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
HANDLED = set()  # Track rejected/approved requestIds to avoid reprocessing
# SECURITY NOTE: clientId/clientMode are client-supplied and spoofable
# (the gateway stores connectParams.client.id verbatim). This allowlist
# is defense-in-depth, not a trust boundary. PR #690 adds one-shot exit,
# timeout reduction, and token cleanup for a more comprehensive fix.
ALLOWED_CLIENTS = {'openclaw-control-ui'}
ALLOWED_MODES = {'webchat', 'cli'}

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
            if not isinstance(device, dict):
                continue
            request_id = device.get('requestId')
            if not request_id or request_id in HANDLED:
                continue
            client_id = device.get('clientId', '')
            client_mode = device.get('clientMode', '')
            if client_id not in ALLOWED_CLIENTS and client_mode not in ALLOWED_MODES:
                HANDLED.add(request_id)
                print(f'[auto-pair] rejected unknown client={client_id} mode={client_mode}')
                continue
            arc, aout, aerr = run(OPENCLAW, 'devices', 'approve', request_id, '--json')
            HANDLED.add(request_id)
            if arc == 0:
                APPROVED += 1
                print(f'[auto-pair] approved request={request_id} client={client_id}')
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
  AUTO_PAIR_PID=$!
  echo "[gateway] auto-pair watcher launched (pid $AUTO_PAIR_PID)" >&2
}

# ── Proxy environment ────────────────────────────────────────────
# OpenShell injects HTTP_PROXY/HTTPS_PROXY/NO_PROXY into the sandbox, but its
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
# ~/.profile or /etc/profile.d/*.
#
# The /sandbox home directory is Landlock read-only (#804), so we write the proxy
# config to /tmp/nemoclaw-proxy-env.sh. The pre-built .bashrc and .profile
# source this file automatically.
#
# SECURITY: /tmp has the sticky bit, so when running as root the sandbox user
# cannot delete or replace this root-owned file. In non-root mode privilege
# separation is already disabled, so this is an accepted limitation.
#
# Both uppercase and lowercase variants are required: Node.js undici prefers
# lowercase (no_proxy) over uppercase (NO_PROXY) when both are set.
# curl/wget use uppercase.  gRPC C-core uses lowercase.
_PROXY_ENV_FILE="/tmp/nemoclaw-proxy-env.sh"
# Remove any pre-existing file/symlink to prevent symlink-following attacks,
# then write a fresh file.
rm -f "$_PROXY_ENV_FILE" 2>/dev/null || true
{
  cat <<PROXYEOF
# Proxy configuration (overrides narrow OpenShell defaults on connect)
export HTTP_PROXY="$_PROXY_URL"
export HTTPS_PROXY="$_PROXY_URL"
export NO_PROXY="$_NO_PROXY_VAL"
export http_proxy="$_PROXY_URL"
export https_proxy="$_PROXY_URL"
export no_proxy="$_NO_PROXY_VAL"
PROXYEOF
  # Tool cache redirects — generated from _TOOL_REDIRECTS (single source of truth)
  echo '# Tool cache redirects — /sandbox is Landlock read-only (#804)'
  for _redir in "${_TOOL_REDIRECTS[@]}"; do
    echo "export ${_redir?}"
  done
} >"$_PROXY_ENV_FILE"
chmod 644 "$_PROXY_ENV_FILE"

# Forward SIGTERM/SIGINT to child processes for graceful shutdown.
# This script is PID 1 — without a trap, signals interrupt wait and
# children are orphaned until Docker sends SIGKILL after the grace period.
cleanup() {
  echo "[gateway] received signal, forwarding to children..." >&2
  local gateway_status=0
  kill -TERM "$GATEWAY_PID" 2>/dev/null || true
  if [ -n "${AUTO_PAIR_PID:-}" ]; then
    kill -TERM "$AUTO_PAIR_PID" 2>/dev/null || true
  fi
  wait "$GATEWAY_PID" 2>/dev/null || gateway_status=$?
  if [ -n "${AUTO_PAIR_PID:-}" ]; then
    wait "$AUTO_PAIR_PID" 2>/dev/null || true
  fi
  exit "$gateway_status"
}
# ── Main ─────────────────────────────────────────────────────────

echo 'Setting up NemoClaw...' >&2
# Best-effort: .env may not exist, and /sandbox is Landlock read-only (#804).
if [ -f .env ]; then
  if ! chmod 600 .env 2>/dev/null; then
    echo "[SECURITY WARNING] Could not restrict .env permissions — file may be world-readable (read-only filesystem)" >&2
  fi
fi

# ── Non-root fallback ──────────────────────────────────────────
# OpenShell runs containers with --security-opt=no-new-privileges, which
# blocks gosu's setuid syscall. When we're not root, skip privilege
# separation and run everything as the current user (sandbox).
# Gateway process isolation is not available in this mode.
if [ "$(id -u)" -ne 0 ]; then
  echo "[gateway] Running as non-root (uid=$(id -u)) — privilege separation disabled" >&2
  export HOME=/sandbox
  if ! verify_config_integrity; then
    echo "[SECURITY] Config integrity check failed — refusing to start (non-root mode)" >&2
    exit 1
  fi
  export_gateway_token
  install_configure_guard
  configure_messaging_channels
  validate_openclaw_symlinks

  # Ensure writable state directories exist and are owned by the current user.
  # The Docker build (Dockerfile) sets this up correctly, but the native curl
  # installer may create these directories as root, causing EACCES when openclaw
  # tries to write device-auth.json or other state files.  Ref: #692
  # Ensure the identity symlink points from .openclaw/identity → .openclaw-data/identity.
  # Uses early returns to keep each case flat.
  ensure_identity_symlink() {
    local data_dir="$1" openclaw_dir="$2"
    local link_path="${openclaw_dir}/identity"
    local target="${data_dir}/identity"
    [ -d "$target" ] || return 0
    mkdir -p "${openclaw_dir}" 2>/dev/null || true

    # Already a correct symlink — nothing to do.
    if [ -L "$link_path" ]; then
      local current expected
      current="$(readlink -f "$link_path" 2>/dev/null || true)"
      expected="$(readlink -f "$target" 2>/dev/null || true)"
      [ "$current" != "$expected" ] || return 0
      ln -snf "$target" "$link_path" 2>/dev/null \
        && echo "[setup] repaired identity symlink" >&2 \
        || echo "[setup] could not repair identity symlink" >&2
      return 0
    fi

    # Nothing exists yet — create the symlink.
    if [ ! -e "$link_path" ]; then
      ln -snf "$target" "$link_path" 2>/dev/null \
        && echo "[setup] created identity symlink" >&2 \
        || echo "[setup] could not create identity symlink" >&2
      return 0
    fi

    # A non-symlink entry exists — back it up, then replace.
    local backup
    backup="${link_path}.bak.$(date +%s)"
    if mv "$link_path" "$backup" 2>/dev/null \
      && ln -snf "$target" "$link_path" 2>/dev/null; then
      echo "[setup] replaced non-symlink identity path (backup: ${backup})" >&2
    else
      echo "[setup] could not replace ${link_path}; writes may fail" >&2
    fi
  }

  fix_openclaw_data_ownership() {
    local data_dir="${HOME}/.openclaw-data"
    local openclaw_dir="${HOME}/.openclaw"
    [ -d "$data_dir" ] || return 0
    local subdirs="agents/main/agent extensions workspace skills hooks identity devices canvas cron"
    for sub in $subdirs; do
      mkdir -p "${data_dir}/${sub}" 2>/dev/null || true
    done
    if find "$data_dir" ! -uid "$(id -u)" -print -quit 2>/dev/null | grep -q .; then
      chown -R "$(id -u):$(id -g)" "$data_dir" 2>/dev/null \
        && echo "[setup] fixed ownership on ${data_dir}" >&2 \
        || echo "[setup] could not fix ownership on ${data_dir}; writes may fail" >&2
    fi
    ensure_identity_symlink "$data_dir" "$openclaw_dir"
  }
  fix_openclaw_data_ownership
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
  echo "[gateway] openclaw gateway launched (pid $GATEWAY_PID)" >&2
  trap cleanup SIGTERM SIGINT
  start_auto_pair
  print_dashboard_urls

  wait "$GATEWAY_PID"
  exit $?
fi

# ── Root path (full privilege separation via gosu) ─────────────

# Verify config integrity before starting anything
verify_config_integrity
export_gateway_token
install_configure_guard

# Inject messaging channel config if provider tokens are present.
# Must run AFTER integrity check (to detect build-time tampering) and
# BEFORE chattr +i (which locks the config permanently).
configure_messaging_channels

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
validate_openclaw_symlinks

# Lock .openclaw directory after symlink validation: set the immutable flag
# so symlinks cannot be swapped at runtime even if DAC or Landlock are
# bypassed. chattr requires cap_linux_immutable which the entrypoint has
# as root; the sandbox user cannot remove the flag.
# Ref: https://github.com/NVIDIA/NemoClaw/issues/1019
harden_openclaw_symlinks

# Start the gateway as the 'gateway' user.
# SECURITY: The sandbox user cannot kill this process because it runs
# under a different UID. The fake-HOME attack no longer works because
# the agent cannot restart the gateway with a tampered config.
nohup gosu gateway "$OPENCLAW" gateway run >/tmp/gateway.log 2>&1 &
GATEWAY_PID=$!
echo "[gateway] openclaw gateway launched as 'gateway' user (pid $GATEWAY_PID)" >&2
trap cleanup SIGTERM SIGINT

start_auto_pair
print_dashboard_urls

# Keep container running by waiting on the gateway process.
# This script is PID 1 (ENTRYPOINT); if it exits, Docker kills all children.
wait "$GATEWAY_PID"
