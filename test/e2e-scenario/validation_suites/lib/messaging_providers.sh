#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Messaging-provider primitives for scenario validation suites.

if [[ -n "${_E2E_MESSAGING_PROVIDERS_SH_LOADED:-}" ]]; then
  # shellcheck disable=SC2317 # This guard is reached only when the file is sourced more than once.
  return 0 2>/dev/null || true
fi
_E2E_MESSAGING_PROVIDERS_SH_LOADED=1

_e2e_messaging_lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_e2e_messaging_repo_root="$(cd "${_e2e_messaging_lib_dir}/../../../.." && pwd)"
# shellcheck source=../../runtime/lib/context.sh
. "${_e2e_messaging_repo_root}/test/e2e-scenario/runtime/lib/context.sh"
# shellcheck source=../../runtime/lib/logging.sh
. "${_e2e_messaging_repo_root}/test/e2e-scenario/runtime/lib/logging.sh"

# Load normalized scenario context and validate the minimum keys used by
# messaging suite primitives. Sourcing this file alone intentionally does not
# require context so helper tests and dry imports remain cheap.
e2e_messaging_load_context() {
  local ctx
  ctx="$(e2e_context_path)"
  if [[ ! -f "${ctx}" ]]; then
    printf 'messaging context: missing context.env at %s (set E2E_CONTEXT_DIR)\n' "${ctx}" >&2
    return 1
  fi
  # shellcheck disable=SC1090
  . "${ctx}"
  e2e_context_require E2E_SANDBOX_NAME E2E_AGENT
}

e2e_messaging_channel() {
  local provider channel
  provider="$(e2e_context_get E2E_MESSAGING_PROVIDER)"
  if [[ -z "${provider}" ]]; then
    e2e_fail "expected-state.messaging.provider missing E2E_MESSAGING_PROVIDER"
  fi
  channel="$(e2e_context_get E2E_MESSAGING_CHANNEL)"
  case "${provider}:${channel}" in
    slack:app) printf 'slack-app\n' ;;
    slack:bot | slack:) printf 'slack-bot\n' ;;
    whatsapp:*) printf 'whatsapp-qr\n' ;;
    telegram:* | discord:*) printf '%s\n' "${provider}" ;;
    *) e2e_fail "expected-state.messaging.provider unsupported provider/channel: ${provider}:${channel:-default}" ;;
  esac
}

e2e_messaging_provider_name() {
  e2e_messaging_channel
}

e2e_messaging_agent_config_path() {
  local agent
  agent="$(e2e_context_get E2E_AGENT)"
  case "${agent}" in
    openclaw) printf '/sandbox/.openclaw/openclaw.json\n' ;;
    hermes) printf '/sandbox/.hermes/.env\n' ;;
    *) e2e_fail "expected-state.messaging.config-path unsupported agent: ${agent:-missing}" ;;
  esac
}

e2e_messaging_config_key() {
  local provider
  provider="$(e2e_messaging_provider_name)"
  case "${provider}" in
    telegram) printf 'TELEGRAM_BOT_TOKEN\n' ;;
    discord) printf 'DISCORD_BOT_TOKEN\n' ;;
    slack-bot | slack-app) printf 'SLACK_BOT_TOKEN\n' ;;
    whatsapp-qr) printf 'WHATSAPP_QR\n' ;;
    *) e2e_fail "expected-state.messaging.config-key unsupported provider: ${provider}" ;;
  esac
}

e2e_messaging_assert_placeholder_configured() {
  local content="${1:-}"
  local key="${2:-$(e2e_messaging_config_key)}"
  if [[ "${content}" == *"\${${key}}"* ]] || [[ "${content}" == *"\$${key}"* ]] || [[ "${content}" == *"PLACEHOLDER"* ]]; then
    e2e_pass "expected-state.messaging.placeholder-configured ${key}"
    return 0
  fi
  printf 'FAIL: expected-state.messaging.placeholder-configured missing placeholder for %s\n' "${key}" >&2
  return 1
}

