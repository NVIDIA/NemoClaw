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
# verify_config_integrity is provided by sandbox-init.sh (parameterized).

# ── Runtime model/provider override ──────────────────────────────
# Patches openclaw.json at startup when NEMOCLAW_MODEL_OVERRIDE is set,
# allowing model or provider changes without rebuilding the sandbox image.
# Runs AFTER integrity check (detects build-time tampering) and BEFORE
# chattr +i (locks the file permanently). Recomputes the config hash so
# future integrity checks pass.
#
# SECURITY: These env vars come from the host (Docker/OpenShell), not from
# inside the sandbox. The agent cannot set them. Landlock locks the file
# after this function runs. Same trust model as NEMOCLAW_LOCAL_INFERENCE_TIMEOUT.
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
  # Symlink validation (validate_openclaw_symlinks) runs later, so guard here too.
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
        printf '[SECURITY] NEMOCLAW_INFERENCE_API_OVERRIDE must be "openai-completions" or "anthropic-messages", got "%s"\n' "$api_override" >&2
        return 1
        ;;
    esac
  fi

  local context_window="${NEMOCLAW_CONTEXT_WINDOW:-}"
  local max_tokens="${NEMOCLAW_MAX_TOKENS:-}"
  local reasoning="${NEMOCLAW_REASONING:-}"

  # Validate numeric values
  if [ -n "$context_window" ] && ! printf '%s' "$context_window" | grep -qE '^[0-9]+$'; then
    printf '[SECURITY] NEMOCLAW_CONTEXT_WINDOW must be a positive integer, got "%s"\n' "$context_window" >&2
    return 1
  fi
  if [ -n "$max_tokens" ] && ! printf '%s' "$max_tokens" | grep -qE '^[0-9]+$'; then
    printf '[SECURITY] NEMOCLAW_MAX_TOKENS must be a positive integer, got "%s"\n' "$max_tokens" >&2
    return 1
  fi
  # Validate reasoning is true/false
  if [ -n "$reasoning" ]; then
    case "$reasoning" in
      true | false) ;;
      *)
        printf '[SECURITY] NEMOCLAW_REASONING must be "true" or "false", got "%s"\n' "$reasoning" >&2
        return 1
        ;;
    esac
  fi

  [ -n "$model_override" ] && printf '[config] Applying model override: %s\n' "$model_override" >&2
  [ -n "$api_override" ] && printf '[config] Applying inference API override: %s\n' "$api_override" >&2
  [ -n "$context_window" ] && printf '[config] Applying context window override: %s\n' "$context_window" >&2
  [ -n "$max_tokens" ] && printf '[config] Applying max tokens override: %s\n' "$max_tokens" >&2
  [ -n "$reasoning" ] && printf '[config] Applying reasoning override: %s\n' "$reasoning" >&2

  # Relax 444 → 644 so writes succeed after CAP_DAC_OVERRIDE is dropped (#2653).
  # Re-lock in all exit paths so files are never left at 644 on failure.
  relax_config_for_write "$config_file" "$hash_file"
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

  # Re-lock 644 → 444 — always runs, even on write/hash failure (#2653)
  lock_config_after_write "$config_file" "$hash_file"
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
    printf '[SECURITY] NEMOCLAW_CORS_ORIGIN must start with http:// or https://, got "%s"\n' "$cors_origin" >&2
    return 1
  fi

  printf '[config] Adding CORS origin: %s\n' "$cors_origin" >&2

  # Relax 444 → 644 so writes succeed after CAP_DAC_OVERRIDE is dropped (#2653).
  # Re-lock in all exit paths so files are never left at 644 on failure.
  relax_config_for_write "$config_file" "$hash_file"
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

  # Re-lock 644 → 444 — always runs, even on write/hash failure (#2653)
  lock_config_after_write "$config_file" "$hash_file"
  [ "$_write_rc" -eq 0 ] || return "$_write_rc"
}

# ── Slack token placeholder resolution ────────────────────────────
# Resolves openshell:resolve:env:SLACK_* placeholders in openclaw.json at
# container startup, before chattr +i locks the file. This ensures Bolt's
# in-process token validation (appToken must start with xapp-) succeeds even
# before the L7 proxy can intercept HTTP calls.
# Same trust model as apply_model_override: host-set env vars, root-only,
# applied before Landlock/chattr +i, hash recomputed. Tokens are unset from
# the process env after patching so they are not visible inside the sandbox.
# Ref: https://github.com/NVIDIA/NemoClaw/issues/2085

apply_slack_token_override() {
  [ -n "${SLACK_BOT_TOKEN:-}" ] || return 0

  # Non-root cannot write to /sandbox/.openclaw (root:root 444), so the
  # placeholder token cannot be resolved here. Log a warning and continue —
  # the Slack channel guard will catch the inevitable auth failure at runtime
  # without crashing the gateway. Ref: #2340
  if [ "$(id -u)" -ne 0 ]; then
    printf '[channels] Slack token override skipped (non-root) — channel guard will handle auth failure at runtime\n' >&2
    return 0
  fi

  local config_file="/sandbox/.openclaw/openclaw.json"
  local hash_file="/sandbox/.openclaw/.config-hash"

  # SECURITY: Refuse to write through symlinks to prevent symlink-following attacks.
  if [ -L "$config_file" ] || [ -L "$hash_file" ]; then
    printf '[SECURITY] Refusing Slack token override — config or hash path is a symlink\n' >&2
    return 1
  fi

  # SECURITY: Validate token prefixes — reject anything that doesn't look like a real Slack token.
  case "${SLACK_BOT_TOKEN}" in
    xoxb-*) ;;
    *)
      printf '[channels] SLACK_BOT_TOKEN does not start with xoxb- — skipping Slack placeholder resolution\n' >&2
      return 0
      ;;
  esac

  if [ -n "${SLACK_APP_TOKEN:-}" ]; then
    case "$SLACK_APP_TOKEN" in
      xapp-*) ;;
      *)
        printf '[channels] SLACK_APP_TOKEN does not start with xapp- — skipping Slack placeholder resolution\n' >&2
        return 0
        ;;
    esac
  else
    printf '[channels] Warning: SLACK_BOT_TOKEN is set but SLACK_APP_TOKEN is missing — Socket Mode requires both tokens\n' >&2
  fi

  printf '[channels] Resolving Slack token placeholders in openclaw.json\n' >&2

  # Relax 444 → 644 so writes succeed after CAP_DAC_OVERRIDE is dropped (#2653).
  # Re-lock in all exit paths so files are never left at 644 on failure.
  relax_config_for_write "$config_file" "$hash_file"
  local _write_rc=0

  SLACK_BOT_TOKEN="$SLACK_BOT_TOKEN" \
    SLACK_APP_TOKEN="${SLACK_APP_TOKEN:-}" \
    python3 - "$config_file" <<'PYSLACK' || _write_rc=$?
