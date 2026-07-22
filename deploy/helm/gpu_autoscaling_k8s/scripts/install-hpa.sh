#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Install GPU HPA (DCGM → prometheus-adapter → gpu_utilization_percent).
# Script output is HPA-focused only; see ../README.md for full operations.
#
# Usage:
#   cd deploy/helm/gpu_autoscaling_k8s
#   ./scripts/install-hpa.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=hpa-common.sh
source "${SCRIPT_DIR}/hpa-common.sh"

NAMESPACE="${NAMESPACE:-nemoclaw-gpu}"
RELEASE="${RELEASE:-nemoclaw-gpu}"
MONITORING_NS="${MONITORING_NS:-monitoring}"
PROM_RELEASE="${PROM_RELEASE:-kube-prometheus}"
ADAPTER_RELEASE="${ADAPTER_RELEASE:-prometheus-adapter}"
DEPLOYMENT="${DEPLOYMENT:-$(RELEASE="${RELEASE}" CHART_NAME=nemoclaw-gpu hpa_common_agent_deployment)}"
HPA_NAME="${HPA_NAME:-${DEPLOYMENT}}"
HPA_VALUES="${HPA_VALUES:-${CHART_DIR}/values-step2-hpa.yaml}"
MIN_REPLICAS="${MIN_REPLICAS:-1}"
MAX_REPLICAS="${MAX_REPLICAS:-4}"
ROLLOUT_TIMEOUT="${ROLLOUT_TIMEOUT:-900}"
INFERENCE_MODEL="${INFERENCE_MODEL:-llama3.2:3b}"
GPU_TARGET="${GPU_TARGET:-40}"
PROM_HELM_TIMEOUT="${PROM_HELM_TIMEOUT:-25m}"
PROM_VALUES="${PROM_VALUES:-${CHART_DIR}/monitoring/kube-prometheus-microk8s.yaml}"
ADAPTER_VALUES="${ADAPTER_VALUES:-${CHART_DIR}/monitoring/prometheus-adapter-gpu-values.yaml}"

require_cmd kubectl
require_cmd helm

custom_metrics_ready() {
  kubectl get apiservice v1beta1.custom.metrics.k8s.io 2>/dev/null | grep -q True
}

prometheus_service_name() {
  local svc=""
  svc="$(kubectl get svc -n "${MONITORING_NS}" \
    -l 'app=kube-prometheus-stack-prometheus' \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  if [[ -z "${svc}" ]]; then
    svc="$(kubectl get svc -n "${MONITORING_NS}" -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' \
      | grep -E 'kube-prome-prometheus$' | head -1 || true)"
  fi
  [[ -n "${svc}" ]] || return 1
  printf '%s' "${svc}"
}

ensure_prometheus_stack() {
  helm repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null 2>&1 || true
  helm repo update prometheus-community >/dev/null 2>&1 || helm repo update >/dev/null 2>&1

  kubectl create namespace "${MONITORING_NS}" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

  if ! helm status "${PROM_RELEASE}" -n "${MONITORING_NS}" >/dev/null 2>&1; then
    helm upgrade --install "${PROM_RELEASE}" prometheus-community/kube-prometheus-stack \
      --namespace "${MONITORING_NS}" \
      --create-namespace \
      -f "${PROM_VALUES}" \
      --set prometheus.prometheusSpec.serviceMonitorSelectorNilUsesHelmValues=false \
      --set prometheus.prometheusSpec.podMonitorSelectorNilUsesHelmValues=false \
      --set prometheus.prometheusSpec.ruleSelectorNilUsesHelmValues=false \
      --timeout "${PROM_HELM_TIMEOUT}" \
      --wait >/dev/null 2>&1 || true
  fi

  kubectl wait --for=condition=ready pod \
    -l app.kubernetes.io/name=prometheus \
    -n "${MONITORING_NS}" \
    --timeout=600s >/dev/null 2>&1 || true

  kubectl apply -f "${CHART_DIR}/monitoring/dcgm-servicemonitor.yaml" >/dev/null

  PROM_SVC="$(prometheus_service_name)" || {
    echo "Prometheus not found — GPU HPA metric pipeline unavailable" >&2
    exit 1
  }
  PROM_URL="http://${PROM_SVC}.${MONITORING_NS}.svc"

  helm upgrade --install "${ADAPTER_RELEASE}" prometheus-community/prometheus-adapter \
    --namespace "${MONITORING_NS}" \
    -f "${ADAPTER_VALUES}" \
    --set "prometheus.url=${PROM_URL}" \
    --set prometheus.port=9090 \
    --wait --timeout 10m >/dev/null

  for _ in $(seq 1 36); do
    custom_metrics_ready && break
    sleep 5
  done
  custom_metrics_ready || {
    echo "custom.metrics.k8s.io not ready — HPA cannot use gpu_utilization_percent" >&2
    exit 1
  }
}

INFERENCE_MODEL="${INFERENCE_MODEL:-llama3.2:3b}"

helm_install() {
  hpa_common_gpu_helm_upgrade "${RELEASE}" "${CHART_DIR}" "${NAMESPACE}" "${HPA_VALUES}" \
    "${MIN_REPLICAS}" "${MAX_REPLICAS}" "${GPU_TARGET}" "${INFERENCE_MODEL}"
}

if command -v microk8s >/dev/null 2>&1; then
  microk8s enable gpu 2>/dev/null || true
  microk8s enable metrics-server 2>/dev/null || true
fi
for _ in $(seq 1 36); do
  kubectl get apiservice v1beta1.metrics.k8s.io 2>/dev/null | grep -q True && break
  sleep 5
done
kubectl get apiservice v1beta1.metrics.k8s.io 2>/dev/null | grep -q True || {
  echo "metrics-server not ready — CPU/memory HPA APIs unavailable" >&2
  exit 1
}
hpa_common_verify_gpu_nodes || exit 1
kubectl get pods -n gpu-operator-resources -l app=nvidia-dcgm-exporter 2>/dev/null | grep -q Running || {
  echo "nvidia-dcgm-exporter not running — GPU HPA metric unavailable" >&2
  exit 1
}

ensure_prometheus_stack

hpa_common_gpu_recreate_stale_workload "${NAMESPACE}" "${DEPLOYMENT}" "${DEPLOYMENT}"

helm_install
hpa_common_kick_deployment "${NAMESPACE}" "${DEPLOYMENT}" && helm_install || true

if ! hpa_common_wait_rollout "${DEPLOYMENT}" "${NAMESPACE}" "${ROLLOUT_TIMEOUT}"; then
  hpa_common_diagnose_rollout "${NAMESPACE}" "${DEPLOYMENT}"
  exit 1
fi

hpa_common_verify_hpa_bounds "${NAMESPACE}" "${DEPLOYMENT}" "${HPA_NAME}" "${MIN_REPLICAS}" "${MAX_REPLICAS}" || true
hpa_common_print_hpa "${NAMESPACE}"
