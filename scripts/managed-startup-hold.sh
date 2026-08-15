#!/bin/bash -p
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Trusted image-owned hold for managed startup. The image OCI user remains root
# for the OpenShell supervisor, which deliberately drops the sandbox startup
# command to sandbox:sandbox before entering this hold. The host separately
# applies one bounded profile as root to the exact final container. No agent
# process starts until the root-owned marker authenticates the exact
# runtime-environment handoff.

set -euo pipefail
unset BASH_ENV CDPATH ENV GLOBIGNORE LD_AUDIT LD_LIBRARY_PATH LD_PRELOAD
unset NODE_OPTIONS NODE_PATH PS4
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

fail() {
  printf '[SECURITY] Managed startup hold: %s\n' "$*" >&2
  exit 1
}

_nemoclaw_sandbox_uid="$(id -u sandbox)" || fail "sandbox uid is unavailable"
_nemoclaw_sandbox_gid="$(id -g sandbox)" || fail "sandbox gid is unavailable"
if [ "$(id -u)" -ne "$_nemoclaw_sandbox_uid" ] \
  || [ "$(id -g)" -ne "$_nemoclaw_sandbox_gid" ]; then
  fail "must run as the sandbox account"
fi
[ "$#" -ge 7 ] \
  || fail "expected --agent <agent> --profile-fingerprint <sha256> --bootstrap-identity <sha256> -- [tail...]"
[ "$1" = "--agent" ] || fail "agent argument is missing"
_nemoclaw_agent="$2"
[ "$3" = "--profile-fingerprint" ] || fail "profile fingerprint argument is missing"
_nemoclaw_fingerprint="$4"
[ "$5" = "--bootstrap-identity" ] || fail "bootstrap identity argument is missing"
_nemoclaw_bootstrap_identity="$6"
[ "$7" = "--" ] || fail "startup argument delimiter is missing"
shift 7

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
  *[!0-9a-f]* | "") fail "bootstrap identity must be lowercase SHA-256" ;;
esac
[ "${#_nemoclaw_bootstrap_identity}" -eq 64 ] \
  || fail "bootstrap identity must be lowercase SHA-256"

_nemoclaw_runtime="/usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs"
_nemoclaw_runtime_env="/run/nemoclaw/managed-startup-runtime.env"
[ -f "$_nemoclaw_runtime" ] || fail "managed startup runtime is missing"

/usr/local/bin/node "$_nemoclaw_runtime" \
  --wait-for-completion \
  --agent "$_nemoclaw_agent" \
  --profile-fingerprint "$_nemoclaw_fingerprint" \
  --bootstrap-identity "$_nemoclaw_bootstrap_identity"

if [ -L "$_nemoclaw_runtime_env" ] \
  || [ ! -f "$_nemoclaw_runtime_env" ] \
  || [ "$(stat -c '%u:%g:%a' "$_nemoclaw_runtime_env")" != "0:0:444" ]; then
  fail "runtime environment failed root ownership validation"
fi

# shellcheck disable=SC1090 # fixed root-owned path authenticated by exact digest above
. "$_nemoclaw_runtime_env"
unset NEMOCLAW_STARTUP_PROFILE_B64 NEMOCLAW_CORPORATE_CA_B64
unset BASH_ENV CDPATH ENV GLOBIGNORE LD_AUDIT LD_LIBRARY_PATH LD_PRELOAD
unset NODE_OPTIONS NODE_PATH PS4
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# Bash privileged mode prevents inherited functions and startup files from
# influencing this hold. Remove their environment transports as well before
# the fixed image-owned entrypoint starts a fresh shell.
_nemoclaw_scrubbed_env=(
  /usr/bin/env
  -u BASHOPTS
  -u BASH_ENV
  -u ENV
  -u LD_AUDIT
  -u LD_LIBRARY_PATH
  -u LD_PRELOAD
  -u NODE_OPTIONS
  -u NODE_PATH
  -u PS4
  -u SHELLOPTS
)
while IFS='=' read -r _nemoclaw_environment_name _; do
  case "$_nemoclaw_environment_name" in
    BASH_FUNC_*) _nemoclaw_scrubbed_env+=(-u "$_nemoclaw_environment_name") ;;
  esac
done < <(/usr/bin/env)

unset _nemoclaw_agent _nemoclaw_fingerprint _nemoclaw_bootstrap_identity
unset _nemoclaw_runtime _nemoclaw_runtime_env _nemoclaw_sandbox_uid _nemoclaw_sandbox_gid
unset _nemoclaw_environment_name
unset -f fail
exec "${_nemoclaw_scrubbed_env[@]}" /usr/local/bin/nemoclaw-start "$@"
