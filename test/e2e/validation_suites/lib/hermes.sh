#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Hermes-specific validation primitives for scenario-suite steps.
#
# Suites consume the normalized $E2E_CONTEXT_DIR/context.env emitted by
# run-scenario.sh. This library intentionally does not install, onboard, or
# rediscover setup state.

if [[ -n "${_E2E_HERMES_SH_LOADED:-}" ]]; then
  return 0 2>/dev/null || true
fi
_E2E_HERMES_SH_LOADED=1

_E2E_HERMES_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_E2E_HERMES_RUNTIME_LIB_DIR="$(cd "${_E2E_HERMES_LIB_DIR}/../../runtime/lib" && pwd)"
_E2E_HERMES_VALIDATION_DIR="$(cd "${_E2E_HERMES_LIB_DIR}/.." && pwd)"
# shellcheck source=../../runtime/lib/env.sh
. "${_E2E_HERMES_RUNTIME_LIB_DIR}/env.sh"
# shellcheck source=../../runtime/lib/context.sh
. "${_E2E_HERMES_RUNTIME_LIB_DIR}/context.sh"
# shellcheck source=../../runtime/lib/logging.sh
. "${_E2E_HERMES_RUNTIME_LIB_DIR}/logging.sh"
# shellcheck source=../sandbox-exec.sh
. "${_E2E_HERMES_VALIDATION_DIR}/sandbox-exec.sh"

_e2e_hermes_redact() {
  sed -E 's/([A-Za-z_]*(TOKEN|SECRET|PASSWORD|API_KEY|APIKEY|CREDENTIAL|PRIVATE)[A-Za-z_]*=)[^[:space:]]+/\1REDACTED/g; s/(Bearer )[A-Za-z0-9._~+\/-]+/\1REDACTED/g; s/(xox[baprs]-)[A-Za-z0-9-]+/\1REDACTED/g; s/(sk-)[A-Za-z0-9_-]{8,}/\1REDACTED/g; s/(nvapi-)[A-Za-z0-9_-]{8,}/\1REDACTED/g'
}

e2e_hermes_load_context() {
  local ctx
  ctx="$(e2e_context_path)"
  if [[ ! -f "${ctx}" ]]; then
    printf 'hermes context: missing context.env at %s (set E2E_CONTEXT_DIR)\n' "${ctx}" >&2
    return 1
  fi
  # shellcheck disable=SC1090
  . "${ctx}"
}

_e2e_hermes_require_agent() {
  e2e_hermes_load_context || return 1
  e2e_context_require E2E_AGENT E2E_SANDBOX_NAME || return 1
  local agent
  agent="$(e2e_context_get E2E_AGENT)"
  if [[ "${agent}" != "hermes" ]]; then
    printf "hermes context: E2E_AGENT should be 'hermes', got '%s'\n" "${agent}" >&2
    return 1
  fi
}

_e2e_hermes_assertion() {
  local assertion_id="${1:-}"
  if [[ -z "${assertion_id}" ]]; then
    echo "e2e_hermes: missing assertion id" >&2
    return 2
  fi
  e2e_section "${assertion_id}"
}

_e2e_hermes_plan() {
  local assertion_id="${1:-}"
  local detail="${2:-planned Hermes validation}"
  e2e_env_trace "hermes:plan" "${assertion_id} ${detail}"
  printf '[dry-run] %s: %s\n' "${assertion_id}" "${detail}"
  if [[ -f "$(e2e_context_path)" ]]; then
    e2e_context_dump | _e2e_hermes_redact
  fi
}

_e2e_hermes_run_override() {
  local override_var="${1:-}"
  shift || true
  if [[ -n "${override_var}" && -n "${!override_var:-}" ]]; then
    bash -c "${!override_var}" -- "$@" 2>&1 | _e2e_hermes_redact
    return "${PIPESTATUS[0]}"
  fi
  "$@" 2>&1 | _e2e_hermes_redact
  return "${PIPESTATUS[0]}"
}

