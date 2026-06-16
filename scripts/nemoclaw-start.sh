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
# the script crashes before touch /tmp/gateway.log (e.g., a Landlock
# read failure), the output is still available for diagnostics.
# The log is written in append mode and also forwarded to the original
# stderr/stdout via tee so openshell sandbox create can still stream it.
# SECURITY: restrict permissions before writing — startup diagnostics may
# include dashboard URLs, but auth tokens must stay redacted in logs.
_START_LOG="/tmp/nemoclaw-start.log"
if [ "$(id -u)" -eq 0 ]; then
  : >"$_START_LOG"
  chown root:root "$_START_LOG"
  chmod 600 "$_START_LOG"
else
  : >"$_START_LOG"
  chmod 600 "$_START_LOG" 2>/dev/null || true
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
# Best-effort: a write failure must never block startup.
mark_in_container_gateway() {
  : >/tmp/nemoclaw-gateway-local 2>/dev/null || true
}

# Record the PID of the live in-container gateway so the Docker HEALTHCHECK
# can confirm the actual gateway process (not merely *some* `openclaw`
# process) is still alive when the in-container curl probe cannot reach the
# dashboard port (#4952). Refreshed on every (re)launch so a respawned gateway
# is tracked and a window where the gateway is down reads as unhealthy.
# Best-effort: a write failure must never block startup.
record_gateway_pid() {
  printf '%s\n' "${1:-}" >/tmp/nemoclaw-gateway.pid 2>/dev/null || true
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
# Keep the recovery baseline outside the mutable group-write contract. It is
# readable by the sandbox group for restore, but only root should rewrite it.
lock_openclaw_config_baseline_if_present() {
  local config_dir="${1:-/sandbox/.openclaw}"
  local baseline_file="$config_dir/openclaw.json.nemoclaw-baseline"

  [ -f "$baseline_file" ] || return 0
  [ "$(id -u)" -eq 0 ] || return 0

  if [ -L "$config_dir" ] || [ -L "$baseline_file" ]; then
    return 0
  fi

  if ! chown root:sandbox "$baseline_file"; then
    printf '[SECURITY] Failed to set ownership on %s\n' "$baseline_file" >&2
    return 1
  fi
  if ! chmod 0440 "$baseline_file"; then
    printf '[SECURITY] Failed to set permissions on %s\n' "$baseline_file" >&2
    return 1
  fi
}

# Idempotent. Skips when shields are UP (config dir owned by root) so
# the lock is not weakened.
#
# This also self-heals a sandbox whose mutable config tree was tightened to
# single-user 700/600 by `openclaw doctor --fix` (#4538): every (re)start
# restores the setgid + group-writable contract. Host-side, `nemoclaw <name>
# doctor --fix` and the rebuild post-upgrade repair step apply the same
# normalization without requiring a restart.
normalize_mutable_config_perms() {
  local config_dir="/sandbox/.openclaw"
  [ -d "$config_dir" ] || return 0

  # Detect shields-up. Config dir owned by root means shields are
  # currently locked; normalizing would weaken the contract.
  local config_dir_owner
  config_dir_owner="$(stat -c '%U' "$config_dir" 2>/dev/null || stat -f '%Su' "$config_dir" 2>/dev/null || echo unknown)"
  if [ "$config_dir_owner" = "root" ]; then
    return 0
  fi

  chmod -R g+rwX,o-rwx "$config_dir" 2>/dev/null || true
  find "$config_dir" -type d -exec chmod g+s {} + 2>/dev/null || true
  chmod 2770 "$config_dir" 2>/dev/null || true
  chmod 660 "$config_dir/openclaw.json" "$config_dir/.config-hash" 2>/dev/null || true
  lock_openclaw_config_baseline_if_present "$config_dir" || return 1
}

openclaw_config_dir_owner() {
  local config_dir="$1"
  stat -c '%U' "$config_dir" 2>/dev/null || stat -f '%Su' "$config_dir" 2>/dev/null || echo unknown
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

# Capture a known-good copy of openclaw.json for later restore. Idempotent:
# only writes the baseline once. Runs at root after apply_model_override and
# apply_cors_override so the baseline reflects the post-override config that
# the user actually started with. Refuses to capture broken state (empty,
# whitespace-only, or unparseable input).
write_openclaw_config_baseline() {
  local config_dir="/sandbox/.openclaw"
  local config_file="$config_dir/openclaw.json"
  local baseline_file="$config_dir/openclaw.json.nemoclaw-baseline"

  [ -d "$config_dir" ] || return 0
  [ -f "$config_file" ] || return 0
  [ "$(id -u)" -eq 0 ] || return 0

  # Refuse to act through symlinks (mirrors apply_model_override's stance).
  if [ -L "$config_dir" ] || [ -L "$config_file" ] || [ -L "$baseline_file" ]; then
    return 0
  fi

  # Idempotent — only capture once per sandbox. Still re-lock an existing
  # baseline because mutable permission normalization is intentionally broad.
  if [ -f "$baseline_file" ]; then
    lock_openclaw_config_baseline_if_present "$config_dir"
    return $?
  fi

  # Skip in shields-up mode — config is supposed to be locked, baseline
  # capture is unnecessary and the prepare/restore permission dance is
  # already owned by the override paths.
  if [ "$(openclaw_config_dir_owner "$config_dir")" = "root" ]; then
    return 0
  fi

  # Refuse to capture broken state. grep -q '[^[:space:]]' is false for both
  # 0-byte and whitespace-only files.
  if ! grep -q '[^[:space:]]' "$config_file" 2>/dev/null; then
    return 0
  fi

  # Refuse to capture content that doesn't parse as JSON5 — keeps the
  # baseline a known-good restore target. openclaw.json is JSON5 (comments,
  # trailing commas) everywhere else in the stack — OpenClaw uses
  # JSON5.parse / parseJsonWithJson5Fallback, and migration-state.ts uses
  # JSON5.parse — so use the real JSON5 parser instead of approximating the
  # grammar with regexes.
  local _json5_rc=0
  node - "$config_file" <<'NODE_VALIDATE' || _json5_rc=$?
  const fs = require("fs");

  const configPath = process.argv[2];

  // The entrypoint runs this validator as root. Only load the parser from the
  // packaged plugin tree, never from sandbox-writable cwd or npm global roots.
  const candidates = ["/opt/nemoclaw/node_modules/json5"];

  const attempted = [];
  let JSON5;
  for (const candidate of [...new Set(candidates)]) {
    try {
      JSON5 = require(candidate);
      if (JSON5 && typeof JSON5.parse === "function") {
        break;
      }
      attempted.push(`${candidate}: missing parse()`);
      JSON5 = undefined;
    } catch {
      attempted.push(candidate);
    }
  }

  if (!JSON5) {
    console.error(
      `[config] ERROR: unable to load JSON5 parser for baseline validation. Tried: ${
        attempted.length ? attempted.join(", ") : "(no candidate module paths found)"
      }`,
    );
    process.exit(2);
  }

  try {
    JSON5.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    process.exit(3);
  }
NODE_VALIDATE
  case "$_json5_rc" in
    0) ;;
    3) return 0 ;;
    *)
      printf '[config] ERROR: JSON5 baseline validator failed for %s\n' "$config_file" >&2
      return 1
      ;;
  esac

  if ! cp "$config_file" "$baseline_file" 2>/dev/null; then
    return 0
  fi
  # 0440 root:sandbox so the gateway/sandbox user can READ for recovery but
  # cannot truncate or rewrite the baseline through the same path that
  # corrupts the active config.
  lock_openclaw_config_baseline_if_present "$config_dir" || return 1
  printf '[config] Baseline snapshot created: %s\n' "$baseline_file" >&2
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
  local hash_file="$config_dir/.config-hash"
  local baseline_file="$config_dir/openclaw.json.nemoclaw-baseline"
  local last_good_file="$config_dir/openclaw.json.last-good"

  [ -d "$config_dir" ] || return 0
  [ -f "$config_file" ] || return 0

  # Refuse to act through symlinks.
  if [ -L "$config_dir" ] || [ -L "$config_file" ] || [ -L "$hash_file" ]; then
    return 0
  fi

  # Skip in shields-up mode — see header comment.
  if [ "$(openclaw_config_dir_owner "$config_dir")" = "root" ]; then
    return 0
  fi

  # Active file is non-empty → no-op.
  if grep -q '[^[:space:]]' "$config_file" 2>/dev/null; then
    return 0
  fi

  local source=""
  if [ -f "$last_good_file" ] && [ ! -L "$last_good_file" ] \
    && grep -q '[^[:space:]]' "$last_good_file" 2>/dev/null; then
    source="$last_good_file"
  elif [ -f "$baseline_file" ] && [ ! -L "$baseline_file" ] \
    && grep -q '[^[:space:]]' "$baseline_file" 2>/dev/null; then
    source="$baseline_file"
  fi

  # Recovery failures must be loud, not silent. In mutable-default mode the
  # downstream verify_config_integrity_if_locked is intentionally a no-op,
  # so a soft-fail here would let startup continue with an empty (or
  # restored-but-unhashed) config and crash much later in a less obvious
  # place. Return non-zero so `set -e` aborts startup with the diagnostic
  # already on stderr.
  if [ -z "$source" ]; then
    printf '[config] ERROR: openclaw.json is empty (%s). No baseline available; restart cannot recover. See issue #3118.\n' "$config_file" >&2
    return 1
  fi

  if ! cp "$source" "$config_file" 2>/dev/null; then
    printf '[config] ERROR: Failed to restore openclaw.json from %s (see #3118)\n' "$source" >&2
    return 1
  fi
  chown sandbox:sandbox "$config_file" 2>/dev/null || true
  chmod 660 "$config_file" 2>/dev/null || true

  if (cd "$config_dir" && sha256sum openclaw.json >".config-hash") 2>/dev/null; then
    chown sandbox:sandbox "$hash_file" 2>/dev/null || true
    chmod 660 "$hash_file" 2>/dev/null || true
  else
    printf '[config] ERROR: Restored openclaw.json from %s but failed to recompute %s (see #3118)\n' "$source" "$hash_file" >&2
    return 1
  fi

  printf '[config] openclaw.json restored from %s (was empty — see #3118)\n' "$source" >&2
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
  if [ "$(id -u)" -ne 0 ]; then
    return 0
  fi

  local config_file="/sandbox/.openclaw/openclaw.json"
  local hash_file="/sandbox/.openclaw/.config-hash"

  [ -f "$config_file" ] || return 0

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
      emit_sandbox_sourced_file "$_target" <"$_source"
      case ",$_inject_into," in
        *,boot,*)
          export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require $_target"
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
    printf '%s\n' "${_connect_preloads[@]}" | emit_sandbox_sourced_file "$_MESSAGING_CONNECT_PRELOADS_FILE"
  else
    : | emit_sandbox_sourced_file "$_MESSAGING_CONNECT_PRELOADS_FILE"
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

  validate_tmp_permissions "$_SANDBOX_SAFETY_NET" "$_PROXY_FIX_SCRIPT" "$_NEMOTRON_FIX_SCRIPT" "$_WS_FIX_SCRIPT" "$_SECCOMP_GUARD_SCRIPT" "$_CIAO_GUARD_SCRIPT" "${_dynamic_targets[@]}"
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
  OPENCLAW_BIN="$OPENCLAW" nohup "${run_prefix[@]}" python3 - <<'PYAUTOPAIR' >>/tmp/auto-pair.log 2>&1 &
