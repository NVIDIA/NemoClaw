#!/bin/bash -p
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# NemoClaw sandbox entrypoint for LangChain Deep Agents Code.

set -euo pipefail
unset BASH_ENV ENV
while IFS= read -r _nemoclaw_auto_approval_env; do
  unset "$_nemoclaw_auto_approval_env"
done < <(compgen -A variable NEMOCLAW_DCODE_AUTO_APPROVAL || true)
unset _nemoclaw_auto_approval_env

export HOME=/sandbox
export PATH="/usr/local/bin:/opt/venv/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin"
export DEEPAGENTS_CODE_NO_UPDATE_CHECK=1
export LANGGRAPH_NO_VERSION_CHECK=true
export LANGGRAPH_CLI_NO_ANALYTICS=1
export OTEL_ENABLED=false
export DEEPAGENTS_CODE_AUTO_UPDATE=0
export DEEPAGENTS_CODE_LANGSMITH_TRACING=false
export DEEPAGENTS_CODE_LANGSMITH_TRACING_V2=false
export DEEPAGENTS_CODE_LANGCHAIN_TRACING=false
export DEEPAGENTS_CODE_LANGCHAIN_TRACING_V2=false
export LANGSMITH_TRACING=false
export LANGSMITH_TRACING_V2=false
export LANGCHAIN_TRACING=false
export LANGCHAIN_TRACING_V2=false
export DEEPAGENTS_CODE_OFFLINE=1
export DEEPAGENTS_CODE_RIPGREP_INSTALLER=system
export DEEPAGENTS_CODE_OPENAI_API_KEY="${DEEPAGENTS_CODE_OPENAI_API_KEY:-nemoclaw-managed-inference}"
export OPENAI_BASE_URL="${OPENAI_BASE_URL:-https://inference.local/v1}"

# Harden RLIMITs (nproc + nofile) for the long-running Deep Agents Code process
# tree. Unlike the root-supervised OpenClaw/Hermes entrypoints this runs as the
# non-root sandbox user, which can still lower the inherited caps. Connect and
# exec shells are hardened independently by the system-wide profile hooks.
_NEMOCLAW_SANDBOX_RLIMITS="/usr/local/lib/nemoclaw/sandbox-rlimits.sh"
if [ ! -f "$_NEMOCLAW_SANDBOX_RLIMITS" ]; then
  _NEMOCLAW_SANDBOX_RLIMITS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../scripts/lib/sandbox-rlimits.sh"
fi
if [ ! -f "$_NEMOCLAW_SANDBOX_RLIMITS" ]; then
  printf '%s\n' '[SECURITY] Required sandbox-rlimits.sh is missing; refusing to start unhardened.' >&2
  exit 1
fi
# shellcheck source=scripts/lib/sandbox-rlimits.sh
. "$_NEMOCLAW_SANDBOX_RLIMITS"
# shellcheck disable=SC2119 # harden_resource_limits' optional $1 selects
# quiet mode; it is not this entrypoint's own argument vector.
harden_resource_limits
# shellcheck disable=SC2119 # optional $1 selects quiet mode, not entrypoint args.
if ! verify_resource_limits_exact; then
  printf '%s\n' '[SECURITY] Effective sandbox resource limits do not match policy; refusing to start unhardened.' >&2
  exit 1
