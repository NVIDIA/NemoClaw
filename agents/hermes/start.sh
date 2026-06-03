#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# NemoClaw sandbox entrypoint for Hermes Agent.
#
# Mirrors scripts/nemoclaw-start.sh (OpenClaw) but launches `hermes gateway
# start` instead of `openclaw gateway run`. Key differences:
#   - No device-pairing auto-pair watcher (Hermes has no browser pairing)
#   - Config is YAML (config.yaml + .env) not JSON (openclaw.json)
#   - Gateway listens on internal port 18642, socat forwards to 8642
#   - Optional dashboard listens on internal port 19119, socat forwards to 9119
#
# SECURITY: The gateway runs as a separate user so the sandboxed agent cannot
# kill it or restart it with a tampered config. Config hash is verified at
# startup to detect tampering.

set -euo pipefail

# ── Source shared sandbox initialisation library ─────────────────
# Single source of truth for security-sensitive primitives shared with
# scripts/nemoclaw-start.sh (OpenClaw). Ref: #2277
# Installed location (container): /usr/local/lib/nemoclaw/sandbox-init.sh
# Dev fallback: scripts/lib/sandbox-init.sh relative to this script.
_SANDBOX_INIT="/usr/local/lib/nemoclaw/sandbox-init.sh"
if [ ! -f "$_SANDBOX_INIT" ]; then
  _SANDBOX_INIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../scripts/lib/sandbox-init.sh"
fi
# shellcheck source=scripts/lib/sandbox-init.sh
source "$_SANDBOX_INIT"

# Harden: limit process count to prevent fork bombs
if ! ulimit -Su 512 2>/dev/null; then
  echo "[SECURITY] Could not set soft nproc limit (container runtime may restrict ulimit)" >&2
fi
if ! ulimit -Hu 512 2>/dev/null; then
  echo "[SECURITY] Could not set hard nproc limit (container runtime may restrict ulimit)" >&2
fi

# SECURITY: Lock down PATH
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# ── Early stderr/stdout capture ──────────────────────────────────
# Capture all entrypoint output to /tmp/nemoclaw-start.log so startup
# failures before /tmp/gateway.log exists are still diagnosable.
prepare_restricted_log() {
  local path="$1"
  local owner="${2:-}"
  local mode="${3:-600}"
  local dir base tmp

  dir="$(dirname "$path")"
  base="$(basename "$path")"
  tmp="$(mktemp "${dir}/.${base}.tmp.XXXXXX")" || return 1
  : >"$tmp" || {
    rm -f "$tmp"
    return 1
  }
  if [ "$(id -u)" -eq 0 ] && [ -n "$owner" ] && ! chown "$owner" "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  if ! chmod "$mode" "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  if ! mv -f "$tmp" "$path"; then
    rm -f "$tmp"
    return 1
  fi
}

_START_LOG="/tmp/nemoclaw-start.log"
if [ "$(id -u)" -eq 0 ]; then
  prepare_restricted_log "$_START_LOG" root:root 600
else
  prepare_restricted_log "$_START_LOG" "" 600
fi
exec > >(tee -a "$_START_LOG") 2> >(tee -a "$_START_LOG" >&2)

# ── Drop unnecessary Linux capabilities (shared) ────────────────
drop_capabilities /usr/local/bin/nemoclaw-start "$@"

# Normalize the self-wrapper bootstrap (same as OpenClaw entrypoint).
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

case "${1:-}" in
  nemoclaw-start | /usr/local/bin/nemoclaw-start) shift ;;
esac
NEMOCLAW_CMD=("$@")
CHAT_UI_URL="${CHAT_UI_URL:-http://127.0.0.1:8642}"
PUBLIC_PORT=8642
# Hermes binds to 127.0.0.1 regardless of config (upstream bug).
# Run it on an internal port and use socat to expose on PUBLIC_PORT.
INTERNAL_PORT=18642
HERMES_DASHBOARD_ENABLED="${NEMOCLAW_HERMES_DASHBOARD:-0}"
HERMES_DASHBOARD_PUBLIC_PORT="${NEMOCLAW_HERMES_DASHBOARD_PORT:-9119}"
HERMES_DASHBOARD_INTERNAL_PORT="${NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT:-19119}"
HERMES_DASHBOARD_TUI="${NEMOCLAW_HERMES_DASHBOARD_TUI:-0}"
HERMES="$(command -v hermes)" # Resolve once, use absolute path everywhere

# Hermes resolves config and runtime state relative to HERMES_HOME. The config
# root is mutable by the sandbox owner and readable by the gateway group. The
# root directory is group-writable with sticky-bit protection so Hermes v0.14 can
# create new top-level state while the gateway user cannot remove config files.
# Immutability is opt-in via `shields up`.
HERMES_DIR="/sandbox/.hermes"
HERMES_HASH_FILE="/etc/nemoclaw/hermes.config-hash"

truthy_env() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    1 | true | yes | on) return 0 ;;
    *) return 1 ;;
  esac
}

validate_tcp_port() {
  local name="$1"
  local value="$2"
  case "$value" in
    '' | *[!0-9]*)
      echo "[gateway] ERROR: ${name} must be an integer TCP port, got '${value}'" >&2
      exit 1
      ;;
  esac
  if [ "$value" -lt 1024 ] || [ "$value" -gt 65535 ]; then
    echo "[gateway] ERROR: ${name} must be between 1024 and 65535, got '${value}'" >&2
    exit 1
  fi
}

