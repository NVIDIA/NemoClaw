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
#   NVIDIA_INFERENCE_API_KEY                API key for NVIDIA-hosted inference
#   CHAT_UI_URL                   Browser origin that will access the forwarded dashboard
#   NEMOCLAW_DISABLE_DEVICE_AUTH  Build-time only. Set to "1" to skip device-pairing auth.
#                                  Also auto-disabled when CHAT_UI_URL is non-loopback.
#                                 (development/headless). Has no runtime effect — openclaw.json
#                                 is baked at image build and verified by hash at startup.
#   NEMOCLAW_MODEL_OVERRIDE       Override the primary model at startup without rebuilding
#                                 the sandbox image. Must match the model configured on
#                                 the gateway via `openshell inference set`.
#   NEMOCLAW_INFERENCE_API_OVERRIDE  Override the inference API type when switching between
#                                 provider families (e.g., "anthropic-messages" or
#                                 "openai-completions"). Only needed for cross-provider switches.
#   NEMOCLAW_CONTEXT_WINDOW        Override the model's context window size (e.g., "32768").
#   NEMOCLAW_MAX_TOKENS            Override the model's max output tokens (e.g., "8192").
#   NEMOCLAW_REASONING             Set to "true" to enable reasoning mode for the model.
#                                 Required for reasoning models (o1, Claude with thinking).
#   NEMOCLAW_CORS_ORIGIN           Add a browser origin to allowedOrigins at startup without
#                                 rebuilding. Useful for custom domains/ports (e.g.,
#                                 "https://my-server.example.com:8443").

set -euo pipefail

# SECURITY: Lock down PATH before any commands run so an injected PATH
# cannot resolve id/chown/chmod/tee from an attacker-controlled location.
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# Reject an invalid explicit dashboard port before installing the tee/fd startup
# capture below. Some CI Docker runners can drop very early fd4 output from
# short-lived containers, and this validation is meant to be fail-fast and
# directly visible to callers.
_EARLY_DASHBOARD_PORT_RAW="${NEMOCLAW_DASHBOARD_PORT:-}"
if [ -n "$_EARLY_DASHBOARD_PORT_RAW" ]; then
  _EARLY_DASHBOARD_PORT="$(printf '%s' "$_EARLY_DASHBOARD_PORT_RAW" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  _EARLY_DASHBOARD_PORT_VALID=1
  case "$_EARLY_DASHBOARD_PORT" in
    *[!0-9]* | '')
      _EARLY_DASHBOARD_PORT_VALID=0
      ;;
  esac
  if [ "$_EARLY_DASHBOARD_PORT_VALID" -eq 1 ] && { [ "$_EARLY_DASHBOARD_PORT" -lt 1024 ] || [ "$_EARLY_DASHBOARD_PORT" -gt 65535 ]; }; then
    _EARLY_DASHBOARD_PORT_VALID=0
  fi
  if [ "$_EARLY_DASHBOARD_PORT_VALID" -ne 1 ]; then
    printf '%s\n' "[SECURITY] Invalid NEMOCLAW_DASHBOARD_PORT='${NEMOCLAW_DASHBOARD_PORT}' — must be an integer between 1024 and 65535" >&2
    exit 1
  fi
fi
unset _EARLY_DASHBOARD_PORT_RAW _EARLY_DASHBOARD_PORT _EARLY_DASHBOARD_PORT_VALID

# ── Early stderr/stdout capture ──────────────────────────────────
# Capture all entrypoint output to /tmp/nemoclaw-start.log so that if
# the script crashes before gateway log setup (e.g., a Landlock
# read failure), the output is still available for diagnostics.
# The log is written in append mode and also forwarded to the original
# stderr/stdout via tee so openshell sandbox create can still stream it.
# SECURITY: restrict permissions before writing — startup diagnostics may
# include dashboard URLs, but auth tokens must stay redacted in logs.
_nemoclaw_safe_replace_tmp_file() {
  local target="$1"
  local mode="$2"
  local owner="${3:-}"
  local chmod_policy="${4:-required}"
  local dir base tmp
  dir="$(dirname "$target")"
  base="$(basename "$target")"
  tmp="$(mktemp "${dir}/.${base}.tmp.XXXXXX")" || return 1

  if ! cat >"$tmp"; then
    rm -f "$tmp" 2>/dev/null || true
    return 1
  fi
  if [ -n "$owner" ] && ! chown "$owner" "$tmp"; then
    rm -f "$tmp" 2>/dev/null || true
    return 1
  fi
  if [ "$chmod_policy" = "best-effort" ]; then
    chmod "$mode" "$tmp" 2>/dev/null || true
  elif ! chmod "$mode" "$tmp"; then
    rm -f "$tmp" 2>/dev/null || true
    return 1
  fi
  if ! mv -f "$tmp" "$target"; then
    rm -f "$tmp" 2>/dev/null || true
    return 1
  fi
}

_nemoclaw_safe_create_tmp_file() {
  _nemoclaw_safe_replace_tmp_file "$@" </dev/null
}

_START_LOG="/tmp/nemoclaw-start.log"
if [ "$(id -u)" -eq 0 ]; then
  _nemoclaw_safe_create_tmp_file "$_START_LOG" 600 root:root
else
  _nemoclaw_safe_create_tmp_file "$_START_LOG" 600 "" best-effort
fi
exec 3>&1
exec 4>&2
exec > >(tee -a "$_START_LOG" >&3) 2> >(tee -a "$_START_LOG" >&4)

# ── Source shared sandbox initialisation library ─────────────────
# Single source of truth for security-sensitive primitives shared with
# agents/hermes/start.sh. Ref: https://github.com/NVIDIA/NemoClaw/issues/2277
# Installed location (container): /usr/local/lib/nemoclaw/sandbox-init.sh
# Dev fallback: scripts/lib/sandbox-init.sh relative to this script.
_SANDBOX_INIT="/usr/local/lib/nemoclaw/sandbox-init.sh"
if [ ! -f "$_SANDBOX_INIT" ]; then
  _SANDBOX_INIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/sandbox-init.sh"
fi
# shellcheck source=scripts/lib/sandbox-init.sh
source "$_SANDBOX_INIT"

_GATEWAY_SUPERVISOR="/usr/local/lib/nemoclaw/gateway-supervisor.sh"
if [ ! -f "$_GATEWAY_SUPERVISOR" ]; then
  _GATEWAY_SUPERVISOR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/gateway-supervisor.sh"
fi
# shellcheck source=scripts/lib/gateway-supervisor.sh
source "$_GATEWAY_SUPERVISOR"

# Harden RLIMITs (nproc #809 + nofile #4527) as root PID 1, before the capsh
# drop and the setpriv step-down, so the caps are inherited and unraisable.
harden_resource_limits

# PATH was already locked down at the top of this script (before the
# early stderr capture). This comment marks the original location.

# Redirect tool caches and state to /tmp so transient package-manager and
# shell state stays outside the agent's durable workspace. Without these, tools
# would create noisy dotfiles (~/.npm, ~/.cache, ~/.bash_history, ~/.gitconfig,
# ~/.local, ~/.claude) under /sandbox.
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
  'PYTHON_HISTORY=/tmp/.python_history'
  'CLAUDE_CONFIG_DIR=/tmp/.claude'
  'npm_config_prefix=/tmp/npm-global'
  # Pin npm online at runtime so a stale base image or future build-time
  # offline-lock regression cannot force `only-if-cached` mode on PID 1 or
  # `openshell sandbox connect` sessions.
  'npm_config_offline=false'
  'NPM_CONFIG_OFFLINE=false'
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
    /tmp/.local/state /tmp/.runtime /tmp/.claude \
    /tmp/npm-global
  install -d -o sandbox -g sandbox -m 700 /tmp/.gnupg
else
  mkdir -p /tmp/.npm-cache /tmp/.cache /tmp/.config /tmp/.local/share \
    /tmp/.local/state /tmp/.runtime /tmp/.claude \
    /tmp/npm-global
  install -d -m 700 /tmp/.gnupg
fi

# ── Drop unnecessary Linux capabilities (shared) ────────────────
drop_capabilities /usr/local/bin/nemoclaw-start "$@"

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

# OpenShell blocks the link-local EC2 Instance Metadata Service. Force this
# after self-wrapper normalization so injected or inherited values cannot make
# OpenClaw processes probe an impossible credential source.
export AWS_EC2_METADATA_DISABLED=true

# Marker file the Docker HEALTHCHECK reads to decide whether an in-container
# gateway liveness check is meaningful. Its presence means this container has
# entered the OpenClaw gateway launch path (standalone deployments and the #3975
# forwarded-port shape); its absence means this entrypoint has not launched a
# gateway in this container, so the HEALTHCHECK short-circuits to healthy and
# defers to the runtime that owns gateway delivery. See the HEALTHCHECK block in
# the Dockerfile.
#
# IMPORTANT (#4710): the marker is dropped immediately before each
# `openclaw gateway run --port ...` invocation later in this script — NOT
# here. An early conditional gated on env hints (NEMOCLAW_CMD empty or
# OPENSHELL_DRIVERS=docker) is unreliable because OpenShell 0.0.44 does not
# export OPENSHELL_DRIVERS into the sandbox container env, so the guard never
# fires for docker-driver sandboxes. Other OpenShell env values are also not a
# trusted gateway-location source: they describe the sandbox container request,
# not whether this process owns the dashboard gateway. Tying the marker to the
# actual gateway-launch code path makes it true-by-construction: the marker
# exists if-and-only-if this container is about to start the gateway. Both the
# root and non-root entrypoint paths call `mark_in_container_gateway` directly
# before their `openclaw gateway run` invocation.
# Internal test seam shared by the PID writer and watchdog. This is deliberately
# not documented as a public env API; production always keeps the default path.
GATEWAY_PID_FILE=/tmp/nemoclaw-gateway.pid
GATEWAY_WATCHDOG_KILL_FILE="${_NEMOCLAW_GATEWAY_WATCHDOG_KILL_FILE:-/tmp/nemoclaw-gateway-watchdog-kill}"

# A numeric PID is not a process identity: Linux may reuse it immediately
# after the child is reaped.  Capture `/proc/<pid>/stat` field 22 (starttime)
# for every supervised process and require the pair to keep matching before
# admitting, probing, or signalling that process.  The `ps` fallback exists
# only so the shell helpers remain testable on non-Linux developer hosts;
# production containers always use the strict `/proc` identity.
GATEWAY_PID_START_IDENTITY=""
AUTO_PAIR_PID_START_IDENTITY=""
GATEWAY_LOG_TAIL_PID_START_IDENTITY=""
GATEWAY_LOG_PERSIST_PID_START_IDENTITY=""
PLUGIN_REFRESH_PID_START_IDENTITY=""
GATEWAY_WATCHDOG_PID_START_IDENTITY=""

openclaw_load_pid_identity() {
  local pid="$1"
  local proc_root="${_NEMOCLAW_PROC_ROOT:-/proc}"
  local stat_line rest parent_pid start_identity started

  OPENCLAW_OBSERVED_PARENT_PID=""
  OPENCLAW_OBSERVED_START_IDENTITY=""
  case "$pid" in
    '' | 0 | 1 | *[!0-9]*) return 1 ;;
  esac

  if [ -r "${proc_root}/${pid}/stat" ]; then
    IFS= read -r stat_line <"${proc_root}/${pid}/stat" || return 1
    rest="${stat_line##*) }"
    [ "$rest" != "$stat_line" ] || return 1
    # After `pid (comm)` is removed, state is $1, ppid is $2, and Linux
    # starttime (the original field 22) is $20.  `##*) ` deliberately uses
    # the final closing parenthesis because comm itself may contain `)`.
    # shellcheck disable=SC2086  # intentional field split of proc stat suffix
    set -- $rest
    [ "$#" -ge 20 ] || return 1
    parent_pid="$2"
    start_identity="${20}"
    case "$parent_pid" in
      '' | *[!0-9]*) return 1 ;;
    esac
    case "$start_identity" in
      '' | *[!0-9]*) return 1 ;;
    esac
  else
    # An explicitly supplied proc root is a fail-closed test seam: never fall
    # through to host `ps`, which would inspect a different process namespace.
    [ "${_NEMOCLAW_PROC_ROOT+x}" != x ] || return 1
    command -v ps >/dev/null 2>&1 || return 1
    parent_pid="$(ps -o ppid= -p "$pid" 2>/dev/null | awk 'NR == 1 { gsub(/[[:space:]]/, "", $0); print; exit }')"
    started="$(LC_ALL=C ps -o lstart= -p "$pid" 2>/dev/null | awk 'NR == 1 { sub(/^[[:space:]]+/, ""); sub(/[[:space:]]+$/, ""); print; exit }')"
    case "$parent_pid" in
      '' | *[!0-9]*) return 1 ;;
    esac
    [ -n "$started" ] || return 1
    start_identity="ps:${started//[[:space:]]/_}"
  fi

  OPENCLAW_OBSERVED_PARENT_PID="$parent_pid"
  OPENCLAW_OBSERVED_START_IDENTITY="$start_identity"
}

openclaw_pid_start_identity() {
  openclaw_load_pid_identity "$1" || return 1
  printf '%s\n' "$OPENCLAW_OBSERVED_START_IDENTITY"
}

capture_openclaw_pid_start_identity() {
  local pid="$1"
  local output_var="$2"
  local identity
  identity="$(openclaw_pid_start_identity "$pid")" || return 1
  [ -n "$identity" ] || return 1
  printf -v "$output_var" '%s' "$identity"
}

openclaw_supervised_pid_is_live() {
  local pid="$1"
  local expected_identity="$2"
  [ -n "$expected_identity" ] || return 1
  gateway_control_pid_is_live "$pid" || return 1
  openclaw_load_pid_identity "$pid" || return 1
  [ "$OPENCLAW_OBSERVED_PARENT_PID" = "$$" ] \
    && [ "$OPENCLAW_OBSERVED_START_IDENTITY" = "$expected_identity" ]
}

# Best-effort: a write failure must never block startup.
mark_in_container_gateway() {
  _nemoclaw_safe_create_tmp_file /tmp/nemoclaw-gateway-local 600 "" best-effort 2>/dev/null || true
}

# Record the PID/starttime identity of the live in-container gateway so the
# Docker HEALTHCHECK
# can confirm the actual gateway process (not merely *some* `openclaw`
# process) is still alive when the in-container curl probe cannot reach the
# dashboard port (#4952). Refreshed on every (re)launch so a respawned gateway
# is tracked and a window where the gateway is down reads as unhealthy.
# Best-effort: a write failure must never block startup.
record_gateway_pid() {
  printf '%s %s\n' "${1:-}" "${2:-}" \
    | _nemoclaw_safe_replace_tmp_file "$GATEWAY_PID_FILE" 600 "" best-effort 2>/dev/null || true
}

clear_gateway_pid_record() {
  printf '' | _nemoclaw_safe_replace_tmp_file "$GATEWAY_PID_FILE" 600 "" best-effort 2>/dev/null || true
}

record_gateway_watchdog_kill() {
  printf '%s\n' "${1:-}" \
    | _nemoclaw_safe_replace_tmp_file "$GATEWAY_WATCHDOG_KILL_FILE" 600 "" best-effort 2>/dev/null || true
}

consume_gateway_watchdog_kill() {
  local expected="$1" marked=""
  [ -f "$GATEWAY_WATCHDOG_KILL_FILE" ] || return 1
  IFS= read -r marked <"$GATEWAY_WATCHDOG_KILL_FILE" 2>/dev/null || true
  rm -f "$GATEWAY_WATCHDOG_KILL_FILE" 2>/dev/null || true
  [ -n "$marked" ] && [ "$marked" = "$expected" ]
}

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

emit_startup_error() {
  local message="$1"
  if [ -n "${_START_LOG:-}" ]; then
    printf '%s\n' "$message" >>"$_START_LOG" 2>/dev/null || true
  fi
  if { true >&4; } 2>/dev/null; then
    printf '%s\n' "$message" >&4
  else
    printf '%s\n' "$message" >&2
  fi
}

# Validate NEMOCLAW_DASHBOARD_PORT if set (same behavior as ports.js: fail fast).
_DASHBOARD_PORT_RAW="${NEMOCLAW_DASHBOARD_PORT:-}"
if [ -z "$_DASHBOARD_PORT_RAW" ]; then
  if _CHAT_UI_PORT="$(_chat_ui_url_port)"; then
    _DASHBOARD_PORT="$_CHAT_UI_PORT"
  else
    _DASHBOARD_PORT=18789
  fi
else
  _DASHBOARD_PORT="$(printf '%s' "$_DASHBOARD_PORT_RAW" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  _DASHBOARD_PORT_VALID=1
  case "$_DASHBOARD_PORT" in
    *[!0-9]* | '')
      _DASHBOARD_PORT_VALID=0
      ;;
  esac
  if [ "$_DASHBOARD_PORT_VALID" -eq 1 ] && { [ "$_DASHBOARD_PORT" -lt 1024 ] || [ "$_DASHBOARD_PORT" -gt 65535 ]; }; then
    _DASHBOARD_PORT_VALID=0
  fi
  if [ "$_DASHBOARD_PORT_VALID" -ne 1 ]; then
    emit_startup_error "[SECURITY] Invalid NEMOCLAW_DASHBOARD_PORT='${NEMOCLAW_DASHBOARD_PORT}' — must be an integer between 1024 and 65535"
    exit 1
  fi
fi
# When NEMOCLAW_DASHBOARD_PORT is explicitly set (injected at sandbox create time
# via envArgs in onboard.ts), unconditionally override CHAT_UI_URL so the gateway
# starts on the configured port even if the Docker image has a different value
# baked in. Without this, the Docker ENV takes precedence and the gateway listens
# on the wrong port while the SSH tunnel forwards the custom port. (#1925)
if [ -n "${NEMOCLAW_DASHBOARD_PORT:-}" ]; then
  CHAT_UI_URL="http://127.0.0.1:${_DASHBOARD_PORT}"
else
  CHAT_UI_URL="${CHAT_UI_URL:-http://127.0.0.1:${_DASHBOARD_PORT}}"
fi
PUBLIC_PORT="$_DASHBOARD_PORT"
export OPENCLAW_GATEWAY_PORT="$_DASHBOARD_PORT"
# Gateway WebSocket URL host. Default to the sandbox's own primary interface
# address rather than loopback: spawned sub-agent runtimes (sessions_spawn)
# dial OPENCLAW_GATEWAY_URL from inside the enforced process tree, where the
# OpenShell L7 proxy transparently intercepts connect() and hard-denies
# loopback destinations regardless of policy. With a loopback URL every child
# WebSocket upgrade dies with `1006 abnormal closure (no close frame)` and
# nothing reaches the gateway log. The gateway listens on 0.0.0.0 and the
# eth0 address is allowlisted in the base sandbox policy
# (openclaw_gateway_dialback in openclaw-sandbox.yaml), so the same dial
# works from both enforced and unenforced contexts. Falls back to loopback
# when no interface address is detectable (the pre-fix behavior). Override
# with NEMOCLAW_GATEWAY_WS_HOST.
_GATEWAY_WS_HOST="${NEMOCLAW_GATEWAY_WS_HOST:-}"
# Only auto-derive inside a real sandbox (the Dockerfile.base image always
# has /sandbox); on dev machines and CI runners the loopback default is
# kept. NEMOCLAW_SANDBOX_ROOT is overridable for tests. `|| true` keeps
# the assignment safe under `set -o pipefail` when hostname lacks -I.
if [ -z "$_GATEWAY_WS_HOST" ] && [ -d "${NEMOCLAW_SANDBOX_ROOT:-/sandbox}" ]; then
  _GATEWAY_WS_HOST="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
fi
if [ -z "$_GATEWAY_WS_HOST" ]; then
  _GATEWAY_WS_HOST="127.0.0.1"
fi
export OPENCLAW_GATEWAY_URL="ws://${_GATEWAY_WS_HOST}:${_DASHBOARD_PORT}"
if [ "$_GATEWAY_WS_HOST" != "127.0.0.1" ]; then
  # The OpenClaw client refuses plaintext ws:// to non-loopback private
  # addresses unless this break-glass is set. The sandbox bridge is a
  # host-local veth pair — frames never leave the machine — and the
  # alternative (loopback) is unconditionally blocked by the L7 proxy,
  # which breaks sessions_spawn entirely.
  export OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1
fi
OPENCLAW="$(command -v openclaw)" # Resolve once, use absolute path everywhere
_SANDBOX_HOME="/sandbox"          # Home dir for the sandbox user (useradd -d /sandbox in Dockerfile.base)
_OPENCLAW_STATE_DIR="${_SANDBOX_HOME}/.openclaw"
_OPENCLAW_CREDENTIALS_DIR="${_OPENCLAW_STATE_DIR}/credentials"

# OpenClaw 2026.4.x stores channel pairing requests under
# resolveOAuthDir(resolveStateDir(...))/<channel>-pairing.json. The gateway
# runs as the gateway user while connect-shell commands run as sandbox, so
# relying on HOME/os.homedir() can split pending requests across users. Force
# every OpenClaw process in the sandbox to the persistent shared state root.
export OPENCLAW_HOME="${_SANDBOX_HOME}"
export OPENCLAW_STATE_DIR="${_OPENCLAW_STATE_DIR}"
export OPENCLAW_CONFIG_PATH="${_OPENCLAW_STATE_DIR}/openclaw.json"
export OPENCLAW_OAUTH_DIR="${_OPENCLAW_CREDENTIALS_DIR}"

# ── Config integrity check (delegates to shared library) ────────
# verify_config_integrity_if_locked is provided by sandbox-init.sh. OpenClaw
# mutable-default startup skips strict hash enforcement until shields-up locks
# .config-hash into a root-owned read-only trust anchor.

# ── Mutable-default permission normalize (#2681) ─────────────────
# OpenClaw's control-UI toggles (Enable Dreaming, account toggles, etc.)
# write through mutateConfigFile to /sandbox/.openclaw/openclaw.json.
# In root mode the gateway runs as the gateway UID; the file is owned
# sandbox:sandbox. Without group write, every toggle EACCESs.
#
# Make the mutable-default tree group-readable/writable + setgid so both
# `gateway` (now a member of the sandbox group via Dockerfile.base
# usermod -aG) and `sandbox` can write. Setgid means new files
# inherit group=sandbox regardless of which UID created them, so the
# agent keeps read access and shields-up locking still works the same.
#
# Idempotent. Skips when shields are UP (config dir owned by root) so
# the lock is not weakened.
#
# This also self-heals a sandbox whose mutable config tree was tightened to
# single-user 700/600 by `openclaw doctor --fix` (#4538): every (re)start
# restores the setgid + group-writable contract. Host-side, `nemoclaw <name>
# doctor --fix` and the rebuild post-upgrade repair step apply the same
# normalization without requiring a restart.
resolve_mutable_config_normalizer() {
  local normalizer="/usr/local/lib/nemoclaw/normalize_mutable_config_perms.py"
  if [ -f "$normalizer" ]; then
    printf '%s\n' "$normalizer"
    return 0
  fi
  # A privileged repair may execute only the immutable helper installed in the
  # image. The environment and checkout fallbacks below exist solely for
  # non-root developer/test harnesses, where they cannot change ownership.
  if [ "$(id -u)" -eq 0 ]; then
    return 1
  fi
  if [ -n "${NEMOCLAW_MUTABLE_CONFIG_NORMALIZER:-}" ] \
    && [ -f "${NEMOCLAW_MUTABLE_CONFIG_NORMALIZER}" ]; then
    printf '%s\n' "${NEMOCLAW_MUTABLE_CONFIG_NORMALIZER}"
    return 0
  fi
  if [ -f "scripts/lib/normalize_mutable_config_perms.py" ]; then
    printf '%s\n' "scripts/lib/normalize_mutable_config_perms.py"
    return 0
  fi
  normalizer="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/normalize_mutable_config_perms.py"
  if [ -f "$normalizer" ]; then
    printf '%s\n' "$normalizer"
    return 0
  fi
  return 1
}

normalize_mutable_config_perms() {
  local config_dir="/sandbox/.openclaw"
  local operation="${1:-normalize}"

  if [ "$operation" != "normalize" ] \
    && [ "$operation" != "capture" ] \
    && [ "$operation" != "recover" ]; then
    printf '[SECURITY] Refusing mutable config permission normalization — invalid operation %s\n' "$operation" >&2
    return 1
  fi

  local config_dir_uid
  if ! config_dir_uid="$(
    python3 -I - "$config_dir" <<'PY_CLASSIFY_MUTABLE_CONFIG'
import os
import stat
import sys

try:
    metadata = os.lstat(sys.argv[1])
except FileNotFoundError:
    print("missing")
    raise SystemExit(0)
if not stat.S_ISDIR(metadata.st_mode):
    raise SystemExit(1)
print(metadata.st_uid)
PY_CLASSIFY_MUTABLE_CONFIG
  )"; then
    printf '[SECURITY] Refusing mutable config permission normalization — descriptor-safe classification failed\n' >&2
    return 1
  fi
  [ "$config_dir_uid" = "missing" ] && return 0
  if [ "$config_dir_uid" = "0" ]; then
    [ "$operation" = "normalize" ] || return 0
    # Dockerfile and policy sources establish sandbox:sandbox 2770/660 as the
    # mutable default. #6300 establishes the root-ownership/write regression,
    # but not a broader safe-to-repair state; no in-repo producer has been
    # identified. This compatibility path therefore accepts only the narrow
    # root:root 0700/0600 fixture, under a sandbox:sandbox 0755 parent. That is
    # distinct from #6047's sandbox-owned mode collapse, which the owner-UID
    # normalizer below repairs. Every other root-owned state fails closed.
    # Remove this path once the runtime preserves the declared ownership and
    # the live shields-config regression proves that boundary.
    reclaim_collapsed_mutable_config "$config_dir" || return 1
    return 0
  fi

  local expected_config_dir_uid expected_config_dir_gid
  if [ "$(id -u)" -eq 0 ]; then
    if ! expected_config_dir_uid="$(id -u sandbox)" \
      || ! expected_config_dir_gid="$(id -g sandbox)"; then
      printf '[SECURITY] Refusing mutable config permission normalization — sandbox identity lookup failed\n' >&2
      return 1
    fi
  else
    expected_config_dir_uid="$(id -u)"
    expected_config_dir_gid="$(id -g)"
  fi
  if [ "$config_dir_uid" != "$expected_config_dir_uid" ]; then
    printf '[SECURITY] Refusing mutable config permission normalization — config directory owner UID %s does not match sandbox UID %s\n' \
      "$config_dir_uid" "$expected_config_dir_uid" >&2
    return 1
  fi

  local normalizer
  if ! normalizer="$(resolve_mutable_config_normalizer)"; then
    printf '[SECURITY] Refusing mutable config permission normalization — trusted normalizer is missing\n' >&2
    return 1
  fi

  # Root supervises an owner-UID child and receives the still-open config
  # directory descriptor over a private authenticated socket. The descriptor
  # stays pinned across the privilege boundary, so inode reuse cannot make the
  # root baseline phase act on a substituted tree.
  local -a normalizer_args=(
    "$config_dir"
    "$expected_config_dir_uid"
    "$expected_config_dir_gid"
  )
  if [ "$operation" = "capture" ]; then
    local node_binary
    if ! node_binary="$(command -v node)" || [ -z "$node_binary" ]; then
      printf '[config] ERROR: JSON5 baseline validator failed for openclaw.json\n' >&2
      return 1
    fi
    normalizer_args+=(
      capture
      "$node_binary"
      /opt/nemoclaw/node_modules/json5
    )
  elif [ "$operation" = "recover" ]; then
    normalizer_args+=(recover)
  fi

  if ! python3 -I "$normalizer" "${normalizer_args[@]}"; then
    printf '[SECURITY] Refusing mutable config permission normalization — descriptor-safe repair detected an unsafe link, race, owner, or metadata state\n' >&2
    return 1
  fi
}

classify_openclaw_config_seal() {
  local config_dir="$1"
  local sandbox_uid sandbox_gid
  if [ "$(id -u)" -eq 0 ]; then
    sandbox_uid="$(id -u sandbox)" || return 2
    sandbox_gid="$(id -g sandbox)" || return 2
  else
    sandbox_uid="$(id -u)"
    sandbox_gid="$(id -g)"
  fi
  local normalizer
  normalizer="$(resolve_mutable_config_normalizer)" || return 2
  python3 -I "$normalizer" classify-seal \
    "$config_dir" "$sandbox_uid" "$sandbox_gid" >/dev/null
}

reclaim_collapsed_mutable_config() {
  local config_dir="$1"

  if [ "$(id -u)" -ne 0 ]; then
    if classify_openclaw_config_seal "$config_dir"; then
      return 0
    fi
    printf '[SECURITY] Refusing mutable config reclaim — root privileges are required\n' >&2
    return 1
  fi

  local sandbox_uid sandbox_gid
  if ! sandbox_uid="$(id -u sandbox)" || ! sandbox_gid="$(id -g sandbox)"; then
    printf '[SECURITY] Refusing mutable config reclaim — sandbox identity lookup failed\n' >&2
    return 1
  fi

  local normalizer
  if ! normalizer="$(resolve_mutable_config_normalizer)"; then
    printf '[SECURITY] Refusing mutable config reclaim — trusted normalizer is missing\n' >&2
    return 1
  fi

  if ! python3 -I "$normalizer" reclaim-if-unsealed "$config_dir" "$sandbox_uid" "$sandbox_gid" >/dev/null; then
    printf '[SECURITY] Refusing mutable config reclaim — descriptor-safe reclaim detected an unsafe link, race, owner, or metadata state\n' >&2
    return 1
  fi
}