_e2e_hermes_sandbox_name() {
  e2e_context_get E2E_SANDBOX_NAME
}

e2e_hermes_assert_gateway_health() {
  local assertion_id="${1:-expected.hermes.runtime.gateway-health}"
  _e2e_hermes_assertion "${assertion_id}" || return $?
  _e2e_hermes_require_agent || return 1
  e2e_context_require E2E_GATEWAY_URL || return 1
  if e2e_env_is_dry_run; then
    _e2e_hermes_plan "${assertion_id}" "verify Hermes gateway health from emitted scenario context"
    return 0
  fi
  local gateway
  gateway="$(e2e_context_get E2E_GATEWAY_URL)"
  if ! _e2e_hermes_run_override HERMES_GATEWAY_HEALTH_CMD curl --silent --show-error --fail --max-time 20 "${gateway%/}/health" >/dev/null; then
    echo "e2e_hermes: gateway health probe failed" >&2
    return 1
  fi
  e2e_pass "${assertion_id}"
}

e2e_hermes_assert_agent_home_permissions() {
  local assertion_id="${1:-expected.hermes.runtime.agent-home}"
  _e2e_hermes_assertion "${assertion_id}" || return $?
  _e2e_hermes_require_agent || return 1
  if e2e_env_is_dry_run; then
    _e2e_hermes_plan "${assertion_id}" "verify /sandbox/.hermes exists and is not world-writable"
    return 0
  fi
  local sandbox
  sandbox="$(_e2e_hermes_sandbox_name)"
  if ! e2e_sandbox_exec "${sandbox}" -- sh -lc 'test -d /sandbox/.hermes && perms=$(stat -c %a /sandbox/.hermes 2>/dev/null || stat -f %Lp /sandbox/.hermes); case "$perms" in *2|*3|*6|*7) exit 1;; *) exit 0;; esac'; then
    echo "e2e_hermes: /sandbox/.hermes missing or world-writable" >&2
    return 1
  fi
  e2e_pass "${assertion_id}"
}

e2e_hermes_assert_env_integrity() {
  local assertion_id="${1:-expected.hermes.runtime.env-integrity}"
  _e2e_hermes_assertion "${assertion_id}" || return $?
  _e2e_hermes_require_agent || return 1
  if e2e_env_is_dry_run; then
    _e2e_hermes_plan "${assertion_id}" "verify Hermes .env is present without leaking sensitive values"
    return 0
  fi
  local sandbox output
  sandbox="$(_e2e_hermes_sandbox_name)"
  if ! output="$(e2e_sandbox_exec "${sandbox}" -- sh -lc 'test -f /sandbox/.hermes/.env && grep -E "^(HERMES|OPENAI|NVIDIA|ANTHROPIC|GEMINI|SLACK|DISCORD|TELEGRAM)_" /sandbox/.hermes/.env | sed -E "s/(TOKEN|SECRET|PASSWORD|API_KEY|APIKEY|CREDENTIAL)([^=]*)=.*/\1\2=REDACTED/"')"; then
    echo "e2e_hermes: Hermes .env missing or unreadable" >&2
    return 1
  fi
  printf '%s\n' "${output}" | _e2e_hermes_redact
  e2e_pass "${assertion_id}"
}

e2e_hermes_assert_security_posture() {
  local assertion_id="${1:-expected.hermes.runtime.security-posture}"
  _e2e_hermes_assertion "${assertion_id}" || return $?
  _e2e_hermes_require_agent || return 1
  if e2e_env_is_dry_run; then
    _e2e_hermes_plan "${assertion_id}" "verify Hermes runtime security posture from sandbox state"
    return 0
  fi
  local sandbox
  sandbox="$(_e2e_hermes_sandbox_name)"
  if ! e2e_sandbox_exec "${sandbox}" -- sh -lc 'test ! -w /etc && test -d /sandbox/.hermes && test ! -f /sandbox/.hermes/.env.bak'; then
    echo "e2e_hermes: security posture checks failed" >&2
    return 1
  fi
  e2e_pass "${assertion_id}"
}
