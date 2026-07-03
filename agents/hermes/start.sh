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
#   - Gateway listens on internal port 18642, socat forwards the API to 8642
#   - Dashboard listens on a private loopback port, socat forwards it to 18789
#
# SECURITY: The gateway runs as a separate user so the sandboxed agent cannot
# kill it or restart it with a tampered config. Config hash is verified at
# startup to detect tampering.

set -euo pipefail

# SECURITY: Lock down PATH before resolving or sourcing root startup helpers.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# ── Source shared sandbox initialisation library ─────────────────
# Single source of truth for security-sensitive primitives shared with
# scripts/nemoclaw-start.sh (OpenClaw). Ref: #2277
# Installed location (container): /usr/local/lib/nemoclaw/sandbox-init.sh
# Dev fallback: scripts/lib/sandbox-init.sh relative to this script.
_SANDBOX_INIT="/usr/local/lib/nemoclaw/sandbox-init.sh"
if [ ! -f "$_SANDBOX_INIT" ]; then
  _HERMES_START_SOURCE="${BASH_SOURCE[0]}"
  _HERMES_START_DIR="${_HERMES_START_SOURCE%/*}"
  if [ "$_HERMES_START_DIR" = "$_HERMES_START_SOURCE" ]; then
    _HERMES_START_DIR="."
  fi
  _SANDBOX_INIT="$(cd "$_HERMES_START_DIR" && pwd)/../../scripts/lib/sandbox-init.sh"
  unset _HERMES_START_SOURCE _HERMES_START_DIR
fi
# shellcheck source=scripts/lib/sandbox-init.sh
source "$_SANDBOX_INIT"

_GATEWAY_SUPERVISOR="/usr/local/lib/nemoclaw/gateway-supervisor.sh"
if [ ! -f "$_GATEWAY_SUPERVISOR" ]; then
  _GATEWAY_SUPERVISOR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../scripts/lib/gateway-supervisor.sh"
fi
# shellcheck source=scripts/lib/gateway-supervisor.sh
source "$_GATEWAY_SUPERVISOR"

# Harden RLIMITs (nproc #809 + nofile #4527) as root PID 1, before any step-down.
harden_resource_limits

if [ -d /opt/hermes/hermes_cli/web_dist ]; then
  export HERMES_WEB_DIST="${HERMES_WEB_DIST:-/opt/hermes/hermes_cli/web_dist}"
fi

# Hermes' browser Chat tab shells out to the React/Ink TUI. Force it to the
# trusted prebuilt bundle baked into the image so `hermes dashboard --tui
# --skip-build` never honors a stale/user-controlled TUI path or tries to run
# npm under root-owned /opt/hermes at runtime. Remove this when upstream Hermes
# reliably discovers the prebaked ui-tui bundle without HERMES_TUI_DIR.
if [ -f /opt/hermes/ui-tui/dist/entry.js ]; then
  export HERMES_TUI_DIR="/opt/hermes/ui-tui"
fi

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

_chat_ui_url_port() {
  [ -n "${CHAT_UI_URL:-}" ] || return 1
  python3 - "$CHAT_UI_URL" <<'PYPORT'
import re
import sys
from urllib.parse import urlparse

raw_url = sys.argv[1]
if raw_url and not re.match(r"^[a-z][a-z0-9+.-]*://", raw_url, re.IGNORECASE):
    raw_url = f"http://{raw_url}"
try:
    port = urlparse(raw_url).port
except ValueError:
    sys.exit(1)
if port is None or port < 1024 or port > 65535:
    sys.exit(1)
print(port)
PYPORT
}

_dashboard_port_raw="${NEMOCLAW_DASHBOARD_PORT:-}"
if [ -z "$_dashboard_port_raw" ]; then
  if _chat_ui_port="$(_chat_ui_url_port)"; then
    _dashboard_port="$_chat_ui_port"
  else
    _dashboard_port=18789
  fi
else
  _dashboard_port="$(printf '%s' "$_dashboard_port_raw" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  _dashboard_port_valid=1
  case "$_dashboard_port" in
    *[!0-9]* | '') _dashboard_port_valid=0 ;;
  esac
  if [ "$_dashboard_port_valid" -eq 1 ] && { [ "$_dashboard_port" -lt 1024 ] || [ "$_dashboard_port" -gt 65535 ]; }; then
    _dashboard_port_valid=0
  fi
  if [ "$_dashboard_port_valid" -ne 1 ]; then
    echo "[SECURITY] Invalid NEMOCLAW_DASHBOARD_PORT='${NEMOCLAW_DASHBOARD_PORT}' - must be an integer between 1024 and 65535" >&2
    exit 1
  fi
fi

if [ "$_dashboard_port" -eq 8642 ]; then
  echo "[SECURITY] Invalid Hermes dashboard port 8642 - reserved for the Hermes OpenAI-compatible API" >&2
  exit 1
fi

if [ -n "${NEMOCLAW_DASHBOARD_PORT:-}" ]; then
  CHAT_UI_URL="http://127.0.0.1:${_dashboard_port}"
else
  CHAT_UI_URL="${CHAT_UI_URL:-http://127.0.0.1:${_dashboard_port}}"
fi

PUBLIC_PORT=8642
# Hermes binds the API server to 127.0.0.1. Run it on an internal port and
# use socat to expose the OpenAI-compatible API on PUBLIC_PORT.
INTERNAL_PORT=18642
DASHBOARD_PUBLIC_PORT="$_dashboard_port"
DASHBOARD_INTERNAL_PORT="${NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT:-19119}"
if [ "$DASHBOARD_PUBLIC_PORT" -eq "$DASHBOARD_INTERNAL_PORT" ]; then
  DASHBOARD_INTERNAL_PORT=19120
fi
HERMES_DASHBOARD_TUI="${NEMOCLAW_HERMES_DASHBOARD_TUI:-${HERMES_DASHBOARD_TUI:-0}}"
HERMES_DASHBOARD_HOME="${HERMES_DASHBOARD_HOME:-/sandbox/.hermes/dashboard-home}"
HERMES="$(command -v hermes)" # Resolve once, use absolute path everywhere

# Hermes resolves config and runtime state relative to HERMES_HOME. The config
# root is mutable by the sandbox owner and readable by the gateway group. The
# root directory is group-writable with sticky-bit protection so Hermes v0.14 can
# create new top-level state while the gateway user cannot remove config files.
# Immutability is opt-in via `shields up`.
HERMES_DIR="/sandbox/.hermes"
HERMES_HASH_FILE="/etc/nemoclaw/hermes.config-hash"

# Resolve the standalone secret-boundary validator. The container ships it at
# the installed path; the dev fallback resolves against the script directory so
# ad-hoc bash invocations from a checkout work without copying the file. The
# path is set unconditionally so a caller-supplied _HERMES_BOUNDARY_VALIDATOR
# carried in via the entrypoint env wrapper cannot redirect this security check
# at an attacker-controlled script.
_HERMES_BOUNDARY_VALIDATOR="/usr/local/lib/nemoclaw/validate-hermes-env-secret-boundary.py"
if [ ! -f "$_HERMES_BOUNDARY_VALIDATOR" ]; then
  _HERMES_BOUNDARY_VALIDATOR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/validate-env-secret-boundary.py"
fi

# Resolve the dashboard config seeder (same install/dev-fallback pattern as the
# boundary validator above). The Hermes dashboard runs under its own
# HERMES_DASHBOARD_HOME, so it never sees the model/custom_providers block
# NemoClaw writes to the gateway config; this script mirrors those routing keys
# into the dashboard config so the Models page and kanban specifier/dispatcher
# resolve the routed model.
_HERMES_DASHBOARD_CONFIG_SEEDER="/usr/local/lib/nemoclaw/seed-hermes-dashboard-config.py"
if [ ! -f "$_HERMES_DASHBOARD_CONFIG_SEEDER" ]; then
  _HERMES_DASHBOARD_CONFIG_SEEDER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/seed-dashboard-config.py"
fi

# Descriptor-safe updater for runtime-mutable Hermes config/env/hash files.
_HERMES_RUNTIME_CONFIG_GUARD="/usr/local/lib/nemoclaw/hermes-runtime-config-guard.py"
if [ ! -f "$_HERMES_RUNTIME_CONFIG_GUARD" ]; then
  _HERMES_RUNTIME_CONFIG_GUARD="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/runtime-config-guard.py"
fi
_HERMES_GUARD_TIMEOUT=(timeout --signal=TERM --kill-after=5s 12m)
_HERMES_BOUNDARY_TIMEOUT=(timeout --signal=TERM --kill-after=2s 15s)
HERMES_RESTART_SEAL_STATE="/run/nemoclaw/hermes-restart-seal.json"
HERMES_CONFIG_MUTATION_LOCK="/run/nemoclaw/hermes-config-mutation.lock"
HERMES_RESTART_ORPHAN_MARKER="/sandbox/.hermes/.nemoclaw-hermes-restart-seal"
HERMES_STARTUP_READY_FILE="/run/nemoclaw/hermes-startup-ready"
HERMES_RESTART_SEALED=0
HERMES_RESTART_ORIGINAL_LOCKED=0
HERMES_RESTART_UNSEALING=0
HERMES_RESTART_SIGNAL_PENDING=0

# A same-container PID 1 restart can retain /run. Revoke the prior readiness
# lease before any startup migration or mutable config read; host mutations are
# admitted again only after the root supervisor is fully initialized.
if [ -e "$HERMES_STARTUP_READY_FILE" ] && ! rm -f "$HERMES_STARTUP_READY_FILE"; then
  echo "[SECURITY] Refusing Hermes startup because the stale readiness marker could not be removed" >&2
  exit 1
fi

# The seeder imports PyYAML, which ships ONLY in the Hermes venv — not in the
# base-image python3 that is first on PATH at container boot. Invoked with
# the base python3, the seeder hits its "PyYAML unavailable; skipping model
# seed" branch and returns 0, so the model routing is silently never mirrored
# into the dashboard home and the Models page shows no models.
#
# Pick the venv interpreter from a fixed trusted absolute-path list so a
# PATH-shadowed python3 (via SSH env, compromised sandbox, or malicious
# entrypoint wrapper) cannot bypass the runtime-config-guard security checks.
# The list scans first-wins ordered most-preferred first (venv > local >
# system) so the venv python3 is selected when present and falls back to
# system python3 when the sandbox image has no venv yet. The same priority
# is mirrored in `agents/hermes/hermes-wrapper.py:_TRUSTED_PYTHON3` and
# `src/lib/agent/hermes-recovery-boundary.ts:buildTrustedPython3Picker` so
# all three entry points pick the same interpreter when several are present.
# The deprecated `/opt/hermes/.venv/bin/python` symlink path is intentionally
# not consulted: it is a symlink an attacker with write access to
# /opt/hermes/.venv could repoint, while the regular files in the trusted
# list cannot be substituted without breaking the image.
_HERMES_PYTHON=""
for _candidate in /opt/hermes/.venv/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
  if [ -x "$_candidate" ]; then
    _HERMES_PYTHON="$_candidate"
    break
  fi
done
unset _candidate

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
  validate_tcp_port DASHBOARD_PUBLIC_PORT "$DASHBOARD_PUBLIC_PORT"
  validate_tcp_port DASHBOARD_INTERNAL_PORT "$DASHBOARD_INTERNAL_PORT"
  if [ "$DASHBOARD_PUBLIC_PORT" -eq "$PUBLIC_PORT" ]; then
    echo "[gateway] ERROR: DASHBOARD_PUBLIC_PORT must not equal PUBLIC_PORT (${PUBLIC_PORT})" >&2
    exit 1
  fi
  if [ "$DASHBOARD_INTERNAL_PORT" -eq "$INTERNAL_PORT" ]; then
    echo "[gateway] ERROR: DASHBOARD_INTERNAL_PORT must not equal INTERNAL_PORT (${INTERNAL_PORT})" >&2
    exit 1
  fi
  if [ "$DASHBOARD_PUBLIC_PORT" -eq "$INTERNAL_PORT" ]; then
    echo "[gateway] ERROR: DASHBOARD_PUBLIC_PORT must not equal INTERNAL_PORT (${INTERNAL_PORT})" >&2
    exit 1
  fi
  if [ "$DASHBOARD_INTERNAL_PORT" -eq "$PUBLIC_PORT" ]; then
    echo "[gateway] ERROR: DASHBOARD_INTERNAL_PORT must not equal PUBLIC_PORT (${PUBLIC_PORT})" >&2
    exit 1
  fi
}

validate_port_configuration

hermes_dashboard_tui_enabled() {
  truthy_env "$HERMES_DASHBOARD_TUI"
}

# verify_config_integrity is provided by sandbox-init.sh (parameterized).

verify_hermes_config_integrity() {
  if [ "$(id -u)" -eq 0 ]; then
    # Docker may start UID 0 without the supplementary groups declared in
    # /etc/group, and hardened runtimes can drop CAP_DAC_OVERRIDE before this
    # entrypoint runs. Verify the root-owned hash through the sandbox identity
    # that owns the mutable Hermes home.
    export -f verify_config_integrity
    "${STEP_DOWN_PREFIX_SANDBOX[@]}" bash -c "verify_config_integrity \"\$1\" \"\$2\"" bash \
      "${HERMES_DIR}" "${HERMES_HASH_FILE}"
    return $?
  fi
  verify_config_integrity "${HERMES_DIR}" "${HERMES_HASH_FILE}"
}

# configure_messaging_channels is provided by sandbox-init.sh (shared).

