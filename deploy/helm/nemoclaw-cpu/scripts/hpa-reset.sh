#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Tear down load-test Jobs and agent pods, then helm upgrade idle baseline.
# Keeps HPA and Deployment by default (only deletes pods + stale ReplicaSets).
#
# Usage:
#   cd deploy/helm/nemoclaw-cpu
#   source ~/.nemoclaw/secrets.env
#   ./scripts/hpa-reset.sh
#
# Env:
#   NAMESPACE=nemoclaw RELEASE=nemoclaw JOB_NAME=nemoclaw-hpa-load-test
#   REINSTALL_HELM=1          # helm upgrade after cleanup (default 1)
#   HPA_VALUES=values-step2-hpa.yaml   # idle baseline; load-test script applies saturate overlay
#   SKIP_HELM=1               # only kubectl cleanup, no helm
#   DELETE_DEPLOYMENT=0       # set 1 to delete Deployment before helm reinstall (stuck clusters)
#   DELETE_HPA=0              # set 1 to delete HPA before reinstall (desiredReplicas=0 deadlock)
#   RUN_LOAD_TEST=0           # set 1 to run ./scripts/hpa-load-test.sh after reset

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=hpa-common.sh
source "${SCRIPT_DIR}/hpa-common.sh"
NAMESPACE="${NAMESPACE:-nemoclaw}"
RELEASE="${RELEASE:-nemoclaw}"
JOB_NAME="${JOB_NAME:-nemoclaw-hpa-load-test}"
DEPLOYMENT="${DEPLOYMENT:-${RELEASE}-nemoclaw-cpu-agent}"
HPA_NAME="${HPA_NAME:-${DEPLOYMENT}}"
REINSTALL_HELM="${REINSTALL_HELM:-1}"
SKIP_HELM="${SKIP_HELM:-0}"
DELETE_DEPLOYMENT="${DELETE_DEPLOYMENT:-0}"
DELETE_HPA="${DELETE_HPA:-0}"
RUN_LOAD_TEST="${RUN_LOAD_TEST:-0}"
HPA_VALUES="${HPA_VALUES:-${CHART_DIR}/values-step2-hpa.yaml}"
WAIT_ROLLOUT="${WAIT_ROLLOUT:-1}"
ROLLOUT_TIMEOUT="${ROLLOUT_TIMEOUT:-300}"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

require_cmd kubectl

if [[ "${SKIP_HELM}" != "1" ]] || [[ "${RUN_LOAD_TEST}" == "1" ]]; then
  require_cmd helm
fi

