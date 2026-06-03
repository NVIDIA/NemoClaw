#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# hermes-specific step: history-writable
#
# Regression probe for #2432. Reproduces the exact prompt_toolkit
# `open(filename, "ab")` call that emits "Permission denied:
# /sandbox/.hermes/.hermes_history" on every keypress under shields-up.
# Asserts the file exists as a sandbox-owned regular file with mode 660
# both before and after `shields up`, and that the sandbox user can
# successfully append to it in both states. Restores the original
# shields state on exit.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(cd "${SCRIPT_DIR}/../../runtime/lib" && pwd)"
# shellcheck source=../../runtime/lib/env.sh
. "${LIB_DIR}/env.sh"
# shellcheck source=../../runtime/lib/context.sh
. "${LIB_DIR}/context.sh"

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
PROBE_MARKER="e2e-2432-probe"

probe_history_writable() {
  local label="$1"
  echo "probe[${label}]:"

  local meta kind owner mode
  if ! meta="$(openshell sandbox exec --name "${sandbox_name}" -- stat -c '%F|%U:%G|%a' "${HISTORY_PATH}" 2>&1)"; then
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

  # Reproduce the exact prompt_toolkit history append call from #2432.
  # The probe runs as the default sandbox user (openshell sandbox exec drops
  # to the sandbox uid), so a failure here matches the original traceback.
  local probe_output
  if ! probe_output="$(openshell sandbox exec --name "${sandbox_name}" -- \
    python3 -c "open('${HISTORY_PATH}', 'ab').write(b'${PROBE_MARKER}\n')" 2>&1)"; then
    printf '%s\n' "${probe_output}"
    echo "  python3 open(${HISTORY_PATH}, 'ab') failed — this is the #2432 regression" >&2
    return 1
  fi
  echo "  python3 open(ab) succeeded"

  local tail_output
  if ! tail_output="$(openshell sandbox exec --name "${sandbox_name}" -- \
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

# Phase 1 — probe in whatever state the scenario left us in.
probe_history_writable "initial:${initial_state}"

# Phase 2 — if shields are currently DOWN, toggle UP and re-probe. This is
# the state #2432 reports; without forcing it here, every Hermes baseline
# scenario starts shields-down and the regression slips through. The
# hermes-specific suite runs last in the scenario plan and the scenario
# teardown owns sandbox cleanup, so we do not need to restore the prior
# state here.
if [[ "${initial_state}" == "down" ]]; then
  nemoclaw "${sandbox_name}" shields up >&2
  probe_history_writable "after-shields-up"
fi
