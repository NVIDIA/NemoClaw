#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage:
  probe_remote_models.sh <base-url> [expected-model-id]

Probes <base-url>/v1/models for an OpenAI-compatible remote LLM/VLM endpoint.
If REMOTE_API_KEY is set, it is sent as a Bearer token.

Examples:
  REMOTE_API_KEY="$NVIDIA_API_KEY" probe_remote_models.sh \
    https://integrate.api.nvidia.com nvidia/llama-3.3-nemotron-super-49b-v1

  probe_remote_models.sh \
    http://localhost:30081 nvidia/nvidia-nemotron-nano-9b-v2-dgx-spark
EOF

  return 0
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ "$#" -lt 1 || "$#" -gt 2 ]]; then
  usage
  exit 1
fi

for dep in curl jq; do
  if ! command -v "$dep" >/dev/null 2>&1; then
    echo "ERROR: required command not found: $dep" >&2
    exit 1
  fi
done

base_url="${1%/}"
base_url="${base_url%/v1/models}"
base_url="${base_url%/v1}"
expected_model="${2:-}"
curl_args=(-sf)

if [[ -n "${REMOTE_API_KEY:-}" ]]; then
  curl_args+=(-H "Authorization: Bearer ${REMOTE_API_KEY}")
fi

models_json="$(curl "${curl_args[@]}" "${base_url}/v1/models")" \
  || { echo "ERROR: remote endpoint failed: ${base_url}/v1/models" >&2; exit 1; }

model_count="$(printf '%s\n' "$models_json" | jq -r \
  'if type == "object" and ((.data? | type) == "array") then ([.data[]? | select(.id? != null)] | length) elif type == "object" and (.id? != null) then 1 else 0 end' 2>/dev/null)" \
  || {
    echo "ERROR: remote endpoint did not return JSON from: ${base_url}/v1/models" >&2
    exit 1
  }

if [[ ! "$model_count" =~ ^[0-9]+$ || "$model_count" -lt 1 ]]; then
  echo "ERROR: remote endpoint did not advertise any models: ${base_url}/v1/models" >&2
  exit 1
fi

if [[ -z "$expected_model" && "${model_count:-0}" -gt 1 ]]; then
  echo "ERROR: remote endpoint advertises multiple models; ask the user to choose one:" >&2
  echo "$models_json" | jq -r \
    'if (.data? | type) == "array" then .data[]?.id elif .id? != null then .id else empty end' \
    | sed 's/^/  /' >&2
  exit 2
fi

if [[ -n "$expected_model" ]]; then
  echo "$models_json" | jq -e --arg model "$expected_model" \
    '(.id == $model) or any(.data[]?; .id == $model)' >/dev/null \
    || {
      echo "ERROR: remote endpoint does not advertise model: $expected_model" >&2
      echo "Advertised models:" >&2
      echo "$models_json" | jq -r \
        'if (.data? | type) == "array" then .data[]?.id elif .id? != null then .id else empty end' \
        | sed 's/^/  /' >&2
      exit 1
    }
fi

echo "remote endpoint OK: ${base_url}"
