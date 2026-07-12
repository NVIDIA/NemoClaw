#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Case: host-side security checks (add sections here as the suite grows).
#
# Current:
#   - VDR3 #13: cloud API token env var must not appear in `ps` (full value or env-style argv assignment leak).
#
# We avoid grepping the live secret on the command line (that would leak the key into ps).

set -euo pipefail

# The caller can point this check at the active hosted-inference credential.
_api_key_env_name="${NEMOCLAW_E2E_CLOUD_API_KEY_ENV:-NVIDIA_INFERENCE_API_KEY}"
if [[ ! "$_api_key_env_name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
  printf '%s\n' "03-security-checks: FAIL: invalid cloud API token env var name: ${_api_key_env_name}" >&2
  exit 1
fi
: "${!_api_key_env_name:?cloud API token env var must be set (export before running)}"

die() {
  printf '%s\n' "03-security-checks: FAIL: $*" >&2
  exit 1
}

# ── VDR3 #13: API key not in ps ─────────────────────────────────────
ps_lines=$( (ps auxww 2>/dev/null || ps auxeww 2>/dev/null || ps aux 2>/dev/null) || true)
[ -n "$ps_lines" ] || die "api-key-in-ps: could not capture ps output"

_api_key_value="${!_api_key_env_name}"
while IFS= read -r line; do
  case "$line" in
    *"$_api_key_value"*) die "api-key-in-ps: full API key material appears in ps output" ;;
  esac
done <<<"$ps_lines"

# argv-style leak: NAME=<first six key characters>. The caller can override or
# disable this marker with NEMOCLAW_E2E_CLOUD_API_KEY_ARGV_PREFIX.
_key_argv_prefix_marker="${NEMOCLAW_E2E_CLOUD_API_KEY_ARGV_PREFIX:-}"
if [ -z "${NEMOCLAW_E2E_CLOUD_API_KEY_ARGV_PREFIX+x}" ]; then
  _key_argv_prefix_marker="$(printf '%.6s' "$_api_key_value")"
fi
if [ -n "$_key_argv_prefix_marker" ]; then
  _key_argv_needle="${_api_key_env_name}=${_key_argv_prefix_marker}"
  while IFS= read -r line; do
    case "$line" in
      *"${_key_argv_needle}"*) die "api-key-in-ps: env-style API key argv leak in ps" ;;
    esac
  done <<<"$ps_lines"
fi

printf '%s\n' "03-security-checks: OK (api-key-in-ps)"
exit 0