import json
import importlib.util
import os
import stat
import subprocess
import time

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
        getattr(module, 'recover_failed_scope_approval', None),
    )


approval_request_decision, gateway_approval_env, recover_failed_scope_approval = load_approval_policy(APPROVAL_POLICY_FILE)

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
SLOW_INTERVAL = _env_seconds('NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS', 30)
QUIET_POLLS = 0
APPROVED = 0
SLOW_MODE = False
HANDLED = set()  # Track rejected/approved requestIds to avoid reprocessing
# SECURITY NOTE: clientId/clientMode are client-supplied and spoofable
# (the gateway stores connectParams.client.id verbatim). This allowlist
# is defense-in-depth, not a trust boundary. PR #690 adds one-shot exit,
# timeout reduction, and token cleanup for a more comprehensive fix.
# The approval_request_decision helper is shared with connect-time approvals.

RUN_TIMEOUT_SECS = _env_seconds('NEMOCLAW_AUTO_PAIR_RUN_TIMEOUT_SECS', 10)

# Workaround boundary (NemoClaw#4462): OpenClaw owns the gateway/device
# approval semantics. In OpenClaw 2026.5.x, a gateway-pinned
# `openclaw devices approve <scope-upgrade>` can request the upgraded scopes
# for its own connection and return the same pending-scope error it is trying
# to resolve. List calls must stay gateway-pinned so we inspect the live
# gateway, but approval calls temporarily remove OPENCLAW_GATEWAY_URL,
# OPENCLAW_GATEWAY_PORT, and OPENCLAW_GATEWAY_TOKEN to use OpenClaw's local
# pairing fallback. Remove this when OpenClaw approve can complete scope
# upgrades through the gateway using only operator.pairing.
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

