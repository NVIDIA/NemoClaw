#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Emit a normalized .e2e/context.env from a resolved plan.json.
#
# Usage:
#   test/e2e/lib/emit-context-from-plan.sh <path-to-plan.json>
#
# The script reads the plan via `node --experimental-default-type=module` so
# it doesn't depend on jq being available on every runner. It then calls
# lib/context.sh helpers to append keys.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_E2E_EMIT_RUNTIME_LIB="$(cd "${SCRIPT_DIR}/../../runtime/lib" && pwd)"
# shellcheck source=../../runtime/lib/context.sh
. "${_E2E_EMIT_RUNTIME_LIB}/context.sh"

PLAN_JSON="${1:-}"
if [[ -z "${PLAN_JSON}" || ! -f "${PLAN_JSON}" ]]; then
  echo "emit-context-from-plan: plan.json not found: ${PLAN_JSON}" >&2
  exit 2
fi

# Extract fields with node (already required by the resolver).
read_plan_value() {
  local key="$1"
  node -e "
    const p = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    const parts = process.argv[2].split('.');
    let cur = p;
    for (const part of parts) {
      if (cur == null) { cur = ''; break; }
      cur = cur[part];
    }
    process.stdout.write(cur == null ? '' : String(cur));
  " "${PLAN_JSON}" "${key}"
}

SCENARIO_ID="$(read_plan_value scenario_id)"
if [[ -z "${SCENARIO_ID}" ]]; then
  # Fail fast when the plan is missing its scenario id (CodeRabbit review
  # item #5). Downstream helpers all index context by scenario and will
  # silently misbehave if this is empty.
  echo "emit-context-from-plan: plan.json is missing 'scenario_id': ${PLAN_JSON}" >&2
  exit 2
fi
PLATFORM_OS="$(read_plan_value dimensions.platform.profile.os)"
EXECUTION_TARGET="$(read_plan_value dimensions.platform.profile.execution_target)"
INSTALL_METHOD="$(read_plan_value dimensions.install.profile.method)"
RUNTIME_ENGINE="$(read_plan_value dimensions.runtime.profile.container_engine)"
RUNTIME_DAEMON="$(read_plan_value dimensions.runtime.profile.container_daemon)"
ONBOARDING_PATH="$(read_plan_value dimensions.onboarding.profile.path)"
AGENT="$(read_plan_value dimensions.onboarding.profile.agent)"
PROVIDER="$(read_plan_value dimensions.onboarding.profile.provider)"
INFERENCE_ROUTE="$(read_plan_value dimensions.onboarding.profile.inference_route)"

: "${PLATFORM_OS:=unknown}"
: "${EXECUTION_TARGET:=local}"
: "${INSTALL_METHOD:=unknown}"
: "${RUNTIME_ENGINE:=docker}"
: "${RUNTIME_DAEMON:=unknown}"
: "${ONBOARDING_PATH:=unknown}"
: "${AGENT:=unknown}"
: "${PROVIDER:=unknown}"
: "${INFERENCE_ROUTE:=inference-local}"

e2e_context_set E2E_SCENARIO "${SCENARIO_ID}"
e2e_context_set E2E_PLATFORM_OS "${PLATFORM_OS}"
e2e_context_set E2E_EXECUTION_TARGET "${EXECUTION_TARGET}"
e2e_context_set E2E_INSTALL_METHOD "${INSTALL_METHOD}"
e2e_context_set E2E_CONTAINER_ENGINE "${RUNTIME_ENGINE}"
e2e_context_set E2E_CONTAINER_DAEMON "${RUNTIME_DAEMON}"
e2e_context_set E2E_ONBOARDING_PATH "${ONBOARDING_PATH}"
e2e_context_set E2E_AGENT "${AGENT}"
e2e_context_set E2E_PROVIDER "${PROVIDER}"
e2e_context_set E2E_INFERENCE_ROUTE "${INFERENCE_ROUTE}"

# Sandbox name and gateway URL are normally discovered/assigned by
# onboarding. Seed them here so dry-run consumers can exercise the suite
# plumbing without live onboarding. Real onboarding helpers will overwrite
# these via e2e_context_set in later phases.
e2e_context_set E2E_SANDBOX_NAME "e2e-${SCENARIO_ID}"
e2e_context_set E2E_GATEWAY_URL "http://127.0.0.1:18789"
