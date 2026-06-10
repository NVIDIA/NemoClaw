#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# State-validation probe dispatcher.
#
# Each probe is a small bash script in this directory invoked by the
# typed StateValidationOrchestrator via the shared dispatch-action.sh
# launcher. The orchestrator owns timeouts, redaction, evidence
# logging, and pass/fail attribution; probes only return 0 (probe
# satisfied) or non-zero with a human-readable message on stderr.
#
# Probes consult ${E2E_CONTEXT_DIR}/context.env for runtime values
# (E2E_GATEWAY_URL, E2E_SANDBOX_NAME) seeded by the framework and
# extended by onboarding.
#
# Library style: dispatch.sh defines a single dispatch function
# (e2e_state_probe) that runs the named probe. The TS phase-action
# uses fn=e2e_state_probe arg=<probe-id>.

_E2E_PROBES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# e2e_state_probe <probe-id>
e2e_state_probe() {
  local id="$1"
  if [[ -z "${id}" ]]; then
    echo "e2e_state_probe: missing probe id" >&2
    return 2
  fi
  local probe_script="${_E2E_PROBES_DIR}/${id}.sh"
  if [[ ! -f "${probe_script}" ]]; then
    echo "e2e_state_probe: unknown probe id '${id}' (no script at ${probe_script})" >&2
    return 2
  fi
  e2e_env_trace "probe:${id}"
  # Probes run in a subshell so a `set -e` failure inside one probe
  # does not affect another action in the same orchestrator process.
  (
    # shellcheck source=/dev/null
    . "${probe_script}"
  )
}