validate_port_configuration() {
  validate_tcp_port PUBLIC_PORT "$PUBLIC_PORT"
  validate_tcp_port INTERNAL_PORT "$INTERNAL_PORT"
  validate_tcp_port HERMES_DASHBOARD_PUBLIC_PORT "$HERMES_DASHBOARD_PUBLIC_PORT"
  validate_tcp_port HERMES_DASHBOARD_INTERNAL_PORT "$HERMES_DASHBOARD_INTERNAL_PORT"
  if [ "$HERMES_DASHBOARD_PUBLIC_PORT" -eq "$PUBLIC_PORT" ]; then
    echo "[gateway] ERROR: HERMES_DASHBOARD_PUBLIC_PORT must not equal PUBLIC_PORT (${PUBLIC_PORT})" >&2
    exit 1
  fi
  if [ "$HERMES_DASHBOARD_INTERNAL_PORT" -eq "$INTERNAL_PORT" ]; then
    echo "[gateway] ERROR: HERMES_DASHBOARD_INTERNAL_PORT must not equal INTERNAL_PORT (${INTERNAL_PORT})" >&2
    exit 1
  fi
  if [ "$HERMES_DASHBOARD_PUBLIC_PORT" -eq "$INTERNAL_PORT" ]; then
    echo "[gateway] ERROR: HERMES_DASHBOARD_PUBLIC_PORT must not equal INTERNAL_PORT (${INTERNAL_PORT})" >&2
    exit 1
  fi
  if [ "$HERMES_DASHBOARD_INTERNAL_PORT" -eq "$PUBLIC_PORT" ]; then
    echo "[gateway] ERROR: HERMES_DASHBOARD_INTERNAL_PORT must not equal PUBLIC_PORT (${PUBLIC_PORT})" >&2
    exit 1
  fi
}

validate_port_configuration

hermes_dashboard_enabled() {
  truthy_env "$HERMES_DASHBOARD_ENABLED"
}

hermes_dashboard_tui_enabled() {
  truthy_env "$HERMES_DASHBOARD_TUI"
}

# verify_config_integrity is provided by sandbox-init.sh (parameterized).

# configure_messaging_channels is provided by sandbox-init.sh (shared).

print_dashboard_urls() {
  local local_url
  local_url="http://127.0.0.1:${PUBLIC_PORT}/v1"
  echo "[gateway] Hermes API: ${local_url}" >&2
  echo "[gateway] Health:     ${local_url%/v1}/health" >&2
  if hermes_dashboard_enabled; then
    echo "[gateway] Dashboard:  http://127.0.0.1:${HERMES_DASHBOARD_PUBLIC_PORT}/" >&2
  fi
  echo "[gateway] Connect any OpenAI-compatible frontend to this endpoint." >&2
}

start_gateway_log_stream() {
  { tail -n +1 -F /tmp/gateway.log 2>/dev/null | sed -u 's/^/[gateway-log:] /' >&2; } &
  GATEWAY_LOG_TAIL_PID=$!
}

start_dashboard_log_stream() {
  { tail -n +1 -F /tmp/hermes-dashboard.log 2>/dev/null | sed -u 's/^/[dashboard-log:] /' >&2; } &
  DASHBOARD_LOG_TAIL_PID=$!
}

retry_tirith_marker_if_needed() {
  local marker="${HERMES_DIR}/.tirith-install-failed"
  local reason

  [ -e "$marker" ] || return 0
  if [ -L "$marker" ] || [ ! -f "$marker" ]; then
    echo "[tirith-bootstrap] WARNING: unsafe Tirith install marker at ${marker}; not reading it" >&2
    return 0
  fi

  reason="$(head -n 1 "$marker" 2>/dev/null | tr -d '\r\n' || true)"
  if [ "$reason" != "download_failed" ]; then
    echo "[tirith-bootstrap] WARNING: Tirith install marker reason '${reason:-unknown}' is not retryable; Hermes gateway startup will continue" >&2
    return 0
  fi

  echo "[tirith-bootstrap] download_failed marker present; letting Hermes runtime fallback retry Tirith" >&2
  if ! rm -f "$marker" 2>/dev/null; then
    echo "[tirith-bootstrap] WARNING: could not remove retryable Tirith marker; Hermes gateway startup will continue" >&2
  fi
}

cmdline_is_hermes_gateway() {
  local cmdline=" $1 "

  case "$cmdline" in
    *"/hermes gateway run "* | *" hermes gateway run "*) return 0 ;;
  esac
  return 1
}

has_live_hermes_gateway() {
  local proc_root="${NEMOCLAW_PROC_ROOT:-/proc}"
  local cmdline_file cmdline

  for cmdline_file in "${proc_root}"/[0-9]*/cmdline; do
    [ -r "$cmdline_file" ] || continue
    cmdline="$(tr '\0' ' ' <"$cmdline_file" 2>/dev/null || true)"
    if cmdline_is_hermes_gateway "$cmdline"; then
      return 0
    fi
  done
  return 1
}

cleanup_orphan_socat_forwarders() {
  local proc_root="${NEMOCLAW_PROC_ROOT:-/proc}"
  local dashboard_internal="${HERMES_DASHBOARD_INTERNAL_PORT:-19119}"
  local dashboard_public="${HERMES_DASHBOARD_PUBLIC_PORT:-9119}"
  local cmdline_file pid cmdline

  for cmdline_file in "${proc_root}"/[0-9]*/cmdline; do
    [ -r "$cmdline_file" ] || continue
    pid="$(basename "$(dirname "$cmdline_file")")"
    cmdline="$(tr '\0' ' ' <"$cmdline_file" 2>/dev/null || true)"
    case "$cmdline" in
      *socat*"TCP-LISTEN:${PUBLIC_PORT}"*"TCP:127.0.0.1:${INTERNAL_PORT}"*)
        echo "[gateway] Removing orphaned socat forwarder for ${PUBLIC_PORT}->${INTERNAL_PORT} (pid ${pid})" >&2
        kill "$pid" 2>/dev/null || true
        ;;
      *socat*"TCP-LISTEN:${dashboard_public}"*"TCP:127.0.0.1:${dashboard_internal}"*)
        echo "[gateway] Removing orphaned dashboard socat forwarder for ${dashboard_public}->${dashboard_internal} (pid ${pid})" >&2
        kill "$pid" 2>/dev/null || true
        ;;
    esac
  done
}

