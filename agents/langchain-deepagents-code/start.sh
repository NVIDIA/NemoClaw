#!/bin/bash -p
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# NemoClaw sandbox entrypoint for LangChain Deep Agents Code.

set -euo pipefail
unset BASH_ENV ENV

export HOME=/sandbox
export PATH="/usr/local/bin:/opt/venv/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin"

# managed-entrypoint-env-wrapper begin
_NEMOCLAW_ENTRYPOINT_ENV_WRAPPER="/usr/local/lib/nemoclaw/entrypoint-env-wrapper.sh"
if [ ! -f "$_NEMOCLAW_ENTRYPOINT_ENV_WRAPPER" ]; then
  _DCODE_ENTRYPOINT_SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  _NEMOCLAW_ENTRYPOINT_ENV_WRAPPER="${_DCODE_ENTRYPOINT_SOURCE_DIR}/../../scripts/lib/entrypoint-env-wrapper.sh"
  unset _DCODE_ENTRYPOINT_SOURCE_DIR
fi
if [ ! -f "$_NEMOCLAW_ENTRYPOINT_ENV_WRAPPER" ]; then
  printf '%s\n' '[SECURITY] Required entrypoint env-wrapper normalizer is missing.' >&2
  exit 1
fi
# shellcheck source=scripts/lib/entrypoint-env-wrapper.sh
source "$_NEMOCLAW_ENTRYPOINT_ENV_WRAPPER"
nemoclaw_normalize_entrypoint_env_wrapper "$@"
if [ "$NEMOCLAW_ENTRYPOINT_NORMALIZED_ARGC" -eq 0 ]; then
  set --
else
  set -- "${NEMOCLAW_ENTRYPOINT_NORMALIZED_ARGV[@]}"
fi
unset NEMOCLAW_ENTRYPOINT_NORMALIZED_ARGC NEMOCLAW_ENTRYPOINT_NORMALIZED_ARGV \
  _NEMOCLAW_ENTRYPOINT_ENV_WRAPPER
unset -f nemoclaw_normalize_entrypoint_env_wrapper
# managed-entrypoint-env-wrapper end

# Root entrypoints hand off agent work without reading personal shell files.
if [ "$(id -u)" -eq 0 ]; then
  exec /usr/bin/setpriv --reuid=sandbox --regid=sandbox --init-groups -- \
    /usr/local/bin/nemoclaw-start "$@"
fi

while IFS= read -r _nemoclaw_auto_approval_env; do
  unset "$_nemoclaw_auto_approval_env"
done < <(compgen -A variable NEMOCLAW_DCODE_AUTO_APPROVAL || true)
unset _nemoclaw_auto_approval_env

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
unset NEMOCLAW_ATTACHED_PROVIDER_API_KEY
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

if [ -e /etc/openshell-tls/ca-bundle.pem ] \
  || [ -L /etc/openshell-tls/ca-bundle.pem ]; then
  readonly MANAGED_FETCH_CA_BUNDLE_FILE="/etc/openshell-tls/ca-bundle.pem"
else
  readonly MANAGED_FETCH_CA_BUNDLE_FILE="/tmp/nemoclaw-managed-startup-ca-bundle.pem"
fi
readonly MANAGED_CA_OWNER_UID=0

managed_fetch_ca_bundle_metadata() {
  local file="$1"
  local metadata
  if metadata="$(stat -c '%u:%a:%s' "$file" 2>/dev/null)"; then
    printf '%s' "$metadata"
  else
    stat -f '%u:%Lp:%z' "$file" 2>/dev/null
  fi
}

