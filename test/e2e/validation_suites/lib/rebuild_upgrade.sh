#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Rebuild/upgrade suite primitives. Source-only: no probes run at load time.

_REBUILD_UPGRADE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_REBUILD_UPGRADE_REPO_ROOT="$(cd "${_REBUILD_UPGRADE_DIR}/../../../.." && pwd)"
# shellcheck source=../../runtime/lib/context.sh
. "${_REBUILD_UPGRADE_REPO_ROOT}/test/e2e/runtime/lib/context.sh"
# shellcheck source=../../runtime/lib/logging.sh
. "${_REBUILD_UPGRADE_REPO_ROOT}/test/e2e/runtime/lib/logging.sh"

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

rebuild_upgrade_assert_sandbox_reachable() {
  rebuild_upgrade_require_context || return 1
  if [[ "${E2E_DRY_RUN:-0}" == "1" ]]; then
    e2e_pass "suite.upgrade.survivor_agent_reachable dry-run"
    return 0
  fi
  local sandbox
  sandbox="$(_rebuild_upgrade_ctx E2E_SANDBOX_NAME)"
  if _rebuild_upgrade_run REBUILD_UPGRADE_SANDBOX_CMD openshell sandbox exec -n "${sandbox}" -- true; then
    e2e_pass "suite.upgrade.survivor_agent_reachable"
  else
    e2e_fail "suite.upgrade.survivor_agent_reachable"
  fi
}

rebuild_upgrade_assert_marker_preserved() {
  rebuild_upgrade_require_context || return 1
  if [[ "${E2E_DRY_RUN:-0}" == "1" ]]; then
    e2e_pass "suite.rebuild.workspace_state_preserved dry-run"
    return 0
  fi
  local sandbox marker_path expected actual
  sandbox="$(_rebuild_upgrade_ctx E2E_SANDBOX_NAME)"
  marker_path="${E2E_REBUILD_MARKER_PATH:-/workspace/.nemoclaw-rebuild-marker}"
  expected="${E2E_REBUILD_MARKER_EXPECTED:-${E2E_STATE_MARKER_EXPECTED:-}}"
  actual="$(_rebuild_upgrade_run REBUILD_UPGRADE_SANDBOX_CMD openshell sandbox exec -n "${sandbox}" -- cat "${marker_path}" 2>/dev/null || true)"
  if [[ -n "${actual}" && (-z "${expected}" || "${actual}" == "${expected}") ]]; then
    e2e_pass "suite.rebuild.workspace_state_preserved"
  else
    e2e_fail "suite.rebuild.workspace_state_preserved"
  fi
}

rebuild_upgrade_assert_agent_version_upgraded() {
  rebuild_upgrade_require_context || return 1
  if [[ "${E2E_DRY_RUN:-0}" == "1" ]]; then
    e2e_pass "suite.rebuild.agent_version_upgraded dry-run"
    return 0
  fi
  local sandbox old expected actual cmd
  sandbox="$(_rebuild_upgrade_ctx E2E_SANDBOX_NAME)"
  old="${E2E_OLD_AGENT_VERSION:-}"
  expected="${E2E_EXPECTED_AGENT_VERSION:-}"
  cmd="${E2E_AGENT_VERSION_COMMAND:-openclaw --version}"
  actual="$(_rebuild_upgrade_run REBUILD_UPGRADE_SANDBOX_CMD openshell sandbox exec -n "${sandbox}" -- bash -lc "${cmd}" 2>/dev/null || true)"
  if [[ -n "${actual}" && (-z "${old}" || "${actual}" != *"${old}"*) && (-z "${expected}" || "${actual}" == *"${expected}"*) ]]; then
    e2e_pass "suite.rebuild.agent_version_upgraded"
  else
    e2e_fail "suite.rebuild.agent_version_upgraded"
  fi
}

