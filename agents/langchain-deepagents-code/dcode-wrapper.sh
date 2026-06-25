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

# SECURITY: dcode runtime/.env secret guard.
# - Invalid state: a user-controlled runtime env var or /sandbox/.deepagents/.env
#   entry can inject a provider secret into Deep Agents Code, bypassing the
#   managed inference plane and `nemoclaw credentials`.
# - Source boundary: upstream `deepagents_code` is third-party Python; the
#   canonical secret-pattern contract lives at src/lib/security/secret-patterns.ts.
#   Neither is callable from the Bash wrapper before exec, so this matcher
#   mirrors the canonical TOKEN_PREFIX_PATTERNS in shell.
# - Regression: the parity test in
#   test/langchain-deepagents-code-image.test.ts imports the canonical
#   TOKEN_PREFIX_PATTERNS and pins its length; any new entry trips the test and
#   forces this matcher (and its sample list) to update.
# - Removal condition: drop this guard when (a) upstream `deepagents_code` itself
#   rejects secret-shaped runtime/.env values, or (b) all dcode invocations
#   route through a Node entrypoint that imports the canonical patterns directly.

is_managed_token_value_for_name() {
  local name="$1"
  local value="$2"
  local len=${#value}
  case "$name" in
    SLACK_BOT_TOKEN)
      case "$value" in
        xoxb-*)
          [ "$len" -ge 15 ] && return 0
          ;;
      esac
      ;;
    SLACK_APP_TOKEN)
      case "$value" in
        xapp-*)
          [ "$len" -ge 15 ] && return 0
          ;;
      esac
      ;;
    TELEGRAM_BOT_TOKEN)
      if [[ "$value" =~ ^bot[0-9]{8,10}:[A-Za-z0-9_-]{35}$ ]]; then
        return 0
      fi
      if [[ "$value" =~ ^[0-9]{8,10}:[A-Za-z0-9_-]{35}$ ]]; then
        return 0
      fi
      ;;
    DISCORD_BOT_TOKEN)
      if [[ "$value" =~ ^[A-Za-z0-9]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}$ ]]; then
        return 0
      fi
      ;;
  esac
  return 1
}

trim_whitespace() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

is_secret_shaped_value() {
  local value="$1"
  if [[ "$value" =~ (sk-proj-|sk-ant-)[A-Za-z0-9_-]{10,} ]]; then
    return 0
  fi
  if [[ "$value" =~ sk-[A-Za-z0-9_-]{20,} ]]; then
    return 0
  fi
  if [[ "$value" =~ (nvapi-|nvcf-|ghp_|hf_|glpat-|gsk_|pypi-)[A-Za-z0-9_-]{10,} ]]; then
    return 0
  fi
  if [[ "$value" =~ github_pat_[A-Za-z0-9_]{30,} ]]; then
    return 0
  fi
  if [[ "$value" =~ xox[bpas]-[A-Za-z0-9_-]{10,} ]]; then
    return 0
  fi
  if [[ "$value" =~ xapp-[A-Za-z0-9_-]{10,} ]]; then
    return 0
  fi
  if [[ "$value" =~ A(K|S)IA[A-Z0-9]{16} ]]; then
    return 0
  fi
  if [[ "$value" =~ bot[0-9]{8,10}:[A-Za-z0-9_-]{35} ]]; then
    return 0
  fi
  if [[ "$value" =~ [0-9]{8,10}:[A-Za-z0-9_-]{35} ]]; then
    return 0
  fi
  if [[ "$value" =~ [A-Za-z0-9]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,} ]]; then
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
  local pair name value
  while IFS= read -r -d '' pair; do
    name="${pair%%=*}"
    [ "$name" != "$pair" ] || continue
    value="${pair#*=}"
    if is_managed_token_value_for_name "$name" "$value"; then
      continue
    fi
    if is_secret_shaped_value "$value"; then
      refuse_secret_env "runtime environment variable" "$name"
    fi
  done < <(env -0)
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
    if is_managed_token_value_for_name "$key" "$value"; then
      continue
    fi
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
