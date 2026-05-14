#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# E2E scenario runner entrypoint.
#
# Usage:
#   bash test/e2e/runtime/run-scenario.sh <scenario-id> [--plan-only|--validate-only|--dry-run]
#
# Flags:
#   --plan-only      Resolve metadata and print the plan only. Writes
#                    ${E2E_CONTEXT_DIR:-.e2e}/plan.json for artifact upload.
#   --validate-only  Run the expected-state validator against the current
#                    context.env without running install/onboard/suites.
#                    Emits probe results JSON to stdout and writes
#                    ${E2E_CONTEXT_DIR}/expected-state-report.json. Used by
#                    the parity-compare workflow to collect per-assertion
#                    probe results. Mutually exclusive with --plan-only.
#   --dry-run        (reserved) Run orchestration with real side effects
#                    replaced by trace-logged stubs. Sets E2E_DRY_RUN=1 for
#                    helpers. Full dry-run orchestration lands in later phases.
#
# Environment:
#   E2E_CONTEXT_DIR  Override the scenario artifact directory
#                    (default: <repo-root>/.e2e/).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E2E_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

SCENARIO_ID=""
PLAN_ONLY=0
VALIDATE_ONLY=0
DRY_RUN=0

usage() {
  cat >&2 <<'USAGE'
Usage: bash test/e2e/runtime/run-scenario.sh <scenario-id> [--plan-only|--validate-only|--dry-run]
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --plan-only)
      PLAN_ONLY=1
      shift
      ;;
    --validate-only)
      VALIDATE_ONLY=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    --*)
      echo "run-scenario: unknown flag: $1" >&2
      usage
      exit 2
      ;;
    *)
      if [[ -z "${SCENARIO_ID}" ]]; then
        SCENARIO_ID="$1"
      else
        echo "run-scenario: unexpected positional argument: $1" >&2
        usage
        exit 2
      fi
      shift
      ;;
  esac
done

if [[ -z "${SCENARIO_ID}" ]]; then
  echo "run-scenario: missing scenario id" >&2
  usage
  exit 2
fi

if [[ "${PLAN_ONLY}" -eq 1 && "${VALIDATE_ONLY}" -eq 1 ]]; then
  echo "run-scenario: --plan-only and --validate-only are mutually exclusive" >&2
  usage
  exit 2
fi

export E2E_CONTEXT_DIR="${E2E_CONTEXT_DIR:-${REPO_ROOT}/.e2e}"
mkdir -p "${E2E_CONTEXT_DIR}"

if [[ "${DRY_RUN}" -eq 1 ]]; then
  export E2E_DRY_RUN=1
fi

# Prefer the locally-installed tsx if present, otherwise fall back to npx.
TSX_BIN="${REPO_ROOT}/node_modules/.bin/tsx"
if [[ ! -x "${TSX_BIN}" ]]; then
  TSX_BIN=""
fi

run_resolver() {
  if [[ -n "${TSX_BIN}" ]]; then
    "${TSX_BIN}" "${SCRIPT_DIR}/resolver/index.ts" "$@"
    return
  fi
  # CodeRabbit review item #10: fail closed with a clear hint instead of
  # silently pulling tsx from the network via `npx --yes`.
  if ! (cd "${REPO_ROOT}" && npx --no-install tsx "${SCRIPT_DIR}/resolver/index.ts" "$@"); then
    echo "run-scenario: tsx is required but not installed. Run 'npm ci' at the repo root and retry." >&2
    return 1
  fi
}

run_resolver plan "${SCENARIO_ID}" --context-dir "${E2E_CONTEXT_DIR}"

if [[ "${PLAN_ONLY}" -eq 1 ]]; then
  exit 0
fi

# --validate-only: assume setup has already completed. Skip install /
# onboard / suite execution and dispatch the expected-state validator
# using probes resolved from E2E_PROBE_OVERRIDE_* env vars. Emits the
# probe results JSON report to stdout and writes it to
# ${E2E_CONTEXT_DIR}/expected-state-report.json.
if [[ "${VALIDATE_ONLY}" -eq 1 ]]; then
  validate_args=("${SCENARIO_ID}" --context-dir "${E2E_CONTEXT_DIR}")
  if ! run_resolver validate-state "${validate_args[@]}"; then
    echo "run-scenario: --validate-only: expected-state validation failed" >&2
    exit 3
  fi
  exit 0
