# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# shellcheck shell=bash
#
# Shared NemoClaw sandbox RLIMIT defaults.

NEMOCLAW_SANDBOX_NPROC_LIMIT=512
NEMOCLAW_SANDBOX_NOFILE_LIMIT=65536

_nemoclaw_set_resource_limit() {
  _nemoclaw_limit_flag="$1"
  _nemoclaw_limit_value="$2"
  _nemoclaw_limit_label="$3"
  _nemoclaw_limit_quiet="${4:-}"

  if ! builtin ulimit "-S${_nemoclaw_limit_flag}" "$_nemoclaw_limit_value" 2>/dev/null; then
    if [ "$_nemoclaw_limit_quiet" != "--quiet" ]; then
      echo "[SECURITY] Could not set soft ${_nemoclaw_limit_label} limit (container runtime may restrict ulimit)" >&2
    fi
  fi
  if ! builtin ulimit "-H${_nemoclaw_limit_flag}" "$_nemoclaw_limit_value" 2>/dev/null; then
    if [ "$_nemoclaw_limit_quiet" != "--quiet" ]; then
      echo "[SECURITY] Could not set hard ${_nemoclaw_limit_label} limit (container runtime may restrict ulimit)" >&2
    fi
  fi

  unset _nemoclaw_limit_flag _nemoclaw_limit_value _nemoclaw_limit_label _nemoclaw_limit_quiet
}

_nemoclaw_is_decimal_limit() {
  case "$1" in
    "" | *[!0-9]*)
      return 1
      ;;
    *)
      return 0
      ;;
  esac
}

_nemoclaw_verify_resource_limit() {
  _nemoclaw_limit_flag="$1"
  _nemoclaw_limit_value="$2"
  _nemoclaw_limit_label="$3"
  _nemoclaw_limit_quiet="${4:-}"
  _nemoclaw_limit_status=0

  for _nemoclaw_limit_bound in soft hard; do
    case "$_nemoclaw_limit_bound" in
      soft)
        _nemoclaw_limit_mode="S"
        ;;
      hard)
        _nemoclaw_limit_mode="H"
        ;;
    esac
    _nemoclaw_effective_limit="$(builtin ulimit "-${_nemoclaw_limit_mode}${_nemoclaw_limit_flag}" 2>/dev/null || printf '%s' unknown)"

    if ! _nemoclaw_is_decimal_limit "$_nemoclaw_effective_limit" \
      || [ "$_nemoclaw_effective_limit" -gt "$_nemoclaw_limit_value" ]; then
      if [ "$_nemoclaw_limit_quiet" != "--quiet" ]; then
        echo "[SECURITY] Effective ${_nemoclaw_limit_bound} ${_nemoclaw_limit_label} limit is ${_nemoclaw_effective_limit}; expected <= ${_nemoclaw_limit_value} (container runtime may restrict ulimit)" >&2
      fi
      _nemoclaw_limit_status=1
    fi
  done

  _nemoclaw_limit_return="$_nemoclaw_limit_status"
  unset _nemoclaw_limit_flag _nemoclaw_limit_value _nemoclaw_limit_label _nemoclaw_limit_quiet
  unset _nemoclaw_limit_status _nemoclaw_limit_bound _nemoclaw_limit_mode _nemoclaw_effective_limit
  return "$_nemoclaw_limit_return"
}

# Harden RLIMITs at PID 1 (root) so caps are inherited by entrypoint descendants
# and cannot be raised after privilege step-down. The same function is also
# sourced by connect-shell hooks, because OpenShell connect shells are spawned
# outside the PID 1 tree and therefore do not inherit those lowered limits.
harden_resource_limits() {
  _nemoclaw_rlimit_quiet="${1:-}"
  _nemoclaw_set_resource_limit u "$NEMOCLAW_SANDBOX_NPROC_LIMIT" nproc "$_nemoclaw_rlimit_quiet"
  _nemoclaw_set_resource_limit n "$NEMOCLAW_SANDBOX_NOFILE_LIMIT" nofile "$_nemoclaw_rlimit_quiet"
  unset _nemoclaw_rlimit_quiet
}

verify_resource_limits() {
  local _nemoclaw_rlimit_quiet="${1:-}"
  local _nemoclaw_rlimit_status=0

  _nemoclaw_verify_resource_limit u "$NEMOCLAW_SANDBOX_NPROC_LIMIT" nproc "$_nemoclaw_rlimit_quiet" \
    || _nemoclaw_rlimit_status=1
  _nemoclaw_verify_resource_limit n "$NEMOCLAW_SANDBOX_NOFILE_LIMIT" nofile "$_nemoclaw_rlimit_quiet" \
    || _nemoclaw_rlimit_status=1

  return "$_nemoclaw_rlimit_status"
}
