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
  local _nemoclaw_token
  local _nemoclaw_name
  local _nemoclaw_seen_names="|"

  # Locate only the exact self-wrapper grammar. A normal explicit command such
  # as `env FOO=bar printenv` remains a user command and is not interpreted by
  # this root entrypoint normalization.
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
    # because the self-wrapper was absent or malformed.
    for _nemoclaw_token in "${_nemoclaw_original_argv[@]:1}"; do
      case "$_nemoclaw_token" in
        NEMOCLAW_STARTUP_PROFILE_B64=* | NEMOCLAW_CORPORATE_CA_B64=*)
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
    case "$_nemoclaw_name" in
      AWS_EC2_METADATA_DISABLED | \
        CHAT_UI_URL | \
        HTTP_PROXY | HTTPS_PROXY | NO_PROXY | \
        http_proxy | https_proxy | no_proxy | \
        OPENCLAW_HOME | OPENCLAW_STATE_DIR | OPENCLAW_WORKSPACE_DIR | \
        NEMOCLAW_AUTO_PAIR_DEADLINE_SECS | \
        NEMOCLAW_AUTO_PAIR_FAST_DEADLINE_SECS | \
        NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS | \
        NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS | \
        NEMOCLAW_AUTO_PAIR_RUN_TIMEOUT_SECS | \
        NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS | \
        NEMOCLAW_CORPORATE_CA_B64 | \
        NEMOCLAW_DASHBOARD_BIND | NEMOCLAW_DASHBOARD_PORT | \
        NEMOCLAW_EXTRA_PLACEHOLDER_KEYS | \
        NEMOCLAW_HERMES_DASHBOARD | \
        NEMOCLAW_HERMES_DASHBOARD_INTERNAL_PORT | \
        NEMOCLAW_HERMES_DASHBOARD_PORT | \
        NEMOCLAW_HERMES_DASHBOARD_TUI | \
        NEMOCLAW_MINIMAL_BOOTSTRAP | \
        NEMOCLAW_OBSERVABILITY | \
        NEMOCLAW_PROXY_HOST | NEMOCLAW_PROXY_PORT | \
        NEMOCLAW_SANDBOX_NAME | \
        NEMOCLAW_STARTUP_PROFILE_B64) ;;
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