if [[ -f "${HOME}/.nemoclaw/secrets.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${HOME}/.nemoclaw/secrets.env"
  set +a
fi

if [[ "${SKIP_HELM}" != "1" ]] && [[ -z "${NVIDIA_INFERENCE_HUB_API_KEY:-}" ]]; then
  echo "Set NVIDIA_INFERENCE_HUB_API_KEY or add it to ~/.nemoclaw/secrets.env" >&2
  exit 1
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

log "=== nemoclaw reset (namespace=${NAMESPACE}) ==="

if ! namespace_exists; then
  log "Namespace ${NAMESPACE} does not exist — nothing to clean."
  exit 0
fi

log "Step 1: delete load-test Jobs and ConfigMaps"
kubectl delete job -n "${NAMESPACE}" -l "job-name=${JOB_NAME}" --ignore-not-found --wait=false 2>/dev/null || true
kubectl delete job "${JOB_NAME}" -n "${NAMESPACE}" --ignore-not-found --wait=false 2>/dev/null || true
kubectl delete configmap "${JOB_NAME}-scripts" -n "${NAMESPACE}" --ignore-not-found 2>/dev/null || true

if [[ "${DELETE_HPA}" == "1" ]]; then
  log "Step 2: delete HPA (DELETE_HPA=1)"
  kubectl delete hpa "${HPA_NAME}" -n "${NAMESPACE}" --ignore-not-found --wait=false 2>/dev/null || true
  kubectl delete hpa -n "${NAMESPACE}" -l app.kubernetes.io/name=nemoclaw-cpu --ignore-not-found --wait=false 2>/dev/null || true
else
  log "Step 2: keep HPA"
fi

if [[ "${DELETE_DEPLOYMENT}" == "1" ]]; then
  log "Step 3: delete Deployment ${DEPLOYMENT}"
  kubectl delete deployment "${DEPLOYMENT}" -n "${NAMESPACE}" --ignore-not-found --wait=false 2>/dev/null || true
else
  log "Step 3: keep Deployment (do not scale to 0 — HPA minReplicas is 1)"
fi

log "Step 4: force-delete all pods in ${NAMESPACE}"
kubectl delete pods -n "${NAMESPACE}" --all --force --grace-period=0 2>/dev/null || true
sleep 2
clear_pod_finalizers
kubectl delete pods -n "${NAMESPACE}" --all --force --grace-period=0 2>/dev/null || true

log "Step 5: remove old ReplicaSets"
kubectl delete rs -n "${NAMESPACE}" -l app.kubernetes.io/name=nemoclaw-cpu --ignore-not-found --wait=false 2>/dev/null || true
hpa_common_clear_stuck_pods "${NAMESPACE}"

if [[ "${SKIP_HELM}" == "1" ]]; then
  log "SKIP_HELM=1 — kubectl cleanup only."
  kubectl get deploy,hpa,pods -n "${NAMESPACE}" 2>/dev/null || true
  log "Done. Run helm upgrade or ./scripts/hpa-load-test.sh when ready."
  exit 0
fi

MIN_REPLICAS="${MIN_REPLICAS:-1}"
MAX_REPLICAS="${MAX_REPLICAS:-7}"

if [[ "${DELETE_HPA}" == "1" ]]; then
  log "Step 6a: start one agent pod (HPA off — recovery after DELETE_HPA=1)"
  if ! hpa_common_ensure_agent_ready "${NAMESPACE}" "${RELEASE}" "${CHART_DIR}" \
    "${NVIDIA_INFERENCE_HUB_API_KEY}" "${HPA_VALUES}" "${ROLLOUT_TIMEOUT}"; then
    log "Failed to start agent — try: DELETE_DEPLOYMENT=1 ./scripts/hpa-reset.sh"
    exit 1
  fi
  log "Step 6b: enable HPA (min=${MIN_REPLICAS}, max=${MAX_REPLICAS}, loadTest.cpuSpinMs=0)"
else
  log "Step 6: helm upgrade idle baseline (keep HPA, min=${MIN_REPLICAS}, max=${MAX_REPLICAS})"
fi

helm upgrade "${RELEASE}" "${CHART_DIR}" -n "${NAMESPACE}" \
  --reuse-values \
  -f "${HPA_VALUES}" \
  --set namespace.create=false \
  --set inference.apiKey="${NVIDIA_INFERENCE_HUB_API_KEY}" \
  --set loadTest.cpuSpinMs=0 \
  --set probes.readinessChecksInferenceHub=false \
  --set autoscaling.enabled=true \
  --set autoscaling.minReplicas="${MIN_REPLICAS}" \
  --set autoscaling.maxReplicas="${MAX_REPLICAS}"

hpa_common_kick_deployment "${NAMESPACE}" "${DEPLOYMENT}" || helm upgrade "${RELEASE}" "${CHART_DIR}" -n "${NAMESPACE}" \
  --reuse-values -f "${HPA_VALUES}" \
  --set namespace.create=false \
  --set inference.apiKey="${NVIDIA_INFERENCE_HUB_API_KEY}" \
  --set loadTest.cpuSpinMs=0 \
  --set probes.readinessChecksInferenceHub=false \
  --set autoscaling.enabled=true \
  --set autoscaling.minReplicas="${MIN_REPLICAS}" \
  --set autoscaling.maxReplicas="${MAX_REPLICAS}"

hpa_common_verify_hpa_bounds "${NAMESPACE}" "${DEPLOYMENT}" "${HPA_NAME}" "${MIN_REPLICAS}" "${MAX_REPLICAS}" || true

if [[ "${WAIT_ROLLOUT}" == "1" ]]; then
  if ! hpa_common_wait_rollout "${DEPLOYMENT}" "${NAMESPACE}" "${ROLLOUT_TIMEOUT}"; then
    hpa_common_diagnose_rollout "${NAMESPACE}" "${DEPLOYMENT}"
    log "Rollout failed — try: ./scripts/cluster-recover.sh"
  fi
fi

log "Step 7: status"
kubectl get hpa,deploy,pods -n "${NAMESPACE}" 2>/dev/null || true
kubectl top pods -n "${NAMESPACE}" 2>/dev/null | grep -E 'agent|NAME' || true

if [[ "${RUN_LOAD_TEST}" == "1" ]]; then
  log "Step 8: starting load test..."
  exec "${SCRIPT_DIR}/hpa-load-test.sh"
fi

cat <<EOF

Reset complete.

Next load test:
  cd ${CHART_DIR}
  source ~/.nemoclaw/secrets.env
  ./scripts/hpa-load-test.sh

Watch:
  kubectl get hpa,pods -n ${NAMESPACE} -w

If pods still stuck:
  DELETE_DEPLOYMENT=1 ./scripts/hpa-reset.sh

If HPA shows desiredReplicas=0:
  DELETE_HPA=1 ./scripts/hpa-reset.sh

Repeated rollout failures:
  ./scripts/cluster-recover.sh

EOF
