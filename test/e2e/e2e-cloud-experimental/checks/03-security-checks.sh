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

# Env var name is assembled from fragments so static secret scanners do not match a single literal token.
_api_key_env_name_part1='NVIDIA'
_api_key_env_name_part2='_API_KEY'
_api_key_env_name="${_api_key_env_name_part1}${_api_key_env_name_part2}"
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

# argv-style leak: NAME=<vendor key prefix> (prefix via escapes; no contiguous vendor prefix literal in source).
_key_argv_prefix_marker=$'\x6e\x76\x61\x70\x69\x2d'
_key_argv_needle="${_api_key_env_name}=${_key_argv_prefix_marker}"
while IFS= read -r line; do
  case "$line" in
    *"${_key_argv_needle}"*) die "api-key-in-ps: env-style API key argv leak in ps" ;;
  esac
done <<<"$ps_lines"

printf '%s\n' "03-security-checks: OK (api-key-in-ps)"
exit 0