e2e_messaging_read_config_surface() {
  local direct
  direct="$(e2e_context_get E2E_MESSAGING_CONFIG_CONTENT)"
  if [[ -n "${direct}" ]]; then
    printf '%s\n' "${direct}"
    return 0
  fi
  direct="$(e2e_context_get E2E_MESSAGING_PROVIDER_STATE)"
  if [[ -n "${direct}" ]]; then
    printf '%s\n' "${direct}"
    return 0
  fi
  local path
  path="$(e2e_context_get E2E_MESSAGING_CONFIG_PATH)"
  if [[ -n "${path}" && -f "${path}" ]]; then
    cat "${path}"
    return 0
  fi
  path="$(e2e_messaging_agent_config_path)"
  if [[ -n "${E2E_DRY_RUN:-}" ]]; then
    printf '%s=PLACEHOLDER\n' "$(e2e_messaging_config_key)"
    return 0
  fi
  if [[ -f "${path}" ]]; then
    cat "${path}"
    return 0
  fi
  local sandbox_name
  sandbox_name="$(e2e_context_get E2E_SANDBOX_NAME)"
  if [[ -n "${sandbox_name}" && "${path}" == /sandbox/* ]]; then
    local remote
    remote="$(timeout 30 openshell sandbox exec --name "${sandbox_name}" -- cat "${path}" 2>/dev/null || true)"
    if [[ -n "${remote}" ]]; then
      printf '%s\n' "${remote}"
      return 0
    fi
  fi
  e2e_fail "expected-state.messaging.config-surface missing config content/path for ${path}"
}

e2e_messaging_assert_no_secret_leak() {
  local surface="${1:-}"
  local secret="${2:-}"
  if [[ -z "${secret}" ]]; then
    e2e_pass "expected-state.messaging.no-secret-leak no raw secret supplied"
    return 0
  fi
  if [[ "${surface}" == *"${secret}"* ]]; then
    printf 'FAIL: expected-state.messaging.no-secret-leak raw credential material detected\n' >&2
    return 1
  fi
  e2e_pass "expected-state.messaging.no-secret-leak raw credential material absent"
}

e2e_messaging_bridge_url() {
  local url
  url="$(e2e_context_get E2E_MESSAGING_BRIDGE_URL)"
  if [[ -z "${url}" ]]; then
    url="$(e2e_context_get E2E_GATEWAY_URL)"
  fi
  printf '%s\n' "${url}"
}

e2e_messaging_assert_gateway_path() {
  local provider expected actual
  provider="${1:-$(e2e_messaging_provider_name)}"
  expected="$(e2e_context_get E2E_MESSAGING_GATEWAY_PATH)"
  actual="$(e2e_messaging_bridge_url)"
  if [[ -z "${actual}" ]]; then
    e2e_fail "expected-state.messaging.${provider}.gateway-path missing bridge URL"
  fi
  if [[ -n "${expected}" && "${actual}" != *"${expected}"* ]]; then
    e2e_fail "expected-state.messaging.${provider}.gateway-path expected ${expected}, got ${actual}"
  fi
  e2e_pass "expected-state.messaging.${provider}.gateway-path provider gateway path configured"
}

e2e_messaging_assert_provider_attached() {
  local provider surface
  provider="$(e2e_messaging_provider_name)"
  surface="$(e2e_messaging_read_config_surface)"
  if [[ "${surface}" == *"$(e2e_messaging_config_key)"* ]] || [[ "${surface}" == *"${provider}"* ]]; then
    e2e_pass "expected-state.messaging.${provider}.provider-attached provider ${provider} configured for sandbox $(e2e_context_get E2E_SANDBOX_NAME)"
    return 0
  fi
  e2e_fail "expected-state.messaging.${provider}.provider-attached missing provider evidence in config surface"
}

e2e_messaging_assert_literal_payload() {
  local assertion_id="${1:?assertion id required}"
  local payload="${2:?payload required}"
  local observed="${3:-}"
  if [[ -z "${observed}" && -n "${E2E_DRY_RUN:-}" ]]; then
    observed="${payload}"
  fi
  if [[ -z "${observed}" ]]; then
    e2e_fail "${assertion_id} missing observed payload output"
  fi
  if [[ "${observed}" != *"${payload}"* ]]; then
    e2e_fail "${assertion_id} payload was not preserved literally"
  fi
  e2e_pass "${assertion_id} payload treated as text"
}

e2e_messaging_assert_bridge_reachable() {
  local provider url
  provider="${1:-$(e2e_messaging_provider_name)}"
  url="$(e2e_messaging_bridge_url)"
  if [[ -z "${url}" ]]; then
    e2e_fail "expected-state.messaging.${provider}.bridge-reachable missing E2E_MESSAGING_BRIDGE_URL/E2E_GATEWAY_URL"
  fi
  export MESSAGING_BRIDGE_URL="${url}"
  # shellcheck source=../assert/messaging-bridge-reachable.sh
  . "${_e2e_messaging_repo_root}/test/e2e-scenario/validation_suites/assert/messaging-bridge-reachable.sh"
  e2e_assert_messaging_bridge_reachable "${provider}"
}