print_dashboard_urls() {
  local api_url dashboard_url
  api_url="http://127.0.0.1:${PUBLIC_PORT}/v1"
  dashboard_url="http://127.0.0.1:${DASHBOARD_PUBLIC_PORT}/"
  echo "[gateway] Hermes Dashboard: ${dashboard_url}" >&2
  echo "[gateway] Hermes API:       ${api_url}" >&2
  echo "[gateway] Health:           ${api_url%/v1}/health" >&2
  echo "[gateway] Connect any OpenAI-compatible frontend to this endpoint." >&2
}

hermes_fatal_unproven_child() {
  local role="$1"
  local pid="$2"
  if [ "${HERMES_STARTUP_SUPERVISOR_PID:-$$}" -eq 1 ]; then
    echo "[CRITICAL] Newly launched Hermes ${role} pid ${pid} failed exact role identity capture; exiting PID 1 for whole-container cleanup without signaling or waiting on the unproven PID" >&2
    exit 1
  fi

  # In managed OpenShell, exiting this non-root supervisor would leave PID 1
  # and the unproven child alive. Bash's job table can still wait for the exact
  # `$!` child without treating a reused numeric PID as authority to signal it.
  # Quarantine the supervisor after that child exits; only sandbox destruction
  # may tear down a process tree whose identities could not be established.
  echo "[CRITICAL] Newly launched Hermes ${role} pid ${pid} failed exact role identity capture; quarantining the managed startup supervisor without signaling the unproven child" >&2
  trap ':' TERM INT
  wait "$pid" 2>/dev/null || true
  echo "[CRITICAL] Unproven Hermes ${role} child exited; managed supervisor remains quarantined until sandbox recreation" >&2
  while :; do
    sleep 60 || true
  done
}

start_gateway_log_stream() {
  tail -n +1 -F /tmp/gateway.log 2>/dev/null | sed -u 's/^/[gateway-log:] /' >&2 &
  GATEWAY_LOG_TAIL_PID=$!
  if ! hermes_capture_tracked_role gateway-log "$GATEWAY_LOG_TAIL_PID" current; then
    hermes_fatal_unproven_child gateway-log "$GATEWAY_LOG_TAIL_PID"
  fi
}

start_dashboard_log_stream() {
  tail -n +1 -F /tmp/dashboard.log 2>/dev/null | sed -u 's/^/[dashboard-log:] /' >&2 &
  DASHBOARD_LOG_TAIL_PID=$!
  if ! hermes_capture_tracked_role dashboard-log "$DASHBOARD_LOG_TAIL_PID" current; then
    hermes_fatal_unproven_child dashboard-log "$DASHBOARD_LOG_TAIL_PID"
  fi
}

ensure_dashboard_log_stream() {
  if ! hermes_tracked_role_is_current dashboard-log "${DASHBOARD_LOG_TAIL_PID:-}" current; then
    start_dashboard_log_stream
  fi
}

ensure_gateway_log_stream() {
  if ! hermes_tracked_role_is_current gateway-log "${GATEWAY_LOG_TAIL_PID:-}" current; then
    start_gateway_log_stream
  fi
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
    *"/hermes gateway run "* | *" hermes gateway run "* | *"/hermes.real gateway run "* | *" hermes.real gateway run "*) return 0 ;;
  esac
  return 1
}

has_live_hermes_gateway() {
  local proc_root="${NEMOCLAW_PROC_ROOT:-/proc}"
  local expected_uid cmdline_file pid process_uid cmdline

  expected_uid="$(id -u)"
  if [ "$expected_uid" -eq 0 ]; then
    expected_uid="$(id -u gateway 2>/dev/null || true)"
  fi
  case "$expected_uid" in
    '' | *[!0-9]*) return 1 ;;
  esac

  for cmdline_file in "${proc_root}"/[0-9]*/cmdline; do
    [ -r "$cmdline_file" ] || continue
    pid="${cmdline_file%/cmdline}"
    process_uid="$(awk '$1 == "Uid:" { print $2; exit }' "${pid}/status" 2>/dev/null || true)"
    [ "$process_uid" = "$expected_uid" ] || continue
    cmdline="$(tr '\0' ' ' <"$cmdline_file" 2>/dev/null || true)"
    if cmdline_is_hermes_gateway "$cmdline"; then
      return 0
    fi
  done
  return 1
}

cleanup_orphan_socat_forwarders() {
  local proc_root="${NEMOCLAW_PROC_ROOT:-/proc}"
  local dashboard_public_port="${DASHBOARD_PUBLIC_PORT:-}"
  local dashboard_internal_port="${DASHBOARD_INTERNAL_PORT:-}"
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
      *socat*"TCP-LISTEN:${dashboard_public_port}"*"TCP:127.0.0.1:${dashboard_internal_port}"*)
        if [ -z "$dashboard_public_port" ] || [ -z "$dashboard_internal_port" ]; then
          continue
        fi
        echo "[gateway] Removing orphaned dashboard socat forwarder for ${dashboard_public_port}->${dashboard_internal_port} (pid ${pid})" >&2
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

hermes_locked_parent_is_protected() {
  local owner mode
  owner="$(stat -c '%U:%G' /sandbox 2>/dev/null || stat -f '%Su:%Sg' /sandbox 2>/dev/null || true)"
  mode="$(stat -c '%a' /sandbox 2>/dev/null || stat -f '%Lp' /sandbox 2>/dev/null || true)"
  case "${owner} ${mode}" in
    "root:sandbox 1775" | "root:sandbox 01775") return 0 ;;
    *) return 1 ;;
  esac
}

apply_shields_up_runtime_env() {
  local config_locked=0
  if [ "${HERMES_RESTART_SEALED:-0}" -eq 1 ]; then
    config_locked="${HERMES_RESTART_ORIGINAL_LOCKED:-0}"
  elif hermes_config_root_is_locked; then
    config_locked=1
  fi

  if [ "$config_locked" -eq 1 ]; then
    if [ -z "${HERMES_KANBAN_DISPATCH_IN_GATEWAY:-}" ]; then
      export HERMES_KANBAN_DISPATCH_IN_GATEWAY=0
      _NEMOCLAW_SET_KANBAN_DISPATCH=1
      echo "[gateway] Shields-up: HERMES_KANBAN_DISPATCH_IN_GATEWAY=0 (embedded kanban dispatcher suspended; kanban.db on locked config root is read-only)" >&2
    fi
    return 0
  fi

  if [ "${_NEMOCLAW_SET_KANBAN_DISPATCH:-0}" -eq 1 ]; then
    unset HERMES_KANBAN_DISPATCH_IN_GATEWAY
    _NEMOCLAW_SET_KANBAN_DISPATCH=0
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
    chown sandbox:sandbox "$HERMES_DIR" || return 1
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

  mkdir -p "$dir" || return 1

  if [ -L "$dir" ] || [ ! -d "$dir" ]; then
    echo "[SECURITY] Refusing Hermes layout repair because ${dir} did not resolve to a safe directory" >&2
    return 1
  fi

  if [ "$(id -u)" -eq 0 ]; then
    chown sandbox:sandbox "$dir" || return 1
  fi
  chmod "$mode" "$dir"
}

repair_hermes_log_permissions() {
  ensure_hermes_state_dir "${HERMES_DIR}/logs" 2770 || return 1
  ensure_hermes_state_dir "${HERMES_DIR}/logs/curator" 2770 || return 1

  NEMOCLAW_HERMES_LOG_DIR="${HERMES_DIR}/logs" \
    python3 - <<'PYLOGS'
import errno
import grp
import os
import pwd
import stat
import sys

root = os.environ["NEMOCLAW_HERMES_LOG_DIR"]
mode = 0o660

if not hasattr(os, "O_NOFOLLOW"):
    print("[SECURITY] Refusing Hermes log repair because O_NOFOLLOW is unavailable", file=sys.stderr)
    sys.exit(1)

root_real = os.path.realpath(root)
flags = os.O_RDONLY | os.O_NOFOLLOW
for optional_flag in ("O_CLOEXEC", "O_NONBLOCK"):
    flags |= getattr(os, optional_flag, 0)


def fail(message: str) -> None:
    print(f"[SECURITY] Refusing Hermes log repair because {message}", file=sys.stderr)
    sys.exit(1)


def describe_unsafe_existing_path(path: str) -> str:
    try:
        st = os.lstat(path)
    except OSError:
        return "could not be opened safely"
    if stat.S_ISLNK(st.st_mode):
        return "is a symlink"
    if not stat.S_ISREG(st.st_mode):
        return "is not a regular file"
    return "could not be opened safely"


def repair_file(path: str) -> None:
    try:
        current = os.lstat(path)
    except OSError as exc:
        fail(f"{path} could not be statted safely: {exc.strerror}")
    if stat.S_ISLNK(current.st_mode):
        fail(f"{path} is a symlink")
    if not stat.S_ISREG(current.st_mode):
        fail(f"{path} is not a regular file")

    try:
        fd = os.open(path, flags)
    except OSError as exc:
        reason = describe_unsafe_existing_path(path)
        detail = exc.strerror or errno.errorcode.get(exc.errno, str(exc.errno))
        fail(f"{path} {reason}: {detail}")

    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            fail(f"{path} is not a regular file")
        if st.st_nlink != 1:
            fail(f"{path} has hard-link count {st.st_nlink}")
        current = os.stat(path, follow_symlinks=False)
        if (current.st_dev, current.st_ino) != (st.st_dev, st.st_ino):
            fail(f"{path} changed during repair")
        if os.geteuid() == 0:
            try:
                uid = pwd.getpwnam("sandbox").pw_uid
                gid = grp.getgrnam("sandbox").gr_gid
            except KeyError as exc:
                fail(f"sandbox account lookup failed: {exc}")
            os.fchown(fd, uid, gid)
        os.fchmod(fd, mode)
        current = os.stat(path, follow_symlinks=False)
        if (current.st_dev, current.st_ino) != (st.st_dev, st.st_ino):
            fail(f"{path} changed during repair")
    finally:
        os.close(fd)


def on_walk_error(exc: OSError) -> None:
    fail(f"{exc.filename} could not be scanned safely: {exc.strerror}")


for dirpath, dirnames, filenames in os.walk(root, topdown=True, onerror=on_walk_error, followlinks=False):
    dir_real = os.path.realpath(dirpath)
    if os.path.commonpath([root_real, dir_real]) != root_real:
        fail(f"{dirpath} escapes {root}")
    for dirname in list(dirnames):
        entry = os.path.join(dirpath, dirname)
        try:
            st = os.lstat(entry)
        except OSError as exc:
            fail(f"{entry} could not be statted safely: {exc.strerror}")
        if stat.S_ISLNK(st.st_mode):
            fail(f"{entry} is a symlink")
        if not stat.S_ISDIR(st.st_mode):
            fail(f"{entry} is not a directory")
    for filename in filenames:
        repair_file(os.path.join(dirpath, filename))
PYLOGS
}

ensure_hermes_history_file() {
  local file="$1"
  local mode="$2"

  # Use a no-follow fd workflow instead of check-then-use shell path
  # operations. /sandbox/.hermes is intentionally sandbox-writable while
  # shields are down, so root must not validate the pathname and then later
  # chown/chmod whatever an agent swaps into that path. Python gives us
  # O_NOFOLLOW + fstat/fchown/fchmod against the actual opened inode.
  NEMOCLAW_HERMES_HISTORY_FILE="$file" \
    NEMOCLAW_HERMES_HISTORY_MODE="$mode" \
    python3 - <<'PYHISTORY'
import errno
import grp
import os
import pwd
import stat
import sys

path = os.environ["NEMOCLAW_HERMES_HISTORY_FILE"]
mode_text = os.environ["NEMOCLAW_HERMES_HISTORY_MODE"]
try:
    mode = int(mode_text, 8)
except ValueError:
    print(f"[SECURITY] Refusing Hermes layout repair because requested mode {mode_text!r} is invalid", file=sys.stderr)
    sys.exit(1)

if not hasattr(os, "O_NOFOLLOW"):
    print("[SECURITY] Refusing Hermes layout repair because O_NOFOLLOW is unavailable", file=sys.stderr)
    sys.exit(1)

flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW
for optional_flag in ("O_CLOEXEC", "O_NONBLOCK"):
    flags |= getattr(os, optional_flag, 0)


def describe_unsafe_existing_path() -> str:
    try:
        st = os.lstat(path)
    except OSError:
        return "could not be opened safely"
    if stat.S_ISLNK(st.st_mode):
        return "is a symlink"
    if not stat.S_ISREG(st.st_mode):
        return "is not a regular file"
    return "could not be opened safely"

try:
    fd = os.open(path, flags, mode)
except OSError as exc:
    reason = describe_unsafe_existing_path()
    detail = exc.strerror or errno.errorcode.get(exc.errno, str(exc.errno))
    print(f"[SECURITY] Refusing Hermes layout repair because {path} {reason}: {detail}", file=sys.stderr)
    sys.exit(1)

try:
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode):
        print(f"[SECURITY] Refusing Hermes layout repair because {path} is not a regular file", file=sys.stderr)
        sys.exit(1)

    # Reject hard-linked targets. An attacker who controls the sandbox user
    # before shields-up can pre-create .hermes_history as a hard link to
    # config.yaml or .env. O_NOFOLLOW and regular-file checks pass, so without
    # this guard fchown/fchmod would walk the shared inode and silently undo
    # the shields-up root:root 0444 lock on the config file after
    # verify_config_integrity has already passed.
    if st.st_nlink != 1:
        print(f"[SECURITY] Refusing Hermes layout repair because {path} has hard-link count {st.st_nlink}", file=sys.stderr)
        sys.exit(1)

    if os.geteuid() == 0:
        try:
            uid = pwd.getpwnam("sandbox").pw_uid
            gid = grp.getgrnam("sandbox").gr_gid
        except KeyError as exc:
            print(f"[SECURITY] Refusing Hermes layout repair because sandbox account lookup failed: {exc}", file=sys.stderr)
            sys.exit(1)
        os.fchown(fd, uid, gid)
    os.fchmod(fd, mode)

    st = os.fstat(fd)
    try:
        current = os.stat(path, follow_symlinks=False)
    except OSError as exc:
        print(f"[SECURITY] Refusing Hermes layout repair because {path} no longer names the opened history file: {exc.strerror}", file=sys.stderr)
        sys.exit(1)
    if (current.st_dev, current.st_ino) != (st.st_dev, st.st_ino):
        print(f"[SECURITY] Refusing Hermes layout repair because {path} changed during repair", file=sys.stderr)
        sys.exit(1)
