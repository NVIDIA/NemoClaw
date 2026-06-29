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

# The seeder imports PyYAML, which ships ONLY in the Hermes venv — not in the
# base-image python3 that is first on PATH at container boot. (An interactive
# login shell activates the venv, masking this: `python3` there resolves to
# /opt/hermes/.venv/bin/python3 and has yaml, but the entrypoint that runs this
# script does not.) Invoked with bare python3, the seeder hits its "PyYAML
# unavailable; skipping model seed" branch and returns 0, so the model routing
# is silently never mirrored into the dashboard home and the Models page shows
# no models. Resolve the venv interpreter explicitly, falling back to python3.
_HERMES_PYTHON="/opt/hermes/.venv/bin/python"
if [ ! -x "$_HERMES_PYTHON" ]; then
  _HERMES_PYTHON="$(command -v python3 || echo python3)"
fi

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

start_gateway_log_stream() {
  { tail -n +1 -F /tmp/gateway.log 2>/dev/null | sed -u 's/^/[gateway-log:] /' >&2; } &
  GATEWAY_LOG_TAIL_PID=$!
}

start_dashboard_log_stream() {
  { tail -n +1 -F /tmp/dashboard.log 2>/dev/null | sed -u 's/^/[dashboard-log:] /' >&2; } &
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
    *"/hermes gateway run "* | *" hermes gateway run "* | *"/hermes.real gateway run "* | *" hermes.real gateway run "*) return 0 ;;
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

repair_hermes_log_permissions() {
  ensure_hermes_state_dir "${HERMES_DIR}/logs" 2770
  ensure_hermes_state_dir "${HERMES_DIR}/logs/curator" 2770

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
    ensure_hermes_history_file "${HERMES_DIR}/.hermes_history" 660
    return 0
  fi

  ensure_hermes_config_root_mode
  repair_hermes_log_permissions
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

# ── socat forwarders ─────────────────────────────────────────────
# Hermes services bind to 127.0.0.1 for safety.
# OpenShell needs the port accessible on 0.0.0.0 for port forwarding.
# socat bridges 0.0.0.0:<public> to 127.0.0.1:<internal>.
SOCAT_PID=""
DASHBOARD_SOCAT_PID=""
start_socat_forwarder() {
  local public_port="$1"
  local internal_port="$2"
  local label="$3"
  local pid_var="${4:-SOCAT_PID}"
  local _socat_pid

  if ! command -v socat >/dev/null 2>&1; then
    echo "[gateway] socat not available - ${label} port forwarding from host may not work" >&2
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
  _socat_pid=$!
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
        mkdir -p "$HERMES_DASHBOARD_HOME"
        if [ -L "$HERMES_DASHBOARD_HOME" ] || [ ! -d "$HERMES_DASHBOARD_HOME" ]; then
          echo "[SECURITY] Refusing Hermes dashboard startup because ${HERMES_DASHBOARD_HOME} is not a safe directory" >&2
          exit 1
        fi
        chmod 700 "$HERMES_DASHBOARD_HOME"
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
  mkdir -p "$HERMES_DASHBOARD_HOME"
  if [ -L "$HERMES_DASHBOARD_HOME" ] || [ ! -d "$HERMES_DASHBOARD_HOME" ]; then
    echo "[SECURITY] Refusing Hermes dashboard startup because ${HERMES_DASHBOARD_HOME} is not a safe directory" >&2
    return 1
  fi
  chmod 700 "$HERMES_DASHBOARD_HOME"
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
  build_hermes_dashboard_args
  prepare_hermes_dashboard_home ""
  prepare_restricted_log /tmp/dashboard.log "" 600
  HERMES_HOME="${HERMES_DASHBOARD_HOME}" \
    GATEWAY_HEALTH_URL="http://127.0.0.1:${INTERNAL_PORT}" \
    nohup "$HERMES" "${HERMES_DASHBOARD_ARGS[@]}" >/tmp/dashboard.log 2>&1 &
  DASHBOARD_PID=$!
  echo "[gateway] hermes dashboard launched (pid $DASHBOARD_PID)" >&2
  start_dashboard_log_stream
  start_socat_forwarder "$DASHBOARD_PUBLIC_PORT" "$DASHBOARD_INTERNAL_PORT" "dashboard" DASHBOARD_SOCAT_PID
}

start_hermes_dashboard_sandbox_user() {
  build_hermes_dashboard_args
  prepare_hermes_dashboard_home sandbox:sandbox
  prepare_restricted_log /tmp/dashboard.log sandbox:sandbox 600
  HERMES_HOME="${HERMES_DASHBOARD_HOME}" \
    GATEWAY_HEALTH_URL="http://127.0.0.1:${INTERNAL_PORT}" \
    nohup "${STEP_DOWN_PREFIX_SANDBOX[@]}" sh -c 'umask 0077; exec "$@" >/tmp/dashboard.log 2>&1' sh "$HERMES" "${HERMES_DASHBOARD_ARGS[@]}" &
  DASHBOARD_PID=$!
  echo "[gateway] hermes dashboard launched as 'sandbox' user (pid $DASHBOARD_PID)" >&2
  start_dashboard_log_stream
  start_socat_forwarder "$DASHBOARD_PUBLIC_PORT" "$DASHBOARD_INTERNAL_PORT" "dashboard" DASHBOARD_SOCAT_PID
}

wait_for_hermes_gateway_internal() {
  local gateway_pid="$1"
  local attempts=0
  local code
  while [ "$attempts" -lt 60 ]; do
    # Status-code extraction (not curl -sf) so a 401 counts as alive: Hermes
    # v0.16.0+ may guard the api_server with API_SERVER_KEY, and the probe is
    # unauthenticated. A 401 still proves the gateway is bound and serving.
    # Mirrors GATEWAY_ALIVE_CODES in src/lib/verify-deployment.ts.
    code=$(curl -so /dev/null -w '%{http_code}' --max-time 2 \
      "http://127.0.0.1:${INTERNAL_PORT}/health" 2>/dev/null || echo 000)
    case "$code" in
      200 | 401) return 0 ;;
    esac
    if ! kill -0 "$gateway_pid" 2>/dev/null; then
      wait "$gateway_pid"
      return $?
    fi
    attempts=$((attempts + 1))
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
  )
  if [ -f "$runtime_plan" ]; then
    args+=(--runtime-plan "$runtime_plan")
  fi
  "$_HERMES_PYTHON" "${args[@]}"
  validate_hermes_env_secret_boundary
}

