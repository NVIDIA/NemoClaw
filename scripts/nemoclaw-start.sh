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
exec > >(tee -a "$_START_LOG") 2> >(tee -a "$_START_LOG" >&2)

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

# Harden: limit process count to prevent fork bombs (ref: #809)
# Best-effort: some container runtimes (e.g., brev) restrict ulimit
# modification, returning "Invalid argument". Warn but don't block startup.
if ! ulimit -Su 512 2>/dev/null; then
  echo "[SECURITY] Could not set soft nproc limit (container runtime may restrict ulimit)" >&2
fi
if ! ulimit -Hu 512 2>/dev/null; then
  echo "[SECURITY] Could not set hard nproc limit (container runtime may restrict ulimit)" >&2
fi

# PATH was already locked down at the top of this script (before the
# early stderr capture). This comment marks the original location.

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
  'PYTHON_HISTORY=/tmp/.python_history'
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
# Validate NEMOCLAW_DASHBOARD_PORT if set (same behavior as ports.js: fail fast).
_DASHBOARD_PORT_RAW="${NEMOCLAW_DASHBOARD_PORT:-}"
if [ -z "$_DASHBOARD_PORT_RAW" ]; then
  _DASHBOARD_PORT=18789
else
  _DASHBOARD_PORT="$(printf '%s' "$_DASHBOARD_PORT_RAW" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  case "$_DASHBOARD_PORT" in
    *[!0-9]* | '')
      echo "[SECURITY] Invalid NEMOCLAW_DASHBOARD_PORT='${NEMOCLAW_DASHBOARD_PORT}' — must be an integer between 1024 and 65535" >&2
      exit 1
      ;;
  esac
  if [ "$_DASHBOARD_PORT" -lt 1024 ] || [ "$_DASHBOARD_PORT" -gt 65535 ]; then
    echo "[SECURITY] Invalid NEMOCLAW_DASHBOARD_PORT='${NEMOCLAW_DASHBOARD_PORT}' — must be an integer between 1024 and 65535" >&2
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
OPENCLAW="$(command -v openclaw)" # Resolve once, use absolute path everywhere
_SANDBOX_HOME="/sandbox"          # Home dir for the sandbox user (useradd -d /sandbox in Dockerfile.base)

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

# ── Slack token rewriter (Bolt-shape → canonical placeholder) ────
# Installs a Node preload that translates the Bolt-compatible placeholder
# (xoxb|xapp)-OPENSHELL-RESOLVE-ENV-VAR — emitted into openclaw.json by
# generate-openclaw-config.py — into the canonical openshell:resolve:env:VAR
# form on outbound HTTP. OpenShell's L7 proxy then substitutes the real
# token from env on the wire, the same path Discord/Telegram/Brave already
# take. No real Slack token ever touches openclaw.json, /tmp, or any other
# disk surface readable by the sandbox uid.
#
# Ref: https://github.com/NVIDIA/NemoClaw/issues/2085

_SLACK_REWRITER_SCRIPT="/tmp/nemoclaw-slack-token-rewriter.js"
_SLACK_REWRITER_SOURCE="/usr/local/lib/nemoclaw/preloads/slack-token-rewriter.js"

install_slack_token_rewriter() {
  local config_file="/sandbox/.openclaw/openclaw.json"

  # Only install if a Slack channel placeholder is present in the config.
  # Same conditional shape as install_slack_channel_guard — both are no-ops
  # for sandboxes without Slack configured.
  if ! grep -q 'OPENSHELL-RESOLVE-ENV-SLACK_' "$config_file" 2>/dev/null; then
    return 0
  fi

  printf '[channels] Installing Slack token rewriter (Bolt-shape → canonical)\n' >&2

  emit_sandbox_sourced_file "$_SLACK_REWRITER_SCRIPT" <"$_SLACK_REWRITER_SOURCE"

  export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require $_SLACK_REWRITER_SCRIPT"
  printf '[channels] Slack token rewriter installed (NODE_OPTIONS updated)\n' >&2
}

# ── Slack secrets-on-disk tripwire ────────────────────────────────
# Defense-in-depth: refuse to serve if a real Slack token (anything
# starting with xoxb- or xapp- that is NOT the OPENSHELL-RESOLVE-ENV-
# placeholder) ever appears in openclaw.json. This catches a regression
# where someone re-introduces inline token mutation, or a bug in the
# config generator that emits raw env values. Runs once at startup,
# after configure_messaging_channels has finalized the config.
verify_no_slack_secrets_on_disk() {
  local config="/sandbox/.openclaw/openclaw.json"
  [ -f "$config" ] || return 0
  if python3 - "$config" <<'PYSLACKSECRET'; then
import re
import sys

with open(sys.argv[1], "r", encoding="utf-8", errors="ignore") as f:
    content = f.read()
sys.exit(0 if re.search(r"(?:xoxb|xapp)-(?!OPENSHELL-RESOLVE-ENV-)", content) else 1)
PYSLACKSECRET
    printf '[SECURITY] Slack token leaked into %s — refusing to serve\n' "$config" >&2
    exit 78 # EX_CONFIG
  fi
}

