#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# HPA scale-up / scale-down test. Prints HPA status only.
#
# Usage:
#   cd deploy/helm/nemoclaw-cpu
#   source ~/.nemoclaw/secrets.env
#   ./scripts/hpa-load-test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=hpa-common.sh
source "${SCRIPT_DIR}/hpa-common.sh"
NAMESPACE="${NAMESPACE:-nemoclaw}"
RELEASE="${RELEASE:-nemoclaw}"
JOB_NAME="${JOB_NAME:-nemoclaw-hpa-load-test}"
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
DEPLOYMENT="${DEPLOYMENT:-${RELEASE}-nemoclaw-cpu-agent}"
SERVICE="${SERVICE:-${DEPLOYMENT}}"
SERVICE_PORT="${SERVICE_PORT:-8080}"
LAST_HPA_LINE=""

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

if ! kubectl get apiservice v1beta1.metrics.k8s.io 2>/dev/null | grep -q True; then
  echo "metrics-server not ready — CPU HPA unavailable" >&2
  exit 1
fi

if ! hpa_common_ensure_agent_ready "${NAMESPACE}" "${RELEASE}" "${CHART_DIR}" \
  "${NVIDIA_INFERENCE_HUB_API_KEY}" "${SATURATE_VALUES}" "${ROLLOUT_TIMEOUT}"; then
  echo "Baseline pod not ready — HPA test cannot start" >&2
  exit 1
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
  --set loadTest.cpuSpinMs="${LOAD_TEST_CPU_SPIN_MS}" \
  >/dev/null

hpa_common_verify_hpa_bounds "${NAMESPACE}" "${DEPLOYMENT}" "${DEPLOYMENT}" 1 "${TARGET_PODS}" || true

if ! hpa_common_wait_rollout "${DEPLOYMENT}" "${NAMESPACE}" "${ROLLOUT_TIMEOUT}"; then
  hpa_common_diagnose_rollout "${NAMESPACE}" "${DEPLOYMENT}"
  exit 1
fi

hpa_common_print_hpa "${NAMESPACE}"

cleanup() {
  kubectl delete job "${JOB_NAME}" -n "${NAMESPACE}" --ignore-not-found=true >/dev/null 2>&1 || true
}
trap cleanup EXIT

kubectl delete job "${JOB_NAME}" -n "${NAMESPACE}" --ignore-not-found=true >/dev/null 2>&1 || true

kubectl create configmap "${JOB_NAME}-scripts" -n "${NAMESPACE}" \
  --from-file=load-generator.mjs="${CHART_DIR}/files/load-generator.mjs" \
  --from-file=questions.txt="${CHART_DIR}/files/questions-sample.txt" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null

cat <<EOF | kubectl apply -f - >/dev/null
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
              value: "http://${SERVICE}:${SERVICE_PORT}"
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

SCALE_UP_OK=0
for _ in $(seq 1 "${SCALE_UP_WAIT_LOOPS}"); do
  hpa_common_log_hpa_if_changed "${NAMESPACE}" LAST_HPA_LINE
  REPLICAS="$(kubectl get hpa -n "${NAMESPACE}" -o jsonpath='{.items[0].status.currentReplicas}' 2>/dev/null || echo 0)"
  if [[ "${REPLICAS}" -ge "${SCALE_UP_TARGET}" ]]; then
    SCALE_UP_OK=1
    break
  fi
  sleep 15
done

if [[ "${SCALE_UP_OK}" -ne 1 ]]; then
  echo "HPA did not scale to ${SCALE_UP_TARGET} replicas" >&2
fi

kubectl wait --for=condition=complete "job/${JOB_NAME}" -n "${NAMESPACE}" --timeout="$((DURATION_SEC + 120))s" >/dev/null 2>&1 || true
kubectl delete job "${JOB_NAME}" -n "${NAMESPACE}" --ignore-not-found=true >/dev/null 2>&1 || true

for _ in $(seq 1 "${SCALE_DOWN_WAIT_LOOPS}"); do
  hpa_common_log_hpa_if_changed "${NAMESPACE}" LAST_HPA_LINE
  REPLICAS="$(kubectl get hpa -n "${NAMESPACE}" -o jsonpath='{.items[0].status.currentReplicas}' 2>/dev/null || echo 0)"
  [[ "${REPLICAS}" -le 1 ]] && break
  sleep 15
done

hpa_common_print_hpa "${NAMESPACE}"
