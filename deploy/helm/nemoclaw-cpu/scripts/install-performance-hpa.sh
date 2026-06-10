#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# OPTIONAL: performance HPA (inflight requests). Output is HPA-focused only.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=hpa-common.sh
source "${SCRIPT_DIR}/hpa-common.sh"

NAMESPACE="${NAMESPACE:-nemoclaw}"
RELEASE="${RELEASE:-nemoclaw}"
MONITORING_NS="${MONITORING_NS:-monitoring}"
PROM_RELEASE="${PROM_RELEASE:-kube-prometheus}"
ADAPTER_RELEASE="${ADAPTER_RELEASE:-prometheus-adapter}"
MAX_REPLICAS="${MAX_REPLICAS:-7}"
MIN_REPLICAS="${MIN_REPLICAS:-1}"
INFLIGHT_TARGET="${INFLIGHT_TARGET:-10}"
PROM_HELM_TIMEOUT="${PROM_HELM_TIMEOUT:-25m}"
PROM_VALUES="${PROM_VALUES:-${CHART_DIR}/monitoring/kube-prometheus-microk8s.yaml}"

helm_release_failed() {
  local rel="${1:?}" ns="${2:?}"
  local st
  st="$(helm status "${rel}" -n "${ns}" -o json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('info',{}).get('status',''))" 2>/dev/null || true)"
  [[ "${st}" == "failed" ]]
}

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

if command -v microk8s >/dev/null 2>&1; then
  microk8s enable metrics-server 2>/dev/null || true
fi

helm repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null 2>&1 || true
helm repo update prometheus-community >/dev/null 2>&1 || helm repo update >/dev/null 2>&1

kubectl create namespace "${MONITORING_NS}" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

if helm_release_failed "${PROM_RELEASE}" "${MONITORING_NS}"; then
  helm uninstall "${PROM_RELEASE}" -n "${MONITORING_NS}" --wait --timeout 5m 2>/dev/null || true
fi

PROM_HELM_ARGS=(
  upgrade --install "${PROM_RELEASE}" prometheus-community/kube-prometheus-stack
  --namespace "${MONITORING_NS}"
  --create-namespace
  -f "${PROM_VALUES}"
  --set prometheus.prometheusSpec.serviceMonitorSelectorNilUsesHelmValues=false
  --set prometheus.prometheusSpec.podMonitorSelectorNilUsesHelmValues=false
  --set prometheus.prometheusSpec.ruleSelectorNilUsesHelmValues=false
  --timeout "${PROM_HELM_TIMEOUT}"
)

helm "${PROM_HELM_ARGS[@]}" --wait >/dev/null 2>&1 || {
  if ! kubectl get pods -n "${MONITORING_NS}" -l app.kubernetes.io/name=prometheus-operator 2>/dev/null | grep -q Running; then
    echo "Prometheus stack did not come up — performance HPA metrics unavailable" >&2
    exit 1
  fi
}

kubectl wait --for=condition=ready pod \
  -l app.kubernetes.io/name=prometheus-operator \
  -n "${MONITORING_NS}" \
  --timeout=600s >/dev/null 2>&1 || true

kubectl wait --for=condition=ready pod \
  -l app.kubernetes.io/name=prometheus \
  -n "${MONITORING_NS}" \
  --timeout=600s >/dev/null 2>&1 || true

PROM_SVC="$(kubectl get svc -n "${MONITORING_NS}" \
  -l app.kubernetes.io/name=prometheus,app.kubernetes.io/component=server \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
if [[ -z "${PROM_SVC}" ]]; then
  PROM_SVC="$(kubectl get svc -n "${MONITORING_NS}" -o name | grep prometheus | head -1 | sed 's|service/||')"
fi
if [[ -z "${PROM_SVC}" ]]; then
  echo "Prometheus not found — performance HPA metrics unavailable" >&2
  exit 1
fi
PROM_URL="http://${PROM_SVC}.${MONITORING_NS}.svc"

helm upgrade --install "${ADAPTER_RELEASE}" prometheus-community/prometheus-adapter \
  --namespace "${MONITORING_NS}" \
  -f "${CHART_DIR}/monitoring/prometheus-adapter-values.yaml" \
  --set "prometheus.url=${PROM_URL}" \
  --set prometheus.port=9090 \
  --wait --timeout 10m >/dev/null

for _ in $(seq 1 30); do
  kubectl get apiservice v1beta1.custom.metrics.k8s.io 2>/dev/null | grep -q True && break
  sleep 5
done
kubectl get apiservice v1beta1.custom.metrics.k8s.io >/dev/null 2>&1 || {
  echo "custom.metrics.k8s.io not ready — performance HPA unavailable" >&2
  exit 1
}

hpa_common_ensure_agent_ready "${NAMESPACE}" "${RELEASE}" "${CHART_DIR}" \
  "${NVIDIA_INFERENCE_HUB_API_KEY}" "${CHART_DIR}/values-step2-hpa-performance.yaml" 300

helm upgrade --install "${RELEASE}" "${CHART_DIR}" \
  --namespace "${NAMESPACE}" \
  --create-namespace \
  --set namespace.create=false \
  -f "${CHART_DIR}/values-step2-hpa-performance.yaml" \
  --set inference.apiKey="${NVIDIA_INFERENCE_HUB_API_KEY}" \
  --set autoscaling.enabled=true \
  --set autoscaling.minReplicas="${MIN_REPLICAS}" \
  --set autoscaling.maxReplicas="${MAX_REPLICAS}" \
  --set "autoscaling.performance.inflightRequestsPerPod=${INFLIGHT_TARGET}" \
  --set metrics.serviceMonitor.enabled=true \
  --set "metrics.serviceMonitor.labels.release=${PROM_RELEASE}" \
  >/dev/null

DEPLOYMENT="$(RELEASE="${RELEASE}" hpa_common_agent_deployment)"
hpa_common_verify_hpa_bounds "${NAMESPACE}" "${DEPLOYMENT}" "${DEPLOYMENT}" "${MIN_REPLICAS}" "${MAX_REPLICAS}" || true

hpa_common_print_hpa "${NAMESPACE}"
