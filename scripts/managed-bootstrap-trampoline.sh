#!/usr/bin/env -S -u BASH_ENV /bin/bash
# shellcheck shell=bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Image-owned bootstrap boundary. A runtime provider creates a replacement
# without starting it, writes one bounded root-owned request into its writable
# layer, and starts this trampoline as PID 1. The exact captured supervisor argv
# cannot run until the fixed request and its identity binding have been validated
# and the request applied.

set -euo pipefail

fail() {
  printf '[SECURITY] Managed bootstrap trampoline: %s\n' "$*" >&2
  exit 1
}

if [ "$(/usr/bin/id -u)" -ne 0 ] || [ "$(/usr/bin/id -g)" -ne 0 ]; then
  fail "must run as root"
fi
[ "$#" -ge 16 ] \
  || fail "managed bootstrap arguments are incomplete"
[ "$1" = "--agent" ] || fail "agent argument is missing"
_nemoclaw_agent="$2"
[ "$3" = "--profile-fingerprint" ] || fail "profile fingerprint argument is missing"
_nemoclaw_fingerprint="$4"
[ "$5" = "--bootstrap-identity" ] || fail "bootstrap identity argument is missing"
_nemoclaw_bootstrap_identity="$6"
[ "$7" = "--agent-uid" ] || fail "agent uid argument is missing"
_nemoclaw_agent_uid="$8"
[ "$9" = "--agent-gid" ] || fail "agent gid argument is missing"
_nemoclaw_agent_gid="${10}"
[ "${11}" = "--agent-workdir" ] || fail "agent workdir argument is missing"
_nemoclaw_agent_workdir="${12}"
[ "${13}" = "--request-file" ] || fail "request-file argument is missing"
_nemoclaw_request="${14:-}"
[ "${15:-}" = "--" ] || fail "supervisor delimiter is missing"
shift 15
[ "$#" -gt 0 ] || fail "supervisor argv is empty"

case "$_nemoclaw_agent" in
  openclaw | hermes | langchain-deepagents-code) ;;
  *) fail "agent is unsupported" ;;
esac
case "$_nemoclaw_fingerprint" in
  *[!0-9a-f]* | "") fail "profile fingerprint must be lowercase SHA-256" ;;
esac
[ "${#_nemoclaw_fingerprint}" -eq 64 ] \
  || fail "profile fingerprint must be lowercase SHA-256"
case "$_nemoclaw_bootstrap_identity" in
  *[!0-9a-f]* | "") fail "bootstrap identity must be lowercase hex" ;;
esac
[ "${#_nemoclaw_bootstrap_identity}" -eq 64 ] \
  || fail "bootstrap identity must encode 32 bytes"
case "$_nemoclaw_agent_uid:$_nemoclaw_agent_gid" in
  *[!0-9:]* | :* | *:) fail "agent uid/gid must be numeric" ;;
esac
if [ "$(/usr/bin/id -u sandbox)" != "$_nemoclaw_agent_uid" ] \
  || [ "$(/usr/bin/id -g sandbox)" != "$_nemoclaw_agent_gid" ]; then
  fail "agent identity does not match the image sandbox account"
fi
if [ "$_nemoclaw_agent_workdir" != "/sandbox" ] \
  || [ ! -d "$_nemoclaw_agent_workdir" ] \
  || [ -L "$_nemoclaw_agent_workdir" ]; then
  fail "agent workdir does not match the image sandbox workspace"
fi
[ "$_nemoclaw_request" = "/var/lib/nemoclaw-managed-bootstrap-request.json" ] \
  || fail "request file path is not the fixed bootstrap path"

_nemoclaw_runtime="/usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs"
if [ ! -f "$_nemoclaw_runtime" ] || [ -L "$_nemoclaw_runtime" ]; then
  fail "managed startup runtime is missing"
fi
if [ -L "$_nemoclaw_request" ]; then
  fail "bootstrap request path is a symbolic link"
fi
if [ -e "$_nemoclaw_request" ]; then
  if [ ! -f "$_nemoclaw_request" ] \
    || [ "$(/usr/bin/stat -c '%u:%g:%a:%h' "$_nemoclaw_request")" != "0:0:400:1" ]; then
    fail "bootstrap request failed root ownership validation"
  fi
  /usr/bin/env -i \
    HOME="/root" \
    LANG="C.UTF-8" \
    LC_ALL="C.UTF-8" \
    NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION="1" \
    PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    /usr/local/bin/node "$_nemoclaw_runtime" \
    --apply-bootstrap-file \
    --agent "$_nemoclaw_agent" \
    --profile-fingerprint "$_nemoclaw_fingerprint" \
    --bootstrap-identity "$_nemoclaw_bootstrap_identity"
  /usr/bin/rm -f -- "$_nemoclaw_request"
  if [ -e "$_nemoclaw_request" ] || [ -L "$_nemoclaw_request" ]; then
    fail "bootstrap runtime did not consume its request"
  fi
fi
/usr/bin/env -i \
  HOME="/root" \
  LANG="C.UTF-8" \
  LC_ALL="C.UTF-8" \
  NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION="1" \
  PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  /usr/local/bin/node "$_nemoclaw_runtime" \
  --verify-bootstrap-completion \
  --agent "$_nemoclaw_agent" \
  --profile-fingerprint "$_nemoclaw_fingerprint" \
  --bootstrap-identity "$_nemoclaw_bootstrap_identity"

unset _nemoclaw_agent _nemoclaw_fingerprint _nemoclaw_bootstrap_identity
unset _nemoclaw_agent_uid _nemoclaw_agent_gid _nemoclaw_agent_workdir
unset _nemoclaw_request _nemoclaw_runtime
unset -f fail
exec 3<&- 4<&- 5<&- 6<&- 7<&- 8<&- 9<&-
exec 3>&- 4>&- 5>&- 6>&- 7>&- 8>&- 9>&-
exec "$@"