while time.time() < DEADLINE:
    rc, out, err = run(OPENCLAW, 'devices', 'list', '--json')
    if rc != 0 or not out:
        time.sleep(SLOW_INTERVAL if SLOW_MODE else 1)
        continue
    try:
        data = json.loads(out)
    except Exception:
        time.sleep(SLOW_INTERVAL if SLOW_MODE else 1)
        continue

    pending = data.get('pending') or []
    paired = data.get('paired') or []
    has_browser = any((d.get('clientId') == 'openclaw-control-ui') or (d.get('clientMode') == 'webchat') for d in paired if isinstance(d, dict))

    # Fast-deadline transition is checked here, BEFORE the pending-branch
    # `continue`, so that a sticky pending request (rejected unknown client
    # added to HANDLED, or a permanent approve failure) cannot hold the
    # watcher in 1s polling for the full DEADLINE window — that would
    # re-create the NemoClaw#2484 connect-handler pile-up on a much longer
    # timeline.
    if not SLOW_MODE and time.time() >= FAST_DEADLINE:
        SLOW_MODE = True
        print(f'[auto-pair] fast-mode deadline reached; switching to slow-mode approvals={APPROVED}')

    if pending:
        QUIET_POLLS = 0
        for device in pending:
            if not isinstance(device, dict):
                continue
            request_id = device.get('requestId')
            if not request_id or request_id in HANDLED:
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
            elif callable(recover_failed_scope_approval):
                recovered = recover_failed_scope_approval(
                    request_id,
                    os.environ.get('OPENCLAW_STATE_DIR') or '/sandbox/.openclaw',
                    aerr or aout or '',
                    device,
                )
                if recovered:
                    HANDLED.add(request_id)
                    APPROVED += 1
                    print(f'[auto-pair] recovered failed approve request={request_id} client={client_id} mode={client_mode}')
                elif aout or aerr:
                    print(f'[auto-pair] approve failed request={request_id}: {(aerr or aout)[:400]}')
            elif aout or aerr:
                print(f'[auto-pair] approve failed request={request_id}: {(aerr or aout)[:400]}')
        time.sleep(SLOW_INTERVAL if SLOW_MODE else 1)
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
    # (default 30s) after convergence. Slow-mode keepalive lets late CLI
    # scope upgrades get approved through the rest of DEADLINE without
    # hammering the gateway.
    if SLOW_MODE:
        time.sleep(SLOW_INTERVAL)
    elif APPROVED > 0 or paired:
        time.sleep(5)
    else:
        time.sleep(1)