finally:
    os.close(fd)
PYHISTORY
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
    ensure_hermes_history_file "${HERMES_DIR}/.hermes_history" 660 || return 1
    return 0
  fi

  ensure_hermes_config_root_mode || return 1
  repair_hermes_log_permissions || return 1
  ensure_hermes_state_dir "${HERMES_DIR}/hooks" 770 || return 1
  ensure_hermes_state_dir "${HERMES_DIR}/image_cache" 770 || return 1
  ensure_hermes_state_dir "${HERMES_DIR}/audio_cache" 770 || return 1
  ensure_hermes_history_file "${HERMES_DIR}/.hermes_history" 660 || return 1
}

cleanup_stale_hermes_gateway_runtime() {
  local runtime_dir="${HERMES_DIR}/runtime"

  if has_live_hermes_gateway; then
    echo "[gateway] Existing Hermes gateway process detected; preserving runtime lock state" >&2
    return 0
  fi

  repair_hermes_startup_layout || return 1

  # Hermes can leave gateway.lock behind after Docker GPU recreation kills the
  # old process namespace. Clear it only after confirming no gateway is alive.
  remove_stale_gateway_file "${runtime_dir}/gateway.pid" "runtime PID file"
  remove_stale_gateway_file "${HERMES_DIR}/gateway.pid" "legacy PID file"
  remove_stale_gateway_file "${runtime_dir}/gateway.lock" "lock file"
  cleanup_orphan_socat_forwarders
}

# ── socat forwarders ─────────────────────────────────────────────
# Hermes services bind to 127.0.0.1 for safety.
# OpenShell needs the port accessible on 0.0.0.0 for port forwarding.
# socat bridges 0.0.0.0:<public> to 127.0.0.1:<internal>.
SOCAT_PID=""
DASHBOARD_SOCAT_PID=""
_HERMES_PROC_ROOT="/proc"
# OpenShell owns container PID 1 and starts this script as the sandbox user in
# its managed topology. Bind every child identity to this immutable supervisor
# process rather than assuming the script itself is PID 1. Direct-container
# root entrypoints still capture 1 here.
readonly HERMES_STARTUP_SUPERVISOR_PID="$$"
GATEWAY_PID_START_IDENTITY=""
DASHBOARD_PID_START_IDENTITY=""
SOCAT_PID_START_IDENTITY=""
DASHBOARD_SOCAT_PID_START_IDENTITY=""
GATEWAY_LOG_TAIL_PID_START_IDENTITY=""
DASHBOARD_LOG_TAIL_PID_START_IDENTITY=""

hermes_role_identity_value() {
  case "$1" in
    gateway) printf '%s' "${GATEWAY_PID_START_IDENTITY:-}" ;;
    dashboard) printf '%s' "${DASHBOARD_PID_START_IDENTITY:-}" ;;
    api-socat) printf '%s' "${SOCAT_PID_START_IDENTITY:-}" ;;
    dashboard-socat) printf '%s' "${DASHBOARD_SOCAT_PID_START_IDENTITY:-}" ;;
    gateway-log) printf '%s' "${GATEWAY_LOG_TAIL_PID_START_IDENTITY:-}" ;;
    dashboard-log) printf '%s' "${DASHBOARD_LOG_TAIL_PID_START_IDENTITY:-}" ;;
    *) return 1 ;;
  esac
}

hermes_set_role_identity() {
  local role="$1"
  local value="$2"
  case "$role" in
    gateway) GATEWAY_PID_START_IDENTITY="$value" ;;
    dashboard) DASHBOARD_PID_START_IDENTITY="$value" ;;
    api-socat) SOCAT_PID_START_IDENTITY="$value" ;;
    dashboard-socat) DASHBOARD_SOCAT_PID_START_IDENTITY="$value" ;;
    gateway-log) GATEWAY_LOG_TAIL_PID_START_IDENTITY="$value" ;;
    dashboard-log) DASHBOARD_LOG_TAIL_PID_START_IDENTITY="$value" ;;
    *) return 1 ;;
  esac
}

hermes_expected_service_uid() {
  case "$1" in
    current) id -u ;;
    gateway) id -u gateway ;;
    sandbox) id -u sandbox ;;
    *) return 1 ;;
  esac
}

hermes_process_start_identity() {
  local pid="$1"
  local proc_stat
  local stat_suffix
  local expected_parent_pid="${HERMES_STARTUP_SUPERVISOR_PID:-$$}"
  local process_ppid
  local process_start

  case "$pid" in
    '' | 0 | 1 | *[!0-9]*) return 1 ;;
  esac
  [ -r "${_HERMES_PROC_ROOT}/${pid}/stat" ] || return 1
  IFS= read -r proc_stat <"${_HERMES_PROC_ROOT}/${pid}/stat" || return 1
  stat_suffix="${proc_stat##*) }"
  process_ppid="$(awk '{print $2}' <<<"$stat_suffix")"
  process_start="$(awk '{print $20}' <<<"$stat_suffix")"
  [ "$process_ppid" = "$expected_parent_pid" ] || return 1
  case "$process_start" in
    '' | *[!0-9]*) return 1 ;;
  esac
  printf '%s' "$process_start"
}

hermes_process_role_identity() {
  local role="$1"
  local pid="$2"
  local service_user="$3"
  local port="${4:-}"
  local process_start
  local expected_uid
  local effective_uid
  local cmdline

  gateway_control_pid_is_live "$pid" || return 1
  [ -r "${_HERMES_PROC_ROOT}/${pid}/status" ] \
    && [ -r "${_HERMES_PROC_ROOT}/${pid}/cmdline" ] || return 1
  process_start="$(hermes_process_start_identity "$pid")" || return 1
  expected_uid="$(hermes_expected_service_uid "$service_user")" || return 1
  effective_uid="$(awk '/^Uid:/ { print $3; exit }' "${_HERMES_PROC_ROOT}/${pid}/status")"
  [ "$effective_uid" = "$expected_uid" ] || return 1
  cmdline="$(tr '\0' ' ' <"${_HERMES_PROC_ROOT}/${pid}/cmdline")" || return 1
  case "$role" in
    gateway)
      case "$cmdline" in
        *hermes*gateway*run*) ;;
        *) return 1 ;;
      esac
      ;;
    dashboard)
      case "$cmdline" in
        *hermes*dashboard*) ;;
        *) return 1 ;;
      esac
      ;;
    api-socat | dashboard-socat)
      case "$port" in
        '' | *[!0-9]*) return 1 ;;
      esac
      case "$cmdline" in
        *socat*"TCP-LISTEN:${port},"*) ;;
        *) return 1 ;;
      esac
      ;;
    gateway-log)
      case "$cmdline" in
        *sed*gateway-log*) ;;
        *) return 1 ;;
      esac
      ;;
    dashboard-log)
      case "$cmdline" in
        *sed*dashboard-log*) ;;
        *) return 1 ;;
      esac
      ;;
    *) return 1 ;;
  esac
  printf '%s' "$process_start"
}

hermes_capture_tracked_role() {
  local role="$1"
  local pid="$2"
  local service_user="$3"
  local port="${4:-}"
  local identity
  local attempts=0
  while [ "$attempts" -lt 50 ]; do
    if identity="$(hermes_process_role_identity "$role" "$pid" "$service_user" "$port")"; then
      hermes_set_role_identity "$role" "$identity"
      return 0
    fi
    gateway_control_pid_is_live "$pid" || return 1
    sleep 0.1
    attempts=$((attempts + 1))
  done
  return 1
}

hermes_tracked_role_is_current() {
  local role="$1"
  local pid="$2"
  local service_user="$3"
  local port="${4:-}"
  local expected
  local current
  expected="$(hermes_role_identity_value "$role")" || return 1
  [ -n "$expected" ] || return 1
  current="$(hermes_process_role_identity "$role" "$pid" "$service_user" "$port")" || return 1
  [ "$current" = "$expected" ]
}

hermes_stop_tracked_role() {
  local role="$1"
  local pid="$2"
  local service_user="$3"
  local port="${4:-}"
  local expected_start_identity
  local current_start_identity
  local state
  expected_start_identity="$(hermes_role_identity_value "$role")" || return 1

  case "$pid" in
    '' | 0 | 1 | *[!0-9]*)
      # An empty role has never owned a process and is a safe no-op. A stored
      # identity paired with an invalid PID is inconsistent and must not be
      # reported as a successful stop.
      [ -z "$expected_start_identity" ] && return 0
      return 1
      ;;
  esac
  [ -n "$expected_start_identity" ] || return 1

  if ! hermes_tracked_role_is_current "$role" "$pid" "$service_user" "$port"; then
    # Distinguish a child that is definitely gone from a live/reused/unreadable
    # numeric PID. Only the former is a successful no-op. A matching zombie is
    # still the exact tracked child and the shared helper can reap it safely.
    current_start_identity="$(hermes_process_start_identity "$pid" 2>/dev/null || true)"
    if [ -n "$current_start_identity" ]; then
      if [ "$current_start_identity" != "$expected_start_identity" ]; then
        echo "[SECURITY] Hermes ${role} pid ${pid} was reused; refusing to signal or treat it as stopped" >&2
        return 1
      fi
      state="$(gateway_control_pid_state "$pid" 2>/dev/null || true)"
      case "$state" in
        Z*) ;;
        *)
          echo "[SECURITY] Hermes ${role} pid ${pid} still has its captured start identity but its role cannot be proven; refusing to signal or treat it as stopped" >&2
          return 1
          ;;
      esac
    elif kill -0 "$pid" 2>/dev/null; then
      echo "[SECURITY] Hermes ${role} pid ${pid} is live but its start identity cannot be proven; refusing to signal or treat it as stopped" >&2
      return 1
    else
      hermes_set_role_identity "$role" ""
      return 0
    fi
  fi

  gateway_control_stop_tracked_pid "$pid" "$expected_start_identity" || return 1
  if kill -0 "$pid" 2>/dev/null; then
    # The shared helper may return success when its final identity read says
    # the numeric PID was replaced. That is sufficient for ordinary cleanup,
    # but not for a gateway revocation that is about to mark the role stopped
    # and relaunch. Require the numeric PID to be absent as a postcondition.
    echo "[SECURITY] Hermes ${role} pid ${pid} remains live after tracked stop; refusing to treat it as stopped" >&2
    return 1
  fi
  hermes_set_role_identity "$role" ""
}

hermes_tracked_service_owns_listener() {
  local pid="$1"
  local port="$2"
  local service_user="$3"

  if [ "$(id -u)" -ne 0 ] || [ "$service_user" = "current" ]; then
    gateway_control_pid_owns_tcp_listener "$pid" "$port"
    return $?
  fi
  case "$service_user" in
    gateway)
      # shellcheck disable=SC2016  # positional args expand in the stepped-down shell
      "${STEP_DOWN_PREFIX_GATEWAY[@]}" env -u BASH_ENV \
        bash --noprofile --norc -c \
        'source "$1"; gateway_control_pid_owns_tcp_listener "$2" "$3"' \
        bash "$_GATEWAY_SUPERVISOR" "$pid" "$port"
      ;;
    sandbox)
      # shellcheck disable=SC2016  # positional args expand in the stepped-down shell
      "${STEP_DOWN_PREFIX_SANDBOX[@]}" env -u BASH_ENV \
        bash --noprofile --norc -c \
        'source "$1"; gateway_control_pid_owns_tcp_listener "$2" "$3"' \
        bash "$_GATEWAY_SUPERVISOR" "$pid" "$port"
      ;;
    *) return 1 ;;
  esac
}

