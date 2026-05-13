#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Canonical `nemoclaw shell <sandbox> -- <cmd>` wrapper.
#
# Absorbs reuse category #10 from the migration spec: 15 legacy scripts
# each reimplement sandbox-scoped exec with subtle drift (quoting, exit-
# code propagation, dry-run handling). This helper provides a single
# contract shared by every migrated suite step.
#
# Functions:
#   e2e_sandbox_exec       <sandbox> -- <cmd> [args...]
#       Run <cmd> inside <sandbox> via `nemoclaw shell`. No stdin passed.
#       Exit code propagates from <cmd>. Honors E2E_DRY_RUN.
#
#   e2e_sandbox_exec_stdin <sandbox> -- <cmd> [args...]
#       Like e2e_sandbox_exec but pipes the caller's stdin into the
#       sandbox command. Safe for secrets: no host-side expansion is
#       performed on stdin content.

_E2E_SBEX_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../runtime/lib" && pwd)"
# shellcheck source=../runtime/lib/env.sh
. "${_E2E_SBEX_LIB_DIR}/env.sh"

# _e2e_sbex_split_args <sandbox> -- <cmd> [args...]
# Parses the shared calling convention. Prints on stderr on misuse and
# returns 2. On success, sets the two global arrays _E2E_SBEX_SB_NAME and
# _E2E_SBEX_CMD.
_e2e_sbex_parse() {
  local sandbox="${1:-}"
  if [[ -z "${sandbox}" ]]; then
    echo "e2e_sandbox_exec: missing sandbox name" >&2
    return 2
  fi
  shift
  local sep="${1:-}"
  if [[ "${sep}" != "--" ]]; then
    echo "e2e_sandbox_exec: expected '--' after sandbox name, got '${sep}'" >&2
    return 2
  fi
  shift
  if [[ $# -eq 0 ]]; then
    echo "e2e_sandbox_exec: missing command to run in sandbox" >&2
    return 2
  fi
  _E2E_SBEX_SB_NAME="${sandbox}"
  _E2E_SBEX_CMD=("$@")
}

# e2e_sandbox_exec <sandbox> -- <cmd> [args...]
e2e_sandbox_exec() {
  _e2e_sbex_parse "$@" || return $?
  e2e_env_trace "sandbox:exec" "${_E2E_SBEX_SB_NAME}" "${_E2E_SBEX_CMD[*]}"
  if e2e_env_is_dry_run; then
    echo "[dry-run] sandbox_exec ${_E2E_SBEX_SB_NAME} -- ${_E2E_SBEX_CMD[*]} (skipped)"
    return 0
  fi
  if ! command -v nemoclaw >/dev/null 2>&1; then
    echo "e2e_sandbox_exec: nemoclaw CLI not on PATH" >&2
    return 127
  fi
  nemoclaw shell "${_E2E_SBEX_SB_NAME}" -- "${_E2E_SBEX_CMD[@]}"
}

# e2e_sandbox_exec_stdin <sandbox> -- <cmd> [args...]
# Pipes the caller's stdin into the sandbox command. Safe for secrets:
# stdin bytes are handed to the child process without shell-level
# interpolation.
e2e_sandbox_exec_stdin() {
  _e2e_sbex_parse "$@" || return $?
  e2e_env_trace "sandbox:exec_stdin" "${_E2E_SBEX_SB_NAME}" "${_E2E_SBEX_CMD[*]}"
  if e2e_env_is_dry_run; then
    # Consume stdin so the caller's pipeline doesn't SIGPIPE.
    cat >/dev/null 2>&1 || true
    echo "[dry-run] sandbox_exec_stdin ${_E2E_SBEX_SB_NAME} -- ${_E2E_SBEX_CMD[*]} (skipped)"
    return 0
  fi
  if ! command -v nemoclaw >/dev/null 2>&1; then
    echo "e2e_sandbox_exec_stdin: nemoclaw CLI not on PATH" >&2
    return 127
  fi
  nemoclaw shell "${_E2E_SBEX_SB_NAME}" -- "${_E2E_SBEX_CMD[@]}"
}
