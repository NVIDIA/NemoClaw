#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Rebuild/upgrade suite primitives. Source-only: no probes run at load time.

_REBUILD_UPGRADE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_REBUILD_UPGRADE_REPO_ROOT="$(cd "${_REBUILD_UPGRADE_DIR}/../../../.." && pwd)"
# shellcheck source=../../runtime/lib/context.sh
. "${_REBUILD_UPGRADE_REPO_ROOT}/test/e2e-scenario/runtime/lib/context.sh"
# shellcheck source=../../runtime/lib/logging.sh
. "${_REBUILD_UPGRADE_REPO_ROOT}/test/e2e-scenario/runtime/lib/logging.sh"
# shellcheck source=../sandbox-exec.sh
. "${_REBUILD_UPGRADE_REPO_ROOT}/test/e2e-scenario/validation_suites/sandbox-exec.sh"

# Sandbox-exec calls in this lib feed the lifecycle.rebuild/upgrade
# orchestrator steps, which carry 120s caps. Default the per-call wrapper
# cap to 100s so a hung 'openshell sandbox exec'/'ssh -F' surfaces as a
# classified exit 124 well before the orchestrator's SIGTERM. Callers
# may still override per-call.
: "${E2E_SANDBOX_EXEC_TIMEOUT_SECONDS:=100}"

rebuild_upgrade_require_context() {
  e2e_context_require E2E_SCENARIO E2E_AGENT E2E_SANDBOX_NAME E2E_GATEWAY_URL
}

_rebuild_upgrade_ctx() {
  e2e_context_get "$1"
}

_rebuild_upgrade_run() {
  local override="$1"
  shift
  if [[ -n "${!override:-}" ]]; then
    # shellcheck disable=SC2086
    ${!override} "$@"
    return $?
  fi
  "$@"
}

# _rebuild_upgrade_sandbox_exec <sandbox> <cmd> [args...]
# Routes through the canonical `e2e_sandbox_exec` wrapper (ssh-config
# preferred, openshell-exec fallback, per-call timeout, classified
# diagnostic on hang) for production; honors the legacy
# REBUILD_UPGRADE_SANDBOX_CMD override so tests can inject a fake. The
# override contract preserves the original argv shape
# (`<override> -n <sandbox> -- <cmd>...`) so existing test fakes
# (e.g. `REBUILD_UPGRADE_SANDBOX_CMD=fake_sandbox`) keep working.
_rebuild_upgrade_sandbox_exec() {
  local sandbox="$1"
  shift
  if [[ -n "${REBUILD_UPGRADE_SANDBOX_CMD:-}" ]]; then
    # shellcheck disable=SC2086
    ${REBUILD_UPGRADE_SANDBOX_CMD} -n "${sandbox}" -- "$@"
    return $?
  fi
  e2e_sandbox_exec "${sandbox}" -- "$@"
}

rebuild_upgrade_assert_sandbox_reachable() {
  rebuild_upgrade_require_context || return 1
  local sandbox
  sandbox="$(_rebuild_upgrade_ctx E2E_SANDBOX_NAME)"
  if _rebuild_upgrade_sandbox_exec "${sandbox}" true; then
    e2e_pass "suite.upgrade.survivor_agent_reachable"
  else
    e2e_fail "suite.upgrade.survivor_agent_reachable"
  fi
}

rebuild_upgrade_assert_marker_preserved() {
  rebuild_upgrade_require_context || return 1
  local sandbox marker_path expected actual
  sandbox="$(_rebuild_upgrade_ctx E2E_SANDBOX_NAME)"
  marker_path="${E2E_REBUILD_MARKER_PATH:-/workspace/.nemoclaw-rebuild-marker}"
  expected="${E2E_REBUILD_MARKER_EXPECTED:-${E2E_STATE_MARKER_EXPECTED:-}}"
  actual="$(_rebuild_upgrade_sandbox_exec "${sandbox}" cat "${marker_path}" 2>/dev/null || true)"
  if [[ -n "${actual}" && (-z "${expected}" || "${actual}" == "${expected}") ]]; then
    e2e_pass "suite.rebuild.workspace_state_preserved"
  else
    e2e_fail "suite.rebuild.workspace_state_preserved"
  fi
}

rebuild_upgrade_assert_agent_version_upgraded() {
  rebuild_upgrade_require_context || return 1
  local sandbox old expected actual cmd
  sandbox="$(_rebuild_upgrade_ctx E2E_SANDBOX_NAME)"
  old="${E2E_OLD_AGENT_VERSION:-}"
  expected="${E2E_EXPECTED_AGENT_VERSION:-}"
  cmd="${E2E_AGENT_VERSION_COMMAND:-openclaw --version}"
  actual="$(_rebuild_upgrade_sandbox_exec "${sandbox}" bash -lc "${cmd}" 2>/dev/null || true)"
  if [[ -n "${actual}" && (-z "${old}" || "${actual}" != *"${old}"*) && (-z "${expected}" || "${actual}" == *"${expected}"*) ]]; then
    e2e_pass "suite.rebuild.agent_version_upgraded"
  else
    e2e_fail "suite.rebuild.agent_version_upgraded"
  fi
}