start_socat_forwarder() {
  local public_port="$1"
  local internal_port="$2"
  local label="$3"
  local pid_var="${4:-SOCAT_PID}"
  local owner_pid="${5:-}"
  local owner_user="${6:-current}"
  local _socat_pid
  local _socat_role=""
  local owner_role=""

  case "$owner_user" in
    gateway) owner_role=gateway ;;
    sandbox) owner_role=dashboard ;;
    current)
      if [ "$internal_port" = "$INTERNAL_PORT" ]; then
        owner_role=gateway
      elif [ "$internal_port" = "$DASHBOARD_INTERNAL_PORT" ]; then
        owner_role=dashboard
      fi
      ;;
  esac

  if ! command -v socat >/dev/null 2>&1; then
    echo "[gateway] socat not available - ${label} port forwarding from host may not work" >&2
    return
  fi
  local attempts=0
  local internal_ready=0
  while [ "$attempts" -lt 30 ]; do
    if [ -n "$owner_pid" ]; then
      if [ -z "$owner_role" ] \
        || ! hermes_tracked_role_is_current \
          "$owner_role" "$owner_pid" "$owner_user" "$internal_port"; then
        echo "[gateway] ${label} service owner pid ${owner_pid} exited before binding 127.0.0.1:${internal_port}" >&2
        return 1
      fi
      if hermes_tracked_service_owns_listener "$owner_pid" "$internal_port" "$owner_user"; then
        internal_ready=1
        break
      fi
    elif ss -tln 2>/dev/null | grep -q "127.0.0.1:${internal_port}"; then
      # Compatibility for non-supervised callers; PID 1 production paths pass
      # an exact owner PID and never rely on this transport-only fallback.
      internal_ready=1
      break
    fi
    sleep 1
    attempts=$((attempts + 1))
  done
  if [ "$internal_ready" -ne 1 ]; then
    echo "[gateway] ${label} service did not bind 127.0.0.1:${internal_port}; refusing to publish an empty forward" >&2
    return 1
  fi
  nohup socat TCP-LISTEN:"${public_port}",bind=0.0.0.0,fork,reuseaddr \
    TCP:127.0.0.1:"${internal_port}" >/dev/null 2>&1 &
  _socat_pid=$!
  sleep 0.1
  if ! gateway_control_pid_is_live "$_socat_pid"; then
    wait "$_socat_pid" 2>/dev/null || true
    echo "[gateway] ${label} socat forwarder failed to stay running on 0.0.0.0:${public_port}" >&2
    return 1
  fi
  case "$pid_var" in
    SOCAT_PID)
      _socat_role=api-socat
      if ! hermes_capture_tracked_role api-socat "$_socat_pid" current "$public_port"; then
        hermes_set_role_identity api-socat ""
        hermes_fatal_unproven_child api-socat "$_socat_pid"
      fi
      ;;
    DASHBOARD_SOCAT_PID)
      _socat_role=dashboard-socat
      if ! hermes_capture_tracked_role dashboard-socat "$_socat_pid" current "$public_port"; then
        hermes_set_role_identity dashboard-socat ""
        hermes_fatal_unproven_child dashboard-socat "$_socat_pid"
      fi
      ;;
  esac
  attempts=0
  while [ "$attempts" -lt 30 ]; do
    gateway_control_pid_owns_tcp_listener "$_socat_pid" "$public_port" && break
    gateway_control_pid_is_live "$_socat_pid" || break
    sleep 0.1
    attempts=$((attempts + 1))
  done
  if ! gateway_control_pid_owns_tcp_listener "$_socat_pid" "$public_port"; then
    if [ -n "$_socat_role" ]; then
      hermes_stop_tracked_role "$_socat_role" "$_socat_pid" current "$public_port" || true
    fi
    echo "[gateway] ${label} socat process did not own 0.0.0.0:${public_port}" >&2
    return 1
  fi
  printf -v "$pid_var" '%s' "$_socat_pid"
  echo "[gateway] ${label} socat forwarder 0.0.0.0:${public_port} -> 127.0.0.1:${internal_port} (pid ${_socat_pid})" >&2
}

build_hermes_dashboard_args() {
  HERMES_DASHBOARD_ARGS=(
    dashboard
    --host
    127.0.0.1
    --port
    "$DASHBOARD_INTERNAL_PORT"
    --skip-build
    --no-open
  )
  if hermes_dashboard_tui_enabled; then
    HERMES_DASHBOARD_ARGS+=(--tui)
  fi
}

prepare_hermes_dashboard_home() {
  local owner="${1:-}"
  local rc=0
  if [ "$(id -u)" -eq 0 ] && [ -n "$owner" ]; then
    # Root starts the dashboard service, but the dashboard home is sandbox-owned
    # mutable state. Do every path-touching operation after step-down so root
    # never follows, creates, chowns, chmods, or deletes through a
    # sandbox-controlled dashboard-home path. Remove this branch only if
    # dashboard home creation moves into a trusted image-build step.
    # shellcheck disable=SC2016  # inner shell expands after sandbox step-down
    env HERMES_DIR="$HERMES_DIR" \
      HERMES_DASHBOARD_HOME="$HERMES_DASHBOARD_HOME" \
      _HERMES_PYTHON="$_HERMES_PYTHON" \
      _HERMES_DASHBOARD_CONFIG_SEEDER="$_HERMES_DASHBOARD_CONFIG_SEEDER" \
      "${STEP_DOWN_PREFIX_SANDBOX[@]}" sh -c '
        if [ -L "$HERMES_DASHBOARD_HOME" ]; then
          echo "[SECURITY] Refusing Hermes dashboard startup because ${HERMES_DASHBOARD_HOME} is a symlink" >&2
          exit 1
        fi
        mkdir -p "$HERMES_DASHBOARD_HOME" || exit 1
        if [ -L "$HERMES_DASHBOARD_HOME" ] || [ ! -d "$HERMES_DASHBOARD_HOME" ]; then
          echo "[SECURITY] Refusing Hermes dashboard startup because ${HERMES_DASHBOARD_HOME} is not a safe directory" >&2
          exit 1
        fi
        chmod 700 "$HERMES_DASHBOARD_HOME" || exit 1
        # The dashboard can attempt a gateway restart from its isolated
        # HERMES_HOME. In NemoClaw the real gateway lives under /sandbox/.hermes,
        # so a failed dashboard-scoped restart can leave stale startup_failed
        # state that poisons /api/status even while the real gateway is healthy.
        rm -f "${HERMES_DASHBOARD_HOME}/gateway_state.json" 2>/dev/null || true
        exec "$_HERMES_PYTHON" "$_HERMES_DASHBOARD_CONFIG_SEEDER" \
          "${HERMES_DIR}/config.yaml" "${HERMES_DASHBOARD_HOME}/config.yaml" \
          "${HERMES_DIR}/.env" "${HERMES_DASHBOARD_HOME}/.env"
      ' || rc=$?
    if [ "$rc" -ne 0 ]; then
      echo "[dashboard] ERROR: config seed exited ${rc}; refusing dashboard startup" >&2
      return "$rc"
    fi
    return 0
  fi

  if [ -L "$HERMES_DASHBOARD_HOME" ]; then
    echo "[SECURITY] Refusing Hermes dashboard startup because ${HERMES_DASHBOARD_HOME} is a symlink" >&2
    return 1
  fi
  mkdir -p "$HERMES_DASHBOARD_HOME" || return 1
  if [ -L "$HERMES_DASHBOARD_HOME" ] || [ ! -d "$HERMES_DASHBOARD_HOME" ]; then
    echo "[SECURITY] Refusing Hermes dashboard startup because ${HERMES_DASHBOARD_HOME} is not a safe directory" >&2
    return 1
  fi
  chmod 700 "$HERMES_DASHBOARD_HOME" || return 1
  seed_hermes_dashboard_config
}

# Mirror the gateway's model routing and dotenv context into the dashboard's
# isolated HERMES_HOME so its Models page (/api/model/options), Chat/TUI setup
# checks, and kanban specifier/dispatcher resolve the routed model. The
# dashboard runs under HERMES_DASHBOARD_HOME for privilege separation and
# otherwise only sees a Hermes-default config with an empty model. Idempotent:
# refreshes the keys on every launch. Missing gateway config is a benign no-op
# in the seeder; security refusals and write failures abort startup.
seed_hermes_dashboard_config() {
  local dst="${HERMES_DASHBOARD_HOME}/config.yaml"
  local env_dst="${HERMES_DASHBOARD_HOME}/.env"
  local rc=0

  # Non-root and explicit same-user launches perform cleanup and seeding under
  # the current service user; root launches run the equivalent block inside
  # prepare_hermes_dashboard_home after stepping down to the sandbox identity.
  rm -f "${HERMES_DASHBOARD_HOME}/gateway_state.json" 2>/dev/null || true
  env "$_HERMES_PYTHON" "$_HERMES_DASHBOARD_CONFIG_SEEDER" \
    "${HERMES_DIR}/config.yaml" "$dst" \
    "${HERMES_DIR}/.env" "$env_dst" || rc=$?

  if [ "$rc" -ne 0 ]; then
    echo "[dashboard] ERROR: config seed exited ${rc}; refusing dashboard startup" >&2
    return "$rc"
  fi
}

start_hermes_dashboard_current_user() {
  build_hermes_dashboard_args || return 1
  prepare_hermes_dashboard_home "" || return 1
  prepare_restricted_log /tmp/dashboard.log "" 600 || return 1
  HERMES_HOME="${HERMES_DASHBOARD_HOME}" \
    GATEWAY_HEALTH_URL="http://127.0.0.1:${INTERNAL_PORT}" \
    nohup "$HERMES" "${HERMES_DASHBOARD_ARGS[@]}" >/tmp/dashboard.log 2>&1 &
  DASHBOARD_PID=$!
  echo "[gateway] hermes dashboard launched (pid $DASHBOARD_PID)" >&2
  if ! hermes_capture_tracked_role dashboard "$DASHBOARD_PID" current "$DASHBOARD_INTERNAL_PORT"; then
    hermes_fatal_unproven_child dashboard "$DASHBOARD_PID"
  fi
  ensure_dashboard_log_stream || return 1
  start_socat_forwarder \
    "$DASHBOARD_PUBLIC_PORT" "$DASHBOARD_INTERNAL_PORT" "dashboard" DASHBOARD_SOCAT_PID \
    "$DASHBOARD_PID" current
}

start_hermes_dashboard_sandbox_user() {
  build_hermes_dashboard_args || return 1
  prepare_hermes_dashboard_home sandbox:sandbox || return 1
  prepare_restricted_log /tmp/dashboard.log sandbox:sandbox 600 || return 1
  HERMES_HOME="${HERMES_DASHBOARD_HOME}" \
    GATEWAY_HEALTH_URL="http://127.0.0.1:${INTERNAL_PORT}" \
    nohup "${STEP_DOWN_PREFIX_SANDBOX[@]}" sh -c 'umask 0077; exec "$@" >/tmp/dashboard.log 2>&1' sh "$HERMES" "${HERMES_DASHBOARD_ARGS[@]}" &
  DASHBOARD_PID=$!
  echo "[gateway] hermes dashboard launched as 'sandbox' user (pid $DASHBOARD_PID)" >&2
  if ! hermes_capture_tracked_role dashboard "$DASHBOARD_PID" sandbox "$DASHBOARD_INTERNAL_PORT"; then
    hermes_fatal_unproven_child dashboard "$DASHBOARD_PID"
  fi
  ensure_dashboard_log_stream || return 1
  start_socat_forwarder \
    "$DASHBOARD_PUBLIC_PORT" "$DASHBOARD_INTERNAL_PORT" "dashboard" DASHBOARD_SOCAT_PID \
    "$DASHBOARD_PID" sandbox
}

wait_for_hermes_gateway_internal() {
  local gateway_pid="$1"
  local deadline=$((SECONDS + 90))
  local code
  local service_user=current
  [ "$(id -u)" -eq 0 ] && service_user=gateway
  while [ "$SECONDS" -lt "$deadline" ]; do
    # Status-code extraction (not curl -sf) so a 401 counts as alive: Hermes
    # v0.16.0+ may guard the api_server with API_SERVER_KEY, and the probe is
    # unauthenticated. A 401 still proves the gateway is bound and serving.
    # Mirrors GATEWAY_ALIVE_CODES in src/lib/verify-deployment.ts.
    if hermes_tracked_role_is_current gateway "$gateway_pid" "$service_user" "$INTERNAL_PORT" \
      && hermes_tracked_service_owns_listener "$gateway_pid" "$INTERNAL_PORT" "$service_user"; then
      code=$(curl -so /dev/null -w '%{http_code}' --max-time 2 \
        "http://127.0.0.1:${INTERNAL_PORT}/health" 2>/dev/null || echo 000)
      case "$code" in
        200 | 401) return 0 ;;
      esac
    fi
    if ! hermes_tracked_role_is_current gateway "$gateway_pid" "$service_user" "$INTERNAL_PORT"; then
      wait "$gateway_pid"
      return $?
    fi
    sleep 1
  done
  echo "[gateway] Hermes gateway did not become healthy on internal port ${INTERNAL_PORT}" >&2
  return 1
}

restore_hermes_config_permissions_after_dashboard_start() {
  [ "$(id -u)" -eq 0 ] || return 0
  # Hermes dashboard startup may tighten HERMES_HOME to 0700 because it runs as
  # the sandbox owner. The gateway process runs as the separate gateway user and
  # reads config via sandbox-group membership, so restore NemoClaw's shared
  # mutable-root mode after the dashboard has performed its startup checks.
  local attempts=0
  while [ "$attempts" -lt 5 ]; do
    ensure_hermes_config_root_mode || return 1
    attempts=$((attempts + 1))
    sleep 1
  done
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
    cat <<'TUIENVEOF'
if [ -f /opt/hermes/ui-tui/dist/entry.js ]; then
  export HERMES_TUI_DIR="/opt/hermes/ui-tui"
fi
TUIENVEOF
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
  local mode="${1:-strict}"
  local env_file="${HERMES_DIR}/.env"
  local runtime_plan="/usr/local/share/nemoclaw/messaging-runtime-plan.json"
  [ -f "$env_file" ] || return 0

  local args=(
    "$_HERMES_RUNTIME_CONFIG_GUARD" provider-placeholders
    --hermes-dir "$HERMES_DIR"
    --hash-file "$HERMES_HASH_FILE"
    --boundary-validator "$_HERMES_BOUNDARY_VALIDATOR"
    --mode "$mode"
    --startup-owner
  )
  if [ -f "$runtime_plan" ]; then
    args+=(--runtime-plan "$runtime_plan")
  fi
  "$_HERMES_PYTHON" -I "${args[@]}"
  validate_hermes_env_secret_boundary
}

