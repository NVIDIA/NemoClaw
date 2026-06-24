#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# CI-only hosted inference shim: live E2E lanes use the repository's
# NVIDIA_INFERENCE_API_KEY secret against the hosted OpenAI-compatible endpoint
# at inference-api.nvidia.com. Keep this helper in test/e2e so the
# product-facing provider/default endpoint remain unchanged.

NEMOCLAW_E2E_COMPATIBLE_INFERENCE_MODEL_DEFAULT="nvidia/nvidia/nemotron-3-super-v3"
NEMOCLAW_E2E_HOSTED_INFERENCE_PROVIDER_DEFAULT="compatible-endpoint"
NEMOCLAW_E2E_NVIDIA_INFERENCE_MODEL_DEFAULT="nvidia/nemotron-3-super-120b-a12b"

nemoclaw_e2e_using_compatible_inference() {
  if [ "${NEMOCLAW_E2E_USE_HOSTED_INFERENCE:-}" = "1" ]; then
    return 0
  fi
  case "${NEMOCLAW_PROVIDER:-}" in
    build | cloud | nvidia | nvidia-prod)
      return 1
      ;;
  esac
  [ -n "${NVIDIA_INFERENCE_API_KEY:-}" ] && [[ "${NVIDIA_INFERENCE_API_KEY}" != nvapi-* ]]
}

nemoclaw_e2e_configure_compatible_inference() {
  if ! nemoclaw_e2e_using_compatible_inference; then
    return 0
  fi

  if [ -z "${NVIDIA_INFERENCE_API_KEY:-}" ]; then
    echo "ERROR: NVIDIA_INFERENCE_API_KEY is required for hosted CI inference" >&2
    return 1
  fi

  export NEMOCLAW_PROVIDER="${NEMOCLAW_PROVIDER:-custom}"
  export NEMOCLAW_ENDPOINT_URL="${NEMOCLAW_ENDPOINT_URL:-https://inference-api.nvidia.com/v1}"
  export NEMOCLAW_MODEL="${NEMOCLAW_MODEL:-${NEMOCLAW_CLOUD_EXPERIMENTAL_MODEL:-$NEMOCLAW_E2E_COMPATIBLE_INFERENCE_MODEL_DEFAULT}}"
  export NEMOCLAW_COMPAT_MODEL="${NEMOCLAW_COMPAT_MODEL:-$NEMOCLAW_MODEL}"
  export NEMOCLAW_PREFERRED_API="${NEMOCLAW_PREFERRED_API:-openai-completions}"
  export COMPATIBLE_API_KEY="$NVIDIA_INFERENCE_API_KEY"
}

nemoclaw_e2e_hosted_inference_key() {
  printf '%s' "${NVIDIA_INFERENCE_API_KEY:-}"
}

nemoclaw_e2e_hosted_inference_base_url() {
  if nemoclaw_e2e_using_compatible_inference; then
    printf '%s' "${NEMOCLAW_ENDPOINT_URL:-https://inference-api.nvidia.com/v1}"
  else
    printf '%s' "https://inference-api.nvidia.com/v1"
  fi
}

nemoclaw_e2e_expected_route_provider() {
  if nemoclaw_e2e_using_compatible_inference; then
    printf '%s' "$NEMOCLAW_E2E_HOSTED_INFERENCE_PROVIDER_DEFAULT"
  else
    printf '%s' "nvidia-prod"
  fi
}

nemoclaw_e2e_strip_ansi() {
  if command -v perl >/dev/null 2>&1; then
    perl -pe 's/\x1b\][^\a]*(?:\a|\x1b\\)//g; s/\x1b\[[0-9;?]*[ -\/]*[@-~]//g'
  else
    sed -E $'s/\x1B\\[[0-9;?]*[ -\\/]*[@-~]//g'
  fi
}

nemoclaw_e2e_inference_output_matches() {
  local output="$1"
  local provider="$2"
  local model="${3:-}"
  local plain

  plain="$(printf '%s' "$output" | nemoclaw_e2e_strip_ansi)"
  grep -Eqi "Provider:[[:space:]]*${provider}" <<<"$plain" || return 1
  [ -z "$model" ] || grep -Fq "$model" <<<"$plain"
}

nemoclaw_e2e_note_pass() {
  if declare -F pass >/dev/null 2>&1; then
    pass "$@"
  else
    printf 'PASS: %s\n' "$*"
  fi
}

nemoclaw_e2e_note_fail() {
  if declare -F fail >/dev/null 2>&1; then
    fail "$@"
  else
    printf 'ERROR: %s\n' "$*" >&2
  fi
}

nemoclaw_e2e_hosted_inference_model() {
  if nemoclaw_e2e_using_compatible_inference; then
    printf '%s' "${NEMOCLAW_MODEL:-${NEMOCLAW_CLOUD_EXPERIMENTAL_MODEL:-$NEMOCLAW_E2E_COMPATIBLE_INFERENCE_MODEL_DEFAULT}}"
  else
    printf '%s' "${NEMOCLAW_MODEL:-${NEMOCLAW_CLOUD_EXPERIMENTAL_MODEL:-$NEMOCLAW_E2E_NVIDIA_INFERENCE_MODEL_DEFAULT}}"
  fi
}

nemoclaw_e2e_probe_hosted_inference() {
  local base_url status
  base_url="$(nemoclaw_e2e_hosted_inference_base_url)"

  # This preflight is a network/TLS reachability check only. Do not spend an
  # inference request here: full parallel nightly runs can otherwise burn CI
  # quota or trip HTTP 429 before the scenario reaches the behavior under test.
  # In compatible mode, NEMOCLAW_ENDPOINT_URL is a trusted repo-controlled CI
  # input from nightly workflow env_json; this probe intentionally validates
  # only TCP/TLS/HTTP reachability for that base URL, not provider semantics.
  # Onboarding still performs the authenticated model/API validation with
  # redaction and retries.
  status=$(curl -sS --connect-timeout 10 --max-time 20 -o /dev/null -w "%{http_code}" "$base_url" 2>/dev/null) || return $?
  [ -n "$status" ] && [ "$status" != "000" ]
}

nemoclaw_e2e_require_hosted_inference_key() {
  local key
  key="$(nemoclaw_e2e_hosted_inference_key)"

  if nemoclaw_e2e_using_compatible_inference; then
    if [ -n "$key" ]; then
      nemoclaw_e2e_note_pass "NVIDIA_INFERENCE_API_KEY is set for hosted CI inference"
    else
      nemoclaw_e2e_note_fail "NVIDIA_INFERENCE_API_KEY not set - required for hosted CI inference"
      return 1
    fi
    return 0
  fi

  if [ -n "$key" ] && [[ "$key" == nvapi-* ]]; then
    nemoclaw_e2e_note_pass "NVIDIA_INFERENCE_API_KEY is set (starts with nvapi-)"
  else
    nemoclaw_e2e_note_fail "NVIDIA_INFERENCE_API_KEY not set or invalid - required for live inference"
    return 1
  fi
}
