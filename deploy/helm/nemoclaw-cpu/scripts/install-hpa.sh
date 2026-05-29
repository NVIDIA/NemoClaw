#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# One-command install: metrics-server + nemoclaw-cpu with CPU-based HPA.
# One Nemoclaw agent pod per CPU (min 1, max 7). No Prometheus required.
#
# Usage:
#   cd deploy/helm/nemoclaw-cpu
#   source ~/.nemoclaw/secrets.env
#   ./scripts/install-hpa.sh
#
# If rollout keeps failing: ./scripts/cluster-recover.sh

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

log() { hpa_common_log "$*"; }

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
    --set autoscaling.maxReplicas="${MAX_REPLICAS}"
}

log "Step 1: metrics-server (required for CPU HPA)"
if command -v microk8s >/dev/null 2>&1; then
  microk8s enable metrics-server 2>/dev/null || true
fi
if ! kubectl get apiservice v1beta1.metrics.k8s.io 2>/dev/null | grep -q True; then
  echo "Waiting for metrics-server..." >&2
  for _ in $(seq 1 24); do
    kubectl get apiservice v1beta1.metrics.k8s.io 2>/dev/null | grep -q True && break
    sleep 5
  done
fi
kubectl get apiservice v1beta1.metrics.k8s.io 2>/dev/null | grep -q True || {
  echo "metrics-server not ready. Run: microk8s enable metrics-server" >&2
  exit 1
}

log "Step 2: install agents + CPU HPA (readiness=/healthz; min=${MIN_REPLICAS} max=${MAX_REPLICAS})"
helm_install
hpa_common_kick_deployment "${NAMESPACE}" "${DEPLOYMENT}" && helm_install || true

if ! hpa_common_wait_rollout "${DEPLOYMENT}" "${NAMESPACE}" "${ROLLOUT_TIMEOUT}"; then
  log "Rollout failed"
  hpa_common_diagnose_rollout "${NAMESPACE}" "${DEPLOYMENT}"
  cat <<EOF >&2

Try full recovery:
  ./scripts/cluster-recover.sh

Or:
  DELETE_DEPLOYMENT=1 DELETE_HPA=1 ./scripts/hpa-reset.sh

Verify Inference Hub after pods run:
  kubectl port-forward -n ${NAMESPACE} svc/${RELEASE}-nemoclaw-cpu-agent 8080:8080
  curl -s http://127.0.0.1:8080/readyz

EOF
  exit 1
fi

hpa_common_verify_hpa_bounds "${NAMESPACE}" "${DEPLOYMENT}" "${HPA_NAME}" "${MIN_REPLICAS}" "${MAX_REPLICAS}" || true

log "Step 3: status"
kubectl get hpa -n "${NAMESPACE}" 2>/dev/null || true
kubectl get deploy,pods -n "${NAMESPACE}" -l app.kubernetes.io/name=nemoclaw-cpu 2>/dev/null || true

cat <<EOF

Installed (CPU HPA — metrics-server only).
Readiness uses /healthz so rollout succeeds; chat still needs a valid Inference Hub key.

Watch:  kubectl get hpa -n ${NAMESPACE} -w && kubectl get pods -n ${NAMESPACE} -w
Hub OK: kubectl port-forward -n ${NAMESPACE} svc/${RELEASE}-nemoclaw-cpu-agent 8080:8080 && curl -s http://127.0.0.1:8080/readyz
Test:   ./scripts/hpa-load-test.sh
Recover: ./scripts/cluster-recover.sh

EOF