remove_stale_gateway_file() {
  local path="$1"
  local label="$2"

  if [ -L "$path" ]; then
    echo "[gateway] Removing unsafe stale Hermes ${label} symlink: ${path}" >&2
    rm -f "$path" 2>/dev/null || echo "[gateway] WARNING: could not remove stale ${label}: ${path}" >&2
    return
  fi
  if [ -f "$path" ]; then
    echo "[gateway] Removing stale Hermes ${label}: ${path}" >&2
    rm -f "$path" 2>/dev/null || echo "[gateway] WARNING: could not remove stale ${label}: ${path}" >&2
  fi
}

hermes_config_path_is_locked() {
  local path="$1"
  local owner mode

  [ -f "$path" ] || return 1
  [ ! -L "$path" ] || return 1

  owner="$(stat -c '%U:%G' "$path" 2>/dev/null || stat -f '%Su:%Sg' "$path" 2>/dev/null || true)"
  mode="$(stat -c '%a' "$path" 2>/dev/null || stat -f '%Lp' "$path" 2>/dev/null || true)"
  mode="${mode#0}"
  [ -n "$mode" ] || return 1

  [ "$owner" = "root:root" ] || return 1
  (((8#$mode & 0222) == 0))
}

hermes_config_root_is_locked() {
  local owner mode

  owner="$(stat -c '%U:%G' "$HERMES_DIR" 2>/dev/null || stat -f '%Su:%Sg' "$HERMES_DIR" 2>/dev/null || true)"
  mode="$(stat -c '%a' "$HERMES_DIR" 2>/dev/null || stat -f '%Lp' "$HERMES_DIR" 2>/dev/null || true)"

  case "${owner} ${mode}" in
    "root:root 755" | "root:root 0755") ;;
    *) return 1 ;;
  esac

  hermes_config_path_is_locked "${HERMES_DIR}/config.yaml" \
    && hermes_config_path_is_locked "${HERMES_DIR}/.env"
}

apply_shields_up_runtime_env() {
  hermes_config_root_is_locked || return 0
  if [ -z "${HERMES_KANBAN_DISPATCH_IN_GATEWAY:-}" ]; then
    export HERMES_KANBAN_DISPATCH_IN_GATEWAY=0
    echo "[gateway] Shields-up: HERMES_KANBAN_DISPATCH_IN_GATEWAY=0 (embedded kanban dispatcher suspended; kanban.db on locked config root is read-only)" >&2
  fi
}

ensure_hermes_config_root_mode() {
  if [ -L "$HERMES_DIR" ] || [ ! -d "$HERMES_DIR" ]; then
    echo "[SECURITY] Refusing Hermes layout repair because ${HERMES_DIR} is not a safe directory" >&2
    return 1
  fi

  if hermes_config_root_is_locked; then
    echo "[gateway] Hermes config root is locked; preserving shields-up permissions" >&2
    return 0
  fi

  if [ "$(id -u)" -eq 0 ]; then
    chown sandbox:sandbox "$HERMES_DIR"
  fi
  chmod 3770 "$HERMES_DIR"
}

ensure_hermes_state_dir() {
  local dir="$1"
  local mode="$2"

  if [ -L "$dir" ]; then
    echo "[SECURITY] Refusing Hermes layout repair because ${dir} is a symlink" >&2
    return 1
  fi
  if [ -e "$dir" ] && [ ! -d "$dir" ]; then
    echo "[SECURITY] Refusing Hermes layout repair because ${dir} is not a directory" >&2
    return 1
  fi

  mkdir -p "$dir"

  if [ -L "$dir" ] || [ ! -d "$dir" ]; then
    echo "[SECURITY] Refusing Hermes layout repair because ${dir} did not resolve to a safe directory" >&2
    return 1
  fi

  if [ "$(id -u)" -eq 0 ]; then
    chown sandbox:sandbox "$dir"
  fi
  chmod "$mode" "$dir"
}

ensure_hermes_history_file() {
  local file="$1"
  local mode="$2"
  local nlinks

  if [ -L "$file" ]; then
    echo "[SECURITY] Refusing Hermes layout repair because ${file} is a symlink" >&2
    return 1
  fi
  if [ -e "$file" ] && [ ! -f "$file" ]; then
    echo "[SECURITY] Refusing Hermes layout repair because ${file} is not a regular file" >&2
    return 1
  fi

  # Reject hard-linked targets. An attacker who controls the sandbox user
  # before shields-up can pre-create .hermes_history as a hard link to
  # config.yaml or .env. Both -L and -f pass, so without this guard the
  # subsequent chown sandbox:sandbox + chmod 660 would walk the shared
  # inode and silently undo the shields-up root:root 0444 lock on the
  # config file after verify_config_integrity has already passed.
  if [ -e "$file" ]; then
    nlinks="$(stat -c '%h' "$file" 2>/dev/null || stat -f '%l' "$file" 2>/dev/null || true)"
    if [ "${nlinks:-}" != "1" ]; then
      echo "[SECURITY] Refusing Hermes layout repair because ${file} has hard-link count ${nlinks:-unknown}" >&2
      return 1
    fi
  fi

  if [ ! -e "$file" ]; then
    : >"$file" || return 1
  fi

  if [ "$(id -u)" -eq 0 ]; then
    chown sandbox:sandbox "$file"
  fi
  chmod "$mode" "$file"
}

repair_hermes_startup_layout() {
  if hermes_config_root_is_locked; then
    # The locked-root posture seals config.yaml/.env, not the dir, so we can
    # still bring a missing prompt_toolkit history file into existence as a
    # sandbox-owned regular file. Sandboxes built before the precreate landed
    # would otherwise stay broken until the next `shields down` cycle.
    # Refusal (symlink, non-regular, create failure) is a hard stop: starting
    # the gateway with an unsafe .hermes_history under a locked root would
    # either let the TUI clobber an attacker-pointed path or repeat the
    # original keypress traceback.
    echo "[gateway] Hermes layout repair limited to history file because config root is locked" >&2
    ensure_hermes_history_file "${HERMES_DIR}/.hermes_history" 660
    return 0
  fi

  ensure_hermes_config_root_mode
  ensure_hermes_state_dir "${HERMES_DIR}/logs" 770
  ensure_hermes_state_dir "${HERMES_DIR}/logs/curator" 770
  ensure_hermes_state_dir "${HERMES_DIR}/hooks" 770
  ensure_hermes_state_dir "${HERMES_DIR}/image_cache" 770
  ensure_hermes_state_dir "${HERMES_DIR}/audio_cache" 770
  ensure_hermes_history_file "${HERMES_DIR}/.hermes_history" 660
}

cleanup_stale_hermes_gateway_runtime() {
  local runtime_dir="${HERMES_DIR}/runtime"

  if has_live_hermes_gateway; then
    echo "[gateway] Existing Hermes gateway process detected; preserving runtime lock state" >&2
    return 0
  fi

  repair_hermes_startup_layout

  # Hermes can leave gateway.lock behind after Docker GPU recreation kills the
  # old process namespace. Clear it only after confirming no gateway is alive.
  remove_stale_gateway_file "${runtime_dir}/gateway.pid" "runtime PID file"
  remove_stale_gateway_file "${HERMES_DIR}/gateway.pid" "legacy PID file"
  remove_stale_gateway_file "${runtime_dir}/gateway.lock" "lock file"
  cleanup_orphan_socat_forwarders
}

# ── socat forwarder ──────────────────────────────────────────────
# Hermes API server binds to 127.0.0.1 regardless of config (upstream bug).
# OpenShell needs the port accessible on 0.0.0.0 for port forwarding.
# socat bridges 0.0.0.0:PUBLIC_PORT → 127.0.0.1:INTERNAL_PORT.
SOCAT_PID=""
DASHBOARD_SOCAT_PID=""
start_socat_forwarder() {
  local label="${1:-gateway}"
  local public_port="${2:-$PUBLIC_PORT}"
  local internal_port="${3:-$INTERNAL_PORT}"
  local pid_var="${4:-SOCAT_PID}"

  if ! command -v socat >/dev/null 2>&1; then
    echo "[gateway] socat not available — ${label} port forwarding from host may not work" >&2
    return
  fi
  local attempts=0
  while [ "$attempts" -lt 30 ]; do
    if ss -tln 2>/dev/null | grep -q "127.0.0.1:${internal_port}"; then
      break
    fi
    sleep 1
    attempts=$((attempts + 1))
  done
  nohup socat TCP-LISTEN:"${public_port}",bind=0.0.0.0,fork,reuseaddr \
    TCP:127.0.0.1:"${internal_port}" >/dev/null 2>&1 &
  printf -v "$pid_var" '%s' "$!"
  echo "[gateway] ${label} socat forwarder 0.0.0.0:${public_port} → 127.0.0.1:${internal_port} (pid ${!pid_var})" >&2
}

build_hermes_dashboard_args() {
  HERMES_DASHBOARD_ARGS=(
    dashboard
    --host
    127.0.0.1
    --port
    "$HERMES_DASHBOARD_INTERNAL_PORT"
    --skip-build
    --no-open
  )
  if hermes_dashboard_tui_enabled; then
    HERMES_DASHBOARD_ARGS+=(--tui)
  fi
}

start_hermes_dashboard_current_user() {
  hermes_dashboard_enabled || return 0

  build_hermes_dashboard_args
  prepare_restricted_log /tmp/hermes-dashboard.log "" 600
  HERMES_HOME="${HERMES_DIR}" \
    nohup "$HERMES" "${HERMES_DASHBOARD_ARGS[@]}" >/tmp/hermes-dashboard.log 2>&1 &
  HERMES_DASHBOARD_PID=$!
  echo "[gateway] hermes dashboard launched (pid $HERMES_DASHBOARD_PID)" >&2
  start_dashboard_log_stream
  start_socat_forwarder "dashboard" \
    "$HERMES_DASHBOARD_PUBLIC_PORT" \
    "$HERMES_DASHBOARD_INTERNAL_PORT" \
    DASHBOARD_SOCAT_PID
}

start_hermes_dashboard_sandbox_user() {
  hermes_dashboard_enabled || return 0

  build_hermes_dashboard_args
  prepare_restricted_log /tmp/hermes-dashboard.log sandbox:sandbox 600
  HERMES_HOME="${HERMES_DIR}" \
    nohup "${STEP_DOWN_PREFIX_SANDBOX[@]}" sh -c 'umask 0077; exec "$@" >/tmp/hermes-dashboard.log 2>&1' sh "$HERMES" "${HERMES_DASHBOARD_ARGS[@]}" &
  HERMES_DASHBOARD_PID=$!
  echo "[gateway] hermes dashboard launched as 'sandbox' user (pid $HERMES_DASHBOARD_PID)" >&2
  start_dashboard_log_stream
  start_socat_forwarder "dashboard" \
    "$HERMES_DASHBOARD_PUBLIC_PORT" \
    "$HERMES_DASHBOARD_INTERNAL_PORT" \
    DASHBOARD_SOCAT_PID
}

# ── Messaging egress ─────────────────────────────────────────────
# Hermes sends messaging traffic directly through the OpenShell L7 proxy.
# OpenShell owns credential alias/body/WebSocket rewrite at the egress
# boundary; NemoClaw must not start a local decode proxy, facade, or
# placeholder-normalizing preload.

# cleanup_on_signal is provided by sandbox-init.sh. It reads
# SANDBOX_CHILD_PIDS (array of all PIDs) and SANDBOX_WAIT_PID (the
# primary process whose exit status is returned).
# Each code path below sets these before registering the trap.

# ── Proxy environment ────────────────────────────────────────────
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

# OpenShell injects SSL_CERT_FILE/CURL_CA_BUNDLE for its L7 proxy CA. Persist
# them into connect-session shells so Python Slack probes and Hermes tools trust
# the same proxy CA that the entrypoint received at startup.
if [ -n "${SSL_CERT_FILE:-}" ] && [ -f "${SSL_CERT_FILE}" ]; then
  export CURL_CA_BUNDLE="${CURL_CA_BUNDLE:-$SSL_CERT_FILE}"
  export REQUESTS_CA_BUNDLE="${REQUESTS_CA_BUNDLE:-$SSL_CERT_FILE}"
  export GIT_SSL_CAINFO="${GIT_SSL_CAINFO:-$SSL_CERT_FILE}"
fi

# Resolve sandbox home dir early — used by proxy-env writing before the
# non-root/root branch below.
if [ "$(id -u)" -eq 0 ]; then
  _SANDBOX_HOME=$(getent passwd sandbox 2>/dev/null | cut -d: -f6)
  _SANDBOX_HOME="${_SANDBOX_HOME:-/sandbox}"
else
  _SANDBOX_HOME="${HOME:-/sandbox}"
fi

# SECURITY FIX: Write proxy config to a standalone file via
# emit_sandbox_sourced_file() (444, root-owned when running as root) instead of
# appending inline to .bashrc/.profile. The old approach rewrote files under
# /sandbox during startup, which fails in non-root entrypoint postures.
# Ref: https://github.com/NVIDIA/NemoClaw/issues/2277
_PROXY_ENV_FILE="/tmp/nemoclaw-proxy-env.sh"
write_runtime_shell_env() {
  {
    cat <<PROXYEOF
# Proxy configuration (overrides narrow OpenShell defaults on connect)
export HTTP_PROXY="$_PROXY_URL"
export HTTPS_PROXY="$_PROXY_URL"
export NO_PROXY="$_NO_PROXY_VAL"
export http_proxy="$_PROXY_URL"
export https_proxy="$_PROXY_URL"
export no_proxy="$_NO_PROXY_VAL"
export HERMES_HOME="${HERMES_DIR}"
PROXYEOF
    for _ca_env_name in SSL_CERT_FILE CURL_CA_BUNDLE REQUESTS_CA_BUNDLE GIT_SSL_CAINFO; do
      _ca_env_value="${!_ca_env_name:-}"
      if [ -n "$_ca_env_value" ]; then
        printf 'export %s=%q\n' "$_ca_env_name" "$_ca_env_value"
      fi
    done
    cat <<'GUARDENVEOF'
# nemoclaw-configure-guard begin
hermes() {
  case "$1" in
    setup|doctor)
      echo "Error: 'hermes $1' cannot modify config inside the sandbox." >&2
      echo "NemoClaw manages sandbox config from the host for integrity checks." >&2
      echo "" >&2
      echo "To change your configuration, exit the sandbox and run:" >&2
      echo "  nemoclaw onboard --resume" >&2
      return 1
      ;;
  esac
  command hermes "$@"
}
# nemoclaw-configure-guard end
GUARDENVEOF
  } | emit_sandbox_sourced_file "$_PROXY_ENV_FILE"
}

