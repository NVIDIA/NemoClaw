#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# OPTIONAL: Prometheus + prometheus-adapter + performance HPA (heavy; may timeout on small VMs).
# For the default path (metrics-server CPU HPA), use: ./scripts/install-hpa.sh
#
# Install Prometheus + prometheus-adapter + nemoclaw-cpu with performance HPA.
# One agent pod per CPU; scales on nemoclaw_http_inflight_requests (min 1, max 7 default).
#
# Usage:
#   cd deploy/helm/nemoclaw-cpu
#   source ~/.nemoclaw/secrets.env
#   ./scripts/install-performance-hpa.sh

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

log() { hpa_common_log "$*"; }

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

log "Step 1: metrics-server (optional but useful for kubectl top)"
if command -v microk8s >/dev/null 2>&1; then
  microk8s enable metrics-server 2>/dev/null || true
fi

log "Step 2: Prometheus + Grafana (kube-prometheus-stack)"
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null 2>&1 || true
helm repo update prometheus-community >/dev/null 2>&1 || helm repo update

kubectl create namespace "${MONITORING_NS}" --dry-run=client -o yaml | kubectl apply -f -

if helm_release_failed "${PROM_RELEASE}" "${MONITORING_NS}"; then
  log "Previous ${PROM_RELEASE} install failed — removing before retry"
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

if helm status "${PROM_RELEASE}" -n "${MONITORING_NS}" >/dev/null 2>&1; then
  log "Upgrading existing ${PROM_RELEASE} (timeout ${PROM_HELM_TIMEOUT})"
  if ! helm "${PROM_HELM_ARGS[@]}" --wait; then
    log "Helm --wait timed out; continuing if core pods exist (re-run script to retry)"
  fi
else
  log "Installing ${PROM_RELEASE} (slim MicroK8s values; first run may take 10–20 min to pull images)"
  log "Using timeout ${PROM_HELM_TIMEOUT} — increase with PROM_HELM_TIMEOUT=35m if needed"
  if ! helm "${PROM_HELM_ARGS[@]}" --wait; then
    log "Helm --wait failed or timed out — checking for running pods..."
    if ! kubectl get pods -n "${MONITORING_NS}" -l app.kubernetes.io/name=prometheus-operator 2>/dev/null | grep -q Running; then
      echo "Prometheus stack did not come up. Try: PROM_HELM_TIMEOUT=35m ./scripts/install-performance-hpa.sh" >&2
      kubectl get pods -n "${MONITORING_NS}" 2>/dev/null || true
      exit 1
    fi
    log "Operator/prometheus still starting; waiting with kubectl..."
  fi
fi

log "Waiting for Prometheus Operator..."
kubectl wait --for=condition=ready pod \
  -l app.kubernetes.io/name=prometheus-operator \
  -n "${MONITORING_NS}" \
  --timeout=600s 2>/dev/null || log "prometheus-operator wait skipped (label may differ)"

log "Waiting for Prometheus server pod..."
kubectl wait --for=condition=ready pod \
  -l app.kubernetes.io/name=prometheus \
  -n "${MONITORING_NS}" \
  --timeout=600s

PROM_SVC="$(kubectl get svc -n "${MONITORING_NS}" \
  -l app.kubernetes.io/name=prometheus,app.kubernetes.io/component=server \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
if [[ -z "${PROM_SVC}" ]]; then
  PROM_SVC="$(kubectl get svc -n "${MONITORING_NS}" -o name | grep prometheus | head -1 | sed 's|service/||')"
fi
if [[ -z "${PROM_SVC}" ]]; then
  echo "Could not find Prometheus service in ${MONITORING_NS}" >&2
  kubectl get svc -n "${MONITORING_NS}"
  exit 1
fi
PROM_URL="http://${PROM_SVC}.${MONITORING_NS}.svc"
log "Prometheus URL: ${PROM_URL}:9090"

log "Step 3: prometheus-adapter (custom metrics API for HPA)"
helm upgrade --install "${ADAPTER_RELEASE}" prometheus-community/prometheus-adapter \
  --namespace "${MONITORING_NS}" \
  -f "${CHART_DIR}/monitoring/prometheus-adapter-values.yaml" \
  --set "prometheus.url=${PROM_URL}" \
  --set prometheus.port=9090 \
  --wait --timeout 10m

log "Waiting for custom.metrics.k8s.io API..."
for _ in $(seq 1 30); do
  if kubectl get apiservice v1beta1.custom.metrics.k8s.io 2>/dev/null | grep -q True; then
    break
  fi
  sleep 5
done
kubectl get apiservice v1beta1.custom.metrics.k8s.io || {
  echo "custom.metrics.k8s.io not ready — check prometheus-adapter logs" >&2
  exit 1
}

log "Step 4: nemoclaw agents (1 CPU/pod, performance HPA)"
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
  --set "metrics.serviceMonitor.labels.release=${PROM_RELEASE}"

DEPLOYMENT="$(RELEASE="${RELEASE}" hpa_common_agent_deployment)"
hpa_common_verify_hpa_bounds "${NAMESPACE}" "${DEPLOYMENT}" "${DEPLOYMENT}" "${MIN_REPLICAS}" "${MAX_REPLICAS}" || true

log "Step 5: status"
kubectl get hpa,deploy,pods,svc -n "${NAMESPACE}"
kubectl get servicemonitor -n "${NAMESPACE}" 2>/dev/null || true

cat <<EOF

Installed:
  • Prometheus/Grafana: namespace ${MONITORING_NS} (release ${PROM_RELEASE})
  • prometheus-adapter: ${ADAPTER_RELEASE}
  • nemoclaw agents:  ${NAMESPACE} (HPA on nemoclaw_http_inflight_requests, min=${MIN_REPLICAS} max=${MAX_REPLICAS})

Verify metrics in Prometheus (after traffic):
  kubectl port-forward -n ${MONITORING_NS} svc/${PROM_SVC} 9090:9090
  # open http://127.0.0.1:9090 → query: nemoclaw_http_inflight_requests

Verify custom metric API:
  kubectl get --raw "/apis/custom.metrics.k8s.io/v1beta1/namespaces/${NAMESPACE}/pods/*/nemoclaw_http_inflight_requests" | head

Grafana:
  kubectl port-forward -n ${MONITORING_NS} svc/${PROM_RELEASE}-grafana 3000:80
  # user admin — password:
  kubectl get secret -n ${MONITORING_NS} ${PROM_RELEASE}-grafana -o jsonpath='{.data.admin-password}' | base64 -d; echo

Load test (optional):
  ./scripts/hpa-reset.sh && ./scripts/hpa-load-test.sh

EOF
