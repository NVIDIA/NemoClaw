#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

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
