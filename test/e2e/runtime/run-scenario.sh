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
# shellcheck source=lib/negative.sh
. "${SCRIPT_DIR}/lib/negative.sh"
# shellcheck source=lib/port-holder.sh
. "${SCRIPT_DIR}/lib/port-holder.sh"
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
RUNTIME_ID="$(read_plan_string dimensions.runtime.id)"
RUNTIME_CONTAINER_DAEMON="$(read_plan_string dimensions.runtime.profile.container_daemon)"
EXPECTED_STATE_ID="$(read_plan_string expected_state.id)"
FAILURE_STAGE="$(read_plan_string expected_state.config.failure.stage)"
FAILURE_EXIT_CODE="$(read_plan_string expected_state.config.failure.exit_code)"
FAILURE_MESSAGE_CONTAINS="$(read_plan_string expected_state.config.failure.message_contains)"
FAILURE_NO_STACK_TRACE="$(read_plan_string expected_state.config.failure.no_stack_trace)"

# Trace the dimension id so scenario-level assertions can identify the
# configured install (e.g. repo-current); e2e_install internally traces
# the resolved method.
e2e_env_trace "install:${INSTALL_ID}"

install_log="${E2E_CONTEXT_DIR}/install.log"
set +e
e2e_install "${INSTALL_METHOD}" >"${install_log}" 2>&1
install_status=$?
set -e
if [[ "${install_status}" -ne 0 ]]; then
  cat "${install_log}" >&2
  echo "run-scenario: install ${INSTALL_METHOD} failed with status ${install_status}" >&2
  exit "${install_status}"
fi
export PATH="${HOME}/.local/bin:${PATH}"
{
  printf 'PATH=%s\n' "${PATH}"
  command -v nemoclaw || true
} >"${E2E_CONTEXT_DIR}/post-install-path.log" 2>&1
if [[ "${DRY_RUN}" -eq 1 ]]; then
  printf 'run-scenario: dry-run skipping post-install nemoclaw PATH verification\n' >&2
else
  nemoclaw_bin="$(command -v nemoclaw || true)"
  if [[ -z "${nemoclaw_bin}" ]]; then
    cat "${E2E_CONTEXT_DIR}/post-install-path.log" >&2
    echo "run-scenario: nemoclaw not found on PATH after install" >&2
    exit 127
  fi
  printf 'run-scenario: using nemoclaw at %s\n' "${nemoclaw_bin}" >&2
fi

# Negative scenarios declare an `expected_failure` block on their expected
# state (see NemoClaw issue #3608). The runner forces the failure mode for
# the scenario, captures the setup log, gathers a side-effect inventory, and
# delegates structured matching to `resolver/index.ts match-failure`. The
# matcher writes `expected-vs-actual.json` for CI artifact upload.

read_plan_failure_field() {
  local key="$1"
  node -e "
    (() => {
      const p = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
      const ef = p.expected_failure;
      if (!ef) { process.stdout.write(''); return; }
      const v = ef[process.argv[2]];
      process.stdout.write(v == null ? '' : Array.isArray(v) ? v.join(',') : String(v));
    })();
  " "${E2E_CONTEXT_DIR}/plan.json" "${key}"
}

EXPECTED_FAILURE_PHASE="$(read_plan_failure_field phase)"

