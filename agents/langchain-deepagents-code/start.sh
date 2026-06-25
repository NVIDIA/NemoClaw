#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# NemoClaw sandbox entrypoint for LangChain Deep Agents Code.

set -euo pipefail

export HOME=/sandbox
export PATH="/usr/local/bin:${PATH}"
export DEEPAGENTS_CODE_NO_UPDATE_CHECK=1
export DEEPAGENTS_CODE_AUTO_UPDATE=0
export DEEPAGENTS_CODE_OPENAI_API_KEY="${DEEPAGENTS_CODE_OPENAI_API_KEY:-nemoclaw-managed-inference}"
export OPENAI_BASE_URL="${OPENAI_BASE_URL:-https://inference.local/v1}"

write_export_if_set() {
  local name="$1"
  local value="${!name:-}"
  [ -n "$value" ] || return 0
  printf 'export %s=%q\n' "$name" "$value"
}

is_credential_bearing_url() {
  local value="$1"
  case "$value" in
    *://*@*) return 0 ;;
    *:*@*) return 0 ;;
    *) return 1 ;;
  esac
}

write_proxy_export_pair() {
  local primary="$1"
  local secondary="$2"
  local name
  local value
  local has_credentials=0
  for name in "$primary" "$secondary"; do
    value="${!name:-}"
    [ -n "$value" ] || continue
    if is_credential_bearing_url "$value"; then
      printf 'Skipping %s in Deep Agents Code runtime env because the proxy URL contains credentials.\n' "$name" >&2
      has_credentials=1
    fi
  done
  if [ "$has_credentials" -eq 1 ]; then
    unset "$primary" "$secondary"
    return 0
  fi
  write_export_if_set "$primary"
  write_export_if_set "$secondary"
}

is_messaging_env_key_allowed() {
  case "$1" in
    TELEGRAM_BOT_TOKEN | TELEGRAM_ALLOWED_USERS | DISCORD_BOT_TOKEN | NEMOCLAW_DISCORD_GUILD_IDS) return 0 ;;
    DISCORD_ALLOWED_USERS | DISCORD_ALLOW_ALL_USERS | SLACK_BOT_TOKEN | SLACK_APP_TOKEN) return 0 ;;
    SLACK_ALLOWED_USERS | SLACK_ALLOWED_CHANNELS) return 0 ;;
    *) return 1 ;;
  esac
}

load_messaging_env() {
  local env_file="/sandbox/.deepagents/.env"
  local line key value
  [ -r "$env_file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    [ -n "$line" ] || continue
    case "$line" in \#*) continue ;; esac
    key="${line%%=*}"
    if [ "$key" = "$line" ] || ! is_messaging_env_key_allowed "$key"; then
      printf 'Skipping invalid Deep Agents Code messaging env line for key %s.\n' "$key" >&2
      continue
    fi
    value="${line#*=}"
    export "$key=$value"
  done <"$env_file"
}

prepare_runtime_env() {
  local target=/tmp/nemoclaw-proxy-env.sh
  local tmp
  tmp="$(mktemp /tmp/nemoclaw-proxy-env.XXXXXX)"
  {
    printf '%s\n' 'export HOME=/sandbox'
    # shellcheck disable=SC2016
    printf '%s\n' 'export PATH="/usr/local/bin:${PATH}"'
    printf '%s\n' 'export DEEPAGENTS_CODE_NO_UPDATE_CHECK=1'
    printf '%s\n' 'export DEEPAGENTS_CODE_AUTO_UPDATE=0'
    # shellcheck disable=SC2016
    printf '%s\n' 'export DEEPAGENTS_CODE_OPENAI_API_KEY="${DEEPAGENTS_CODE_OPENAI_API_KEY:-nemoclaw-managed-inference}"'
    # shellcheck disable=SC2016
    printf '%s\n' 'export OPENAI_BASE_URL="${OPENAI_BASE_URL:-https://inference.local/v1}"'
    write_proxy_export_pair HTTP_PROXY http_proxy
    write_proxy_export_pair HTTPS_PROXY https_proxy
    write_export_if_set NO_PROXY
    write_export_if_set no_proxy
    write_export_if_set SSL_CERT_FILE
    write_export_if_set REQUESTS_CA_BUNDLE
    write_export_if_set NODE_EXTRA_CA_CERTS
    write_export_if_set LANGSMITH_TRACING
    write_export_if_set LANGSMITH_PROJECT
    write_export_if_set DEEPAGENTS_CODE_LANGSMITH_PROJECT
    write_export_if_set TELEGRAM_BOT_TOKEN
    write_export_if_set TELEGRAM_ALLOWED_USERS
    write_export_if_set DISCORD_BOT_TOKEN
    write_export_if_set NEMOCLAW_DISCORD_GUILD_IDS
    write_export_if_set DISCORD_ALLOWED_USERS
    write_export_if_set DISCORD_ALLOW_ALL_USERS
    write_export_if_set SLACK_BOT_TOKEN
    write_export_if_set SLACK_APP_TOKEN
    write_export_if_set SLACK_ALLOWED_USERS
    write_export_if_set SLACK_ALLOWED_CHANNELS
  } >"$tmp"
  chmod 400 "$tmp"
  mv -f "$tmp" "$target"
}

load_messaging_env
prepare_runtime_env

# With no command, this invocation IS the sandbox's long-running entrypoint.
# Deep Agents Code is a terminal-runtime agent invoked on demand via
# `openshell sandbox exec`, so the entrypoint has no daemon to run and must
# stay alive as a stable foreground process. A bare `/bin/bash` exits
# immediately in a non-interactive sandbox (no TTY, EOF on stdin), leaving the
# sandbox with no persistent process: OpenShell then flaps it into the Error
# phase, which breaks the Docker GPU-patch supervisor reconnect and leaves GPU
# posture unreliable (#5717). Idle forever instead so the sandbox stays Ready.
if [ "$#" -eq 0 ]; then
  exec sleep infinity
fi

exec "$@"