refresh_hermes_runtime_config_hashes() {
  local mode="${1:-strict}"
  local cmd=(
    "$_HERMES_PYTHON" -I "$_HERMES_RUNTIME_CONFIG_GUARD" refresh-hashes
    --hermes-dir "$HERMES_DIR"
    --hash-file "$HERMES_HASH_FILE"
    --mode "$mode"
    --startup-owner
  )
  if [ "$mode" = "compat" ] && [ "$(id -u)" -eq 0 ]; then
    "${STEP_DOWN_PREFIX_SANDBOX[@]}" "${cmd[@]}"
    return $?
  fi
  "${cmd[@]}"
}

ensure_hermes_runtime_api_server_key() {
  local mode="${1:-strict}"
  local env_file="${HERMES_DIR}/.env"
  local result_file
  local guard_status
  [ -f "$env_file" ] || return 0

  local result
  if [ "$EUID" -eq 0 ] && [ -d /run/nemoclaw ] && [ -w /run/nemoclaw ]; then
    result_file="$(mktemp /run/nemoclaw/hermes-api-key-result.XXXXXX)" || return 1
  else
    result_file="$(mktemp "${TMPDIR:-/tmp}/hermes-api-key-result.XXXXXX")" || return 1
  fi
  chmod 600 "$result_file" || {
    rm -f "$result_file"
    return 1
  }
  # Keep the guard as the startup owner's direct child: --startup-owner is
  # authenticated by exact parent identity. Its own alarm bounds this call;
  # wrapping it in `timeout` would interpose a different parent process.
  if "$_HERMES_PYTHON" -I "$_HERMES_RUNTIME_CONFIG_GUARD" ensure-api-key \
    --hermes-dir "$HERMES_DIR" \
    --hash-file "$HERMES_HASH_FILE" \
    --mode "$mode" \
    --startup-owner >"$result_file"; then
    guard_status=0
  else
    guard_status=$?
  fi
  IFS= read -r result <"$result_file" || result=""
  rm -f "$result_file"
  [ "$guard_status" -eq 0 ] || return "$guard_status"

  case "$result" in
    minted=0) return 0 ;;
    updated=1)
      if [ "$mode" = "strict" ]; then
        refresh_hermes_runtime_config_hashes compat
      fi
      return 0
      ;;
    minted=1) ;;
    *)
      echo "[config] Unexpected Hermes API key mint result: ${result}" >&2
      return 1
      ;;
  esac

  if [ "$mode" = "strict" ]; then
    refresh_hermes_runtime_config_hashes compat
  fi
  echo "[config] Minted Hermes API_SERVER_KEY for this sandbox and refreshed config hash" >&2
}

validate_hermes_env_secret_boundary() {
  local env_file="${HERMES_DIR}/.env"
  if [ -L "$env_file" ]; then
    echo "[SECURITY] Refusing Hermes startup because ${env_file} is a symlink" >&2
    return 1
  fi
  # `_HERMES_PYTHON` was resolved from the trusted absolute-path list earlier;
  # use it here so a PATH-shadowed `python3` cannot substitute the validator.
  "${_HERMES_BOUNDARY_TIMEOUT[@]}" \
    "$_HERMES_PYTHON" -I "$_HERMES_BOUNDARY_VALIDATOR" env-file "$env_file"
}

validate_hermes_runtime_env_secret_boundary() {
  "${_HERMES_BOUNDARY_TIMEOUT[@]}" \
    "$_HERMES_PYTHON" -I "$_HERMES_BOUNDARY_VALIDATOR" runtime-env
}

hermes_gateway_healthy() {
  local pid="$1"
  local code
  local service_user=current
  [ "$(id -u)" -eq 0 ] && service_user=gateway
  hermes_tracked_role_is_current gateway "$pid" "$service_user" "$INTERNAL_PORT" || return 1
  code="$(curl -so /dev/null -w '%{http_code}' --max-time 2 \
    "http://127.0.0.1:${INTERNAL_PORT}/health" 2>/dev/null || echo 000)"
  case "$code" in
    200 | 401) hermes_tracked_service_owns_listener "$pid" "$INTERNAL_PORT" gateway ;;
    *) return 1 ;;
  esac
}

HERMES_RESTART_FAILURE_CODE=internal

validate_running_hermes_boundary() {
  HERMES_RESTART_FAILURE_CODE=validator-missing
  [ -f "$_HERMES_BOUNDARY_VALIDATOR" ] || return 1
  HERMES_RESTART_FAILURE_CODE=secret-boundary-refusal
  validate_hermes_env_secret_boundary || return 1
  validate_hermes_runtime_env_secret_boundary || return 1
  HERMES_RESTART_FAILURE_CODE=preload-missing
  # shellcheck disable=SC2119
  validate_tmp_permissions || return 1
}

prepare_hermes_gateway_restart() {
  if ! validate_running_hermes_boundary; then
    return 1
  fi

  # A restart is a lifecycle action, not authority to bless arbitrary bytes
  # written by the sandbox user. Supported host config commands refresh the
  # root-owned strict hash when they make a change; direct in-sandbox edits do
  # not. Require that trusted anchor for both mutable-default and shields-up
  # sandboxes instead of chowning attacker-controlled paths or adopting a new
  # hash here.
  HERMES_RESTART_FAILURE_CODE=hash-mismatch
  verify_hermes_config_integrity
}

hermes_restart_unseal_on_exit() {
  [ "$HERMES_RESTART_SEALED" -eq 1 ] || return 0
  [ "$HERMES_RESTART_UNSEALING" -eq 0 ] || return 1
  unseal_hermes_restart_inputs || true
}

hermes_restart_cleanup_on_signal() {
  if [ "$HERMES_RESTART_UNSEALING" -eq 1 ]; then
    HERMES_RESTART_SIGNAL_PENDING=1
    return 0
  fi
  stop_hermes_gateway_fail_closed
  if [ "$HERMES_RESTART_SEALED" -eq 1 ]; then
    unseal_hermes_restart_inputs || true
  fi
  refresh_hermes_supervised_child_pids
  hermes_cleanup_on_signal
}

install_hermes_restart_seal_traps() {
  trap hermes_restart_unseal_on_exit EXIT
  trap hermes_restart_cleanup_on_signal SIGTERM SIGINT HUP
}

restore_hermes_runtime_traps() {
  trap - EXIT HUP
  trap hermes_cleanup_on_signal SIGTERM SIGINT
}

seal_hermes_restart_inputs() {
  local output
  local owner_output
  local original_failure_code
  HERMES_RESTART_FAILURE_CODE=unsafe-config
  HERMES_RESTART_SEALED=0
  install_hermes_restart_seal_traps
  if ! output="$(
    ${_HERMES_GUARD_TIMEOUT[@]+"${_HERMES_GUARD_TIMEOUT[@]}"} "$_HERMES_PYTHON" -I "$_HERMES_RUNTIME_CONFIG_GUARD" seal-restart \
      --hermes-dir "$HERMES_DIR" \
      --hash-file "$HERMES_HASH_FILE" \
      --state-file "$HERMES_RESTART_SEAL_STATE" \
      --lock-token "$GATEWAY_CONTROL_NONCE" 2>&1
  )"; then
    printf '%s\n' "$output" >&2
    case "$output" in
      *"strict hash verification failed"*) HERMES_RESTART_FAILURE_CODE=hash-mismatch ;;
    esac
    # The guard normally rolls back failures it owns. If rollback itself was
    # interrupted, recover only a state whose cryptographic token is this
    # request nonce. A concurrent config/shields transaction has a different
    # token and must never be unsealed or used as authority to stop the healthy
    # gateway.
    original_failure_code="$HERMES_RESTART_FAILURE_CODE"
    if owner_output="$(
      ${_HERMES_GUARD_TIMEOUT[@]+"${_HERMES_GUARD_TIMEOUT[@]}"} "$_HERMES_PYTHON" -I "$_HERMES_RUNTIME_CONFIG_GUARD" inspect-mutation-owner \
        --hermes-dir "$HERMES_DIR" \
        --state-file "$HERMES_RESTART_SEAL_STATE" \
        --lock-token "$GATEWAY_CONTROL_NONCE" 2>&1
    )"; then
      case "$owner_output" in
        *"token_match=1"*)
          case "$owner_output" in
            *"original_locked=1"*) HERMES_RESTART_ORIGINAL_LOCKED=1 ;;
            *) HERMES_RESTART_ORIGINAL_LOCKED=0 ;;
          esac
          HERMES_RESTART_SEALED=1
          if unseal_hermes_restart_inputs; then
            HERMES_RESTART_FAILURE_CODE="$original_failure_code"
          fi
          return 1
          ;;
      esac
    else
      printf '%s\n' "$owner_output" >&2
    fi
    restore_hermes_runtime_traps
    return 1
  fi
  case "$output" in
    *"original_locked=1"*) HERMES_RESTART_ORIGINAL_LOCKED=1 ;;
    *) HERMES_RESTART_ORIGINAL_LOCKED=0 ;;
  esac
  HERMES_RESTART_SEALED=1
}

unseal_hermes_restart_inputs() {
  local output
  if [ "$HERMES_RESTART_SEALED" -ne 1 ] && [ ! -e "$HERMES_RESTART_SEAL_STATE" ]; then
    return 0
  fi
  if [ "$HERMES_RESTART_UNSEALING" -eq 1 ]; then
    HERMES_RESTART_FAILURE_CODE=unsafe-config
    return 1
  fi
  HERMES_RESTART_UNSEALING=1
  trap 'HERMES_RESTART_SIGNAL_PENDING=1' SIGTERM SIGINT HUP
  if ! output="$(
    ${_HERMES_GUARD_TIMEOUT[@]+"${_HERMES_GUARD_TIMEOUT[@]}"} "$_HERMES_PYTHON" -I "$_HERMES_RUNTIME_CONFIG_GUARD" unseal-restart \
      --hermes-dir "$HERMES_DIR" \
      --state-file "$HERMES_RESTART_SEAL_STATE" 2>&1
  )"; then
    printf '%s\n' "$output" >&2
    HERMES_RESTART_FAILURE_CODE=unsafe-config
    HERMES_RESTART_UNSEALING=0
    trap hermes_restart_cleanup_on_signal SIGTERM SIGINT HUP
    if [ "$HERMES_RESTART_SIGNAL_PENDING" -eq 1 ]; then
      # Do not recursively retry an unseal that just failed. Retain the token,
      # clear the EXIT retry, and honor the deferred stop signal fail-closed.
      HERMES_RESTART_SIGNAL_PENDING=0
      trap - EXIT HUP TERM INT
      refresh_hermes_supervised_child_pids
      hermes_cleanup_on_signal
    fi
    return 1
  fi
  HERMES_RESTART_SEALED=0
  HERMES_RESTART_UNSEALING=0
  restore_hermes_runtime_traps
  if [ "$HERMES_RESTART_SIGNAL_PENDING" -eq 1 ]; then
    HERMES_RESTART_SIGNAL_PENDING=0
    hermes_cleanup_on_signal
  fi
}

stop_hermes_gateway_fail_closed() {
  if ! hermes_stop_tracked_role gateway "${GATEWAY_PID:-0}" gateway "$INTERNAL_PORT"; then
    echo "[CRITICAL] Hermes gateway revocation could not prove and stop the tracked child; exiting PID 1 for whole-container cleanup without signaling the unproven PID" >&2
    exit 1
  fi
  mark_hermes_gateway_stopped
}

hermes_restart_seal_orphaned() {
  local marker_meta
  local sandbox_meta

  [ ! -e "$HERMES_RESTART_SEAL_STATE" ] || return 1
  marker_meta="$(stat -c '%u:%g %a' "$HERMES_RESTART_ORPHAN_MARKER" 2>/dev/null || true)"
  sandbox_meta="$(stat -c '%u:%g %a' /sandbox 2>/dev/null || true)"
  # Mutable mode keeps /sandbox sandbox-owned. Locked mode deliberately uses
  # root:sandbox with the sticky bit so the sandbox user cannot rename the
  # root-owned .hermes entry. Only an in-flight transaction uses root:root;
  # that remains the durable discriminator when `/run` recovery state is lost.
  case "$marker_meta" in
    "0:0 400") ;;
    *)
      case "$sandbox_meta" in
        "0:0 "*) ;;
        *) return 1 ;;
      esac
      ;;
  esac

  # Hash validation only enriches the diagnostic. Never let missing/partial
  # child seal state turn the recognized orphan transaction into normal start.
  if ! verify_hermes_config_integrity; then
    echo "[SECURITY] Orphaned Hermes restart seal also failed strict hash validation" >&2
  fi
  return 0
}

