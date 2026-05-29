#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# HPA scale-up / scale-down test for nemoclaw-cpu chart.
# Sends many Nemotron chat questions (Inference Hub, same model as NemoClaw)
# through agent pods so CPU-based HPA adds replicas, then scales down after load stops.
#
# Usage:
#   cd deploy/helm/nemoclaw-cpu
#   source ~/.nemoclaw/secrets.env
#   ./scripts/hpa-load-test.sh
#
# Env overrides:
#   SCALE_UP_TARGET=7 WORKERS_MAX=120 BENCH_MS=400 HPA_TARGET_CPU=35 ./scripts/hpa-load-test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=hpa-common.sh
source "${SCRIPT_DIR}/hpa-common.sh"
NAMESPACE="${NAMESPACE:-nemoclaw}"
RELEASE="${RELEASE:-nemoclaw}"
JOB_NAME="${JOB_NAME:-nemoclaw-hpa-load-test}"
# Load model: TARGET_PODS × CONCURRENCY_PER_POD in-flight /bench (see load-generator.mjs)
TARGET_PODS="${TARGET_PODS:-7}"
CONCURRENCY_PER_POD="${CONCURRENCY_PER_POD:-40}"
BENCH_THREADS="${BENCH_THREADS:-2}"
DURATION_SEC="${DURATION_SEC:-720}"
RAMP_SEC="${RAMP_SEC:-90}"
BENCH_MS="${BENCH_MS:-${SPIN_MS:-450}}"
BENCH_RATIO="${BENCH_RATIO:-1}"
JOB_PARALLELISM="${JOB_PARALLELISM:-1}"
SCALE_UP_TARGET="${SCALE_UP_TARGET:-7}"
SCALE_UP_WAIT_LOOPS="${SCALE_UP_WAIT_LOOPS:-64}"
LOAD_TEST_CPU_SPIN_MS="${LOAD_TEST_CPU_SPIN_MS:-$BENCH_MS}"
HPA_TARGET_CPU="${HPA_TARGET_CPU:-50}"
SATURATE_VALUES="${SATURATE_VALUES:-${CHART_DIR}/values-step2-hpa-saturate.yaml}"
SCALE_DOWN_WAIT_LOOPS="${SCALE_DOWN_WAIT_LOOPS:-32}"
ROLLOUT_TIMEOUT="${ROLLOUT_TIMEOUT:-300}"
WATCH_LOG="${WATCH_LOG:-/tmp/nemoclaw-hpa-watch.log}"
DEPLOYMENT="${DEPLOYMENT:-${RELEASE}-nemoclaw-cpu-agent}"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

require_cmd kubectl
require_cmd helm