# Invalid state (#4538, #6047): OpenClaw assumes a single-UID 700/600 config
# tree, while NemoClaw's separate sandbox and gateway UIDs require the mutable
# 2770/660 group contract. The tightening originates at the OpenClaw command
# boundary; NemoClaw owns restoring its multi-UID postcondition afterward.
# Regression proof lives in test/nemoclaw-start-perms.test.ts and the live
# shields-config documented-exec phase. Issue #6047 tracks the boundary and its
# removal condition: remove this wrapper only when the pinned OpenClaw preserves
# 2770/660 after every command outcome; do not replace that upstream source fix
# with a NemoClaw timeout or permission escape flag.
run_oneshot_command() {
  local _nemoclaw_runtime_env_file="${_RUNTIME_SHELL_ENV_FILE:-/tmp/nemoclaw-proxy-env.sh}"
  local _nemoclaw_oneshot_child_pid=""
  local _nemoclaw_oneshot_signal=""
  local _nemoclaw_oneshot_wait_rc=0
  local _nemoclaw_oneshot_cleanup_rc=0

  # Bash gives asynchronous commands /dev/null stdin and an ignored SIGINT
  # when job control is off. The explicit stdin and signal reset preserve the
  # foreground command contract; exec keeps the launched command as our one
  # direct child rather than adding a forwarding process.
  (
    trap - TERM INT
    # Source the root-owned runtime environment before stepping down so PID-1
    # one-shot commands use the same proxy, state, and gateway routing contract
    # as connect-shell and host `exec` commands.
    # shellcheck source=/dev/null
    if [ -r "$_nemoclaw_runtime_env_file" ]; then
      builtin source "$_nemoclaw_runtime_env_file" || exit $?
    fi
    # The shared, sandbox-readable file also exports the gateway token.
    # Remove it from the child's ambient environment so ordinary one-shot argv
    # uses local device auth and does not print it accidentally. This is not a
    # secrecy boundary against a command that deliberately reads the file.
    builtin unset OPENCLAW_GATEWAY_TOKEN
    builtin exec -- "$@"
  ) <&0 &
  _nemoclaw_oneshot_child_pid=$!
  trap '_nemoclaw_oneshot_signal=TERM; kill -TERM "$_nemoclaw_oneshot_child_pid" 2>/dev/null || true' TERM
  trap '_nemoclaw_oneshot_signal=INT; kill -INT "$_nemoclaw_oneshot_child_pid" 2>/dev/null || true' INT

  # A trapped signal interrupts `wait`. Forward it above, then wait again so
  # the direct child is reaped and its final status remains authoritative.
  while :; do
    _nemoclaw_oneshot_signal=""
    if wait "$_nemoclaw_oneshot_child_pid"; then
      _nemoclaw_oneshot_wait_rc=0
    else
      _nemoclaw_oneshot_wait_rc=$?
    fi
    [ -n "$_nemoclaw_oneshot_signal" ] || break
  done
  _nemoclaw_oneshot_child_pid=""

  if normalize_mutable_config_perms; then
    _nemoclaw_oneshot_cleanup_rc=0
  else
    _nemoclaw_oneshot_cleanup_rc=$?
  fi
  trap - TERM INT

  if [ "$_nemoclaw_oneshot_cleanup_rc" -ne 0 ]; then
    printf '[one-shot] command status=%s; permission cleanup status=%s; returning cleanup failure\n' \
      "$_nemoclaw_oneshot_wait_rc" "$_nemoclaw_oneshot_cleanup_rc" >&2
    return "$_nemoclaw_oneshot_cleanup_rc"
  fi
  return "$_nemoclaw_oneshot_wait_rc"
}

openclaw_config_dir_owner() {
  local config_dir="$1"
  stat -c '%U' "$config_dir" 2>/dev/null || stat -f '%Su' "$config_dir" 2>/dev/null || echo unknown
}

openclaw_locked_parent_is_protected() {
  local owner mode
  owner="$(stat -c '%U:%G' /sandbox 2>/dev/null || stat -f '%Su:%Sg' /sandbox 2>/dev/null || true)"
  mode="$(stat -c '%a' /sandbox 2>/dev/null || stat -f '%Lp' /sandbox 2>/dev/null || true)"
  case "${owner} ${mode}" in
    "root:sandbox 1775" | "root:sandbox 01775") return 0 ;;
    *) return 1 ;;
  esac
}

prepare_openclaw_config_startup() {
  run_openclaw_config_guard revoke-startup-ready --startup-owner || return 1

  # A persisted #6300 root:root 0700/0600 mutable tree overlaps one broad
  # orphan-freeze discriminator in the transaction guard. Repair only that
  # exact signature before recovery; sealed and indeterminate states remain
  # untouched for the guard to verify or recover under its mutation mutex.
  if [ "$(openclaw_config_dir_owner /sandbox/.openclaw)" = "root" ]; then
    local seal_state=0
    classify_openclaw_config_seal /sandbox/.openclaw || seal_state=$?
    case "$seal_state" in
      0 | 2) ;;
      1) reclaim_collapsed_mutable_config /sandbox/.openclaw || return 1 ;;
      *)
        printf '[SECURITY] Refusing mutable config startup — invalid seal classification %s\n' \
          "$seal_state" >&2
        return 1
        ;;
    esac
  fi

  run_openclaw_config_guard recover --startup-owner || return 1
  if [ "$(stat -c '%a %U:%G' /sandbox/.openclaw 2>/dev/null || true)" = "500 root:root" ]; then
    echo "[config-guard] resuming interrupted recursive OpenClaw state lock" >&2
    timeout --signal=TERM --kill-after=5s 12m \
      python3 -I "$_OPENCLAW_STATE_DIR_GUARD" lock \
      --config-dir /sandbox/.openclaw || return 1
  fi
}

prepare_openclaw_config_for_write() {
  local config_file="$1"
  local hash_file="$2"
  local config_dir
  config_dir="$(dirname "$config_file")"

  if [ -L "$config_dir" ] || [ -L "$config_file" ] || [ -L "$hash_file" ]; then
    printf '[SECURITY] Refusing config override — config directory or file path is a symlink\n' >&2
    return 1
  fi

  _NEMOCLAW_CONFIG_WRITE_MODE="locked"
  if [ "$(openclaw_config_dir_owner "$config_dir")" != "root" ]; then
    _NEMOCLAW_CONFIG_WRITE_MODE="mutable"
    if [ "$(id -u)" -eq 0 ]; then
      if ! chown root:sandbox "$config_dir"; then
        printf '[SECURITY] Failed to take ownership of %s for write\n' "$config_dir" >&2
        return 1
      fi
      local f
      for f in "$config_file" "$hash_file"; do
        [ -e "$f" ] || continue
        if ! chown root:sandbox "$f"; then
          printf '[SECURITY] Failed to take ownership of %s for write\n' "$f" >&2
          return 1
        fi
      done
    fi
    if ! chmod 2770 "$config_dir"; then
      printf '[SECURITY] Failed to relax permissions on %s\n' "$config_dir" >&2
      return 1
    fi
    local f
    for f in "$config_file" "$hash_file"; do
      [ -e "$f" ] || continue
      if ! chmod 660 "$f"; then
        printf '[SECURITY] Failed to relax permissions on %s\n' "$f" >&2
        return 1
      fi
    done
    return 0
  fi

  relax_config_for_write "$config_file" "$hash_file"
}

restore_openclaw_config_after_write() {
  local config_file="$1"
  local hash_file="$2"
  local config_dir
  config_dir="$(dirname "$config_file")"

  if [ -L "$config_dir" ] || [ -L "$config_file" ] || [ -L "$hash_file" ]; then
    printf '[SECURITY] Refusing config override restore — config directory or file path is a symlink\n' >&2
    return 1
  fi

  if [ "${_NEMOCLAW_CONFIG_WRITE_MODE:-locked}" = "mutable" ]; then
    if [ "$(id -u)" -eq 0 ]; then
      if ! chown sandbox:sandbox "$config_dir"; then
        printf '[SECURITY] Failed to restore ownership of %s\n' "$config_dir" >&2
        return 1
      fi
      local f
      for f in "$config_file" "$hash_file"; do
        [ -e "$f" ] || continue
        if ! chown sandbox:sandbox "$f"; then
          printf '[SECURITY] Failed to restore ownership of %s\n' "$f" >&2
          return 1
        fi
      done
    fi
    if ! chmod 2770 "$config_dir"; then
      printf '[SECURITY] Failed to restore permissions on %s\n' "$config_dir" >&2
      return 1
    fi
    local f
    for f in "$config_file" "$hash_file"; do
      [ -e "$f" ] || continue
      if ! chmod 660 "$f"; then
        printf '[SECURITY] Failed to restore permissions on %s\n' "$f" >&2
        return 1
      fi
    done
    return 0
  fi

  lock_config_after_write "$config_file" "$hash_file"
}

# ── Empty-config recovery and baseline (#3118) ──────────────────
# Upstream OpenShell's `openshell inference set` (run inside the sandbox to
# change the runtime model) can truncate /sandbox/.openclaw/openclaw.json to
# 0 bytes when its write fails partway through. The corrupted file then
# breaks `openclaw doctor --fix` (its own JSON5.parse crashes on empty
# input) and any other consumer of the config.
#
# These two functions are NemoClaw's defensive recovery — they don't fix the
# upstream bugs (which still need to be filed against OpenShell and OpenClaw)
# but they let a sandbox restart restore working state instead of leaving the
# sandbox unusable. Both are scoped to mutable-default mode: in shields-up
# mode openclaw.json is root-owned and immutable, so an empty file there
# implies tampering (which integrity check should catch) rather than the
# #3118 trigger (which requires a writable config).
# Remove this recovery only after upstream writes can no longer truncate
# openclaw.json and regression coverage proves the empty-config state cannot
# recur at any supported inference-update boundary.

# Capture a known-good copy of openclaw.json for later restore. A pristine
# root-owned baseline is retained; a sandbox-owned candidate is replaced from
# the exact validated active-config descriptor. Runs at root after
# apply_model_override and apply_cors_override so the baseline reflects the
# post-override config that the user actually started with. Refuses to capture
# broken state (empty, whitespace-only, or unparseable input).
write_openclaw_config_baseline() {
  local config_dir="/sandbox/.openclaw"
  local config_file="$config_dir/openclaw.json"
  local baseline_file="$config_dir/openclaw.json.nemoclaw-baseline"

  [ -d "$config_dir" ] || return 0
  [ -f "$config_file" ] || return 0
  [ "$(id -u)" -eq 0 ] || return 0

  local baseline_existed=0
  [ -e "$baseline_file" ] && baseline_existed=1

  # Capture and lock through the same pinned directory descriptor used by
  # permission normalization. The permanently dropped child validates and
  # pins the exact active config; root copies that descriptor into a fresh
  # inode. No root path-based cp/chown/chmod operation follows an
  # attacker-swappable entry in the mutable directory.
  normalize_mutable_config_perms capture || return 1
  if [ "$baseline_existed" -eq 0 ] && [ -f "$baseline_file" ]; then
    printf '[config] Baseline snapshot created: %s\n' "$baseline_file" >&2
  fi
}

# Restore openclaw.json from a baseline when the active file has been
# truncated to 0 bytes / whitespace-only. Runs at startup before
# verify_config_integrity_if_locked. Prefers OpenClaw's own
# openclaw.json.last-good (if it exists and is non-empty) over our
# nemoclaw-baseline so we ride OpenClaw's recovery convention when both
# are available. Recomputes .config-hash on success so subsequent
# integrity checks pass.
recover_openclaw_config_if_empty() {
  local config_dir="/sandbox/.openclaw"
  local config_file="$config_dir/openclaw.json"

  [ -d "$config_dir" ] || return 0
  [ -f "$config_file" ] || return 0

  # The owner-identity phase pins the mutable directory and recovery source,
  # then installs fresh sandbox-owned config/hash inodes with dir-fd-relative
  # atomic replaces. Root never follows, writes, chowns, or chmods an existing
  # sandbox-controlled pathname.
  normalize_mutable_config_perms recover
}

# Refresh the mutable-default .config-hash so it matches the current
# openclaw.json. Independent of the #3118 recovery above — this runs on
# every start after the override pipeline to keep the hash in sync with
# any in-flight config edits (model override, CORS override, provider
# placeholder refresh).
ensure_mutable_openclaw_config_hash() {
  local config_dir="/sandbox/.openclaw"
  local config_file="${config_dir}/openclaw.json"
  local hash_file="${config_dir}/.config-hash"

  [ -f "$config_file" ] || return 0
  if [ -L "$config_dir" ] || [ -L "$config_file" ] || [ -L "$hash_file" ]; then
    printf '[SECURITY] Refusing mutable config hash refresh — config directory or file path is a symlink\n' >&2
    return 1
  fi

  # Locked/shields-up mode treats .config-hash as a root-owned trust anchor.
  # verify_config_integrity_if_locked already fails closed when that anchor is
  # missing, so only synthesize/refresh the mutable-default hash.
  if [ "$(openclaw_config_dir_owner "$config_dir")" = "root" ]; then
    return 0
  fi

  # Mutable-default mode: $config_dir is 2770 sandbox:sandbox and
  # $hash_file is 660 sandbox:sandbox. Without CAP_DAC_OVERRIDE root
  # cannot bypass the sandbox-only write bit and the redirection
  # aborts with EACCES, so step down to the file's owner for the write.
  # shellcheck disable=SC2016  # positional params are expanded by the inner sh
  if [ "$(id -u)" -eq 0 ]; then
    if ! "${STEP_DOWN_PREFIX_SANDBOX[@]}" sh -c '
      cd "$1" || exit 1
      sha256sum openclaw.json >".config-hash" || exit 1
      chmod 660 ".config-hash" 2>/dev/null || true
    ' _ "$config_dir"; then
      printf '[SECURITY] Failed to refresh mutable OpenClaw config hash\n' >&2
      return 1
    fi
  elif ! sh -c '
    cd "$1" || exit 1
    sha256sum openclaw.json >".config-hash" || exit 1
    chmod 660 ".config-hash" 2>/dev/null || true
  ' _ "$config_dir"; then
    printf '[SECURITY] Failed to refresh mutable OpenClaw config hash\n' >&2
    return 1
  fi
}

# ── Runtime model/provider override ──────────────────────────────
# Patches openclaw.json at startup when NEMOCLAW_MODEL_OVERRIDE is set,
# allowing model or provider changes without rebuilding the sandbox image.
# Runs AFTER integrity check (detects build-time tampering). Recomputes
# the config hash so future integrity checks pass.
#
# SECURITY: These env vars come from the host (Docker/OpenShell), not from
# inside the sandbox. The agent cannot set them.
# Ref: https://github.com/NVIDIA/NemoClaw/issues/759

apply_model_override() {
  # Only explicit override env vars trigger a config patch. NEMOCLAW_CONTEXT_WINDOW,
  # NEMOCLAW_MAX_TOKENS, and NEMOCLAW_REASONING are promoted from Dockerfile build
  # ARGs to ENV and are always set — they should only take effect when accompanied
  # by an explicit model or API override. Without this guard the function runs on
  # every container start even with no override requested. Ref: #2653
  [ -n "${NEMOCLAW_MODEL_OVERRIDE:-}" ] \
    || [ -n "${NEMOCLAW_INFERENCE_API_OVERRIDE:-}" ] \
    || return 0

  # SECURITY: Only root can write to /sandbox/.openclaw (root:root 444).
  # In non-root mode the sandbox user cannot modify the config.
  if [ "$(id -u)" -ne 0 ]; then
    printf '[SECURITY] Model/inference overrides ignored — requires root (non-root mode cannot write to config)\n' >&2
    return 0
  fi

  local config_file="/sandbox/.openclaw/openclaw.json"
  local hash_file="/sandbox/.openclaw/.config-hash"

  # A shields-up pair is a host-sealed trust anchor. Startup/restart may read
  # it, but must never temporarily chmod or rewrite it behind the host's
  # persisted content seal. Apply host overrides after shields-down instead.
  if [ "$(openclaw_config_dir_owner "$(dirname "$config_file")")" = "root" ]; then
    printf '[config] Shields are up; deferring model/inference overrides until config is mutable\n' >&2
    return 0
  fi

  # SECURITY: Refuse to write through symlinks to prevent symlink-following attacks.
  # Legacy-layout migration rejects symlinked config paths before overrides; guard here too.
  if [ -L "$config_file" ] || [ -L "$hash_file" ]; then
    printf '[SECURITY] Refusing model override — config or hash path is a symlink\n' >&2
    return 1
  fi

  local model_override="${NEMOCLAW_MODEL_OVERRIDE:-}"
  local api_override="${NEMOCLAW_INFERENCE_API_OVERRIDE:-}"

  # SECURITY: Validate inputs — reject control characters and enforce length limit.
  if printf '%s' "$model_override" | grep -qP '[\x00-\x1f\x7f]'; then
    printf '[SECURITY] NEMOCLAW_MODEL_OVERRIDE contains control characters — refusing\n' >&2
    return 1
  fi
  if [ "${#model_override}" -gt 256 ]; then
    printf '[SECURITY] NEMOCLAW_MODEL_OVERRIDE exceeds 256 characters — refusing\n' >&2
    return 1
  fi

  # SECURITY: Allowlist inference API types to prevent unexpected routing.
  if [ -n "$api_override" ]; then
    case "$api_override" in
      openai-completions | anthropic-messages) ;;
      *)
        printf '[SECURITY] NEMOCLAW_INFERENCE_API_OVERRIDE must be "openai-completions" or "anthropic-messages", got "%s" — skipping override\n' "$api_override" >&2
        return 0
        ;;
    esac
  fi

  local context_window="${NEMOCLAW_CONTEXT_WINDOW:-}"
  local max_tokens="${NEMOCLAW_MAX_TOKENS:-}"
  local reasoning="${NEMOCLAW_REASONING:-}"

  # Validate supplemental override values before relaxing or writing config.
  if [ -n "$context_window" ] && ! printf '%s' "$context_window" | grep -qE '^[1-9][0-9]*$'; then
    printf '[SECURITY] NEMOCLAW_CONTEXT_WINDOW must be a positive integer, got "%s" — skipping override\n' "$context_window" >&2
    return 0
  fi
  if [ -n "$max_tokens" ] && ! printf '%s' "$max_tokens" | grep -qE '^[1-9][0-9]*$'; then
    printf '[SECURITY] NEMOCLAW_MAX_TOKENS must be a positive integer, got "%s" — skipping override\n' "$max_tokens" >&2
    return 0
  fi
  if [ -n "$reasoning" ]; then
    case "$reasoning" in
      true | false) ;;
      *)
        printf '[SECURITY] NEMOCLAW_REASONING must be "true" or "false", got "%s" — skipping override\n' "$reasoning" >&2
        return 0
        ;;
    esac
  fi

  [ -n "$model_override" ] && printf '[config] Applying model override: %s\n' "$model_override" >&2
  [ -n "$api_override" ] && printf '[config] Applying inference API override: %s\n' "$api_override" >&2
  [ -n "$context_window" ] && printf '[config] Applying context window override: %s\n' "$context_window" >&2
  [ -n "$max_tokens" ] && printf '[config] Applying max tokens override: %s\n' "$max_tokens" >&2
  [ -n "$reasoning" ] && printf '[config] Applying reasoning override: %s\n' "$reasoning" >&2

  # Shields-up configs are root-owned and re-locked after writing; mutable
  # default configs are briefly root-owned so writes still work after
  # CAP_DAC_OVERRIDE is dropped, then restored to sandbox:sandbox 2770/660.
  prepare_openclaw_config_for_write "$config_file" "$hash_file"
  local _write_rc=0

  NEMOCLAW_CONTEXT_WINDOW="$context_window" \
    NEMOCLAW_MAX_TOKENS="$max_tokens" \
    NEMOCLAW_REASONING="$reasoning" \
    python3 - "$config_file" "$model_override" "$api_override" <<'PYOVERRIDE' || _write_rc=$?
import json, os, sys

config_file, model_override, api_override = sys.argv[1], sys.argv[2], sys.argv[3]
context_window = os.environ.get("NEMOCLAW_CONTEXT_WINDOW", "")
max_tokens = os.environ.get("NEMOCLAW_MAX_TOKENS", "")
reasoning = os.environ.get("NEMOCLAW_REASONING", "")

with open(config_file) as f:
    cfg = json.load(f)

# Patch primary model reference
if model_override:
    cfg["agents"]["defaults"]["model"]["primary"] = model_override

# Patch model properties in provider config
for pkey, pval in cfg.get("models", {}).get("providers", {}).items():
    for m in pval.get("models", []):
        if model_override:
            m["id"] = model_override
            m["name"] = model_override
        if context_window:
            m["contextWindow"] = int(context_window)
        if max_tokens:
            m["maxTokens"] = int(max_tokens)
        if reasoning:
            m["reasoning"] = reasoning == "true"

    # Patch inference API type if overridden (cross-provider switch)
    if api_override:
        pval["api"] = api_override

with open(config_file, "w") as f:
    json.dump(cfg, f, indent=2)
PYOVERRIDE

  if [ "$_write_rc" -eq 0 ]; then
    # Recompute config hash so integrity check passes on next startup
    if (cd /sandbox/.openclaw && sha256sum openclaw.json >"$hash_file"); then
      printf '[SECURITY] Config hash recomputed after model override\n' >&2
    else
      _write_rc=$?
    fi
  fi

  # Always restore ownership/mode, even on write/hash failure (#2653, #2877).
  restore_openclaw_config_after_write "$config_file" "$hash_file"
  [ "$_write_rc" -eq 0 ] || return "$_write_rc"
}

# ── Agent identity reconciliation with provider routing ───────────
# After the host-side `openshell inference set` swaps the gateway's
# inference provider entry, agents.defaults.model.primary AND the
# in-sandbox models.providers.inference.models[0] entry can both go
# stale: openshell only updates the gateway, not /sandbox/.openclaw/
# openclaw.json. The gateway routes requests to the new model but
# the agent self-reports the old one, and on the next gateway
# reconciliation the file's stale entry can be pushed back, reverting
# the route.
#
# Probe the live gateway via `openshell inference get --json` and
# treat it as the source of truth: when the gateway model differs
# from the file, align both primary and the inference provider's
# first model entry so the agent identity and the gateway route stay
# consistent across the next reconcile cycle.
#
# When the gateway probe is unavailable (no openshell binary, gateway
# unreachable, malformed output), fall back to the legacy in-file
# reconcile so the function still closes primary↔models[0] drift.
#
# Runs after apply_model_override so explicit NEMOCLAW_MODEL_OVERRIDE
# values still win. No-op when already in sync.
# Ref: https://github.com/NVIDIA/NemoClaw/issues/3175

reconcile_agent_model_with_provider() {
  # apply_model_override already won; reconciling against the gateway would
  # overwrite the user's explicit choice with an inference/-prefixed variant.
  [ -z "${NEMOCLAW_MODEL_OVERRIDE:-}" ] || return 0

  if [ "$(id -u)" -ne 0 ]; then
    return 0
  fi

  local config_file="/sandbox/.openclaw/openclaw.json"
  local hash_file="/sandbox/.openclaw/.config-hash"

  [ -f "$config_file" ] || return 0

  if [ "$(openclaw_config_dir_owner "$(dirname "$config_file")")" = "root" ]; then
    printf '[config] Shields are up; skipping provider-model reconciliation for the sealed config\n' >&2
    return 0
  fi

  if [ -L "$config_file" ] || [ -L "$hash_file" ]; then
    return 0
  fi

  local gateway_model=""
  if command -v openshell >/dev/null 2>&1; then
    gateway_model="$(
      python3 - <<'PYPROBE'
import json, subprocess
try:
    result = subprocess.run(
        ["openshell", "inference", "get", "--json"],
        capture_output=True,
        timeout=3,
        check=False,
    )
except Exception:
    raise SystemExit(0)
if result.returncode != 0:
    raise SystemExit(0)
try:
    data = json.loads(result.stdout)
except Exception:
    raise SystemExit(0)
model = data.get("model") if isinstance(data, dict) else None
if isinstance(model, str) and model:
    print(model)
PYPROBE
    )"
  fi

  local provider_model_ref
  provider_model_ref="$(
    GATEWAY_MODEL="${gateway_model:-}" python3 - "$config_file" <<'PYRECONCILE_READ'
import json, os, sys

try:
    with open(sys.argv[1]) as f:
        cfg = json.load(f)
except Exception:
    sys.exit(0)

primary = cfg.get("agents", {}).get("defaults", {}).get("model", {}).get("primary")
provider = cfg.get("models", {}).get("providers", {}).get("inference", {})
models = provider.get("models") if isinstance(provider, dict) else None
first = (
    models[0]
    if isinstance(models, list) and models and isinstance(models[0], dict)
    else None
)


def qualify(model_id):
    if not isinstance(model_id, str) or not model_id:
        return None
    return model_id if model_id.startswith("inference/") else f"inference/{model_id}"


gateway_target = qualify(os.environ.get("GATEWAY_MODEL", ""))
if gateway_target is not None:
    bare = gateway_target[len("inference/"):]
    first_name = first.get("name") if first is not None else None
    first_id = first.get("id") if first is not None else None
    primary_ok = isinstance(primary, str) and primary == gateway_target
    first_name_ok = isinstance(first_name, str) and first_name == gateway_target
    first_id_ok = isinstance(first_id, str) and (first_id == bare or first_id == gateway_target)
    if primary_ok and first_name_ok and first_id_ok:
        sys.exit(0)
    print(f"gateway\t{gateway_target}")
    sys.exit(0)

# Legacy fallback: gateway probe is unavailable. Align primary with
# the in-file provider entry only (models[0] is treated as the
# source). Preserves pre-gateway-probe behavior for environments
# without openshell.
if first is None:
    sys.exit(0)
legacy_target = qualify(first.get("name") or first.get("id"))
if legacy_target is None:
    sys.exit(0)
if isinstance(primary, str) and primary == legacy_target:
    sys.exit(0)
print(f"legacy\t{legacy_target}")
PYRECONCILE_READ
  )"

  if [ -z "$provider_model_ref" ]; then
    return 0
  fi

  local source_mode="${provider_model_ref%%$'\t'*}"
  provider_model_ref="${provider_model_ref#*$'\t'}"

  printf '[config] Reconciling agent identity with provider model: %s (source=%s, #3175)\n' \
    "$provider_model_ref" "$source_mode" >&2

  prepare_openclaw_config_for_write "$config_file" "$hash_file"
  local _write_rc=0

  RECONCILE_SOURCE="$source_mode" python3 - "$config_file" "$provider_model_ref" <<'PYRECONCILE_WRITE' || _write_rc=$?
import json, os, sys
config_file, provider_model = sys.argv[1], sys.argv[2]
with open(config_file) as f:
    cfg = json.load(f)
cfg.setdefault("agents", {}).setdefault("defaults", {}).setdefault("model", {})["primary"] = provider_model
if os.environ.get("RECONCILE_SOURCE") == "gateway":
    bare = (
        provider_model[len("inference/"):]
        if provider_model.startswith("inference/")
        else provider_model
    )
    models_root = cfg.setdefault("models", {})
    providers_root = models_root.setdefault("providers", {})
    inference = providers_root.setdefault("inference", {})
    models_list = inference.get("models")
    if not isinstance(models_list, list) or not models_list:
        models_list = [{}]
        inference["models"] = models_list
    first = models_list[0]
    if not isinstance(first, dict):
        first = {}
        models_list[0] = first
    first["id"] = bare
    first["name"] = provider_model
with open(config_file, "w") as f:
    json.dump(cfg, f, indent=2)
PYRECONCILE_WRITE

  if [ "$_write_rc" -eq 0 ]; then
    if (cd /sandbox/.openclaw && sha256sum openclaw.json >"$hash_file"); then
      printf '[SECURITY] Config hash recomputed after agent identity reconciliation\n' >&2
    else
      _write_rc=$?
    fi
  fi

  restore_openclaw_config_after_write "$config_file" "$hash_file"
  [ "$_write_rc" -eq 0 ] || return "$_write_rc"
}

# ── Runtime CORS origin override ──────────────────────────────────
# Adds a browser origin to gateway.controlUi.allowedOrigins at startup
# without rebuilding the sandbox image. Useful for custom domains/ports.
# Same trust model as model override: host-set env var, applied before
# chattr +i, hash recomputed.
# Ref: https://github.com/NVIDIA/NemoClaw/issues/719

apply_cors_override() {
  [ -n "${NEMOCLAW_CORS_ORIGIN:-}" ] || return 0

  if [ "$(id -u)" -ne 0 ]; then
    printf '[SECURITY] NEMOCLAW_CORS_ORIGIN ignored — requires root (non-root mode cannot write to config)\n' >&2
    return 0
  fi

  local config_file="/sandbox/.openclaw/openclaw.json"
  local hash_file="/sandbox/.openclaw/.config-hash"

  if [ "$(openclaw_config_dir_owner "$(dirname "$config_file")")" = "root" ]; then
    printf '[config] Shields are up; deferring the CORS override until config is mutable\n' >&2
    return 0
  fi

  if [ -L "$config_file" ] || [ -L "$hash_file" ]; then
    printf '[SECURITY] Refusing CORS override — config or hash path is a symlink\n' >&2
    return 1
  fi

  local cors_origin="$NEMOCLAW_CORS_ORIGIN"

  if printf '%s' "$cors_origin" | grep -qP '[\x00-\x1f\x7f]'; then
    printf '[SECURITY] NEMOCLAW_CORS_ORIGIN contains control characters — refusing\n' >&2
    return 1
  fi
  if [ "${#cors_origin}" -gt 256 ]; then
    printf '[SECURITY] NEMOCLAW_CORS_ORIGIN exceeds 256 characters — refusing\n' >&2
    return 1
  fi
  if ! printf '%s' "$cors_origin" | grep -qE '^https?://'; then
    printf '[SECURITY] NEMOCLAW_CORS_ORIGIN must start with http:// or https://, got "%s" — skipping override\n' "$cors_origin" >&2
    return 0
  fi

  printf '[config] Adding CORS origin: %s\n' "$cors_origin" >&2

  # See apply_model_override for the locked-vs-mutable config mode split.
  prepare_openclaw_config_for_write "$config_file" "$hash_file"
  local _write_rc=0

  python3 - "$config_file" "$cors_origin" <<'PYCORS' || _write_rc=$?
import json, sys

config_file, cors_origin = sys.argv[1], sys.argv[2]

with open(config_file) as f:
    cfg = json.load(f)

origins = cfg.get("gateway", {}).get("controlUi", {}).get("allowedOrigins", [])
if cors_origin not in origins:
    origins.append(cors_origin)
    cfg.setdefault("gateway", {}).setdefault("controlUi", {})["allowedOrigins"] = origins

with open(config_file, "w") as f:
    json.dump(cfg, f, indent=2)
PYCORS

  if [ "$_write_rc" -eq 0 ]; then
    if (cd /sandbox/.openclaw && sha256sum openclaw.json >"$hash_file"); then
      printf '[config] Config hash recomputed after CORS override\n' >&2
    else
      _write_rc=$?
    fi
  fi

  # Always restore ownership/mode, even on write/hash failure (#2653, #2877).
  restore_openclaw_config_after_write "$config_file" "$hash_file"
  [ "$_write_rc" -eq 0 ] || return "$_write_rc"
}

