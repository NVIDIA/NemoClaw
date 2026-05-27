#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Inference/provider validation primitives for scenario-suite steps.

_E2E_INF_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_E2E_INF_RUNTIME_LIB_DIR="$(cd "${_E2E_INF_LIB_DIR}/../../runtime/lib" && pwd)"
_E2E_INF_VALIDATION_DIR="$(cd "${_E2E_INF_LIB_DIR}/.." && pwd)"
# shellcheck source=../../runtime/lib/env.sh
. "${_E2E_INF_RUNTIME_LIB_DIR}/env.sh"
# shellcheck source=../../runtime/lib/context.sh
. "${_E2E_INF_RUNTIME_LIB_DIR}/context.sh"
# shellcheck source=../sandbox-exec.sh
. "${_E2E_INF_VALIDATION_DIR}/sandbox-exec.sh"

_e2e_inference_assertion() {
  local assertion_id="${1:-}"
  if [[ -z "${assertion_id}" ]]; then
    echo "e2e_inference_routing: missing assertion id" >&2
    return 2
  fi
  e2e_section "${assertion_id}"
}

_e2e_inference_require_sandbox() {
  e2e_context_require E2E_SANDBOX_NAME
}

_e2e_inference_sandbox_name() {
  e2e_context_get E2E_SANDBOX_NAME
}

_e2e_inference_plan() {
  local assertion_id="${1:-}"
  local detail="${2:-planned inference/provider check}"
  e2e_env_trace "inference:plan" "${assertion_id} ${detail}"
  echo "[dry-run] ${assertion_id}: ${detail}"
  if [[ -f "$(e2e_context_path)" ]]; then
    e2e_context_dump | sed -E 's/(TOKEN|SECRET|API_KEY|APIKEY|CREDENTIAL|PASSWORD)([^=]*)=.*/\1\2=REDACTED/'
  fi
}

_e2e_inference_curl_json() {
  local sandbox="$1"
  local url="$2"
  local payload="${3:-}"
  if [[ -n "${payload}" ]]; then
    printf '%s' "${payload}" | e2e_sandbox_exec_stdin "${sandbox}" -- curl --silent --show-error --fail --max-time 20 \
      -H 'content-type: application/json' -d @- "${url}"
  else
    e2e_sandbox_exec "${sandbox}" -- curl --silent --show-error --fail --max-time 20 "${url}"
  fi
}

_e2e_inference_status() {
  local sandbox="$1"
  local url="$2"
  shift 2
  e2e_sandbox_exec "${sandbox}" -- curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 20 "$@" "${url}"
}

e2e_inference_routing_assert_chat_completion() {
  local assertion_id="${1:-post-onboard.inference-routing.inference-local-chat-completion}"
  _e2e_inference_assertion "${assertion_id}"
  _e2e_inference_require_sandbox
  if e2e_env_is_dry_run; then
    _e2e_inference_plan "${assertion_id}" "POST https://inference.local/v1/chat/completions with bounded curl"
    return 0
  fi
  local sandbox payload output
  sandbox="$(_e2e_inference_sandbox_name)"
  payload='{"model":"default","messages":[{"role":"user","content":"Say ok"}],"max_tokens":8}'
  output="$(_e2e_inference_curl_json "${sandbox}" "https://inference.local/v1/chat/completions" "${payload}")"
  if [[ "${output}" != *choices* && "${output}" != *content* ]]; then
    echo "e2e_inference_routing: chat completion response missing choices/content" >&2
    return 1
  fi
  e2e_pass "${assertion_id}"
}

e2e_inference_routing_assert_health() {
  local assertion_id="${1:-post-onboard.inference-routing.provider-route-healthy}"
  local url="${2:-https://inference.local/v1/models}"
  _e2e_inference_assertion "${assertion_id}"
  _e2e_inference_require_sandbox
  if e2e_env_is_dry_run; then
    _e2e_inference_plan "${assertion_id}" "GET ${url} with bounded curl"
    return 0
  fi
  local sandbox status
  sandbox="$(_e2e_inference_sandbox_name)"
  status="$(_e2e_inference_status "${sandbox}" "${url}")"
  [[ "${status}" =~ ^2[0-9][0-9]$ ]] || {
    echo "e2e_inference_routing: ${url} returned HTTP ${status}" >&2
    return 1
  }
  e2e_pass "${assertion_id}"
}

e2e_inference_routing_assert_auth_proxy() {
  local assertion_id="${1:-post-onboard.ollama-auth-proxy.authenticated-request-accepted}"
  local mode="${2:-valid}"
  _e2e_inference_assertion "${assertion_id}"
  _e2e_inference_require_sandbox
  if e2e_env_is_dry_run; then
    _e2e_inference_plan "${assertion_id}" "auth-proxy ${mode} request; sensitive context redacted"
    return 0
  fi
  local sandbox status token
  sandbox="$(_e2e_inference_sandbox_name)"
  case "${mode}" in
    unauthenticated)
      status="$(_e2e_inference_status "${sandbox}" "https://inference.local/v1/models")"
      [[ "${status}" =~ ^(401|403)$ ]] || return 1
      ;;
    invalid)
      status="$(_e2e_inference_status "${sandbox}" "https://inference.local/v1/models" -H 'Authorization: Bearer invalid-token')"
      [[ "${status}" =~ ^(401|403)$ ]] || return 1
      ;;
    valid)
      e2e_context_require E2E_OLLAMA_AUTH_TOKEN
      token="$(e2e_context_get E2E_OLLAMA_AUTH_TOKEN)"
      status="$(_e2e_inference_status "${sandbox}" "https://inference.local/v1/models" -H "Authorization: Bearer ${token}")"
      [[ "${status}" =~ ^2[0-9][0-9]$ ]] || return 1
      ;;
    *)
      echo "e2e_inference_routing: unknown auth proxy mode ${mode}" >&2
      return 2
      ;;
  esac
  e2e_pass "${assertion_id}"
}