if [[ -n "${EXPECTED_FAILURE_PHASE}" ]]; then
  expected_error_class="$(read_plan_failure_field error_class)"
  negative_log="${E2E_CONTEXT_DIR}/negative-${EXPECTED_FAILURE_PHASE}.log"
  sandbox_name="$(e2e_context_get E2E_SANDBOX_NAME)"

  # Snapshot the side-effect baseline BEFORE forcing the failure so we only
  # report effects newly introduced by this scenario. A pre-existing gateway
  # or credentials file from an earlier run would otherwise look like a fresh
  # side effect and falsely fail negative scenarios in dirty environments.
  baseline_sandbox=0
  if [[ -n "${sandbox_name}" ]] && openshell sandbox list 2>/dev/null | grep -Fq "${sandbox_name}"; then
    baseline_sandbox=1
  fi
  baseline_gateway=0
  if nemoclaw gateway status >/dev/null 2>&1; then
    baseline_gateway=1
  fi
  baseline_credentials=0
  if [[ -s "${HOME}/.nemoclaw/credentials.json" ]]; then
    baseline_credentials=1
  fi

  # Force the failure mode declared by the scenario. Only `preflight` /
  # `docker-missing` is implemented here; other phases are accepted by the
  # schema but their forcing logic lands alongside the first consumer.
  case "${EXPECTED_FAILURE_PHASE}:${expected_error_class}" in
    preflight:docker-missing)
      if [[ "${DRY_RUN}" -eq 1 ]]; then
        printf 'Cannot connect to the Docker daemon during preflight\n' >"${negative_log}"
      else
        if DOCKER_HOST="unix:///tmp/nemoclaw-e2e-missing-docker.sock" \
          e2e_onboard "${ONBOARDING_ID}" >"${negative_log}" 2>&1; then
          echo "run-scenario: expected preflight failure, but onboarding succeeded" >&2
          cat "${negative_log}" >&2
          exit 4
        fi
      fi
      ;;
    *)
      echo "run-scenario: expected_failure phase=${EXPECTED_FAILURE_PHASE} class=${expected_error_class} has no forcing implementation yet" >&2
      exit 2
      ;;
  esac

  # Compute the side-effect delta: only count effects that were absent in the
  # baseline and present after the forced failure.
  observed_side_effects=""
  if [[ "${baseline_sandbox}" -eq 0 ]] && [[ -n "${sandbox_name}" ]] \
    && openshell sandbox list 2>/dev/null | grep -Fq "${sandbox_name}"; then
    observed_side_effects="${observed_side_effects:+${observed_side_effects},}sandbox-created"
  fi
  if [[ "${baseline_gateway}" -eq 0 ]] && nemoclaw gateway status >/dev/null 2>&1; then
    observed_side_effects="${observed_side_effects:+${observed_side_effects},}gateway-started"
  fi
  if [[ "${baseline_credentials}" -eq 0 ]] && [[ -s "${HOME}/.nemoclaw/credentials.json" ]]; then
    observed_side_effects="${observed_side_effects:+${observed_side_effects},}credentials-written"
  fi

  # `--observed-error-class` is intentionally omitted: the runner does not yet
  # derive a structured error class from the actual failure output, and
  # reporting the planned class back to the matcher would make the check
  # tautological. The matcher logs this as a skipped check.
  match_args=(
    match-failure "${SCENARIO_ID}"
    --context-dir "${E2E_CONTEXT_DIR}"
    --log "${negative_log}"
    --observed-phase "${EXPECTED_FAILURE_PHASE}"
  )
  if [[ -n "${observed_side_effects}" ]]; then
    match_args+=(--observed-side-effects "${observed_side_effects}")
  fi
  if ! run_resolver "${match_args[@]}"; then
    echo "run-scenario: expected-failure match failed; see ${E2E_CONTEXT_DIR}/expected-vs-actual.json" >&2
    exit 4
  fi
  echo "run-scenario: negative scenario passed (phase=${EXPECTED_FAILURE_PHASE} class=${expected_error_class})"
  exit 0
fi

if [[ "${EXPECTED_STATE_ID}" == "preflight-failure-no-sandbox" ]]; then
  negative_log="${E2E_CONTEXT_DIR}/negative-preflight.log"
  sandbox_name="$(e2e_context_get E2E_SANDBOX_NAME)"
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    printf 'Cannot connect to the Docker daemon during preflight\n' >"${negative_log}"
  elif DOCKER_HOST="unix:///tmp/nemoclaw-e2e-missing-docker.sock" e2e_onboard "${ONBOARDING_ID}" >"${negative_log}" 2>&1; then
    echo "run-scenario: expected preflight failure, but onboarding succeeded" >&2
    exit 4
  fi
  if ! grep -Eiq "docker|container|daemon|socket|preflight" "${negative_log}"; then
    echo "run-scenario: negative preflight failed without a clear Docker/preflight reason" >&2
    cat "${negative_log}" >&2
    exit 4
  fi
  if openshell sandbox list 2>/dev/null | grep -Fq "${sandbox_name}"; then
    echo "run-scenario: negative preflight left behind sandbox ${sandbox_name}" >&2
    exit 4
  fi
  echo "run-scenario: negative preflight passed; Docker daemon unavailable and no sandbox was created"
  exit 0
fi

if [[ "${FAILURE_STAGE}" == "onboarding" ]]; then
  negative_log="${E2E_CONTEXT_DIR}/negative-onboarding.log"
  sandbox_name="$(e2e_context_get E2E_SANDBOX_NAME)"
  port_holder_started=0
  onboard_env=(NEMOCLAW_SANDBOX_NAME="${sandbox_name}" NEMOCLAW_RECREATE_SANDBOX=1 NEMOCLAW_POLICY_MODE=skip)
  case "${ONBOARDING_ID}" in
    cloud-openclaw-invalid-nvidia-key)
      onboard_env+=(NVIDIA_API_KEY=not-a-nvidia-key)
      ;;
    cloud-openclaw-gateway-port-conflict)
      conflict_port="$(read_plan_string dimensions.onboarding.profile.gateway_port)"
      : "${conflict_port:=18080}"
      if e2e_port_holder_start "${conflict_port}"; then
        port_holder_started=1
      else
        echo "run-scenario: could not start port holder on ${conflict_port}; continuing against any existing listener" >&2
      fi
      onboard_env+=(NEMOCLAW_GATEWAY_PORT="${conflict_port}")
      ;;
  esac
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    printf '%s
' "${FAILURE_MESSAGE_CONTAINS}" >"${negative_log}"
    negative_status="${FAILURE_EXIT_CODE:-1}"
  else
    set +e
    (
      export "${onboard_env[@]}"
      e2e_onboard "${ONBOARDING_ID}"
    ) >"${negative_log}" 2>&1
    negative_status=$?
    set -e
  fi
  if [[ "${port_holder_started}" -eq 1 ]]; then
    e2e_port_holder_stop
  fi
  if ! e2e_negative_assert_failure "${negative_log}" "${negative_status}" "${FAILURE_EXIT_CODE:-1}" "${FAILURE_MESSAGE_CONTAINS}" "$([[ "${FAILURE_NO_STACK_TRACE}" == "true" ]] && echo 1 || echo 0)"; then
    exit 4
  fi
  if openshell sandbox list 2>/dev/null | grep -Fq "${sandbox_name}"; then
    echo "run-scenario: negative onboarding left behind sandbox ${sandbox_name}" >&2
    exit 4
  fi
  echo "run-scenario: negative onboarding ${ONBOARDING_ID} passed"
  exit 0