# OpenShell provider snapshots can expose revision-scoped placeholders such as
# openshell:resolve:env:v11_<ENV_KEY> in the child environment. Refresh
# baked canonical placeholders in openclaw.json after the integrity check so
# token egress keeps working across provider attach/refresh generations without
# ever writing a raw credential to disk.
refresh_openclaw_provider_placeholders() {
  local config_file="/sandbox/.openclaw/openclaw.json"
  local hash_file="/sandbox/.openclaw/.config-hash"
  [ -f "$config_file" ] || return 0

  if [ "$(openclaw_config_dir_owner "$(dirname "$config_file")")" = "root" ]; then
    printf '[config] Shields are up; preserving sealed provider placeholders unchanged\n' >&2
    return 0
  fi

  local keys
  keys="$(
    python3 - "$config_file" <<'PYPLACEHOLDERKEYS'
import base64
import json
import os
import re
import sys

config_file = sys.argv[1]
prefix = "openshell:resolve:env:"
alias_marker = "-OPENSHELL-RESOLVE-ENV-"
env_key_re = re.compile(r"^[A-Z][A-Z0-9_]{0,127}$")
revision_re = re.compile(r"^v[0-9]+_")
keys = set()
MESSAGING_RUNTIME_PLAN_DEFAULT_PATH = "/usr/local/share/nemoclaw/messaging-runtime-plan.json"


def add_key(value):
    key = revision_re.sub("", value)
    if env_key_re.match(key):
        keys.add(key)


def walk(value):
    if isinstance(value, str):
        if value.startswith(prefix):
            add_key(value[len(prefix) :])
        alias_index = value.find(alias_marker)
        if alias_index > 0:
            add_key(value[alias_index + len(alias_marker) :])
        return
    if isinstance(value, list):
        for item in value:
            walk(item)
        return
    if isinstance(value, dict):
        for item in value.values():
            walk(item)


try:
    with open(config_file, encoding="utf-8") as f:
        walk(json.load(f))
except Exception:
    pass

def read_messaging_plan():
    raw_plan = os.environ.get("NEMOCLAW_MESSAGING_PLAN_B64", "").strip()
    if raw_plan:
        try:
            return json.loads(base64.b64decode(raw_plan).decode("utf-8"))
        except Exception:
            return None
    artifact_path = os.environ.get(
        "NEMOCLAW_MESSAGING_RUNTIME_PLAN_PATH",
        MESSAGING_RUNTIME_PLAN_DEFAULT_PATH,
    )
    if not artifact_path or not os.path.isfile(artifact_path):
        return None
    try:
        with open(artifact_path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


plan = read_messaging_plan()
if isinstance(plan, dict):
    for binding in plan.get("credentialBindings", []):
        if isinstance(binding, dict) and isinstance(binding.get("providerEnvKey"), str):
            add_key(binding["providerEnvKey"])

base_keys = {
    key
    for key in keys
    if not any(key != candidate and key.startswith(f"{candidate}_") for candidate in keys)
}
print(" ".join(sorted(base_keys)))
PYPLACEHOLDERKEYS
  )"
  local base_keys="$keys"

  # Append operator-registered extras from NEMOCLAW_EXTRA_PLACEHOLDER_KEYS so
  # the revision-strip walk also collapses suffixed placeholders such as
  # openshell:resolve:env:v51_<ENV_KEY>_AGENT_A back to the canonical
  # form. The host-side onboard parser at
  # src/lib/onboard/extra-placeholder-keys.ts already filters by an identical
  # regex, rejects canonical-channel collisions, and requires every entry to
  # extend a canonical channel envKey with a non-empty `_<suffix>`; this loop
  # mirrors those checks against provider envKeys discovered from the messaging
  # plan and current OpenClaw config because the env var travels through one
  # extra hop and a sandbox operator could clobber it independently. Keeping the
  # sandbox parser restrictive means a host-side refusal for unrelated secrets
  # (GITHUB_TOKEN, NEMOCLAW_EXTRA_PLACEHOLDER_KEYS itself, etc.) cannot be
  # bypassed by mutating the runtime env after sandbox boot.
  local extra_token
  local _extra_raw="${NEMOCLAW_EXTRA_PLACEHOLDER_KEYS-}"
  # Normalize commas to whitespace so callers can pass either form,
  # matching the host-side parseExtraPlaceholderKeys contract.
  _extra_raw="${_extra_raw//,/ }"
  local _extras_accepted=0
  local _canon_prefix
  local _accepted_this_token
  local _canonical_collision
  local _example_key
  local _accepted_extra_keys=""
  for extra_token in $_extra_raw; do
    [ -n "$extra_token" ] || continue
    _canonical_collision=0
    for _canon_prefix in $base_keys; do
      if [ "$extra_token" = "$_canon_prefix" ]; then
        _canonical_collision=1
        break
      fi
    done
    [ "$_canonical_collision" -eq 1 ] && continue
    if ! printf '%s' "$extra_token" | grep -Eq '^[A-Z][A-Z0-9_]{0,127}$'; then
      printf "[config] Ignoring NEMOCLAW_EXTRA_PLACEHOLDER_KEYS entry '%s' — must match /^[A-Z][A-Z0-9_]{0,127}\$/\n" \
        "$extra_token" >&2
      continue
    fi
    _accepted_this_token=0
    _example_key=""
    for _canon_prefix in $base_keys; do
      [ -n "$_example_key" ] || _example_key="$_canon_prefix"
      case "$extra_token" in
        "${_canon_prefix}_"?*)
          _accepted_this_token=1
          break
          ;;
      esac
    done
    if [ "$_accepted_this_token" -ne 1 ]; then
      if [ -n "$_example_key" ]; then
        printf "[config] Ignoring NEMOCLAW_EXTRA_PLACEHOLDER_KEYS entry '%s' — must extend a discovered provider envKey such as %s_<suffix>\n" \
          "$extra_token" "$_example_key" >&2
      else
        printf "[config] Ignoring NEMOCLAW_EXTRA_PLACEHOLDER_KEYS entry '%s' — must extend a discovered provider envKey from the messaging plan or OpenClaw config\n" \
          "$extra_token" >&2
      fi
      continue
    fi
    if [ "$_extras_accepted" -ge 32 ]; then
      printf "[config] NEMOCLAW_EXTRA_PLACEHOLDER_KEYS: capped at 32 entries; ignoring remainder\n" >&2
      break
    fi
    keys="$keys $extra_token"
    _accepted_extra_keys="${_accepted_extra_keys:+$_accepted_extra_keys }$extra_token"
    _extras_accepted=$((_extras_accepted + 1))
  done
  if [ "$_extras_accepted" -gt 0 ]; then
    # Deterministic breadcrumb so e2e harnesses can prove the host-validated
    # extras list reached the in-container refresh helper even when no
    # revision-scoped placeholder has been staged yet (which is the steady
    # state for a fresh provider attach). Stripping the canonical baseline
    # prefix here keeps the log line about extras only.
    printf '[config] NEMOCLAW_EXTRA_PLACEHOLDER_KEYS accepted %d entry(ies): %s\n' \
      "$_extras_accepted" "$_accepted_extra_keys" >&2
  fi

  if [ -L "$config_file" ] || [ -L "$hash_file" ]; then
    printf '[SECURITY] Refusing provider placeholder refresh — config or hash path is a symlink\n' >&2
    return 1
  fi

  prepare_openclaw_config_for_write "$config_file" "$hash_file"
  local _write_rc=0
  local _placeholder_report=""

  _placeholder_report="$(
    NEMOCLAW_PROVIDER_PLACEHOLDER_KEYS="$keys" \
      python3 - "$config_file" <<'PYPLACEHOLDERS'
import json
import os
import re
import sys

config_file = sys.argv[1]
prefix = "openshell:resolve:env:"
alias_marker = "-OPENSHELL-RESOLVE-ENV-"
keys = os.environ.get("NEMOCLAW_PROVIDER_PLACEHOLDER_KEYS", "").split()
replacements = {}
warnings = []

for key in keys:
    value = os.environ.get(key, "")
    if value.startswith(prefix) and value != f"{prefix}{key}":
        replacements[f"{prefix}{key}"] = (key, value)

with open(config_file, encoding="utf-8") as f:
    config = json.load(f)

refreshed = set()

# Match each canonical placeholder only as an exact token. The OpenShell
# placeholder grammar is "openshell:resolve:env:[A-Za-z_][A-Za-z0-9_]*",
# so the negative-lookahead ensures replacing one provider env key does not
# also mutate a suffixed extra placeholder; sort longest-first so two keys
# sharing a strict prefix still match the more specific one when both
# replacements happen to apply to the same exact-token position (the
# lookahead already guarantees disjoint matches in practice, but keeping
# longest-first preserves the determinism the tests rely on).
replacement_patterns = [
    (re.compile(re.escape(old) + r"(?![A-Za-z0-9_])"), key, new)
    for old, (key, new) in sorted(replacements.items(), key=lambda kv: -len(kv[0]))
]


def rewrite(value):
    if isinstance(value, str):
        for pattern, key, new in replacement_patterns:
            updated, count = pattern.subn(new, value)
            if count:
                refreshed.add(key)
                value = updated
        return value
    if isinstance(value, list):
        return [rewrite(item) for item in value]
    if isinstance(value, dict):
        return {k: rewrite(v) for k, v in value.items()}
    return value

updated = rewrite(config)

def placeholder_suffix_matches_env_key(suffix, env_key):
    if suffix == env_key:
        return True
    revision = re.match(r"^v[0-9]+_", suffix)
    return bool(revision and suffix[len(revision.group(0)) :] == env_key)


def path_label(path):
    if len(path) >= 5 and path[0] == "channels" and path[2] == "accounts":
        return f"{path[1]}.{path[3]}.{path[4]}"
    return ".".join(path)


def walk_for_warnings(value, path):
    if isinstance(value, str):
        if value.startswith(prefix):
            suffix = value[len(prefix) :]
            for env_key in keys:
                if not placeholder_suffix_matches_env_key(suffix, env_key):
                    continue
                env_value = os.environ.get(env_key, "")
                label = path_label(path)
                if not env_value:
                    warnings.append(
                        f"[channels] {label} is an OpenShell placeholder but {env_key} is missing from the runtime environment"
                    )
                elif not env_value.startswith(prefix):
                    warnings.append(
                        f"[channels] {label} left unchanged because {env_key} is not an OpenShell placeholder; refusing to write raw credentials to openclaw.json"
                    )
                elif not placeholder_suffix_matches_env_key(env_value[len(prefix) :], env_key):
                    warnings.append(
                        f"[channels] {label} placeholder does not match the OpenShell runtime placeholder for {env_key}"
                    )
                elif value != env_value:
                    warnings.append(
                        f"[channels] {label} placeholder does not match the OpenShell runtime placeholder for {env_key}"
                    )
                break
        alias_index = value.find(alias_marker)
        if alias_index > 0:
            alias_env_key = value[alias_index + len(alias_marker) :]
            token_scheme = value[:alias_index] + "-"
            for env_key in keys:
                if env_key != alias_env_key:
                    continue
                label = path_label(path)
                env_value = os.environ.get(env_key, "")
                placeholder_re = re.compile(
                    rf"^{re.escape(prefix)}(v[0-9]+_)?{re.escape(env_key)}$"
                )
                if not env_value:
                    warnings.append(
                        f"[channels] {label} expects the {env_key} provider placeholder but it is missing from the runtime environment"
                    )
                elif not placeholder_re.match(env_value) and not env_value.startswith(token_scheme):
                    warnings.append(
                        f"[channels] {label} runtime {env_key} is neither the {env_key} OpenShell placeholder nor a {token_scheme} token; runtime may reject it"
                    )
                break
        return
    if isinstance(value, list):
        for index, item in enumerate(value):
            walk_for_warnings(item, path + [str(index)])
        return
    if isinstance(value, dict):
        for key, item in value.items():
            walk_for_warnings(item, path + [str(key)])


walk_for_warnings(updated, [])

if updated != config:
    with open(config_file, "w", encoding="utf-8") as f:
        json.dump(updated, f, indent=2)
        f.write("\n")

if refreshed:
    print("refreshed=" + ",".join(sorted(refreshed)))
for warning in warnings:
    print("warning=" + warning)
PYPLACEHOLDERS
  )" || _write_rc=$?

  if [ "$_write_rc" -eq 0 ]; then
    local _refreshed_keys
    _refreshed_keys="$(printf '%s\n' "$_placeholder_report" | sed -n 's/^refreshed=//p' | tail -n 1)"
    if [ -n "$_refreshed_keys" ]; then
      if (cd /sandbox/.openclaw && sha256sum openclaw.json >"$hash_file"); then
        printf '[config] Refreshed provider placeholders from OpenShell runtime env: %s\n' "$_refreshed_keys" >&2
      else
        _write_rc=$?
      fi
    fi
    printf '%s\n' "$_placeholder_report" | sed -n 's/^warning=//p' | while IFS= read -r _warning; do
      [ -n "$_warning" ] && printf '%s\n' "$_warning" >&2
    done
  fi

  restore_openclaw_config_after_write "$config_file" "$hash_file"
  [ "$_write_rc" -eq 0 ] || return "$_write_rc"
}

# ── Messaging runtime setup from manifest metadata ───────────────
# Channel-owned runtime setup is compiled from manifests at image build time.
# The entrypoint consumes only generic declarations: envAliases, nodePreloads,
# and secretScans. Prefer a forwarded env plan when present; otherwise load the
# reduced image artifact written by the messaging build applier.
_MESSAGING_RUNTIME_PLAN_ARTIFACT="${NEMOCLAW_MESSAGING_RUNTIME_PLAN_PATH:-/usr/local/share/nemoclaw/messaging-runtime-plan.json}"
_MESSAGING_RUNTIME_SETUP_PLAN="/tmp/nemoclaw-messaging-runtime-setup.json"
_MESSAGING_CONNECT_PRELOADS_FILE="/tmp/nemoclaw-messaging-connect-preloads.list"

write_messaging_runtime_setup_plan() {
  python3 - "$_MESSAGING_RUNTIME_PLAN_ARTIFACT" <<'PYMESSAGINGRUNTIME' | emit_sandbox_sourced_file "$_MESSAGING_RUNTIME_SETUP_PLAN"
import base64
import json
import os
import re
import sys

EMPTY = {"nodePreloads": [], "envAliases": [], "secretScans": []}
PRELOAD_SOURCE_PREFIX = "/usr/local/lib/nemoclaw/preloads/"
PRELOAD_TARGET_PREFIX = "/tmp/nemoclaw-"
ENV_KEY_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,127}$")


def fail(message):
    print(f"[channels] Invalid messaging runtime setup plan: {message}", file=sys.stderr)
    raise SystemExit(1)


def clean_string(value, field, *, allow_empty=False):
    if not isinstance(value, str):
        fail(f"{field} must be a string")
    if not allow_empty and not value:
        fail(f"{field} must not be empty")
    if any(ch in value for ch in "\x00\r\n\t"):
        fail(f"{field} contains a control character")
    return value


def clean_message(value, field):
    if value is None:
        return ""
    if not isinstance(value, str):
        fail(f"{field} must be a string")
    if any(ch in value for ch in "\x00\r\n\t"):
        fail(f"{field} contains a control character")
    return value


def clean_node_preload(entry, index):
    if not isinstance(entry, dict):
        fail(f"nodePreloads[{index}] must be an object")
    source = clean_string(entry.get("source"), f"nodePreloads[{index}].source")
    target = clean_string(entry.get("target"), f"nodePreloads[{index}].target")
    if not source.startswith(PRELOAD_SOURCE_PREFIX) or not source.endswith(".js"):
        fail(f"nodePreloads[{index}].source must be a preload JavaScript file under {PRELOAD_SOURCE_PREFIX}")
    if not target.startswith(PRELOAD_TARGET_PREFIX) or not target.endswith(".js"):
        fail(f"nodePreloads[{index}].target must be a JavaScript file under {PRELOAD_TARGET_PREFIX}*")
    inject_into = entry.get("injectInto", [])
    if not isinstance(inject_into, list):
        fail(f"nodePreloads[{index}].injectInto must be a list")
    normalized_scopes = []
    for scope in inject_into:
        if scope not in ("boot", "connect"):
            fail(f"nodePreloads[{index}].injectInto contains unsupported value {scope!r}")
        if scope not in normalized_scopes:
            normalized_scopes.append(scope)
    optional = entry.get("optional", False)
    if not isinstance(optional, bool):
        fail(f"nodePreloads[{index}].optional must be a boolean")
    return {
        "source": source,
        "target": target,
        "injectInto": normalized_scopes,
        "optional": optional,
        "installMessage": clean_message(entry.get("installMessage"), f"nodePreloads[{index}].installMessage"),
        "installedMessage": clean_message(entry.get("installedMessage"), f"nodePreloads[{index}].installedMessage"),
    }


def clean_env_alias(entry, index):
    if not isinstance(entry, dict):
        fail(f"envAliases[{index}] must be an object")
    env_key = clean_string(entry.get("envKey"), f"envAliases[{index}].envKey")
    if not ENV_KEY_RE.match(env_key):
        fail(f"envAliases[{index}].envKey is not a safe environment key")
    pattern = clean_string(entry.get("match"), f"envAliases[{index}].match")
    try:
        re.compile(pattern)
    except re.error as exc:
        fail(f"envAliases[{index}].match is not a valid regex: {exc}")
    return {
        "envKey": env_key,
        "match": pattern,
        "value": clean_string(entry.get("value"), f"envAliases[{index}].value", allow_empty=True),
        "message": clean_message(entry.get("message"), f"envAliases[{index}].message"),
    }


def clean_secret_scan(entry, index):
    if not isinstance(entry, dict):
        fail(f"secretScans[{index}] must be an object")
    path = clean_string(entry.get("path"), f"secretScans[{index}].path")
    if not path.startswith("/sandbox/"):
        fail(f"secretScans[{index}].path must be under /sandbox")
    pattern = clean_string(entry.get("pattern"), f"secretScans[{index}].pattern")
    try:
        re.compile(pattern)
    except re.error as exc:
        fail(f"secretScans[{index}].pattern is not a valid regex: {exc}")
    exit_code = entry.get("exitCode", 78)
    if not isinstance(exit_code, int) or exit_code < 1 or exit_code > 255:
        fail(f"secretScans[{index}].exitCode must be an integer from 1 to 255")
    return {
        "path": path,
        "pattern": pattern,
        "message": clean_message(entry.get("message"), f"secretScans[{index}].message") or "[SECURITY] Runtime secret scan failed for {path}",
        "exitCode": exit_code,
    }


def load_messaging_plan():
    raw_plan = os.environ.get("NEMOCLAW_MESSAGING_PLAN_B64", "").strip()
    if raw_plan:
        try:
            return json.loads(base64.b64decode(raw_plan, validate=True).decode("utf-8"))
        except Exception as exc:
            fail(f"NEMOCLAW_MESSAGING_PLAN_B64 is not valid base64 JSON: {exc}")
    artifact_path = sys.argv[1] if len(sys.argv) > 1 else ""
    if not artifact_path or not os.path.isfile(artifact_path):
        return None
    try:
        with open(artifact_path, encoding="utf-8") as handle:
            return json.load(handle)
    except Exception as exc:
        fail(f"messaging runtime plan artifact {artifact_path} is not valid JSON: {exc}")


plan = load_messaging_plan()
if plan is None:
    print(json.dumps(EMPTY, sort_keys=True))
    raise SystemExit(0)
if not isinstance(plan, dict):
    fail("decoded plan must be an object")

disabled_channels = {
    channel_id
    for channel_id in plan.get("disabledChannels", [])
    if isinstance(channel_id, str)
}
active_channel_ids = set()
for channel in plan.get("channels", []):
    if not isinstance(channel, dict):
        continue
    channel_id = channel.get("channelId")
    if not isinstance(channel_id, str):
        continue
    if channel.get("active") is True and channel.get("disabled") is not True and channel_id not in disabled_channels:
        active_channel_ids.add(channel_id)

runtime_setup = plan.get("runtimeSetup", EMPTY)
if runtime_setup is None:
    runtime_setup = EMPTY
if not isinstance(runtime_setup, dict):
    fail("runtimeSetup must be an object")


def runtime_setup_entries(key):
    entries = runtime_setup.get(key, [])
    if not isinstance(entries, list):
        fail(f"runtimeSetup.{key} must be a list")
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            fail(f"runtimeSetup.{key}[{index}] must be an object")
        channel_id = entry.get("channelId")
        if not isinstance(channel_id, str) or not channel_id:
            fail(f"runtimeSetup.{key}[{index}].channelId must be a string")
        if channel_id not in active_channel_ids:
            continue
        yield entry


node_preloads = []
env_aliases = []
secret_scans = []
seen_node_preloads = set()
seen_aliases = set()
seen_scans = set()

for entry in runtime_setup_entries("nodePreloads"):
    preload = clean_node_preload(entry, len(node_preloads))
    preload_key = (preload["source"], preload["target"])
    if preload_key not in seen_node_preloads:
        seen_node_preloads.add(preload_key)
        node_preloads.append(preload)
for entry in runtime_setup_entries("envAliases"):
    alias = clean_env_alias(entry, len(env_aliases))
    alias_key = (alias["envKey"], alias["match"], alias["value"])
    if alias_key not in seen_aliases:
        seen_aliases.add(alias_key)
        env_aliases.append(alias)
for entry in runtime_setup_entries("secretScans"):
    scan = clean_secret_scan(entry, len(secret_scans))
    scan_key = (scan["path"], scan["pattern"])
    if scan_key not in seen_scans:
        seen_scans.add(scan_key)
        secret_scans.append(scan)

print(json.dumps({"nodePreloads": node_preloads, "envAliases": env_aliases, "secretScans": secret_scans}, sort_keys=True))
PYMESSAGINGRUNTIME
}

apply_messaging_runtime_env_aliases() {
  [ -f "$_MESSAGING_RUNTIME_SETUP_PLAN" ] || return 0
  local _rows
  _rows="$(
    python3 - "$_MESSAGING_RUNTIME_SETUP_PLAN" <<'PYMESSAGINGALIASES'
import json
import os
import re
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    plan = json.load(handle)
for alias in plan.get("envAliases", []):
    if not re.search(alias["match"], os.environ.get(alias["envKey"], "")):
        continue
    print("\t".join([
        alias["envKey"],
        alias["value"],
        alias.get("message", ""),
    ]))
PYMESSAGINGALIASES
  )" || return $?
  [ -n "$_rows" ] || return 0

  local _env_key _value _message
  while IFS=$'\t' read -r _env_key _value _message; do
    export "$_env_key=$_value"
    [ -n "$_message" ] && printf '%s\n' "$_message" >&2
  done <<<"$_rows"
}

node_options_has_require() {
  local wanted="$1"
  local previous=""
  local token
  local tokens=()
  IFS=$' \t\n' read -r -a tokens <<<"${NODE_OPTIONS:-}"
  # Iterating "${tokens[@]}" on an empty array trips `set -u` on bash 3.2
  # (macOS default); guard so the local unit harnesses run there too.
  [ "${#tokens[@]}" -gt 0 ] || return 1
  for token in "${tokens[@]}"; do
    if [ "$previous" = "--require" ] && [ "$token" = "$wanted" ]; then
      return 0
    fi
    [ "$token" = "--require=$wanted" ] && return 0
    previous="$token"
  done
  return 1
}

append_node_require_once() {
  local wanted="$1"
  if ! node_options_has_require "$wanted"; then
    export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require $wanted"
  fi
}

install_messaging_runtime_preloads() {
  [ -f "$_MESSAGING_RUNTIME_SETUP_PLAN" ] || return 0
  local _rows
  _rows="$(
    python3 - "$_MESSAGING_RUNTIME_SETUP_PLAN" <<'PYMESSAGINGPRELOADS'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    plan = json.load(handle)
for preload in plan.get("nodePreloads", []):
    print("\t".join([
        preload["source"],
        preload["target"],
        ",".join(preload.get("injectInto", [])),
        "1" if preload.get("optional") else "0",
        preload.get("installMessage", ""),
        preload.get("installedMessage", ""),
    ]))
PYMESSAGINGPRELOADS
  )" || return $?

  local _connect_preloads=()
  if [ -n "$_rows" ]; then
    local _source _target _inject_into _optional _install_message _installed_message
    while IFS=$'\t' read -r _source _target _inject_into _optional _install_message _installed_message; do
      if [ ! -f "$_source" ]; then
        [ "$_optional" = "1" ] && continue
        printf '[channels] Missing runtime preload source: %s\n' "$_source" >&2
        return 1
      fi
      [ -n "$_install_message" ] && printf '%s\n' "$_install_message" >&2
      emit_sandbox_sourced_file "$_target" <"$_source" || return 1
      case ",$_inject_into," in
        *,boot,*)
          append_node_require_once "$_target"
          ;;
      esac
      case ",$_inject_into," in
        *,connect,*)
          _connect_preloads+=("$_target")
          ;;
      esac
      [ -n "$_installed_message" ] && printf '%s\n' "$_installed_message" >&2
    done <<<"$_rows"
  fi

  if [ "${#_connect_preloads[@]}" -gt 0 ]; then
    printf '%s\n' "${_connect_preloads[@]}" \
      | emit_sandbox_sourced_file "$_MESSAGING_CONNECT_PRELOADS_FILE" || return 1
  else
    : | emit_sandbox_sourced_file "$_MESSAGING_CONNECT_PRELOADS_FILE" || return 1
  fi
}

emit_messaging_connect_runtime_preload_exports() {
  cat <<CONNECTPRELOADSEOF
if [ -f "$_MESSAGING_CONNECT_PRELOADS_FILE" ]; then
  while IFS= read -r _nemoclaw_preload; do
    [ -n "\$_nemoclaw_preload" ] || continue
    [ -f "\$_nemoclaw_preload" ] || continue
    export NODE_OPTIONS="\${NODE_OPTIONS:+\$NODE_OPTIONS }--require \$_nemoclaw_preload"
  done < "$_MESSAGING_CONNECT_PRELOADS_FILE"
fi
CONNECTPRELOADSEOF
}

messaging_runtime_preload_targets() {
  printf '%s\n' "$_MESSAGING_RUNTIME_SETUP_PLAN" "$_MESSAGING_CONNECT_PRELOADS_FILE"
  [ -f "$_MESSAGING_RUNTIME_SETUP_PLAN" ] || return 0
  python3 - "$_MESSAGING_RUNTIME_SETUP_PLAN" <<'PYMESSAGINGTARGETS'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    plan = json.load(handle)
for preload in plan.get("nodePreloads", []):
    target = preload.get("target")
    if target:
        print(target)
PYMESSAGINGTARGETS
}

validate_nemoclaw_tmp_permissions() {
  local _dynamic_targets=()
  local _target
  while IFS= read -r _target; do
    [ -n "$_target" ] && _dynamic_targets+=("$_target")
  done < <(messaging_runtime_preload_targets)

  validate_tmp_permissions "$_SANDBOX_SAFETY_NET" "$_PROXY_FIX_SCRIPT" "$_NEMOTRON_FIX_SCRIPT" "$_WS_FIX_SCRIPT" "$_SECCOMP_GUARD_SCRIPT" "$_CIAO_GUARD_SCRIPT" "${_dynamic_targets[@]+"${_dynamic_targets[@]}"}"
}

verify_messaging_runtime_secret_scans() {
  [ -f "$_MESSAGING_RUNTIME_SETUP_PLAN" ] || return 0
  python3 - "$_MESSAGING_RUNTIME_SETUP_PLAN" <<'PYMESSAGINGSECRETS'
import json
import re
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    plan = json.load(handle)

for scan in plan.get("secretScans", []):
    path = scan["path"]
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as handle:
            content = handle.read()
    except FileNotFoundError:
        continue
    if re.search(scan["pattern"], content):
        print(scan["message"].replace("{path}", path), file=sys.stderr)
        raise SystemExit(scan["exitCode"])
PYMESSAGINGSECRETS
}

_read_gateway_token() {
  node - <<'NODETOKEN'
const fs = require("fs");

const configPath = "/sandbox/.openclaw/openclaw.json";

function loadJson5() {
  try {
    const JSON5 = require("/opt/nemoclaw/node_modules/json5");
    if (JSON5 && typeof JSON5.parse === "function") {
      return JSON5;
    }
  } catch {
    // Fall through to the caller's empty-token behavior.
  }
  return undefined;
}

function parseConfig(text) {
  try {
    return JSON.parse(text);
  } catch (jsonError) {
    const JSON5 = loadJson5();
    if (!JSON5) {
      throw jsonError;
    }
    return JSON5.parse(text);
  }
}

try {
  const cfg = parseConfig(fs.readFileSync(configPath, "utf8"));
  console.log(cfg?.gateway?.auth?.token || "");
} catch {
  console.log("");
}
NODETOKEN
}