# ── Slack channel guard (unhandled-rejection safety net) ─────────
# Prevents the gateway from crashing when a Slack channel fails to
# initialize (e.g., invalid_auth, token_revoked, unresolved placeholder
# tokens). Instead of modifying openclaw.json (which is Landlock
# read-only at runtime), this injects a Node.js preload via
# NODE_OPTIONS that catches unhandled promise rejections originating
# from Slack channel initialization and logs them as warnings instead
# of letting Node v22 treat them as fatal.
#
# Same pattern as the HTTP proxy fix (_PROXY_FIX_SCRIPT) and the
# WebSocket CONNECT fix (_WS_FIX_SCRIPT).
#
# Ref: https://github.com/NVIDIA/NemoClaw/issues/2340
_SLACK_GUARD_SCRIPT="/tmp/nemoclaw-slack-channel-guard.js"
_SLACK_GUARD_SOURCE="/usr/local/lib/nemoclaw/preloads/slack-channel-guard.js"

install_slack_channel_guard() {
  local config_file="/sandbox/.openclaw/openclaw.json"

  # Only install if a Slack channel is configured
  if ! grep -q '"slack"' "$config_file" 2>/dev/null; then
    return 0
  fi

  printf '[channels] Installing Slack channel guard (unhandled-rejection safety net)\n' >&2

  emit_sandbox_sourced_file "$_SLACK_GUARD_SCRIPT" <"$_SLACK_GUARD_SOURCE"

  export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require $_SLACK_GUARD_SCRIPT"
  printf '[channels] Slack channel guard installed (NODE_OPTIONS updated)\n' >&2
}

# ── Telegram diagnostics (provider-ready + inference-failure clarity) ─
_TELEGRAM_DIAGNOSTICS_SCRIPT="/tmp/nemoclaw-telegram-diagnostics.js"
_TELEGRAM_DIAGNOSTICS_SOURCE="/usr/local/lib/nemoclaw/preloads/telegram-diagnostics.js"

install_telegram_diagnostics() {
  local config_file="/sandbox/.openclaw/openclaw.json"

  # Only install when Telegram is configured in the baked OpenClaw config.
  if ! grep -q '"telegram"' "$config_file" 2>/dev/null; then
    return 0
  fi

  printf '[channels] Installing Telegram diagnostics (provider readiness + inference errors)\n' >&2

  emit_sandbox_sourced_file "$_TELEGRAM_DIAGNOSTICS_SCRIPT" <"$_TELEGRAM_DIAGNOSTICS_SOURCE"

  export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require $_TELEGRAM_DIAGNOSTICS_SCRIPT"
  printf '[channels] Telegram diagnostics installed (NODE_OPTIONS updated)\n' >&2
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

  if [ -z "$token" ]; then
    unset OPENCLAW_GATEWAY_TOKEN
    return
  fi
  export OPENCLAW_GATEWAY_TOKEN="$token"
}