import json, os, re, sys

config_file = sys.argv[1]
bot_token = os.environ["SLACK_BOT_TOKEN"]
app_token = os.environ.get("SLACK_APP_TOKEN", "")
# json.dumps produces a quoted string; strip the outer quotes to get a
# JSON-safe value that can be spliced directly into the existing string literal.
bot_token_json = json.dumps(bot_token)[1:-1]
app_token_json = json.dumps(app_token)[1:-1]

with open(config_file) as f:
    content = f.read()

content = re.sub(
    r'("botToken"\s*:\s*")openshell:resolve:env:SLACK_BOT_TOKEN(")',
    lambda m: m.group(1) + bot_token_json + m.group(2),
    content,
)
if app_token:
    content = re.sub(
        r'("appToken"\s*:\s*")openshell:resolve:env:SLACK_APP_TOKEN(")',
        lambda m: m.group(1) + app_token_json + m.group(2),
        content,
    )

with open(config_file, "w") as f:
    f.write(content)
PYSLACK

  if [ "$_write_rc" -eq 0 ]; then
    if (cd /sandbox/.openclaw && sha256sum openclaw.json >"$hash_file"); then
      printf '[channels] Config hash recomputed after Slack token override\n' >&2
    else
      _write_rc=$?
    fi
  fi

  # Re-lock 644 → 444 — always runs, even on write/hash failure (#2653)
  lock_config_after_write "$config_file" "$hash_file"
  [ "$_write_rc" -eq 0 ] || return "$_write_rc"
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