ensure_gateway_token() {
  local config_file="/sandbox/.openclaw/openclaw.json"
  local hash_file="/sandbox/.openclaw/.config-hash"
  local config_dir
  config_dir="$(dirname "$config_file")"

  if [ -L "$config_dir" ] || [ -L "$config_file" ] || [ -L "$hash_file" ]; then
    printf '[SECURITY] Refusing gateway token generation — config or hash path is a symlink\n' >&2
    return 1
  fi

  if [ "$(id -u)" -eq 0 ]; then
    prepare_openclaw_config_for_write "$config_file" "$hash_file"
  fi

  local _write_rc=0
  node - "$config_file" <<'NODETOKEN' || _write_rc=$?
const crypto = require("crypto");
const fs = require("fs");
const pathModule = require("path");

const path = process.argv[2];

function loadJson5() {
  const candidate = "/opt/nemoclaw/node_modules/json5";
  const JSON5 = require(candidate);
  if (!JSON5 || typeof JSON5.parse !== "function") {
    throw new Error(`JSON5 parser at ${candidate} is missing parse()`);
  }
  return JSON5;
}

function parseConfig(text) {
  try {
    return JSON.parse(text);
  } catch {
    return loadJson5().parse(text);
  }
}

function tokenUrlSafe(bytes) {
  return crypto
    .randomBytes(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function makeTempPath(dirPath) {
  for (let i = 0; i < 16; i += 1) {
    const suffix = crypto.randomBytes(12).toString("hex");
    const tmpPath = pathModule.join(dirPath, `.openclaw.${process.pid}.${suffix}.tmp`);
    try {
      const fd = fs.openSync(tmpPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      return { fd, tmpPath };
    } catch (error) {
      if (error && error.code === "EEXIST") {
        continue;
      }
      throw error;
    }
  }
  throw new Error("unable to allocate temporary OpenClaw config path");
}

try {
  const cfg = parseConfig(fs.readFileSync(path, "utf8"));
  const gateway = cfg.gateway && typeof cfg.gateway === "object" ? cfg.gateway : (cfg.gateway = {});
  const auth = gateway.auth && typeof gateway.auth === "object" ? gateway.auth : (gateway.auth = {});
  auth.token = tokenUrlSafe(32);

  const dirPath = pathModule.dirname(path);
  let fd;
  let tmpPath;
  try {
    ({ fd, tmpPath } = makeTempPath(dirPath));
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, JSON.stringify(cfg, null, 2));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmpPath, path);

    let dirFlags = fs.constants.O_RDONLY;
    if (fs.constants.O_DIRECTORY) {
      dirFlags |= fs.constants.O_DIRECTORY;
    }
    const dirFd = fs.openSync(dirPath, dirFlags);
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore cleanup failure and report the original error below.
      }
    }
    if (tmpPath) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // Ignore cleanup failure and report the original error below.
      }
    }
    throw error;
  }
} catch (error) {
  console.error(`[SECURITY] Failed to ensure OpenClaw gateway token: ${error.message || error}`);
  process.exit(1);
}
NODETOKEN

  if [ "$_write_rc" -eq 0 ] && [ -f "$hash_file" ]; then
    (cd "$(dirname "$config_file")" && sha256sum "$(basename "$config_file")" >"$hash_file") || _write_rc=$?
  fi

  if [ "$(id -u)" -eq 0 ]; then
    restore_openclaw_config_after_write "$config_file" "$hash_file" || _write_rc=$?
  fi

  [ "$_write_rc" -eq 0 ] || return "$_write_rc"
  printf '[token] Gateway auth token refreshed for startup\n' >&2
}

ensure_gateway_token_if_missing() {
  if [ -n "$(_read_gateway_token)" ]; then
    return 0
  fi

  ensure_gateway_token
}

export_gateway_token() {
  local token
  token="$(_read_gateway_token)"

  if [ -z "$token" ]; then
    unset OPENCLAW_GATEWAY_TOKEN
    return
  fi
  export OPENCLAW_GATEWAY_TOKEN="$token"
}

needs_gateway_token_for_current_command() {
  # Startup and direct OpenClaw CLI commands need the token before auto-pair or
  # agent subprocesses run. Arbitrary explicit commands do not, and non-root
  # smoke paths may not be able to mutate the baked OpenClaw config.
  if [ ${#NEMOCLAW_CMD[@]} -eq 0 ]; then
    return 0
  fi

  case "${NEMOCLAW_CMD[0]##*/}" in
    openclaw) return 0 ;;
    *) return 1 ;;
  esac
}

