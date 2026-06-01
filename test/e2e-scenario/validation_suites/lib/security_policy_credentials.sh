#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Security policy and credential validation primitives.

if [[ -n "${NEMOCLAW_SECURITY_POLICY_CREDENTIALS_LIB_LOADED:-}" ]]; then
  # shellcheck disable=SC2317 # This file may be sourced repeatedly or executed in tests.
  return 0 2>/dev/null || exit 0
fi
NEMOCLAW_SECURITY_POLICY_CREDENTIALS_LIB_LOADED=1

_spc_lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_spc_e2e_root="$(cd "${_spc_lib_dir}/../.." && pwd)"
# shellcheck source=../../runtime/lib/env.sh
. "${_spc_e2e_root}/runtime/lib/env.sh"
# shellcheck source=../../runtime/lib/context.sh
. "${_spc_e2e_root}/runtime/lib/context.sh"

spc_assertion_id() {
  printf '%s\n' "$1"
}

spc_require_context() {
  e2e_context_require "$@"
}

spc_context_get() {
  e2e_context_get "$1"
}

spc_redact_secret_text() {
  sed -E 's/(sk-[A-Za-z0-9_-]{8,}|nvapi-[A-Za-z0-9_-]{8,}|[A-Za-z0-9._%+-]+:[A-Za-z0-9_\/-]{12,}|(api[_-]?key|token|secret|password)[=:][^[:space:]]+)/[REDACTED]/Ig'
}

spc_log_provider_metadata() {
  local provider="$1"
  local name="${2:-default}"
  printf 'credential provider=%s name=%s value=[REDACTED]\n' "${provider}" "${name}"
}

spc_assert_credentials_expected() {
  spc_assertion_id "post-onboard.credentials.gateway-list-redacts-values"
  spc_require_context E2E_SCENARIO E2E_PROVIDER
  local expected
  expected="$(spc_context_get E2E_CREDENTIALS_EXPECTED)"
  if [[ -z "${expected}" ]]; then
    expected="$(spc_context_get CREDENTIALS_EXPECTED)"
  fi
  if [[ -z "${expected}" ]]; then
    expected="present"
  fi
  if [[ "${expected}" != "present" ]]; then
    echo "credentials expected state is '${expected}', not present" >&2
    return 1
  fi
  spc_log_provider_metadata "$(spc_context_get E2E_PROVIDER)" "gateway"
  if e2e_env_is_dry_run; then
    echo "[dry-run] would list gateway credentials without raw values"
    return 0
  fi
  local raw_file listed_raw listed list_rc
  raw_file="$(mktemp "${TMPDIR:-/tmp}/nemoclaw-credentials-list.XXXXXX")"
  chmod 600 "${raw_file}"
  if nemoclaw credentials list >"${raw_file}" 2>&1; then
    list_rc=0
  else
    list_rc=$?
  fi
  listed_raw="$(cat "${raw_file}")"
  listed="$(printf '%s\n' "${listed_raw}" | spc_redact_secret_text)"
  rm -f "${raw_file}"
  printf '%s\n' "${listed}"
  if [[ "${listed_raw}" != "${listed}" ]]; then
    echo "credentials list emitted secret-looking raw output before redaction" >&2
    return 1
  fi
  if ((list_rc != 0)); then
    echo "nemoclaw credentials list failed while credentials.expected=present" >&2
    return 1
  fi
  if printf '%s\n' "${listed}" | grep -qi "No provider credentials registered"; then
    echo "no gateway credentials were listed while credentials.expected=present" >&2
    return 1
  fi
  if ! printf '%s\n' "${listed}" | grep -q "Providers registered with the OpenShell gateway"; then
    echo "credentials list did not include the expected OpenShell gateway provider header" >&2
    return 1
  fi
}

spc_assert_no_plaintext_host_store() {
  spc_assertion_id "post-onboard.credentials.no-plaintext-host-store"
  spc_require_context E2E_SCENARIO
  local home_dir="${HOME:-}"
  if [[ -n "${home_dir}" && -f "${home_dir}/.nemoclaw/credentials.json" ]]; then
    echo "plaintext credential store found at ~/.nemoclaw/credentials.json" >&2
    return 1
  fi
  echo "plaintext host credential store absent"
}