install_slack_channel_guard() {
  local config_file="/sandbox/.openclaw/openclaw.json"

  # Only install if a Slack channel is configured
  if ! grep -q '"slack"' "$config_file" 2>/dev/null; then
    return 0
  fi

  printf '[channels] Installing Slack channel guard (unhandled-rejection safety net)\n' >&2

  emit_sandbox_sourced_file "$_SLACK_GUARD_SCRIPT" <<'SLACK_GUARD_EOF'
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// slack-channel-guard.js — catches unhandled promise rejections from Slack
// channel initialization so a single channel auth failure does not crash
// the entire OpenClaw gateway. Node v22 treats unhandled rejections as
// fatal (--unhandled-rejections=throw is the default), taking down
// inference, chat, and TUI alongside the failed Slack channel.
//
// This preload installs a process-level handler that detects Slack-specific
// rejections (by error code or stack trace) and logs a warning instead of
// crashing. Non-Slack rejections are re-thrown to preserve normal behavior.
//
// Ref: https://github.com/NVIDIA/NemoClaw/issues/2340

(function () {
  'use strict';

  // Slack-specific error codes from @slack/web-api that indicate auth failure.
  // These appear as error.code on the WebAPIRequestError or CodedError objects.
  var SLACK_AUTH_ERRORS = [
    'slack_webapi_platform_error',
    'slack_webapi_request_error',
    'slackbot_error',
  ];

  // Slack-specific error messages that indicate auth/token problems.
  var SLACK_AUTH_MESSAGES = [
    'invalid_auth',
    'not_authed',
    'token_revoked',
    'token_expired',
    'account_inactive',
    'missing_scope',
    'not_allowed_token_type',
    'An API error occurred: invalid_auth',
  ];

  function isSlackRejection(reason) {
    if (!reason) return false;

    // Check error code (Slack SDK sets .code on its errors)
    var code = reason.code || '';
    for (var i = 0; i < SLACK_AUTH_ERRORS.length; i++) {
      if (code === SLACK_AUTH_ERRORS[i]) return true;
    }

    // Check error message
    var msg = String(reason.message || reason);
    for (var j = 0; j < SLACK_AUTH_MESSAGES.length; j++) {
      if (msg.indexOf(SLACK_AUTH_MESSAGES[j]) !== -1) return true;
    }

    // Check stack trace for @slack/ packages
    var stack = reason.stack || '';
    if (stack.indexOf('@slack/') !== -1 || stack.indexOf('slack-') !== -1) {
      return true;
    }

    // Check for proxy/network errors targeting Slack domains.
    // When the network policy blocks or rejects connections to Slack
    // servers, the error comes from the HTTP client (CONNECT tunnel
    // failure), not from @slack/ code. The stack won't contain @slack/
    // but the error message or URL may reference the Slack hostname.
    if (msg.indexOf('slack.com') !== -1) {
      return true;
    }

    return false;
  }

  function handleSlackError(reason, source) {
    if (isSlackRejection(reason)) {
      var msg = (reason && reason.message) ? reason.message : String(reason);
      process.stderr.write(
        '[channels] [slack] provider failed to start: ' + msg +
        ' \u2014 ' + source + ' caught by safety net, gateway continues\n'
      );
      return true; // handled
    }
    return false;
  }

  // Catch async Slack errors (rejected promises from @slack/web-api).
  process.on('unhandledRejection', function (reason, promise) {
    if (handleSlackError(reason, 'unhandledRejection')) return;
    // Non-Slack: re-throw to preserve default --unhandled-rejections=throw.
    throw reason;
  });

  // Catch sync Slack errors (e.g., Bolt token format validation throws
  // synchronously when appToken doesn't start with xapp-).
  process.on('uncaughtException', function (err, origin) {
    if (handleSlackError(err, 'uncaughtException')) return;
    // Non-Slack: re-throw to preserve normal crash behavior.
    // Print the error first since re-throw inside uncaughtException handler
    // may not print the original stack.
    process.stderr.write(err.stack || String(err));
    process.stderr.write('\n');
    process.exit(1);
  });
})();
SLACK_GUARD_EOF

  export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require $_SLACK_GUARD_SCRIPT"
  printf '[channels] Slack channel guard installed (NODE_OPTIONS updated)\n' >&2
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
        tmp="$(mktemp)" || continue
        awk -v b="$marker_begin" -v e="$marker_end" \
          '$0==b{s=1;next} $0==e{s=0;next} !s' "$rc_file" >"$tmp" 2>/dev/null || {
          rm -f "$tmp"
          continue
        }
        cat "$tmp" >"$rc_file" 2>/dev/null || true
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
    [ -f "$rc_file" ] || continue
    # All writes use || true because Landlock may block writes even though
    # DAC (-w) says writable (#804) — same pattern as install_configure_guard.
    if grep -qF "$marker_begin" "$rc_file" 2>/dev/null; then
      local tmp
      tmp="$(mktemp)" || continue
      awk -v b="$marker_begin" -v e="$marker_end" \
        '$0==b{s=1;next} $0==e{s=0;next} !s' "$rc_file" >"$tmp" 2>/dev/null || {
        rm -f "$tmp"
        continue
      }
      printf '%s\n' "$snippet" >>"$tmp"
      cat "$tmp" >"$rc_file" 2>/dev/null || true
      rm -f "$tmp"
    else
      printf '\n%s\n' "$snippet" >>"$rc_file" 2>/dev/null || true
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
    config)
      case "$2" in
        set | unset)
          echo "Error: 'openclaw config $2' cannot modify config inside the sandbox." >&2
          echo "The sandbox config is read-only (Landlock enforced) for security." >&2
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
          echo "The sandbox config is read-only (Landlock enforced) for security." >&2
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
      # Block --local inside sandbox — it bypasses gateway protections and can
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
GUARD

  for rc_file in "${_SANDBOX_HOME}/.bashrc" "${_SANDBOX_HOME}/.profile"; do
    [ -f "$rc_file" ] || continue
    # Try to write the guard snippet. All writes use || true because
    # Landlock may block writes even though DAC (-w) says writable (#804).
    if grep -qF "$marker_begin" "$rc_file" 2>/dev/null; then
      local tmp
      tmp="$(mktemp)" || continue
      awk -v b="$marker_begin" -v e="$marker_end" \
        '$0==b{s=1;next} $0==e{s=0;next} !s' "$rc_file" >"$tmp" 2>/dev/null || {
        rm -f "$tmp"
        continue
      }
      printf '%s\n' "$snippet" >>"$tmp"
      cat "$tmp" >"$rc_file" 2>/dev/null || true
      rm -f "$tmp"
    else
      printf '\n%s\n' "$snippet" >>"$rc_file" 2>/dev/null || true
    fi
  done
  # Best-effort lock — Landlock may already enforce read-only.
  lock_rc_files "$_SANDBOX_HOME"
}

# validate_openclaw_symlinks / harden_openclaw_symlinks — thin wrappers
# around shared library functions for backward compatibility with callsites.
validate_openclaw_symlinks() {
  validate_config_symlinks /sandbox/.openclaw /sandbox/.openclaw-data
}

