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

# Invalid state: OpenShell's sandbox-create environment contains the host proxy
# seed, including NO_PROXY=inference.local, so dcode bypasses the managed proxy
# and attempts direct DNS resolution that is not part of the dcode contract.
# Source boundary: that seed remains correct for OpenShell's host-side proxy
# chaining; this agent-owned runtime boundary is the first safe place to replace
# it without changing OpenClaw, Hermes, or global OpenShell route provisioning.
# Source-fix constraint: inference.local is an L7 managed-proxy route, so adding
# sandbox DNS/hosts state or changing the shared seed would widen this fix and
# break the host chaining contract. Direct DNS/hosts resolution is not required.
# Regression: focused tests and the live check cover login-shell, direct dcode,
# and connect paths when the direct DNS/hosts lookup is absent.
# Removal condition: remove this normalization only when OpenShell guarantees
# the managed proxy and normalized NO_PROXY for every sandbox exec/login process,
# or when dcode no longer uses inference.local.
readonly MANAGED_PROXY_HOST_FILE="/usr/local/share/nemoclaw/dcode-proxy-host"
readonly MANAGED_PROXY_PORT_FILE="/usr/local/share/nemoclaw/dcode-proxy-port"
readonly MANAGED_PROXY_OWNER_UID=0

managed_proxy_file_metadata() {
  local file="$1"
  local metadata
  if metadata="$(stat -c '%u:%a' "$file" 2>/dev/null)"; then
    printf '%s' "$metadata"
  else
    stat -f '%u:%Lp' "$file" 2>/dev/null
  fi
}

read_managed_proxy_value() {
  local file="$1"
  local name="$2"
  local metadata
  local value
  if [ ! -f "$file" ] || [ -L "$file" ] || [ ! -r "$file" ]; then
    printf 'Missing or unsafe trusted managed proxy %s file.\n' "$name" >&2
    return 1
  fi
  metadata="$(managed_proxy_file_metadata "$file")" || {
    printf 'Cannot inspect trusted managed proxy %s file.\n' "$name" >&2
    return 1
  }
  if [ "$metadata" != "${MANAGED_PROXY_OWNER_UID}:444" ]; then
    printf 'Unsafe ownership or mode on trusted managed proxy %s file.\n' "$name" >&2
    return 1
  fi
  value="$(<"$file")"
  printf '%s' "$value"
}

# Fail closed if the root-owned image contract is missing. Process-level
# NEMOCLAW_PROXY_* values are not a trusted runtime routing source.
PROXY_HOST="$(read_managed_proxy_value "$MANAGED_PROXY_HOST_FILE" "host")"
PROXY_PORT="$(read_managed_proxy_value "$MANAGED_PROXY_PORT_FILE" "port")"
unset NEMOCLAW_PROXY_HOST NEMOCLAW_PROXY_PORT
# Generic proxy fallbacks are outside the managed dcode contract and may carry
# host credentials even after the scheme-specific proxy values are normalized.
unset ALL_PROXY all_proxy

# Keep this validator behavior identical to the host-side TypeScript boundary.
# It is applied only to image-baked values that onboard writes into root-owned
# files at build time; runtime env is explicitly unset above and never reaches
# this check. Underscores remain accepted for controlled internal/container
# aliases such as proxy_name; public DNS hostnames should remain RFC 1123
# names without them. Schemes, credentials, separators, and whitespace are
# still rejected.
is_valid_proxy_host() {
  local value="$1"
  [[ "$value" =~ ^[A-Za-z0-9._-]+$ ]]
}

is_valid_proxy_port() {
  local value="$1"
  [[ "$value" =~ ^[0-9]{1,5}$ ]] || return 1
  ((10#$value >= 1 && 10#$value <= 65535))
}

if ! is_valid_proxy_host "$PROXY_HOST"; then
  printf '%s\n' 'Invalid NEMOCLAW_PROXY_HOST for the managed runtime proxy.' >&2
  exit 1
fi
if ! is_valid_proxy_port "$PROXY_PORT"; then
  printf '%s\n' 'Invalid NEMOCLAW_PROXY_PORT for the managed runtime proxy.' >&2
  exit 1
fi

_PROXY_URL="http://${PROXY_HOST}:${PROXY_PORT}"
_NO_PROXY_VAL="localhost,127.0.0.1,::1,${PROXY_HOST}"
export HTTP_PROXY="$_PROXY_URL"
export HTTPS_PROXY="$_PROXY_URL"
export NO_PROXY="$_NO_PROXY_VAL"
export http_proxy="$_PROXY_URL"
export https_proxy="$_PROXY_URL"
export no_proxy="$_NO_PROXY_VAL"

write_export_if_set() {
  local name="$1"
  local value="${!name:-}"
  [ -n "$value" ] || return 0
  printf 'export %s=%q\n' "$name" "$value"
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
    printf '%s\n' 'unset ALL_PROXY all_proxy'
    write_export_if_set HTTP_PROXY
    write_export_if_set HTTPS_PROXY
    write_export_if_set NO_PROXY
    write_export_if_set http_proxy
    write_export_if_set https_proxy
    write_export_if_set no_proxy
    write_export_if_set SSL_CERT_FILE
    write_export_if_set REQUESTS_CA_BUNDLE
    write_export_if_set NODE_EXTRA_CA_CERTS
    write_export_if_set LANGSMITH_TRACING
    write_export_if_set LANGSMITH_PROJECT
    write_export_if_set DEEPAGENTS_CODE_LANGSMITH_PROJECT
    write_export_if_set NEMOCLAW_SANDBOX_NAME
  } >"$tmp"
  # Dcode intentionally runs as the non-root sandbox user, unlike the
  # root-supervised OpenClaw/Hermes startup path. This atomic, sandbox-user-owned
  # file is credential-free convenience state for independent login/exec shells,
  # not an integrity boundary: the dcode launcher re-derives trusted proxy values
  # from the root-owned image files. Secret scans guard its contents; mode 0444
  # removes write bits so ordinary accidental writes fail.
  chmod 444 "$tmp"
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