prepare_gateway_token_for_current_command() {
  if [ ${#NEMOCLAW_CMD[@]} -eq 0 ]; then
    ensure_gateway_token
    return $?
  fi

  if needs_gateway_token_for_current_command; then
    ensure_gateway_token_if_missing
  fi
}

# Write an auth profile JSON for the NVIDIA API key so the gateway can authenticate.
write_auth_profile() {
  if [ -z "${NVIDIA_INFERENCE_API_KEY:-}" ] && [ -n "${NVIDIA_API_KEY:-}" ]; then
    export NVIDIA_INFERENCE_API_KEY="$NVIDIA_API_KEY"
  fi

  if [ -z "${NVIDIA_INFERENCE_API_KEY:-}" ]; then
    return
  fi

  # Read the provider key from the NEMOCLAW_PROVIDER_KEY env var (exported at
  # Dockerfile:99 from the build-time ARG). This avoids parsing openclaw.json
  # and ensures the auth profile matches the provider key in the model config.
  # See: https://github.com/NVIDIA/NemoClaw/issues/1332
  local provider_key="${NEMOCLAW_PROVIDER_KEY:-inference}"

  python3 - "$provider_key" <<'PYAUTH'
import json
import os
import sys

provider_key = sys.argv[1]

path = os.path.expanduser('~/.openclaw/agents/main/agent/auth-profiles.json')
os.makedirs(os.path.dirname(path), exist_ok=True)
json.dump({
    f'{provider_key}:manual': {
        'type': 'api_key',
        'provider': provider_key,
        'keyRef': {'source': 'env', 'id': 'NVIDIA_INFERENCE_API_KEY'},
        'profileId': f'{provider_key}:manual',
    }
}, open(path, 'w'))
os.chmod(path, 0o600)
PYAUTH
}

harden_auth_profiles() {
  if [ -d "${HOME}/.openclaw" ]; then
    # Enforce 600 for all auth profiles across all agents
    find -L "${HOME}/.openclaw" -type f -name "auth-profiles.json" -exec chmod 600 {} + 2>/dev/null || true
  fi
}

# configure_messaging_channels is provided by sandbox-init.sh (shared).

# Print the local and remote dashboard URLs without the auth token fragment.
print_dashboard_urls() {
  local token chat_ui_base local_url remote_url

  token="$(_read_gateway_token)"

  chat_ui_base="${CHAT_UI_URL%%#*}"
  chat_ui_base="${chat_ui_base%/}"
  local_url="http://127.0.0.1:${PUBLIC_PORT}/"
  remote_url="${chat_ui_base}/"

  echo "[gateway] Local UI: ${local_url}" >&2
  echo "[gateway] Remote UI: ${remote_url}" >&2
  if [ -n "$token" ]; then
    echo "[gateway] Dashboard auth token redacted from startup logs." >&2
  fi
}

start_persistent_gateway_log_mirror() {
  local log_dir="/sandbox/.openclaw/logs"
  local log_file="${log_dir}/gateway-persistent.log"

  if [ -L "$log_dir" ]; then
    echo "[SECURITY] refusing symlinked persistent log directory: $log_dir" >&2
    return 1
  fi

  if [ "$(id -u)" -eq 0 ]; then
    install -d -o root -g root -m 755 "$log_dir" 2>/dev/null || return 1
  else
    mkdir -p "$log_dir" 2>/dev/null || return 1
    chmod 755 "$log_dir" 2>/dev/null || true
  fi

  if [ -L "$log_file" ] || { [ -e "$log_file" ] && [ ! -f "$log_file" ]; }; then
    echo "[SECURITY] refusing unsafe persistent log path: $log_file" >&2
    return 1
  fi

  if [ "$(id -u)" -eq 0 ]; then
    if [ ! -e "$log_file" ]; then
      install -o root -g root -m 644 /dev/null "$log_file" 2>/dev/null || return 1
    else
      chown root:root "$log_file" 2>/dev/null || return 1
      chmod 644 "$log_file" 2>/dev/null || return 1
    fi
  else
    touch "$log_file" 2>/dev/null || return 1
    chmod 644 "$log_file" 2>/dev/null || true
  fi

  if [ -L "$log_file" ] || [ ! -f "$log_file" ]; then
    echo "[SECURITY] refusing unsafe persistent log path after create: $log_file" >&2
    return 1
  fi

  { tail -n +1 -F /tmp/gateway.log 2>/dev/null >>"$log_file"; } &
  GATEWAY_LOG_PERSIST_PID=$!
  if ! capture_openclaw_pid_start_identity \
    "$GATEWAY_LOG_PERSIST_PID" GATEWAY_LOG_PERSIST_PID_START_IDENTITY; then
    echo "[gateway] could not capture persistent-log process identity" >&2
    return 1
  fi
}

start_auto_pair() {
  # Run auto-pair as sandbox user (it talks to the gateway via CLI)
  # SECURITY: Pass resolved openclaw path to prevent PATH hijacking
  # When running as non-root, skip privilege step-down (we're already
  # the sandbox user). When root, step down via STEP_DOWN_PREFIX_SANDBOX
  # which uses setpriv to drop load-bearing caps from the bounding set
  # atomically with reuid (issue #3280 follow-up).
  local run_prefix=()
  if [ "$(id -u)" -eq 0 ]; then
    run_prefix=("${STEP_DOWN_PREFIX_SANDBOX[@]}")
  fi
  # The gateway must retain NemoClaw's private-interface URL, but the watcher
  # is an ordinary OpenClaw CLI client. Source the trusted runtime environment
  # in this child only so an injected private URL is removed before the first
  # `devices list`. OpenClaw can then complete its local-loopback pairing
  # bootstrap before this unchanged watcher starts approving bounded requests.
  # An explicit URL override is preserved by write_runtime_shell_env().
  (
    if [ -r "$_RUNTIME_SHELL_ENV_FILE" ]; then
      # shellcheck source=/dev/null
      builtin source "$_RUNTIME_SHELL_ENV_FILE" || exit $?
    fi
    export OPENCLAW_BIN="$OPENCLAW"
    exec nohup "${run_prefix[@]+"${run_prefix[@]}"}" python3 -u -
  ) <<'PYAUTOPAIR' >>/tmp/auto-pair.log 2>&1 &
import json
import importlib.util
import base64
import binascii
import hashlib
import os
import re
import stat
import subprocess
import time

print('[auto-pair] watcher started', flush=True)

APPROVAL_POLICY_FILE = '/usr/local/lib/nemoclaw/openclaw_device_approval_policy.py'


def load_approval_policy(path):
    helper_stat = os.stat(path)
    mode = helper_stat.st_mode
    if mode & (stat.S_IWGRP | stat.S_IWOTH):
        raise RuntimeError('approval policy helper is writable by group or other')
    if helper_stat.st_uid == os.geteuid() and mode & stat.S_IWUSR:
        raise RuntimeError('approval policy helper is writable by the current user')
    spec = importlib.util.spec_from_file_location('openclaw_device_approval_policy', path)
    if spec is None or spec.loader is None:
        raise RuntimeError('approval policy helper could not be loaded')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return (
        module.approval_request_decision,
        module.gateway_approval_env,
        module.ALLOWED_SCOPES,
    )


approval_request_decision, gateway_approval_env, policy_allowed_scopes = load_approval_policy(APPROVAL_POLICY_FILE)

OPENCLAW = os.environ.get('OPENCLAW_BIN', 'openclaw')


def _env_seconds(name, default):
    raw = os.environ.get(name, '').strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return value if value > 0 else default


# Total runtime cap. After convergence the watcher polls at a slow cadence,
# so it can stay alive for the typical sandbox session without saturating
# the gateway. Late `openclaw agent` runs (NemoClaw#4263) request additional
# scopes that the gateway holds as pending until something approves them; an
# exited watcher leaves those upgrades stuck and the agent falls back to
# embedded mode. Defaults: 8h total, 30s slow-mode cadence.
FAST_DEADLINE = time.time() + _env_seconds('NEMOCLAW_AUTO_PAIR_FAST_DEADLINE_SECS', 600)
DEADLINE = time.time() + _env_seconds('NEMOCLAW_AUTO_PAIR_DEADLINE_SECS', 28800)
# After convergence the watcher polls at SLOW_INTERVAL. A late allowlisted
# scope upgrade — e.g. `openclaw tui` or `openclaw agent` invoked after the
# watcher entered slow mode — can wait up to SLOW_INTERVAL before being
# approved, which is longer than the OpenClaw client's tolerance for `scope
# upgrade pending approval` and forces a fallback to embedded mode. The
# default sits well below typical client-side wait windows; raise it through
# NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS when the gateway connect handler is
# load-sensitive. When the watcher successfully approves a fresh allowlisted
# request during slow mode it also bumps a bounded fast-reentry counter
# (NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS) that drops polling back to 1s for
# the next few iterations, so cascading upgrades and transient approve
# failures both clear before the OpenClaw client gives up. The counter is
# only bumped on the rising edge for each requestId (tracked in
# FAST_REENTRY_BUMPED_REQUEST_IDS and garbage-collected against the live
# pending list), so a sticky failing request cannot pin the watcher in fast
# polling. This is a polling-cadence fix only — non-allowlisted scopes such
# as `operator.admin` are still rejected by the device approval policy, and
# requests that need them must be approved through a separate operator path.
SLOW_INTERVAL = _env_seconds('NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS', 5)
# SOURCE_OF_TRUTH_REVIEW (auto-pair slow-mode cadence default 30s → 5s):
#
#   * Source boundary: the single SLOW_INTERVAL global above is the only
#     steady-state inter-poll wait for the in-sandbox auto-pair watcher
#     after browser pairing converges. The watcher's faster pre-converge
#     cadence (1s) is unaffected.
#   * Invalid state at the old default: a late
#     `openclaw tui` / `openclaw agent` allowlisted scope upgrade lands
#     inside a 30s window and waits up to one full SLOW_INTERVAL before
#     the watcher polls. Two sibling sandboxes onboarded back-to-back
#     each hit this window and both fall back to embedded mode (#5343).
#   * Source-fix constraint: the 5s default is a bounded 6x increase in
#     steady-state `openclaw devices list --json` calls per sandbox — at
#     most one extra call per 5s vs. per 30s, which the gateway connect
#     handler tolerates easily; the bounded fast-reentry counter above
#     keeps cascading upgrades from exceeding this cadence.
#   * Migration: operators who relied on the old cadence (load-sensitive
#     gateways, large multi-sandbox deployments) can restore it by
#     exporting NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS=30 in the sandbox
#     environment; the PR body calls this out under "Changes" too.
#   * Regression test: test/nemoclaw-start.test.ts's late-CLI fixture
#     covers the new default deterministically; #5343 Phase 5 covers it
#     end to end.
#   * Removal condition: when OpenClaw signals scope-upgrade requests via
#     a push channel rather than a poll, the cadence becomes irrelevant
#     and the variable retires.
FAST_REENTRY_POLLS = int(_env_seconds('NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS', 5))
FAST_REENTRY_INTERVAL = _env_seconds('NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS', 1)
FAST_REENTRY_REMAINING = 0
FAST_REENTRY_BUMPED_REQUEST_IDS = set()
QUIET_POLLS = 0
APPROVED = 0
SLOW_MODE = False
HANDLED = set()  # Track rejected/approved requestIds to avoid reprocessing
# SECURITY NOTE: clientId/clientMode are client-supplied and spoofable
# (the gateway stores connectParams.client.id verbatim). The policy requires
# an explicit known clientId and never trusts an allowlisted mode by itself.
# This remains defense-in-depth, not a trust boundary. PR #690 adds one-shot
# exit, timeout reduction, and token cleanup for a more comprehensive fix.
# The approval_request_decision helper is shared with connect-time approvals.

RUN_TIMEOUT_SECS = _env_seconds('NEMOCLAW_AUTO_PAIR_RUN_TIMEOUT_SECS', 10)


def _read_json_object(path):
    with open(path, 'r', encoding='utf-8') as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise RuntimeError(f'{path} is not a JSON object')
    return data


def _identity_public_key(identity):
    raw = str(identity.get('publicKey', '') or '').strip()
    if raw:
        return raw
    pem = str(identity.get('publicKeyPem', '') or '')
    body = ''.join(line.strip() for line in pem.splitlines() if '---' not in line)
    if not body:
        return ''
    der = base64.b64decode(body)
    if len(der) < 32:
        return ''
    return base64.urlsafe_b64encode(der[-32:]).decode('ascii').rstrip('=')


def initial_cli_request_is_allowlisted(request_id):
    # SOURCE_OF_TRUTH_REVIEW (NemoClaw#6113 gated-list bootstrap):
    # Invalid state: `devices list --json` can be gated by the same initial
    # CLI pairing request the watcher needs to approve, so the request id is
    # only available in the structured error text.
    # Source boundary: this function reads local OpenClaw pending/identity
    # state only to validate the parsed request id before delegating approval
    # back to `openclaw devices approve`, which owns locking, token creation,
    # and state publication. The watcher never writes OpenClaw state.
    # Source-fix constraint: OpenClaw should expose a first-run local
    # bootstrap/list API that returns the pending request without requiring an
    # already-approved device. This compatibility path supports packaged
    # gateway builds that still gate list.
    # Removal condition: delete this branch once the pinned OpenClaw release
    # exposes that bootstrap/list API and NemoClaw no longer supports gated
    # list behavior for first-run CLI pairing.
    state_dir = os.environ.get('OPENCLAW_STATE_DIR') or '/sandbox/.openclaw'
    pending_path = os.path.join(state_dir, 'devices', 'pending.json')
    identity_path = os.path.join(state_dir, 'identity', 'device.json')
    try:
        pending = _read_json_object(pending_path)
        identity = _read_json_object(identity_path)
        request = pending.get(request_id)
        if not isinstance(request, dict):
            return False
        # The map key is the authoritative request id. Reject a record whose
        # embedded requestId is missing or disagrees with its key, so a
        # malformed/tampered pending.json cannot approve a mismatched request.
        # (PR #6330 review, cv item 3.)
        if str(request.get('requestId', '') or '').strip() != str(request_id).strip():
            return False
        device_id = str(identity.get('deviceId', '') or '').strip()
        public_key = _identity_public_key(identity)
        if not device_id or not public_key:
            return False
        public_key_raw = base64.urlsafe_b64decode(public_key + '=' * (-len(public_key) % 4))
        if len(public_key_raw) != 32 or hashlib.sha256(public_key_raw).hexdigest() != device_id:
            return False
        if str(request.get('deviceId', '')).strip() != device_id:
            return False
        if str(request.get('publicKey', '')).strip() != public_key:
            return False
        # OpenClaw CLI initial pairing records use clientId/clientMode `cli`
        # in the observed DGX Spark/Station repros and in the paired-state
        # fixtures for this PR. The broader policy still handles normal
        # openclaw-cli scope upgrades through the main pending-list branch.
        if str(request.get('clientId', '')).strip() != 'cli':
            return False
        if str(request.get('clientMode', '')).strip() != 'cli':
            return False
        roles = set()
        role = request.get('role')
        if role is not None:
            if not isinstance(role, str) or not role.strip():
                return False
            roles.add(role.strip())
        raw_roles = request.get('roles')
        if raw_roles is not None:
            if not isinstance(raw_roles, list):
                return False
            for item in raw_roles:
                if not isinstance(item, str) or not item.strip():
                    return False
                roles.add(item.strip())
        if roles != {'operator'}:
            return False
        raw_scopes = request.get('scopes')
        if not isinstance(raw_scopes, list) or not raw_scopes:
            return False
        scopes = set()
        for item in raw_scopes:
            if not isinstance(item, str) or not item.strip():
                return False
            scope = item.strip()
            if scope not in policy_allowed_scopes or scope in scopes:
                return False
            scopes.add(scope)
        if scopes != {'operator.pairing'}:
            return False
        return approval_request_decision(request)['allowed'] is True
    except (OSError, ValueError, RuntimeError, binascii.Error) as err:
        print(f'[auto-pair] initial CLI pairing validation skipped request={request_id}: {brief_child_error("", str(err))}')
        return False


def is_pairing_required_list_failure(out, err):
    # SOURCE_OF_TRUTH_REVIEW (NemoClaw#6113 gated-list failure detection):
    # Invalid state: initial `openclaw devices list --json` returns the gateway
    # pairing-required denial instead of the pending request list.
    # Source boundary: the compatibility trigger only recognizes the stable
    # gateway denial text and still requires local pending/identity validation
    # before approval is delegated to OpenClaw.
    # Source-fix constraint: OpenClaw should expose a structured bootstrap/list
    # API for first-run CLI pairing.
    # Regression test: the non-pairing error fixture must not call approve.
    # Removal condition: delete with initial_cli_request_is_allowlisted once the
    # pinned OpenClaw release exposes that bootstrap/list API.
    message = f'{out}\n{err}'.lower()
    return 'pairing required' in message and 'device is not approved yet' in message


REQUEST_ID_RE = re.compile(r'^[A-Za-z0-9._:-]{1,128}$')


def _structured_request_ids(text):
    try:
        data = json.loads(text)
    except Exception:
        return []
    found = []

    def walk(value):
        if isinstance(value, dict):
            for key, item in value.items():
                if key in {'requestId', 'request_id'} and isinstance(item, str):
                    found.append(item.strip())
                else:
                    walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)

    walk(data)
    return found


def pairing_required_request_id(out, err):
    # SOURCE_OF_TRUTH_REVIEW (NemoClaw#6113 gated-list requestId extraction):
    # Invalid state: the requestId needed for canonical `devices approve` is
    # sometimes only present in the list denial payload.
    # Source boundary: parse one bounded requestId from structured JSON first,
    # then from the reviewed error-text forms; ambiguous, overlong, or malformed
    # output fails closed and never reaches approve.
    # Source-fix constraint: OpenClaw should return requestId in a stable
    # structured error field for this first-run bootstrap path.
    # Regression test: malformed, overlong, whitespace, and multiple requestIds
    # must not call approve.
    # Removal condition: delete with initial_cli_request_is_allowlisted once the
    # pinned OpenClaw release exposes a bootstrap/list API.
    if not is_pairing_required_list_failure(out, err):
        return None
    message = f'{out}\n{err}'
    if len(re.findall(r'\brequestId\b', message)) != 1:
        return None
    candidates = []
    for text in (out, err):
        candidates.extend(_structured_request_ids(text))
    candidates.extend(
        next(group for group in match.groups() if group is not None)
        for match in re.finditer(
            r'\brequestId\b["\']?\s*[:=]\s*(?:"([A-Za-z0-9._:-]{1,128})"(?=$|[,}\]\)])|\'([A-Za-z0-9._:-]{1,128})\'(?=$|[,}\]\)])|([A-Za-z0-9._:-]{1,128})(?=$|[,}\]\)]))',
            message,
        )
    )
    candidates.extend(
        match.group(1).strip()
        for match in re.finditer(r'\(requestId:\s*([A-Za-z0-9._:-]{1,128})\)', message)
    )
    valid = [candidate for candidate in candidates if REQUEST_ID_RE.fullmatch(candidate)]
    if not valid or len(set(valid)) != 1 or len(valid) != len(candidates):
        return None
    return valid[0]


def brief_child_error(out, err):
    # SOURCE_OF_TRUTH_REVIEW (auto-pair child error summary):
    # Invalid state: child openclaw failures often include noisy locale/setup
    # output before the actual error.
    # Source boundary: logs only the last non-empty child line, capped to 400
    # characters; decisions never depend on this summary.
    # Source-fix constraint: OpenClaw should expose structured error codes so
    # callers do not need stdout/stderr message summaries.
    # Regression test: approve-failure fixtures assert the actionable child
    # error remains visible.
    # Removal condition: retire when OpenClaw CLI returns structured errors for
    # the watched devices list/approve calls.
    lines = [line.strip() for line in f'{err}\n{out}'.splitlines() if line.strip()]
    return (lines[-1] if lines else '')[:400]

# Workaround boundary (NemoClaw#4462): the watcher child sources the trusted
# runtime environment, so list calls resolve the same live gateway through
# local loopback instead of the injected private-interface URL. Approval calls
# additionally drop the gateway env triplet so OpenClaw must use the local
# device token. The reviewed 2026.6.10 dist patch requests only
# operator.pairing for a complete bounded CLI self-upgrade and forces the
# existing local-only stored-device-auth path so a shared token reloaded from
# config cannot win authentication. The gateway then validates and commits in
# OpenClaw's canonical locked pairing writer. Remove both pieces when upstream
# supports that flow.
def run(*args, strip_gateway_env=False):
    # Bound every openclaw CLI invocation so a wedged child cannot pin
    # the watcher beyond DEADLINE (CodeRabbit #4292): subprocess.run with
    # no timeout would hold a hung `openclaw devices list/approve` past
    # the fast→slow transition and the 8h deadline check.
    env = None
    if strip_gateway_env:
        env = gateway_approval_env(os.environ)
    try:
        proc = subprocess.run(
            args, capture_output=True, text=True, timeout=RUN_TIMEOUT_SECS, env=env,
        )
        return proc.returncode, proc.stdout.strip(), proc.stderr.strip()
    except subprocess.TimeoutExpired as exc:
        # 124 matches GNU `timeout` exit status so log scrapers can spot it.
        out = (exc.stdout or '') if isinstance(exc.stdout, str) else ''
        err = (exc.stderr or '') if isinstance(exc.stderr, str) else ''
        print(f'[auto-pair] timeout calling {args[1] if len(args) > 1 else "openclaw"} {args[2] if len(args) > 2 else ""}'.rstrip())
        return 124, out.strip(), err.strip()


def sleep_for_next_poll(default_seconds, productive=True):
    # Apply the bounded fast-reentry override before the caller's default
    # sleep so a recent allowlisted approval (which bumps the remaining
    # counter) drops polling to FAST_REENTRY_INTERVAL for the next few
    # iterations. Mutates the global counter so callers do not need to
    # thread the state through. The override is floored by the caller's
    # default so it never increases the inter-poll latency (e.g. when the
    # default is already tighter than FAST_REENTRY_INTERVAL during a
    # bounded retry pass in fast mode).
    #
    # Error-path callers pass productive=False so a string of gateway
    # errors or JSON-parse failures after a fast-reentry bump does not
    # silently drain the bounded window before a productive poll observes
    # the cascading upgrades.
    global FAST_REENTRY_REMAINING
    if FAST_REENTRY_REMAINING > 0:
        if productive:
            FAST_REENTRY_REMAINING -= 1
        time.sleep(min(FAST_REENTRY_INTERVAL, default_seconds))
        return
    time.sleep(default_seconds)


while time.time() < DEADLINE:
    # Fast-to-slow transition is checked at the TOP of every iteration — before
    # any list/approve-failure `continue` below — so a permanently failing gated
    # list/approve (or a sticky pending request) cannot hold the watcher in 1s
    # polling for the full DEADLINE window; after FAST_DEADLINE it drops to
    # SLOW_INTERVAL. Preventing that long-timeline re-creation of the
    # NemoClaw#2484 connect-handler pile-up is exactly the point.
    # (PR #6330 review, cv item 2.)
    if not SLOW_MODE and time.time() >= FAST_DEADLINE:
        SLOW_MODE = True
        print(f'[auto-pair] fast-mode deadline reached; switching to slow-mode approvals={APPROVED}')
    rc, out, err = run(OPENCLAW, 'devices', 'list', '--json')
    if rc != 0 or not out:
        initial_request_id = pairing_required_request_id(out, err)
        if (
            initial_request_id
            and initial_request_id not in HANDLED
            and initial_cli_request_is_allowlisted(initial_request_id)
        ):
            arc, aout, aerr = run(
                OPENCLAW, 'devices', 'approve', initial_request_id, '--json', strip_gateway_env=True,
            )
            if arc == 0:
                HANDLED.add(initial_request_id)
                APPROVED += 1
                print(f'[auto-pair] approved initial CLI pairing request={initial_request_id}')
                FAST_REENTRY_REMAINING = max(FAST_REENTRY_REMAINING, FAST_REENTRY_POLLS)
                sleep_for_next_poll(FAST_REENTRY_INTERVAL)
                continue
            failure = brief_child_error(aout, aerr)
            if arc != 124 and failure:
                print(f'[auto-pair] initial CLI approve failed request={initial_request_id}: {failure}')
        sleep_for_next_poll(SLOW_INTERVAL if SLOW_MODE else 1, productive=False)
        continue
    try:
        data = json.loads(out)
    except Exception:
        sleep_for_next_poll(SLOW_INTERVAL if SLOW_MODE else 1, productive=False)
        continue

    pending = data.get('pending') or []
    paired = data.get('paired') or []
    has_browser = any((d.get('clientId') == 'openclaw-control-ui') or (d.get('clientMode') == 'webchat') for d in paired if isinstance(d, dict))

    if pending:
        QUIET_POLLS = 0
        attempted_request_ids = set()
        pending_request_ids = set()
        for device in pending:
            if not isinstance(device, dict):
                continue
            request_id = device.get('requestId')
            if not request_id:
                continue
            pending_request_ids.add(request_id)
            if request_id in HANDLED:
                continue
            decision = approval_request_decision(device)
            client_id = decision['client_id']
            client_mode = decision['client_mode']
            if decision['reason'] == 'unknown-client':
                HANDLED.add(request_id)
                print(f'[auto-pair] rejected unknown client={client_id} mode={client_mode}')
                continue
            if decision['reason'] == 'malformed-scopes':
                HANDLED.add(request_id)
                print(f'[auto-pair] rejected malformed scopes client={client_id} mode={client_mode}')
                continue
            if decision['reason'] == 'disallowed-scopes':
                HANDLED.add(request_id)
                scopes = decision['scopes']
                print(f'[auto-pair] rejected disallowed scopes={sorted(scopes)} client={client_id} mode={client_mode}')
                continue
            attempted_request_ids.add(request_id)
            arc, aout, aerr = run(
                OPENCLAW, 'devices', 'approve', request_id, '--json', strip_gateway_env=True,
            )
            # rc=124 is the timeout sentinel from run() — do NOT add the
            # request to HANDLED on a transient timeout, so the next poll
            # can retry (CodeRabbit #4292). Other approve failures stay
            # retryable too; only intentionally rejected unknown clients
            # and confirmed successful approvals are marked handled.
            if arc == 124:
                continue
            if arc == 0:
                HANDLED.add(request_id)
                APPROVED += 1
                print(f'[auto-pair] approved request={request_id} client={client_id} mode={client_mode}')
            else:
                failure = brief_child_error(aout, aerr)
                if failure:
                    print(f'[auto-pair] approve failed request={request_id}: {failure}')
        # Drop previously-bumped requestIds that the gateway no longer reports
        # as pending so a future re-appearance of the same id (very unlikely,
        # but kept robust) can bump again. The set is otherwise small and
        # never crosses out of the watcher process.
        FAST_REENTRY_BUMPED_REQUEST_IDS.intersection_update(pending_request_ids)
        # Fast-reentry is armed on the rising edge per requestId — once for
        # each freshly-observed allowlisted attempt. A sticky pending request
        # that fails approval repeatedly therefore stops bumping the counter
        # after the first attempt, so it cannot keep the watcher in fast
        # polling for the rest of DEADLINE; the next slow-cadence poll
        # decides whether to retry. Cascading approvals from new ids still
        # bump as they appear, which is the case the override targets.
        new_attempted_ids = attempted_request_ids - FAST_REENTRY_BUMPED_REQUEST_IDS
        # Bump in fast mode too: the cadence override is a no-op there
        # (min(FAST_REENTRY_INTERVAL=1, default=1) = 1) but the requestId
        # is still recorded in FAST_REENTRY_BUMPED_REQUEST_IDS so the same
        # sticky id cannot re-arm the counter later when the watcher
        # transitions into slow mode.
        if new_attempted_ids and FAST_REENTRY_POLLS > 0:
            FAST_REENTRY_REMAINING = FAST_REENTRY_POLLS
            FAST_REENTRY_BUMPED_REQUEST_IDS.update(new_attempted_ids)
            mode_label = 'slow' if SLOW_MODE else 'fast'
            print(f'[auto-pair] fast-reentry bumped polls={FAST_REENTRY_POLLS} approved={APPROVED} mode={mode_label}')
        sleep_for_next_poll(SLOW_INTERVAL if SLOW_MODE else 1)
        continue

    QUIET_POLLS += 1
    # Convergence conditions, checked in order of strength:
    #   1. Browser device paired — original control-UI workflow
    #   2. Any paired device — covers dangerouslyDisableDeviceAuth setups
    #      where the gateway auto-pairs CLI clients directly without the
    #      watcher running `openclaw devices approve` (so APPROVED stays
    #      0 forever in those configurations)
    #   3. We approved at least one device explicitly
    # On convergence the watcher used to exit. That left late CLI scope
    # upgrades pending forever (NemoClaw#4263). Now we transition to a slow
    # polling cadence (default 30s) so late allowlisted scope upgrades for
    # already-paired clients still get approved without saturating the
    # gateway connect handler (NemoClaw#2484: WS handshake-timeout). The
    # fast-deadline transition is now evaluated above (before the pending
    # branch) so a stuck pending request cannot defer it.
    if not SLOW_MODE and QUIET_POLLS >= 4:
        if has_browser:
            SLOW_MODE = True
            print(f'[auto-pair] browser pairing converged; entering slow-mode approvals={APPROVED}')
        elif paired:
            SLOW_MODE = True
            print(f'[auto-pair] devices paired ({len(paired)}); entering slow-mode approvals={APPROVED}')
        elif APPROVED > 0:
            SLOW_MODE = True
            print(f'[auto-pair] non-browser pairing converged; entering slow-mode approvals={APPROVED}')

    # Back off polling: 1s in fast mode while waiting for first pairing,
    # 5s in fast mode once anything is paired/approved, and SLOW_INTERVAL
    # (default 5s) after convergence. Slow-mode keepalive lets late CLI
    # scope upgrades get approved through the rest of DEADLINE without
    # hammering the gateway. The bounded fast-reentry counter (bumped above
    # when an allowlisted upgrade was attempted) overrides whichever tier
    # is selected here so the next few polls catch cascading upgrades.
    if SLOW_MODE:
        sleep_for_next_poll(SLOW_INTERVAL)
    elif APPROVED > 0 or paired:
        sleep_for_next_poll(5)
    else:
        sleep_for_next_poll(1)
else:
    print(f'[auto-pair] watcher deadline reached approvals={APPROVED}')
PYAUTOPAIR
  AUTO_PAIR_PID=$!
  if ! capture_openclaw_pid_start_identity "$AUTO_PAIR_PID" AUTO_PAIR_PID_START_IDENTITY; then
    echo "[gateway] could not capture auto-pair process identity" >&2
    return 1
  fi
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

# Git TLS CA bundle fix (NemoClaw#2270).
# OpenShell's L7 proxy does MITM TLS termination and re-signs with its own CA.
# OpenShell injects SSL_CERT_FILE and CURL_CA_BUNDLE pointing at the CA bundle,
# but git does not read those — it needs GIT_SSL_CAINFO.  Without it, git clone
# fails with "server certificate verification failed".
# Use SSL_CERT_FILE (set by OpenShell) as the canonical CA bundle path.
if [ -n "${SSL_CERT_FILE:-}" ] && [ -f "${SSL_CERT_FILE}" ]; then
  export GIT_SSL_CAINFO="$SSL_CERT_FILE"
fi

# HTTP library + NODE_USE_ENV_PROXY double-proxy fix (NemoClaw#2109).
# Node.js 22 sets NODE_USE_ENV_PROXY=1 in the OpenShell base image, which
# intercepts https.request() calls and handles proxying via CONNECT tunnel.
# HTTP libraries (axios, follow-redirects, proxy-from-env) also read
# HTTPS_PROXY and configure HTTP FORWARD mode, double-processing the
# request — the L7 proxy rejects with "FORWARD rejected: HTTPS requires
# CONNECT".
#
# The preload wraps http.request() — the lowest common denominator every
# HTTP client bottoms out at — and rewrites FORWARD-mode requests back to
# https.request() so NODE_USE_ENV_PROXY can handle the CONNECT tunnel.
#
# Earlier PR #2110 intercepted require('axios') via a Module._load hook;
# that could not catch follow-redirects + proxy-from-env bundled as ESM
# in OpenClaw's dist/ (no require() calls to intercept).
#
# Node runtime preload modules are copied into /usr/local/lib/nemoclaw/preloads/
# at image build time, then copied to /tmp before NODE_OPTIONS=--require so
# the sandbox user can read them under Landlock-constrained runtimes.
# ── Global sandbox safety net ──────────────────────────────────
# Last-resort handler for uncaught exceptions and unhandled rejections
# that would otherwise crash the gateway. The gateway is shared sandbox
# infrastructure; user-initiated actions must not be able to take it down.
#
# This is intentionally NOT a catch-all swallow. Known-benign error
# patterns are documented inline in the script; unknown patterns are
# logged with full stack so they can be diagnosed and either fixed
# upstream or added to the allow-list with explicit justification.
# Specific guards (Slack, ciao) pre-empt their own error patterns;
# this is the backstop for everything else.
#
# Only active when OPENSHELL_SANDBOX=1 (set by OpenShell at runtime),
# and only for gateway processes. Outside a sandbox or in CLI processes
# (agent, doctor, plugins, tui, etc.) normal Node.js crash behavior is
# preserved so errors surface promptly to users running short-lived tools.
_SANDBOX_SAFETY_NET="/tmp/nemoclaw-sandbox-safety-net.js"
_SANDBOX_SAFETY_NET_SOURCE="/usr/local/lib/nemoclaw/preloads/sandbox-safety-net.js"

_PROXY_FIX_SCRIPT="/tmp/nemoclaw-http-proxy-fix.js"
_PROXY_FIX_SOURCE="/usr/local/lib/nemoclaw/preloads/http-proxy-fix.js"

# NVIDIA endpoint model-specific inference parameter injection
# (NemoClaw#1193, NemoClaw#2051).
# Nemotron models may return empty content (tool call instead of text) or
# thinking-only blocks (stalls the conversation) when the model's chat
# template produces an empty assistant turn. The vLLM / NIM chat template
# kwarg `force_nonempty_content` prevents this by ensuring the template
# always emits a non-empty content field.
#
# DeepSeek V4 Pro and Kimi K2.6 on NVIDIA Build expect chat template
# thinking mode disabled for NemoClaw's OpenAI-compatible
# chat-completions path.
#
# The preload wraps http.request()/https.request() plus fetch() because modern
# OpenAI-compatible clients may use either transport. It buffers JSON bodies for
# POST requests to /v1/chat/completions and injects model-specific kwargs for the
# affected NVIDIA endpoint models. Backends that do not recognise the extra
# field silently ignore it (OpenAI-compatible contract).
#
# Scoped strictly to known affected models: unrelated requests pass through
# completely untouched. This sandbox preload is the source-boundary workaround
# until upstream clients/providers always emit these model-specific kwargs; see
# nemoclaw-blueprint/scripts/nemotron-inference-fix.js for the invalid state,
# regression proof, and removal condition.
_NEMOTRON_FIX_SCRIPT="/tmp/nemoclaw-nemotron-inference-fix.js"
_NEMOTRON_FIX_SOURCE="/usr/local/lib/nemoclaw/preloads/nemotron-inference-fix.js"

# mDNS / ciao network interface guard.
# The @homebridge/ciao mDNS library calls os.networkInterfaces() which
# throws a SystemError (uv_interface_addresses) inside sandboxes with
# restricted network namespaces (seccomp/Landlock). This crashes the
# gateway even though mDNS is not needed. The guard monkey-patches
# os.networkInterfaces to return an empty object on failure instead
# of throwing, and catches the uncaughtException as a fallback.
# Ref: https://github.com/NVIDIA/NemoClaw/issues/2340
_CIAO_GUARD_SCRIPT="/tmp/nemoclaw-ciao-network-guard.js"
_CIAO_GUARD_SOURCE="/usr/local/lib/nemoclaw/preloads/ciao-network-guard.js"

# WebSocket CONNECT tunnel fix (NemoClaw#1570).
# The `ws` library calls https.request() for wss:// WebSocket upgrades.
# EnvHttpProxyAgent (NODE_USE_ENV_PROXY=1) sends a forward proxy request
# instead of CONNECT — rejected by the L7 proxy with 400. Without
# NODE_USE_ENV_PROXY, ws goes direct — blocked by sandbox netns.
# The preload patches https.request() to inject a CONNECT tunnel agent for
# WebSocket upgrade requests. Activates whenever HTTPS_PROXY is set (the
# script itself guards on the env var).
_WS_FIX_SOURCE="/usr/local/lib/nemoclaw/preloads/ws-proxy-fix.js"
_WS_FIX_SCRIPT="/tmp/nemoclaw-ws-proxy-fix.js"

# ── Seccomp syscall guard ─────────────────────────────────────
# OpenShell ≥0.0.36 seccomp policy blocks syscalls like getifaddrs
# (used by Node's os.networkInterfaces()). Third-party libraries (e.g.,
# @homebridge/ciao mDNS) call these without error handling, producing
# unhandled promise rejections that crash the gateway under Node v22's
# default --unhandled-rejections=throw.
#
# This preload catches those specific sandbox-infrastructure errors
# and logs them as warnings instead of letting them kill the process.
# Unlike the Slack channel guard, this is always installed because the
# seccomp-blocked syscalls affect all sandboxes, not just Slack ones.
_SECCOMP_GUARD_SCRIPT="/tmp/nemoclaw-seccomp-guard.js"
_SECCOMP_GUARD_SOURCE="/usr/local/lib/nemoclaw/preloads/seccomp-guard.js"

# Stage the immutable, image-packaged preload set into /tmp. Startup and
# authenticated PID 1 recovery share this exact path so a pod-recreate-style
# /tmp wipe cannot drift from the initial security boundary. The shared emit
# helper atomically replaces each target as root:root 0444 in root mode.
install_core_runtime_preloads() {
  emit_sandbox_sourced_file "$_SANDBOX_SAFETY_NET" <"$_SANDBOX_SAFETY_NET_SOURCE" || return 1
  append_node_require_once "$_SANDBOX_SAFETY_NET"

  if [ "${NODE_USE_ENV_PROXY:-}" = "1" ]; then
    emit_sandbox_sourced_file "$_PROXY_FIX_SCRIPT" <"$_PROXY_FIX_SOURCE" || return 1
    append_node_require_once "$_PROXY_FIX_SCRIPT"
  fi

  emit_sandbox_sourced_file "$_NEMOTRON_FIX_SCRIPT" <"$_NEMOTRON_FIX_SOURCE" || return 1
  append_node_require_once "$_NEMOTRON_FIX_SCRIPT"

  emit_sandbox_sourced_file "$_CIAO_GUARD_SCRIPT" <"$_CIAO_GUARD_SOURCE" || return 1
  append_node_require_once "$_CIAO_GUARD_SCRIPT"

  if [ -f "$_WS_FIX_SOURCE" ]; then
    # Copy to /tmp so the sandbox user can read it under Landlock-constrained
    # runtimes. The missing optional source keeps the historical no-op.
    emit_sandbox_sourced_file "$_WS_FIX_SCRIPT" <"$_WS_FIX_SOURCE" || return 1
    append_node_require_once "$_WS_FIX_SCRIPT"
  fi

  emit_sandbox_sourced_file "$_SECCOMP_GUARD_SCRIPT" <"$_SECCOMP_GUARD_SOURCE" || return 1
  append_node_require_once "$_SECCOMP_GUARD_SCRIPT"
}

install_core_runtime_preloads || exit 1

# OpenShell re-injects narrow NO_PROXY/no_proxy=127.0.0.1,localhost,::1 every
# time a user connects via `openshell sandbox connect`. Dynamic connect-session
# config lives in /tmp/nemoclaw-proxy-env.sh and is sourced by system-wide shell
# hooks from the base image, keeping per-user rc files free of proxy entries.
#
# SECURITY: The proxy-env file is written via emit_sandbox_sourced_file()
# which ensures root:root 444 in root mode (sandbox cannot modify) and
# best-effort 444 in non-root mode. The /tmp sticky bit prevents the
# sandbox user from deleting or replacing the root-owned file.
# Ref: https://github.com/NVIDIA/NemoClaw/issues/2181
#
# Both uppercase and lowercase variants are required: Node.js undici prefers
# lowercase (no_proxy) over uppercase (NO_PROXY) when both are set.
# curl/wget use uppercase.  gRPC C-core uses lowercase.
_RUNTIME_SHELL_ENV_FILE="/tmp/nemoclaw-proxy-env.sh"
_RUNTIME_SHELL_ENV_SHIM="[ -f ${_RUNTIME_SHELL_ENV_FILE} ] && . ${_RUNTIME_SHELL_ENV_FILE}"

write_runtime_shell_env() {
  _PROXY_ENV_FILE="/tmp/nemoclaw-proxy-env.sh"
  {
    cat <<PROXYEOF
# Proxy configuration (overrides narrow OpenShell defaults on connect)
export HTTP_PROXY="$_PROXY_URL"
export HTTPS_PROXY="$_PROXY_URL"
export NO_PROXY="$_NO_PROXY_VAL"
export http_proxy="$_PROXY_URL"
export https_proxy="$_PROXY_URL"
export no_proxy="$_NO_PROXY_VAL"
export AWS_EC2_METADATA_DISABLED="true"
export JITI_FS_CACHE="false"
PROXYEOF
    local _openclaw_env_name _openclaw_env_value _escaped_openclaw_env_value
    for _openclaw_env_name in OPENCLAW_HOME OPENCLAW_STATE_DIR OPENCLAW_CONFIG_PATH OPENCLAW_OAUTH_DIR OPENCLAW_WORKSPACE_DIR; do
      _openclaw_env_value="${!_openclaw_env_name:-}"
      [ -n "$_openclaw_env_value" ] || continue
      _escaped_openclaw_env_value="$(printf '%s' "$_openclaw_env_value" | sed "s/'/'\\\\''/g")"
      printf "export %s='%s'\n" "$_openclaw_env_name" "$_escaped_openclaw_env_value"
    done
    if [ -n "${OPENCLAW_GATEWAY_PORT:-}" ]; then
      _escaped_gateway_port="$(printf '%s' "$OPENCLAW_GATEWAY_PORT" | sed "s/'/'\\\\''/g")"
      printf "export OPENCLAW_GATEWAY_PORT='%s'\n" "$_escaped_gateway_port"
    fi
    if [ -n "${OPENCLAW_GATEWAY_URL:-}" ]; then
      _escaped_gateway_url="$(printf '%s' "$OPENCLAW_GATEWAY_URL" | sed "s/'/'\\\\''/g")"
      # Preserve NemoClaw's sandbox-interface dial-back URL for the few
      # NemoClaw-owned commands that require it without forcing ordinary
      # OpenClaw CLI clients onto the explicit remote-gateway pairing path.
      printf "export NEMOCLAW_OPENCLAW_GATEWAY_URL='%s'\n" "$_escaped_gateway_url"
      cat <<'GATEWAYURLENVEOF'
# Equality identifies NemoClaw's inherited private-interface value. A different
# nonempty raw value was supplied explicitly after this file was generated, so
# preserve that caller override and its matching insecure-WS marker.
if [ -z "${OPENCLAW_GATEWAY_URL:-}" ] || [ "${OPENCLAW_GATEWAY_URL}" = "${NEMOCLAW_OPENCLAW_GATEWAY_URL:-}" ]; then
  unset OPENCLAW_GATEWAY_URL
  unset OPENCLAW_ALLOW_INSECURE_PRIVATE_WS
fi
GATEWAYURLENVEOF
    fi
    if [ -n "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
      _escaped_gateway_token="$(printf '%s' "$OPENCLAW_GATEWAY_TOKEN" | sed "s/'/'\\\\''/g")"
      printf "export OPENCLAW_GATEWAY_TOKEN='%s'\n" "$_escaped_gateway_token"
    fi
    if [ -n "${OPENCLAW_ALLOW_INSECURE_PRIVATE_WS:-}" ]; then
      # Retain the matching break-glass under the same private namespace.
      # WhatsApp reinjects it only for its gateway-backed login command.
      printf "export NEMOCLAW_OPENCLAW_ALLOW_INSECURE_PRIVATE_WS='1'\n"
    fi
    cat <<'GUARDENVEOF'
# nemoclaw-configure-guard begin
# #4538: a raw in-sandbox `openclaw doctor --fix` (run directly from a connect
# shell, outside any NemoClaw wrapper command) tightens the mutable OpenClaw
# config tree back to single-user 700/600 — even when it exits nonzero (e.g. it
# hits EACCES on a root-locked shell init file). That blocks the gateway UID,
# a member of the sandbox group, from persisting config writes. Restore the
# setgid + group-writable contract (2770 dir / 660 config) after every openclaw
# invocation routed through this guard, regardless of exit code. Best-effort and
# idempotent: it skips when shields are up (config dir owned by root) so the lock
# is never weakened, and is a no-op when the contract already holds. The
# baseline re-lock stays a root-only startup concern (this runs as the sandbox
# user), so it is intentionally not attempted here. Kept in sync with the
# entrypoint's normalize_mutable_config_perms.
_nemoclaw_restore_mutable_config_perms() {
  local _nemoclaw_oc_dir _nemoclaw_oc_owner _nemoclaw_oc_dir_mode _nemoclaw_oc_file_mode _nemoclaw_oc_hash_mode
  _nemoclaw_oc_dir="${OPENCLAW_STATE_DIR:-/sandbox/.openclaw}"
  [ -d "$_nemoclaw_oc_dir" ] || return 0
  _nemoclaw_oc_owner="$(stat -c '%U' "$_nemoclaw_oc_dir" 2>/dev/null || stat -f '%Su' "$_nemoclaw_oc_dir" 2>/dev/null || echo unknown)"
  # Shields up — config is intentionally root-locked; never weaken it.
  [ "$_nemoclaw_oc_owner" = "root" ] && return 0
  _nemoclaw_oc_dir_mode="$(stat -c '%a' "$_nemoclaw_oc_dir" 2>/dev/null || stat -f '%Lp' "$_nemoclaw_oc_dir" 2>/dev/null || echo '')"
  _nemoclaw_oc_file_mode="$(stat -c '%a' "$_nemoclaw_oc_dir/openclaw.json" 2>/dev/null || stat -f '%Lp' "$_nemoclaw_oc_dir/openclaw.json" 2>/dev/null || echo '')"
  _nemoclaw_oc_hash_mode="$(stat -c '%a' "$_nemoclaw_oc_dir/.config-hash" 2>/dev/null || stat -f '%Lp' "$_nemoclaw_oc_dir/.config-hash" 2>/dev/null || echo '')"
  # Fast path: contract already intact (2770 dir, 660 config + hash when present).
  # Check .config-hash too so a doctor run that tightened only it is still fixed.
  if [ "$_nemoclaw_oc_dir_mode" = "2770" ] &&
    { [ "$_nemoclaw_oc_file_mode" = "660" ] || [ -z "$_nemoclaw_oc_file_mode" ]; } &&
    { [ "$_nemoclaw_oc_hash_mode" = "660" ] || [ -z "$_nemoclaw_oc_hash_mode" ]; }; then
    return 0
  fi
  chmod -R g+rwX,o-rwx "$_nemoclaw_oc_dir" 2>/dev/null || true
  find "$_nemoclaw_oc_dir" -type d -exec chmod g+s {} + 2>/dev/null || true
  chmod 2770 "$_nemoclaw_oc_dir" 2>/dev/null || true
  if [ ! -L "$_nemoclaw_oc_dir" ] &&
    [ ! -L "$_nemoclaw_oc_dir/openclaw.json" ] &&
    [ ! -L "$_nemoclaw_oc_dir/.config-hash" ] &&
    [ -f "$_nemoclaw_oc_dir/openclaw.json" ]; then
    (cd "$_nemoclaw_oc_dir" && sha256sum openclaw.json >.config-hash) 2>/dev/null || true
  fi
  chmod 660 "$_nemoclaw_oc_dir/openclaw.json" "$_nemoclaw_oc_dir/.config-hash" 2>/dev/null || true
  # Keep the recovery baseline out of the group-writable contract — it is a
  # read-only trust anchor (root:sandbox 0440 when root re-locks it). The
  # recursive chmod above would otherwise loosen it to group-writable in
  # rootless mode, where the root-only re-lock is skipped (#4538).
  chmod g-w "$_nemoclaw_oc_dir/openclaw.json.nemoclaw-baseline" 2>/dev/null || true
}
_nemoclaw_messaging_connect_node_options() {
  local _nemoclaw_preload _nemoclaw_options=""
  [ -f "/tmp/nemoclaw-messaging-connect-preloads.list" ] || return 0
  while IFS= read -r _nemoclaw_preload; do
    [ -n "$_nemoclaw_preload" ] || continue
    [ -f "$_nemoclaw_preload" ] || continue
    _nemoclaw_options="${_nemoclaw_options:+$_nemoclaw_options }--require $_nemoclaw_preload"
  done < "/tmp/nemoclaw-messaging-connect-preloads.list"
  printf '%s' "$_nemoclaw_options"
}
openclaw() {
  # NemoClaw#4462: approval calls temporarily drop the gateway URL/port/token
  # so OpenClaw resolves the local loopback gateway and device token. The
  # reviewed 2026.6.10 compatibility patch then performs bounded same-device
  # scope upgrades in the gateway's canonical locked pairing writer. This
  # wrapper never reads or writes pending.json/paired.json.
  if [ "${1:-}" = "devices" ] && [ "${2:-}" = "approve" ]; then
    _nemoclaw_approve_errexit=0
    case $- in *e*) _nemoclaw_approve_errexit=1 ;; esac
    set +e
    (unset OPENCLAW_GATEWAY_URL OPENCLAW_GATEWAY_PORT OPENCLAW_GATEWAY_TOKEN; command openclaw "$@")
    _nemoclaw_approve_rc=$?
    if [ "$_nemoclaw_approve_errexit" = "1" ]; then set -e; else set +e; fi
    return "$_nemoclaw_approve_rc"
  fi
  case "$1" in
    configure)
      echo "Error: 'openclaw configure' cannot modify config inside the sandbox." >&2
      echo "Changes inside the sandbox do not persist across rebuilds." >&2
      echo "" >&2
      echo "To change your configuration, exit the sandbox and run:" >&2
      echo "  nemoclaw onboard --resume" >&2
      echo "" >&2
      echo "This rebuilds the sandbox with your updated settings." >&2
      return 1
      ;;
    config)
      case "$2" in
        set | unset)
          echo "Error: 'openclaw config $2' cannot modify config inside the sandbox." >&2
          echo "Changes inside the sandbox do not persist across rebuilds." >&2
          echo "" >&2
          echo "To change your configuration, exit the sandbox and run:" >&2
          echo "  nemoclaw onboard --resume" >&2
          echo "" >&2
          echo "This rebuilds the sandbox with your updated settings." >&2
          return 1
          ;;
      esac
      ;;
    channels)
      # `status` is read-only diagnostics. `login` is only allowed for
      # WhatsApp, whose QR pairing intentionally happens inside the sandbox.
      # Other persistent mutations (including host-QR channel login) stay
      # blocked — they must go through the host CLI so registry/provider state
      # and rebuild reasons are captured.
      case "$2" in
        list | status | "" | -h | --help) ;;
        login)
          _login_channel=""
          _login_help=0
          _prev_arg_was_channel_flag=0
          _seen_login_subcommand=0
          for _arg in "$@"; do
            if [ "$_seen_login_subcommand" = "0" ]; then
              [ "$_arg" = "login" ] && _seen_login_subcommand=1
              continue
            fi
            if [ "$_prev_arg_was_channel_flag" = "1" ]; then
              _login_channel="$_arg"
              _prev_arg_was_channel_flag=0
              continue
            fi
            case "$_arg" in
              --channel)
                _prev_arg_was_channel_flag=1
                ;;
              --channel=*)
                _login_channel="${_arg#--channel=}"
                ;;
              -h | --help)
                _login_help=1
                ;;
              --*)
                ;;
              *)
                [ -z "$_login_channel" ] && _login_channel="$_arg"
                ;;
            esac
          done
          if [ "$_login_help" != "1" ] && [ "$_login_channel" != "whatsapp" ]; then
            echo "Error: 'openclaw channels login' is only supported inside the sandbox for WhatsApp." >&2
            echo "Changes inside the sandbox do not persist across rebuilds." >&2
            echo "" >&2
            echo "To add or remove messaging channels, exit the sandbox and run:" >&2
            echo "  nemoclaw <sandbox> channels add <channel>" >&2
            echo "  nemoclaw <sandbox> channels remove <channel>" >&2
            echo "" >&2
            echo "WhatsApp pairs entirely inside the sandbox; complete pairing via:" >&2
            echo "  openclaw channels login --channel whatsapp" >&2
            echo "WeChat captures its token via a host-side QR during the host-side" >&2
            echo "'channels add wechat' flow — no in-sandbox login step." >&2
            return 1
          fi
          # NemoClaw-supported WhatsApp pairing (NemoClaw#4522): validate the
          # gateway environment up front so a gateway close (e.g. the reported
          # "1008 abnormal closure") is diagnosed separately from QR rendering,
          # and force compact QR output so the code fits on the screen.
          if [ "$_login_help" != "1" ] && [ "$_login_channel" = "whatsapp" ]; then
            # Keep an explicit override coupled to its own opt-in. The private
            # veth URL may inherit only NemoClaw's matching private-WS marker.
            if [ -n "${OPENCLAW_GATEWAY_URL:-}" ]; then
              _nemoclaw_whatsapp_gateway_url="$OPENCLAW_GATEWAY_URL"
              _nemoclaw_whatsapp_insecure_ws="${OPENCLAW_ALLOW_INSECURE_PRIVATE_WS:-}"
            else
              _nemoclaw_whatsapp_gateway_url="${NEMOCLAW_OPENCLAW_GATEWAY_URL:-}"
              _nemoclaw_whatsapp_insecure_ws="${NEMOCLAW_OPENCLAW_ALLOW_INSECURE_PRIVATE_WS:-}"
            fi
            if [ -z "$_nemoclaw_whatsapp_gateway_url" ]; then
              echo "Error: WhatsApp pairing cannot start — gateway URL is not set in this shell." >&2
              echo "Pairing talks to the OpenClaw gateway; without the gateway URL the login will" >&2
              echo "close immediately (this is a gateway/env problem, not a QR problem)." >&2
              echo "" >&2
              echo "Reconnect with 'openshell sandbox connect <sandbox>' and retry. If it persists," >&2
              echo "exit the sandbox and rebuild with 'nemoclaw <sandbox> rebuild'." >&2
              return 1
            fi
            # The OpenClaw gateway is a WebSocket endpoint (set to
            # ws://127.0.0.1:<port> at boot). Reject a malformed scheme up front
            # so a typo'd/clobbered URL is reported as a gateway/env problem
            # rather than failing inside the login as an ambiguous close.
            case "$_nemoclaw_whatsapp_gateway_url" in
              ws://*|wss://*) ;;
              *)
                echo "Error: WhatsApp pairing cannot start — gateway URL='${_nemoclaw_whatsapp_gateway_url}' is not a ws:// gateway URL." >&2
                echo "The OpenClaw gateway is a WebSocket endpoint (e.g. ws://127.0.0.1:<port>); a malformed value" >&2
                echo "would fail the login in a way that looks like a QR/pairing problem (this is a gateway/env problem)." >&2
                echo "" >&2
                echo "Reconnect with 'openshell sandbox connect <sandbox>' and retry. If it persists," >&2
                echo "exit the sandbox and rebuild with 'nemoclaw <sandbox> rebuild'." >&2
                return 1
                ;;
            esac
            echo "[whatsapp] Pairing via gateway ${_nemoclaw_whatsapp_gateway_url}." >&2
            echo "[whatsapp] On your phone: WhatsApp > Linked devices > Link a device, then scan the QR below." >&2
            # Defense-in-depth: connect-session NODE_OPTIONS already wires
            # manifest-declared connect preloads for every openclaw invocation;
            # injecting them again here covers non-connect shells. Runtime
            # preload modules are idempotent, so a double --require is harmless.
            _nemoclaw_connect_node_options="$(_nemoclaw_messaging_connect_node_options)"
            if [ -n "$_nemoclaw_connect_node_options" ]; then
              OPENCLAW_GATEWAY_URL="$_nemoclaw_whatsapp_gateway_url" \
                OPENCLAW_ALLOW_INSECURE_PRIVATE_WS="$_nemoclaw_whatsapp_insecure_ws" \
                NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }$_nemoclaw_connect_node_options" \
                command openclaw "$@"
            else
              OPENCLAW_GATEWAY_URL="$_nemoclaw_whatsapp_gateway_url" \
                OPENCLAW_ALLOW_INSECURE_PRIVATE_WS="$_nemoclaw_whatsapp_insecure_ws" \
                command openclaw "$@"
            fi
            _whatsapp_login_exit=$?
            if [ "$_whatsapp_login_exit" -ne 0 ]; then
              echo "" >&2
              echo "[whatsapp] Pairing exited with code ${_whatsapp_login_exit} before it completed." >&2
              echo "[whatsapp] A gateway close (e.g. '1008 abnormal closure') is a gateway/session" >&2
              echo "issue, not a QR-size issue — the QR above rendered independently of the gateway." >&2
              echo "[whatsapp] Re-run 'openclaw channels login --channel whatsapp' to retry. If it keeps" >&2
              echo "closing, exit the sandbox and run 'nemoclaw <sandbox> channels status --channel whatsapp'." >&2
            fi
            return $_whatsapp_login_exit
          fi
          ;;
        *)
          echo "Error: 'openclaw channels $2' cannot modify channels inside the sandbox." >&2
          echo "Changes inside the sandbox do not persist across rebuilds." >&2
          echo "" >&2
          echo "To add or remove messaging channels, exit the sandbox and run:" >&2
          echo "  nemoclaw <sandbox> channels add <channel>" >&2
          echo "  nemoclaw <sandbox> channels remove <channel>" >&2
          echo "" >&2
          echo "These stage the change and rebuild the sandbox to apply it." >&2
          echo "WhatsApp pairs entirely inside the sandbox; complete pairing via:" >&2
          echo "  openclaw channels login --channel whatsapp" >&2
          echo "WeChat captures its token via a host-side QR during the host-side" >&2
          echo "'channels add wechat' flow — no in-sandbox login step." >&2
          return 1
          ;;
      esac
      ;;
    agent)
      # Block --local inside sandbox: it bypasses gateway protections and can
      # crash the container's main process, bricking the sandbox. Ref: #1632, #2016
      local _arg
      for _arg in "$@"; do
        if [ "$_arg" = "--local" ]; then
          echo "Error: 'openclaw agent --local' is not supported inside NemoClaw sandboxes." >&2
          echo "The --local flag bypasses the gateway's security protections (secret scanning," >&2
          echo "network policy, inference auth) and can crash the sandbox." >&2
          echo "" >&2
          echo "Instead, run without --local to use the gateway's managed inference route:" >&2
          echo "  openclaw agent --agent main -m \"hello\"" >&2
          return 1
        fi
      done
      ;;
  esac
  # #4538: re-assert the mutable config perm contract after any openclaw run
  # (notably `doctor --fix`), even on a nonzero exit, then preserve its status.
  # Drop errexit around the call (mirroring the devices-approve branch above) so
  # a nonzero openclaw exit cannot abort the guard before the restore runs — the
  # nonzero-exit case is the exact #4538 scenario.
  local _nemoclaw_oc_errexit=0
  case $- in *e*) _nemoclaw_oc_errexit=1 ;; esac
  set +e
  command openclaw "$@"
  local _nemoclaw_oc_status=$?
  _nemoclaw_restore_mutable_config_perms
  [ "$_nemoclaw_oc_errexit" = "1" ] && set -e
  return "$_nemoclaw_oc_status"
}
# nemoclaw-configure-guard end
# nemoclaw-policy-denial-hint begin
# #5978: outbound network is denied-by-default and enforced by the OpenShell L7
# proxy. From inside the sandbox, generic CLIs (curl, git, wget, python, …) see
# a policy denial only as the opaque protocol error
# "CONNECT tunnel failed, response 403" — with no pointer to the detailed
# allow/deny reason, which lives in the NemoClaw logs. Surface a one-line
# breadcrumb when a human first lands in an interactive connect shell so a later
# 403 is recognisable and actionable.
#
# This deliberately does NOT wrap or alter curl/git/wget: wrapping them to scan
# stderr turns their stderr into a pipe, which makes the tools treat it as a
# non-TTY and silently drop progress meters and colour — a worse regression than
# the missing breadcrumb. The hint is therefore tool-agnostic informational
# output that leaves every tool's stdout/stderr/TTY behaviour and exit code
# byte-for-byte unchanged, and covers every connect path that sources this file.
# Shown once per top-level interactive TTY session; suppress with
# NEMOCLAW_NO_POLICY_HINT=1.
#
# Source-of-truth: the 403 itself is emitted by the OpenShell L7 egress proxy,
# which lives in a separate codebase/release cycle, so the denial response
# cannot be made self-describing from this repo. This proactive breadcrumb is
# the NemoClaw-owned surface that points at the denial reason in the logs.
# Regression coverage: test/repro-5978-policy-denial-hint.test.ts. Removal
# condition: drop this stanza once the OpenShell proxy returns a structured,
# actionable denial (naming the rule / a logs pointer) at the tunnel-failure
# site, at which point the breadcrumb is redundant.
#
# Accepted contract (#5978, maintainer-agreed on PR #6018): the supported
# behavior is this proactive connect-shell reminder. It does NOT make the
# denial-time curl/git/wget error itself denial-adjacent — that is intentional,
# given the source boundary above — so the tool error stays unchanged.
_nemoclaw_policy_denial_hint_label() {
  # OpenShell >=0.0.44 sets OPENSHELL_SANDBOX to the sandbox name; older
  # versions set the boolean "1". OPENSHELL_SANDBOX is untrusted input that is
  # interpolated into a copyable `nemoclaw … logs` command, so allowlist it
  # rather than merely stripping: only render it when it is a valid sandbox name.
  # This mirrors NAME_VALID_PATTERN in src/lib/name-validation.ts
  # (/^[a-z]([a-z0-9-]*[a-z0-9])?$/, max 63): starts with a lowercase letter,
  # then lowercase alphanumerics/hyphens, no trailing hyphen. Anything else
  # (digit-leading labels, control characters, ANSI escapes, shell
  # metacharacters, whitespace) falls back to a placeholder the user resolves
  # with `nemoclaw list`. Shell `case` globs match newlines as ordinary
  # characters, so an embedded newline is rejected by the metacharacter class.
  #
  # Evaluate the ranges under the C locale so [a-z0-9-] stays ASCII and is not
  # widened by the caller's LC_COLLATE/LC_CTYPE (e.g. a locale that folds
  # additional code points into [a-z]). Safe to set unconditionally: this helper
  # is only ever called inside $(…) command substitution (a subshell), so the
  # assignment cannot leak into the interactive shell.
  LC_ALL=C
  # Allowlist pattern mirrors NAME_VALID_PATTERN in src/lib/name-validation.ts
  # (RFC-1123 label: /^[a-z]([a-z0-9-]*[a-z0-9])?$/, max 63). Keep them in sync.
  case "${OPENSHELL_SANDBOX:-}" in
    "" | 0 | 1 | true | TRUE | false | FALSE) printf '<name>' ;;
    [!a-z]* | *- | *[!a-z0-9-]*) printf '<name>' ;;
    *)
      if [ "${#OPENSHELL_SANDBOX}" -le 63 ]; then
        printf '%s' "$OPENSHELL_SANDBOX"
      else
        printf '<name>'
      fi
      ;;
  esac
}
_nemoclaw_policy_denial_hint_text() {
  {
    printf '  Note: this sandbox restricts outbound network access by policy.\n'
    printf "  Blocked requests fail with 'CONNECT tunnel failed, response 403'.\n"
    printf '  See which rule denied a request:  nemoclaw %s logs --tail 50\n' \
      "$(_nemoclaw_policy_denial_hint_label)"
  } >&2
}
_nemoclaw_maybe_policy_denial_hint() {
  # Once per shell process: a login shell can source this file through more than
  # one system-wide hook (the login-profile hook and the interactive-bash hook;
  # #2704), so guard against printing twice. Not exported, so it neither leaks
  # into child processes nor suppresses sibling connect sessions.
  [ -n "${_NEMOCLAW_POLICY_HINT_SHOWN:-}" ] && return 0
  # Suppressed by the user.
  case "${NEMOCLAW_NO_POLICY_HINT:-}" in 1 | true | TRUE | yes | YES) return 0 ;; esac
  # Interactive human shells only — never automation (`bash -c`, scripts).
  case $- in *i*) ;; *) return 0 ;; esac
  # Real terminal on stderr (where the hint is written).
  [ -t 2 ] || return 0
  # Top-level connect shell only — don't repeat in every subshell/pane.
  [ "${SHLVL:-1}" -le 1 ] || return 0
  # Nothing is proxied (no egress restriction) ⇒ nothing to explain.
  [ -n "${HTTPS_PROXY:-${https_proxy:-}}" ] || return 0
  _NEMOCLAW_POLICY_HINT_SHOWN=1
  _nemoclaw_policy_denial_hint_text
}
_nemoclaw_maybe_policy_denial_hint
# nemoclaw-policy-denial-hint end
GUARDENVEOF
    # Global sandbox safety net for connect sessions — must be first.
    echo "export NODE_OPTIONS=\"\${NODE_OPTIONS:+\$NODE_OPTIONS }--require $_SANDBOX_SAFETY_NET\""
    # HTTP library double-proxy fix: also expose NODE_OPTIONS in connect
    # sessions so interactive shells and user commands started via
    # `openshell sandbox connect` benefit from the preload. (NemoClaw#2109)
    if [ "${NODE_USE_ENV_PROXY:-}" = "1" ]; then
      echo "export NODE_OPTIONS=\"\${NODE_OPTIONS:+\$NODE_OPTIONS }--require $_PROXY_FIX_SCRIPT\""
    fi
    # WebSocket CONNECT tunnel fix for connect sessions. (NemoClaw#1570)
    if [ -f "$_WS_FIX_SCRIPT" ]; then
      echo "export NODE_OPTIONS=\"\${NODE_OPTIONS:+\$NODE_OPTIONS }--require $_WS_FIX_SCRIPT\""
    fi
    # Git TLS CA bundle for connect sessions (NemoClaw#2270)
    if [ -n "${GIT_SSL_CAINFO:-}" ]; then
      printf 'export GIT_SSL_CAINFO=%q\n' "$GIT_SSL_CAINFO"
    fi
    # Nemotron inference fix for connect sessions. (NemoClaw#1193, #2051)
    echo "export NODE_OPTIONS=\"\${NODE_OPTIONS:+\$NODE_OPTIONS }--require $_NEMOTRON_FIX_SCRIPT\""
    # Seccomp guard for connect sessions.
    echo "export NODE_OPTIONS=\"\${NODE_OPTIONS:+\$NODE_OPTIONS }--require $_SECCOMP_GUARD_SCRIPT\""
    # ciao network guard for connect sessions.
    echo "export NODE_OPTIONS=\"\${NODE_OPTIONS:+\$NODE_OPTIONS }--require $_CIAO_GUARD_SCRIPT\""
    # Manifest-declared messaging preloads for connect sessions.
    if type emit_messaging_connect_runtime_preload_exports >/dev/null 2>&1; then
      emit_messaging_connect_runtime_preload_exports
    fi
    # Tool cache redirects — generated from _TOOL_REDIRECTS (single source of truth)
    echo '# Tool cache redirects — keep transient tool state under /tmp'
    for _redir in "${_TOOL_REDIRECTS[@]}"; do
      echo "export ${_redir?}"
    done
  } | emit_sandbox_sourced_file "$_PROXY_ENV_FILE"
}