# Write an auth profile JSON for the NVIDIA API key so the gateway can authenticate.
write_auth_profile() {
  if [ -z "${NVIDIA_API_KEY:-}" ]; then
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
        'keyRef': {'source': 'env', 'id': 'NVIDIA_API_KEY'},
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

    QUIET_POLLS += 1
    # Exit-on-quiet conditions, checked in order of strength:
    #   1. Browser device paired — original control-UI workflow
    #   2. Any paired device — covers dangerouslyDisableDeviceAuth setups
    #      where the gateway auto-pairs CLI clients directly without the
    #      watcher running `openclaw devices approve` (so APPROVED stays
    #      0 forever in those configurations)
    #   3. We approved at least one device explicitly
    # Without these, the watcher polled `openclaw devices list --json`
    # every 1 second for 10 minutes whenever no browser device joined,
    # saturating the gateway connect handler and starving concurrent
    # `openclaw agent` connects (NemoClaw#2484: WS handshake-timeout).
    if QUIET_POLLS >= 4:
        if has_browser:
            print(f'[auto-pair] browser pairing converged approvals={APPROVED}')
            break
        if paired:
            print(f'[auto-pair] devices paired ({len(paired)}); exiting approvals={APPROVED}')
            break
        if APPROVED > 0:
            print(f'[auto-pair] non-browser pairing converged approvals={APPROVED}')
            break

    # Back off polling once anything is paired or approved: 1s when
    # actively processing pending requests / waiting for first pairing,
    # 5s thereafter. The 5s cadence avoids connect-handler pile-up under
    # high gateway connect latency.
    time.sleep(5 if (APPROVED > 0 or paired) else 1)
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
# Runtime preload modules are copied into /usr/local/lib/nemoclaw/preloads/
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
# The preload wraps http.request() — the lowest common denominator every
# HTTP client bottoms out at — buffers the JSON body for POST requests
# to /v1/chat/completions, and injects model-specific kwargs for the affected
# NVIDIA endpoint models. Backends that do not recognise the extra field
# silently ignore it (OpenAI-compatible contract).
#
# Scoped strictly to known affected models: unrelated requests pass through
# completely untouched.
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
# time a user connects via `openshell sandbox connect`.  The connect path spawns
# `/bin/bash -i` (interactive, non-login), which sources ~/.bashrc — NOT
# ~/.profile or /etc/profile.d/*.
#
# We write dynamic connect-session config to /tmp/nemoclaw-proxy-env.sh. The
# pre-built .bashrc and .profile source this file automatically.
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
PROXYEOF
    if [ -n "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
      _escaped_gateway_token="$(printf '%s' "$OPENCLAW_GATEWAY_TOKEN" | sed "s/'/'\\\\''/g")"
      printf "export OPENCLAW_GATEWAY_TOKEN='%s'\n" "$_escaped_gateway_token"
    fi
    cat <<'GUARDENVEOF'
# nemoclaw-configure-guard begin
openclaw() {
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
      case "$2" in
        list | "" | -h | --help) ;;
        *)
          echo "Error: 'openclaw channels $2' cannot modify channels inside the sandbox." >&2
          echo "Changes inside the sandbox do not persist across rebuilds." >&2
          echo "" >&2
          echo "To add or remove messaging channels, exit the sandbox and run:" >&2
          echo "  nemoclaw <sandbox> channels add <telegram|discord|slack>" >&2
          echo "  nemoclaw <sandbox> channels remove <telegram|discord|slack>" >&2
          echo "" >&2
          echo "These stage the change and rebuild the sandbox to apply it." >&2
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
  command openclaw "$@"
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
    # Telegram diagnostics for connect sessions — same conditional pattern.
    echo "[ -f \"$_TELEGRAM_DIAGNOSTICS_SCRIPT\" ] && export NODE_OPTIONS=\"\${NODE_OPTIONS:+\$NODE_OPTIONS }--require $_TELEGRAM_DIAGNOSTICS_SCRIPT\""
    # Slack channel guard for connect sessions. The guard file is installed later
    # by install_slack_channel_guard() — conditional on the file existing at
    # source-time so connect sessions started before Slack is configured are safe.
    echo "[ -f \"$_SLACK_GUARD_SCRIPT\" ] && export NODE_OPTIONS=\"\${NODE_OPTIONS:+\$NODE_OPTIONS }--require $_SLACK_GUARD_SCRIPT\""
    # Slack token rewriter for connect sessions — same conditional pattern.
    echo "[ -f \"$_SLACK_REWRITER_SCRIPT\" ] && export NODE_OPTIONS=\"\${NODE_OPTIONS:+\$NODE_OPTIONS }--require $_SLACK_REWRITER_SCRIPT\""
    # Tool cache redirects — generated from _TOOL_REDIRECTS (single source of truth)
    echo '# Tool cache redirects — /sandbox is Landlock read-only (#804)'
    for _redir in "${_TOOL_REDIRECTS[@]}"; do
      echo "export ${_redir?}"
    done
  } | emit_sandbox_sourced_file "$_PROXY_ENV_FILE"
}

# cleanup_on_signal is provided by sandbox-init.sh. It reads
# SANDBOX_CHILD_PIDS (array of all PIDs) and SANDBOX_WAIT_PID (the
# primary process whose exit status is returned).
# Each code path below sets these before registering the trap.