write_runtime_shell_env
# SECURITY FIX: Lock .bashrc/.profile after all static shims are in place.
# Hermes connect sessions source the dynamic guard from /tmp/nemoclaw-proxy-env.sh
# so startup never needs to rewrite files directly under /sandbox after caps drop.
lock_rc_files "$_SANDBOX_HOME"

# ── Legacy layout migration ──────────────────────────────────────
path_has_immutable_bit() {
  local target="$1"
  command -v lsattr >/dev/null 2>&1 || return 1
  [ -e "$target" ] || [ -L "$target" ] || return 1
  lsattr -d "$target" 2>/dev/null | awk '{print $1}' | grep -q 'i'
}

ensure_mutable_for_migration() {
  local target="$1" label="$2"
  if ! path_has_immutable_bit "$target"; then
    return 0
  fi
  if command -v chattr >/dev/null 2>&1 && chattr -i "$target" 2>/dev/null; then
    return 0
  fi
  echo "[SECURITY] ${label}: ${target} is immutable; run 'nemoclaw <sandbox> shields down' before migration" >&2
  return 1
}

chown_tree_no_symlink_follow() {
  local owner="$1" target="$2"
  [ -d "$target" ] || return 0
  find -P "$target" \( -type d -o -type f \) -exec chown "$owner" {} + 2>/dev/null || true
}

