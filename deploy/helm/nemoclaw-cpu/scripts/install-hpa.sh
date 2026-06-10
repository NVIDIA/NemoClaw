#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Install CPU HPA (metrics-server). Output is HPA-focused only.
#
# Usage:
#   cd deploy/helm/nemoclaw-cpu
#   source ~/.nemoclaw/secrets.env
#   ./scripts/install-hpa.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=hpa-common.sh
source "${SCRIPT_DIR}/hpa-common.sh"

NAMESPACE="${NAMESPACE:-nemoclaw}"
RELEASE="${RELEASE:-nemoclaw}"
DEPLOYMENT="${DEPLOYMENT:-${RELEASE}-nemoclaw-cpu-agent}"
HPA_NAME="${HPA_NAME:-${DEPLOYMENT}}"
HPA_VALUES="${HPA_VALUES:-${CHART_DIR}/values-step2-hpa.yaml}"
MIN_REPLICAS="${MIN_REPLICAS:-1}"
MAX_REPLICAS="${MAX_REPLICAS:-7}"
ROLLOUT_TIMEOUT="${ROLLOUT_TIMEOUT:-300}"

require_cmd kubectl
require_cmd helm

if [[ -f "${HOME}/.nemoclaw/secrets.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${HOME}/.nemoclaw/secrets.env"
  set +a
fi

if [[ -z "${NVIDIA_INFERENCE_HUB_API_KEY:-}" ]]; then
  echo "Set NVIDIA_INFERENCE_HUB_API_KEY in ~/.nemoclaw/secrets.env" >&2
  exit 1
fi

helm_install() {
  helm upgrade --install "${RELEASE}" "${CHART_DIR}" \
    --namespace "${NAMESPACE}" \
    --create-namespace \
    --set namespace.create=false \
    -f "${HPA_VALUES}" \
    --set inference.apiKey="${NVIDIA_INFERENCE_HUB_API_KEY}" \
    --set loadTest.cpuSpinMs=0 \
    --set probes.readinessChecksInferenceHub=false \
    --set autoscaling.enabled=true \
    --set autoscaling.minReplicas="${MIN_REPLICAS}" \
    --set autoscaling.maxReplicas="${MAX_REPLICAS}" \
    >/dev/null
}

if command -v microk8s >/dev/null 2>&1; then
  microk8s enable metrics-server 2>/dev/null || true
fi
if ! kubectl get apiservice v1beta1.metrics.k8s.io 2>/dev/null | grep -q True; then
  for _ in $(seq 1 24); do
    kubectl get apiservice v1beta1.metrics.k8s.io 2>/dev/null | grep -q True && break
    sleep 5
  done
fi
kubectl get apiservice v1beta1.metrics.k8s.io 2>/dev/null | grep -q True || {
  echo "metrics-server not ready — CPU HPA unavailable" >&2
  exit 1
}

helm_install
hpa_common_kick_deployment "${NAMESPACE}" "${DEPLOYMENT}" && helm_install || true

if ! hpa_common_wait_rollout "${DEPLOYMENT}" "${NAMESPACE}" "${ROLLOUT_TIMEOUT}"; then
  hpa_common_diagnose_rollout "${NAMESPACE}" "${DEPLOYMENT}"
  exit 1
fi

hpa_common_verify_hpa_bounds "${NAMESPACE}" "${DEPLOYMENT}" "${HPA_NAME}" "${MIN_REPLICAS}" "${MAX_REPLICAS}" || true
hpa_common_print_hpa "${NAMESPACE}"