else:
    print(f'[auto-pair] watcher deadline reached approvals={APPROVED}')
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
emit_sandbox_sourced_file "$_SANDBOX_SAFETY_NET" <"$_SANDBOX_SAFETY_NET_SOURCE"
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require $_SANDBOX_SAFETY_NET"

_PROXY_FIX_SCRIPT="/tmp/nemoclaw-http-proxy-fix.js"
_PROXY_FIX_SOURCE="/usr/local/lib/nemoclaw/preloads/http-proxy-fix.js"
if [ "${NODE_USE_ENV_PROXY:-}" = "1" ]; then
  emit_sandbox_sourced_file "$_PROXY_FIX_SCRIPT" <"$_PROXY_FIX_SOURCE"
  export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require $_PROXY_FIX_SCRIPT"
fi

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
emit_sandbox_sourced_file "$_NEMOTRON_FIX_SCRIPT" <"$_NEMOTRON_FIX_SOURCE"
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require $_NEMOTRON_FIX_SCRIPT"

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
emit_sandbox_sourced_file "$_CIAO_GUARD_SCRIPT" <"$_CIAO_GUARD_SOURCE"
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require $_CIAO_GUARD_SCRIPT"

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
if [ -f "$_WS_FIX_SOURCE" ]; then
  # Copy to /tmp so the sandbox user can read it — /usr/local/lib/ may be
  # Landlock-restricted in some runtimes. Same pattern as the other preloads.
  emit_sandbox_sourced_file "$_WS_FIX_SCRIPT" <"$_WS_FIX_SOURCE"
  export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require $_WS_FIX_SCRIPT"