refresh_hermes_runtime_config_hashes() {
  local mode="${1:-strict}"
  local cmd=(
    "$_HERMES_PYTHON" "$_HERMES_RUNTIME_CONFIG_GUARD" refresh-hashes
    --hermes-dir "$HERMES_DIR"
    --hash-file "$HERMES_HASH_FILE"
    --mode "$mode"
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
  [ -f "$env_file" ] || return 0

  local result
  result="$(
    "$_HERMES_PYTHON" "$_HERMES_RUNTIME_CONFIG_GUARD" ensure-api-key \
      --hermes-dir "$HERMES_DIR" \
      --hash-file "$HERMES_HASH_FILE" \
      --mode "$mode"
  )" || return $?

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
  [ -e "$env_file" ] || return 0
  if [ -L "$env_file" ]; then
    echo "[SECURITY] Refusing Hermes startup because ${env_file} is a symlink" >&2
    return 1
  fi
  python3 "$_HERMES_BOUNDARY_VALIDATOR" env-file "$env_file"
}

validate_hermes_runtime_env_secret_boundary() {
  python3 "$_HERMES_BOUNDARY_VALIDATOR" runtime-env
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
  ensure_hermes_runtime_api_server_key compat
  apply_shields_up_runtime_env
  validate_hermes_env_secret_boundary
  validate_hermes_runtime_env_secret_boundary
  refresh_hermes_provider_placeholders compat
  refresh_hermes_runtime_config_hashes compat
  configure_messaging_channels
  retry_tirith_marker_if_needed

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
  HERMES_HOME="${HERMES_DIR}" \
    nohup "$HERMES" gateway run >/tmp/gateway.log 2>&1 &
  GATEWAY_PID=$!
  echo "[gateway] hermes gateway launched (pid $GATEWAY_PID)" >&2
  start_gateway_log_stream
  wait_for_hermes_gateway_internal "$GATEWAY_PID"
  start_socat_forwarder "$PUBLIC_PORT" "$INTERNAL_PORT" "API" SOCAT_PID
  start_hermes_dashboard_current_user
  # NOTE: PIDs are collected after launch; a signal arriving between trap
  # registration and the final append is a small race window (same as before
  # the shared-library refactor). Acceptable for entrypoint-level cleanup.
  SANDBOX_CHILD_PIDS=("$GATEWAY_PID" "$DASHBOARD_PID")
  [ -n "${GATEWAY_LOG_TAIL_PID:-}" ] && SANDBOX_CHILD_PIDS+=("$GATEWAY_LOG_TAIL_PID")
  [ -n "${DASHBOARD_LOG_TAIL_PID:-}" ] && SANDBOX_CHILD_PIDS+=("$DASHBOARD_LOG_TAIL_PID")
  # shellcheck disable=SC2034  # read by cleanup_on_signal from sandbox-init.sh
  SANDBOX_WAIT_PID="$GATEWAY_PID"
  trap cleanup_on_signal SIGTERM SIGINT
  [ -n "${SOCAT_PID:-}" ] && SANDBOX_CHILD_PIDS+=("$SOCAT_PID")
  [ -n "${DASHBOARD_SOCAT_PID:-}" ] && SANDBOX_CHILD_PIDS+=("$DASHBOARD_SOCAT_PID")
  print_dashboard_urls

  wait "$GATEWAY_PID"
  exit $?
fi

# ── Root path (full privilege separation via setpriv) ──────────

export HERMES_HOME="${HERMES_DIR}"
verify_hermes_config_integrity
ensure_hermes_config_root_mode
ensure_hermes_runtime_api_server_key strict
apply_shields_up_runtime_env
validate_hermes_env_secret_boundary
validate_hermes_runtime_env_secret_boundary
refresh_hermes_provider_placeholders strict
refresh_hermes_runtime_config_hashes compat
configure_messaging_channels
retry_tirith_marker_if_needed

if [ ${#NEMOCLAW_CMD[@]} -gt 0 ]; then
  exec "${STEP_DOWN_PREFIX_SANDBOX[@]}" "${NEMOCLAW_CMD[@]}"
fi

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
wait_for_hermes_gateway_internal "$GATEWAY_PID"
start_socat_forwarder "$PUBLIC_PORT" "$INTERNAL_PORT" "API" SOCAT_PID
start_hermes_dashboard_sandbox_user
restore_hermes_config_permissions_after_dashboard_start
# NOTE: PIDs are collected after launch; a signal arriving between trap
# registration and the final append is a small race window (same as before
# the shared-library refactor). Acceptable for entrypoint-level cleanup.
SANDBOX_CHILD_PIDS=("$GATEWAY_PID" "$DASHBOARD_PID")
[ -n "${GATEWAY_LOG_TAIL_PID:-}" ] && SANDBOX_CHILD_PIDS+=("$GATEWAY_LOG_TAIL_PID")
[ -n "${DASHBOARD_LOG_TAIL_PID:-}" ] && SANDBOX_CHILD_PIDS+=("$DASHBOARD_LOG_TAIL_PID")
# shellcheck disable=SC2034  # read by cleanup_on_signal from sandbox-init.sh
SANDBOX_WAIT_PID="$GATEWAY_PID"
trap cleanup_on_signal SIGTERM SIGINT
[ -n "${SOCAT_PID:-}" ] && SANDBOX_CHILD_PIDS+=("$SOCAT_PID")
[ -n "${DASHBOARD_SOCAT_PID:-}" ] && SANDBOX_CHILD_PIDS+=("$DASHBOARD_SOCAT_PID")
print_dashboard_urls

# Keep container running by waiting on the gateway process.
wait "$GATEWAY_PID"