resume_startup_hermes_shields_lock() {
  local result_file
  local begin_output
  local lock_token

  result_file="$(mktemp "$(dirname "$HERMES_RESTART_SEAL_STATE")/hermes-shields-resume.XXXXXX")" || return 1
  chmod 600 "$result_file" || {
    rm -f "$result_file"
    return 1
  }
  # These guard calls must remain direct PID 1 children. The internal Python
  # alarm is their deadline; the recursive helper is separately wrapped by the
  # container-side timeout because it has no startup-owner parent contract.
  if ! "$_HERMES_PYTHON" -I "$_HERMES_RUNTIME_CONFIG_GUARD" begin-shields-transition \
    --hermes-dir "$HERMES_DIR" \
    --hash-file "$HERMES_HASH_FILE" \
    --state-file "$HERMES_RESTART_SEAL_STATE" \
    --shields-mode locked \
    --startup-owner >"$result_file"; then
    rm -f "$result_file"
    return 1
  fi
  IFS= read -r begin_output <"$result_file" || begin_output=""
  rm -f "$result_file"
  case "$begin_output" in
    lock_token=*" original_locked="[01])
      lock_token="${begin_output#lock_token=}"
      lock_token="${lock_token%% *}"
      ;;
    *)
      echo "[SECURITY] Invalid Hermes shields resume response" >&2
      return 1
      ;;
  esac
  if [ "${#lock_token}" -ne 64 ]; then
    echo "[SECURITY] Invalid Hermes shields resume token" >&2
    return 1
  fi
  case "$lock_token" in
    *[!0-9a-f]*)
      echo "[SECURITY] Invalid Hermes shields resume token" >&2
      return 1
      ;;
  esac

  "$_HERMES_PYTHON" -I "$_HERMES_RUNTIME_CONFIG_GUARD" run-state-dir-transition \
    --hermes-dir "$HERMES_DIR" \
    --state-file "$HERMES_RESTART_SEAL_STATE" \
    --state-action lock \
    --lock-token "$lock_token" \
    --startup-owner || return 1
  "$_HERMES_PYTHON" -I "$_HERMES_RUNTIME_CONFIG_GUARD" apply-shields-transition \
    --hermes-dir "$HERMES_DIR" \
    --state-file "$HERMES_RESTART_SEAL_STATE" \
    --lock-token "$lock_token" \
    --startup-owner >/dev/null || return 1
  "$_HERMES_PYTHON" -I "$_HERMES_RUNTIME_CONFIG_GUARD" finish-shields-transition \
    --hermes-dir "$HERMES_DIR" \
    --hash-file "$HERMES_HASH_FILE" \
    --state-file "$HERMES_RESTART_SEAL_STATE" \
    --lock-token "$lock_token" \
    --startup-owner >/dev/null
}

recover_startup_hermes_mutation() {
  local attempts=0
  local owner_output

  while [ -e "$HERMES_CONFIG_MUTATION_LOCK" ] || [ -e "$HERMES_RESTART_SEAL_STATE" ]; do
    if ! owner_output="$(
      ${_HERMES_GUARD_TIMEOUT[@]+"${_HERMES_GUARD_TIMEOUT[@]}"} "$_HERMES_PYTHON" -I "$_HERMES_RUNTIME_CONFIG_GUARD" inspect-mutation-owner \
        --hermes-dir "$HERMES_DIR" \
        --state-file "$HERMES_RESTART_SEAL_STATE" 2>&1
    )"; then
      printf '%s\n' "$owner_output" >&2
      return 1
    fi

    case "$owner_output" in
      *"resumable_lock=1"*)
        if resume_startup_hermes_shields_lock; then
          echo "[security] Resumed interrupted Hermes shields lock before startup" >&2
          attempts=0
          continue
        fi
        echo "[SECURITY] HERMES_SHIELDS_RESUME_PENDING: the root-only shields clamp remains active; retry sandbox startup after the recursive guard can complete" >&2
        return 1
        ;;
    esac

    case "$owner_output" in
      *"owner_active=1"*)
        attempts=$((attempts + 1))
        if [ "$attempts" -ge 300 ]; then
          echo "[SECURITY] HERMES_CONFIG_MUTATION_BUSY: a root config transaction is still active; retry sandbox startup after it finishes" >&2
          return 1
        fi
        sleep 0.1
        continue
        ;;
    esac

    case "$owner_output" in
      *"state=1"*)
        case "$owner_output" in
          *"recovery_safe=0"*)
            echo "[SECURITY] HERMES_CONFIG_MUTATION_ORPHANED: an interrupted shields transition is sealed fail-closed; restore from a trusted backup and recreate the sandbox (an in-place rebuild cannot read the sealed state)" >&2
            return 1
            ;;
        esac
        # The recorded owner is gone. Recovery is now exclusively owned by PID
        # 1; restore the exact metadata/digest transaction before startup reads
        # any mutable Hermes path.
        HERMES_RESTART_SEALED=1
        install_hermes_restart_seal_traps
        unseal_hermes_restart_inputs || return 1
        ;;
      *"lock=1"*)
        if "$_HERMES_PYTHON" -I "$_HERMES_RUNTIME_CONFIG_GUARD" recover-prestate-lock \
          --hermes-dir "$HERMES_DIR" \
          --state-file "$HERMES_RESTART_SEAL_STATE" \
          --startup-owner >/dev/null; then
          echo "[security] Removed a dead Hermes pre-state mutation lock" >&2
          attempts=0
          continue
        fi
        echo "[SECURITY] HERMES_CONFIG_MUTATION_ORPHANED: mutation lock recovery failed; retry startup or restore from a trusted backup" >&2
        return 1
        ;;
      *) return 0 ;;
    esac
  done
}

hermes_socat_bridge_healthy() {
  local role="$1"
  local pid="$2"
  local port="$3"
  hermes_tracked_role_is_current "$role" "$pid" current "$port" || return 1
  gateway_control_pid_owns_tcp_listener "$pid" "$port"
}

hermes_dashboard_healthy() {
  local pid="$1"
  local code
  local service_user=current
  [ "$(id -u)" -eq 0 ] && service_user=sandbox
  hermes_tracked_role_is_current dashboard "$pid" "$service_user" "$DASHBOARD_INTERNAL_PORT" || return 1
  hermes_tracked_service_owns_listener "$pid" "$DASHBOARD_INTERNAL_PORT" sandbox || return 1
  code="$(curl -so /dev/null -w '%{http_code}' --max-time 3 \
    "http://127.0.0.1:${DASHBOARD_INTERNAL_PORT}/" 2>/dev/null || true)"
  case "$code" in
    200 | 301 | 302 | 307 | 308) return 0 ;;
    *) return 1 ;;
  esac
}

hermes_auxiliaries_need_recovery() {
  hermes_socat_bridge_healthy api-socat "${SOCAT_PID:-}" "$PUBLIC_PORT" || return 0
  hermes_dashboard_healthy "${DASHBOARD_PID:-}" || return 0
  hermes_socat_bridge_healthy dashboard-socat "${DASHBOARD_SOCAT_PID:-}" "$DASHBOARD_PUBLIC_PORT" || return 0
  return 1
}

cleanup_sealed_hermes_gateway_runtime() {
  # shellcheck disable=SC2016  # positional args expand in the stepped-down shell
  "${STEP_DOWN_PREFIX_GATEWAY[@]}" sh -c '
    rm -f "$1/runtime/gateway.pid" "$1/runtime/gateway.lock"
  ' sh "$HERMES_DIR"
}

launch_hermes_gateway() {
  # This function is called from an `if ! ...` recovery branch, where Bash
  # disables errexit throughout the function call. Propagate every security-
  # sensitive preparation failure explicitly before creating a child.
  apply_shields_up_runtime_env || return 1
  if [ "$HERMES_RESTART_SEALED" -ne 1 ]; then
    cleanup_stale_hermes_gateway_runtime || return 1
  fi
  HERMES_HOME="${HERMES_DIR}" \
    nohup "${STEP_DOWN_PREFIX_GATEWAY[@]}" sh -c \
    'umask 0007; exec "$@" >>/tmp/gateway.log 2>&1' sh "$HERMES" gateway run &
  GATEWAY_PID=$!
  if ! hermes_capture_tracked_role gateway "$GATEWAY_PID" gateway "$INTERNAL_PORT"; then
    hermes_fatal_unproven_child gateway "$GATEWAY_PID"
  fi
  # shellcheck disable=SC2034  # read by cleanup_on_signal from sandbox-init.sh
  SANDBOX_WAIT_PID="$GATEWAY_PID"
  echo "[gateway] hermes gateway launched as 'gateway' user (pid $GATEWAY_PID)" >&2
}

ensure_hermes_supervised_auxiliaries() {
  local gateway_user=current
  local dashboard_user=current
  if [ "$(id -u)" -eq 0 ]; then
    gateway_user=gateway
    dashboard_user=sandbox
  fi

  if ! hermes_socat_bridge_healthy api-socat "${SOCAT_PID:-}" "$PUBLIC_PORT"; then
    hermes_stop_tracked_role api-socat "${SOCAT_PID:-0}" current "$PUBLIC_PORT" || return 1
    SOCAT_PID=""
    start_socat_forwarder \
      "$PUBLIC_PORT" "$INTERNAL_PORT" "API" SOCAT_PID "$GATEWAY_PID" "$gateway_user" || return 1
  fi
  if ! hermes_dashboard_healthy "${DASHBOARD_PID:-}"; then
    # A live PID is not sufficient: it may be reused, alive without the exact
    # dashboard listener, or serving a wedged HTTP process. Stop both tracked
    # children before relaunch so the replacement cannot lose either bind race.
    hermes_stop_tracked_role dashboard-socat "${DASHBOARD_SOCAT_PID:-0}" current "$DASHBOARD_PUBLIC_PORT" || return 1
    DASHBOARD_SOCAT_PID=""
    hermes_stop_tracked_role dashboard "${DASHBOARD_PID:-0}" "$dashboard_user" "$DASHBOARD_INTERNAL_PORT" || return 1
    DASHBOARD_PID=""
    if [ "$(id -u)" -eq 0 ]; then
      start_hermes_dashboard_sandbox_user || return 1
    else
      start_hermes_dashboard_current_user || return 1
    fi
  elif ! hermes_socat_bridge_healthy dashboard-socat "${DASHBOARD_SOCAT_PID:-}" "$DASHBOARD_PUBLIC_PORT"; then
    hermes_stop_tracked_role dashboard-socat "${DASHBOARD_SOCAT_PID:-0}" current "$DASHBOARD_PUBLIC_PORT" || return 1
    DASHBOARD_SOCAT_PID=""
    start_socat_forwarder \
      "$DASHBOARD_PUBLIC_PORT" "$DASHBOARD_INTERNAL_PORT" "dashboard" DASHBOARD_SOCAT_PID \
      "$DASHBOARD_PID" "$dashboard_user" || return 1
  fi
  ensure_gateway_log_stream || return 1
}

refresh_hermes_supervised_child_pids() {
  local gateway_user=current
  local dashboard_user=current
  SANDBOX_CHILD_PIDS=()
  if [ "$(id -u)" -eq 0 ]; then
    gateway_user=gateway
    dashboard_user=sandbox
  fi
  hermes_tracked_role_is_current gateway "${GATEWAY_PID:-}" "$gateway_user" "$INTERNAL_PORT" \
    && SANDBOX_CHILD_PIDS+=("$GATEWAY_PID")
  hermes_tracked_role_is_current dashboard "${DASHBOARD_PID:-}" "$dashboard_user" "$DASHBOARD_INTERNAL_PORT" \
    && SANDBOX_CHILD_PIDS+=("$DASHBOARD_PID")
  hermes_tracked_role_is_current api-socat "${SOCAT_PID:-}" current "$PUBLIC_PORT" \
    && SANDBOX_CHILD_PIDS+=("$SOCAT_PID")
  hermes_tracked_role_is_current dashboard-socat "${DASHBOARD_SOCAT_PID:-}" current "$DASHBOARD_PUBLIC_PORT" \
    && SANDBOX_CHILD_PIDS+=("$DASHBOARD_SOCAT_PID")
  hermes_tracked_role_is_current gateway-log "${GATEWAY_LOG_TAIL_PID:-}" current \
    && SANDBOX_CHILD_PIDS+=("$GATEWAY_LOG_TAIL_PID")
  hermes_tracked_role_is_current dashboard-log "${DASHBOARD_LOG_TAIL_PID:-}" current \
    && SANDBOX_CHILD_PIDS+=("$DASHBOARD_LOG_TAIL_PID")
}

hermes_cleanup_on_signal() {
  local gateway_user=current
  [ "$(id -u)" -eq 0 ] && gateway_user=gateway
  refresh_hermes_supervised_child_pids
  if ! hermes_tracked_role_is_current gateway "${GATEWAY_PID:-}" "$gateway_user" "$INTERNAL_PORT"; then
    # The shared cleanup helper must never wait on or signal a PID that has
    # been reused/adopted since NemoClaw captured the gateway start identity.
    SANDBOX_WAIT_PID=""
  fi
  cleanup_on_signal
}

mark_hermes_gateway_stopped() {
  GATEWAY_PID=0
  GATEWAY_PID_START_IDENTITY=""
  # shellcheck disable=SC2034  # read by cleanup_on_signal from sandbox-init.sh
  SANDBOX_WAIT_PID=""
  refresh_hermes_supervised_child_pids
}