rebuild_upgrade_assert_inference_works() {
  rebuild_upgrade_require_context || return 1
  local sandbox cmd output
  sandbox="$(_rebuild_upgrade_ctx E2E_SANDBOX_NAME)"
  cmd="${E2E_INFERENCE_CHECK_COMMAND:-curl -fsS http://inference.local/v1/models}"
  output="$(_rebuild_upgrade_sandbox_exec "${sandbox}" bash -lc "${cmd}" 2>/dev/null || true)"
  if [[ -n "${output}" ]]; then
    e2e_pass "suite.rebuild.inference_still_works"
  else
    e2e_fail "suite.rebuild.inference_still_works"
  fi
}

rebuild_upgrade_assert_policy_presets_preserved() {
  rebuild_upgrade_require_context || return 1
  local id="suite.rebuild.policy_presets_preserved"
  local sandbox presets output preset
  sandbox="$(_rebuild_upgrade_ctx E2E_SANDBOX_NAME)"
  presets="${E2E_EXPECTED_POLICY_PRESETS:-npm pypi}"

  # Mirror the legacy test/e2e/test-rebuild-openclaw.sh and
  # test-full-e2e.sh pattern: ask the live gateway for the full policy
  # via `openshell policy get --full <sandbox>` and grep for the preset
  # name OR a well-known endpoint hostname for that preset. The earlier
  # implementation called `nemoclaw policy status`, which does not
  # exist as a CLI subcommand — the assertion always failed silently
  # because the wrapper swallowed the missing-command stderr via
  # `2>/dev/null || true`.
  output="$(_rebuild_upgrade_run REBUILD_UPGRADE_OPENSHELL_CMD openshell policy get --full "${sandbox}" 2>&1 || true)"
  if [[ -z "${output}" ]]; then
    e2e_fail "${id} openshell policy get --full returned no output for sandbox '${sandbox}'"
    return 1
  fi

  local preset matchers found m
  for preset in ${presets}; do
    case "${preset}" in
      npm) matchers=("npm" "registry.npmjs.org") ;;
      pypi) matchers=("pypi" "pypi.org" "files.pythonhosted.org") ;;
      huggingface) matchers=("huggingface" "huggingface.co") ;;
      brew) matchers=("brew" "formulae.brew.sh") ;;
      openclaw-pricing) matchers=("openclaw-pricing" "openrouter.ai") ;;
      *) matchers=("${preset}") ;;
    esac
    found=0
    for m in "${matchers[@]}"; do
      if [[ "${output}" == *"${m}"* ]]; then
        found=1
        break
      fi
    done
    if [[ "${found}" -eq 0 ]]; then
      e2e_fail "${id} preset '${preset}' not in policy (matchers: ${matchers[*]}); head: ${output:0:300}"
      return 1
    fi
  done
  e2e_pass "${id} presets=${presets}"
}

rebuild_upgrade_assert_hermes_config_preserved() {
  rebuild_upgrade_require_context || return 1
  if [[ "$(_rebuild_upgrade_ctx E2E_AGENT)" != "hermes" ]]; then
    e2e_pass "suite.rebuild.hermes_config_preserved skipped non-hermes"
    return 0
  fi
  local sandbox output
  sandbox="$(_rebuild_upgrade_ctx E2E_SANDBOX_NAME)"
  output="$(_rebuild_upgrade_sandbox_exec "${sandbox}" bash -lc "grep -R 'platforms.discord\|DISCORD' ~/.hermes . 2>/dev/null" || true)"
  if [[ "${output}" == *"discord"* || "${output}" == *"DISCORD"* ]]; then
    e2e_pass "suite.rebuild.hermes_config_preserved"
  else
    e2e_fail "suite.rebuild.hermes_config_preserved"
  fi
}

rebuild_upgrade_assert_sandbox_registry_preserved() {
  rebuild_upgrade_require_context || return 1
  local sandbox output
  sandbox="$(_rebuild_upgrade_ctx E2E_SANDBOX_NAME)"
  output="$(_rebuild_upgrade_run REBUILD_UPGRADE_NEMOCLAW_CMD nemoclaw list 2>/dev/null || true)"
  if [[ "${output}" == *"${sandbox}"* ]]; then
    e2e_pass "suite.upgrade.sandbox_registry_preserved"
  else
    e2e_fail "suite.upgrade.sandbox_registry_preserved"
  fi
}

rebuild_upgrade_assert_gateway_version_upgraded() {
  rebuild_upgrade_require_context || return 1
  local expected output
  expected="${E2E_EXPECTED_OPENSHELL_VERSION:-}"
  output="$(_rebuild_upgrade_run REBUILD_UPGRADE_GATEWAY_CMD curl -fsS "$(_rebuild_upgrade_ctx E2E_GATEWAY_URL)/version" 2>/dev/null || true)"
  if [[ -n "${output}" && (-z "${expected}" || "${output}" == *"${expected}"*) ]]; then
    e2e_pass "suite.upgrade.gateway_version_upgraded"
  else
    e2e_fail "suite.upgrade.gateway_version_upgraded"
  fi
}
