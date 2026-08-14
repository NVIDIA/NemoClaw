#!/bin/bash -p
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# NemoClaw sandbox entrypoint for Pi.

set -euo pipefail
unset BASH_ENV ENV

# Sessions and generated configuration are confidential user state, so every
# file this entrypoint or Pi creates stays owner-only.
umask 077

export HOME=/sandbox
export PATH="/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin"

readonly NEMOCLAW_PI_STATE_DIR="/sandbox/.pi/agent"
readonly NEMOCLAW_PI_SHELL_INIT_FILES=(/sandbox/.bashrc /sandbox/.profile)

verify_pi_shell_init() {
  local file
  [ -d /sandbox ] && [ ! -L /sandbox ] || return 1
  for file in "${NEMOCLAW_PI_SHELL_INIT_FILES[@]}"; do
    [ -f "$file" ] && [ ! -L "$file" ] || return 1
    [ "$(stat -c '%U:%G:%a' "$file" 2>/dev/null || true)" = "root:root:444" ] || return 1
  done
}

# managed-entrypoint-env-wrapper begin
_NEMOCLAW_ENTRYPOINT_ENV_WRAPPER="/usr/local/lib/nemoclaw/entrypoint-env-wrapper.sh"
if [ ! -f "$_NEMOCLAW_ENTRYPOINT_ENV_WRAPPER" ]; then
  _PI_ENTRYPOINT_SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  _NEMOCLAW_ENTRYPOINT_ENV_WRAPPER="${_PI_ENTRYPOINT_SOURCE_DIR}/../../scripts/lib/entrypoint-env-wrapper.sh"
  unset _PI_ENTRYPOINT_SOURCE_DIR
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

# The published managed image uses uid 0 as its OCI entry user so every start
# can repair the protected workspace boundary before dropping to the sandbox
# user. A sandbox-user image verifies the image-baked boundary instead.
if [ "$(id -u)" -eq 0 ]; then
  if ! verify_pi_shell_init; then
    printf '%s\n' '[SECURITY] Managed Pi shell initialization files are missing or unsafe.' >&2
    exit 1
  fi
  chown root:sandbox /sandbox
  chmod 1775 /sandbox
  install -d -o sandbox -g sandbox -m 0700 "$NEMOCLAW_PI_STATE_DIR"
  exec /usr/bin/setpriv --reuid=sandbox --regid=sandbox --init-groups -- \
    /usr/local/bin/nemoclaw-start "$@"
fi
if ! verify_pi_shell_init; then
  printf '%s\n' '[SECURITY] Pi shell initialization files are not protected; rebuild this sandbox.' >&2
  exit 1
fi

export PI_OFFLINE=1
export PI_TELEMETRY=0

# Harden RLIMITs (nproc + nofile) for the long-running Pi process tree. Like the
# Deep Agents Code entrypoint this runs as the non-root sandbox user, which can
# still lower the inherited limits. Connect and exec shells are hardened
# independently by the system-wide profile hooks.
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

readonly MANAGED_PROXY_HOST_FILE="/usr/local/share/nemoclaw/pi-proxy-host"
readonly MANAGED_PROXY_PORT_FILE="/usr/local/share/nemoclaw/pi-proxy-port"
readonly MANAGED_PROXY_OWNER_UID=0

read_managed_proxy_value() {
  local file="$1"
  local name="$2"
  local metadata
  if [ ! -f "$file" ] || [ -L "$file" ] || [ ! -r "$file" ]; then
    printf 'Missing or unsafe trusted managed proxy %s file.\n' "$name" >&2
    return 1
  fi
  metadata="$(stat -c '%u:%a' "$file" 2>/dev/null)" || {
    printf 'Cannot inspect trusted managed proxy %s file.\n' "$name" >&2
    return 1
  }
  if [ "$metadata" != "${MANAGED_PROXY_OWNER_UID}:444" ]; then
    printf 'Unsafe ownership or mode on trusted managed proxy %s file.\n' "$name" >&2
    return 1
  fi
  printf '%s' "$(<"$file")"
}

# Fail closed if the root-owned image contract is missing. Process-level
# NEMOCLAW_PROXY_* values are not a trusted runtime routing source.
PROXY_HOST="$(read_managed_proxy_value "$MANAGED_PROXY_HOST_FILE" "host")"
PROXY_PORT="$(read_managed_proxy_value "$MANAGED_PROXY_PORT_FILE" "port")"
unset NEMOCLAW_PROXY_HOST NEMOCLAW_PROXY_PORT
# Generic proxy fallbacks are outside the managed Pi contract and may carry host
# credentials even after the scheme-specific proxy values are normalized.
unset ALL_PROXY all_proxy OPENAI_PROXY

# These two patterns must match isValidProxyHost and isValidProxyPort in
# src/lib/onboard/dockerfile-patch.ts. They apply only to image-baked values that
# onboard writes into root-owned files at build time; runtime env is explicitly
# unset above and never reaches this check.
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
  # This file is intentionally volatile: it holds no state that must survive a
  # restart, so every start rebuilds it from the root-owned proxy files.
  local target=/tmp/nemoclaw-proxy-env.sh
  local tmp
  tmp="$(mktemp /tmp/nemoclaw-proxy-env.XXXXXX)"
  {
    printf '%s\n' 'umask 077'
    printf '%s\n' 'export HOME=/sandbox'
    printf '%s\n' 'export PATH="/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin"'
    printf '%s\n' 'export PI_OFFLINE=1'
    printf '%s\n' 'export PI_TELEMETRY=0'
    printf '%s\n' 'unset ALL_PROXY all_proxy OPENAI_PROXY'
    write_export_if_set HTTP_PROXY
    write_export_if_set HTTPS_PROXY
    write_export_if_set NO_PROXY
    write_export_if_set http_proxy
    write_export_if_set https_proxy
    write_export_if_set no_proxy
    write_export_if_set SSL_CERT_FILE
    write_export_if_set NODE_EXTRA_CA_CERTS
    write_export_if_set NEMOCLAW_SANDBOX_NAME
  } >"$tmp"
  # This sandbox-user-owned file is credential-free convenience state for
  # independent login and exec shells, not an integrity boundary: the entrypoint
  # re-derives trusted proxy values from the root-owned image files. No Pi scan
  # currently checks this file's contents; mode 0444 removes write bits so
  # ordinary accidental writes fail.
  chmod 444 "$tmp"
  mv -f "$tmp" "$target"
}

prepare_runtime_env

# With no command, this invocation is the sandbox's long-running entrypoint. Pi
# is a terminal agent that users invoke on demand through `openshell sandbox
# exec`, so the entrypoint runs no service and must not exit. A bare `/bin/bash`
# exits immediately in a non-interactive sandbox, and OpenShell then moves the
# sandbox to the Error phase. Block instead so the sandbox stays in the Ready
# phase.
if [ "$#" -eq 0 ]; then
  printf '%s\n' 'Setting up NemoClaw Pi runtime...'
  exec -a nemoclaw-pi-entrypoint tail -f /dev/null
fi

exec "$@"