fi
unset _NEMOCLAW_SANDBOX_RLIMITS

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
unset ALL_PROXY all_proxy OPENAI_PROXY

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
# Deep Agents Code 0.1.34 intentionally ignores environment proxies in
# fetch_url so it can pin direct DNS results against rebinding. OpenShell's
# sandbox instead requires all ordinary egress, including DNS resolution for a
# destination, to stay behind its policy proxy. This explicit variable opts the
# managed package patch into that trusted proxy boundary without teaching the
# upstream tool to trust arbitrary ambient HTTP_PROXY values. It is derived
# only from the root-owned image files validated above.
export DEEPAGENTS_CODE_FETCH_URL_TRUSTED_PROXY_URL="$_PROXY_URL"
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
    printf '%s\n' 'export LANGGRAPH_NO_VERSION_CHECK=true'
    printf '%s\n' 'export LANGGRAPH_CLI_NO_ANALYTICS=1'
    printf '%s\n' 'export OTEL_ENABLED=false'
    printf '%s\n' 'export DEEPAGENTS_CODE_AUTO_UPDATE=0'
    printf '%s\n' 'export DEEPAGENTS_CODE_LANGSMITH_TRACING=false'
    printf '%s\n' 'export DEEPAGENTS_CODE_LANGSMITH_TRACING_V2=false'
    printf '%s\n' 'export DEEPAGENTS_CODE_LANGCHAIN_TRACING=false'
    printf '%s\n' 'export DEEPAGENTS_CODE_LANGCHAIN_TRACING_V2=false'
    printf '%s\n' 'export LANGSMITH_TRACING=false'
    printf '%s\n' 'export LANGSMITH_TRACING_V2=false'
    printf '%s\n' 'export LANGCHAIN_TRACING=false'
    printf '%s\n' 'export LANGCHAIN_TRACING_V2=false'
    printf '%s\n' 'export DEEPAGENTS_CODE_OFFLINE=1'
    printf '%s\n' 'export DEEPAGENTS_CODE_RIPGREP_INSTALLER=system'
    # Intentionally omit the trusted proxy when unset: its absence signals
    # unmanaged mode, where the upstream fetch transport remains authoritative.
    write_export_if_set DEEPAGENTS_CODE_FETCH_URL_TRUSTED_PROXY_URL
    # shellcheck disable=SC2016
    printf '%s\n' 'export DEEPAGENTS_CODE_OPENAI_API_KEY="${DEEPAGENTS_CODE_OPENAI_API_KEY:-nemoclaw-managed-inference}"'
    # shellcheck disable=SC2016
    printf '%s\n' 'export OPENAI_BASE_URL="${OPENAI_BASE_URL:-https://inference.local/v1}"'
    printf '%s\n' 'unset ALL_PROXY all_proxy OPENAI_PROXY'
    write_export_if_set HTTP_PROXY
    write_export_if_set HTTPS_PROXY
    write_export_if_set NO_PROXY
    write_export_if_set http_proxy
    write_export_if_set https_proxy
    write_export_if_set no_proxy
    write_export_if_set SSL_CERT_FILE
    write_export_if_set REQUESTS_CA_BUNDLE
    write_export_if_set NODE_EXTRA_CA_CERTS
    # LangSmith values are intentionally excluded because any inherited variable
    # can be misconfigured with a token and this shared file is readable.
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

prepare_observability_marker() {
  local marker_dir=/sandbox/.deepagents
  local target="${marker_dir}/.nemoclaw-observability-enabled"
  local tmp

  # OpenShell policy replacement can reset the sandbox's ephemeral /tmp while
  # preserving its /sandbox workspace. Keep this credential-free convenience
  # bit with the managed DCode state so independent exec/login shells retain
  # the host-selected observability setting across policy updates. Reject a
  # symlinked state directory before creating a same-directory temporary file;
  # the marker remains non-authoritative and the network policy controls OTLP.
  if [ -L "$marker_dir" ] || { [ -e "$marker_dir" ] && [ ! -d "$marker_dir" ]; }; then
    printf '%s\n' 'Unsafe managed Deep Agents Code state directory.' >&2
    return 1
  fi
  if [ -d "$marker_dir" ] \
    && { [ -L "$target" ] || { [ -e "$target" ] && [ ! -f "$target" ]; }; }; then
    printf '%s\n' 'Unsafe managed observability marker target.' >&2
    return 1
  fi

  # Policy replacement restarts the entrypoint without the sandbox-create
  # environment. Absent therefore preserves the validated durable state;
  # NemoClaw create/rebuild paths pass an explicit authoritative 1 or 0.
  if [ -z "${NEMOCLAW_OBSERVABILITY+x}" ]; then
    return 0
  fi
  if [ "$NEMOCLAW_OBSERVABILITY" != "1" ]; then
    [ -d "$marker_dir" ] || return 0
    rm -f "$target"
    return 0
  fi
  mkdir -p "$marker_dir"
  if [ -L "$marker_dir" ] || [ ! -d "$marker_dir" ]; then
    printf '%s\n' 'Unsafe managed Deep Agents Code state directory.' >&2
    return 1
  fi
  if [ -L "$target" ] || { [ -e "$target" ] && [ ! -f "$target" ]; }; then
    printf '%s\n' 'Unsafe managed observability marker target.' >&2
    return 1
  fi

  tmp="$(mktemp "${target}.XXXXXX")"
  printf '%s\n' '1' >"$tmp"
  chmod 444 "$tmp"
  mv -f "$tmp" "$target"
}

prepare_runtime_env
prepare_observability_marker

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
  exec -a nemoclaw-dcode-entrypoint tail -f /dev/null
fi

exec "$@"