validate_managed_fetch_ca_bundle() {
  local file="$MANAGED_FETCH_CA_BUNDLE_FILE"
  local metadata owner mode size extra
  if [ -L "$file" ]; then
    printf '%s\n' 'Missing or unsafe managed fetch CA bundle file.' >&2
    return 1
  fi
  [ -e "$file" ] || return 0
  if [ ! -f "$file" ] || [ ! -r "$file" ]; then
    printf '%s\n' 'Missing or unsafe managed fetch CA bundle file.' >&2
    return 1
  fi
  metadata="$(managed_fetch_ca_bundle_metadata "$file")" || {
    printf '%s\n' 'Cannot inspect managed fetch CA bundle file.' >&2
    return 1
  }
  IFS=: read -r owner mode size extra <<<"$metadata"
  if [ -n "${extra:-}" ] \
    || [[ ! "$owner" =~ ^[0-9]+$ ]] \
    || [[ ! "$mode" =~ ^[0-7]{3,4}$ ]] \
    || [[ ! "$size" =~ ^[0-9]+$ ]] \
    || [ "$owner" != "$MANAGED_CA_OWNER_UID" ] \
    || [ "$size" -le 0 ] \
    || (((8#$mode & 0022) != 0)); then
    printf '%s\n' 'Unsafe ownership or mode on managed fetch CA bundle file.' >&2
    return 1
  fi
}

validate_managed_fetch_ca_bundle
if [ -e "$MANAGED_FETCH_CA_BUNDLE_FILE" ]; then
  : "${SSL_CERT_FILE:=$MANAGED_FETCH_CA_BUNDLE_FILE}"
  : "${REQUESTS_CA_BUNDLE:=$MANAGED_FETCH_CA_BUNDLE_FILE}"
  : "${NODE_EXTRA_CA_CERTS:=$MANAGED_FETCH_CA_BUNDLE_FILE}"
  export SSL_CERT_FILE REQUESTS_CA_BUNDLE NODE_EXTRA_CA_CERTS
fi
# OpenShell 0.1.3 mediates sockets and DNS. Ambient proxies must not replace that route.
unset HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy
unset ALL_PROXY all_proxy OPENAI_PROXY grpc_proxy GRPC_PROXY NODE_USE_ENV_PROXY
unset NEMOCLAW_PROXY_HOST NEMOCLAW_PROXY_PORT DEEPAGENTS_CODE_FETCH_URL_TRUSTED_PROXY_URL

write_export_if_set() {
  local name="$1"
  local value="${!name:-}"
  [ -n "$value" ] || return 0
  printf 'export %s=%q\n' "$name" "$value"
}

prepare_runtime_env() {
  # Unlike prepare_observability_marker below, this file is intentionally
  # volatile: every stateful start rebuilds its environment guards.
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
    # shellcheck disable=SC2016
    printf '%s\n' 'export DEEPAGENTS_CODE_OPENAI_API_KEY="${DEEPAGENTS_CODE_OPENAI_API_KEY:-nemoclaw-managed-inference}"'
    printf '%s\n' 'unset NEMOCLAW_ATTACHED_PROVIDER_API_KEY'
    # shellcheck disable=SC2016
    printf '%s\n' 'export OPENAI_BASE_URL="${OPENAI_BASE_URL:-https://inference.local/v1}"'
    printf '%s\n' 'unset HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy'
    printf '%s\n' 'unset ALL_PROXY all_proxy OPENAI_PROXY grpc_proxy GRPC_PROXY NODE_USE_ENV_PROXY'
    printf '%s\n' 'unset NEMOCLAW_PROXY_HOST NEMOCLAW_PROXY_PORT DEEPAGENTS_CODE_FETCH_URL_TRUSTED_PROXY_URL'
    printf '_nemoclaw_dcode_ca_bundle=%q\n' "$MANAGED_FETCH_CA_BUNDLE_FILE"
    printf '_nemoclaw_dcode_ca_owner_uid=%q\n' "$MANAGED_CA_OWNER_UID"
    cat <<'NEMOCLAW_DCODE_CA_GUARD'
if [ -L "$_nemoclaw_dcode_ca_bundle" ]; then
  printf "%s\n" "Missing or unsafe managed fetch CA bundle file." >&2
  return 1 2>/dev/null || exit 1
elif [ -e "$_nemoclaw_dcode_ca_bundle" ]; then
  if [ ! -f "$_nemoclaw_dcode_ca_bundle" ] || [ ! -r "$_nemoclaw_dcode_ca_bundle" ]; then
    printf "%s\n" "Missing or unsafe managed fetch CA bundle file." >&2
    return 1 2>/dev/null || exit 1
  fi
  _nemoclaw_dcode_ca_meta="$(stat -c "%u:%a:%s" "$_nemoclaw_dcode_ca_bundle" 2>/dev/null || stat -f "%u:%Lp:%z" "$_nemoclaw_dcode_ca_bundle" 2>/dev/null || true)"
  IFS=: read -r _nemoclaw_dcode_ca_owner _nemoclaw_dcode_ca_mode _nemoclaw_dcode_ca_size _nemoclaw_dcode_ca_extra <<NEMOCLAW_DCODE_CA_METADATA
$_nemoclaw_dcode_ca_meta
NEMOCLAW_DCODE_CA_METADATA
  _nemoclaw_dcode_ca_valid=1
  case "$_nemoclaw_dcode_ca_owner" in
    '' | *[!0-9]*) _nemoclaw_dcode_ca_valid=0 ;;
  esac
  case "$_nemoclaw_dcode_ca_owner_uid" in
    '' | *[!0-9]*) _nemoclaw_dcode_ca_valid=0 ;;
  esac
  case "$_nemoclaw_dcode_ca_mode" in
    [0-7][0-7][0-7] | [0-7][0-7][0-7][0-7]) ;;
    *) _nemoclaw_dcode_ca_valid=0 ;;
  esac
  case "$_nemoclaw_dcode_ca_size" in
    '' | *[!0-9]*) _nemoclaw_dcode_ca_valid=0 ;;
  esac
  if [ "$_nemoclaw_dcode_ca_valid" -ne 1 ] \
    || [ -n "${_nemoclaw_dcode_ca_extra:-}" ] \
    || [ "$_nemoclaw_dcode_ca_owner" != "$_nemoclaw_dcode_ca_owner_uid" ] \
    || [ "$_nemoclaw_dcode_ca_size" -le 0 ] \
    || [ "$((0$_nemoclaw_dcode_ca_mode & 022))" -ne 0 ]; then
    printf "%s\n" "Unsafe ownership or mode on managed fetch CA bundle file." >&2
    return 1 2>/dev/null || exit 1
  fi
fi
unset _nemoclaw_dcode_ca_bundle _nemoclaw_dcode_ca_owner_uid _nemoclaw_dcode_ca_meta _nemoclaw_dcode_ca_owner _nemoclaw_dcode_ca_mode _nemoclaw_dcode_ca_size _nemoclaw_dcode_ca_extra _nemoclaw_dcode_ca_valid
NEMOCLAW_DCODE_CA_GUARD
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
  mv -fT -- "$tmp" "$target"
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