fi

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
emit_sandbox_sourced_file "$_SECCOMP_GUARD_SCRIPT" <"$_SECCOMP_GUARD_SOURCE"
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require $_SECCOMP_GUARD_SCRIPT"

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
      printf "export OPENCLAW_GATEWAY_URL='%s'\n" "$_escaped_gateway_url"
    fi
    if [ -n "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
      _escaped_gateway_token="$(printf '%s' "$OPENCLAW_GATEWAY_TOKEN" | sed "s/'/'\\\\''/g")"
      printf "export OPENCLAW_GATEWAY_TOKEN='%s'\n" "$_escaped_gateway_token"
    fi
    if [ -n "${OPENCLAW_ALLOW_INSECURE_PRIVATE_WS:-}" ]; then
      # Mirrors the gateway-process export above so connect-shell CLI
      # clients accept the plaintext eth0 ws:// gateway URL too.
      printf "export OPENCLAW_ALLOW_INSECURE_PRIVATE_WS='1'\n"
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
  # NemoClaw#4462: keep user-initiated device approval usable from an
  # interactive sandbox shell until upstream OpenClaw can approve scope
  # upgrades through the gateway without requesting the upgraded scopes for
  # the approval command itself. Approval calls temporarily drop the gateway
  # URL/port/token; other commands keep the full gateway environment.
  if [ "${1:-}" = "devices" ] && [ "${2:-}" = "approve" ]; then
    _nemoclaw_approve_request_id="${3:-}"
    _nemoclaw_approve_state_dir="${OPENCLAW_STATE_DIR:-/sandbox/.openclaw}"
    _nemoclaw_approve_before=""
    if [ -n "$_nemoclaw_approve_request_id" ] && command -v python3 >/dev/null 2>&1; then
      _nemoclaw_approve_before="$(NEMOCLAW_APPROVE_REQUEST_ID="$_nemoclaw_approve_request_id" NEMOCLAW_APPROVE_STATE_DIR="$_nemoclaw_approve_state_dir" python3 - <<'PYAPPROVEBEFORE' 2>/dev/null || true
import json
import os
from pathlib import Path

root = Path(os.environ.get("NEMOCLAW_APPROVE_STATE_DIR") or "/sandbox/.openclaw") / "devices"
request_id = os.environ.get("NEMOCLAW_APPROVE_REQUEST_ID") or ""
try:
    pending = json.loads((root / "pending.json").read_text(encoding="utf-8"))
except Exception:
    pending = {}
if not isinstance(pending, dict):
    pending = {}
request = next((item for item in pending.values() if isinstance(item, dict) and item.get("requestId") == request_id), None)
if request:
    print(json.dumps({
        "requestId": request_id,
        "deviceId": request.get("deviceId"),
        "scopes": request.get("scopes") or request.get("requestedScopes") or [],
    }, sort_keys=True))
PYAPPROVEBEFORE
)"
    fi
    _nemoclaw_approve_errexit=0
    case $- in *e*) _nemoclaw_approve_errexit=1 ;; esac
    set +e
    _nemoclaw_approve_output="$(unset OPENCLAW_GATEWAY_URL OPENCLAW_GATEWAY_PORT OPENCLAW_GATEWAY_TOKEN; command openclaw "$@" 2>&1)"
    _nemoclaw_approve_rc=$?
    if [ "$_nemoclaw_approve_errexit" = "1" ]; then set -e; else set +e; fi
    if [ "$_nemoclaw_approve_rc" -eq 0 ]; then
      printf '%s\n' "$_nemoclaw_approve_output"
      return 0
    fi
    if [ -n "$_nemoclaw_approve_request_id" ] && [ -n "$_nemoclaw_approve_before" ] && command -v python3 >/dev/null 2>&1; then
      if NEMOCLAW_APPROVE_REQUEST_ID="$_nemoclaw_approve_request_id" NEMOCLAW_APPROVE_STATE_DIR="$_nemoclaw_approve_state_dir" NEMOCLAW_APPROVE_BEFORE="$_nemoclaw_approve_before" NEMOCLAW_APPROVE_OUTPUT="$_nemoclaw_approve_output" python3 - <<'PYAPPROVEAFTER'; then
import json
import os
import re
from pathlib import Path

request_id = os.environ.get("NEMOCLAW_APPROVE_REQUEST_ID") or ""
root = Path(os.environ.get("NEMOCLAW_APPROVE_STATE_DIR") or "/sandbox/.openclaw") / "devices"
try:
    before = json.loads(os.environ.get("NEMOCLAW_APPROVE_BEFORE") or "{}")
except Exception:
    before = {}
approve_output = os.environ.get("NEMOCLAW_APPROVE_OUTPUT") or ""

def load(name):
    try:
        value = json.loads((root / name).read_text(encoding="utf-8"))
    except Exception:
        return {}
    return value if isinstance(value, dict) else {}

def save(name, value):
    path = root / name
    tmp = path.with_name(f".{path.name}.tmp")
    with tmp.open("w", encoding="utf-8") as handle:
        handle.write(json.dumps(value, indent=2, sort_keys=True) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)

def norm(value):
    return str(value or "").strip()

