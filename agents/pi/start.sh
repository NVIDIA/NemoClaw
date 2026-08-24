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
# can repair the protected workspace boundary and create the protected merged
# CA bundle before dropping to the sandbox user. A sandbox-user image verifies
# the image-baked boundary instead.
_NEMOCLAW_PI_DROP_PRIVILEGES=0
if [ "$(id -u)" -eq 0 ]; then
  if ! verify_pi_shell_init; then
    printf '%s\n' '[SECURITY] Managed Pi shell initialization files are missing or unsafe.' >&2
    exit 1
  fi
  chown root:sandbox /sandbox
  chmod 1775 /sandbox
  install -d -o sandbox -g sandbox -m 0700 "$NEMOCLAW_PI_STATE_DIR"
  _NEMOCLAW_PI_DROP_PRIVILEGES=1
elif ! verify_pi_shell_init; then
  printf '%s\n' '[SECURITY] Pi shell initialization files are not protected; rebuild this sandbox.' >&2
  exit 1
fi

export PI_OFFLINE=1
export PI_TELEMETRY=0

# Harden RLIMITs (nproc + nofile) for the long-running Pi process tree. The
# initial root pass lowers the inherited limits before the privilege transition;
# the sandbox-user pass verifies the same exact values. Connect and exec shells
# are hardened independently by the system-wide profile hooks.
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

