# shellcheck shell=bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Non-executable image-owned bootstrap body. The statically linked native
# entrypoint starts this file through absolute Bash with a fixed environment.
# It carries the exact supervisor environment in one sealed, reserved descriptor.
# A runtime provider creates a replacement without starting it, writes one
# bounded root-owned request into its writable layer, and starts the native
# entrypoint as PID 1. The exact captured supervisor argv and environment cannot
# run until the request and its identity binding have been validated and applied.

set -euo pipefail

fail() {
  printf '[SECURITY] Managed bootstrap trampoline: %s\n' "$*" >&2
  exit 1
}

[ "${NEMOCLAW_MANAGED_BOOTSTRAP_ENTRYPOINT:-}" = "1" ] \
  || fail "must be entered through the native bootstrap boundary"
[ "${1:-}" = "--nemoclaw-supervisor-environment" ] \
  || fail "supervisor environment handoff is missing"
[ "${2:-}" = "9" ] \
  || fail "supervisor environment descriptor is invalid"
[[ "${3:-}" =~ ^(0|[1-9][0-9]{0,3})$ ]] \
  || fail "supervisor environment count is invalid"
_nemoclaw_supervisor_environment_count="$3"
[ "$_nemoclaw_supervisor_environment_count" -le 1024 ] \
  || fail "supervisor environment has too many entries"
[[ "${4:-}" =~ ^(0|[1-9][0-9]{0,6})$ ]] \
  || fail "supervisor environment byte count is invalid"
_nemoclaw_supervisor_environment_bytes="$4"
[ "$_nemoclaw_supervisor_environment_bytes" -le 524288 ] \
  || fail "supervisor environment exceeds its transport bound"
[ "${5:-}" = "--" ] || fail "supervisor environment delimiter is missing"
shift 5

if [ "$(/usr/bin/id -u 9<&-)" -ne 0 ] || [ "$(/usr/bin/id -g 9<&-)" -ne 0 ]; then
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
[[ "$1" = /* ]] || fail "supervisor executable must be absolute"

case "$_nemoclaw_agent" in
  openclaw | hermes | langchain-deepagents-code | pi) ;;
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
if [ "$(/usr/bin/id -u sandbox 9<&-)" != "$_nemoclaw_agent_uid" ] \
  || [ "$(/usr/bin/id -g sandbox 9<&-)" != "$_nemoclaw_agent_gid" ]; then
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
_nemoclaw_request_directory="${_nemoclaw_request%/*}"
_nemoclaw_request_basename="${_nemoclaw_request##*/}"
_nemoclaw_claim="${_nemoclaw_request_directory}/.${_nemoclaw_request_basename}.nemoclaw-claim/request"
if [ ! -f "$_nemoclaw_runtime" ] || [ -L "$_nemoclaw_runtime" ]; then
  fail "managed startup runtime is missing"
fi
/usr/bin/env -i \
  HOME="/root" \
  LANG="C.UTF-8" \
  LC_ALL="C.UTF-8" \
  NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION="1" \
  PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  /usr/local/bin/node "$_nemoclaw_runtime" \
  --recover-bootstrap-claim \
  --agent "$_nemoclaw_agent" \
  --profile-fingerprint "$_nemoclaw_fingerprint" \
  --bootstrap-identity "$_nemoclaw_bootstrap_identity" \
  9<&-
if [ -e "$_nemoclaw_request" ] || [ -L "$_nemoclaw_request" ] \
  || [ -e "$_nemoclaw_claim" ] || [ -L "$_nemoclaw_claim" ]; then
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
    --bootstrap-identity "$_nemoclaw_bootstrap_identity" \
    9<&-
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
  --bootstrap-identity "$_nemoclaw_bootstrap_identity" \
  9<&-

exec 3<&- 4<&- 5<&- 6<&- 7<&- 8<&-
exec 3>&- 4>&- 5>&- 6>&- 7>&- 8>&-
exec /usr/bin/env -i \
  NEMOCLAW_MANAGED_BOOTSTRAP_RESUME="1" \
  "$NEMOCLAW_MANAGED_BOOTSTRAP_RESUME_EXECUTABLE" \
  --nemoclaw-resume-supervisor \
  "9" \
  "$_nemoclaw_supervisor_environment_count" \
  "$_nemoclaw_supervisor_environment_bytes" \
  -- \
  "$@"
