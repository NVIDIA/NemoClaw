#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Canonical `openshell sandbox exec --name <sandbox> -- <cmd>` wrapper.
#
# Absorbs reuse category #10 from the migration spec: 15 legacy scripts
# each reimplement sandbox-scoped exec with subtle drift (quoting, exit-
# code propagation, dry-run handling). This helper provides a single
# contract shared by every migrated suite step.
#
# Functions:
#   e2e_sandbox_exec       <sandbox> -- <cmd> [args...]
#       Run <cmd> inside <sandbox> via `openshell sandbox exec`. No stdin passed.
#
#   e2e_sandbox_exec_stdin <sandbox> -- <cmd> [args...]
#       Like e2e_sandbox_exec but pipes the caller's stdin into the
#       sandbox command. Safe for secrets: no host-side expansion is
#       performed on stdin content.

_E2E_SBEX_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../runtime/lib" && pwd)"
# shellcheck source=../runtime/lib/env.sh
. "${_E2E_SBEX_LIB_DIR}/env.sh"

# Per-call timeout (seconds) applied to every `openshell sandbox exec`
# invocation routed through this wrapper. Callers MAY override per call:
#   E2E_SANDBOX_EXEC_TIMEOUT_SECONDS=50 e2e_sandbox_exec ...
#
# Why a wrapper-level cap exists:
#   The orchestrator (phase.ts) enforces step-level timeouts via SIGTERM on
#   the script's process group. When openshell ssh-into-sandbox hangs,
#   SIGTERM eventually kills the script — but the script has no chance to
#   emit a structured diagnostic, so logs end mid-line. An inner per-call
#   `timeout` lets the wrapper observe the hang, emit a classified
#   diagnostic, and exit cleanly *before* the orchestrator's SIGTERM.
#
# The default (25s) sits below the most common orchestrator step caps
# (30s smoke / kimi, 45s sandbox-local). Steps with longer caps (60s
# chat-completion, 120s rebuild) export a larger value before calling.
: "${E2E_SANDBOX_EXEC_TIMEOUT_SECONDS:=25}"

# Resolve the timeout binary once. Empty string == not available.
_e2e_sbex_resolve_timeout_cmd() {
  if command -v timeout >/dev/null 2>&1; then
    printf '%s' timeout
  elif command -v gtimeout >/dev/null 2>&1; then
    printf '%s' gtimeout
  else
    printf '%s' ''
  fi
}

# ----------------------------------------------------------------------
# ssh-config transport (preferred)
#
# `openshell sandbox exec` has been observed to wedge in CI (PR #4380
# scenario run — host can curl the gateway but `openshell sandbox exec`
# never returns). The legacy test/e2e/ scripts have always entered the
# sandbox via `openshell sandbox ssh-config` + `ssh -F`, which works in
# the same environments. We mirror that pattern here:
#
#   1. On first call per sandbox, materialize an ssh-config under
#      ${E2E_CONTEXT_DIR}/.ssh-config-cache/<sandbox>.cfg.
#   2. Subsequent calls reuse the cached config.
#   3. Each ssh invocation gets `-o ConnectTimeout=10`,
#      `-o StrictHostKeyChecking=no`, `-o UserKnownHostsFile=/dev/null`,
#      `-o LogLevel=ERROR` to mirror the legacy pattern.
#
# Opt-out: set E2E_SANDBOX_EXEC_VIA_OPENSHELL=1 to force the original
# `openshell sandbox exec` transport (e.g. for debugging or for runners
# where ssh-config is unavailable).
# ----------------------------------------------------------------------

_e2e_sbex_ssh_cfg_dir() {
  local base="${E2E_CONTEXT_DIR:-/tmp}"
  printf '%s/.ssh-config-cache' "${base}"
}

# _e2e_sbex_ssh_config_for <sandbox>
# Prints the path to a populated ssh-config for <sandbox> on stdout.
# Returns non-zero (and prints nothing) if `openshell sandbox ssh-config`
# fails — callers fall back to `openshell sandbox exec`.
_e2e_sbex_ssh_config_for() {
  local sandbox="$1"
  local dir cfg
  dir="$(_e2e_sbex_ssh_cfg_dir)"
  mkdir -p "${dir}" || return 1
  cfg="${dir}/${sandbox}.cfg"
  if [[ ! -s "${cfg}" ]]; then
    if ! openshell sandbox ssh-config "${sandbox}" >"${cfg}" 2>/dev/null; then
      rm -f "${cfg}"
      return 1
    fi
  fi
  printf '%s' "${cfg}"
}

# _e2e_sbex_quote_args <args...>
# Outputs the args quoted into a single shell string suitable for
# embedding as the remote command in `ssh host 'cmd args ...'`.
_e2e_sbex_quote_args() {
  local arg out=""
  for arg in "$@"; do
    out+="$(printf '%q' "${arg}") "
  done
  printf '%s' "${out% }"
}

