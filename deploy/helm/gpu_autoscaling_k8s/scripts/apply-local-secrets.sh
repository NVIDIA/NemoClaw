#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Read gitignored secrets.env and create Kubernetes Secrets. NGC_API_KEY is the
# nvcr.io pull credential: it becomes dockerconfigjson Secret ngc-registry
# (kubelet image pull) and Opaque Secret nim-ngc-key (NIM in-container NGC_API_KEY).
# vLLM only uses ngc-registry. Optional HF_TOKEN becomes Opaque Secret hf-token.
#
# Usage:
#   cd deploy/helm/gpu_autoscaling_k8s
#   # paste NGC_API_KEY=nvapi-... into secrets.env first
#   ./scripts/apply-local-secrets.sh
#   ./scripts/apply-local-secrets.sh --replace

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SECRETS_FILE="${CHART_DIR}/secrets.env"
NAMESPACE="${NAMESPACE:-nemoclaw-gpu}"
REPLACE_ARGS=()

case "${1:-}" in
  "") ;;
  --replace) REPLACE_ARGS=(--replace) ;;
  -h | --help)
    sed -n '1,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *)
    echo "Usage: $0 [--replace]" >&2
    exit 2
    ;;
esac

[[ -f "${SECRETS_FILE}" ]] || {
  echo "ERROR: missing ${SECRETS_FILE}. Copy secrets.env.example to secrets.env and paste NGC_API_KEY." >&2
  exit 1
}

# shellcheck disable=SC1090
source "${SECRETS_FILE}"

[[ -n "${NGC_API_KEY:-}" ]] || {
  echo "ERROR: NGC_API_KEY is empty in secrets.env. Paste the nvapi- key (used to pull nvcr.io images)." >&2
  exit 1
}

export NGC_API_KEY
export NAMESPACE
"${SCRIPT_DIR}/create-nim-ngc-secrets.sh" "${REPLACE_ARGS[@]+"${REPLACE_ARGS[@]}"}"

if [[ -n "${HF_TOKEN:-}" ]]; then
  kubectl create secret generic hf-token \
    --namespace "${NAMESPACE}" \
    --from-file=HF_TOKEN=<(printf '%s' "${HF_TOKEN}") \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  echo "Created/updated Opaque Secret hf-token (key HF_TOKEN) in ${NAMESPACE}"
  echo "Set export VLLM_HF_TOKEN_SECRET=hf-token in gitignored local.env if the vLLM model is gated."
fi

unset NGC_API_KEY HF_TOKEN
echo "vLLM image pull: VLLM_IMAGE_PULL_SECRET=ngc-registry (from NGC_API_KEY)."
echo "Do not commit secrets.env."
