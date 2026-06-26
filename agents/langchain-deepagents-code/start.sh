#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# NemoClaw sandbox entrypoint for LangChain Deep Agents Code.

set -euo pipefail

export HOME=/sandbox
export PATH="/usr/local/bin:/opt/venv/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin"
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
    printf '%s\n' 'export PATH="/usr/local/bin:/opt/venv/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin"'
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

# With no command, this invocation IS the sandbox's long-running entrypoint.
# Deep Agents Code is a terminal-runtime agent invoked on demand via
# `openshell sandbox exec`, so the entrypoint has no daemon to run and must
# stay alive as a stable foreground process. A bare `/bin/bash` exits
# immediately in a non-interactive sandbox (no TTY, EOF on stdin), leaving the
# sandbox with no persistent process: OpenShell then flaps it into the Error
# phase, which breaks the Docker GPU-patch supervisor reconnect and leaves GPU
# posture unreliable (#5717). Idle forever instead so the sandbox stays Ready.
if [ "$#" -eq 0 ]; then
  printf '%s\n' 'Setting up NemoClaw Deep Agents Code runtime...'
  exec tail -f /dev/null
fi

exec "$@"
