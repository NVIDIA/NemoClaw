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
  } >"$tmp"
  chmod 400 "$tmp"
  mv -f "$tmp" "$target"
}

prepare_runtime_env

if [ "$#" -eq 0 ]; then
  set -- /bin/bash
fi

exec "$@"