harden_openclaw_symlinks() {
  harden_config_symlinks /sandbox/.openclaw
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

harden_auth_profiles() {
  if [ -d "${HOME}/.openclaw" ]; then
    # Enforce 600 for all auth profiles across all agents
    find -L "${HOME}/.openclaw" -type f -name "auth-profiles.json" -exec chmod 600 {} + 2>/dev/null || true
  fi
}

# configure_messaging_channels is provided by sandbox-init.sh (shared).

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
# The JS is embedded inline rather than copied from
# nemoclaw-blueprint/scripts/http-proxy-fix.js because the blueprint
# scripts/ directory is intentionally excluded from the optimized sandbox
# build context — adding it cache-busts the `COPY nemoclaw-blueprint/`
# Dockerfile layer and hangs npm ci in k3s Docker-in-Docker. See
# src/lib/sandbox-build-context.ts. A sync test enforces that the
# embedded copy is byte-identical to the canonical file.
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
emit_sandbox_sourced_file "$_SANDBOX_SAFETY_NET" <<'SAFETY_NET_EOF'
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// sandbox-safety-net.js — last-resort handler that keeps the gateway alive
// when any library throws an uncaught exception or unhandled rejection.
//
// Contract:
//
//   1. Inside the OpenShell sandbox the gateway is shared infrastructure.
//      User-initiated actions (loading a plugin, starting a sidecar,
//      running an agent against the gateway) must not be able to take it
//      down. Node.js 22+ defaults --unhandled-rejections=throw which
//      crashes on the first stray rejection from any library — including
//      libraries we don't control.
//
//   2. Specific known-benign patterns are documented inline below. They
//      get a single-line summary and are absorbed silently. Each pattern
//      MUST document which library produces it, why it's safe to absorb
//      in the sandbox context, and what the upstream fix is. Prefer
//      disabling/configuring the upstream component so the rejection
//      never fires; this list is the safety net, not the policy.
//
//   3. Unknown errors do NOT crash the gateway either, but they are
//      logged with full stack so they can be diagnosed and either fixed
//      upstream or added to the allow-list with explicit justification.
//      "Unknown means crash" is the wrong default for shared
//      infrastructure; "unknown means log loudly" is the right default.
//
//   4. No process.exit interception. An earlier iteration intercepted
//      process.exit during swallow windows, which masked legitimate
//      shutdown signals and was itself the kind of catch-all hack we
//      want to avoid.
//
//   5. Only active when OPENSHELL_SANDBOX=1 (set by OpenShell at runtime),
//      and only for `openclaw gateway run …` invocations
//      (process.argv[2] === "gateway"). CLI commands (agent, doctor,
//      plugins, tui, etc.) get default Node behavior so errors surface
//      promptly to users running short-lived tools.

(function () {
  'use strict';
  if (process.env.OPENSHELL_SANDBOX !== '1') return;
  if (process.argv[2] !== 'gateway') return;

  // KNOWN-BENIGN ERROR PATTERNS
  //
  // ciao / @homebridge/ciao — mDNS service-discovery library used by the
  // OpenClaw bonjour plugin (introduced in 2026.4.15). Sandboxes have
  // restricted network namespaces with no multicast. Two failure modes:
  //   - sync: os.networkInterfaces() throws ERR_SYSTEM_ERROR
  //     uv_interface_addresses. Pre-empted by ciao-network-guard.js,
  //     which monkey-patches os.networkInterfaces() to return {}.
  //   - async: the probe state machine cancels itself during gateway
  //     startup/reload and emits "CIAO PROBING CANCELLED" as an unhandled
  //     rejection. This is the path we catch here.
  // Upstream fix: bonjour is disabled via plugins.entries.bonjour.enabled
  // = false in the sandbox openclaw.json. This pattern is a backstop in
  // case the disable is bypassed or a future release introduces another
  // mDNS code path.
  function classifyBenignRejection(reason) {
    if (!reason) return null;
    var msg = String((reason && reason.message) || reason);
    var stack = (reason && reason.stack) || '';

    if (msg.indexOf('CIAO') !== -1 ||
        stack.indexOf('@homebridge/ciao') !== -1 ||
        stack.indexOf('/ciao/') !== -1) {
      return 'ciao/mDNS (sandbox lacks multicast; bonjour should be disabled in openclaw.json)';
    }
    if (reason && reason.code === 'ERR_SYSTEM_ERROR' &&
        msg.indexOf('uv_interface_addresses') !== -1) {
      return 'uv_interface_addresses (restricted netns)';
    }
    return null;
  }

  process.on('uncaughtException', function (err, origin) {
    // Sync error paths are pre-empted by the targeted guards
    // (ciao-network-guard.js, slack-channel-guard.js when Slack is
    // configured). If we get here it's an error those guards didn't
    // recognize. Log full stack and stay alive — registering this
    // listener is what tells Node "don't crash on uncaughtException".
    try {
      process.stderr.write(
        '[sandbox-safety-net] uncaughtException [unhandled by upstream guards \u2014 please diagnose]: ' +
        ((err && err.stack) ? err.stack : String(err)) +
        ' (origin: ' + origin + ') \u2014 gateway continues\n'
      );
    } catch (_) {}
  });

  process.on('unhandledRejection', function (reason, promise) {
    var benign = classifyBenignRejection(reason);
    if (benign) {
      try {
        process.stderr.write(
          '[sandbox-safety-net] unhandledRejection [known-benign: ' + benign + ']: ' +
          ((reason && reason.message) ? reason.message : String(reason)) + '\n'
        );
      } catch (_) {}
      return;
    }
    try {
      process.stderr.write(
        '[sandbox-safety-net] unhandledRejection [UNKNOWN PATTERN \u2014 please diagnose]: ' +
        ((reason && reason.stack) ? reason.stack : String(reason)) +
        ' \u2014 gateway continues\n'
      );
    } catch (_) {}
  });
})();
SAFETY_NET_EOF
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require $_SANDBOX_SAFETY_NET"

_PROXY_FIX_SCRIPT="/tmp/nemoclaw-http-proxy-fix.js"
if [ "${NODE_USE_ENV_PROXY:-}" = "1" ]; then
  emit_sandbox_sourced_file "$_PROXY_FIX_SCRIPT" <<'HTTP_PROXY_FIX_EOF'
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// http-proxy-fix.js — http.request() wrapper resolving the double-proxy
// conflict between NODE_USE_ENV_PROXY=1 (Node.js 22+) and HTTP libraries
// that independently read HTTPS_PROXY (axios, follow-redirects,
// proxy-from-env). See NemoClaw#2109.
//
// Problem:
//   Node.js 22 with NODE_USE_ENV_PROXY=1 (baked into the OpenShell base
//   image) intercepts https.request() calls and handles proxying via a
//   CONNECT tunnel. HTTP libraries also read HTTPS_PROXY and configure
//   HTTP FORWARD mode, so the request is processed twice and the L7 proxy
//   rejects it with "FORWARD rejected: HTTPS requires CONNECT".
//
// Fix:
//   Wrap http.request() — the lowest common denominator every HTTP client
//   bottoms out at. Detect FORWARD-mode requests (hostname = proxy IP,
//   path = full https:// URL) and rewrite them as https.request() against
//   the real target host, letting NODE_USE_ENV_PROXY handle the CONNECT
//   tunnel correctly.
//
// Earlier PR #2110 tried a Module._load hook intercepting require('axios').
// That could not catch follow-redirects + proxy-from-env bundled as ESM in
// OpenClaw's dist/ — there are no require() calls to intercept. The
// http.request wrapper sits below all libraries and catches every path.
//
// This file is the canonical source for review and tests. At sandbox boot
// nemoclaw-start.sh writes an identical copy to /tmp/nemoclaw-http-proxy-fix.js
// and loads it via NODE_OPTIONS=--require. A sync test enforces byte-for-byte
// equality. The content cannot be baked into /opt/nemoclaw-blueprint/scripts/
// because adding files to the optimized sandbox build context cache-busts the
// `COPY nemoclaw-blueprint/` Dockerfile layer and hangs npm ci in k3s
// Docker-in-Docker — see src/lib/sandbox-build-context.ts.

(function () {
  'use strict';
  if (process.env.NODE_USE_ENV_PROXY !== '1') return;

  var http = require('http');
  var origRequest = http.request;

  var proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    '';
  var proxyHost = '';
  try {
    proxyHost = new URL(proxyUrl).hostname;
  } catch (_e) {
    /* no usable proxy configured */
  }
  if (!proxyHost) return;

  // Strip headers that were meaningful for the proxy hop only. Once we
  // re-issue against the target via https.request, the original Host
  // points at the proxy and the hop-by-hop headers (RFC 7230 §6.1) leak
  // upstream — they describe the connection between the caller and the
  // proxy, not the rewritten connection to the target.
  //
  // RFC 7230 §6.1 hop-by-hop set (request direction):
  //   Connection, Keep-Alive, Proxy-Authorization, TE, Trailer,
  //   Transfer-Encoding, Upgrade.
  // Also stripped: Host (points at the proxy); Proxy-Connection (de
  // facto deprecated header still emitted by some clients); and
  // Proxy-Authenticate (response-only per RFC 7235 §4.3, included
  // belt-and-suspenders for clients that echo response headers into
  // retry-request options). Plus: per RFC 7230 §6.1, any token named in
  // the Connection header is itself hop-by-hop and must be stripped.
  var STATIC_HOP_BY_HOP = [
    'host',
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'proxy-connection',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
  ];

  function sanitizeHeaders(headers) {
    if (!headers || typeof headers !== 'object') return undefined;
    // Collect tokens named in the Connection header — those become
    // hop-by-hop transitively per RFC 7230 §6.1.
    var dynamic = new Set();
    for (var k in headers) {
      if (
        !Object.prototype.hasOwnProperty.call(headers, k) ||
        String(k).toLowerCase() !== 'connection'
      ) {
        continue;
      }
      var raw = headers[k];
      var listed = Array.isArray(raw) ? raw.join(',') : raw;
      if (typeof listed === 'string') {
        listed.split(',').forEach(function (token) {
          var t = token.trim().toLowerCase();
          if (t) dynamic.add(t);
        });
      }
    }
    var staticSet = new Set(STATIC_HOP_BY_HOP);
    var out = {};
    for (var key in headers) {
      if (!Object.prototype.hasOwnProperty.call(headers, key)) continue;
      var lower = String(key).toLowerCase();
      if (staticSet.has(lower) || dynamic.has(lower)) continue;
      out[key] = headers[key];
    }
    return out;
  }

  http.request = function (options, callback) {
    if (typeof options === 'string' || !options) {
      return origRequest.apply(http, arguments);
    }
    if (
      options.hostname === proxyHost &&
      options.path &&
      options.path.startsWith('https://')
    ) {
      var target;
      try {
        target = new URL(options.path);
      } catch (_e) {
        return origRequest.apply(http, arguments);
      }
      var https = require('https');
      // Clone caller's options and overwrite proxy-specific routing
      // fields. Strip fields that were set up for the proxy hop and
      // would misbehave on the rewritten https.request to the target:
      //   - agent: a forward-proxy http.Agent cannot speak TLS. Leaving
      //     it attached caused upstreams like deepinfra to surface as
      //     "LLM request failed: network connection error" while other
      //     upstreams that don't end up on this code path still worked.
      //     On Node 22 https.request throws a synchronous TypeError; on
      //     Node 18/20 it falls through and the TLS handshake fails.
      //   - auth: basic-auth meant for the proxy hop. Leaving it on
      //     would Basic-auth the target server with proxy credentials.
      //   - servername / checkServerIdentity: TLS SNI + cert validation
      //     pre-computed for the proxy hop. Wrong cert chain and wrong
      //     SNI must not survive into the rewrite — drop them so Node
      //     re-derives from the new `hostname`.
      //   - socketPath: Unix-socket proxies exist (e.g. cntlm-style
      //     local proxies). Routing TLS bytes into the proxy's Unix
      //     socket would defeat the entire rewrite.
      //   - localAddress / lookup / family / hints: source-binding and
      //     DNS hints picked for reachability to the proxy. The
      //     rewritten target may not be reachable from the same NIC or
      //     DNS family.
      //   - Host / hop-by-hop headers (RFC 7230 §6.1): stripped via
      //     sanitizeHeaders so Node regenerates Host from `host`/`port`
      //     to point at the real target.
      // Signal (AbortController) and TLS material (ca/cert/key/
      // rejectUnauthorized), timeout, body, and target-intent headers
      // (Authorization, Content-Type, …) are preserved.
      var rewritten = Object.assign({}, options, {
        method: options.method || 'GET',
        hostname: target.hostname,
        host: target.hostname,
        port: target.port || 443,
        path: target.pathname + target.search,
        protocol: 'https:',
        headers: sanitizeHeaders(options.headers),
      });
      delete rewritten.agent;
      delete rewritten.auth;
      delete rewritten.servername;
      delete rewritten.checkServerIdentity;
      delete rewritten.socketPath;
      delete rewritten.localAddress;
      delete rewritten.lookup;
      delete rewritten.family;
      delete rewritten.hints;
      return https.request(rewritten, callback);
    }
    return origRequest.apply(http, arguments);
  };
})();
HTTP_PROXY_FIX_EOF
  export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require $_PROXY_FIX_SCRIPT"
fi

# Nemotron inference parameter injection (NemoClaw#1193, NemoClaw#2051).
# Nemotron models may return empty content (tool call instead of text) or
# thinking-only blocks (stalls the conversation) when the model's chat
# template produces an empty assistant turn. The vLLM / NIM chat template
# kwarg `force_nonempty_content` prevents this by ensuring the template
# always emits a non-empty content field.
#
# The preload wraps http.request() — the lowest common denominator every
# HTTP client bottoms out at — buffers the JSON body for POST requests
# to /v1/chat/completions, and injects the kwarg when the model ID
# contains "nemotron". Backends that do not recognise the extra field
# silently ignore it (OpenAI-compatible contract).
#
# Scoped strictly to Nemotron models: non-Nemotron requests pass through
# completely untouched.
_NEMOTRON_FIX_SCRIPT="/tmp/nemoclaw-nemotron-inference-fix.js"
emit_sandbox_sourced_file "$_NEMOTRON_FIX_SCRIPT" <<'NEMOTRON_FIX_EOF'
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// nemotron-inference-fix.js — inject chat_template_kwargs for Nemotron models.
//
// Problem (NemoClaw#1193, NemoClaw#2051):
//   Nemotron models sometimes generate tool calls instead of text for simple
//   queries, or return thinking-only blocks with stopReason "stop" that
//   OpenClaw treats as end-of-turn, causing the conversation to stall.
//   The root cause is the model's chat template producing empty assistant
//   content when tool definitions are present.
//
// Fix:
//   Inject `chat_template_kwargs: { force_nonempty_content: true }` into
//   /v1/chat/completions request bodies when the model ID contains
//   "nemotron". This tells the vLLM/NIM serving layer to force the chat
//   template to always produce non-empty content alongside any tool calls
//   or thinking blocks.
//
//   Scoped strictly to Nemotron models — all other requests pass through
//   untouched. Backends that do not support chat_template_kwargs silently
//   ignore the extra field per the OpenAI-compatible API contract.

(function () {
  'use strict';

  var http = require('http');
  var https = require('https');

  var NEMOTRON_RE = /nemotron/i;
  var COMPLETIONS_RE = /\/v1\/chat\/completions/;

  function wrapModule(mod) {
    var origRequest = mod.request;

    mod.request = function (options, callback) {
      // Only intercept object-form calls with a recognisable path.
      if (typeof options === 'string' || !options) {
        return origRequest.apply(mod, arguments);
      }

      var path = options.path || '';
      if (options.method !== 'POST' || !COMPLETIONS_RE.test(path)) {
        return origRequest.apply(mod, arguments);
      }

      // Create the real request, then intercept write/end to buffer the body.
      var req = origRequest.apply(mod, arguments);
      var origWrite = req.write;
      var origEnd = req.end;
      var chunks = [];
      var intercepted = false;

      req.write = function (chunk, encoding, cb) {
        if (chunk != null) {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk);
        }
        // Buffer instead of sending — we flush in end().
        if (typeof encoding === 'function') { encoding(); }
        else if (typeof cb === 'function') { cb(); }
        return true;
      };

      req.end = function (chunk, encoding, cb) {
        if (chunk != null && typeof chunk !== 'function') {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk);
        }
        // Resolve the callback argument (end has multiple overload signatures).
        var endCb = typeof chunk === 'function' ? chunk
          : typeof encoding === 'function' ? encoding
          : typeof cb === 'function' ? cb
          : null;

        var raw = Buffer.concat(chunks);
        try {
          var body = JSON.parse(raw.toString('utf-8'));
          if (body && body.model && NEMOTRON_RE.test(body.model)) {
            if (!body.chat_template_kwargs) {
              body.chat_template_kwargs = {};
            }
            body.chat_template_kwargs.force_nonempty_content = true;
            intercepted = true;
            var modified = Buffer.from(JSON.stringify(body), 'utf-8');
            // Update Content-Length so the proxy/server reads the full body.
            if (req.getHeader && req.setHeader) {
              req.removeHeader('content-length');
              req.setHeader('Content-Length', modified.length);
            }
            origWrite.call(req, modified);
          } else {
            // Not a Nemotron model — send original bytes unmodified.
            origWrite.call(req, raw);
          }
        } catch (_e) {
          // JSON parse failed — forward original bytes.
          origWrite.call(req, raw);
        }

        return endCb ? origEnd.call(req, endCb) : origEnd.call(req);
      };

      return req;
    };
  }

  wrapModule(http);
  wrapModule(https);
})();
NEMOTRON_FIX_EOF
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
emit_sandbox_sourced_file "$_CIAO_GUARD_SCRIPT" <<'CIAO_GUARD_EOF'
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// ciao-network-guard.js — prevents @homebridge/ciao mDNS library from
// crashing the gateway when os.networkInterfaces() fails in restricted
// sandbox network namespaces.