if [[ -z "${NVIDIA_INFERENCE_HUB_API_KEY:-}" ]]; then
  if [[ -f "${HOME}/.nemoclaw/secrets.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "${HOME}/.nemoclaw/secrets.env"
    set +a
  fi
fi

if [[ -z "${NVIDIA_INFERENCE_HUB_API_KEY:-}" ]]; then
  echo "Set NVIDIA_INFERENCE_HUB_API_KEY or add it to ~/.nemoclaw/secrets.env" >&2
  exit 1
fi

log "Preflight: metrics-server + HPA"
if ! kubectl get apiservice v1beta1.metrics.k8s.io 2>/dev/null | grep -q True; then
  echo "metrics-server not ready. Run: microk8s enable metrics-server" >&2
  echo "Then wait until: kubectl get apiservice v1beta1.metrics.k8s.io shows AVAILABLE True" >&2
  exit 1
fi

log "Ensure at least one agent pod is Ready (HPA off first)"
if ! hpa_common_ensure_agent_ready "${NAMESPACE}" "${RELEASE}" "${CHART_DIR}" \
  "${NVIDIA_INFERENCE_HUB_API_KEY}" "${SATURATE_VALUES}" "${ROLLOUT_TIMEOUT}"; then
  log "Agent not ready — run: ./scripts/hpa-reset.sh"
  exit 1
fi

if ! kubectl get hpa -n "${NAMESPACE}" 2>/dev/null | grep -q agent; then
  log "Enabling HPA (min=1, max=${TARGET_PODS}, target CPU ${HPA_TARGET_CPU}%)"
else
  log "Upgrading chart (saturate overlay: 400m CPU req/pod so 7 fit on 8 vCPU)"
fi

helm upgrade "${RELEASE}" "${CHART_DIR}" -n "${NAMESPACE}" \
  --reuse-values \
  -f "${SATURATE_VALUES}" \
  --set namespace.create=false \
  --set inference.apiKey="${NVIDIA_INFERENCE_HUB_API_KEY}" \
  --set autoscaling.enabled=true \
  --set autoscaling.minReplicas=1 \
  --set autoscaling.maxReplicas="${TARGET_PODS}" \
  --set autoscaling.targetCPUUtilizationPercentage="${HPA_TARGET_CPU}" \
  --set loadTest.cpuSpinMs="${LOAD_TEST_CPU_SPIN_MS}"

hpa_common_verify_hpa_bounds "${NAMESPACE}" "${DEPLOYMENT}" "${DEPLOYMENT}" 1 "${TARGET_PODS}" || true

if ! hpa_common_wait_rollout "${DEPLOYMENT}" "${NAMESPACE}" "${ROLLOUT_TIMEOUT}"; then
  log "ERROR: rollout timed out after ${ROLLOUT_TIMEOUT}s"
  log "  HPA may show desiredReplicas=0 when no metrics — check:"
  log "  kubectl get hpa,deploy,pods -n ${NAMESPACE}"
  log "  kubectl describe deploy ${DEPLOYMENT} -n ${NAMESPACE}"
  log "Fix: ./scripts/hpa-reset.sh"
  exit 1
fi

log "Baseline"
kubectl get hpa,deploy,pods -n "${NAMESPACE}"
kubectl top pods -n "${NAMESPACE}" 2>/dev/null || true

log "Starting HPA watch log: ${WATCH_LOG}"
: > "${WATCH_LOG}"
(
  while true; do
    date -u +%Y-%m-%dT%H:%M:%SZ | tr -d '\n'
    echo -n " "
    kubectl get hpa -n "${NAMESPACE}" --no-headers 2>/dev/null || true
    kubectl get deploy -n "${NAMESPACE}" -l app.kubernetes.io/name=nemoclaw-cpu --no-headers 2>/dev/null || true
    kubectl top pods -n "${NAMESPACE}" 2>/dev/null | head -10 || true
    echo "---"
    sleep 15
  done
) >>"${WATCH_LOG}" 2>&1 &
WATCH_PID=$!
cleanup() {
  kill "${WATCH_PID}" 2>/dev/null || true
  kubectl delete job "${JOB_NAME}" -n "${NAMESPACE}" --ignore-not-found=true >/dev/null 2>&1 || true
}
trap cleanup EXIT

PEAK_INFLIGHT=$((TARGET_PODS * CONCURRENCY_PER_POD))
log "Creating load-test Job(s): parallelism=${JOB_PARALLELISM}, peakInflight=${PEAK_INFLIGHT} (${TARGET_PODS}pods×${CONCURRENCY_PER_POD}), bench ${BENCH_MS}ms×${BENCH_THREADS}threads"
kubectl delete job "${JOB_NAME}" -n "${NAMESPACE}" --ignore-not-found=true >/dev/null 2>&1 || true

kubectl create configmap "${JOB_NAME}-scripts" -n "${NAMESPACE}" \
  --from-file=load-generator.mjs="${CHART_DIR}/files/load-generator.mjs" \
  --from-file=questions.txt="${CHART_DIR}/files/questions-sample.txt" \
  --dry-run=client -o yaml | kubectl apply -f -

cat <<EOF | kubectl apply -f -
apiVersion: batch/v1
kind: Job
metadata:
  name: ${JOB_NAME}
  namespace: ${NAMESPACE}
spec:
  backoffLimit: 0
  parallelism: ${JOB_PARALLELISM}
  completions: ${JOB_PARALLELISM}
  ttlSecondsAfterFinished: 600
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: load-generator
          image: node:22-bookworm-slim
          command: ["node", "/scripts/load-generator.mjs"]
          env:
            - name: TARGET_URL
              value: "http://${RELEASE}-nemoclaw-cpu-agent:8080"
            - name: TARGET_PODS
              value: "${TARGET_PODS}"
            - name: CONCURRENCY_PER_POD
              value: "${CONCURRENCY_PER_POD}"
            - name: BENCH_THREADS
              value: "${BENCH_THREADS}"
            - name: RAMP_SEC
              value: "${RAMP_SEC}"
            - name: DURATION_SEC
              value: "${DURATION_SEC}"
            - name: BENCH_MS
              value: "${BENCH_MS}"
            - name: BENCH_RATIO
              value: "${BENCH_RATIO}"
            - name: QUESTIONS_FILE
              value: "/questions/questions.txt"
          volumeMounts:
            - name: scripts
              mountPath: /scripts
              readOnly: true
            - name: questions
              mountPath: /questions
              readOnly: true
      volumes:
        - name: scripts
          configMap:
            name: ${JOB_NAME}-scripts
            items:
              - key: load-generator.mjs
                path: load-generator.mjs
        - name: questions
          configMap:
            name: ${JOB_NAME}-scripts
            items:
              - key: questions.txt
                path: questions.txt
EOF

log "Waiting for scale-up (target >= ${SCALE_UP_TARGET} replicas, up to $((SCALE_UP_WAIT_LOOPS * 15 / 60)) min)"
SCALE_UP_OK=0
for _ in $(seq 1 "${SCALE_UP_WAIT_LOOPS}"); do
  REPLICAS="$(kubectl get hpa -n "${NAMESPACE}" -o jsonpath='{.items[0].status.currentReplicas}' 2>/dev/null || echo 0)"
  TARGETS="$(kubectl get hpa -n "${NAMESPACE}" --no-headers 2>/dev/null | awk '{print $3}' || echo "?")"
  log "HPA replicas=${REPLICAS} targets=${TARGETS}"
  if [[ "${REPLICAS}" -ge "${SCALE_UP_TARGET}" ]]; then
    SCALE_UP_OK=1
    break
  fi
  sleep 15
done

kubectl get hpa,deploy,pods -n "${NAMESPACE}"
kubectl top pods -n "${NAMESPACE}" 2>/dev/null || true

if [[ "${SCALE_UP_OK}" -ne 1 ]]; then
  log "Scale-up did not reach ${SCALE_UP_TARGET} replicas in time."
  log "Try: CONCURRENCY_PER_POD=55 BENCH_MS=500 JOB_PARALLELISM=3 HPA_TARGET_CPU=25 ./scripts/hpa-load-test.sh"
  log "Job logs:"
  kubectl logs -n "${NAMESPACE}" "job/${JOB_NAME}" --tail=40 2>/dev/null || true
fi

log "Waiting for load Job to finish (or tail logs in another terminal)"
kubectl wait --for=condition=complete "job/${JOB_NAME}" -n "${NAMESPACE}" --timeout="$((DURATION_SEC + 120))s" 2>/dev/null || {
  kubectl logs -n "${NAMESPACE}" "job/${JOB_NAME}" --tail=30 2>/dev/null || true
}

kubectl delete job "${JOB_NAME}" -n "${NAMESPACE}" --ignore-not-found=true

log "Cool-down: scale-down uses ~90–120s stabilization + pod removal (watch up to $((SCALE_DOWN_WAIT_LOOPS * 15 / 60)) min)"
log "Watch: kubectl get hpa -n ${NAMESPACE} -w"
log "Full timeline: less ${WATCH_LOG}"

for _ in $(seq 1 "${SCALE_DOWN_WAIT_LOOPS}"); do
  REPLICAS="$(kubectl get hpa -n "${NAMESPACE}" -o jsonpath='{.items[0].status.currentReplicas}' 2>/dev/null || echo 0)"
  TARGETS="$(kubectl get hpa -n "${NAMESPACE}" --no-headers 2>/dev/null | awk '{print $3}' || echo "?")"
  log "Cool-down replicas=${REPLICAS} targets=${TARGETS}"
  [[ "${REPLICAS}" -le 1 ]] && break
  sleep 15
done

kubectl get hpa,deploy,pods -n "${NAMESPACE}"
log "Done. Reset CPU spin: helm upgrade ${RELEASE} . -n ${NAMESPACE} --reuse-values --set loadTest.cpuSpinMs=0"