fi

DOCKER_OPTIONAL_UNAVAILABLE=0
if [[ "${RUNTIME_CONTAINER_DAEMON}" == "optional" ]] && ! docker info >/dev/null 2>&1; then
  DOCKER_OPTIONAL_UNAVAILABLE=1
  echo "SKIP: scenario.${SCENARIO_ID}.docker-dependent-suites Docker unavailable for optional runtime ${RUNTIME_ID}; gateway/sandbox/inference coverage skipped"
  echo "run-scenario: Docker unavailable for optional runtime ${RUNTIME_ID}; scaling back to platform-only suites"
else
  onboard_log="${E2E_CONTEXT_DIR}/onboard.log"
  set +e
  e2e_onboard "${ONBOARDING_ID}" >"${onboard_log}" 2>&1
  onboard_status=$?
  set -e
  if [[ "${onboard_status}" -ne 0 ]]; then
    cat "${onboard_log}" >&2
    echo "run-scenario: onboarding ${ONBOARDING_ID} failed with status ${onboard_status}" >&2
    exit "${onboard_status}"
  fi
  if [[ "${RUNTIME_ID}" == "gpu-docker-cdi" ]] && ! e2e_env_is_dry_run; then
    echo "run-scenario: GPU Docker CDI uses host-network gateway; validating gateway from suites"
  else
    e2e_gateway_assert_healthy
  fi
  e2e_sandbox_assert_running
fi

# Expected state validation. The validator reads E2E_PROBE_OVERRIDE_* env
# variables to simulate real probe outputs in dry-run/test contexts.
# Live probe wiring lands scenario-by-scenario; by default, live runs move
# straight from setup checks to suites so migrated suite assertions can be
# debugged against the real environment.
if [[ "${E2E_VALIDATE_EXPECTED_STATE:-0}" == "1" || "${DRY_RUN}" -eq 1 ]]; then
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

SUITE_IDS=()
while IFS= read -r suite_id; do
  SUITE_IDS+=("${suite_id}")
done < <(node -e "
  try {
    const planPath = process.argv[1];
    const p = JSON.parse(require('fs').readFileSync(planPath, 'utf8'));
    if (!Array.isArray(p.suites)) {
      throw new Error('missing or invalid suites array');
    }
    const filter = process.env.E2E_SUITE_FILTER || '';
    const selected = filter ? filter.split(',').map((s) => s.trim()).filter(Boolean) : p.suites.map((s) => s.id);
    for (const id of selected) console.log(id);
  } catch (err) {
    console.error('run-scenario: failed to parse plan.json ' + process.argv[1] + ': ' + err.message);
    process.exit(1);
  }
" "${E2E_CONTEXT_DIR}/plan.json")

if [[ "${#SUITE_IDS[@]}" -eq 0 ]]; then
  echo "run-scenario: no suites selected for ${SCENARIO_ID}" >&2
  exit 4
fi

if [[ "${DOCKER_OPTIONAL_UNAVAILABLE}" -eq 1 ]]; then
  FILTERED_SUITE_IDS=()
  for suite_id in "${SUITE_IDS[@]}"; do
    case "${suite_id}" in
      smoke | inference | credentials | hermes-specific | local-ollama-inference | ollama-proxy | gateway-health | sandbox-shell | cloud-inference | ollama-auth-proxy | security-credentials | messaging-telegram | messaging-discord | messaging-slack | security-shields | inference-routing | sandbox-lifecycle | sandbox-operations | snapshot | rebuild | upgrade | diagnostics | docs-validation | openai-compatible-inference | inference-switch | kimi-compatibility | messaging-token-rotation | security-policy | security-injection)
        echo "SKIP: suite.${suite_id} skipped because optional Docker runtime ${RUNTIME_ID} is unavailable"
        ;;
      *)
        FILTERED_SUITE_IDS+=("${suite_id}")
        ;;
    esac
  done
  SUITE_IDS=("${FILTERED_SUITE_IDS[@]}")
fi

if [[ "${#SUITE_IDS[@]}" -eq 0 ]]; then
  echo "run-scenario: all suites skipped for ${SCENARIO_ID}" >&2
  exit 0
fi

bash "${SCRIPT_DIR}/run-suites.sh" "${SUITE_IDS[@]}"