(function () {
  'use strict';

  // Monkey-patch os.networkInterfaces to return empty on failure.
  var os = require('os');
  var _origNetworkInterfaces = os.networkInterfaces;
  // Rate-limit the failure log. The bonjour watchdog inside ciao retries
  // advertising every few seconds, so a naive "log on every failure" fills
  // sandbox logs with hundreds of identical lines per hour. Log the first
  // failure (operator gets the actionable message) and at most one summary
  // every 5 minutes thereafter, with a suppression count so volume is
  // still observable. See GitHub issue #2611.
  var _failureCount = 0;
  var _lastLogMs = 0;
  var _suppressedSinceLog = 0;
  var _LOG_INTERVAL_MS = 5 * 60 * 1000;
  os.networkInterfaces = function () {
    try {
      return _origNetworkInterfaces.call(os);
    } catch (err) {
      _failureCount++;
      var nowMs = Date.now();
      var shouldLog = _failureCount === 1 || (nowMs - _lastLogMs) >= _LOG_INTERVAL_MS;
      if (shouldLog) {
        var suffix = _suppressedSinceLog > 0
          ? ' [' + _suppressedSinceLog + ' suppressed in last ~5min, ' + _failureCount + ' total]'
          : '';
        process.stderr.write(
          '[guard] os.networkInterfaces() failed: ' + (err.message || err) +
          ' — returning empty (mDNS disabled)' + suffix + '\n'
        );
        _lastLogMs = nowMs;
        _suppressedSinceLog = 0;
      } else {
        _suppressedSinceLog++;
      }
      return {};
    }
  };

  // Fallback: catch uncaughtException from ciao if the monkey-patch
  // doesn't cover all call sites. Gateway-only — registering ANY
  // uncaughtException listener tells Node "don't crash by default", and
  // we want CLI processes (agent, doctor, plugins, tui) to keep default
  // Node crash behavior so errors surface promptly.
  //
  // For gateway processes, non-ciao errors fall through (return) to the
  // sandbox safety net registered later in the preload chain. The safety
  // net is the single point of "keep gateway alive on unknown errors".
  if (process.argv[2] === 'gateway') {
    process.on('uncaughtException', function (err, origin) {
      if (
        err && err.code === 'ERR_SYSTEM_ERROR' &&
        String(err.message || '').indexOf('uv_interface_addresses') !== -1
      ) {
        process.stderr.write(
          '[guard] ciao/networkInterfaces crash caught: ' + (err.message || err) +
          ' \u2014 gateway continues\n'
        );
        return;
      }
      if (err && err.stack && err.stack.indexOf('ciao') !== -1 &&
          String(err.message || '').indexOf('networkInterfaces') !== -1) {
        process.stderr.write(
          '[guard] ciao network error caught: ' + (err.message || err) +
          ' \u2014 gateway continues\n'
        );
        return;
      }
      // Not ciao — let the sandbox safety net handle it.
    });
  }
})();
CIAO_GUARD_EOF
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require $_CIAO_GUARD_SCRIPT"