def scope_set(entry, key="scopes"):
    return {norm(scope) for scope in (entry.get(key) or []) if norm(scope)}

def output_mentions_request_id(value):
    request = norm(value)
    return bool(request and re.search(r"(?<![0-9A-Za-z_-])" + re.escape(request) + r"(?![0-9A-Za-z_-])", approve_output))

def is_scope_upgrade_approval_compat_failure(output):
    text = norm(output).lower()
    return "scope upgrade pending approval" in text and (
        "gatewayclientrequesterror" in text or "gateway" in text
    )

requested = scope_set(before)
device_id = norm(before.get("deviceId"))
pending = load("pending.json")
paired = load("paired.json")
original_pending_key = None
for key, item in pending.items():
    if isinstance(item, dict) and item.get("requestId") == request_id:
        original_pending_key = key
        break
still_pending = original_pending_key is not None
paired_entry = paired.get(device_id) if device_id else None
paired_scopes = scope_set(paired_entry or {}, "approvedScopes") | scope_set(paired_entry or {})
# Compatibility boundary: treat a nonzero approve as success only when OpenClaw
# already removed the pending request and persisted the requested paired scopes.
if request_id and requested and not still_pending and isinstance(paired_entry, dict) and requested.issubset(paired_scopes):
    print(json.dumps({"requestId": request_id, "deviceId": device_id, "approvedScopes": sorted(requested), "compatibility": "openclaw-approve-applied-after-nonzero"}, sort_keys=True))
    raise SystemExit(0)

# Compatibility boundary: repair only the local OpenClaw device state after a
# failed approve leaves behind exactly one same-device admin-shaped replacement
# request. Some OpenClaw failures only surface opaque gateway text, so the state
# files are the source of truth; stderr is only used as an exact disambiguator
# when it carries a replacement request ID. Remove this once OpenClaw stops
# replacing operator.write approvals with admin-shaped pending requests or
# exposes a supported approval repair API.
allowed = {"operator.pairing", "operator.read", "operator.write"}
if not request_id or not device_id or not requested or not requested.issubset(allowed) or "operator.pairing" not in paired_scopes:
    raise SystemExit(1)
replacement_allowed = allowed | {"operator.admin"}
candidates = []
mentioned = []
for key, item in pending.items():
    item_scopes = scope_set(item) if isinstance(item, dict) else set()
    if (isinstance(item, dict) and norm(item.get("requestId")) != request_id and norm(item.get("deviceId")) == device_id and
            "operator.admin" in item_scopes and requested.issubset(item_scopes) and item_scopes.issubset(replacement_allowed)):
        candidates.append((key, item))
        if output_mentions_request_id(item.get("requestId")):
            mentioned.append((key, item))
compatibility = "openclaw-approve-recovered-replacement"
if len(mentioned) == 1:
    replacement_key, replacement = mentioned[0]
elif len(candidates) == 1 and not re.search(r"\brequestId\b|\brequest[-_ ]?id\b", approve_output, re.IGNORECASE):
    replacement_key, replacement = candidates[0]
elif still_pending and not candidates and is_scope_upgrade_approval_compat_failure(approve_output):
    replacement_key = original_pending_key
    compatibility = "openclaw-approve-recovered-original"
else:
    raise SystemExit(1)
approved = set(paired_scopes) | requested
if "operator.write" in approved:
    approved.add("operator.read")
if {"operator.read", "operator.write"} & approved:
    approved.add("operator.pairing")
if not approved.issubset(allowed):
    raise SystemExit(1)
approved_list = [scope for scope in ("operator.pairing", "operator.read", "operator.write") if scope in approved]
paired_entry["scopes"] = approved_list
paired_entry["approvedScopes"] = approved_list
token = paired_entry.get("tokens", {}).get("operator")
if isinstance(token, dict):
    token["scopes"] = approved_list
