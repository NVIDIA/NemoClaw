#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Install two copies of this chart: vLLM for Hermes and Ollama for OpenClaw.
# Each Horizontal Pod Autoscaler ceiling is MAX_REPLICAS (default 8). The
# node still has one pool of GPUs. A pod that does not fit stays Pending.
#
#   DCGM_NAMESPACE=gpu-operator ./scripts/install-two-runtimes.sh
#
# Leaves the existing nemoclaw-gpu release in place.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=hpa-common.sh
source "${SCRIPT_DIR}/hpa-common.sh"
# shellcheck source=agent-common.sh
source "${SCRIPT_DIR}/agent-common.sh"

MAX_REPLICAS="${MAX_REPLICAS:-8}"
DCGM_NAMESPACE="${DCGM_NAMESPACE:-gpu-operator}"
VLLM_RELEASE="${VLLM_RELEASE:-nemoclaw-gpu-vllm}"
OLLAMA_RELEASE="${OLLAMA_RELEASE:-nemoclaw-gpu-ollama}"

install_one() {
  local release="${1:?release}"
  local runtime="${2:?runtime}"
  local skip_monitoring="${3:?skip}"
  echo "Installing ${release} runtime=${runtime} maxReplicas=${MAX_REPLICAS}"
  RELEASE="${release}" \
    NAMESPACE="${release}" \
    INFERENCE_RUNTIME="${runtime}" \
    MAX_REPLICAS="${MAX_REPLICAS}" \
    HPA_SHARED_GPU_CEILING=1 \
    ENABLE_ENVOY_LB=1 \
    SKIP_MONITORING="${skip_monitoring}" \
    DCGM_NAMESPACE="${DCGM_NAMESPACE}" \
    "${SCRIPT_DIR}/install-hpa.sh"
}

service_url() {
  local release="${1:?release}"
  local service
  service="$(RELEASE="${release}" CHART_NAME=nemoclaw-gpu hpa_common_metrics_proxy_service)"
  printf 'http://%s.%s.svc.cluster.local:8081/v1\n' "${service}" "${release}"
}

install_one "${VLLM_RELEASE}" vllm 0
install_one "${OLLAMA_RELEASE}" ollama 1

echo "Hermes inference: $(service_url "${VLLM_RELEASE}")"
echo "OpenClaw inference: $(service_url "${OLLAMA_RELEASE}")"
echo "Each ceiling is maxReplicas=${MAX_REPLICAS}. Idle replicas still hold their GPUs until that runtime scales down."