# _e2e_sbex_invoke_via_ssh <cfg> <stdin_mode> <seconds> <timeout_cmd>
# stdin_mode is 'pipe' (forward caller stdin) or 'none' (close stdin).
# Returns ssh's exit code (124 if timed out, 137 if SIGKILLed).
_e2e_sbex_invoke_via_ssh() {
  local cfg="$1" stdin_mode="$2" seconds="$3" timeout_cmd="$4"
  local remote_cmd ssh_args
  remote_cmd="$(_e2e_sbex_quote_args "${_E2E_SBEX_CMD[@]}")"
  ssh_args=(
    -F "${cfg}"
    -o ConnectTimeout=10
    -o StrictHostKeyChecking=no
    -o UserKnownHostsFile=/dev/null
    -o LogLevel=ERROR
    "openshell-${_E2E_SBEX_SB_NAME}"
    "${remote_cmd}"
  )
  if [[ "${stdin_mode}" == "none" ]]; then
    if [[ -z "${timeout_cmd}" ]]; then
      ssh "${ssh_args[@]}" </dev/null
    else
      "${timeout_cmd}" --kill-after=5s "${seconds}" ssh "${ssh_args[@]}" </dev/null
    fi
  else
    if [[ -z "${timeout_cmd}" ]]; then
      ssh "${ssh_args[@]}"
    else
      "${timeout_cmd}" --kill-after=5s "${seconds}" ssh "${ssh_args[@]}"
    fi
  fi
}

# _e2e_sbex_invoke_via_openshell <stdin_mode> <seconds> <timeout_cmd>
# Fallback path that uses `openshell sandbox exec`.
_e2e_sbex_invoke_via_openshell() {
  local stdin_mode="$1" seconds="$2" timeout_cmd="$3"
  if [[ -z "${timeout_cmd}" ]]; then
    openshell sandbox exec --name "${_E2E_SBEX_SB_NAME}" -- "${_E2E_SBEX_CMD[@]}"
  else
    "${timeout_cmd}" --kill-after=5s "${seconds}" \
      openshell sandbox exec --name "${_E2E_SBEX_SB_NAME}" -- "${_E2E_SBEX_CMD[@]}"
  fi
}

# _e2e_sbex_dispatch <stdin_mode>
# Shared body for e2e_sandbox_exec / e2e_sandbox_exec_stdin. Picks the
# transport (ssh-config preferred; openshell sandbox exec on opt-out or
# ssh-config failure), applies the per-call timeout, and emits a
# classified diagnostic on hang.
_e2e_sbex_dispatch() {
  local stdin_mode="$1"
  if ! command -v openshell >/dev/null 2>&1; then
    echo "e2e_sandbox_exec: openshell CLI not on PATH" >&2
    return 127
  fi
  local timeout_cmd seconds="${E2E_SANDBOX_EXEC_TIMEOUT_SECONDS}"
  timeout_cmd="$(_e2e_sbex_resolve_timeout_cmd)"
  if [[ -z "${timeout_cmd}" ]]; then
    # Make the missing safety net visible so CI can flag it; do not
    # abort — the orchestrator's step-level timeout still applies.
    echo "e2e_sandbox_exec: 'timeout' not available; running without per-call cap (sandbox=${_E2E_SBEX_SB_NAME})" >&2
  fi

  local cfg="" via="ssh" rc=0
  if [[ "${E2E_SANDBOX_EXEC_VIA_OPENSHELL:-0}" == "1" ]]; then
    via="openshell"
  elif ! cfg="$(_e2e_sbex_ssh_config_for "${_E2E_SBEX_SB_NAME}")"; then
    echo "e2e_sandbox_exec: ssh-config unavailable for ${_E2E_SBEX_SB_NAME}; falling back to 'openshell sandbox exec'" >&2
    via="openshell"
  fi

  if [[ "${via}" == "ssh" ]]; then
    _e2e_sbex_invoke_via_ssh "${cfg}" "${stdin_mode}" "${seconds}" "${timeout_cmd}"
    rc=$?
  else
    _e2e_sbex_invoke_via_openshell "${stdin_mode}" "${seconds}" "${timeout_cmd}"
    rc=$?
  fi

  if [[ "${rc}" -eq 124 || "${rc}" -eq 137 ]]; then
    echo "e2e_sandbox_exec: ${via} transport hung after ${seconds}s (sandbox=${_E2E_SBEX_SB_NAME}, cmd=${_E2E_SBEX_CMD[0]:-?}; classifier=gateway-transient)" >&2
  fi
  return "${rc}"
}

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
  _e2e_sbex_dispatch none
}

# e2e_sandbox_exec_stdin <sandbox> -- <cmd> [args...]
# Pipes the caller's stdin into the sandbox command. Safe for secrets:
# stdin bytes are handed to the child process without shell-level
# interpolation.
e2e_sandbox_exec_stdin() {
  _e2e_sbex_parse "$@" || return $?
  e2e_env_trace "sandbox:exec_stdin" "${_E2E_SBEX_SB_NAME}" "${_E2E_SBEX_CMD[*]}"
  _e2e_sbex_dispatch pipe
}
