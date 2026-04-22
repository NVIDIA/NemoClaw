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
  # Any of these env vars trigger a config patch
  [ -n "${NEMOCLAW_MODEL_OVERRIDE:-}" ] \
    || [ -n "${NEMOCLAW_INFERENCE_API_OVERRIDE:-}" ] \
    || [ -n "${NEMOCLAW_CONTEXT_WINDOW:-}" ] \
    || [ -n "${NEMOCLAW_MAX_TOKENS:-}" ] \
    || [ -n "${NEMOCLAW_REASONING:-}" ] \
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

  NEMOCLAW_CONTEXT_WINDOW="$context_window" \
    NEMOCLAW_MAX_TOKENS="$max_tokens" \
    NEMOCLAW_REASONING="$reasoning" \
    python3 - "$config_file" "$model_override" "$api_override" <<'PYOVERRIDE'
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

  # Recompute config hash so integrity check passes on next startup
  (cd /sandbox/.openclaw && sha256sum openclaw.json >"$hash_file")
  printf '[SECURITY] Config hash recomputed after model override\n' >&2
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

  python3 - "$config_file" "$cors_origin" <<'PYCORS'
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

  (cd /sandbox/.openclaw && sha256sum openclaw.json >"$hash_file")
  printf '[config] Config hash recomputed after CORS override\n' >&2
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

  # SECURITY: Only root can write to /sandbox/.openclaw (root:root 444).
  if [ "$(id -u)" -ne 0 ]; then
    printf '[SECURITY] Slack token override ignored — requires root (non-root mode cannot write to config)\n' >&2
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

  SLACK_BOT_TOKEN="$SLACK_BOT_TOKEN" \
    SLACK_APP_TOKEN="${SLACK_APP_TOKEN:-}" \
    python3 - "$config_file" <<'PYSLACK'
import json, os, sys

config_file = sys.argv[1]
bot_token = os.environ["SLACK_BOT_TOKEN"]
app_token = os.environ.get("SLACK_APP_TOKEN", "")
placeholder_prefix = "openshell:resolve:env:"

with open(config_file) as f:
    cfg = json.load(f)

slack = cfg.get("channels", {}).get("slack", {})
default_acct = slack.get("accounts", {}).get("default", {})

if default_acct.get("botToken", "").startswith(placeholder_prefix):
    default_acct["botToken"] = bot_token
if app_token and default_acct.get("appToken", "").startswith(placeholder_prefix):
    default_acct["appToken"] = app_token

with open(config_file, "w") as f:
    json.dump(cfg, f, indent=2)
PYSLACK

  (cd /sandbox/.openclaw && sha256sum openclaw.json >"$hash_file")
  printf '[channels] Config hash recomputed after Slack token override\n' >&2
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
  # Final lock after all rc-file mutations (export_gateway_token + this
  # function) are complete so Landlock read_only enforcement holds.
  for rc_file in "${_SANDBOX_HOME}/.bashrc" "${_SANDBOX_HOME}/.profile"; do
    [ -f "$rc_file" ] && chmod 444 "$rc_file"
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

harden_auth_profiles() {
  if [ -d "${HOME}/.openclaw" ]; then
    # Enforce 600 for all auth profiles across all agents
    find -L "${HOME}/.openclaw" -type f -name "auth-profiles.json" -exec chmod 600 {} + 2>/dev/null || true
  fi
}

