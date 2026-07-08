#!/bin/bash -p
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Proxy-normalizing launcher for every managed Deep Agents Code entry point.

set -euo pipefail
unset BASH_ENV ENV
while IFS= read -r _nemoclaw_auto_approval_env; do
  unset "$_nemoclaw_auto_approval_env"
done < <(compgen -A variable NEMOCLAW_DCODE_AUTO_APPROVAL || true)
unset _nemoclaw_auto_approval_env

readonly MANAGED_DCODE_WRAPPER="/usr/local/lib/nemoclaw/dcode-wrapper.sh"
readonly MANAGED_OBSERVABILITY_MARKER="/tmp/nemoclaw-observability-enabled"
export HOME=/sandbox
export PATH="/usr/local/bin:/opt/venv/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin"

# Invalid state: raw OpenShell exec processes do not inherit the sandbox
# entrypoint's environment, so an opted-in direct dcode exec can lose tracing.
# Source boundary: start.sh materializes only the credential-free enable bit;
# this launcher recovers it only from a regular, non-symlink marker.
# Source-fix constraint: NemoClaw cannot make OpenShell preserve entrypoint env.
# Regression: the proxy-launcher tests cover exact values and unsafe file types.
# Removal condition: OpenShell propagates the bit to every exec/login process.
# The marker is convenience state, not an authorization boundary; the
# host-selected network policy controls whether local OTLP egress exists.
unset NEMOCLAW_OBSERVABILITY
if [ -f "$MANAGED_OBSERVABILITY_MARKER" ] \
  && [ ! -L "$MANAGED_OBSERVABILITY_MARKER" ] \
  && [ "$(<"$MANAGED_OBSERVABILITY_MARKER")" = "1" ]; then
  export NEMOCLAW_OBSERVABILITY=1
fi

# Raw OpenShell exec processes do not inherit the entrypoint's environment or
# source shell startup files. Rebuild the proxy-only dcode contract here so a
# direct exec cannot retain the host seed and bypass the managed proxy for a
# direct inference.local DNS lookup. This stays at the agent runtime boundary
# because the shared seed is still required for OpenShell host-side chaining.
# Remove it only when OpenShell normalizes every sandbox exec/login process or
# dcode no longer uses inference.local.
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

# Onboard validates the build args and the Dockerfile stores them in root-owned
# files. Runtime env is untrusted and cannot override those image-baked values.
PROXY_HOST="$(read_managed_proxy_value "$MANAGED_PROXY_HOST_FILE" "host")"
PROXY_PORT="$(read_managed_proxy_value "$MANAGED_PROXY_PORT_FILE" "port")"
unset NEMOCLAW_PROXY_HOST NEMOCLAW_PROXY_PORT
# Generic proxy fallbacks are outside the managed dcode contract and may carry
# host credentials even after the scheme-specific proxy values are normalized.
unset ALL_PROXY all_proxy OPENAI_PROXY

# This validator is applied only to image-baked values that onboard writes
# into root-owned files at build time; runtime env is explicitly unset above
# and never reaches this check. That scope is why underscores remain accepted
# for controlled internal/container aliases such as proxy_name — public DNS
# hostnames should still remain RFC 1123 names without underscores. Cross-
# boundary parity tests prevent this standalone boundary from drifting from
# start.sh or from the host-side TypeScript validator.
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

exec "$MANAGED_DCODE_WRAPPER" "$@"
