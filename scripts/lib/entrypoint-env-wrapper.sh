#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Bounded numeric grammar for the OpenClaw auto-pair scheduler knobs. Bash's
# printf builtin converts each admitted decimal with the same binary64 boundary
# behavior as the TypeScript launch validator. The normalized values can then
# be compared without bc, awk, or Python, which are unavailable to this PID 1
# entrypoint. Digit ranges are explicit so inherited collation cannot widen the
# grammar.
#
# An empty value is admitted: the watcher reads it as "use the built-in
# default", which is what an unset name already does.
_nemoclaw_bounded_seconds_value() {
  local LC_ALL=C
  local _nemoclaw_value
  local _nemoclaw_maximum="${2:?maximum is required}"
  local _nemoclaw_normalized
  local _nemoclaw_normalized_maximum
  local _nemoclaw_value_exponent
  local _nemoclaw_maximum_exponent
  local _nemoclaw_value_digits
  local _nemoclaw_maximum_digits
  local _nemoclaw_mantissa
  local _nemoclaw_integer
  local _nemoclaw_fraction
  local _nemoclaw_decimal_digits
  local _nemoclaw_leading_zeros
  local _nemoclaw_significant_digits
  local _nemoclaw_explicit_exponent=0
  local _nemoclaw_effective_exponent
  local _nemoclaw_half_min_subnormal
  local _nemoclaw_padding
  [ -n "${1-}" ] || return 0
  _nemoclaw_value="${1#+}"
  if [[ ! "$_nemoclaw_value" =~ ^([0123456789]+(\.[0123456789]*)?|\.[0123456789]+)([eE][+-]?[0123456789]{1,3})?$ ]]; then
    return 1
  fi

  # Linux Bash parses printf operands as long doubles, whose range extends
  # below binary64. Reject exact decimal values at or below 2^-1075 before
  # printf so values that JavaScript rounds to zero cannot cross this shell
  # boundary. The coefficient is the exact finite decimal expansion of
  # 5^1075; comparing zero-padded significant digits keeps this dependency-free.
  _nemoclaw_mantissa="${_nemoclaw_value%%[eE]*}"
  if [[ "$_nemoclaw_value" == *[eE]* ]]; then
    _nemoclaw_explicit_exponent="${_nemoclaw_value##*[eE]}"
    case "$_nemoclaw_explicit_exponent" in
      -*) _nemoclaw_explicit_exponent="-$((10#${_nemoclaw_explicit_exponent#-}))" ;;
      *) _nemoclaw_explicit_exponent="$((10#${_nemoclaw_explicit_exponent#+}))" ;;
    esac
  fi
  if [[ "$_nemoclaw_mantissa" == *.* ]]; then
    _nemoclaw_integer="${_nemoclaw_mantissa%%.*}"
    _nemoclaw_fraction="${_nemoclaw_mantissa#*.}"
  else
    _nemoclaw_integer="$_nemoclaw_mantissa"
    _nemoclaw_fraction=""
  fi
  _nemoclaw_decimal_digits="${_nemoclaw_integer}${_nemoclaw_fraction}"
  _nemoclaw_leading_zeros="${_nemoclaw_decimal_digits%%[!0]*}"
  _nemoclaw_significant_digits="${_nemoclaw_decimal_digits#"$_nemoclaw_leading_zeros"}"
  [ -n "$_nemoclaw_significant_digits" ] || return 1
  _nemoclaw_effective_exponent=$((\
    _nemoclaw_explicit_exponent + ${#_nemoclaw_integer} - ${#_nemoclaw_leading_zeros} - 1))
  if [ "$_nemoclaw_effective_exponent" -lt -324 ]; then
    return 1
  fi
  if [ "$_nemoclaw_effective_exponent" -eq -324 ]; then
    _nemoclaw_half_min_subnormal="247032822920623272088284396434110686182529901307162382212792841250337753635104375932649918180817"
    _nemoclaw_half_min_subnormal+="996189898282347722858865463328355177969898199387398005390939063150356595155702263922908583924491"
    _nemoclaw_half_min_subnormal+="051844359318028499365361525003193704576782492193656236698636584807570015857692699037063119282795"
    _nemoclaw_half_min_subnormal+="585513329278343384093519780155312465972635795746227664652728272200563740064854999770965994704540"
    _nemoclaw_half_min_subnormal+="208281662262378573934507363390079677619305775067401763246736009689513405355374585166611342237666"
    _nemoclaw_half_min_subnormal+="786041621596804619144672918403005300575308490487653917113865916462395249126236538818796362393732"
    _nemoclaw_half_min_subnormal+="804238910186723484976682350898633885879256283027559956575244555072551893136908362547791869486679"
    _nemoclaw_half_min_subnormal+="94968324049705821028513185451396213837722826145437693412532098591327667236328125"
    if [ "${#_nemoclaw_significant_digits}" -lt "${#_nemoclaw_half_min_subnormal}" ]; then
      printf -v _nemoclaw_padding '%*s' \
        "$((${#_nemoclaw_half_min_subnormal} - ${#_nemoclaw_significant_digits}))" ''
      _nemoclaw_significant_digits+="${_nemoclaw_padding// /0}"
    elif [ "${#_nemoclaw_significant_digits}" -gt "${#_nemoclaw_half_min_subnormal}" ]; then
      printf -v _nemoclaw_padding '%*s' \
        "$((${#_nemoclaw_significant_digits} - ${#_nemoclaw_half_min_subnormal}))" ''
      _nemoclaw_half_min_subnormal+="${_nemoclaw_padding// /0}"
    fi
    # shellcheck disable=SC2071 # equal-width decimal strings require lexical order
    [[ "$_nemoclaw_significant_digits" > "$_nemoclaw_half_min_subnormal" ]] || return 1
  fi

  _nemoclaw_normalized=""
  _nemoclaw_normalized_maximum=""
  LC_NUMERIC=C printf -v _nemoclaw_normalized '%.17e' "$_nemoclaw_value" 2>/dev/null || :
  LC_NUMERIC=C printf -v _nemoclaw_normalized_maximum '%.17e' "$_nemoclaw_maximum" 2>/dev/null || :
  case "$_nemoclaw_normalized" in
    0.00000000000000000e+00 | inf | nan | '') return 1 ;;
  esac
  _nemoclaw_value_exponent="${_nemoclaw_normalized##*e}"
  _nemoclaw_maximum_exponent="${_nemoclaw_normalized_maximum##*e}"
  case "$_nemoclaw_value_exponent" in
    -*) _nemoclaw_value_exponent="-$((10#${_nemoclaw_value_exponent#-}))" ;;
    *) _nemoclaw_value_exponent="$((10#${_nemoclaw_value_exponent#+}))" ;;
  esac
  case "$_nemoclaw_maximum_exponent" in
    -*) _nemoclaw_maximum_exponent="-$((10#${_nemoclaw_maximum_exponent#-}))" ;;
    *) _nemoclaw_maximum_exponent="$((10#${_nemoclaw_maximum_exponent#+}))" ;;
  esac
  [ "$_nemoclaw_value_exponent" -lt "$_nemoclaw_maximum_exponent" ] && return 0
  [ "$_nemoclaw_value_exponent" -eq "$_nemoclaw_maximum_exponent" ] || return 1
  _nemoclaw_value_digits="${_nemoclaw_normalized%%e*}"
  _nemoclaw_value_digits="${_nemoclaw_value_digits//./}"
  _nemoclaw_maximum_digits="${_nemoclaw_normalized_maximum%%e*}"
  _nemoclaw_maximum_digits="${_nemoclaw_maximum_digits//./}"
  [ "$_nemoclaw_value_digits" -le "$_nemoclaw_maximum_digits" ]
}