configure_messaging_channels() {
  # Channel entries are baked into openclaw.json at image build time via
  # NEMOCLAW_MESSAGING_CHANNELS_B64 (see Dockerfile).
  #
  # Telegram/Discord: placeholder tokens (openshell:resolve:env:*) flow through
  # to API calls where the L7 proxy rewrites them with real secrets at egress.
  # Real tokens are never visible inside the sandbox for these channels.
  #
  # Slack: apply_slack_token_override (runs before this function) resolves
  # SLACK_BOT_TOKEN/SLACK_APP_TOKEN placeholders directly into openclaw.json so
  # Bolt's in-process token validation passes. Both env vars are unset before the
  # gateway starts (root path) so they do not leak into the sandbox process env.
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

# axios + NODE_USE_ENV_PROXY double-proxy fix (NemoClaw#2109).
# Node.js 22 sets NODE_USE_ENV_PROXY=1 in the OpenShell base image, which
# intercepts all https.request() calls and handles proxy via CONNECT tunnel.
# axios also reads HTTPS_PROXY, causing a double-proxy conflict that produces
# malformed URLs (https://host:3128/) rejected by the L7 proxy.
# The preload script disables axios's own proxy handling so NODE_USE_ENV_PROXY
# takes over — the correct path for all other Node.js HTTP clients.
_AXIOS_FIX_SCRIPT="/opt/nemoclaw-blueprint/scripts/axios-proxy-fix.js"
if [ -f "$_AXIOS_FIX_SCRIPT" ] && [ "${NODE_USE_ENV_PROXY:-}" = "1" ]; then
  export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require $_AXIOS_FIX_SCRIPT"
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
  # axios double-proxy fix: also expose NODE_OPTIONS in connect sessions so that
  # interactive shells and user commands started via `openshell sandbox connect`
  # also benefit from the preload. (NemoClaw#2109)
  if [ -f "$_AXIOS_FIX_SCRIPT" ] && [ "${NODE_USE_ENV_PROXY:-}" = "1" ]; then
    echo "export NODE_OPTIONS=\"\${NODE_OPTIONS:+\$NODE_OPTIONS }--require $_AXIOS_FIX_SCRIPT\""
  fi
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
  apply_model_override
  apply_cors_override
  apply_slack_token_override
  # SECURITY: apply_slack_token_override is a no-op when non-root.
  # If SLACK_BOT_TOKEN is still set here the placeholder was never resolved —
  # Bolt will crash with invalid_auth at startup. Fail fast with a clear message.
  if [ -n "${SLACK_BOT_TOKEN:-}" ]; then
    printf '[SECURITY] Slack Socket Mode requires a root container — SLACK_BOT_TOKEN is set but token placeholder resolution needs root. Run the container as root or remove SLACK_BOT_TOKEN.\n' >&2
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
  harden_auth_profiles

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
  nohup "$OPENCLAW" gateway run --port "${_DASHBOARD_PORT}" >/tmp/gateway.log 2>&1 &
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
apply_model_override
apply_cors_override
apply_slack_token_override
export_gateway_token
install_configure_guard

# Inject messaging channel config if provider tokens are present.
# Must run AFTER integrity check (to detect build-time tampering) and
# BEFORE chattr +i (which locks the config permanently).
configure_messaging_channels

# SECURITY: Slack tokens were resolved into openclaw.json by apply_slack_token_override.
# Unset here — before any gosu sandbox child — so neither the sandbox user nor
# the gateway inherits them from the process environment.
unset SLACK_BOT_TOKEN SLACK_APP_TOKEN

# Write auth profile as sandbox user (needs writable .openclaw-data)
# and recursively re-tighten any auth-profiles.json files under ~/.openclaw.
gosu sandbox bash -c "$(declare -f write_auth_profile harden_auth_profiles); write_auth_profile; harden_auth_profiles"

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
nohup gosu gateway "$OPENCLAW" gateway run --port "${_DASHBOARD_PORT}" >/tmp/gateway.log 2>&1 &
GATEWAY_PID=$!
echo "[gateway] openclaw gateway launched as 'gateway' user (pid $GATEWAY_PID)" >&2
trap cleanup SIGTERM SIGINT

start_auto_pair
print_dashboard_urls

# Keep container running by waiting on the gateway process.
# This script is PID 1 (ENTRYPOINT); if it exits, Docker kills all children.
wait "$GATEWAY_PID"
