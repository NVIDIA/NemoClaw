#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Managed Deep Agents Code launcher for NemoClaw/OpenShell sandboxes.

set -euo pipefail

export HOME=/sandbox
export PATH="/usr/local/bin:${PATH}"
export DEEPAGENTS_CODE_NO_UPDATE_CHECK=1
export DEEPAGENTS_CODE_AUTO_UPDATE=0
export DEEPAGENTS_CODE_OPENAI_API_KEY="${DEEPAGENTS_CODE_OPENAI_API_KEY:-nemoclaw-managed-inference}"
export OPENAI_BASE_URL="${OPENAI_BASE_URL:-https://inference.local/v1}"

readonly DEEPAGENTS_ENV_FILE="/sandbox/.deepagents/.env"

run_dcode() {
  exec python3 -m deepagents_code "$@"
}

is_managed_secret_name() {
  case "$1" in
    SLACK_BOT_TOKEN | SLACK_APP_TOKEN) return 0 ;;
    TELEGRAM_BOT_TOKEN | DISCORD_BOT_TOKEN) return 0 ;;
    *) return 1 ;;
  esac
}

trim_whitespace() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

is_secret_shaped_value() {
  local value="$1"
  local len=${#value}
  case "$value" in
    sk-proj-* | sk-ant-*)
      [ "$len" -ge 18 ] && return 0
      ;;
    sk-* | nvapi-* | nvcf-* | ghp_* | github_pat_* | hf_* | glpat-* | gsk_* | pypi-*)
      [ "$len" -ge 20 ] && return 0
      ;;
    xoxb-* | xoxp-* | xoxa-* | xoxs-* | xapp-*)
      [ "$len" -ge 15 ] && return 0
      ;;
    AKIA* | ASIA*)
      [ "$len" -ge 20 ] && return 0
      ;;
  esac
  if [[ "$value" =~ ^bot[0-9]{8,10}:[A-Za-z0-9_-]{35}$ ]]; then
    return 0
  fi
  if [[ "$value" =~ ^[0-9]{8,10}:[A-Za-z0-9_-]{35}$ ]]; then
    return 0
  fi
  if [[ "$value" =~ ^[A-Za-z0-9]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}$ ]]; then
    return 0
  fi
  return 1
}

refuse_secret_env() {
  local source="$1"
  local name="$2"
  printf 'dcode: refusing to start — %s contains a secret-shaped value in %s.\n' "$source" "$name" >&2
  printf "  Remove it from the environment, or use 'nemoclaw credentials' to register provider keys.\n" >&2
  exit 2
}

assert_no_secret_runtime_env() {
  local name value
  for name in $(compgen -e); do
    is_managed_secret_name "$name" && continue
    value="${!name}"
    if is_secret_shaped_value "$value"; then
      refuse_secret_env "runtime environment variable" "$name"
    fi
  done
}

assert_no_secret_env_file() {
  local env_file="$DEEPAGENTS_ENV_FILE"
  [ -r "$env_file" ] || return 0
  local -a lines=()
  local line key value
  while IFS= read -r line || [ -n "$line" ]; do
    lines+=("$line")
  done <"$env_file"
  for line in "${lines[@]}"; do
    line="${line%$'\r'}"
    line="$(trim_whitespace "$line")"
    [ -n "$line" ] || continue
    case "$line" in \#*) continue ;; esac
    key="${line%%=*}"
    [ "$key" != "$line" ] || continue
    value="${line#*=}"
    key="$(trim_whitespace "$key")"
    value="$(trim_whitespace "$value")"
    case "$value" in
      \"*\")
        value="${value#\"}"
        value="${value%\"}"
        ;;
      \'*\')
        value="${value#\'}"
        value="${value%\'}"
        ;;
    esac
    value="$(trim_whitespace "$value")"
    is_managed_secret_name "$key" && continue
    if is_secret_shaped_value "$value"; then
      refuse_secret_env "$env_file" "$key"
    fi
  done
}

assert_no_secret_runtime_env
assert_no_secret_env_file

case "${1:-}" in
  --version | -v | -V | --help | -h)
    run_dcode "$@"
    ;;
esac

unset DEEPAGENTS_CODE_SHELL_ALLOW_LIST

reject_managed_override() {
  local posture="$1"
  local arg="$2"
  printf 'NemoClaw manages Deep Agents Code %s; remove %s and use NemoClaw policy/configuration instead.\n' "$posture" "$arg" >&2
  exit 2
}

if [ "${1:-}" = "mcp" ]; then
  reject_managed_override "MCP posture" "mcp"
fi

for arg in "$@"; do
  case "$arg" in
    --sandbox | --sandbox=*)
      reject_managed_override "sandbox isolation" "$arg"
      ;;
    --sandbox-id | --sandbox-id=*)
      reject_managed_override "sandbox isolation" "$arg"
      ;;
    --sandbox-snapshot-name | --sandbox-snapshot-name=*)
      reject_managed_override "sandbox isolation" "$arg"
      ;;
    --sandbox-setup | --sandbox-setup=*)
      reject_managed_override "sandbox isolation" "$arg"
      ;;
    --mcp-config | --mcp-config=* | --trust-project-mcp | --no-mcp=*)
      reject_managed_override "MCP posture" "$arg"
      ;;
    --shell-allow-list | --shell-allow-list=* | -S | -S?*)
      reject_managed_override "shell allow-list posture" "$arg"
      ;;
  esac
done

extra_args=(--sandbox none --no-mcp)

run_dcode "${extra_args[@]}" "$@"