# Corporate proxy CA merge (NemoClaw#6210).
# OpenShell injects SSL_CERT_FILE for its own L7 proxy CA at runtime. When a
# separate corporate MITM proxy sits in front of the host and re-signs external
# TLS with a different root, that root is absent from the OpenShell bundle, so
# external endpoints fail verification even when policy allows the connection.
# If onboard baked an operator-supplied corporate CA into the image, append it
# to the OpenShell bundle — never replace it (the #1828 OpenShell CA behavior
# stays intact) — and repoint the CA env vars at the merged bundle so
# curl/python/git/node all trust both roots.
_NEMOCLAW_CORPORATE_CA_FILE="/usr/local/share/nemoclaw/corporate-ca.pem"
readonly _NEMOCLAW_MERGED_CA_FILE="/tmp/nemoclaw-ca-bundle.pem"
# Concise, secret-free warning when a baked corporate CA fails to merge at
# runtime. Names the failed step + target path only (never certificate bytes)
# so an operator can distinguish "no CA was baked" from "runtime merge failed".
_nemoclaw_ca_merge_warn() {
  echo "[nemoclaw] WARNING: corporate proxy CA merge failed at ${1}; keeping OpenShell-only trust — external TLS through the corporate proxy may fail (#6210)" >&2
}
merge_corporate_proxy_ca() {
  if [ "${_NEMOCLAW_CORPORATE_CA_ROOT_PHASE:-}" = "1" ]; then
    if [ "$(id -u)" -eq 0 ]; then
      echo "[nemoclaw] refusing an externally supplied corporate CA root-phase marker" >&2
      exit 1
    fi
    [ "${_NEMOCLAW_CORPORATE_CA_MERGED:-}" = "1" ] || return 0
    for _ca_variable in \
      SSL_CERT_FILE \
      CURL_CA_BUNDLE \
      REQUESTS_CA_BUNDLE \
      GIT_SSL_CAINFO \
      NODE_EXTRA_CA_CERTS; do
      if [ "${!_ca_variable:-}" != "$_NEMOCLAW_MERGED_CA_FILE" ]; then
        echo "[nemoclaw] refusing an invalid root-to-sandbox corporate CA environment handoff" >&2
        exit 1
      fi
    done
    if [ "$(stat -c '%u:%g:%a' "$_NEMOCLAW_MERGED_CA_FILE" 2>/dev/null || true)" != "0:0:444" ]; then
      echo "[nemoclaw] refusing an invalid root-to-sandbox corporate CA handoff" >&2
      exit 1
    fi
    return 0
  fi
  if [ "${_NEMOCLAW_CORPORATE_CA_MERGED:-}" = "1" ]; then
    echo "[nemoclaw] refusing an unpaired corporate CA merge marker" >&2
    exit 1
  fi
  # Trust-anchor tampering (#8650): replacing the baked corporate CA file with a
  # symlink makes the merge below read the link target instead, adding
  # attacker-selected bytes to the trust bundle that curl, python, git, and node
  # verify against. The image bakes this path as a root-owned 0444 regular file,
  # so a symlink here is never a legitimate state. This is not the recoverable
  # "merge failed" case below, which safely keeps OpenShell-only trust, so it
  # fails closed instead of warning.
  if [ -L "$_NEMOCLAW_CORPORATE_CA_FILE" ]; then
    echo "[nemoclaw] refusing symlinked corporate CA at ${_NEMOCLAW_CORPORATE_CA_FILE}; expected a regular file (#8650)" >&2
    exit 1
  fi
  [ -s "$_NEMOCLAW_CORPORATE_CA_FILE" ] || return 0
  _base_bundle=""
  if [ -n "${SSL_CERT_FILE:-}" ] && [ -f "${SSL_CERT_FILE}" ]; then
    _base_bundle="$SSL_CERT_FILE"
  elif [ -f /etc/ssl/certs/ca-certificates.crt ]; then
    _base_bundle="/etc/ssl/certs/ca-certificates.crt"
  fi
  _merged="$_NEMOCLAW_MERGED_CA_FILE"
  # Trust-anchor path safety (#6210): in the normal container start the initial
  # entrypoint phase runs as root through this merge, so the merged bundle is
  # written root-owned 0444 before the process drops privileges. The non-root
  # sandbox user inherits SSL_CERT_FILE but cannot rewrite it. The predictable
  # /tmp path is still handled safely: it is built in a fresh mktemp sibling and
  # atomically renamed into place; a pre-planted symlink at the target is
  # dropped first
  # (below); and rename(2) replaces the target link/file rather than writing
  # through it, so a pre-planted symlink or file cannot redirect the write. On a
  # non-root start the whole entrypoint (and the agent) is the same sandbox user,
  # so there is no privilege boundary to cross.
  # Build the bundle in a private temp file next to the target, verifying every
  # write, then atomically rename into place. If any step fails we bail without
  # exporting anything, leaving the OpenShell-only trust intact rather than
  # pointing tools at a partial/empty bundle.
  _tmp="$(mktemp "${_merged}.XXXXXX" 2>/dev/null)" || {
    _nemoclaw_ca_merge_warn "create temp bundle (${_merged})"
    return 0
  }
  if [ -n "$_base_bundle" ]; then
    cat "$_base_bundle" >>"$_tmp" 2>/dev/null || {
      rm -f "$_tmp"
      _nemoclaw_ca_merge_warn "append OpenShell bundle"
      return 0
    }
    printf '\n' >>"$_tmp" 2>/dev/null || {
      rm -f "$_tmp"
      _nemoclaw_ca_merge_warn "append OpenShell bundle"
      return 0
    }
  fi
  # Append through a descriptor opened with O_NOFOLLOW and verified as a regular
  # file (#8650). The check above rejects a planted symlink; this rejects one
  # swapped in afterwards, because the type check and the read share one
  # descriptor and no path is resolved twice. Status 2 means the source was
  # rejected as a trust anchor; any other non-zero status is an ordinary read
  # failure that keeps the existing warn-and-continue behavior.
  _ca_append_status=0
  python3 -I - "$_NEMOCLAW_CORPORATE_CA_FILE" "$_tmp" <<'PY_APPEND_CORPORATE_CA' || _ca_append_status=$?
import errno
import os
import stat
import sys

source, target = sys.argv[1], sys.argv[2]
try:
    descriptor = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
except OSError as error:
    raise SystemExit(2 if error.errno == errno.ELOOP else 3)
try:
    if not stat.S_ISREG(os.fstat(descriptor).st_mode):
        raise SystemExit(2)
    with open(target, "ab") as merged:
        while True:
            chunk = os.read(descriptor, 65536)
            if not chunk:
                break
            merged.write(chunk)
finally:
    os.close(descriptor)
PY_APPEND_CORPORATE_CA
  if [ "$_ca_append_status" -eq 2 ]; then
    rm -f "$_tmp"
    echo "[nemoclaw] refusing corporate CA at ${_NEMOCLAW_CORPORATE_CA_FILE}; expected a regular file, not a symlink (#8650)" >&2
    exit 1
  fi
  if [ "$_ca_append_status" -ne 0 ]; then
    rm -f "$_tmp"
    _nemoclaw_ca_merge_warn "append corporate CA"
    return 0
  fi
  chmod 0444 "$_tmp" 2>/dev/null || {
    rm -f "$_tmp"
    _nemoclaw_ca_merge_warn "set merged bundle permissions (${_merged})"
    return 0
  }
  # Defense-in-depth for the predictable /tmp path (#6210): if a co-tenant
  # pre-planted a symlink at the target, drop it first so we rename into a fresh
  # regular file we own rather than through an attacker-controlled link.
  if [ -L "$_merged" ]; then
    rm -f "$_merged" 2>/dev/null || true
  fi
  mv -f "$_tmp" "$_merged" 2>/dev/null || {
    rm -f "$_tmp"
    _nemoclaw_ca_merge_warn "install merged bundle (${_merged})"
    return 0
  }
  export SSL_CERT_FILE="$_merged"
  export CURL_CA_BUNDLE="$_merged"
  export REQUESTS_CA_BUNDLE="$_merged"
  export GIT_SSL_CAINFO="$_merged"
  export NODE_EXTRA_CA_CERTS="$_merged"
  export _NEMOCLAW_CORPORATE_CA_MERGED=1
  echo "[nemoclaw] merged corporate proxy CA into sandbox trust bundle (#6210)" >&2
}
merge_corporate_proxy_ca

if [ "$_NEMOCLAW_PI_DROP_PRIVILEGES" -eq 1 ]; then
  if [ "${_NEMOCLAW_CORPORATE_CA_MERGED:-}" = "1" ] \
    && [ "$(stat -c '%u:%g:%a' "$_NEMOCLAW_MERGED_CA_FILE" 2>/dev/null || true)" != "0:0:444" ]; then
    printf '%s\n' '[SECURITY] Merged corporate CA bundle is not protected; refusing to drop privileges.' >&2
    exit 1
  fi
  export _NEMOCLAW_CORPORATE_CA_ROOT_PHASE=1
  exec /usr/bin/setpriv --reuid=sandbox --regid=sandbox --init-groups -- \
    /usr/local/bin/nemoclaw-start "$@"
fi
unset _NEMOCLAW_PI_DROP_PRIVILEGES

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
    write_export_if_set CURL_CA_BUNDLE
    write_export_if_set REQUESTS_CA_BUNDLE
    write_export_if_set GIT_SSL_CAINFO
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
