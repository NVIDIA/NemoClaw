# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# shellcheck shell=sh
#
# Shared NemoClaw sandbox RLIMIT defaults. Sourced by bash entrypoints and by
# /bin/sh-compatible profile hooks during `openshell sandbox exec`.

NEMOCLAW_SANDBOX_NPROC_LIMIT=512
NEMOCLAW_SANDBOX_NOFILE_LIMIT=65536

_nemoclaw_ulimit() {
  # `command` bypasses shell functions named `ulimit` in bash and POSIX sh,
  # while still invoking the shell's special builtin. `builtin ulimit` is
  # bash-only and breaks when /etc/profile.d hooks are sourced by /bin/sh.
  command ulimit "$@"
}

_nemoclaw_supports_resource_limit() {
  _nemoclaw_support_flag="$1"
  _nemoclaw_support_status=0

  _nemoclaw_ulimit "-S${_nemoclaw_support_flag}" >/dev/null 2>&1 || _nemoclaw_support_status=1

  _nemoclaw_support_return="$_nemoclaw_support_status"
  unset _nemoclaw_support_flag _nemoclaw_support_status
  return "$_nemoclaw_support_return"
}

_nemoclaw_set_resource_limit() {
  _nemoclaw_limit_flag="$1"
  _nemoclaw_limit_value="$2"
  _nemoclaw_limit_label="$3"
  _nemoclaw_limit_quiet="${4:-}"

  if _nemoclaw_supports_resource_limit "$_nemoclaw_limit_flag"; then
    if ! _nemoclaw_ulimit "-S${_nemoclaw_limit_flag}" "$_nemoclaw_limit_value" 2>/dev/null; then
      if [ "$_nemoclaw_limit_quiet" != "--quiet" ]; then
        echo "[SECURITY] Could not set soft ${_nemoclaw_limit_label} limit (container runtime may restrict ulimit)" >&2
      fi
    fi
    if ! _nemoclaw_ulimit "-H${_nemoclaw_limit_flag}" "$_nemoclaw_limit_value" 2>/dev/null; then
      if [ "$_nemoclaw_limit_quiet" != "--quiet" ]; then
        echo "[SECURITY] Could not set hard ${_nemoclaw_limit_label} limit (container runtime may restrict ulimit)" >&2
      fi
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
  _nemoclaw_limit_requirement="${5:-maximum}"
  _nemoclaw_limit_status=0

  if ! _nemoclaw_supports_resource_limit "$_nemoclaw_limit_flag"; then
    if [ "$_nemoclaw_limit_requirement" = "exact" ]; then
      if [ "$_nemoclaw_limit_quiet" != "--quiet" ]; then
        echo "[SECURITY] Cannot verify exact ${_nemoclaw_limit_label} limit in this shell" >&2
      fi
      unset _nemoclaw_limit_flag _nemoclaw_limit_value _nemoclaw_limit_label
      unset _nemoclaw_limit_quiet _nemoclaw_limit_requirement _nemoclaw_limit_status
      return 1
    fi
    # POSIX profile hooks can be sourced by /bin/sh (dash on Ubuntu), which
    # supports nofile (-n) but not nproc (-u). Treat an unsupported flag as
    # not enforceable in this shell rather than as drift; otherwise ordinary
    # `openshell sandbox exec ... sh -lc ...` probes emit false security
    # warnings before user code runs. Supported limits are still set and
    # verified independently by verify_resource_limits. Remove or escalate this
    # compatibility path if OpenShell guarantees profile hooks run under a shell
    # with nproc support, or if a currently supported flag such as nofile
    # becomes unsupported.
    unset _nemoclaw_limit_flag _nemoclaw_limit_value _nemoclaw_limit_label
    unset _nemoclaw_limit_quiet _nemoclaw_limit_requirement
    return 0
  fi

  for _nemoclaw_limit_bound in soft hard; do
    case "$_nemoclaw_limit_bound" in
      soft)
        _nemoclaw_limit_mode="S"
        ;;
      hard)
        _nemoclaw_limit_mode="H"
        ;;
    esac
    _nemoclaw_effective_limit="$(_nemoclaw_ulimit "-${_nemoclaw_limit_mode}${_nemoclaw_limit_flag}" 2>/dev/null || printf '%s' unknown)"

    _nemoclaw_limit_mismatch=0
    if ! _nemoclaw_is_decimal_limit "$_nemoclaw_effective_limit"; then
      _nemoclaw_limit_mismatch=1
    elif [ "$_nemoclaw_limit_requirement" = "exact" ]; then
      [ "$_nemoclaw_effective_limit" -eq "$_nemoclaw_limit_value" ] \
        || _nemoclaw_limit_mismatch=1
    elif [ "$_nemoclaw_effective_limit" -gt "$_nemoclaw_limit_value" ]; then
      _nemoclaw_limit_mismatch=1
    fi

    if [ "$_nemoclaw_limit_mismatch" -ne 0 ]; then
      if [ "$_nemoclaw_limit_quiet" != "--quiet" ]; then
        _nemoclaw_limit_expected="<= ${_nemoclaw_limit_value}"
        if [ "$_nemoclaw_limit_requirement" = "exact" ]; then
          _nemoclaw_limit_expected="exactly ${_nemoclaw_limit_value}"
        fi
        echo "[SECURITY] Effective ${_nemoclaw_limit_bound} ${_nemoclaw_limit_label} limit is ${_nemoclaw_effective_limit}; expected ${_nemoclaw_limit_expected} (container runtime may restrict ulimit)" >&2
      fi
      _nemoclaw_limit_status=1
    fi
  done

  _nemoclaw_limit_return="$_nemoclaw_limit_status"
  unset _nemoclaw_limit_flag _nemoclaw_limit_value _nemoclaw_limit_label
  unset _nemoclaw_limit_quiet _nemoclaw_limit_requirement
  unset _nemoclaw_limit_status _nemoclaw_limit_bound _nemoclaw_limit_mode _nemoclaw_effective_limit
  unset _nemoclaw_limit_mismatch _nemoclaw_limit_expected
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
  _nemoclaw_rlimit_quiet="${1:-}"
  _nemoclaw_rlimit_status=0

  _nemoclaw_verify_resource_limit u "$NEMOCLAW_SANDBOX_NPROC_LIMIT" nproc "$_nemoclaw_rlimit_quiet" \
    || _nemoclaw_rlimit_status=1
  _nemoclaw_verify_resource_limit n "$NEMOCLAW_SANDBOX_NOFILE_LIMIT" nofile "$_nemoclaw_rlimit_quiet" \
    || _nemoclaw_rlimit_status=1

  _nemoclaw_rlimit_return="$_nemoclaw_rlimit_status"
  unset _nemoclaw_rlimit_quiet _nemoclaw_rlimit_status
  return "$_nemoclaw_rlimit_return"
}

# DCode's managed contract requires the documented defaults, not merely upper
# bounds. This distinguishes a successfully applied 65536 nofile default from
# the reproduced 1024 runtime default in #6545. OpenClaw and Hermes retain the
# maximum-cap verifier above for compatibility with deliberate lower overrides.
verify_resource_limits_exact() {
  _nemoclaw_rlimit_quiet="${1:-}"
  _nemoclaw_rlimit_status=0

  _nemoclaw_verify_resource_limit u "$NEMOCLAW_SANDBOX_NPROC_LIMIT" nproc "$_nemoclaw_rlimit_quiet" exact \
    || _nemoclaw_rlimit_status=1
  _nemoclaw_verify_resource_limit n "$NEMOCLAW_SANDBOX_NOFILE_LIMIT" nofile "$_nemoclaw_rlimit_quiet" exact \
    || _nemoclaw_rlimit_status=1

  _nemoclaw_rlimit_return="$_nemoclaw_rlimit_status"
  unset _nemoclaw_rlimit_quiet _nemoclaw_rlimit_status
  return "$_nemoclaw_rlimit_return"
}