# cleanup_on_signal is provided by sandbox-init.sh. It reads
# SANDBOX_CHILD_PIDS (array of all PIDs) and SANDBOX_WAIT_PID (the
# primary process whose exit status is returned).
# Each code path below sets these before registering the trap.

# Keep per-user rc files out of runtime proxy wiring. Older images and prior
# entrypoint versions wrote a two-line shim into .bashrc/.profile; remove that
# managed stanza before lock_rc_files makes the files read-only again.
#
# The Python body lives in scripts/lib/clean_runtime_shell_env_shim.py so it
# can be unit-tested with controlled rc fixtures. Installed location in the
# sandbox image: /usr/local/lib/nemoclaw/clean_runtime_shell_env_shim.py.
ensure_runtime_shell_env_shim() {
  local failed=0
  local rc_file
  # Resolution order is deliberately fixed: the immutable installed helper at
  # /usr/local/lib/nemoclaw/ ALWAYS wins when present. That path is set up
  # by the Dockerfile, chmod 644, root-owned (or build-time owned), and lives
  # under a system directory the sandbox user cannot write to. We refuse to
  # honour any environment-supplied override when that file is in place so a
  # malicious envvar cannot swap in arbitrary Python.
  #
  # The NEMOCLAW_RC_CLEAN_SCRIPT override is consulted ONLY when the installed
  # helper is missing — i.e. running the unit-test wrappers against the
  # repository tree, where the script lives at scripts/lib/ instead.
  # The final fallback resolves the script relative to nemoclaw-start.sh so
  # `bash scripts/nemoclaw-start.sh` works out-of-the-box for ad-hoc dev runs.
  local clean_script="/usr/local/lib/nemoclaw/clean_runtime_shell_env_shim.py"
  if [ ! -f "$clean_script" ]; then
    if [ -n "${NEMOCLAW_RC_CLEAN_SCRIPT:-}" ] && [ -f "${NEMOCLAW_RC_CLEAN_SCRIPT}" ]; then
      clean_script="${NEMOCLAW_RC_CLEAN_SCRIPT}"
    else
      clean_script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/clean_runtime_shell_env_shim.py"
    fi
  fi

  for rc_file in "${_SANDBOX_HOME}/.bashrc" "${_SANDBOX_HOME}/.profile"; do
    if [ -L "$rc_file" ]; then
      echo "[SECURITY] refusing symlinked rc file: $rc_file" >&2
      failed=1
      continue
    fi
    if [ -e "$rc_file" ] && [ ! -f "$rc_file" ]; then
      echo "[SECURITY] refusing non-regular rc file: $rc_file" >&2
      failed=1
      continue
    fi
    if [ ! -f "$rc_file" ]; then
      continue
    fi

    if ! command python3 "$clean_script" "$rc_file" "$_RUNTIME_SHELL_ENV_SHIM" "$(id -u)"; then
      failed=1
      continue
    fi
  done

  return "$failed"
}

# ── Legacy layout migration ──────────────────────────────────────
# Sandboxes created with the OLD base image have:
#   .openclaw/ containing symlinks → .openclaw-data/<subdir>
#   .openclaw-data/ containing real state data
# Migrate to the new layout: real data lives directly in .openclaw/.
# Idempotent: no-op if .openclaw-data doesn't exist.
#
# SECURITY (NC-2227-01): Guard against agent-planted data dirs.
# Only migrate if (a) we are running as root (the agent cannot call
# this path), (b) the data directory is NOT agent-writable (root-owned),
# and (c) a migration-complete sentinel does not already exist.
# After migration, reapply shields-up ownership if shields were active.
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

restore_immutable_if_possible() {
  command -v chattr >/dev/null 2>&1 || return 0
  local target
  for target in "$@"; do
    [ -e "$target" ] || [ -L "$target" ] || continue
    [ -L "$target" ] && continue
    chattr +i "$target" 2>/dev/null || true
  done
}

chown_tree_no_symlink_follow() {
  local owner="$1" target="$2"
  [ -d "$target" ] || return 0
  find -P "$target" \( -type d -o -type f \) -exec chown "$owner" {} + 2>/dev/null || true
}

legacy_symlinks_exist() {
  local config_dir="$1" data_dir="$2"
  local data_real entry raw_target resolved_target
  data_real="$(readlink -f "$data_dir" 2>/dev/null || echo "$data_dir")"
  for entry in "$config_dir"/.[!.]* "$config_dir"/..?* "$config_dir"/*; do
    [ -L "$entry" ] || continue
    raw_target="$(readlink "$entry" 2>/dev/null || true)"
    resolved_target="$(readlink -f "$entry" 2>/dev/null || true)"
    case "$raw_target" in
      "$data_real"/* | "$data_dir"/*) return 0 ;;
    esac
    case "$resolved_target" in
      "$data_real"/* | "$data_dir"/*) return 0 ;;
    esac
  done
  return 1
}

assert_no_legacy_layout() {
  local config_dir="$1" data_dir="$2" label="$3"
  local data_real entry raw_target resolved_target
  if [ -e "$data_dir" ] || [ -L "$data_dir" ]; then
    echo "[SECURITY] ${label}: legacy data dir still exists after migration: ${data_dir}" >&2
    return 1
  fi
  data_real="$(readlink -f "$data_dir" 2>/dev/null || echo "$data_dir")"
  for entry in "$config_dir"/.[!.]* "$config_dir"/..?* "$config_dir"/*; do
    [ -L "$entry" ] || continue
    raw_target="$(readlink "$entry" 2>/dev/null || true)"
    resolved_target="$(readlink -f "$entry" 2>/dev/null || true)"
    case "$raw_target" in
      "$data_real"/* | "$data_dir"/*)
        echo "[SECURITY] ${label}: legacy symlink remains after migration: ${entry} -> ${raw_target}" >&2
        return 1
        ;;
    esac
    case "$resolved_target" in
      "$data_real"/* | "$data_dir"/*)
        echo "[SECURITY] ${label}: legacy symlink remains after migration: ${entry} -> ${resolved_target}" >&2
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

  # Guard 1: Already migrated — the sentinel proves a prior trusted run.
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

  # Guard 2: Only root may run migration. The sandbox user cannot reach
  # this code path (entrypoint runs as root or the non-root branch never
  # calls migrate), but be explicit.
  if [ "$(id -u)" -ne 0 ]; then
    echo "[SECURITY] ${label}: migration skipped — requires root" >&2
    return 0
  fi

  # Guard 3: Reject agent-planted data directories. A legitimate legacy
  # data dir was created by the image build (root-owned). If the data dir
  # is owned by sandbox, the agent may have planted it to trigger migration.
  local data_owner
  data_owner="$(stat -c '%U' "$data_dir" 2>/dev/null || stat -f '%Su' "$data_dir" 2>/dev/null || echo "unknown")"
  if [ "$data_owner" = "sandbox" ] && ! legacy_symlinks_exist "$config_dir" "$data_dir"; then
    echo "[SECURITY] ${label}: sandbox-owned ${data_dir} has no legacy symlink bridge — refusing migration (possible agent-planted trigger)" >&2
    return 1
  fi

  # Check if shields were previously active (config dir is root-owned).
  local shields_were_active=false
  local config_dir_owner
  config_dir_owner="$(stat -c '%U' "$config_dir" 2>/dev/null || stat -f '%Su' "$config_dir" 2>/dev/null || echo "unknown")"
  if [ "$config_dir_owner" = "root" ]; then
    shields_were_active=true
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

  # Only chown state subdirectories, NOT the config dir itself or
  # protected files (openclaw.json, .config-hash, .env).
  # This prevents undoing shields-up root ownership on the config dir.
  for entry in "$config_dir"/.[!.]* "$config_dir"/..?* "$config_dir"/*; do
    [ -L "$entry" ] && continue
    [ -d "$entry" ] || continue
    chown_tree_no_symlink_follow sandbox:sandbox "$entry"
  done

  rm -rf "$data_dir"
  assert_no_legacy_layout "$config_dir" "$data_dir" "$label" || return 1

  # Write the migration sentinel (root-owned, read-only) so we never
  # re-run migration on this sandbox.
  printf 'migrated=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$sentinel"
  chown root:root "$sentinel" 2>/dev/null || true
  chmod 444 "$sentinel" 2>/dev/null || true

  # Reapply shields-up ownership if config dir was previously root-locked.
  if [ "$shields_were_active" = "true" ]; then
    echo "[migration] Reapplying shields-up ownership on ${config_dir}" >&2
    chown root:root "$config_dir" 2>/dev/null || true
    chmod 755 "$config_dir" 2>/dev/null || true
    # Re-lock known sensitive files if they exist
    for f in "$config_dir"/openclaw.json "$config_dir"/.config-hash "$config_dir"/.env; do
      if [ -f "$f" ]; then
        chown root:root "$f" 2>/dev/null || true
        chmod 444 "$f" 2>/dev/null || true
      fi
    done
    for subdir in skills hooks cron agents extensions plugins; do
      if [ -d "$config_dir/$subdir" ]; then
        chown_tree_no_symlink_follow root:root "$config_dir/$subdir"
        chmod 755 "$config_dir/$subdir" 2>/dev/null || true
        chmod -R go-w "$config_dir/$subdir" 2>/dev/null || true
        restore_immutable_if_possible "$config_dir/$subdir"
      fi
    done
    restore_immutable_if_possible \
      "$config_dir"/openclaw.json \
      "$config_dir"/.config-hash \
      "$config_dir"/.env \
      "$config_dir"
  fi

  echo "[migration] Completed ${label} layout migration (${data_dir} removed)" >&2
}

# Seed default OpenClaw workspace template files when the workspace is
# pristine. OpenClaw normally writes these from bundled templates at first
# agent boot via ensureAgentWorkspace(), but when
# `agents.defaults.skipBootstrap=true` (set by NemoClaw to suppress the
# interactive identity-setup turn) that path short-circuits before any
# template is written, leaving /sandbox/.openclaw/workspace/ empty.
# Reuse OpenClaw's own bundled templates so seeded content matches what
# upstream would have produced. BOOTSTRAP.md is intentionally excluded —
# its presence is what triggers the interactive turn we are skipping.
# Ref: https://github.com/NVIDIA/NemoClaw/issues/3240
seed_default_workspace_templates() {
  local workspace_dir="${1:-/sandbox/.openclaw/workspace}"
  local templates_dir="${2:-}"
  local config_file="${3:-/sandbox/.openclaw/openclaw.json}"

  # #2598: opt-in flag that skips default workspace template seeding for
  # new/pristine workspaces (does NOT delete files already present). Cuts
  # ~3k tokens off OpenClaw's per-turn bootstrap context injection.
  if [ "${NEMOCLAW_MINIMAL_BOOTSTRAP:-}" = "1" ]; then
    echo "[setup] NEMOCLAW_MINIMAL_BOOTSTRAP=1; skipping default workspace template seed" >&2
    return 0
  fi

  if [ ! -f "$config_file" ]; then
    return 0
  fi
  if ! command -v node >/dev/null 2>&1; then
    return 0
  fi
  if ! node - "$config_file" <<'NODE' >/dev/null 2>&1; then
const fs = require("fs");
const configPath = process.argv[2];
const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
process.exit(cfg?.agents?.defaults?.skipBootstrap === true ? 0 : 1);
NODE
    return 0
  fi

  [ -e "$workspace_dir" ] || return 0
  if [ -L "$workspace_dir" ]; then
    echo "[SECURITY] refusing to seed symlinked workspace dir: $workspace_dir" >&2
    return 0
  fi
  [ -d "$workspace_dir" ] || return 0
  # Only seed pristine workspaces — never clobber user content.
  if [ -n "$(ls -A "$workspace_dir" 2>/dev/null)" ]; then
    return 0
  fi
  if [ -z "$templates_dir" ]; then
    local npm_root openclaw_bin openclaw_real openclaw_pkg candidate searched_template_dirs=""
    local openclaw_pkg_roots=()
    npm_root="$(npm root -g 2>/dev/null || true)"
    if [ -n "$npm_root" ]; then
      openclaw_pkg_roots+=("${npm_root}/openclaw")
    fi
    openclaw_pkg_roots+=("/usr/local/lib/node_modules/openclaw")
    if openclaw_bin="$(command -v openclaw 2>/dev/null)"; then
      openclaw_real="$(readlink -f "$openclaw_bin" 2>/dev/null || printf '%s\n' "$openclaw_bin")"
      openclaw_pkg="$(
        if cd "$(dirname "$openclaw_real")/.." 2>/dev/null; then
          pwd -P
        fi
      )"
      if [ -n "$openclaw_pkg" ]; then
        openclaw_pkg_roots+=("$openclaw_pkg")
      fi
    fi

    templates_dir=""
    for openclaw_pkg in "${openclaw_pkg_roots[@]}"; do
      for candidate in \
        "${openclaw_pkg}/docs/reference/templates" \
        "${openclaw_pkg}/dist/docs/reference/templates"; do
        searched_template_dirs="${searched_template_dirs}${searched_template_dirs:+, }${candidate}"
        if [ -d "$candidate" ]; then
          templates_dir="$candidate"
          break
        fi
      done
      [ -n "$templates_dir" ] && break
    done
  fi
  if [ -z "$templates_dir" ] || [ ! -d "$templates_dir" ]; then
    if [ -n "${searched_template_dirs:-}" ]; then
      echo "[setup] openclaw workspace templates dir not found; tried: ${searched_template_dirs}; skipping default workspace seed" >&2
    else
      echo "[setup] openclaw workspace templates dir not found: ${templates_dir}; skipping default workspace seed" >&2
    fi
    return 0
  fi
  local file src dst tmp seeded=0
  for file in AGENTS.md SOUL.md IDENTITY.md USER.md TOOLS.md HEARTBEAT.md; do
    src="$templates_dir/$file"
    dst="$workspace_dir/$file"
    if [ -f "$src" ] && [ ! -e "$dst" ]; then
      tmp="${dst}.tmp.$$"
      if awk '
        NR == 1 && $0 == "---" { in_frontmatter = 1; next }
        in_frontmatter && $0 == "---" { in_frontmatter = 0; next }
        !in_frontmatter { print }
      ' "$src" >"$tmp" 2>/dev/null && mv "$tmp" "$dst" 2>/dev/null; then
        seeded=$((seeded + 1))
      else
        rm -f "$tmp" 2>/dev/null || true
      fi
    fi
  done
  if [ "$seeded" -gt 0 ]; then
    echo "[setup] seeded ${seeded} default workspace template(s) into ${workspace_dir}" >&2
  fi
}

# Extract the literal source of a bash function from its defining file.
#
# Uses `shopt -s extdebug` + `declare -F` to look up the function's
# source location, then prints the function definition byte-exact from
# disk. The opener line MUST match ^<name>\(\) \{$ and the body MUST
# end with a single `}` at column 0; every function dispatched through
# run_step_down_as_sandbox follows that style.
#
# This bypasses `declare -f`'s serialiser, which mis-orders the body of
# functions whose `if`/`while`/`until` condition is a here-doc command:
# `declare -f` places the indented `then`-body command immediately after
# the `<<TAG` opener and before the here-doc body. The step-down shell
# then absorbs the displaced command into the here-doc body, leaves the
# `then` block empty, and aborts on the closing `fi` with
#   syntax error near unexpected token `fi'
# Reading the source bytes off disk preserves the original layout and
# is robust to every here-doc shape, not only the
# here-doc-as-last-statement shape `declare -f` happens to round-trip.
#
# Returns 1 on any of: function not a function, source file unreadable,
# opener line shape unrecognised, or matching closing `}` not found.
_step_down_extract_function() {
  local fn="$1"
  local info src_lineno src_path
  if ! shopt -s extdebug 2>/dev/null; then
    return 1
  fi
  info="$(declare -F "$fn" 2>/dev/null)"
  shopt -u extdebug 2>/dev/null || true
  if [ -z "$info" ]; then
    return 1
  fi
  src_lineno="${info#* }"
  src_lineno="${src_lineno%% *}"
  src_path="${info#* * }"
  if [ -z "$src_lineno" ] || [ -z "$src_path" ] || [ ! -r "$src_path" ]; then
    return 1
  fi
  awk -v start="$src_lineno" -v fn="$fn" '
    NR == start {
      # One-liner shape: `name() { body; }` — entire definition on one line.
      # No heredoc is possible in this shape, so emit and stop.
      if ($0 ~ "^"fn"[[:space:]]*\\(\\)[[:space:]]*\\{.*\\}[[:space:]]*$") {
        print
        exit 0
      }
      # Multi-line shape: `name() {` opener, with the matching `}` on its
      # own line at column 0 at the end of the body. Both production
      # call sites and the test stubs that exercise here-docs follow
      # this convention.
      if ($0 !~ "^"fn"[[:space:]]*\\(\\)[[:space:]]*\\{[[:space:]]*$") {
        exit 1
      }
      in_fn = 1
      print
      next
    }
    !in_fn { next }
    in_heredoc {
      print
      if ($0 == heredoc_tag) in_heredoc = 0
      next
    }
    {
      print
      if (match($0, /<<-?[[:space:]]*['"'"'"]?[A-Za-z_][A-Za-z0-9_]*['"'"'"]?/)) {
        tag = substr($0, RSTART, RLENGTH)
        sub(/^<<-?[[:space:]]*/, "", tag)
        sub(/^['"'"'"]/, "", tag)
        sub(/['"'"'"]$/, "", tag)
        in_heredoc = 1
        heredoc_tag = tag
        next
      }
      if ($0 == "}") exit
    }
    END { if (in_fn && in_heredoc) exit 1 }
  ' "$src_path"
}