hermes_reap_exited_gateway() {
  local pid="${GATEWAY_PID:-0}"
  local expected_start_identity="${GATEWAY_PID_START_IDENTITY:-}"
  local current_start_identity state
  local rc=0
  case "$pid" in
    '' | 0 | 1 | *[!0-9]*) return 1 ;;
  esac
  [ -n "$expected_start_identity" ] || return 1

  current_start_identity="$(hermes_process_start_identity "$pid" 2>/dev/null || true)"
  if [ -n "$current_start_identity" ] \
    && [ "$current_start_identity" != "$expected_start_identity" ]; then
    echo "[SECURITY] Hermes gateway pid $pid no longer matches its captured start identity; refusing to poll or reap it" >&2
    return 2
  fi

  # kill -0 also succeeds for zombies. Only the exact matching zombie is safe
  # to reap. A live process, or one whose state/identity cannot be proven, must
  # not send PID 1 into an unbounded wait or let an interrupted wait forget a
  # still-running gateway.
  if kill -0 "$pid" 2>/dev/null; then
    state="$(gateway_control_pid_state "$pid" 2>/dev/null || true)"
    case "$state" in
      Z*) [ "$current_start_identity" = "$expected_start_identity" ] || return 2 ;;
      *)
        if [ "${GATEWAY_CONTROL_SIGNAL_PENDING:-0}" -eq 1 ] \
          && hermes_tracked_role_is_current gateway "$pid" gateway "$INTERNAL_PORT"; then
          return 3
        fi
        echo "[SECURITY] Hermes gateway pid $pid cannot be proven exited with its captured role identity; refusing to reap it" >&2
        return 2
        ;;
    esac
  fi

  # If the proc entry is already gone, Bash's child-status table keeps this
  # wait scoped to the original direct child rather than an unrelated PID.
  wait "$pid" 2>/dev/null || rc=$?
  # USR1 may interrupt wait before it reaps the exact child. Preserve the
  # tracked identity and let the authenticated request handler own the child.
  if [ "${GATEWAY_CONTROL_SIGNAL_PENDING:-0}" -eq 1 ] \
    && hermes_tracked_role_is_current gateway "$pid" gateway "$INTERNAL_PORT"; then
    return 3
  fi
  echo "[gateway] Hermes gateway pid $pid exited (rc=$rc); awaiting host recovery" >&2
  mark_hermes_gateway_stopped
}

handle_hermes_gateway_control_request() {
  gateway_control_take_request || return 1
  local old_pid="${GATEWAY_PID:-0}"
  local failure_code

  if [ "$GATEWAY_CONTROL_ACTION" = "probe" ]; then
    if ! prepare_hermes_gateway_restart; then
      gateway_control_fail "$HERMES_RESTART_FAILURE_CODE" "$old_pid"
      return 1
    fi
    if ! gateway_control_pid_is_live "$old_pid" \
      || ! hermes_gateway_healthy "$old_pid" \
      || hermes_auxiliaries_need_recovery; then
      gateway_control_fail health-timeout "$old_pid"
      return 1
    fi
    gateway_control_complete already-running "$old_pid" "$old_pid"
    return 0
  fi

  if [ "$GATEWAY_CONTROL_ACTION" = "recover" ] \
    && gateway_control_pid_is_live "$old_pid" \
    && hermes_gateway_healthy "$old_pid"; then
    # Recovery may also recreate the dashboard from the shared Hermes config.
    # Verify the root-owned trust anchor before any auxiliary consumes it; a
    # healthy gateway is not authority to bless direct sandbox config drift.
    if ! prepare_hermes_gateway_restart; then
      if [ "$HERMES_RESTART_FAILURE_CODE" = "secret-boundary-refusal" ]; then
        stop_hermes_gateway_fail_closed
      fi
      gateway_control_fail "$HERMES_RESTART_FAILURE_CODE" "$old_pid"
      return 1
    fi
    if hermes_auxiliaries_need_recovery; then
      if ! seal_hermes_restart_inputs; then
        if [ "$HERMES_RESTART_SEALED" -eq 1 ]; then
          stop_hermes_gateway_fail_closed
        fi
        gateway_control_fail "$HERMES_RESTART_FAILURE_CODE" "$old_pid"
        return 1
      fi
      # Re-run boundary + hash validation against the fresh sealed inodes. A
      # pre-open attacker fd cannot change these pathnames after this point.
      if ! prepare_hermes_gateway_restart; then
        failure_code="$HERMES_RESTART_FAILURE_CODE"
        if [ "$failure_code" = "secret-boundary-refusal" ]; then
          # A post-seal boundary refusal means the currently running service no
          # longer has a boundary we can prove safe. Stop it even if metadata
          # restoration subsequently fails.
          stop_hermes_gateway_fail_closed
        fi
        if ! unseal_hermes_restart_inputs; then
          gateway_control_fail "$HERMES_RESTART_FAILURE_CODE" "$old_pid"
          return 1
        fi
        gateway_control_fail "$failure_code" "$old_pid"
        return 1
      fi
      if ! ensure_hermes_supervised_auxiliaries; then
        if ! unseal_hermes_restart_inputs; then
          stop_hermes_gateway_fail_closed
          gateway_control_fail "$HERMES_RESTART_FAILURE_CODE" "$old_pid"
        else
          gateway_control_fail launch-failed "$old_pid"
        fi
        refresh_hermes_supervised_child_pids
        return 1
      fi
      if ! unseal_hermes_restart_inputs; then
        stop_hermes_gateway_fail_closed
        gateway_control_fail "$HERMES_RESTART_FAILURE_CODE" "$old_pid"
        return 1
      fi
    fi
    refresh_hermes_supervised_child_pids
    gateway_control_complete already-running "$old_pid" "$old_pid"
    return 0
  fi

  if ! prepare_hermes_gateway_restart; then
    if [ "$HERMES_RESTART_FAILURE_CODE" = "secret-boundary-refusal" ]; then
      stop_hermes_gateway_fail_closed
    fi
    gateway_control_fail "$HERMES_RESTART_FAILURE_CODE" "$old_pid"
    return 1
  fi

  # Seal and revalidate while the old gateway is still healthy. A seal failure
  # must not turn a rejected config into an avoidable outage.
  if ! seal_hermes_restart_inputs; then
    if [ "$HERMES_RESTART_SEALED" -eq 1 ]; then
      stop_hermes_gateway_fail_closed
    fi
    gateway_control_fail "$HERMES_RESTART_FAILURE_CODE" "$old_pid"
    return 1
  fi
  if ! prepare_hermes_gateway_restart; then
    failure_code="$HERMES_RESTART_FAILURE_CODE"
    if [ "$failure_code" = "secret-boundary-refusal" ]; then
      # Do not leave the old gateway alive after a boundary refusal merely
      # because restoring the restart seal also fails.
      stop_hermes_gateway_fail_closed
    fi
    if ! unseal_hermes_restart_inputs; then
      gateway_control_fail "$HERMES_RESTART_FAILURE_CODE" "$old_pid"
      return 1
    fi
    gateway_control_fail "$failure_code" "$old_pid"
    return 1
  fi

  if ! hermes_stop_tracked_role gateway "$old_pid" gateway "$INTERNAL_PORT"; then
    if ! unseal_hermes_restart_inputs; then
      gateway_control_fail "$HERMES_RESTART_FAILURE_CODE" "$old_pid"
    else
      gateway_control_fail internal "$old_pid"
    fi
    return 1
  fi
  mark_hermes_gateway_stopped

  if ! cleanup_sealed_hermes_gateway_runtime; then
    if ! unseal_hermes_restart_inputs; then
      gateway_control_fail "$HERMES_RESTART_FAILURE_CODE" "$old_pid"
    else
      gateway_control_fail unsafe-config "$old_pid"
    fi
    return 1
  fi

  if ! launch_hermes_gateway || ! wait_for_hermes_gateway_internal "$GATEWAY_PID"; then
    stop_hermes_gateway_fail_closed
    if ! unseal_hermes_restart_inputs; then
      gateway_control_fail "$HERMES_RESTART_FAILURE_CODE" "$old_pid"
    else
      gateway_control_fail health-timeout "$old_pid"
    fi
    return 1
  fi
  if ! ensure_hermes_supervised_auxiliaries; then
    refresh_hermes_supervised_child_pids
    if ! unseal_hermes_restart_inputs; then
      stop_hermes_gateway_fail_closed
      gateway_control_fail "$HERMES_RESTART_FAILURE_CODE" "$old_pid"
    else
      gateway_control_fail launch-failed "$old_pid"
    fi
    return 1
  fi
  if ! unseal_hermes_restart_inputs; then
    stop_hermes_gateway_fail_closed
    gateway_control_fail "$HERMES_RESTART_FAILURE_CODE" "$old_pid"
    return 1
  fi
  refresh_hermes_supervised_child_pids
  gateway_control_complete ok "$old_pid" "$GATEWAY_PID"
}

prepare_hermes_nonroot_runtime() {
  if ! verify_config_integrity_if_locked "${HERMES_DIR}"; then
    echo "[SECURITY] Config integrity check failed — refusing to start (non-root mode)" >&2
    return 1
  fi
  ensure_hermes_runtime_api_server_key compat || return 1
  apply_shields_up_runtime_env || return 1
  validate_hermes_env_secret_boundary || return 1
  validate_hermes_runtime_env_secret_boundary || return 1
  refresh_hermes_provider_placeholders compat || return 1
  refresh_hermes_runtime_config_hashes compat || return 1
  configure_messaging_channels || return 1
  retry_tirith_marker_if_needed || return 1
}

launch_hermes_gateway_current_user() {
  cleanup_stale_hermes_gateway_runtime || return 1
  HERMES_HOME="${HERMES_DIR}" \
    nohup "$HERMES" gateway run >>/tmp/gateway.log 2>&1 &
  GATEWAY_PID=$!
  if ! hermes_capture_tracked_role gateway "$GATEWAY_PID" current "$INTERNAL_PORT"; then
    hermes_fatal_unproven_child gateway "$GATEWAY_PID"
  fi
  # shellcheck disable=SC2034  # read by cleanup_on_signal from sandbox-init.sh
  SANDBOX_WAIT_PID="$GATEWAY_PID"
  echo "[gateway] hermes gateway launched (pid $GATEWAY_PID)" >&2
}

HERMES_MANAGED_GATEWAY_EXIT_TIMES=()
HERMES_MANAGED_GATEWAY_EXIT_COUNT=0
readonly HERMES_MANAGED_EXPECTED_EXIT_DIR="/run/nemoclaw"
readonly HERMES_MANAGED_EXPECTED_EXIT_MARKER="managed-gateway-expected-exit"
readonly HERMES_MANAGED_CONTROLLER_PATH="/usr/local/lib/nemoclaw/managed-gateway-control.py"

quarantine_hermes_managed_gateway_relaunch() {
  while :; do
    sleep 60 || true
  done
}

hermes_managed_controller_argv_is_expected() {
  [ "$#" -eq 5 ] || return 1
  case "${1##*/}" in
    python3) ;;
    *) return 1 ;;
  esac
  [ "$2" = "-I" ] && [ "$3" = "$HERMES_MANAGED_CONTROLLER_PATH" ] || return 1
  case "$4" in
    restart | recover) ;;
    *) return 1 ;;
  esac
  case "$5" in
    '' | *[!0-9a-f]*) return 1 ;;
  esac
  [ "${#5}" -eq 64 ]
}

hermes_managed_controller_is_live() {
  local pid="$1"
  local expected_start_identity="$2"
  local proc_root="${_HERMES_PROC_ROOT:-/proc}"
  local first_start second_start first_state second_state first_uids second_uids
  local -a first_argv=()
  local -a second_argv=()

  case "$pid" in
    '' | 0 | 1 | *[!0-9]*) return 1 ;;
  esac
  case "$expected_start_identity" in
    '' | *[!0-9]*) return 1 ;;
  esac
  [ -r "${proc_root}/${pid}/status" ] \
    && [ -r "${proc_root}/${pid}/cmdline" ] || return 1

  first_start="$(gateway_control_pid_start_identity "$pid")" || return 1
  first_state="$(gateway_control_pid_state "$pid")" || return 1
  first_uids="$(awk '/^Uid:/ { print $2 ":" $3 ":" $4 ":" $5; exit }' "${proc_root}/${pid}/status")" || return 1
  while IFS= read -r -d "" elem; do first_argv+=("$elem"); done <"${proc_root}/${pid}/cmdline" || return 1
  hermes_managed_controller_argv_is_expected "${first_argv[@]}" || return 1

  second_start="$(gateway_control_pid_start_identity "$pid")" || return 1
  second_state="$(gateway_control_pid_state "$pid")" || return 1
  second_uids="$(awk '/^Uid:/ { print $2 ":" $3 ":" $4 ":" $5; exit }' "${proc_root}/${pid}/status")" || return 1
  while IFS= read -r -d "" elem; do second_argv+=("$elem"); done <"${proc_root}/${pid}/cmdline" || return 1
  hermes_managed_controller_argv_is_expected "${second_argv[@]}" || return 1

  [ "$first_start" = "$expected_start_identity" ] \
    && [ "$second_start" = "$expected_start_identity" ] \
    && [ "$first_uids" = "0:0:0:0" ] \
    && [ "$second_uids" = "0:0:0:0" ] \
    && [ "$first_state" != "Z" ] \
    && [ "$second_state" != "Z" ] \
    && [ "${first_argv[*]}" = "${second_argv[*]}" ]
}

hermes_managed_gateway_exit_was_host_authorized() {
  local pid="$1"
  local start_identity="$2"
  local marker dir_metadata marker_metadata
  local version marker_pid marker_start_identity controller_pid controller_start_identity extra
  local trailing=""

  case "$pid" in
    '' | 0 | 1 | *[!0-9]*) return 1 ;;
  esac
  case "$start_identity" in
    '' | *[!0-9]*) return 1 ;;
  esac

  [ -d "$HERMES_MANAGED_EXPECTED_EXIT_DIR" ] \
    && [ ! -L "$HERMES_MANAGED_EXPECTED_EXIT_DIR" ] || return 1
  dir_metadata="$(stat -c '%u:%g %a' "$HERMES_MANAGED_EXPECTED_EXIT_DIR" 2>/dev/null || true)"
  [ "$dir_metadata" = "0:0 711" ] || return 1

  marker="${HERMES_MANAGED_EXPECTED_EXIT_DIR}/${HERMES_MANAGED_EXPECTED_EXIT_MARKER}"
  [ -f "$marker" ] && [ ! -L "$marker" ] || return 1
  marker_metadata="$(stat -c '%u:%g %a %h' "$marker" 2>/dev/null || true)"
  [ "$marker_metadata" = "0:0 444 1" ] || return 1

  # bash 4.1+ named FDs ({var}<file) are not available on bash 3.2 (macOS).
  # Use a grouped redirect instead — variables assigned inside {} remain in scope.
  {
    if ! IFS=' ' read -r \
      version marker_pid marker_start_identity controller_pid controller_start_identity extra; then
      return 1
    fi
    if IFS= read -r trailing || [ -n "$trailing" ]; then
      return 1
    fi
  } <"$marker" || return 1

  [ "$version" = "v1" ] \
    && [ "$marker_pid" = "$pid" ] \
    && [ "$marker_start_identity" = "$start_identity" ] \
    && [ -z "${extra:-}" ] || return 1
  case "$controller_pid" in
    '' | 0 | 1 | *[!0-9]*) return 1 ;;
  esac
  case "$controller_start_identity" in
    '' | *[!0-9]*) return 1 ;;
  esac
  hermes_managed_controller_is_live "$controller_pid" "$controller_start_identity"
}