rebuild_upgrade_assert_inference_works() {
  rebuild_upgrade_require_context || return 1
  if [[ "${E2E_DRY_RUN:-0}" == "1" ]]; then
    e2e_pass "suite.rebuild.inference_still_works dry-run"
    return 0
  fi
  local sandbox cmd output
  sandbox="$(_rebuild_upgrade_ctx E2E_SANDBOX_NAME)"
  cmd="${E2E_INFERENCE_CHECK_COMMAND:-curl -fsS http://inference.local/v1/models}"
  output="$(_rebuild_upgrade_run REBUILD_UPGRADE_SANDBOX_CMD openshell sandbox exec -n "${sandbox}" -- bash -lc "${cmd}" 2>/dev/null || true)"
  if [[ -n "${output}" ]]; then
    e2e_pass "suite.rebuild.inference_still_works"
  else
    e2e_fail "suite.rebuild.inference_still_works"
  fi
}

rebuild_upgrade_assert_policy_presets_preserved() {
  rebuild_upgrade_require_context || return 1
  if [[ "${E2E_DRY_RUN:-0}" == "1" ]]; then
    e2e_pass "suite.rebuild.policy_presets_preserved dry-run"
    return 0
  fi
  local presets output preset
  presets="${E2E_EXPECTED_POLICY_PRESETS:-npm pypi}"
  output="$(_rebuild_upgrade_run REBUILD_UPGRADE_NEMOCLAW_CMD nemoclaw policy status 2>/dev/null || true)"
  for preset in ${presets}; do
    if [[ "${output}" != *"${preset}"* ]]; then
      e2e_fail "suite.rebuild.policy_presets_preserved"
      return 1
    fi
  done
  e2e_pass "suite.rebuild.policy_presets_preserved"
}

rebuild_upgrade_assert_hermes_config_preserved() {
  rebuild_upgrade_require_context || return 1
  if [[ "$(_rebuild_upgrade_ctx E2E_AGENT)" != "hermes" ]]; then
    e2e_pass "suite.rebuild.hermes_config_preserved skipped non-hermes"
    return 0
  fi
  if [[ "${E2E_DRY_RUN:-0}" == "1" ]]; then
    e2e_pass "suite.rebuild.hermes_config_preserved dry-run"
    return 0
  fi
  local sandbox output
  sandbox="$(_rebuild_upgrade_ctx E2E_SANDBOX_NAME)"
  output="$(_rebuild_upgrade_run REBUILD_UPGRADE_SANDBOX_CMD openshell sandbox exec -n "${sandbox}" -- bash -lc "grep -R 'platforms.discord\|DISCORD' ~/.hermes . 2>/dev/null" || true)"
  if [[ "${output}" == *"discord"* || "${output}" == *"DISCORD"* ]]; then
    e2e_pass "suite.rebuild.hermes_config_preserved"
  else
    e2e_fail "suite.rebuild.hermes_config_preserved"
  fi
}

rebuild_upgrade_assert_sandbox_registry_preserved() {
  rebuild_upgrade_require_context || return 1
  if [[ "${E2E_DRY_RUN:-0}" == "1" ]]; then
    e2e_pass "suite.upgrade.sandbox_registry_preserved dry-run"
    return 0
  fi
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
  if [[ "${E2E_DRY_RUN:-0}" == "1" ]]; then
    e2e_pass "suite.upgrade.gateway_version_upgraded dry-run"
    return 0
  fi
  local expected output
  expected="${E2E_EXPECTED_OPENSHELL_VERSION:-}"
  output="$(_rebuild_upgrade_run REBUILD_UPGRADE_GATEWAY_CMD curl -fsS "$(_rebuild_upgrade_ctx E2E_GATEWAY_URL)/version" 2>/dev/null || true)"
  if [[ -n "${output}" && (-z "${expected}" || "${output}" == *"${expected}"*) ]]; then
    e2e_pass "suite.upgrade.gateway_version_upgraded"
  else
    e2e_fail "suite.upgrade.gateway_version_upgraded"
  fi
}