legacy_symlinks_exist() {
  local config_dir="$1" data_dir="$2"
  local data_real entry target
  data_real="$(readlink -f "$data_dir" 2>/dev/null || echo "$data_dir")"
  for entry in "$config_dir"/.[!.]* "$config_dir"/..?* "$config_dir"/*; do
    [ -L "$entry" ] || continue
    target="$(readlink -f "$entry" 2>/dev/null || readlink "$entry" 2>/dev/null || true)"
    case "$target" in
      "$data_real"/* | "$data_dir"/*) return 0 ;;
    esac
  done
  return 1
}

assert_no_legacy_layout() {
  local config_dir="$1" data_dir="$2" label="$3"
  local data_real entry target
  if [ -e "$data_dir" ] || [ -L "$data_dir" ]; then
    echo "[SECURITY] ${label}: legacy data dir still exists after migration: ${data_dir}" >&2
    return 1
  fi
  data_real="$(readlink -f "$data_dir" 2>/dev/null || echo "$data_dir")"
  for entry in "$config_dir"/.[!.]* "$config_dir"/..?* "$config_dir"/*; do
    [ -L "$entry" ] || continue
    target="$(readlink -f "$entry" 2>/dev/null || readlink "$entry" 2>/dev/null || true)"
    case "$target" in
      "$data_real"/* | "$data_dir"/*)
        echo "[SECURITY] ${label}: legacy symlink remains after migration: ${entry} -> ${target}" >&2
        return 1
        ;;
    esac
  done
}

migrate_legacy_layout() {
  local config_dir="$1" data_dir="$2" label="$3"
  if [ -L "$config_dir" ]; then
    echo "[SECURITY] ${label}: refusing migration because ${config_dir} is a symlink" >&2
    return 1
  fi
  if [ -L "$data_dir" ]; then
    echo "[SECURITY] ${label}: refusing migration because ${data_dir} is a symlink" >&2
    return 1
  fi

  local sentinel="${config_dir}/.migration-complete"
  if [ -e "$sentinel" ] || [ -L "$sentinel" ]; then
    local sentinel_uid sentinel_mode
    sentinel_uid="$(stat -c '%u' "$sentinel" 2>/dev/null || stat -f '%u' "$sentinel" 2>/dev/null || echo "unknown")"
    sentinel_mode="$(stat -c '%a' "$sentinel" 2>/dev/null || stat -f '%Lp' "$sentinel" 2>/dev/null || echo "unknown")"
    if [ -f "$sentinel" ] && [ ! -L "$sentinel" ] && [ "$sentinel_uid" = "0" ] && [ "$sentinel_mode" != "unknown" ] && (((8#$sentinel_mode & 0222) == 0)); then
      if [ ! -d "$data_dir" ] && ! legacy_symlinks_exist "$config_dir" "$data_dir"; then
        echo "[migration] ${label}: already migrated (trusted sentinel exists), skipping" >&2
        return 0
      fi
      echo "[migration] ${label}: trusted sentinel exists but legacy artifacts remain; repairing" >&2
      ensure_mutable_for_migration "$sentinel" "$label" || return 1
      rm -f "$sentinel" || return 1
    else
      echo "[SECURITY] ${label}: ignoring untrusted migration sentinel ${sentinel}" >&2
      ensure_mutable_for_migration "$sentinel" "$label" || return 1
      rm -f "$sentinel" || return 1
    fi
  fi

  if [ ! -d "$data_dir" ]; then
    assert_no_legacy_layout "$config_dir" "$data_dir" "$label"
    return $?
  fi

  if [ "$(id -u)" -ne 0 ]; then
    echo "[SECURITY] ${label}: migration skipped — requires root" >&2
    return 0
  fi

  local data_owner
  data_owner="$(stat -c '%U' "$data_dir" 2>/dev/null || stat -f '%Su' "$data_dir" 2>/dev/null || echo "unknown")"
  if [ "$data_owner" = "sandbox" ] && ! legacy_symlinks_exist "$config_dir" "$data_dir"; then
    echo "[SECURITY] ${label}: sandbox-owned ${data_dir} has no legacy symlink bridge — refusing migration (possible agent-planted trigger)" >&2
    return 1
  fi

  if [ "$(stat -c '%U' "$config_dir" 2>/dev/null || stat -f '%Su' "$config_dir" 2>/dev/null || echo "unknown")" = "root" ]; then
    echo "[SECURITY] ${label}: legacy layout appears shielded; run 'nemoclaw <sandbox> shields down' before migration" >&2
    return 1
  fi

  ensure_mutable_for_migration "$config_dir" "$label" || return 1
  ensure_mutable_for_migration "$data_dir" "$label" || return 1

  echo "[migration] Detected legacy ${label} layout (${data_dir} exists), migrating..." >&2
  for entry in "$data_dir"/.[!.]* "$data_dir"/..?* "$data_dir"/*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    if [ -L "$entry" ]; then
      echo "[SECURITY] ${label}: refusing migration because ${entry} is a symlink" >&2
      return 1
    fi
    ensure_mutable_for_migration "$entry" "$label" || return 1
    local name
    name="$(basename "$entry")"
    local target="${config_dir}/${name}"
    if [ -L "$target" ]; then
      ensure_mutable_for_migration "$target" "$label" || return 1
      rm -f "$target"
      cp -a "$entry" "$target"
    elif [ -d "$target" ] && [ -d "$entry" ]; then
      ensure_mutable_for_migration "$target" "$label" || return 1
      cp -a "$entry"/. "$target"/
    elif [ ! -e "$target" ]; then
      cp -a "$entry" "$target"
    fi
  done
  for entry in "$config_dir"/.[!.]* "$config_dir"/..?* "$config_dir"/*; do
    [ -L "$entry" ] && continue
    [ -d "$entry" ] || continue
    chown_tree_no_symlink_follow sandbox:sandbox "$entry"
  done
  rm -rf "$data_dir"
  assert_no_legacy_layout "$config_dir" "$data_dir" "$label" || return 1
  printf 'migrated=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$sentinel"
  chown root:root "$sentinel" 2>/dev/null || true
  chmod 444 "$sentinel" 2>/dev/null || true
  echo "[migration] Completed ${label} layout migration (${data_dir} removed)" >&2
}

refresh_hermes_provider_placeholders() {
  local env_file="${HERMES_DIR}/.env"
  local hash_file="${HERMES_HASH_FILE}"
  local compat_hash="${HERMES_DIR}/.config-hash"
  [ -f "$env_file" ] || return 0

  local keys="TELEGRAM_BOT_TOKEN DISCORD_BOT_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN"
  local has_scoped_placeholder=0
  local key value
  for key in $keys; do
    value="${!key:-}"
    case "$value" in
      openshell:resolve:env:*) has_scoped_placeholder=1 ;;
    esac
  done
  [ "$has_scoped_placeholder" -eq 1 ] || return 0

  if [ -L "$env_file" ] || [ -L "$hash_file" ] || { [ -e "$compat_hash" ] && [ -L "$compat_hash" ]; }; then
    echo "[SECURITY] Refusing Hermes provider placeholder refresh — config or hash path is a symlink" >&2
    return 1
  fi

  if [ "$(id -u)" -eq 0 ]; then
    chown root:sandbox "$env_file" || return 1
    chmod 640 "$env_file" || return 1
    chmod u+w "$hash_file" || return 1
    [ ! -f "$compat_hash" ] || chmod u+w "$compat_hash" 2>/dev/null || true
  elif [ ! -w "$env_file" ] || [ ! -w "$hash_file" ]; then
    echo "[config] Hermes provider placeholders supplied by OpenShell runtime env; .env refresh skipped without write access" >&2
    return 0
  fi

  local _write_rc=0
  NEMOCLAW_PROVIDER_PLACEHOLDER_KEYS="$keys" \
    python3 - "$env_file" <<'PYPLACEHOLDERS' || _write_rc=$?
import os
import sys

env_file = sys.argv[1]
prefix = "openshell:resolve:env:"
keys = os.environ.get("NEMOCLAW_PROVIDER_PLACEHOLDER_KEYS", "").split()
replacements = {}

for key in keys:
    value = os.environ.get(key, "")
    if value.startswith(prefix):
        replacements[key] = value

if not replacements:
    sys.exit(0)

with open(env_file, encoding="utf-8") as f:
    lines = f.readlines()

changed = False
updated = []
for line in lines:
    stripped = line.rstrip("\n")
    replaced = False
    for key, value in replacements.items():
        if stripped.startswith(f"{key}="):
            new_line = f"{key}={value}\n"
            updated.append(new_line)
            changed = changed or new_line != line
            replaced = True
            break
    if not replaced:
        updated.append(line)

if not changed:
    sys.exit(0)

with open(env_file, "w", encoding="utf-8") as f:
    f.writelines(updated)

print("refreshed=" + ",".join(sorted(replacements)))
PYPLACEHOLDERS

  if [ "$_write_rc" -eq 0 ]; then
    if sha256sum "${HERMES_DIR}/config.yaml" "${HERMES_DIR}/.env" >"$hash_file"; then
      chown root:root "$hash_file" 2>/dev/null || true
      chmod 444 "$hash_file" 2>/dev/null || true
      if [ -f "$compat_hash" ]; then
        sha256sum "${HERMES_DIR}/config.yaml" "${HERMES_DIR}/.env" >"$compat_hash" || _write_rc=$?
        chown sandbox:sandbox "$compat_hash" 2>/dev/null || true
        chmod 600 "$compat_hash" 2>/dev/null || true
      fi
      echo "[config] Refreshed Hermes provider placeholders from OpenShell runtime env" >&2
    else
      _write_rc=$?
    fi
  fi

  if [ "$(id -u)" -eq 0 ]; then
    chown sandbox:sandbox "$env_file" 2>/dev/null || true
    chmod 640 "$env_file" 2>/dev/null || true
  fi

  [ "$_write_rc" -eq 0 ] || return "$_write_rc"
}

# ── Main ─────────────────────────────────────────────────────────

# Migrate legacy symlink layout before anything else reads .hermes
migrate_legacy_layout "/sandbox/.hermes" "/sandbox/.hermes-data" "hermes" || exit 1

echo 'Setting up NemoClaw (Hermes)...' >&2

# ── Non-root fallback ──────────────────────────────────────────
if [ "$(id -u)" -ne 0 ]; then
  echo "[gateway] Running as non-root (uid=$(id -u)) — privilege separation disabled" >&2
  export HOME=/sandbox
  export HERMES_HOME="${HERMES_DIR}"

  # macOS VM startup currently runs this entrypoint as the sandbox user and
  # remaps rootfs ownership to the host uid. In that mode the strict /etc hash
  # cannot remain a root-owned trust anchor, so use the same locked-aware
  # mutable-default verifier as OpenClaw. The root path below keeps strict
  # verification against /etc/nemoclaw/hermes.config-hash.
  if ! verify_config_integrity_if_locked "${HERMES_DIR}"; then
    echo "[SECURITY] Config integrity check failed — refusing to start (non-root mode)" >&2
    exit 1
  fi
  apply_shields_up_runtime_env
  refresh_hermes_provider_placeholders
  configure_messaging_channels

  if [ ${#NEMOCLAW_CMD[@]} -gt 0 ]; then
    exec "${NEMOCLAW_CMD[@]}"
  fi

  retry_tirith_marker_if_needed

  cleanup_stale_hermes_gateway_runtime

  prepare_restricted_log /tmp/gateway.log "" 600

  # Defence-in-depth: verify /tmp file permissions before launching services.
  # shellcheck disable=SC2119
  validate_tmp_permissions

  # Start Hermes gateway. Messaging egress goes directly through OpenShell.
  umask 0007
  HERMES_HOME="${HERMES_DIR}" \
    nohup "$HERMES" gateway run >/tmp/gateway.log 2>&1 &
  GATEWAY_PID=$!
  echo "[gateway] hermes gateway launched (pid $GATEWAY_PID)" >&2
  start_gateway_log_stream
  start_hermes_dashboard_current_user
  # NOTE: PIDs are collected after launch; a signal arriving between trap
  # registration and the final append is a small race window (same as before
  # the shared-library refactor). Acceptable for entrypoint-level cleanup.
  SANDBOX_CHILD_PIDS=("$GATEWAY_PID")
  [ -n "${GATEWAY_LOG_TAIL_PID:-}" ] && SANDBOX_CHILD_PIDS+=("$GATEWAY_LOG_TAIL_PID")
  [ -n "${HERMES_DASHBOARD_PID:-}" ] && SANDBOX_CHILD_PIDS+=("$HERMES_DASHBOARD_PID")
  [ -n "${DASHBOARD_LOG_TAIL_PID:-}" ] && SANDBOX_CHILD_PIDS+=("$DASHBOARD_LOG_TAIL_PID")
  [ -n "${DASHBOARD_SOCAT_PID:-}" ] && SANDBOX_CHILD_PIDS+=("$DASHBOARD_SOCAT_PID")
  # shellcheck disable=SC2034  # read by cleanup_on_signal from sandbox-init.sh
  SANDBOX_WAIT_PID="$GATEWAY_PID"
  trap cleanup_on_signal SIGTERM SIGINT
  start_socat_forwarder "api" "$PUBLIC_PORT" "$INTERNAL_PORT" SOCAT_PID
  [ -n "${SOCAT_PID:-}" ] && SANDBOX_CHILD_PIDS+=("$SOCAT_PID")
  print_dashboard_urls

  wait "$GATEWAY_PID"
  exit $?
fi

# ── Root path (full privilege separation via setpriv) ──────────

export HERMES_HOME="${HERMES_DIR}"
verify_config_integrity "${HERMES_DIR}" "${HERMES_HASH_FILE}"
apply_shields_up_runtime_env
refresh_hermes_provider_placeholders
configure_messaging_channels

if [ ${#NEMOCLAW_CMD[@]} -gt 0 ]; then
  exec "${STEP_DOWN_PREFIX_SANDBOX[@]}" "${NEMOCLAW_CMD[@]}"
fi

retry_tirith_marker_if_needed

cleanup_stale_hermes_gateway_runtime

# SECURITY: Protect gateway log from sandbox user tampering
prepare_restricted_log /tmp/gateway.log gateway:gateway 600

# Defence-in-depth: verify /tmp file permissions before launching services.
# shellcheck disable=SC2119
validate_tmp_permissions

# Start Hermes gateway. Messaging egress goes directly through OpenShell.
HERMES_HOME="${HERMES_DIR}" \
  nohup "${STEP_DOWN_PREFIX_GATEWAY[@]}" sh -c 'umask 0007; exec "$@" >/tmp/gateway.log 2>&1' sh "$HERMES" gateway run &
GATEWAY_PID=$!
echo "[gateway] hermes gateway launched as 'gateway' user (pid $GATEWAY_PID)" >&2
start_gateway_log_stream
start_hermes_dashboard_sandbox_user
# NOTE: PIDs are collected after launch; a signal arriving between trap
# registration and the final append is a small race window (same as before
# the shared-library refactor). Acceptable for entrypoint-level cleanup.
SANDBOX_CHILD_PIDS=("$GATEWAY_PID")
[ -n "${GATEWAY_LOG_TAIL_PID:-}" ] && SANDBOX_CHILD_PIDS+=("$GATEWAY_LOG_TAIL_PID")
[ -n "${HERMES_DASHBOARD_PID:-}" ] && SANDBOX_CHILD_PIDS+=("$HERMES_DASHBOARD_PID")
[ -n "${DASHBOARD_LOG_TAIL_PID:-}" ] && SANDBOX_CHILD_PIDS+=("$DASHBOARD_LOG_TAIL_PID")
[ -n "${DASHBOARD_SOCAT_PID:-}" ] && SANDBOX_CHILD_PIDS+=("$DASHBOARD_SOCAT_PID")
# shellcheck disable=SC2034  # read by cleanup_on_signal from sandbox-init.sh
SANDBOX_WAIT_PID="$GATEWAY_PID"
trap cleanup_on_signal SIGTERM SIGINT
start_socat_forwarder "api" "$PUBLIC_PORT" "$INTERNAL_PORT" SOCAT_PID
[ -n "${SOCAT_PID:-}" ] && SANDBOX_CHILD_PIDS+=("$SOCAT_PID")
print_dashboard_urls

# Keep container running by waiting on the gateway process.
wait "$GATEWAY_PID"