# WebSocket CONNECT tunnel fix (NemoClaw#1570).
# The `ws` library calls https.request() for wss:// WebSocket upgrades.
# EnvHttpProxyAgent (NODE_USE_ENV_PROXY=1) sends a forward proxy request
# instead of CONNECT — rejected by the L7 proxy with 400. Without
# NODE_USE_ENV_PROXY, ws goes direct — blocked by sandbox netns.
# The preload patches https.request() to inject a CONNECT tunnel agent for
# WebSocket upgrade requests. Activates whenever HTTPS_PROXY is set (the
# script itself guards on the env var).
_WS_FIX_SCRIPT="/opt/nemoclaw-blueprint/scripts/ws-proxy-fix.js"
if [ -f "$_WS_FIX_SCRIPT" ]; then
  export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require $_WS_FIX_SCRIPT"
fi

# OpenShell re-injects narrow NO_PROXY/no_proxy=127.0.0.1,localhost,::1 every
# time a user connects via `openshell sandbox connect`.  The connect path spawns
# `/bin/bash -i` (interactive, non-login), which sources ~/.bashrc — NOT
# ~/.profile or /etc/profile.d/*.
#
# The /sandbox home directory is Landlock read-only (#804), so we write the proxy
# config to /tmp/nemoclaw-proxy-env.sh. The pre-built .bashrc and .profile
# source this file automatically.
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
  # ciao network guard for connect sessions.
  echo "export NODE_OPTIONS=\"\${NODE_OPTIONS:+\$NODE_OPTIONS }--require $_CIAO_GUARD_SCRIPT\""
  # Slack channel guard for connect sessions. The guard file is installed later
  # by install_slack_channel_guard() — conditional on the file existing at
  # source-time so connect sessions started before Slack is configured are safe.
  echo "[ -f \"$_SLACK_GUARD_SCRIPT\" ] && export NODE_OPTIONS=\"\${NODE_OPTIONS:+\$NODE_OPTIONS }--require $_SLACK_GUARD_SCRIPT\""
  # Tool cache redirects — generated from _TOOL_REDIRECTS (single source of truth)
  echo '# Tool cache redirects — /sandbox is Landlock read-only (#804)'
  for _redir in "${_TOOL_REDIRECTS[@]}"; do
    echo "export ${_redir?}"
  done
} | emit_sandbox_sourced_file "$_PROXY_ENV_FILE"