pending.pop(request_id, None)
pending.pop(replacement_key, None)
paired[device_id] = paired_entry
save("pending.json", pending)
save("paired.json", paired)
print(json.dumps({"requestId": request_id, "deviceId": device_id, "approvedScopes": approved_list, "compatibility": compatibility}, sort_keys=True))
raise SystemExit(0)
PYAPPROVEAFTER
        return 0
      fi
    fi
    printf '%s\n' "$_nemoclaw_approve_output"
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
            if [ -z "${OPENCLAW_GATEWAY_URL:-}" ]; then
              echo "Error: WhatsApp pairing cannot start — OPENCLAW_GATEWAY_URL is not set in this shell." >&2
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
            case "${OPENCLAW_GATEWAY_URL}" in
              ws://*|wss://*) ;;
              *)
                echo "Error: WhatsApp pairing cannot start — OPENCLAW_GATEWAY_URL='${OPENCLAW_GATEWAY_URL}' is not a ws:// gateway URL." >&2
                echo "The OpenClaw gateway is a WebSocket endpoint (e.g. ws://127.0.0.1:<port>); a malformed value" >&2
                echo "would fail the login in a way that looks like a QR/pairing problem (this is a gateway/env problem)." >&2
                echo "" >&2
                echo "Reconnect with 'openshell sandbox connect <sandbox>' and retry. If it persists," >&2
                echo "exit the sandbox and rebuild with 'nemoclaw <sandbox> rebuild'." >&2
                return 1
                ;;
            esac
            echo "[whatsapp] Pairing via gateway ${OPENCLAW_GATEWAY_URL}." >&2
            echo "[whatsapp] On your phone: WhatsApp > Linked devices > Link a device, then scan the QR below." >&2
            # Defense-in-depth: connect-session NODE_OPTIONS already wires
            # manifest-declared connect preloads for every openclaw invocation;
            # injecting them again here covers non-connect shells. Runtime
            # preload modules are idempotent, so a double --require is harmless.
            _nemoclaw_connect_node_options="$(_nemoclaw_messaging_connect_node_options)"
            if [ -n "$_nemoclaw_connect_node_options" ]; then
              NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }$_nemoclaw_connect_node_options" command openclaw "$@"
            else
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
}

# ── Main ─────────────────────────────────────────────────────────

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
    exec "${NEMOCLAW_CMD[@]}"
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
  # TODO(#2277-P2): migrate to shared emit_restricted_log() helper
  touch /tmp/gateway.log
  chmod 644 /tmp/gateway.log

  # Separate log for auto-pair in non-root mode as well.
  # TODO(#2277-P2): migrate to shared emit_restricted_log() helper
  touch /tmp/auto-pair.log
  chmod 600 /tmp/auto-pair.log

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
  record_gateway_pid "$GATEWAY_PID"
  echo "[gateway] openclaw gateway launched (pid $GATEWAY_PID)" >&2
  # Diagnostic: mirror gateway log to PID 1's stderr — see root-mode block
  # below for rationale (NVIDIA/NemoClaw#2484).
  { tail -n +1 -F /tmp/gateway.log 2>/dev/null | sed -u 's/^/[gateway-log:] /' >&2; } &
  GATEWAY_LOG_TAIL_PID=$!
  # Persistent mirror: see root-mode block for rationale.
  start_persistent_gateway_log_mirror || exit 1
  start_auto_pair
  start_plugin_registry_refresh
  # NOTE: PIDs are collected after launch; a signal arriving between trap
  # registration and the final append is a small race window (same as before
  # the shared-library refactor). Acceptable for entrypoint-level cleanup.
  SANDBOX_CHILD_PIDS=("$GATEWAY_PID")
  [ -n "${AUTO_PAIR_PID:-}" ] && SANDBOX_CHILD_PIDS+=("$AUTO_PAIR_PID")
  [ -n "${GATEWAY_LOG_TAIL_PID:-}" ] && SANDBOX_CHILD_PIDS+=("$GATEWAY_LOG_TAIL_PID")
  [ -n "${GATEWAY_LOG_PERSIST_PID:-}" ] && SANDBOX_CHILD_PIDS+=("$GATEWAY_LOG_PERSIST_PID")
  [ -n "${PLUGIN_REFRESH_PID:-}" ] && SANDBOX_CHILD_PIDS+=("$PLUGIN_REFRESH_PID")
  # shellcheck disable=SC2034  # read by cleanup_on_signal from sandbox-init.sh
  SANDBOX_WAIT_PID="$GATEWAY_PID"
  trap cleanup_on_signal SIGTERM SIGINT
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
    wait "$GATEWAY_PID" || RC=$?
    if [ "$RC" -eq 0 ]; then
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
    echo "[gateway] pid $GATEWAY_PID exited (rc=$RC); respawning (#$RESPAWN_COUNT in 60s window) in 2s" >&2
    sleep 2
    nohup "$OPENCLAW" gateway run --port "${_DASHBOARD_PORT}" >>/tmp/gateway.log 2>&1 &
    GATEWAY_PID=$!
    record_gateway_pid "$GATEWAY_PID"
    # shellcheck disable=SC2034  # read by cleanup_on_signal from sandbox-init.sh
    SANDBOX_WAIT_PID="$GATEWAY_PID"
    SANDBOX_CHILD_PIDS+=("$GATEWAY_PID")
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
  exec "${STEP_DOWN_PREFIX_SANDBOX[@]}" "${NEMOCLAW_CMD[@]}"
