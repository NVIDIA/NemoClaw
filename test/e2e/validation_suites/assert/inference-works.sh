#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Inference round-trip assertion.
#
# Verifies that an OpenAI-compatible endpoint answers a `chat/completions`
# request with a well-shaped response. Used both against the real gateway
# and against `fake-openai.sh` for deterministic fast-mode parity runs.
#
# Usage:
#   e2e_assert_inference_works <base-url> [--model <name>] [--api-key <key>]
#
# Exits 0 on success. On failure, prints a FAIL: line and returns non-zero
# (does NOT call e2e_fail so callers can decide whether to abort the step).

_E2E_INF_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../runtime/lib" && pwd)"
# shellcheck source=../../runtime/lib/env.sh
. "${_E2E_INF_LIB_DIR}/env.sh"

e2e_assert_inference_works() {
  local base_url="${1:-}"
  if [[ -z "${base_url}" ]]; then
    echo "FAIL: e2e_assert_inference_works: missing base URL" >&2
    return 2
  fi
  shift
  local model="fake-model"
  local api_key=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --model)
        model="${2:?value required}"
        shift 2
        ;;
      --api-key)
        api_key="${2:?value required}"
        shift 2
        ;;
      *)
        echo "e2e_assert_inference_works: unknown arg: $1" >&2
        return 2
        ;;
    esac
  done

  e2e_env_trace "assert:inference-works" "${base_url}" "model=${model}"

  local url="${base_url%/}/v1/chat/completions"
  local body
  body='{"model":"'"${model}"'","messages":[{"role":"user","content":"ping"}]}'
  local curl_args=(-fsS --max-time 15 -H "Content-Type: application/json")
  if [[ -n "${api_key}" ]]; then
    curl_args+=(-H "Authorization: Bearer ${api_key}")
  fi
  local out
  if ! out="$(curl "${curl_args[@]}" -d "${body}" "${url}" 2>/dev/null)"; then
    echo "FAIL: inference round-trip to ${url} failed" >&2
    return 1
  fi
  # Minimal shape check: must contain a `choices` array with some content.
  if ! printf '%s' "${out}" | grep -q '"choices"'; then
    echo "FAIL: inference response missing 'choices' field: ${out}" >&2
    return 1
  fi
  if ! printf '%s' "${out}" | grep -q '"content"'; then
    echo "FAIL: inference response missing 'content' field: ${out}" >&2
    return 1
  fi
  return 0
}
