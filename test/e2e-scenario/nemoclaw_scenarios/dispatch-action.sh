#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Phase-action launcher for the hybrid scenario E2E framework.
#
# The phase orchestrators (EnvironmentOrchestrator, OnboardingOrchestrator)
# call this launcher to invoke a function defined in a sourced shell
# dispatcher (install/dispatch.sh or onboard/dispatch.sh). Those
# dispatchers are intentionally library-style (function definitions
# only); this script gives them a deterministic executable entrypoint
# the typed runner can spawn.
#
# Usage:
#   dispatch-action.sh <fn> <arg> <dispatcher-script>
#
# Examples:
#   dispatch-action.sh e2e_install repo-current \
#     test/e2e-scenario/nemoclaw_scenarios/install/dispatch.sh
#
#   dispatch-action.sh e2e_onboard cloud-openclaw \
#     test/e2e-scenario/nemoclaw_scenarios/onboard/dispatch.sh
#
# Environment (set by the orchestrator):
#   E2E_CONTEXT_DIR  artifact directory
#   E2E_PHASE        environment | onboarding
#   E2E_ACTION_ID    stable action id, used for trace/log correlation

set -euo pipefail

if [[ $# -lt 3 ]]; then
  echo "dispatch-action.sh: usage: <fn> <arg> <dispatcher-script>" >&2
  exit 2
fi

ACTION_FN="$1"
ACTION_ARG="$2"
DISPATCHER="$3"

if [[ ! -f "${DISPATCHER}" ]]; then
  echo "dispatch-action.sh: dispatcher script not found: ${DISPATCHER}" >&2
  exit 2
fi

# Source the runtime/lib helpers the dispatchers (and their workers) rely on.
RUNTIME_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../runtime/lib" && pwd)"
# shellcheck source=runtime/lib/env.sh
. "${RUNTIME_LIB}/env.sh"
# shellcheck source=runtime/lib/context.sh
. "${RUNTIME_LIB}/context.sh"

# Apply the standard non-interactive env once, on the very first action of
# the run. Subsequent actions in the same run see the env via process
# inheritance. e2e_env_apply_noninteractive is idempotent.
e2e_env_apply_noninteractive
e2e_env_trace "phase:${E2E_PHASE:-unknown}/action:${E2E_ACTION_ID:-unknown}"

# IMPORTANT: do NOT call e2e_context_init here. The TS framework
# (ScenarioRunner.seedContextEnv) is the single owner of context.env
# initialization for the run; e2e_context_init opens with `: > ctx`
# which would truncate the file and wipe seeded keys (E2E_SCENARIO,
# E2E_GATEWAY_URL, ...) that runtime assertions require.
# Workers may still call e2e_context_set to extend context.env in place.

# Source the dispatcher last so its function definitions are in scope
# when we invoke the requested function.
# shellcheck source=/dev/null
. "${DISPATCHER}"

if ! declare -F "${ACTION_FN}" >/dev/null 2>&1; then
  echo "dispatch-action.sh: function not found in dispatcher: ${ACTION_FN}" >&2
  exit 2
fi

"${ACTION_FN}" "${ACTION_ARG}"
