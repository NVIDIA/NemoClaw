#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Tear down load-test Jobs and GPU agent pods, then helm upgrade idle baseline.
#
# Usage:
#   cd deploy/helm/gpu_autoscaling_k8s
#   ./scripts/hpa-reset.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=hpa-common.sh
source "${SCRIPT_DIR}/hpa-common.sh"
NAMESPACE="${NAMESPACE:-nemoclaw-gpu}"
RELEASE="${RELEASE:-nemoclaw-gpu}"
JOB_NAME="${JOB_NAME:-nemoclaw-gpu-hpa-load-test}"
DEPLOYMENT="${DEPLOYMENT:-$(RELEASE="${RELEASE}" CHART_NAME=nemoclaw-gpu hpa_common_agent_deployment)}"
HPA_NAME="${HPA_NAME:-${DEPLOYMENT}}"
REINSTALL_HELM="${REINSTALL_HELM:-1}"
SKIP_HELM="${SKIP_HELM:-0}"
DELETE_DEPLOYMENT="${DELETE_DEPLOYMENT:-0}"
DELETE_HPA="${DELETE_HPA:-0}"
RUN_LOAD_TEST="${RUN_LOAD_TEST:-0}"
HPA_VALUES="${HPA_VALUES:-${CHART_DIR}/values-step2-hpa.yaml}"
WAIT_ROLLOUT="${WAIT_ROLLOUT:-1}"
ROLLOUT_TIMEOUT="${ROLLOUT_TIMEOUT:-900}"
MIN_REPLICAS="${MIN_REPLICAS:-1}"
MAX_REPLICAS="${MAX_REPLICAS:-4}"
GPU_TARGET="${GPU_TARGET:-40}"
INFERENCE_MODEL="${INFERENCE_MODEL:-llama3.2:3b}"
SERVICE="${SERVICE:-$(RELEASE="${RELEASE}" CHART_NAME=nemoclaw-gpu hpa_common_agent_service)}"

require_cmd kubectl

if [[ "${SKIP_HELM}" != "1" ]] || [[ "${RUN_LOAD_TEST}" == "1" ]]; then
  require_cmd helm
fi

namespace_exists() {
  kubectl get namespace "${NAMESPACE}" >/dev/null 2>&1
}

clear_pod_finalizers() {
  local pod
  for pod in $(kubectl get pods -n "${NAMESPACE}" -o jsonpath='{.items[*].metadata.name}' 2>/dev/null); do
    [[ -z "${pod}" ]] && continue
    kubectl patch pod "${pod}" -n "${NAMESPACE}" -p '{"metadata":{"finalizers":null}}' --type=merge \
      >/dev/null 2>&1 || true
  done
}

if ! namespace_exists; then
  exit 0
fi

kubectl delete job "${JOB_NAME}" -n "${NAMESPACE}" --ignore-not-found --wait=false 2>/dev/null || true
kubectl delete configmap "${JOB_NAME}-scripts" -n "${NAMESPACE}" --ignore-not-found 2>/dev/null || true

if [[ "${DELETE_HPA}" == "1" ]]; then
  kubectl delete hpa "${HPA_NAME}" -n "${NAMESPACE}" --ignore-not-found --wait=false 2>/dev/null || true
  kubectl delete hpa -n "${NAMESPACE}" -l app.kubernetes.io/name=nemoclaw-gpu --ignore-not-found --wait=false 2>/dev/null || true
fi

if [[ "${DELETE_DEPLOYMENT}" == "1" ]]; then
  kubectl delete deployment "${DEPLOYMENT}" -n "${NAMESPACE}" --ignore-not-found --wait=false 2>/dev/null || true
fi

kubectl delete pods -n "${NAMESPACE}" --all --force --grace-period=0 2>/dev/null || true
sleep 2
clear_pod_finalizers
kubectl delete pods -n "${NAMESPACE}" --all --force --grace-period=0 2>/dev/null || true

kubectl delete rs -n "${NAMESPACE}" -l app.kubernetes.io/name=nemoclaw-gpu --ignore-not-found --wait=false 2>/dev/null || true
hpa_common_clear_stuck_pods "${NAMESPACE}"

if [[ "${SKIP_HELM}" == "1" ]]; then
  hpa_common_print_hpa "${NAMESPACE}"
  exit 0
fi

if [[ "${DELETE_HPA}" == "1" ]]; then
  if ! hpa_common_ensure_agent_ready "${NAMESPACE}" "${RELEASE}" "${CHART_DIR}" \
    "${HPA_VALUES}" "${ROLLOUT_TIMEOUT}"; then
    echo "HPA reset failed — baseline pod not ready" >&2
    exit 1
  fi
fi

hpa_common_gpu_recreate_stale_workload "${NAMESPACE}" "${DEPLOYMENT}" "${SERVICE}"

hpa_common_gpu_helm_upgrade "${RELEASE}" "${CHART_DIR}" "${NAMESPACE}" "${HPA_VALUES}" \
  "${MIN_REPLICAS}" "${MAX_REPLICAS}" "${GPU_TARGET}" "${INFERENCE_MODEL}"

hpa_common_kick_deployment "${NAMESPACE}" "${DEPLOYMENT}" || hpa_common_gpu_helm_upgrade "${RELEASE}" "${CHART_DIR}" "${NAMESPACE}" "${HPA_VALUES}" \
  "${MIN_REPLICAS}" "${MAX_REPLICAS}" "${GPU_TARGET}" "${INFERENCE_MODEL}"

hpa_common_verify_hpa_bounds "${NAMESPACE}" "${DEPLOYMENT}" "${HPA_NAME}" "${MIN_REPLICAS}" "${MAX_REPLICAS}" || true

if [[ "${WAIT_ROLLOUT}" == "1" ]]; then
  hpa_common_wait_rollout "${DEPLOYMENT}" "${NAMESPACE}" "${ROLLOUT_TIMEOUT}" \
    || hpa_common_diagnose_rollout "${NAMESPACE}" "${DEPLOYMENT}"
fi

hpa_common_print_hpa "${NAMESPACE}"

if [[ "${RUN_LOAD_TEST}" == "1" ]]; then
  exec "${SCRIPT_DIR}/hpa-load-test.sh"
fi