# cleanup_on_signal is provided by sandbox-init.sh. It reads
# SANDBOX_CHILD_PIDS (array of all PIDs) and SANDBOX_WAIT_PID (the
# primary process whose exit status is returned).
# Each code path below sets these before registering the trap.
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
  if ! verify_config_integrity /sandbox/.openclaw; then
    echo "[SECURITY] Config integrity check failed — refusing to start (non-root mode)" >&2
    exit 1
  fi
  apply_model_override
  apply_cors_override
  apply_slack_token_override
  export_gateway_token
  install_configure_guard
  configure_messaging_channels
  install_slack_channel_guard
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
  harden_auth_profiles

  if [ ${#NEMOCLAW_CMD[@]} -gt 0 ]; then
    exec "${NEMOCLAW_CMD[@]}"
  fi

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
  validate_tmp_permissions "$_SANDBOX_SAFETY_NET" "$_PROXY_FIX_SCRIPT" "$_NEMOTRON_FIX_SCRIPT" "$_CIAO_GUARD_SCRIPT" "$_SLACK_GUARD_SCRIPT"

  # Start gateway in background, auto-pair, then wait
  nohup "$OPENCLAW" gateway run --port "${_DASHBOARD_PORT}" >/tmp/gateway.log 2>&1 &
  GATEWAY_PID=$!
  echo "[gateway] openclaw gateway launched (pid $GATEWAY_PID)" >&2
  # Diagnostic: mirror gateway log to PID 1's stderr — see root-mode block
  # below for rationale (NVIDIA/NemoClaw#2484).
  { tail -n +1 -F /tmp/gateway.log 2>/dev/null | sed -u 's/^/[gateway-log:] /' >&2; } &
  GATEWAY_LOG_TAIL_PID=$!
  # Persistent mirror: see root-mode block for rationale.
  mkdir -p /sandbox/.openclaw-data/logs 2>/dev/null || true
  { tail -n +1 -F /tmp/gateway.log 2>/dev/null >>/sandbox/.openclaw-data/logs/gateway-persistent.log; } &
  GATEWAY_LOG_PERSIST_PID=$!
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

# Verify config integrity before starting anything
verify_config_integrity /sandbox/.openclaw
apply_model_override
apply_cors_override
apply_slack_token_override
export_gateway_token
install_configure_guard

# Inject messaging channel config if provider tokens are present.
# Must run AFTER integrity check (to detect build-time tampering) and
# BEFORE chattr +i (which locks the config permanently).
configure_messaging_channels
install_slack_channel_guard

# Write auth profile as sandbox user (needs writable .openclaw-data)
# and recursively re-tighten any auth-profiles.json files under ~/.openclaw.
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
# `/sandbox/.openclaw/workspace-<name>/` directory. Without intervention these
# land as real directories under the root-owned immutable `.openclaw/` tree and
# are lost on every sandbox restart.
#
# Mirror the default-workspace persistence pattern: any `workspace-<name>`
# discovered under `.openclaw-data/` or `.openclaw/` gets (a) a writable backing
# dir under `.openclaw-data/workspace-<name>/` and (b) a symlink from
# `.openclaw/workspace-<name>/ → .openclaw-data/workspace-<name>/`. The symlinks
# are then picked up by validate_openclaw_symlinks below.
#
# Ref: https://github.com/NVIDIA/NemoClaw/issues/1260
provision_agent_workspaces() {
  local data_dir="/sandbox/.openclaw-data"
  local config_dir="/sandbox/.openclaw"
  local names=""
  local d name

  # Discover existing workspace-* dirs in either location.
  if [ -d "$data_dir" ]; then
    for d in "$data_dir"/workspace-*/; do
      [ -d "$d" ] || continue
      name="$(basename "$d")"
      names="${names} ${name}"
    done
  fi
  if [ -d "$config_dir" ]; then
    for d in "$config_dir"/workspace-*/; do
      # Skip the glob-fell-through sentinel ('workspace-*/' itself) and
      # any existing symlink (already provisioned).
      [ -e "$d" ] || continue
      [ -L "${d%/}" ] && continue
      name="$(basename "$d")"
      names="${names} ${name}"
    done
  fi

  local seen=""
  for name in $names; do
    case " $seen " in *" $name "*) continue ;; esac
    seen="${seen} ${name}"

    local data_path="$data_dir/$name"
    local link_path="$config_dir/$name"

    mkdir -p "$data_path"
    chown -R sandbox:sandbox "$data_path" 2>/dev/null || true

    if [ -L "$link_path" ]; then
      continue
    fi
    if [ -e "$link_path" ]; then
      cp -a "$link_path/." "$data_path/" 2>/dev/null || true
      rm -rf "$link_path"
    fi
    ln -s "$data_path" "$link_path"
    echo "[setup] provisioned multi-agent workspace: $name → $data_path" >&2
  done
}
provision_agent_workspaces

# Verify ALL symlinks in .openclaw point to expected .openclaw-data targets.
# Dynamic scan so future OpenClaw symlinks are covered automatically.
validate_openclaw_symlinks

# Lock .openclaw directory after symlink validation: set the immutable flag
# so symlinks cannot be swapped at runtime even if DAC or Landlock are
# bypassed. chattr requires cap_linux_immutable which the entrypoint has
# as root; the sandbox user cannot remove the flag.
# Ref: https://github.com/NVIDIA/NemoClaw/issues/1019
harden_openclaw_symlinks

# Defence-in-depth: verify /tmp file permissions before launching services.
# Pass the HTTP proxy-fix path so it is validated alongside proxy-env.sh
# (both are trust-boundary files; tampering would let the sandbox user
# inject code into any Node process via NODE_OPTIONS).
validate_tmp_permissions "$_SANDBOX_SAFETY_NET" "$_PROXY_FIX_SCRIPT" "$_NEMOTRON_FIX_SCRIPT" "$_CIAO_GUARD_SCRIPT" "$_SLACK_GUARD_SCRIPT"

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
# /sandbox/.openclaw-data/logs which is volume-mounted by openshell and
# survives pod restarts. /tmp/gateway.log itself is wiped when the pod
# restarts (TC-SBX-06 docker-kills the gateway container), so the
# only durable record of pre-restart events lives here. The diag
# streamer in the e2e workflow snapshots this file post-test.
mkdir -p /sandbox/.openclaw-data/logs 2>/dev/null || true
chown gateway:gateway /sandbox/.openclaw-data/logs 2>/dev/null || true
{ tail -n +1 -F /tmp/gateway.log 2>/dev/null >>/sandbox/.openclaw-data/logs/gateway-persistent.log; } &
GATEWAY_LOG_PERSIST_PID=$!

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