fi

# Source the shared helper library so we can exercise the full
# setup → install → onboard → gateway/sandbox check sequence. In dry-run
# mode each helper short-circuits (and writes to E2E_TRACE_FILE if set).
# shellcheck source=lib/env.sh
. "${SCRIPT_DIR}/lib/env.sh"
# shellcheck source=lib/context.sh
. "${SCRIPT_DIR}/lib/context.sh"
# shellcheck source=../nemoclaw_scenarios/install/dispatch.sh
. "${E2E_ROOT}/nemoclaw_scenarios/install/dispatch.sh"
# shellcheck source=../nemoclaw_scenarios/onboard/dispatch.sh
. "${E2E_ROOT}/nemoclaw_scenarios/onboard/dispatch.sh"
# shellcheck source=../validation_suites/assert/gateway-alive.sh
. "${E2E_ROOT}/validation_suites/assert/gateway-alive.sh"
# shellcheck source=../validation_suites/assert/sandbox-alive.sh
. "${E2E_ROOT}/validation_suites/assert/sandbox-alive.sh"

# Apply standard non-interactive env (and trace it).
e2e_env_apply_noninteractive
e2e_env_trace "env:noninteractive"

# Emit normalized context from the resolved plan.
e2e_context_init
"${E2E_ROOT}/nemoclaw_scenarios/helpers/emit-context-from-plan.sh" "${E2E_CONTEXT_DIR}/plan.json"

# Extract the install method and onboarding profile from the plan so we can
# dispatch to the right helpers.
read_plan_string() {
  local key="$1"
  node -e "
    const p = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    const parts = process.argv[2].split('.');
    let cur = p;
    for (const part of parts) { if (cur == null) { cur = ''; break; } cur = cur[part]; }
    process.stdout.write(cur == null ? '' : String(cur));
  " "${E2E_CONTEXT_DIR}/plan.json" "${key}"
}

INSTALL_ID="$(read_plan_string dimensions.install.id)"
INSTALL_METHOD="$(read_plan_string dimensions.install.profile.method)"
ONBOARDING_ID="$(read_plan_string dimensions.onboarding.id)"

# Trace the dimension id so scenario-level assertions can identify the
# configured install (e.g. repo-current); e2e_install internally traces
# the resolved method.
e2e_env_trace "install:${INSTALL_ID}"
e2e_install "${INSTALL_METHOD}"
e2e_onboard "${ONBOARDING_ID}"
e2e_gateway_assert_healthy
e2e_sandbox_assert_running

# Expected state validation. The validator reads E2E_PROBE_OVERRIDE_* env
# variables to simulate real probe outputs in dry-run/test contexts.
# In non-dry-run mode the validator currently also relies on those
# overrides; wiring real probes through the validator happens as
# scenarios migrate.
if [[ "${E2E_VALIDATE_EXPECTED_STATE:-0}" == "1" || "${DRY_RUN}" -ne 1 ]]; then
  validate_args=("${SCENARIO_ID}" --context-dir "${E2E_CONTEXT_DIR}")
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    # CodeRabbit review item #9: explicitly opt in to seeding probes from
    # the expected state in dry-run/test mode. Live runs go through real
    # probes and must fail closed if any are missing.
    validate_args+=(--probes-from-state)
  fi
  if ! run_resolver validate-state "${validate_args[@]}"; then
    echo "run-scenario: expected-state validation failed; suites will NOT run" >&2
    exit 3
  fi
fi

if [[ "${DRY_RUN}" -eq 1 ]]; then
  echo "run-scenario: dry-run complete; context.env emitted under ${E2E_CONTEXT_DIR}"
  exit 0
fi

# CodeRabbit review item #11: do not exit 0 when no suites were executed.
# Full suite execution against a live environment lands in subsequent
# scenarios; calling run-scenario.sh in non-dry-run mode must not masquerade
# as success until that wiring exists for the requested scenario.
echo "run-scenario: full suite execution is not implemented yet for this scenario." >&2
echo "run-scenario: pass --dry-run to exercise the plan+context path, or run the suite runner directly with a live environment." >&2
exit 4