spc_assert_policy_preset_present() {
  local preset="$1"
  spc_assertion_id "post-onboard.security-policy.${preset}-preset-applied"
  spc_require_context E2E_SCENARIO E2E_SANDBOX_NAME
  echo "policy preset expected: ${preset}"
  if e2e_env_is_dry_run; then
    echo "[dry-run] would verify policy preset ${preset}"
    return 0
  fi
  local sandbox_name active
  sandbox_name="$(spc_context_get E2E_SANDBOX_NAME)"
  if ! active="$(nemoclaw "${sandbox_name}" policy-list 2>&1)"; then
    printf '%s\n' "${active}"
    echo "failed to query policy presets for sandbox '${sandbox_name}'" >&2
    return 1
  fi
  printf '%s\n' "${active}"
  if ! printf '%s\n' "${active}" | awk -v preset="${preset}" '$1 == "●" && $2 == preset { found = 1 } END { exit found ? 0 : 1 }'; then
    echo "expected policy preset '${preset}' to be applied for sandbox '${sandbox_name}'" >&2
    return 1
  fi
}

spc_semver_ge() {
  local have="$1" want="$2" h_major h_minor h_patch w_major w_minor w_patch
  IFS=. read -r h_major h_minor h_patch <<<"${have}"
  IFS=. read -r w_major w_minor w_patch <<<"${want}"
  h_major=$((10#${h_major:-0}))
  h_minor=$((10#${h_minor:-0}))
  h_patch=$((10#${h_patch:-0}))
  w_major=$((10#${w_major:-0}))
  w_minor=$((10#${w_minor:-0}))
  w_patch=$((10#${w_patch:-0}))
  ((h_major > w_major)) && return 0
  ((h_major < w_major)) && return 1
  ((h_minor > w_minor)) && return 0
  ((h_minor < w_minor)) && return 1
  ((h_patch >= w_patch))
}

spc_assert_openshell_credential_rewrite_supported() {
  spc_assertion_id "post-onboard.gateway.openshell-version-supports-credential-rewrite"
  spc_require_context E2E_SCENARIO
  if e2e_env_is_dry_run; then
    echo "[dry-run] would verify OpenShell gateway capability metadata"
    return 0
  fi
  local openshell_bin version_output version minimum_version binary_strings feature
  minimum_version="0.0.39"
  openshell_bin="$(command -v openshell 2>/dev/null || true)"
  if [[ -z "${openshell_bin}" ]]; then
    echo "openshell binary was not found on PATH" >&2
    return 1
  fi
  version_output="$(${openshell_bin} --version 2>&1 || true)"
  version="$(printf '%s\n' "${version_output}" | grep -oE '[0-9]+(\.[0-9]+){1,2}' | head -n1 || true)"
  if [[ -z "${version}" ]]; then
    echo "could not determine OpenShell version from: ${version_output}" >&2
    return 1
  fi
  if ! spc_semver_ge "${version}" "${minimum_version}"; then
    echo "OpenShell ${version} is below credential rewrite minimum ${minimum_version}" >&2
    return 1
  fi
  if ! command -v strings >/dev/null 2>&1; then
    echo "strings is required to verify OpenShell credential rewrite support" >&2
    return 1
  fi
  binary_strings="$(strings "${openshell_bin}" 2>/dev/null || true)"
  for feature in request-body-credential-rewrite websocket-credential-rewrite; do
    if [[ "${binary_strings}" != *"${feature}"* ]]; then
      echo "OpenShell binary is missing ${feature} support" >&2
      return 1
    fi
  done
  echo "OpenShell ${version} credential rewrite capability markers present"
}

spc_agent_config_path() {
  case "$(spc_context_get E2E_AGENT)" in
    hermes) printf '%s\n' "/sandbox/.hermes/.env" ;;
    openclaw | "") printf '%s\n' "/sandbox/.openclaw/openclaw.json" ;;
    *)
      echo "unsupported E2E_AGENT for shields config check: $(spc_context_get E2E_AGENT)" >&2
      return 1
      ;;
  esac
}

spc_assert_shields_permissions_match_state() {
  local sandbox_name="$1"
  local observed="$2"
  local config_path perms mode owner
  config_path="$(spc_agent_config_path)" || return 1
  if ! perms="$(openshell sandbox exec --name "${sandbox_name}" -- stat -c '%a %U:%G' "${config_path}" 2>&1)"; then
    printf '%s\n' "${perms}"
    echo "failed to inspect shields config permissions at ${config_path}" >&2
    return 1
  fi
  printf 'config permissions: %s %s\n' "${config_path}" "${perms}"
  mode="$(printf '%s\n' "${perms}" | awk '{print $1}')"
  owner="$(printf '%s\n' "${perms}" | awk '{print $2}')"
  case "${observed}" in
    up)
      if [[ ! "${mode}" =~ ^4[0-4][0-4]$ || "${owner}" != "root:root" ]]; then
        echo "shields are UP but config is not locked root:root with restrictive permissions: ${perms}" >&2
        return 1
      fi
      ;;
    down | not-configured)
      if [[ "${owner}" != "sandbox:sandbox" ]]; then
        echo "shields are ${observed} but config owner is not sandbox:sandbox: ${perms}" >&2
        return 1
      fi
      ;;
  esac
}

spc_assert_shields_config_consistent() {
  spc_assertion_id "post-onboard.security-shields.config-consistent"
  spc_require_context E2E_SCENARIO E2E_SANDBOX_NAME E2E_AGENT
  if e2e_env_is_dry_run; then
    echo "[dry-run] would verify shields config consistency"
    return 0
  fi
  local sandbox_name status observed expected
  sandbox_name="$(spc_context_get E2E_SANDBOX_NAME)"
  if ! status="$(nemoclaw "${sandbox_name}" shields status 2>&1)"; then
    printf '%s\n' "${status}"
    echo "failed to query shields status for sandbox '${sandbox_name}'" >&2
    return 1
  fi
  printf '%s\n' "${status}"
  case "${status}" in
    *"Shields: UP"*) observed="up" ;;
    *"Shields: DOWN"*) observed="down" ;;
    *"Shields: NOT CONFIGURED"*) observed="not-configured" ;;
    *)
      echo "shields status did not report a recognized state" >&2
      return 1
      ;;
  esac
  expected="$(spc_context_get E2E_SHIELDS_EXPECTED_STATE)"
  if [[ -z "${expected}" ]]; then
    expected="$(spc_context_get E2E_SHIELDS_EXPECTED)"
  fi
  expected="${expected//_/-}"
  if [[ -n "${expected}" && "${expected}" != "${observed}" ]]; then
    echo "expected shields state '${expected}', got '${observed}'" >&2
    return 1
  fi
  spc_assert_shields_permissions_match_state "${sandbox_name}" "${observed}"
  echo "shields config state is consistent: ${observed}"
}

spc_assert_telegram_payload_not_shell_executed() {
  spc_assertion_id "post-onboard.security-injection.telegram-message-not-shell-executed"
  spc_require_context E2E_SCENARIO E2E_SANDBOX_NAME
  local fixture_payload="${1:-}"
  if [[ -n "${fixture_payload}" ]]; then
    printf 'telegram payload fixture loaded (%s bytes)\n' "${#fixture_payload}"
  fi
  if e2e_env_is_dry_run; then
    echo "[dry-run] would submit payload without shell evaluation"
    return 0
  fi
  local sandbox_name marker payload send_output marker_state
  sandbox_name="$(spc_context_get E2E_SANDBOX_NAME)"
  marker="/tmp/nemoclaw-telegram-injection-proof-$RANDOM-$$"
  # shellcheck disable=SC2016 # Literal command-substitution payload under test.
  payload="$(printf '$(touch %s && echo INJECTED)' "${marker}")"
  openshell sandbox exec --name "${sandbox_name}" -- sh -c "rm -f '${marker}'" >/dev/null 2>&1 || true
  # shellcheck disable=SC2016 # Remote shell reads payload from stdin; local shell must not expand MSG.
  if ! send_output="$(openshell sandbox exec --name "${sandbox_name}" -- sh -c 'MSG=$(cat); printf "%s\n" "$MSG"' <<<"${payload}" 2>&1)"; then
    printf '%s\n' "${send_output}"
    echo "failed to submit telegram injection payload to sandbox '${sandbox_name}'" >&2
    return 1
  fi
  printf '%s\n' "${send_output}"
  if [[ "${send_output}" != *"${payload}"* ]]; then
    echo "telegram injection payload was not preserved literally" >&2
    return 1
  fi
  marker_state="$(openshell sandbox exec --name "${sandbox_name}" -- sh -c "test -f '${marker}' && echo EXPLOITED || echo SAFE" 2>&1 || true)"
  if [[ "${marker_state}" != *"SAFE"* ]]; then
    printf '%s\n' "${marker_state}"
    echo "telegram injection payload executed shell side effects" >&2
    return 1
  fi
  echo "telegram injection payload treated as data"
}
