#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# hermes-specific step: history-writable
#
# Regression probe for the Hermes TUI history-write path. prompt_toolkit
# opens HERMES_HOME/.hermes_history in append mode on every keypress, and
# the upstream CLI hardcodes that path with no env override. The sandbox
# user can only succeed when the file exists as a sandbox-owned regular
# file before shields-up engages. The probe reproduces the exact
# open(filename, "ab") call against the running sandbox and asserts the
# write succeeds in both shields-down and shields-up states. The step
# leaves shields-up engaged on exit when it had to toggle, because the
# hermes-specific suite runs last in the scenario plan and the scenario
# teardown owns sandbox cleanup.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(cd "${SCRIPT_DIR}/../../runtime/lib" && pwd)"
# shellcheck source=../../runtime/lib/env.sh
. "${LIB_DIR}/env.sh"
# shellcheck source=../../runtime/lib/context.sh
. "${LIB_DIR}/context.sh"
# shellcheck source=../sandbox-exec.sh
. "${SCRIPT_DIR}/../sandbox-exec.sh"

echo "hermes-specific:history-writable"
e2e_context_require E2E_AGENT E2E_SANDBOX_NAME
if e2e_env_is_dry_run; then
  echo "[dry-run] would probe /sandbox/.hermes/.hermes_history writability under shields up/down"
  exit 0
fi

agent="$(e2e_context_get E2E_AGENT)"
if [[ "${agent}" != "hermes" ]]; then
  echo "hermes-specific: E2E_AGENT should be 'hermes', got '${agent}'" >&2
  exit 1
fi
sandbox_name="$(e2e_context_get E2E_SANDBOX_NAME)"

HISTORY_PATH="/sandbox/.hermes/.hermes_history"
PROBE_MARKER="hermes-history-probe-marker"

probe_history_writable() {
  local label="$1"
  echo "probe[${label}]:"

  local meta kind owner mode
  if ! meta="$(e2e_sandbox_exec "${sandbox_name}" -- stat -c '%F|%U:%G|%a' "${HISTORY_PATH}" 2>&1)"; then
    printf '%s\n' "${meta}"
    echo "  stat failed for ${HISTORY_PATH}" >&2
    return 1
  fi
  echo "  meta: ${meta}"
  IFS='|' read -r kind owner mode <<<"${meta}"
  if [[ "${kind}" != "regular file" ]]; then
    echo "  expected regular file, got '${kind}'" >&2
    return 1
  fi
  if [[ "${owner}" != "sandbox:sandbox" ]]; then
    echo "  expected sandbox:sandbox owner, got '${owner}'" >&2
    return 1
  fi
  if [[ "${mode}" != "660" ]]; then
    echo "  expected mode 660, got '${mode}'" >&2
    return 1
  fi

  # Reproduce the exact prompt_toolkit history append call from the bug
  # report. The probe runs as the default sandbox user (openshell sandbox
  # exec drops to the sandbox uid), so a failure here matches the original
  # traceback.
  local probe_output
  if ! probe_output="$(e2e_sandbox_exec "${sandbox_name}" -- \
    python3 -c "open('${HISTORY_PATH}', 'ab').write(b'${PROBE_MARKER}\n')" 2>&1)"; then
    printf '%s\n' "${probe_output}"
    echo "  python3 open(${HISTORY_PATH}, 'ab') failed — Hermes TUI keypress would error" >&2
    return 1
  fi
  echo "  python3 open(ab) succeeded"

  local tail_output
  if ! tail_output="$(e2e_sandbox_exec "${sandbox_name}" -- \
    tail -n 1 "${HISTORY_PATH}" 2>&1)"; then
    printf '%s\n' "${tail_output}"
    echo "  tail of ${HISTORY_PATH} failed" >&2
    return 1
  fi
  if [[ "${tail_output}" != "${PROBE_MARKER}" ]]; then
    echo "  expected last line '${PROBE_MARKER}', got '${tail_output}'" >&2
    return 1
  fi
}

shields_status_state() {
  local status
  status="$(nemoclaw "${sandbox_name}" shields status 2>&1 || true)"
  case "${status}" in
    *"Shields: UP"*) printf 'up\n' ;;
    *"Shields: DOWN"*) printf 'down\n' ;;
    *) printf 'unknown\n' ;;
  esac
}

initial_state="$(shields_status_state)"
echo "initial shields state: ${initial_state}"
if [[ "${initial_state}" == "unknown" ]]; then
  echo "could not determine shields state for sandbox '${sandbox_name}'; refusing to probe" >&2
  exit 1
fi

# Phase 1 — probe in whatever state the scenario left us in.
probe_history_writable "initial:${initial_state}"

# Phase 2 — when shields are DOWN, force them UP and re-probe. This is the
# state the original report covers; without forcing it, every Hermes
# baseline scenario starts shields-down and the regression slips through.
if [[ "${initial_state}" == "down" ]]; then
  nemoclaw "${sandbox_name}" shields up >&2
  forced_state="$(shields_status_state)"
  if [[ "${forced_state}" != "up" ]]; then
    echo "expected shields to be UP after toggle, got '${forced_state}'" >&2
    exit 1
  fi
  probe_history_writable "after-shields-up"
fi