fi

# Gateway log: owned by gateway user, world-readable for diagnostics.
# The sandbox user can read but not truncate/overwrite (not owner, sticky /tmp).
# TODO(#2277-P2): migrate to shared emit_restricted_log() helper
touch /tmp/gateway.log
chown gateway:gateway /tmp/gateway.log
chmod 644 /tmp/gateway.log

# Separate log for auto-pair so sandbox user can write to it
# TODO(#2277-P2): migrate to shared emit_restricted_log() helper
touch /tmp/auto-pair.log
chown sandbox:sandbox /tmp/auto-pair.log
chmod 600 /tmp/auto-pair.log

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
# Mark the in-container gateway path so the Docker HEALTHCHECK probes it
# rather than short-circuiting to healthy — see mark_in_container_gateway
# comment near the top of this file for the #4710 rationale.
mark_in_container_gateway
nohup "${STEP_DOWN_PREFIX_GATEWAY[@]}" "$OPENCLAW" gateway run --port "${_DASHBOARD_PORT}" >/tmp/gateway.log 2>&1 &
GATEWAY_PID=$!
record_gateway_pid "$GATEWAY_PID"
echo "[gateway] openclaw gateway launched as 'gateway' user (pid $GATEWAY_PID)" >&2

# Diagnostic: mirror gateway log to PID 1's stderr so its content surfaces in
# docker logs. /tmp/gateway.log is otherwise only readable from inside the
# sandbox via `nemoclaw <sandbox> logs` and is not captured by the e2e test
# framework on failure. Streaming it to PID 1's stderr lets a workflow-level
# `docker logs` capture pick it up. Each line is prefixed with [gateway-log:]
# so it can be filtered out post-hoc when not investigating.
# Ref: NVIDIA/NemoClaw#2484 (TC-SBX-02 hang investigation)
{ tail -n +1 -F /tmp/gateway.log 2>/dev/null | sed -u 's/^/[gateway-log:] /' >&2; } &
GATEWAY_LOG_TAIL_PID=$!

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

# NOTE: PIDs are collected after launch; a signal arriving between trap
# registration and the final append is a small race window (same as before
# the shared-library refactor). Acceptable for entrypoint-level cleanup.
SANDBOX_CHILD_PIDS=("$GATEWAY_PID")
[ -n "${AUTO_PAIR_PID:-}" ] && SANDBOX_CHILD_PIDS+=("$AUTO_PAIR_PID")
[ -n "${GATEWAY_LOG_TAIL_PID:-}" ] && SANDBOX_CHILD_PIDS+=("$GATEWAY_LOG_TAIL_PID")
[ -n "${GATEWAY_LOG_PERSIST_PID:-}" ] && SANDBOX_CHILD_PIDS+=("$GATEWAY_LOG_PERSIST_PID")
[ -n "${PLUGIN_REFRESH_PID:-}" ] && SANDBOX_CHILD_PIDS+=("$PLUGIN_REFRESH_PID")
# shellcheck disable=SC2034  # read by cleanup_on_signal from sandbox-init.sh
SANDBOX_WAIT_PID="$GATEWAY_PID"
trap cleanup_on_signal SIGTERM SIGINT
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
  # `wait` must be guarded with `|| RC=$?` because errexit (set -e on
  # line 33) would otherwise exit PID 1 the instant the gateway returns
  # non-zero, defeating the respawn loop entirely.
  RC=0
  wait "$GATEWAY_PID" || RC=$?
  if [ "$RC" -eq 0 ]; then
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
  echo "[gateway] pid $GATEWAY_PID exited (rc=$RC); respawning (#$RESPAWN_COUNT in 60s window) in 2s" >&2
  sleep 2
  nohup "${STEP_DOWN_PREFIX_GATEWAY[@]}" "$OPENCLAW" gateway run --port "${_DASHBOARD_PORT}" >>/tmp/gateway.log 2>&1 &
  GATEWAY_PID=$!
  record_gateway_pid "$GATEWAY_PID"
  # shellcheck disable=SC2034  # read by cleanup_on_signal from sandbox-init.sh
  SANDBOX_WAIT_PID="$GATEWAY_PID"
  SANDBOX_CHILD_PIDS+=("$GATEWAY_PID")
  echo "[gateway] respawned (pid $GATEWAY_PID)" >&2
done