# Run one or more locally-defined bash functions as the sandbox user
# without round-tripping through `bash -c "$(declare -f ...) ..."` and
# without going through `declare -f`'s serialiser at all.
#
# The interpolated argv form was fragile because the step-down shell
# could not always re-parse a here-doc-bearing function body carried
# through `bash -c`'s argv. The earlier in-house fix routed function
# bodies through `declare -f` plus a temp file, which removed the argv
# round-trip but kept `declare -f`'s body-reordering bug for here-doc
# `if` conditions. This helper now copies each named function's source
# verbatim from `${BASH_SOURCE[0]}` (resolved per function via the
# extdebug machinery), so every here-doc shape — condition, body,
# trailing — survives the dispatch unchanged.
#
# The temp script lives directly under /tmp (sticky-bit, world-writable
# but unlink-protected) with an unguessable mktemp suffix, so an
# attacker cannot swap the file between mktemp and the step-down bash
# invocation. The directory is intentionally not configurable.
#
# A `bash -n` syntax check runs on the assembled script before the
# step-down invocation. It is a fail-closed guard: if a future change
# ever produces a malformed temp script (for example, a dispatched
# function that violates the opener/closer style assumption), we abort
# before handing the broken script to step-down, surfacing a clean
# error instead of the obscure `unexpected token 'fi'` failure that
# this helper exists to prevent.
#
# Usage: run_step_down_as_sandbox <invocation-snippet> <fn>...
#
# SECURITY CONTRACT: <invocation-snippet> is appended verbatim to the
# generated bash script and parsed by the step-down shell. It MUST be
# a trusted literal authored alongside this script — never derived
# from environment, file contents, sandbox-uid input, or any
# non-static source. Pass arguments through positional parameters of
# the dispatched functions, not through string interpolation into the
# snippet, and keep the snippet to the minimum set of function calls
# (plus the explicit `export HOME=...` the auth-profile path needs).
run_step_down_as_sandbox() {
  local invocation="$1"
  shift
  local script
  script="$(mktemp /tmp/nemoclaw-step-down-XXXXXX.sh)" || return 1
  if ! chmod 0644 "$script" 2>/dev/null; then
    rm -f "$script" 2>/dev/null || true
    return 1
  fi
  if ! (
    printf 'set -euo pipefail\n'
    for fn in "$@"; do
      _step_down_extract_function "$fn" || exit 1
    done
    printf '%s\n' "$invocation"
  ) >"$script"; then
    rm -f "$script" 2>/dev/null || true
    printf '[step-down] failed to assemble dispatch script\n' >&2
    return 1
  fi
  if ! bash -n "$script" 2>/dev/null; then
    rm -f "$script" 2>/dev/null || true
    printf '[step-down] generated dispatch script failed bash -n syntax check\n' >&2
    return 1
  fi
  local rc=0
  "${STEP_DOWN_PREFIX_SANDBOX[@]}" bash "$script" || rc=$?
  rm -f "$script" 2>/dev/null || true
  return "$rc"
}

seed_default_workspace_templates_as_sandbox() {
  run_step_down_as_sandbox \
    "seed_default_workspace_templates /sandbox/.openclaw/workspace '' /sandbox/.openclaw/openclaw.json" \
    seed_default_workspace_templates
}

# Root-mode entry point for the post-gateway auth-profile setup. The
# step-down shell needs HOME=/sandbox explicitly because setpriv keeps
# the parent entrypoint's HOME=/root, which would push
# write_auth_profile's `~/.openclaw/...` expansion outside the sandbox.
# The non-root path exports HOME=/sandbox up front, so the equivalent
# call there does not need the wrapper.
setup_auth_profile_as_sandbox() {
  run_step_down_as_sandbox \
    "export HOME=/sandbox; write_auth_profile; harden_auth_profiles" \
    write_auth_profile \
    harden_auth_profiles
}

PLUGIN_REFRESH_LOG="/tmp/nemoclaw-plugin-refresh.log"

prepare_plugin_refresh_log() {
  local dir base tmp
  dir="$(dirname "$PLUGIN_REFRESH_LOG")"
  base="$(basename "$PLUGIN_REFRESH_LOG")"

  if [ -L "$PLUGIN_REFRESH_LOG" ]; then
    echo "[SECURITY] refusing to use symlinked plugin-refresh log: $PLUGIN_REFRESH_LOG" >&2
    return 1
  fi
  if [ -e "$PLUGIN_REFRESH_LOG" ] && [ ! -f "$PLUGIN_REFRESH_LOG" ]; then
    echo "[SECURITY] refusing to use non-regular plugin-refresh log: $PLUGIN_REFRESH_LOG" >&2
    return 1
  fi

  # Create the log through a same-directory temp file and rename it into place.
  # Root never opens the sandbox-controlled final /tmp path, and the refresh
  # command below performs its redirection after dropping to the sandbox user.
  tmp="$(mktemp "${dir}/.${base}.tmp.XXXXXX")" || return 1
  if [ "$(id -u)" -eq 0 ] && ! chown sandbox:sandbox "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  if ! chmod 600 "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  if ! mv -f "$tmp" "$PLUGIN_REFRESH_LOG"; then
    rm -f "$tmp"
    return 1
  fi
}

start_plugin_registry_refresh() {
  (
    local ready=0
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      if [ "$(id -u)" -eq 0 ]; then
        if "${STEP_DOWN_PREFIX_SANDBOX[@]}" env HOME=/sandbox "$OPENCLAW" gateway status >/dev/null 2>&1; then
          ready=1
          break
        fi
      elif env HOME=/sandbox "$OPENCLAW" gateway status >/dev/null 2>&1; then
        ready=1
        break
      fi
      sleep 1
    done
    if [ "$ready" -ne 1 ]; then
      echo "[plugin-refresh] gateway did not become ready; skipping registry refresh" >&2
      exit 0
    fi
    if [ "$(id -u)" -eq 0 ]; then
      "${STEP_DOWN_PREFIX_SANDBOX[@]}" env HOME=/sandbox PLUGIN_REFRESH_LOG="$PLUGIN_REFRESH_LOG" \
        sh -c "exec \"\$@\" >\"\$PLUGIN_REFRESH_LOG\" 2>&1" sh \
        "$OPENCLAW" plugins registry --refresh || true
    else
      env HOME=/sandbox PLUGIN_REFRESH_LOG="$PLUGIN_REFRESH_LOG" \
        sh -c "exec \"\$@\" >\"\$PLUGIN_REFRESH_LOG\" 2>&1" sh \
        "$OPENCLAW" plugins registry --refresh || true
    fi
  ) &
  PLUGIN_REFRESH_PID=$!
  if ! capture_openclaw_pid_start_identity "$PLUGIN_REFRESH_PID" PLUGIN_REFRESH_PID_START_IDENTITY; then
    # The best-effort refresh may legitimately finish before PID 1 can read
    # its stat record.  An uncaptured PID is never admitted or signalled.
    PLUGIN_REFRESH_PID_START_IDENTITY=""
  fi
}

# Watchdog for the in-container gateway HTTP listener (#4710). OpenClaw's
# config reloader can SIGUSR1-restart the gateway in-process; in containers a
# failed restart parks the process alive with its listener closed ("gateway
# startup failed: ... Process will stay alive"). The #2757 respawn loop only
# observes process exit, so an alive-but-deaf gateway would stay wedged until
# a human runs `nemoclaw <sandbox> recover`. This watchdog probes the local
# health endpoint and — once it has seen a listener at least once — kills the
# gateway after sustained connection-refused so the respawn loop relaunches
# it. Only curl exit 7 counts as "listener gone": 200/401 mean serving, and
# timeout / HTTP-error outcomes (curl 28/22) mean a listener exists and remain
# the Docker HEALTHCHECK's responsibility. Arming only after the first
# non-refused probe means a slow first boot is never killed; failed first
# boots stay the respawn loop's and HEALTHCHECK's job.

# PID-reuse / tamper defense: only kill a process whose cmdline still looks
# like the OpenClaw gateway. Match the PID 1 launch argv
# ("... openclaw gateway run --port N") and the rewritten process titles
# ("openclaw-gateway", bare "openclaw").
gateway_pid_is_openclaw_gateway() {
  # _NEMOCLAW_PROC_ROOT is a test seam (unit tests also run on macOS, which
  # has no /proc). Production always uses /proc: the watchdog inherits PID 1's
  # environment, which the sandbox user cannot influence.
  local cmdline
  cmdline="$(tr '\0' ' ' <"${_NEMOCLAW_PROC_ROOT:-/proc}/$1/cmdline" 2>/dev/null)" || return 1
  cmdline="${cmdline%"${cmdline##*[![:space:]]}"}"
  [ -n "$cmdline" ] || return 1
  printf '%s' "$cmdline" | grep -qE 'openclaw([ -]gateway| gateway run|$)'
}

# Positive integer guard used by the gateway watchdog env validation. Extracted
# so a regression test can exercise the regex against trailing-non-digit and
# zero/garbage inputs without spinning up the whole watcher.
gateway_watchdog_positive_int_ok() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

start_gateway_serving_watchdog() {
  (
    local interval refused_threshold armed=0 refused_streak=0
    local pid start_identity extra tracked_identity last_identity="" rc msg
    interval="${NEMOCLAW_GATEWAY_WATCHDOG_INTERVAL_SECONDS:-30}"
    refused_threshold="${NEMOCLAW_GATEWAY_WATCHDOG_REFUSED_THRESHOLD:-4}"
    # Both knobs must be positive integers: a zero/garbage interval would
    # busy-loop the probe, and a zero threshold would kill on the first
    # refusal. Fall back to the defaults rather than trusting bad input.
    # gateway_watchdog_positive_int_ok uses regex (=~), not glob, so trailing
    # non-digit input like "12x" or "30abc" is rejected, not coerced.
    if ! gateway_watchdog_positive_int_ok "$interval"; then
      echo "[gateway-watchdog] invalid NEMOCLAW_GATEWAY_WATCHDOG_INTERVAL_SECONDS='${interval}'; defaulting to 30" >&2
      interval=30
    fi
    if ! gateway_watchdog_positive_int_ok "$refused_threshold"; then
      echo "[gateway-watchdog] invalid NEMOCLAW_GATEWAY_WATCHDOG_REFUSED_THRESHOLD='${refused_threshold}'; defaulting to 4" >&2
      refused_threshold=4
    fi
    [ -n "${_DASHBOARD_PORT:-}" ] || exit 0
    while :; do
      sleep "$interval"
      pid=""
      start_identity=""
      extra=""
      IFS=' ' read -r pid start_identity extra <"$GATEWAY_PID_FILE" 2>/dev/null || true
      case "$pid" in
        '' | *[!0-9]*)
          last_identity=""
          armed=0
          refused_streak=0
          continue
          ;;
      esac
      case "$start_identity" in
        '' | *[!0-9]*)
          last_identity=""
          armed=0
          refused_streak=0
          continue
          ;;
      esac
      if [ -n "$extra" ]; then
        last_identity=""
        armed=0
        refused_streak=0
        continue
      fi
      tracked_identity="${pid}:${start_identity}"
      # A respawned gateway must earn its own armed state — never inherit
      # the previous process identity's serve history, even if the kernel has
      # already recycled the same numeric PID for the replacement.
      if [ "$tracked_identity" != "$last_identity" ]; then
        last_identity="$tracked_identity"
        armed=0
        refused_streak=0
      fi
      if ! openclaw_supervised_pid_is_live "$pid" "$start_identity"; then
        # Process exit is the respawn loop's signal, not ours.
        last_identity=""
        armed=0
        refused_streak=0
        continue
      fi
      rc=0
      curl -s -o /dev/null --max-time 5 "http://127.0.0.1:${_DASHBOARD_PORT}/health" 2>/dev/null || rc=$?
      if [ "$rc" -ne 7 ]; then
        armed=1
        refused_streak=0
        continue
      fi
      [ "$armed" -eq 1 ] || continue
      refused_streak=$((refused_streak + 1))
      if [ "$refused_streak" -lt "$refused_threshold" ]; then
        echo "[gateway-watchdog] gateway pid $pid alive but port ${_DASHBOARD_PORT} refused connection ($refused_streak/$refused_threshold) (#4710)" >&2
        continue
      fi
      if ! gateway_pid_is_openclaw_gateway "$pid"; then
        echo "[gateway-watchdog] pid $pid no longer looks like the openclaw gateway; not killing (#4710)" >&2
        armed=0
        refused_streak=0
        continue
      fi
      if ! openclaw_supervised_pid_is_live "$pid" "$start_identity"; then
        echo "[gateway-watchdog] pid $pid start identity changed; not killing (#4710)" >&2
        last_identity=""
        armed=0
        refused_streak=0
        continue
      fi
      msg="[gateway-watchdog] CRITICAL: gateway pid $pid is alive but dropped its HTTP listener on port ${_DASHBOARD_PORT} ($refused_streak consecutive refused probes); killing it so the respawn loop can relaunch (#4710)"
      echo "$msg" >&2
      # _NEMOCLAW_GATEWAY_LOG is a test seam; production always appends to
      # /tmp/gateway.log alongside the gateway's own output.
      echo "$msg" >>"${_NEMOCLAW_GATEWAY_LOG:-/tmp/gateway.log}" 2>/dev/null || true
      record_gateway_watchdog_kill "$tracked_identity"
      kill -TERM "$pid" 2>/dev/null || true
      for _ in 1 2 3 4 5 6 7 8 9 10; do
        openclaw_supervised_pid_is_live "$pid" "$start_identity" || break
        sleep 1
      done
      if openclaw_supervised_pid_is_live "$pid" "$start_identity"; then
        kill -KILL "$pid" 2>/dev/null || true
      fi
      armed=0
      refused_streak=0
    done
  ) &
  GATEWAY_WATCHDOG_PID=$!
  if ! capture_openclaw_pid_start_identity "$GATEWAY_WATCHDOG_PID" GATEWAY_WATCHDOG_PID_START_IDENTITY; then
    echo "[gateway-watchdog] could not capture watchdog process identity" >&2
    return 1
  fi
}

openclaw_gateway_pid_owns_listener() {
  local pid="$1"
  local port="$2"
  if [ "$(id -u)" -ne 0 ]; then
    gateway_control_pid_owns_tcp_listener "$pid" "$port"
    return $?
  fi
  # shellcheck disable=SC2016  # positional args expand in the inner bash
  "${STEP_DOWN_PREFIX_GATEWAY[@]}" env -u BASH_ENV \
    bash --noprofile --norc -c \
    'source "$1"; gateway_control_pid_owns_tcp_listener "$2" "$3"' \
    bash "$_GATEWAY_SUPERVISOR" "$pid" "$port"
}

openclaw_gateway_healthy() {
  local pid="$1"
  local expected_identity="$2"
  local code
  openclaw_supervised_pid_is_live "$pid" "$expected_identity" || return 1
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:${_DASHBOARD_PORT}/health" 2>/dev/null || true)"
  case "$code" in
    200 | 401)
      openclaw_supervised_pid_is_live "$pid" "$expected_identity" \
        && openclaw_gateway_pid_owns_listener "$pid" "$_DASHBOARD_PORT" \
        && openclaw_supervised_pid_is_live "$pid" "$expected_identity"
      ;;
    *) return 1 ;;
  esac
}

wait_for_openclaw_gateway_internal() {
  local pid="$1"
  local expected_identity="$2"
  local deadline=$((SECONDS + 90))
  while [ "$SECONDS" -lt "$deadline" ]; do
    openclaw_supervised_pid_is_live "$pid" "$expected_identity" || return 1
    openclaw_gateway_healthy "$pid" "$expected_identity" && return 0
    sleep 1
  done
  return 1
}

launch_openclaw_gateway() {
  mark_in_container_gateway
  nohup "${STEP_DOWN_PREFIX_GATEWAY[@]}" sh -c \
    'umask 0007; exec "$@" >>/tmp/gateway.log 2>&1' sh \
    "$OPENCLAW" gateway run --port "${_DASHBOARD_PORT}" &
  GATEWAY_PID=$!
  if ! capture_openclaw_pid_start_identity "$GATEWAY_PID" GATEWAY_PID_START_IDENTITY; then
    # An uncaptured numeric PID is never safe to signal: Bash may already have
    # reaped the short-lived child and the kernel may have reused its PID. Fail
    # PID 1 so the container/runtime tears down any surviving untracked child.
    GATEWAY_PID=0
    GATEWAY_PID_START_IDENTITY=""
    clear_gateway_pid_record
    echo "[gateway] could not capture gateway process identity" >&2
    exit 1
  fi
  record_gateway_pid "$GATEWAY_PID" "$GATEWAY_PID_START_IDENTITY"
  # shellcheck disable=SC2034  # read by cleanup_on_signal from sandbox-init.sh
  SANDBOX_WAIT_PID="$GATEWAY_PID"
  echo "[gateway] openclaw gateway launched as 'gateway' user (pid $GATEWAY_PID)" >&2
}

openclaw_supervised_aux_pid_is_live() {
  local pid="$1"
  local expected_identity="$2"
  openclaw_supervised_pid_is_live "$pid" "$expected_identity"
}

stop_openclaw_supervised_gateway() {
  local pid="$1"
  local expected_identity="$2"
  openclaw_supervised_pid_is_live "$pid" "$expected_identity" || return 1
  gateway_control_stop_tracked_pid "$pid" "$expected_identity" || return 1
  if kill -0 "$pid" 2>/dev/null; then
    # The shared helper returns success when a later identity read says the
    # numeric PID changed. Before clearing the gateway identity or relaunching,
    # require the stronger postcondition that no process occupies that PID.
    echo "[SECURITY] OpenClaw gateway pid ${pid} remains live after tracked stop; refusing to treat it as stopped" >&2
    return 1
  fi
}

refresh_openclaw_supervised_child_pids() {
  SANDBOX_CHILD_PIDS=()
  openclaw_supervised_pid_is_live \
    "${GATEWAY_PID:-}" "${GATEWAY_PID_START_IDENTITY:-}" \
    && SANDBOX_CHILD_PIDS+=("$GATEWAY_PID")
  openclaw_supervised_aux_pid_is_live \
    "${AUTO_PAIR_PID:-}" "${AUTO_PAIR_PID_START_IDENTITY:-}" \
    && SANDBOX_CHILD_PIDS+=("$AUTO_PAIR_PID")
  openclaw_supervised_aux_pid_is_live \
    "${GATEWAY_LOG_TAIL_PID:-}" "${GATEWAY_LOG_TAIL_PID_START_IDENTITY:-}" \
    && SANDBOX_CHILD_PIDS+=("$GATEWAY_LOG_TAIL_PID")
  openclaw_supervised_aux_pid_is_live \
    "${GATEWAY_LOG_PERSIST_PID:-}" "${GATEWAY_LOG_PERSIST_PID_START_IDENTITY:-}" \
    && SANDBOX_CHILD_PIDS+=("$GATEWAY_LOG_PERSIST_PID")
  openclaw_supervised_aux_pid_is_live \
    "${PLUGIN_REFRESH_PID:-}" "${PLUGIN_REFRESH_PID_START_IDENTITY:-}" \
    && SANDBOX_CHILD_PIDS+=("$PLUGIN_REFRESH_PID")
  openclaw_supervised_aux_pid_is_live \
    "${GATEWAY_WATCHDOG_PID:-}" "${GATEWAY_WATCHDOG_PID_START_IDENTITY:-}" \
    && SANDBOX_CHILD_PIDS+=("$GATEWAY_WATCHDOG_PID")
  return 0
}

mark_openclaw_gateway_stopped() {
  GATEWAY_PID=0
  GATEWAY_PID_START_IDENTITY=""
  [ -n "${GATEWAY_PID_FILE:-}" ] && clear_gateway_pid_record
  # shellcheck disable=SC2034  # read by cleanup_on_signal from sandbox-init.sh
  SANDBOX_WAIT_PID=""
  refresh_openclaw_supervised_child_pids
}

stop_openclaw_gateway_fail_closed() {
  if ! stop_openclaw_supervised_gateway \
    "${GATEWAY_PID:-0}" "${GATEWAY_PID_START_IDENTITY:-}"; then
    echo "[CRITICAL] OpenClaw gateway revocation could not prove and stop the tracked child; exiting PID 1 for whole-container cleanup without signaling the unproven PID" >&2
    exit 1
  fi
  mark_openclaw_gateway_stopped
}

OPENCLAW_REAP_EXIT_STATUS=0
openclaw_reap_exited_gateway() {
  local pid="${GATEWAY_PID:-0}"
  local expected_start_identity="${GATEWAY_PID_START_IDENTITY:-}"
  local current_start_identity state
  local rc=0
  case "$pid" in
    '' | 0 | 1 | *[!0-9]*) return 1 ;;
  esac
  [ -n "$expected_start_identity" ] || return 1

  current_start_identity="$(openclaw_pid_start_identity "$pid" 2>/dev/null || true)"
  if [ -n "$current_start_identity" ] \
    && [ "$current_start_identity" != "$expected_start_identity" ]; then
    echo "[SECURITY] OpenClaw gateway pid $pid no longer matches its captured start identity; refusing to poll or reap it" >&2
    return 2
  fi

  # kill -0 also succeeds for zombies. Only that exact matching zombie is
  # safe to reap. A live process, or a process whose state/identity cannot be
  # proven, must not send PID 1 into an unbounded wait on a recycled PID.
  if kill -0 "$pid" 2>/dev/null; then
    state="$(gateway_control_pid_state "$pid" 2>/dev/null || true)"
    case "$state" in
      Z*) [ "$current_start_identity" = "$expected_start_identity" ] || return 2 ;;
      *)
        if [ "${GATEWAY_CONTROL_SIGNAL_PENDING:-0}" -eq 1 ] \
          && openclaw_supervised_pid_is_live "$pid" "$expected_start_identity" \
          && gateway_pid_is_openclaw_gateway "$pid"; then
          return 3
        fi
        echo "[SECURITY] OpenClaw gateway pid $pid cannot be proven exited with its captured start identity; refusing to reap it" >&2
        return 2
        ;;
    esac
  fi

  wait "$pid" 2>/dev/null || rc=$?
  # USR1 may interrupt wait without reaping the exact tracked child. Leave its
  # identity intact so the authenticated request handler can stop it.
  if [ "${GATEWAY_CONTROL_SIGNAL_PENDING:-0}" -eq 1 ] \
    && openclaw_supervised_pid_is_live "$pid" "$expected_start_identity" \
    && gateway_pid_is_openclaw_gateway "$pid"; then
    return 3
  fi
  OPENCLAW_REAP_EXIT_STATUS="$rc"
  mark_openclaw_gateway_stopped
}

cleanup_openclaw_on_signal() {
  # Revalidate every PID immediately before the shared cleanup helper signals
  # it.  Clear the primary wait PID too if the tracked gateway identity has
  # disappeared or the numeric PID was recycled.
  if ! openclaw_supervised_pid_is_live \
    "${GATEWAY_PID:-}" "${GATEWAY_PID_START_IDENTITY:-}"; then
    SANDBOX_WAIT_PID=""
  fi
  refresh_openclaw_supervised_child_pids
  cleanup_on_signal
}

OPENCLAW_RESTART_FAILURE_CODE=internal
_OPENCLAW_CONFIG_GUARD=/usr/local/lib/nemoclaw/openclaw-config-guard.py
_OPENCLAW_STATE_DIR_GUARD=/usr/local/lib/nemoclaw/state-dir-guard.py
OPENCLAW_CONFIG_GUARD_LAST_OUTPUT=""
run_openclaw_config_guard() {
  local action="$1"
  local startup_owner=0
  local arg output_file rc
  shift
  for arg in "$@"; do
    [ "$arg" = "--startup-owner" ] && startup_owner=1
  done
  if [ "$startup_owner" -eq 1 ]; then
    # The readiness contract authenticates this helper as a direct PID 1
    # child. A `timeout` wrapper or command substitution would become Python's
    # parent and invalidate that identity, so capture through a root-private
    # file while invoking Python directly.
    install -d -o root -g root -m 700 /run/nemoclaw || return 1
    output_file="/run/nemoclaw/.openclaw-config-guard.$$.output"
    : >"$output_file"
    chmod 600 "$output_file"
    rc=0
    python3 -I "$_OPENCLAW_CONFIG_GUARD" "$action" \
      --config-dir /sandbox/.openclaw "$@" >"$output_file" 2>&1 || rc=$?
    OPENCLAW_CONFIG_GUARD_LAST_OUTPUT="$(<"$output_file")"
    rm -f "$output_file"
    if [ "$rc" -ne 0 ]; then
      printf '[config-guard] %s failed: %s\n' "$action" "$OPENCLAW_CONFIG_GUARD_LAST_OUTPUT" >&2
      return "$rc"
    fi
    return 0
  fi
  OPENCLAW_CONFIG_GUARD_LAST_OUTPUT="$(
    timeout --signal=TERM --kill-after=5s 5m \
      python3 -I "$_OPENCLAW_CONFIG_GUARD" "$action" \
      --config-dir /sandbox/.openclaw "$@" 2>&1
  )" || {
    printf '[config-guard] %s failed: %s\n' "$action" "$OPENCLAW_CONFIG_GUARD_LAST_OUTPUT" >&2
    return 1
  }
}

restore_openclaw_restart_config() {
  run_openclaw_config_guard unseal-restart \
    || run_openclaw_config_guard recover
}

cleanup_openclaw_gateway_locks() {
  timeout --signal=TERM --kill-after=1s 5s python3 -I - <<'PYLOCKS'
import os
import re
import stat
import sys
import time

deadline = time.monotonic() + 3
parent_limit = 64
entry_limit = 10000
lock_limit = 128
lock_pattern = re.compile(r"gateway[.][^/]+[.]lock\Z")
directory_flags = (
    os.O_RDONLY
    | getattr(os, "O_DIRECTORY", 0)
    | getattr(os, "O_NOFOLLOW", 0)
    | getattr(os, "O_CLOEXEC", 0)
)
tmp_fd = os.open("/tmp", directory_flags)
tmp_stat = os.fstat(tmp_fd)
parents = 0
locks = 0
observed = 0
try:
    with os.scandir(tmp_fd) as entries:
        for entry in entries:
            observed += 1
            if observed > entry_limit or time.monotonic() > deadline:
                raise RuntimeError("bounded /tmp gateway-lock inventory exceeded")
            if not entry.name.startswith("openclaw-"):
                continue
            parents += 1
            if parents > parent_limit:
                raise RuntimeError("too many OpenClaw lock directories")
            parent_fd = os.open(entry.name, directory_flags, dir_fd=tmp_fd)
            try:
                parent_stat = os.fstat(parent_fd)
                if parent_stat.st_dev != tmp_stat.st_dev:
                    print(
                        f"[gateway] refusing cross-device lock directory: /tmp/{entry.name}",
                        file=sys.stderr,
                    )
                    continue
                child_observed = 0
                with os.scandir(parent_fd) as children:
                    for child in children:
                        child_observed += 1
                        if child_observed > entry_limit or time.monotonic() > deadline:
                            raise RuntimeError("bounded gateway-lock directory inventory exceeded")
                        if not lock_pattern.fullmatch(child.name):
                            continue
                        locks += 1
                        if locks > lock_limit:
                            raise RuntimeError("too many gateway lock entries")
                        metadata = os.stat(
                            child.name, dir_fd=parent_fd, follow_symlinks=False
                        )
                        if (
                            metadata.st_dev != parent_stat.st_dev
                            or not stat.S_ISREG(metadata.st_mode)
                        ):
                            print(
                                f"[gateway] refusing non-regular lock entry: /tmp/{entry.name}/{child.name}",
                                file=sys.stderr,
                            )
                            continue
                        os.unlink(child.name, dir_fd=parent_fd)
                os.fsync(parent_fd)
            finally:
                os.close(parent_fd)
finally:
    os.close(tmp_fd)
PYLOCKS
}

openclaw_runtime_guard_chain_complete() {
  local targets=(
    "$_SANDBOX_SAFETY_NET"
    "$_NEMOTRON_FIX_SCRIPT"
    "$_CIAO_GUARD_SCRIPT"
    "$_SECCOMP_GUARD_SCRIPT"
    "$_RUNTIME_SHELL_ENV_FILE"
  )
  local target
  [ "${NODE_USE_ENV_PROXY:-}" = "1" ] && targets+=("$_PROXY_FIX_SCRIPT")
  [ -f "$_WS_FIX_SOURCE" ] && targets+=("$_WS_FIX_SCRIPT")
  for target in "${targets[@]}"; do
    [ -f "$target" ] && [ ! -L "$target" ] || return 1
  done
}

restore_openclaw_runtime_guard_chain() {
  if ! openclaw_runtime_guard_chain_complete; then
    local _guard_warn="[gateway-recovery] WARNING: /tmp guard chain missing or unsafe - restoring library guards from packaged preloads (#2478/#2701)"
    echo "$_guard_warn" >&2
    echo "$_guard_warn" >>"${_NEMOCLAW_GATEWAY_LOG:-/tmp/gateway.log}" 2>/dev/null || true
  fi

  # Preserve startup ordering: immutable core preloads first, then the
  # manifest-declared messaging layer, then the shell environment that refers
  # to both. Permission validation is the final gate before any relaunch.
  install_core_runtime_preloads || return 1
  write_messaging_runtime_setup_plan || return 1
  install_messaging_runtime_preloads || return 1
  verify_messaging_runtime_secret_scans || return 1
  write_runtime_shell_env || return 1
  validate_nemoclaw_tmp_permissions || return 1
}