record_hermes_managed_gateway_exit() {
  local now timestamp
  local -a retained=()

  now="$(date +%s)"
  HERMES_MANAGED_GATEWAY_EXIT_TIMES+=("$now")
  for timestamp in "${HERMES_MANAGED_GATEWAY_EXIT_TIMES[@]+"${HERMES_MANAGED_GATEWAY_EXIT_TIMES[@]}"}"; do
    [ $((now - timestamp)) -le 60 ] && retained+=("$timestamp")
  done
  HERMES_MANAGED_GATEWAY_EXIT_TIMES=("${retained[@]+"${retained[@]}"}")
  HERMES_MANAGED_GATEWAY_EXIT_COUNT=${#HERMES_MANAGED_GATEWAY_EXIT_TIMES[@]}
  if [ "$HERMES_MANAGED_GATEWAY_EXIT_COUNT" -ge 5 ]; then
    echo "[gateway] CRITICAL: $HERMES_MANAGED_GATEWAY_EXIT_COUNT exits in 60s window — Hermes relaunch is quarantined until sandbox recreation; check /tmp/gateway.log" >&2
    quarantine_hermes_managed_gateway_relaunch
    return 1
  fi
}

recover_hermes_gateway_current_user() {
  while :; do
    until prepare_hermes_nonroot_runtime; do
      echo "[gateway] Hermes runtime preparation refused automatic respawn; retrying in 5s" >&2
      sleep 5 || true
    done
    if ! launch_hermes_gateway_current_user; then
      echo "[gateway] Hermes gateway launch failed; retrying under the same supervisor" >&2
      sleep 5 || true
      continue
    fi
    if wait_for_hermes_gateway_internal "$GATEWAY_PID" \
      && ensure_hermes_supervised_auxiliaries; then
      refresh_hermes_supervised_child_pids
      return 0
    fi

    echo "[gateway] Hermes replacement failed health or auxiliary validation; stopping the exact child" >&2
    if ! hermes_stop_tracked_role \
      gateway "$GATEWAY_PID" current "$INTERNAL_PORT"; then
      echo "[gateway] CRITICAL: exact Hermes replacement could not be stopped; managed supervisor is quarantined without another launch" >&2
      quarantine_hermes_managed_gateway_relaunch
      return 1
    fi
    mark_hermes_gateway_stopped
    record_hermes_managed_gateway_exit || return 1
    sleep 2 || true
  done
}

supervise_hermes_gateway_current_user() {
  local exited_gateway_pid exited_gateway_start_identity rc respawn_count unhealthy_streak=0

  while :; do
    # Keep one exact supervisor alive for the full managed OpenShell process
    # tree and continuously repair its dashboard and internal relays.
    while hermes_tracked_role_is_current gateway "$GATEWAY_PID" current "$INTERNAL_PORT"; do
      if hermes_gateway_healthy "$GATEWAY_PID"; then
        unhealthy_streak=0
        if ! ensure_hermes_supervised_auxiliaries; then
          echo "[gateway] Hermes auxiliary repair failed; retrying while the exact gateway remains supervised" >&2
        fi
      else
        unhealthy_streak=$((unhealthy_streak + 1))
        echo "[gateway] Hermes gateway failed health validation ($unhealthy_streak/4)" >&2
        if [ "$unhealthy_streak" -ge 4 ]; then
          echo "[gateway] CRITICAL: Hermes gateway lost its listener or health endpoint; stopping the exact child for recovery" >&2
          if ! hermes_stop_tracked_role \
            gateway "$GATEWAY_PID" current "$INTERNAL_PORT"; then
            echo "[gateway] CRITICAL: unhealthy Hermes gateway could not be stopped; managed supervisor is quarantined without another launch" >&2
            quarantine_hermes_managed_gateway_relaunch
            return 1
          fi
          break
        fi
      fi
      refresh_hermes_supervised_child_pids
      sleep 1 || true
    done

    exited_gateway_pid="$GATEWAY_PID"
    exited_gateway_start_identity="${GATEWAY_PID_START_IDENTITY:-}"
    rc=0
    wait "$GATEWAY_PID" 2>/dev/null || rc=$?
    mark_hermes_gateway_stopped

    if hermes_managed_gateway_exit_was_host_authorized \
      "$exited_gateway_pid" "$exited_gateway_start_identity"; then
      echo "[gateway] Hermes gateway pid $exited_gateway_pid exited (rc=$rc; authenticated host authorization); respawning without charging crash quarantine in 2s" >&2
    else
      record_hermes_managed_gateway_exit || return 1
      respawn_count="$HERMES_MANAGED_GATEWAY_EXIT_COUNT"
      echo "[gateway] Hermes gateway pid $exited_gateway_pid exited (rc=$rc); respawning (#$respawn_count in 60s window) in 2s" >&2
    fi
    sleep 2 || true

    recover_hermes_gateway_current_user || return 1
    echo "[gateway] Hermes gateway respawned (pid $GATEWAY_PID)" >&2
  done
}

bootstrap_hermes_gateway_current_user() {
  launch_hermes_gateway_current_user || return 1
  start_gateway_log_stream
  refresh_hermes_supervised_child_pids
  trap hermes_cleanup_on_signal SIGTERM SIGINT

  if wait_for_hermes_gateway_internal "$GATEWAY_PID" \
    && ensure_hermes_supervised_auxiliaries; then
    refresh_hermes_supervised_child_pids
    return 0
  fi

  echo "[gateway] Initial Hermes gateway failed health or auxiliary validation; stopping the exact child for supervised recovery" >&2
  if ! hermes_stop_tracked_role \
    gateway "$GATEWAY_PID" current "$INTERNAL_PORT"; then
    echo "[gateway] CRITICAL: initial Hermes gateway could not be stopped; managed supervisor is quarantined without another launch" >&2
    quarantine_hermes_managed_gateway_relaunch
    return 1
  fi
  mark_hermes_gateway_stopped
  record_hermes_managed_gateway_exit || return 1
  sleep 2 || true
  recover_hermes_gateway_current_user || return 1
  refresh_hermes_supervised_child_pids
}

# ── Main ─────────────────────────────────────────────────────────

# A PID 1 interruption within the same container writable layer can leave the
# root-only seal token behind. Restore it before any startup migration or config
# read. `/run` is not persistent across container recreation, so recognize the
# distinctive frozen parent + sealed-file posture when the token is gone and
# require a rebuild instead of guessing the original ownership/mode/flags.
if [ "$(id -u)" -eq 0 ]; then
  recover_startup_hermes_mutation || exit 1
  if hermes_restart_seal_orphaned; then
    echo "[SECURITY] HERMES_RESTART_SEAL_ORPHANED: restart recovery metadata was lost; restore from a trusted backup and recreate the sandbox" >&2
    exit 1
  fi
  if hermes_config_root_is_locked && ! hermes_locked_parent_is_protected; then
    echo "[SECURITY] HERMES_LOCKED_PARENT_UNPROTECTED: /sandbox must be root:sandbox 1775 while Hermes shields are up; restore from a trusted backup and recreate the sandbox (shields up cannot run while PID 1 refuses startup)" >&2
    exit 1
  fi
elif [ -e "$HERMES_CONFIG_MUTATION_LOCK" ] \
  || [ -e "$HERMES_RESTART_SEAL_STATE" ] \
  || [ -e "$HERMES_RESTART_ORPHAN_MARKER" ] \
  || hermes_restart_seal_orphaned; then
  echo "[SECURITY] HERMES_RESTART_SEAL_ORPHANED: non-root startup cannot safely recover an interrupted root config transaction; restore from a trusted backup and recreate the sandbox" >&2
  exit 1
fi

# Migrate legacy symlink layout before anything else reads .hermes
migrate_legacy_layout "/sandbox/.hermes" "/sandbox/.hermes-data" "hermes" || exit 1

echo 'Setting up NemoClaw (Hermes)...' >&2

# ── Non-root fallback ──────────────────────────────────────────
if [ "$(id -u)" -ne 0 ]; then
  echo "[gateway] Running as non-root (uid=$(id -u)) — privilege separation disabled" >&2
  export HOME=/sandbox
  export HERMES_HOME="${HERMES_DIR}"

  # macOS VM and OpenShell-managed startup run this entrypoint as the sandbox
  # user. In that mode the strict /etc hash cannot remain a root-owned trust
  # anchor, so use the same locked-aware mutable verifier as OpenClaw. Repeat
  # this preparation before every automatic respawn so a stopped gateway never
  # relaunches with stale or boundary-unsafe runtime inputs.
  prepare_hermes_nonroot_runtime || exit 1

  if [ ${#NEMOCLAW_CMD[@]} -gt 0 ]; then
    exec "${NEMOCLAW_CMD[@]}"
  fi

  cleanup_stale_hermes_gateway_runtime

  prepare_restricted_log /tmp/gateway.log "" 600

  # Defence-in-depth: verify /tmp file permissions before launching services.
  # shellcheck disable=SC2119
  validate_tmp_permissions

  # Start Hermes gateway. Messaging egress goes directly through OpenShell.
  umask 0007
  bootstrap_hermes_gateway_current_user || exit 1
  print_dashboard_urls

  supervise_hermes_gateway_current_user
  exit $?
fi

# ── Root path (full privilege separation via setpriv) ──────────

export HERMES_HOME="${HERMES_DIR}"
verify_hermes_config_integrity
ensure_hermes_config_root_mode
ensure_hermes_runtime_api_server_key both
apply_shields_up_runtime_env
validate_hermes_env_secret_boundary
validate_hermes_runtime_env_secret_boundary
refresh_hermes_provider_placeholders both
configure_messaging_channels
retry_tirith_marker_if_needed

if [ ${#NEMOCLAW_CMD[@]} -gt 0 ]; then
  exec "${STEP_DOWN_PREFIX_SANDBOX[@]}" "${NEMOCLAW_CMD[@]}"
fi

# SECURITY: Protect gateway log from sandbox user tampering
prepare_restricted_log /tmp/gateway.log gateway:gateway 600

# Defence-in-depth: verify /tmp file permissions before launching services.
# shellcheck disable=SC2119
validate_tmp_permissions

# Start Hermes gateway. Messaging egress goes directly through OpenShell.
launch_hermes_gateway
start_gateway_log_stream
wait_for_hermes_gateway_internal "$GATEWAY_PID"
ensure_hermes_supervised_auxiliaries
restore_hermes_config_permissions_after_dashboard_start
# NOTE: PIDs are collected after launch; a signal arriving between trap
# registration and the final append is a small race window (same as before
# the shared-library refactor). Acceptable for entrypoint-level cleanup.
refresh_hermes_supervised_child_pids
# shellcheck disable=SC2034  # read by cleanup_on_signal from sandbox-init.sh
SANDBOX_WAIT_PID="$GATEWAY_PID"
trap hermes_cleanup_on_signal SIGTERM SIGINT
if ! gateway_control_init; then
  echo "[gateway-control] privileged gateway control unavailable" >&2
fi
if ! "$_HERMES_PYTHON" -I "$_HERMES_RUNTIME_CONFIG_GUARD" publish-startup-ready \
  --hermes-dir "$HERMES_DIR" \
  --startup-owner >/dev/null; then
  echo "[gateway-control] failed to publish Hermes startup readiness" >&2
  exit 1
fi
print_dashboard_urls

# PID 1 remains alive even when Hermes stops its gateway. Host recovery uses
# the authenticated control helper to validate and launch a replacement; no
# unrelated exec process owns or races the child lifecycle.
while :; do
  while [ -n "${GATEWAY_PID:-}" ] \
    && [ "$GATEWAY_PID" -gt 1 ] \
    && hermes_tracked_role_is_current gateway "$GATEWAY_PID" gateway "$INTERNAL_PORT" \
    && [ "$GATEWAY_CONTROL_SIGNAL_PENDING" -eq 0 ]; do
    sleep 1 || true
  done

  if [ "$GATEWAY_CONTROL_SIGNAL_PENDING" -eq 1 ]; then
    handle_hermes_gateway_control_request || true
    continue
  fi

  if [ -n "${GATEWAY_PID:-}" ] \
    && [ "$GATEWAY_PID" -gt 0 ] \
    && ! hermes_tracked_role_is_current gateway "$GATEWAY_PID" gateway "$INTERNAL_PORT"; then
    reap_status=0
    hermes_reap_exited_gateway || reap_status=$?
    case "$reap_status" in
      0) ;;
      3)
        handle_hermes_gateway_control_request || true
        continue
        ;;
      *) exit 1 ;;
    esac
  else
    sleep 1 || true
  fi
done