# Stale base images may have rc files from before the runtime env source shim
# was baked into Dockerfile.base. Backfill the static shim before lock_rc_files
# makes those files read-only so connect sessions still receive proxy config,
# gateway auth, and command guards through /tmp/nemoclaw-proxy-env.sh.
ensure_runtime_shell_env_shim() {
  local failed=0
  local rc_file

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
    if [ -f "$rc_file" ] && grep -qxF "$_RUNTIME_SHELL_ENV_SHIM" "$rc_file" 2>/dev/null; then
      continue
    fi

    if [ "$(id -u)" -eq 0 ] && [ -f "$rc_file" ]; then
      if ! chown root:root "$rc_file" 2>/dev/null; then
        echo "[SECURITY] could not take ownership of $rc_file before shim backfill" >&2
        failed=1
        continue
      fi
      if ! chmod 644 "$rc_file" 2>/dev/null; then
        echo "[SECURITY] could not make $rc_file writable before shim backfill" >&2
        failed=1
        continue
      fi
    elif [ -f "$rc_file" ]; then
      chmod u+w "$rc_file" 2>/dev/null || true
    fi

    if [ -e "$rc_file" ]; then
      if ! printf '\n%s\n%s\n' '# Source runtime proxy config' "$_RUNTIME_SHELL_ENV_SHIM" >>"$rc_file"; then
        echo "[SECURITY] could not backfill runtime env shim into $rc_file" >&2
        failed=1
        continue
      fi
    elif ! printf '%s\n%s\n' '# Source runtime proxy config' "$_RUNTIME_SHELL_ENV_SHIM" >"$rc_file"; then
      echo "[SECURITY] could not create $rc_file with runtime env shim" >&2
      failed=1
      continue
    fi

    if ! grep -qxF "$_RUNTIME_SHELL_ENV_SHIM" "$rc_file" 2>/dev/null; then
      echo "[SECURITY] runtime env shim missing after backfill: $rc_file" >&2
      failed=1
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
    local npm_root
    npm_root="$(npm root -g 2>/dev/null)" || return 0
    [ -n "$npm_root" ] || return 0
    templates_dir="${npm_root}/openclaw/dist/docs/reference/templates"
  fi
  if [ ! -d "$templates_dir" ]; then
    echo "[setup] openclaw templates dir not found at ${templates_dir}; skipping workspace seed" >&2
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
  if ! verify_config_integrity_if_locked /sandbox/.openclaw; then
    echo "[SECURITY] Config integrity check failed — refusing to start (non-root mode)" >&2
    exit 1
  fi
  normalize_mutable_config_perms
  apply_model_override
  apply_cors_override
  export_gateway_token
  write_runtime_shell_env
  ensure_runtime_shell_env_shim
  lock_rc_files "$_SANDBOX_HOME" || true

  if [ ${#NEMOCLAW_CMD[@]} -gt 0 ]; then
    exec "${NEMOCLAW_CMD[@]}"
  fi

  configure_messaging_channels
  install_telegram_diagnostics
  install_slack_token_rewriter
  install_slack_channel_guard
  verify_no_slack_secrets_on_disk

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
  seed_default_workspace_templates
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

  # Defence-in-depth: verify /tmp file permissions before launching services.
  # Pass the HTTP proxy-fix path so it is validated alongside proxy-env.sh
  # (both are trust-boundary files; tampering would let the sandbox user
  # inject code into any Node process via NODE_OPTIONS).
  validate_tmp_permissions "$_SANDBOX_SAFETY_NET" "$_PROXY_FIX_SCRIPT" "$_NEMOTRON_FIX_SCRIPT" "$_WS_FIX_SCRIPT" "$_SECCOMP_GUARD_SCRIPT" "$_CIAO_GUARD_SCRIPT" "$_TELEGRAM_DIAGNOSTICS_SCRIPT" "$_SLACK_GUARD_SCRIPT" "$_SLACK_REWRITER_SCRIPT"

  # Start gateway in background, auto-pair, then wait
  nohup "$OPENCLAW" gateway run --port "${_DASHBOARD_PORT}" >/tmp/gateway.log 2>&1 &
  GATEWAY_PID=$!
  echo "[gateway] openclaw gateway launched (pid $GATEWAY_PID)" >&2
  # Diagnostic: mirror gateway log to PID 1's stderr — see root-mode block
  # below for rationale (NVIDIA/NemoClaw#2484).
  { tail -n +1 -F /tmp/gateway.log 2>/dev/null | sed -u 's/^/[gateway-log:] /' >&2; } &
  GATEWAY_LOG_TAIL_PID=$!
  # Persistent mirror: see root-mode block for rationale.
  start_persistent_gateway_log_mirror || exit 1
  start_auto_pair
  # NOTE: PIDs are collected after launch; a signal arriving between trap
  # registration and the final append is a small race window (same as before
  # the shared-library refactor). Acceptable for entrypoint-level cleanup.
  SANDBOX_CHILD_PIDS=("$GATEWAY_PID")
  [ -n "${AUTO_PAIR_PID:-}" ] && SANDBOX_CHILD_PIDS+=("$AUTO_PAIR_PID")
  [ -n "${GATEWAY_LOG_TAIL_PID:-}" ] && SANDBOX_CHILD_PIDS+=("$GATEWAY_LOG_TAIL_PID")
  [ -n "${GATEWAY_LOG_PERSIST_PID:-}" ] && SANDBOX_CHILD_PIDS+=("$GATEWAY_LOG_PERSIST_PID")
  # shellcheck disable=SC2034  # read by cleanup_on_signal from sandbox-init.sh
  SANDBOX_WAIT_PID="$GATEWAY_PID"
  trap cleanup_on_signal SIGTERM SIGINT
  print_dashboard_urls

  wait "$GATEWAY_PID"
  exit $?
fi

# ── Root path (full privilege separation via gosu) ─────────────

# Verify locked config integrity before starting anything. Mutable-default
# config is intentionally writable and is not a trust anchor until shields-up.
verify_config_integrity_if_locked /sandbox/.openclaw
normalize_mutable_config_perms
apply_model_override
apply_cors_override
export_gateway_token
write_runtime_shell_env
ensure_runtime_shell_env_shim
lock_rc_files "$_SANDBOX_HOME"

# Inject messaging channel config if provider tokens are present.
# Must run AFTER integrity check (to detect build-time tampering) and
# BEFORE chattr +i (which locks the config permanently).
configure_messaging_channels
install_telegram_diagnostics
install_slack_token_rewriter
install_slack_channel_guard
verify_no_slack_secrets_on_disk

# Write auth profile as sandbox user and recursively re-tighten any
# auth-profiles.json files under ~/.openclaw.
gosu sandbox bash -c "$(declare -f write_auth_profile harden_auth_profiles); write_auth_profile; harden_auth_profiles"

# If a command was passed (e.g., "openclaw agent ..."), run it as sandbox user
if [ ${#NEMOCLAW_CMD[@]} -gt 0 ]; then
  exec gosu sandbox "${NEMOCLAW_CMD[@]}"
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
gosu sandbox bash -c "$(declare -f seed_default_workspace_templates); seed_default_workspace_templates"

# Defence-in-depth: verify /tmp file permissions before launching services.
# Pass the HTTP proxy-fix path so it is validated alongside proxy-env.sh
# (both are trust-boundary files; tampering would let the sandbox user
# inject code into any Node process via NODE_OPTIONS).
validate_tmp_permissions "$_SANDBOX_SAFETY_NET" "$_PROXY_FIX_SCRIPT" "$_NEMOTRON_FIX_SCRIPT" "$_WS_FIX_SCRIPT" "$_SECCOMP_GUARD_SCRIPT" "$_CIAO_GUARD_SCRIPT" "$_TELEGRAM_DIAGNOSTICS_SCRIPT" "$_SLACK_GUARD_SCRIPT" "$_SLACK_REWRITER_SCRIPT"

# Start the gateway as the 'gateway' user.
# SECURITY: The sandbox user cannot kill this process because it runs
# under a different UID. The fake-HOME attack no longer works because
# the agent cannot restart the gateway with a tampered config.
nohup gosu gateway "$OPENCLAW" gateway run --port "${_DASHBOARD_PORT}" >/tmp/gateway.log 2>&1 &
GATEWAY_PID=$!
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
# NOTE: PIDs are collected after launch; a signal arriving between trap
# registration and the final append is a small race window (same as before
# the shared-library refactor). Acceptable for entrypoint-level cleanup.
SANDBOX_CHILD_PIDS=("$GATEWAY_PID")
[ -n "${AUTO_PAIR_PID:-}" ] && SANDBOX_CHILD_PIDS+=("$AUTO_PAIR_PID")
[ -n "${GATEWAY_LOG_TAIL_PID:-}" ] && SANDBOX_CHILD_PIDS+=("$GATEWAY_LOG_TAIL_PID")
[ -n "${GATEWAY_LOG_PERSIST_PID:-}" ] && SANDBOX_CHILD_PIDS+=("$GATEWAY_LOG_PERSIST_PID")
# shellcheck disable=SC2034  # read by cleanup_on_signal from sandbox-init.sh
SANDBOX_WAIT_PID="$GATEWAY_PID"
trap cleanup_on_signal SIGTERM SIGINT
print_dashboard_urls

# Keep container running by waiting on the gateway process.
# This script is PID 1 (ENTRYPOINT); if it exits, Docker kills all children.
wait "$GATEWAY_PID"