# The fast-reentry counter is an integer, so it carries the launch renderer's
# safe-integer bound instead of the seconds grammar. The digit-count guard runs
# first so the comparison below cannot overflow Bash's 64-bit arithmetic.
_nemoclaw_bounded_polls_value() {
  local _nemoclaw_polls
  [ -n "${1-}" ] || return 0
  _nemoclaw_polls="${1#+}"
  [[ "$_nemoclaw_polls" =~ ^[0123456789]+$ ]] || return 1
  _nemoclaw_polls="${_nemoclaw_polls#"${_nemoclaw_polls%%[!0]*}"}"
  [ -n "$_nemoclaw_polls" ] || return 1
  [ "${#_nemoclaw_polls}" -le 16 ] && [ "$_nemoclaw_polls" -le 9007199254740991 ]
}

# Normalize OpenShell's sandbox-create command when an OCI runtime invokes the
# image ENTRYPOINT with the literal argv:
#
#   env NAME=value ... nemoclaw-start [agent command...]
#
# This runs before any managed-startup gate. Only environment names emitted by
# NemoClaw's launch renderer are promoted into the root entrypoint process;
# interpreter/loader variables such as NODE_OPTIONS, BASH_ENV, PATH, and
# LD_PRELOAD therefore cannot be smuggled into the trusted profile applicator.
#
# Result: NEMOCLAW_ENTRYPOINT_NORMALIZED_ARGV contains the command tail.
nemoclaw_normalize_entrypoint_env_wrapper() {
  NEMOCLAW_ENTRYPOINT_NORMALIZED_ARGV=("$@")
  NEMOCLAW_ENTRYPOINT_NORMALIZED_ARGC="$#"
  [ "$#" -gt 0 ] || return 0

  case "$1" in
    nemoclaw-start | /usr/local/bin/nemoclaw-start)
      shift
      NEMOCLAW_ENTRYPOINT_NORMALIZED_ARGV=("$@")
      NEMOCLAW_ENTRYPOINT_NORMALIZED_ARGC="$#"
      return 0
      ;;
    env) ;;
    *) return 0 ;;
  esac

  local -a _nemoclaw_original_argv=("$@")
  local -a _nemoclaw_assignments=()
  local _nemoclaw_self_index=-1
  local _nemoclaw_index
  local _nemoclaw_break_index
  local _nemoclaw_token
  local _nemoclaw_name
  local _nemoclaw_seen_names="|"
  local _nemoclaw_supported_names="|AWS_EC2_METADATA_DISABLED|CHAT_UI_URL"
  _nemoclaw_supported_names="${_nemoclaw_supported_names}|HTTP_PROXY|HTTPS_PROXY|NO_PROXY"
  _nemoclaw_supported_names="${_nemoclaw_supported_names}|http_proxy|https_proxy|no_proxy"
  _nemoclaw_supported_names="${_nemoclaw_supported_names}|OPENCLAW_HOME|OPENCLAW_STATE_DIR"
  _nemoclaw_supported_names="${_nemoclaw_supported_names}|OPENCLAW_WORKSPACE_DIR"
  _nemoclaw_supported_names="${_nemoclaw_supported_names}|NEMOCLAW_AUTO_PAIR_DEADLINE_SECS"
  _nemoclaw_supported_names="${_nemoclaw_supported_names}|NEMOCLAW_AUTO_PAIR_FAST_DEADLINE_SECS"
  _nemoclaw_supported_names="${_nemoclaw_supported_names}|NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS"
  _nemoclaw_supported_names="${_nemoclaw_supported_names}|NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS"
  _nemoclaw_supported_names="${_nemoclaw_supported_names}|NEMOCLAW_AUTO_PAIR_RUN_TIMEOUT_SECS"
  _nemoclaw_supported_names="${_nemoclaw_supported_names}|NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS"
  _nemoclaw_supported_names="${_nemoclaw_supported_names}|NEMOCLAW_CORPORATE_CA_B64"
  _nemoclaw_supported_names="${_nemoclaw_supported_names}|NEMOCLAW_DASHBOARD_BIND|NEMOCLAW_DASHBOARD_PORT"
  _nemoclaw_supported_names="${_nemoclaw_supported_names}|NEMOCLAW_EXTRA_PLACEHOLDER_KEYS"
  _nemoclaw_supported_names="${_nemoclaw_supported_names}|NEMOCLAW_HERMES_API_PORT"
  _nemoclaw_supported_names="${_nemoclaw_supported_names}|NEMOCLAW_HERMES_DASHBOARD"
  _nemoclaw_supported_names="${_nemoclaw_supported_names}|NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT"
  _nemoclaw_supported_names="${_nemoclaw_supported_names}|NEMOCLAW_HERMES_DASHBOARD_PORT"
  _nemoclaw_supported_names="${_nemoclaw_supported_names}|NEMOCLAW_HERMES_DASHBOARD_TUI"
  _nemoclaw_supported_names="${_nemoclaw_supported_names}|NEMOCLAW_MINIMAL_BOOTSTRAP"
  _nemoclaw_supported_names="${_nemoclaw_supported_names}|NEMOCLAW_OBSERVABILITY"
  _nemoclaw_supported_names="${_nemoclaw_supported_names}|NEMOCLAW_PROXY_HOST|NEMOCLAW_PROXY_PORT"
  _nemoclaw_supported_names="${_nemoclaw_supported_names}|NEMOCLAW_SANDBOX_NAME"
  _nemoclaw_supported_names="${_nemoclaw_supported_names}|NEMOCLAW_STARTUP_PROFILE_B64|"

  # Locate only the exact self-wrapper grammar. A normal explicit command such
  # as `env FOO=bar printenv` carries no managed name in its leading assignment
  # run. This root entrypoint normalization therefore leaves it unchanged.
  # NEMOCLAW_STARTUP_PROFILE_B64 and NEMOCLAW_CORPORATE_CA_B64 are rejected in
  # any argument position by the terminator-missing branch below.
  for ((_nemoclaw_index = 1; _nemoclaw_index < ${#_nemoclaw_original_argv[@]}; _nemoclaw_index += 1)); do
    _nemoclaw_token="${_nemoclaw_original_argv[$_nemoclaw_index]}"
    case "$_nemoclaw_token" in
      nemoclaw-start | /usr/local/bin/nemoclaw-start)
        _nemoclaw_self_index="$_nemoclaw_index"
        break
        ;;
      *=*) ;;
      *) break ;;
    esac
  done

  if [ "$_nemoclaw_self_index" -lt 0 ]; then
    # A managed handoff must never silently degrade into an unmanaged command
    # because the self-wrapper was absent or malformed. This branch rejects
    # NEMOCLAW_STARTUP_PROFILE_B64 and NEMOCLAW_CORPORATE_CA_B64 in any
    # argument position. Any other managed name indicates a degraded handoff
    # only when it appears in the leading assignment run. A sequence whose
    # tail alone assigns any other managed name stays a user command.
    _nemoclaw_break_index="$_nemoclaw_index"
    for _nemoclaw_token in "${_nemoclaw_original_argv[@]:1}"; do
      case "$_nemoclaw_token" in
        NEMOCLAW_STARTUP_PROFILE_B64=* | NEMOCLAW_CORPORATE_CA_B64=*)
          printf '%s\n' \
            '[SECURITY] Malformed managed startup env wrapper; expected nemoclaw-start after assignments.' >&2
          return 1
          ;;
      esac
    done
    for ((_nemoclaw_index = 1; _nemoclaw_index < _nemoclaw_break_index; _nemoclaw_index += 1)); do
      _nemoclaw_name="${_nemoclaw_original_argv[$_nemoclaw_index]%%=*}"
      case "$_nemoclaw_supported_names" in
        *"|${_nemoclaw_name}|"*)
          printf '%s\n' \
            '[SECURITY] Malformed managed startup env wrapper; expected nemoclaw-start after assignments.' >&2
          return 1
          ;;
      esac
    done
    return 0
  fi

  if [ "$_nemoclaw_self_index" -gt 65 ]; then
    printf '%s\n' '[SECURITY] Managed startup env wrapper has too many assignments.' >&2
    return 1
  fi

  for ((_nemoclaw_index = 1; _nemoclaw_index < _nemoclaw_self_index; _nemoclaw_index += 1)); do
    _nemoclaw_token="${_nemoclaw_original_argv[$_nemoclaw_index]}"
    _nemoclaw_name="${_nemoclaw_token%%=*}"
    if [ "${#_nemoclaw_token}" -gt 122880 ] \
      || [[ ! "$_nemoclaw_name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] \
      || [[ "$_nemoclaw_token" == *$'\n'* ]] \
      || [[ "$_nemoclaw_token" == *$'\r'* ]]; then
      printf '%s\n' '[SECURITY] Managed startup env wrapper contains a malformed assignment.' >&2
      return 1
    fi
    case "$_nemoclaw_supported_names" in
      *"|${_nemoclaw_name}|"*) ;;
      *)
        printf '%s\n' \
          "[SECURITY] Managed startup env wrapper contains unsupported variable '${_nemoclaw_name}'." >&2
        return 1
        ;;
    esac
    case "$_nemoclaw_seen_names" in
      *"|${_nemoclaw_name}|"*)
        printf '%s\n' \
          "[SECURITY] Managed startup env wrapper repeats variable '${_nemoclaw_name}'." >&2
        return 1
        ;;
    esac
    case "$_nemoclaw_name" in
      NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS)
        if ! _nemoclaw_bounded_polls_value "${_nemoclaw_token#*=}"; then
          printf '%s\n' \
            '[SECURITY] Managed startup env wrapper contains an out-of-range assignment.' >&2
          return 1
        fi
        ;;
      NEMOCLAW_AUTO_PAIR_DEADLINE_SECS | NEMOCLAW_AUTO_PAIR_FAST_DEADLINE_SECS)
        if ! _nemoclaw_bounded_seconds_value "${_nemoclaw_token#*=}" 1000000000000; then
          printf '%s\n' \
            '[SECURITY] Managed startup env wrapper contains an out-of-range assignment.' >&2
          return 1
        fi
        ;;
      NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS | \
        NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS)
        if ! _nemoclaw_bounded_seconds_value "${_nemoclaw_token#*=}" 1000000000; then
          printf '%s\n' \
            '[SECURITY] Managed startup env wrapper contains an out-of-range assignment.' >&2
          return 1
        fi
        ;;
      NEMOCLAW_AUTO_PAIR_RUN_TIMEOUT_SECS)
        if ! _nemoclaw_bounded_seconds_value "${_nemoclaw_token#*=}" 2147483; then
          printf '%s\n' \
            '[SECURITY] Managed startup env wrapper contains an out-of-range assignment.' >&2
          return 1
        fi
        ;;
    esac
    _nemoclaw_assignments+=("$_nemoclaw_token")
    _nemoclaw_seen_names="${_nemoclaw_seen_names}${_nemoclaw_name}|"
  done

  # Export only after the complete vector has passed validation so malformed
  # input cannot leave a partially mutated root process.
  if [ "$_nemoclaw_self_index" -gt 1 ]; then
    for _nemoclaw_token in "${_nemoclaw_assignments[@]}"; do
      export "${_nemoclaw_token?}"
    done
  fi
  # shellcheck disable=SC2034 # output array is consumed by the sourcing entrypoint
  NEMOCLAW_ENTRYPOINT_NORMALIZED_ARGV=(
    "${_nemoclaw_original_argv[@]:$((_nemoclaw_self_index + 1))}"
  )
  # shellcheck disable=SC2034 # output count is consumed by the sourcing entrypoint
  NEMOCLAW_ENTRYPOINT_NORMALIZED_ARGC=$((\
    ${#_nemoclaw_original_argv[@]} - _nemoclaw_self_index - 1))
}