prepare_openclaw_automatic_respawn() {
  if restore_openclaw_runtime_guard_chain; then
    return 0
  fi
  echo "[gateway] CRITICAL: runtime guard restoration failed; refusing automatic respawn" >&2
  return 1
}

prepare_openclaw_gateway_restart() {
  OPENCLAW_RESTART_FAILURE_CODE=unsafe-config
  # Restart preflight is deliberately read-only. The gateway and sandbox code
  # may still hold descriptors into a mutable tree, so pathname recovery,
  # chmod/chown normalization, and placeholder rewrites here would be root
  # TOCTOU primitives. The descriptor guard validates the exact config/hash
  # pair and refuses incoherent or substituted paths; mutation belongs to a
  # serialized host config command before restart.
  run_openclaw_config_guard preflight-restart || return 1
  OPENCLAW_RESTART_FAILURE_CODE=preload-missing
  restore_openclaw_runtime_guard_chain || return 1
}

retire_openclaw_supervised_gateway() {
  local pid="$1"
  local expected_identity="$2"
  local reap_status=0

  # A recover request can arrive after the respawn loop has already reaped the
  # failed child and entered its backoff. Only the canonical stopped state may
  # bypass retirement; every nonzero tracked PID must still be stopped or
  # identity-safely reaped before a replacement is launched.
  [ "${GATEWAY_PID:-0}" = "$pid" ] \
    && [ "${GATEWAY_PID_START_IDENTITY:-}" = "$expected_identity" ] \
    || return 1
  if [ "$pid" = "0" ] \
    && [ -z "$expected_identity" ] \
    && [ -z "${SANDBOX_WAIT_PID:-}" ]; then
    return 0
  fi
  if openclaw_supervised_pid_is_live "$pid" "$expected_identity" \
    && stop_openclaw_supervised_gateway "$pid" "$expected_identity"; then
    return 0
  fi
  openclaw_reap_exited_gateway || reap_status=$?
  [ "$reap_status" -eq 0 ] \
    && [ "${GATEWAY_PID:-0}" = "0" ] \
    && [ -z "${GATEWAY_PID_START_IDENTITY:-}" ] \
    && [ -z "${SANDBOX_WAIT_PID:-}" ]
}

handle_openclaw_gateway_control_request() {
  gateway_control_take_request || return 1
  local old_pid="${GATEWAY_PID:-0}"
  local old_identity="${GATEWAY_PID_START_IDENTITY:-}"

  if [ "$GATEWAY_CONTROL_ACTION" = "probe" ]; then
    if ! run_openclaw_config_guard preflight-restart; then
      gateway_control_fail unsafe-config "$old_pid"
      return 1
    fi
    if ! openclaw_gateway_healthy "$old_pid" "$old_identity"; then
      gateway_control_fail health-timeout "$old_pid"
      return 1
    fi
    gateway_control_complete already-running "$old_pid" "$old_pid"
    return 0
  fi

  if [ "$GATEWAY_CONTROL_ACTION" = "recover" ] \
    && openclaw_gateway_healthy "$old_pid" "$old_identity"; then
    if ! run_openclaw_config_guard recover; then
      gateway_control_fail unsafe-config "$old_pid"
      return 1
    fi
    gateway_control_complete already-running "$old_pid" "$old_pid"
    return 0
  fi

  # Validate every mutable/security input while the currently healthy gateway
  # is still serving. Refusal must not turn a recoverable config error into an
  # outage.
  if ! prepare_openclaw_gateway_restart; then
    gateway_control_fail "$OPENCLAW_RESTART_FAILURE_CODE" "$old_pid"
    return 1
  fi

  # Seal while the old healthy gateway is still serving. This fresh-replaces
  # the canonical config/hash pair and revokes old writable descriptors before
  # any outage is introduced. The journal records whether the original posture
  # was mutable or shields-locked so unseal restores it exactly.
  if ! run_openclaw_config_guard seal-restart; then
    if ! restore_openclaw_restart_config; then
      echo "[SECURITY] OpenClaw restart seal failed and deterministic recovery also failed; stopping the old gateway to revoke stale config descriptors" >&2
      stop_openclaw_gateway_fail_closed
    fi
    gateway_control_fail unsafe-config "$old_pid"
    return 1
  fi

  if ! retire_openclaw_supervised_gateway "$old_pid" "$old_identity"; then
    restore_openclaw_restart_config || true
    gateway_control_fail internal "$old_pid"
    return 1
  fi
  mark_openclaw_gateway_stopped
  cleanup_openclaw_gateway_locks \
    || echo "[gateway] warning: bounded stale gateway-lock cleanup was incomplete" >&2

  if ! launch_openclaw_gateway; then
    stop_openclaw_gateway_fail_closed
    restore_openclaw_restart_config || true
    gateway_control_fail health-timeout "$old_pid"
    return 1
  fi
  # Register the replacement before its bounded health wait. A container stop
  # in this window must signal the new child, never the already-reaped old PID.
  refresh_openclaw_supervised_child_pids
  if ! wait_for_openclaw_gateway_internal \
    "$GATEWAY_PID" "$GATEWAY_PID_START_IDENTITY"; then
    stop_openclaw_gateway_fail_closed
    restore_openclaw_restart_config || true
    gateway_control_fail health-timeout "$old_pid"
    return 1
  fi

  if ! restore_openclaw_restart_config; then
    # The replacement is healthy and the canonical pair remains fail-closed,
    # but the original mutable/locked posture could not be restored. Keep the
    # service running and make the host operation fail loudly for recovery.
    refresh_openclaw_supervised_child_pids
    gateway_control_fail unsafe-config "$old_pid"
    return 1
  fi

  # PLUGIN_REFRESH_PID remains set after its best-effort background job exits.
  # Never signal that potentially stale PID during a later gateway restart:
  # PID reuse could otherwise terminate an unrelated process. A still-running
  # prior refresh is harmless and will exit on its own.
  start_plugin_registry_refresh
  refresh_openclaw_supervised_child_pids
  gateway_control_complete ok "$old_pid" "$GATEWAY_PID"
}

# ── Main ─────────────────────────────────────────────────────────

# Begin the root PID 1 readiness lease before any startup path reads or mutates
# OpenClaw config. Recovery runs before the locked-parent discriminator so a
# crash in a prior config write/restart/handoff can complete deterministically.
if [ "$(id -u)" -eq 0 ]; then
  prepare_openclaw_config_startup || exit 1
fi

# A root-owned config directory is the shields-up discriminator. Its parent
# must be sticky and root-owned too; otherwise the sandbox identity can rename
# the entire `.openclaw` entry and replace the pathname with mutable content.
# Refuse before migration or any config read. PID 1 cannot repair this posture
# after startup has failed, so recovery requires a trusted snapshot/recreate.
if [ "$(openclaw_config_dir_owner /sandbox/.openclaw)" = "root" ] \
  && ! openclaw_locked_parent_is_protected; then
  echo "[SECURITY] OPENCLAW_LOCKED_PARENT_UNPROTECTED: /sandbox must be root:sandbox 1775 while OpenClaw shields are up; restore from a trusted backup and recreate the sandbox" >&2
  exit 1
fi

# Migrate legacy symlink layout before anything else reads .openclaw
migrate_legacy_layout "/sandbox/.openclaw" "/sandbox/.openclaw-data" "openclaw" || exit 1

echo 'Setting up NemoClaw...' >&2
# Best-effort: .env may not exist.
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
  # Empty-config recovery runs before integrity check so a #3118 truncation
  # (openshell inference set inside the sandbox) is restored from baseline
  # rather than failing the integrity hash for the empty file.
  recover_openclaw_config_if_empty
  if ! verify_config_integrity_if_locked /sandbox/.openclaw; then
    echo "[SECURITY] Config integrity check failed — refusing to start (non-root mode)" >&2
    exit 1
  fi
  normalize_mutable_config_perms
  apply_model_override
  reconcile_agent_model_with_provider
  apply_cors_override
  refresh_openclaw_provider_placeholders
  ensure_mutable_openclaw_config_hash
  prepare_gateway_token_for_current_command
  # Capture baseline for next start's recovery — only after overrides and
  # placeholder refresh have produced the post-startup config the user
  # actually runs with.
  write_openclaw_config_baseline
  export_gateway_token
  write_messaging_runtime_setup_plan
  write_runtime_shell_env
  ensure_runtime_shell_env_shim
  lock_rc_files "$_SANDBOX_HOME" || true
  # Apply manifest-declared runtime env aliases before any child inherits the
  # env. This covers both one-shot commands and the gateway launch.
  apply_messaging_runtime_env_aliases

  if [ ${#NEMOCLAW_CMD[@]} -gt 0 ]; then
    install_messaging_runtime_preloads
    verify_messaging_runtime_secret_scans
    _nemoclaw_cmd_rc=0
    run_oneshot_command "${NEMOCLAW_CMD[@]}" || _nemoclaw_cmd_rc=$?
    exit "$_nemoclaw_cmd_rc"
  fi

  configure_messaging_channels
  refresh_openclaw_provider_placeholders
  ensure_mutable_openclaw_config_hash
  write_openclaw_config_baseline
  install_messaging_runtime_preloads
  verify_messaging_runtime_secret_scans

  # Ensure writable state directories exist and are owned by the current user.
  # The Docker build (Dockerfile) sets this up correctly, but the native curl
  # installer may create these directories as root, causing EACCES when openclaw
  # tries to write device-auth.json or other state files.  Ref: #692
  fix_openclaw_ownership() {
    local openclaw_dir="${HOME}/.openclaw"
    [ -d "$openclaw_dir" ] || return 0
    local subdirs="agents/main/agent extensions workspace skills hooks identity devices canvas cron memory logs credentials flows sandbox telegram media"
    for sub in $subdirs; do
      mkdir -p "${openclaw_dir}/${sub}" 2>/dev/null || true
    done
    if find "$openclaw_dir" ! -uid "$(id -u)" -print -quit 2>/dev/null | grep -q .; then
      chown -R "$(id -u):$(id -g)" "$openclaw_dir" 2>/dev/null \
        && echo "[setup] fixed ownership on ${openclaw_dir}" >&2 \
        || echo "[setup] could not fix ownership on ${openclaw_dir}; writes may fail" >&2
    fi
    chmod 2770 "$openclaw_dir" 2>/dev/null || true
    chmod 660 "$openclaw_dir/openclaw.json" "$openclaw_dir/.config-hash" 2>/dev/null || true
  }
  fix_openclaw_ownership
  normalize_mutable_config_perms
  seed_default_workspace_templates /sandbox/.openclaw/workspace "" /sandbox/.openclaw/openclaw.json
  write_auth_profile
  harden_auth_profiles

  # In non-root mode, detach gateway stdout/stderr from the sandbox-create
  # stream so openshell sandbox create can return once the container is ready.
  _nemoclaw_safe_create_tmp_file /tmp/gateway.log 644

  # Separate log for auto-pair in non-root mode as well.
  _nemoclaw_safe_create_tmp_file /tmp/auto-pair.log 600

  prepare_plugin_refresh_log || exit 1

  # Defence-in-depth: verify /tmp file permissions before launching services.
  # Pass the HTTP proxy-fix path so it is validated alongside proxy-env.sh
  # (both are trust-boundary files; tampering would let the sandbox user
  # inject code into any Node process via NODE_OPTIONS).
  validate_nemoclaw_tmp_permissions

  # Start gateway in background, auto-pair, then wait. Mark the in-container
  # gateway path so the Docker HEALTHCHECK probes it rather than short-circuiting
  # to healthy — see the mark_in_container_gateway comment near the top of this
  # file for the #4710 rationale (why the marker is tied to the launch site
  # rather than an env-var conditional at startup).
  mark_in_container_gateway
  nohup "$OPENCLAW" gateway run --port "${_DASHBOARD_PORT}" >/tmp/gateway.log 2>&1 &
  GATEWAY_PID=$!
  capture_openclaw_pid_start_identity "$GATEWAY_PID" GATEWAY_PID_START_IDENTITY || exit 1
  record_gateway_pid "$GATEWAY_PID" "$GATEWAY_PID_START_IDENTITY"
  echo "[gateway] openclaw gateway launched (pid $GATEWAY_PID)" >&2
  # Diagnostic: mirror gateway log to PID 1's stderr — see root-mode block
  # below for rationale (NVIDIA/NemoClaw#2484).
  { tail -n +1 -F /tmp/gateway.log 2>/dev/null | sed -u 's/^/[gateway-log:] /' >&2; } &
  GATEWAY_LOG_TAIL_PID=$!
  capture_openclaw_pid_start_identity \
    "$GATEWAY_LOG_TAIL_PID" GATEWAY_LOG_TAIL_PID_START_IDENTITY || exit 1
  # Persistent mirror: see root-mode block for rationale.
  start_persistent_gateway_log_mirror || exit 1
  start_auto_pair
  start_plugin_registry_refresh
  start_gateway_serving_watchdog
  # NOTE: PIDs are collected after launch; a signal arriving between trap
  # registration and the final append is a small race window (same as before
  # the shared-library refactor). Acceptable for entrypoint-level cleanup.
  refresh_openclaw_supervised_child_pids
  # shellcheck disable=SC2034  # read by cleanup_on_signal from sandbox-init.sh
  SANDBOX_WAIT_PID="$GATEWAY_PID"
  trap cleanup_openclaw_on_signal SIGTERM SIGINT
  print_dashboard_urls

  # Auto-respawn gateway on unexpected death (NVIDIA/NemoClaw#2757). Without
  # this loop, gateway death unblocks `wait` → PID 1 exits → Docker reaps the
  # whole sandbox container, forcing users to run `nemoclaw connect` to recover.
  # RESPAWN_TIMES is a true sliding 60s window of crash timestamps; entries
  # older than the cutoff are pruned each iteration so bursts spanning a
  # window boundary still trigger the >=5 alarm.
  RESPAWN_TIMES=()
  while :; do
    # `wait` must be guarded with `|| RC=$?` because errexit (set -e on
    # line 33) would otherwise exit PID 1 the instant the gateway returns
    # non-zero, defeating the respawn loop entirely.
    RC=0
    EXITED_GATEWAY_PID="$GATEWAY_PID"
    EXITED_GATEWAY_START_IDENTITY="$GATEWAY_PID_START_IDENTITY"
    wait "$EXITED_GATEWAY_PID" || RC=$?
    mark_openclaw_gateway_stopped
    if [ "$RC" -eq 0 ] \
      && ! consume_gateway_watchdog_kill "${EXITED_GATEWAY_PID}:${EXITED_GATEWAY_START_IDENTITY}"; then
      exit 0
    fi
    NOW=$(date +%s)
    RESPAWN_TIMES+=("$NOW")
    _PRUNED=()
    for _t in "${RESPAWN_TIMES[@]+"${RESPAWN_TIMES[@]}"}"; do
      [ $((NOW - _t)) -le 60 ] && _PRUNED+=("$_t")
    done
    RESPAWN_TIMES=("${_PRUNED[@]+"${_PRUNED[@]}"}")
    RESPAWN_COUNT=${#RESPAWN_TIMES[@]}
    if [ "$RESPAWN_COUNT" -ge 5 ]; then
      echo "[gateway] CRITICAL: $RESPAWN_COUNT respawns in 60s window — gateway likely unstable; check /tmp/gateway.log" >&2
    fi
    echo "[gateway] pid $EXITED_GATEWAY_PID exited (rc=$RC); respawning (#$RESPAWN_COUNT in 60s window) in 2s" >&2
    sleep 2
    prepare_openclaw_automatic_respawn || exit 1
    nohup "$OPENCLAW" gateway run --port "${_DASHBOARD_PORT}" >>/tmp/gateway.log 2>&1 &
    GATEWAY_PID=$!
    capture_openclaw_pid_start_identity "$GATEWAY_PID" GATEWAY_PID_START_IDENTITY || exit 1
    record_gateway_pid "$GATEWAY_PID" "$GATEWAY_PID_START_IDENTITY"
    # shellcheck disable=SC2034  # read by cleanup_on_signal from sandbox-init.sh
    SANDBOX_WAIT_PID="$GATEWAY_PID"
    refresh_openclaw_supervised_child_pids
    echo "[gateway] respawned (pid $GATEWAY_PID)" >&2
  done
fi

# ── Root path (full privilege separation via setpriv) ──────────

# Empty-config recovery runs before integrity check so a #3118 truncation
# (openshell inference set inside the sandbox) is restored from baseline
# rather than failing the integrity hash for the empty file.
recover_openclaw_config_if_empty
# Verify locked config integrity before starting anything. Mutable-default
# config is intentionally writable and is not a trust anchor until shields-up.
verify_config_integrity_if_locked /sandbox/.openclaw
normalize_mutable_config_perms
apply_model_override
reconcile_agent_model_with_provider
apply_cors_override
configure_messaging_channels
refresh_openclaw_provider_placeholders
ensure_mutable_openclaw_config_hash
prepare_gateway_token_for_current_command
# Capture baseline for next start's recovery — only after overrides and
# placeholder refresh have produced the post-startup config the user
# actually runs with.
write_openclaw_config_baseline
export_gateway_token
write_messaging_runtime_setup_plan
write_runtime_shell_env
ensure_runtime_shell_env_shim
lock_rc_files "$_SANDBOX_HOME"
# Apply manifest-declared runtime env aliases before any child (the one-shot
# "${NEMOCLAW_CMD[@]}" exec or the stepped-down gateway) inherits the env.
# gosu/setpriv preserve the environment, so the export reaches the gateway user.
apply_messaging_runtime_env_aliases

# Messaging channel config was announced before placeholder refresh so the
# baseline captures the same provider placeholders the gateway will use.
# Install manifest-declared Node runtime preloads before starting OpenClaw.
install_messaging_runtime_preloads
verify_messaging_runtime_secret_scans

# Write auth profile as sandbox user and recursively re-tighten any
# auth-profiles.json files under ~/.openclaw. See
# setup_auth_profile_as_sandbox for the HOME-handling rationale.
setup_auth_profile_as_sandbox

# If a command was passed (e.g., "openclaw agent ..."), run it as sandbox user
if [ ${#NEMOCLAW_CMD[@]} -gt 0 ]; then
  _nemoclaw_cmd_rc=0
  run_oneshot_command "${STEP_DOWN_PREFIX_SANDBOX[@]}" "${NEMOCLAW_CMD[@]}" || _nemoclaw_cmd_rc=$?
  exit "$_nemoclaw_cmd_rc"
fi

# Gateway log: owned by gateway user, world-readable for diagnostics.
# The sandbox user can read but not truncate/overwrite (not owner, sticky /tmp).
_nemoclaw_safe_create_tmp_file /tmp/gateway.log 644 gateway:gateway

# Separate log for auto-pair so sandbox user can write to it
_nemoclaw_safe_create_tmp_file /tmp/auto-pair.log 600 sandbox:sandbox

prepare_plugin_refresh_log || exit 1

# Provision per-agent workspaces for multi-agent OpenClaw deployments.
#
# OpenClaw can be configured with multiple named agents (agents.defaults.workspace
# + agents.list[*].workspace in openclaw.json), each producing its own
# `/sandbox/.openclaw/workspace-<name>/` directory. In the mutable-by-default
# layout these live directly under `.openclaw/` (no symlink indirection).
# Ensure they exist and are sandbox-writable.
#
# Ref: https://github.com/NVIDIA/NemoClaw/issues/1260
provision_agent_workspaces() {
  local config_dir="/sandbox/.openclaw"
  local names=""
  local d name config_names

  # Discover existing workspace-* dirs.
  if [ -d "$config_dir" ]; then
    for d in "$config_dir"/workspace-*; do
      [ -e "$d" ] || [ -L "$d" ] || continue
      if [ -L "$d" ]; then
        echo "[SECURITY] refusing symlinked workspace dir: $d" >&2
        continue
      fi
      [ -d "$d" ] || continue
      name="$(basename "$d")"
      names="${names} ${name}"
    done
  fi

  # Also provision workspace directories declared in openclaw.json. On first
  # boot these may not exist yet, so directory discovery alone is insufficient.
  if [ -f "$config_dir/openclaw.json" ] && command -v node >/dev/null 2>&1; then
    config_names="$(
      node - "$config_dir/openclaw.json" <<'NODE' 2>/dev/null || true
  const fs = require("fs");
  const configPath = process.argv[2];
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const names = new Set();
  const workspacePattern = /^workspace-[A-Za-z0-9._-]+$/;
  function addWorkspace(value) {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed) return;
    if (trimmed.startsWith("/sandbox/.openclaw/")) {
      const relative = trimmed.slice("/sandbox/.openclaw/".length);
      if (workspacePattern.test(relative)) names.add(relative);
      return;
    }
    if (/^[A-Za-z0-9._-]+$/.test(trimmed)) {
      const name = trimmed.startsWith("workspace-") ? trimmed : `workspace-${trimmed}`;
      if (workspacePattern.test(name)) names.add(name);
    }
  }
  addWorkspace(cfg?.agents?.defaults?.workspace);
  for (const agent of cfg?.agents?.list || []) addWorkspace(agent?.workspace);
  for (const name of names) console.log(name);
NODE
    )"
    if [ -n "$config_names" ]; then
      names="$({
        for name in $names; do
          printf '%s\n' "$name"
        done
        printf '%s\n' "$config_names"
      } | awk 'NF && !seen[$0]++' | tr '\n' ' ')"
    fi
  fi

  for name in $names; do
    local ws_path="$config_dir/$name"
    if [ -L "$ws_path" ]; then
      echo "[SECURITY] refusing to provision symlinked workspace path: $ws_path" >&2
      continue
    fi
    mkdir -p "$ws_path"
    chown_tree_no_symlink_follow sandbox:sandbox "$ws_path"
    echo "[setup] provisioned multi-agent workspace: $name" >&2
  done
}
provision_agent_workspaces

# Seed default workspace templates if the default workspace is empty.
# Run as the sandbox user so the seeded files inherit sandbox:sandbox
# ownership (the function's own cp calls would otherwise produce
# root-owned files in this branch). See function comment for context.
seed_default_workspace_templates_as_sandbox

# Defence-in-depth: verify /tmp file permissions before launching services.
# Pass the HTTP proxy-fix path so it is validated alongside proxy-env.sh
# (both are trust-boundary files; tampering would let the sandbox user
# inject code into any Node process via NODE_OPTIONS).
validate_nemoclaw_tmp_permissions

# Start the gateway as the 'gateway' user.
# SECURITY: The sandbox user cannot kill this process because it runs
# under a different UID. The fake-HOME attack no longer works because
# the agent cannot restart the gateway with a tampered config.
# Marking, privilege step-down, log redirection, and PID recording are kept in
# one reusable launch primitive so PID 1 owns initial start, crash respawn, and
# host-requested restart identically.
launch_openclaw_gateway

# Diagnostic: mirror gateway log to PID 1's stderr so its content surfaces in
# docker logs. /tmp/gateway.log is otherwise only readable from inside the
# sandbox via `nemoclaw <sandbox> logs` and is not captured by the e2e test
# framework on failure. Streaming it to PID 1's stderr lets a workflow-level
# `docker logs` capture pick it up. Each line is prefixed with [gateway-log:]
# so it can be filtered out post-hoc when not investigating.
# Ref: NVIDIA/NemoClaw#2484 (TC-SBX-02 hang investigation)
{ tail -n +1 -F /tmp/gateway.log 2>/dev/null | sed -u 's/^/[gateway-log:] /' >&2; } &
GATEWAY_LOG_TAIL_PID=$!
capture_openclaw_pid_start_identity \
  "$GATEWAY_LOG_TAIL_PID" GATEWAY_LOG_TAIL_PID_START_IDENTITY || exit 1

# Persistent mirror: append /tmp/gateway.log content to a file under
# /sandbox/.openclaw/logs which is volume-mounted by openshell and
# survives pod restarts. /tmp/gateway.log itself is wiped when the pod
# restarts (TC-SBX-06 docker-kills the gateway container), so the
# only durable record of pre-restart events lives here. The diag
# streamer in the e2e workflow snapshots this file post-test.
start_persistent_gateway_log_mirror || exit 1

start_auto_pair

# Re-register non-bundled plugins after the gateway's first policy-changed
# regen. Under GPU sandbox onboard, OpenClaw rebuilds plugins[] from bundled
# extensions only and drops path/npm-origin entries like the NemoClaw plugin
# and the WeChat plugin. Their installRecords survive on disk, but the runtime
# registry forgets them — so `/nemoclaw` is unreachable in the TUI and
# `openclaw plugins inspect nemoclaw` says "Plugin not found" (#2021).
# A `plugins registry --refresh` repopulates plugins[] from installRecords.
# Backgrounded so the gateway-wait loop is unblocked; failure is non-fatal.
# Source boundary: the lossy policy-changed rebuild lives in OpenClaw's registry
# regeneration path, outside NemoClaw. NemoClaw can only heal the initial
# post-start registry from persisted installRecords until upstream preserves
# path/npm-origin plugins itself. Later runtime policy mutations are owned by
# OpenClaw's upstream fix, not by this one-shot startup workaround. Remove this
# workaround after openclaw/openclaw#89606 ships and the full onboard E2E still
# proves /nemoclaw registration without the refresh.
start_plugin_registry_refresh

start_gateway_serving_watchdog

# NOTE: PIDs are collected after launch; a signal arriving between trap
# registration and the final append is a small race window (same as before
# the shared-library refactor). Acceptable for entrypoint-level cleanup.
refresh_openclaw_supervised_child_pids
# shellcheck disable=SC2034  # read by cleanup_on_signal from sandbox-init.sh
SANDBOX_WAIT_PID="$GATEWAY_PID"
trap cleanup_openclaw_on_signal SIGTERM SIGINT
if ! gateway_control_init; then
  echo "[gateway-control] privileged gateway control unavailable" >&2
fi
if ! run_openclaw_config_guard publish-startup-ready --startup-owner; then
  echo "[SECURITY] OpenClaw config readiness lease could not be published; refusing to keep the gateway running" >&2
  stop_openclaw_supervised_gateway \
    "${GATEWAY_PID:-0}" "${GATEWAY_PID_START_IDENTITY:-}" || true
  exit 1
fi
print_dashboard_urls

# Keep container running by waiting on the gateway process.
# This script is PID 1 (ENTRYPOINT); if it exits, Docker kills all children.
# Auto-respawn gateway on unexpected death (NVIDIA/NemoClaw#2757). Without
# this loop, gateway death unblocks `wait` → PID 1 exits → Docker reaps the
# whole sandbox container, forcing users to run `nemoclaw connect` to recover.
# RESPAWN_TIMES is a true sliding 60s window of crash timestamps; entries
# older than the cutoff are pruned each iteration so bursts spanning a
# window boundary still trigger the >=5 alarm.
RESPAWN_TIMES=()
while :; do
  # Poll the tracked child instead of entering an unbounded wait immediately.
  # A USR1 that lands just before `wait` would otherwise set the trap flag and
  # then leave PID 1 blocked forever because there is no second signal to
  # interrupt that wait.
  while openclaw_supervised_pid_is_live \
    "$GATEWAY_PID" "$GATEWAY_PID_START_IDENTITY" \
    && [ "$GATEWAY_CONTROL_SIGNAL_PENDING" -eq 0 ]; do
    sleep 1 || true
  done
  if [ "$GATEWAY_CONTROL_SIGNAL_PENDING" -eq 1 ]; then
    handle_openclaw_gateway_control_request || true
    continue
  fi

  EXITED_GATEWAY_PID="$GATEWAY_PID"
  EXITED_GATEWAY_START_IDENTITY="$GATEWAY_PID_START_IDENTITY"
  REAP_STATUS=0
  openclaw_reap_exited_gateway || REAP_STATUS=$?
  if [ "$REAP_STATUS" -eq 3 ]; then
    handle_openclaw_gateway_control_request || true
    continue
  fi
  if [ "$REAP_STATUS" -ne 0 ]; then
    exit 1
  fi
  RC="$OPENCLAW_REAP_EXIT_STATUS"
  if [ "$GATEWAY_CONTROL_SIGNAL_PENDING" -eq 1 ]; then
    handle_openclaw_gateway_control_request || true
    continue
  fi
  if [ "$RC" -eq 0 ] \
    && ! consume_gateway_watchdog_kill "${EXITED_GATEWAY_PID}:${EXITED_GATEWAY_START_IDENTITY}"; then
    exit 0
  fi
  NOW=$(date +%s)
  RESPAWN_TIMES+=("$NOW")
  _PRUNED=()
  for _t in "${RESPAWN_TIMES[@]+"${RESPAWN_TIMES[@]}"}"; do
    [ $((NOW - _t)) -le 60 ] && _PRUNED+=("$_t")
  done
  RESPAWN_TIMES=("${_PRUNED[@]+"${_PRUNED[@]}"}")
  RESPAWN_COUNT=${#RESPAWN_TIMES[@]}
  if [ "$RESPAWN_COUNT" -ge 5 ]; then
    echo "[gateway] CRITICAL: $RESPAWN_COUNT respawns in 60s window — gateway likely unstable; check /tmp/gateway.log" >&2
  fi
  echo "[gateway] pid $EXITED_GATEWAY_PID exited (rc=$RC); respawning (#$RESPAWN_COUNT in 60s window) in 2s" >&2
  sleep 2 || true
  # A host request can arrive during the crash backoff. Service it before the
  # automatic relaunch so PID 1 never launches an untracked extra gateway and
  # immediately replaces it again.
  if [ "$GATEWAY_CONTROL_SIGNAL_PENDING" -eq 1 ]; then
    handle_openclaw_gateway_control_request || true
    continue
  fi
  prepare_openclaw_automatic_respawn || exit 1
  launch_openclaw_gateway
  refresh_openclaw_supervised_child_pids
  echo "[gateway] respawned (pid $GATEWAY_PID)" >&2
done
