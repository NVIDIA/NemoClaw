#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# CI-only compatibility shim: some live E2E lanes use the repository's
# NVIDIA_INFERENCE_API_KEY secret against an OpenAI-compatible endpoint instead
# of the public NVIDIA Endpoints provider. Keep this helper in test/e2e so the
# product-facing provider/default endpoint remain unchanged.

NEMOCLAW_E2E_COMPATIBLE_INFERENCE_MODEL_DEFAULT="nvidia/nvidia/nemotron-3-super-v3"
NEMOCLAW_E2E_NVIDIA_INFERENCE_MODEL_DEFAULT="nvidia/nemotron-3-super-120b-a12b"

nemoclaw_e2e_using_compatible_inference() {
  [ "${NEMOCLAW_E2E_USE_NVIDIA_SECRET_AS_COMPATIBLE:-}" = "1" ]
}

nemoclaw_e2e_configure_compatible_inference() {
  if ! nemoclaw_e2e_using_compatible_inference; then
    return 0
  fi

  export NEMOCLAW_PROVIDER="${NEMOCLAW_PROVIDER:-custom}"
  export NEMOCLAW_ENDPOINT_URL="${NEMOCLAW_ENDPOINT_URL:-https://inference-api.nvidia.com/v1}"
  export NEMOCLAW_MODEL="${NEMOCLAW_MODEL:-${NEMOCLAW_CLOUD_EXPERIMENTAL_MODEL:-$NEMOCLAW_E2E_COMPATIBLE_INFERENCE_MODEL_DEFAULT}}"
  export NEMOCLAW_COMPAT_MODEL="${NEMOCLAW_COMPAT_MODEL:-$NEMOCLAW_MODEL}"

  if [ -z "${COMPATIBLE_API_KEY:-}" ] && [ -n "${NVIDIA_INFERENCE_API_KEY:-}" ]; then
    export COMPATIBLE_API_KEY="$NVIDIA_INFERENCE_API_KEY"
  fi
}

nemoclaw_e2e_hosted_inference_key() {
  if nemoclaw_e2e_using_compatible_inference; then
    printf '%s' "${COMPATIBLE_API_KEY:-${NVIDIA_INFERENCE_API_KEY:-}}"
  else
    printf '%s' "${NVIDIA_INFERENCE_API_KEY:-}"
  fi
}

nemoclaw_e2e_hosted_inference_base_url() {
  if nemoclaw_e2e_using_compatible_inference; then
    printf '%s' "${NEMOCLAW_ENDPOINT_URL:-https://inference-api.nvidia.com/v1}"
  else
    printf '%s' "https://inference-api.nvidia.com/v1"
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
  local base_url key
  base_url="$(nemoclaw_e2e_hosted_inference_base_url)"
  key="$(nemoclaw_e2e_hosted_inference_key)"

  if nemoclaw_e2e_using_compatible_inference; then
    local model payload
    model="$(nemoclaw_e2e_hosted_inference_model)"
    payload=$(
      printf '{"model":"%s","messages":[{"role":"user","content":"Respond with OK."}],"temperature":0,"max_tokens":8}' "$model"
    )
    curl -sf --max-time 30 \
      -X POST "${base_url}/chat/completions" \
      -H "Authorization: Bearer $key" \
      -H "Content-Type: application/json" \
      -d "$payload" >/dev/null 2>&1
    return $?
  fi

  curl -sf --max-time 10 \
    -H "Authorization: Bearer $key" \
    "${base_url}/models" >/dev/null 2>&1
}

nemoclaw_e2e_require_hosted_inference_key() {
  local key
  key="$(nemoclaw_e2e_hosted_inference_key)"

  if nemoclaw_e2e_using_compatible_inference; then
    if [ -n "$key" ]; then
      pass "COMPATIBLE_API_KEY is set for CI compatible inference"
    else
      fail "COMPATIBLE_API_KEY not set — required for CI compatible inference"
      return 1
    fi
    return 0
  fi

  if [ -n "$key" ] && [[ "$key" == nvapi-* ]]; then
    pass "NVIDIA_INFERENCE_API_KEY is set (starts with nvapi-)"
  else
    fail "NVIDIA_INFERENCE_API_KEY not set or invalid — required for live inference"
    return 1
  fi
}
