#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# HPA scale-up / scale-down test driven by GPU utilization (DCGM → HPA).
# Goal: raise average GPU util above HPA target so replicas grow to TARGET_PODS.
#
# Usage:
#   cd deploy/helm/gpu_autoscaling_k8s
#   ./scripts/hpa-load-test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=hpa-common.sh
source "${SCRIPT_DIR}/hpa-common.sh"
NAMESPACE="${NAMESPACE:-nemoclaw-gpu}"
RELEASE="${RELEASE:-nemoclaw-gpu}"
JOB_NAME="${JOB_NAME:-nemoclaw-gpu-hpa-load-test}"
ALLOC_GPUS="$(hpa_common_allocatable_gpus 2>/dev/null || echo 4)"
TARGET_PODS="${TARGET_PODS:-${ALLOC_GPUS}}"

# Backoff / floor — never drive all GPUs to 0% when HPA has 2+ replicas (circuit breaker keeps probe load).
ERROR_BACKOFF_FACTOR="${ERROR_BACKOFF_FACTOR:-0.92}"
ERROR_BACKOFF_MIN="${ERROR_BACKOFF_MIN:-0.4}"
ERROR_BACKOFF_RECOVERY="${ERROR_BACKOFF_RECOVERY:-1.15}"
CIRCUIT_BREAKER_BACKOFF="${CIRCUIT_BREAKER_BACKOFF:-0.15}"
MIN_INFLIGHT_FLOOR="${MIN_INFLIGHT_FLOOR:-12}"
MIN_RECOVERY_INFLIGHT="${MIN_RECOVERY_INFLIGHT:-4}"
READYZ_GRACE_SEC="${READYZ_GRACE_SEC:-45}"

# Steady GPU saturation — scales to all allocatable GPUs (TARGET_PODS defaults to GPU count).
# Defaults avoid overload → 502/503 → 0% GPU → retry spikes (see README.md).
# Override any knob via env, e.g. INFLIGHT_PER_GPU=512 ./scripts/hpa-load-test.sh
# HPA target GPU util % (default 40 — easier scale-up vs 50 while load spreads across GPUs).
if [[ "${TARGET_PODS}" -ge 4 ]]; then
  JOB_PARALLELISM="${JOB_PARALLELISM:-4}"
  MAX_TOKENS="${MAX_TOKENS:-128}"
  HPA_TARGET_GPU="${HPA_TARGET_GPU:-40}"
  INFLIGHT_PER_GPU="${INFLIGHT_PER_GPU:-64}"
  LOAD_MULTIPLIER="${LOAD_MULTIPLIER:-2}"
  LOAD_COMPENSATION_SAFETY="${LOAD_COMPENSATION_SAFETY:-2}"
  MAX_COMPENSATION="${MAX_COMPENSATION:-4}"
  MAX_INFLIGHT_PER_POD="${MAX_INFLIGHT_PER_POD:-512}"
  WARMUP_SEC="${WARMUP_SEC:-90}"
  NEW_POD_RAMP_SEC="${NEW_POD_RAMP_SEC:-0}"
  BOOTSTRAP_INFLIGHT="${BOOTSTRAP_INFLIGHT:-8}"
  NEW_POD_WARMUP_PARALLEL="${NEW_POD_WARMUP_PARALLEL:-8}"
  RAMP_SEC="${RAMP_SEC:-45}"
  ESCALATE_INTERVAL_SEC="${ESCALATE_INTERVAL_SEC:-15}"
  ESCALATE_FACTOR="${ESCALATE_FACTOR:-0.35}"
  ESCALATE_MAX_MULT="${ESCALATE_MAX_MULT:-1.5}"
  TARGET_POLL_SEC="${TARGET_POLL_SEC:-1}"
  SCALE_UP_POLL_SEC="${SCALE_UP_POLL_SEC:-10}"
else
  JOB_PARALLELISM="${JOB_PARALLELISM:-2}"
  LOAD_MULTIPLIER="${LOAD_MULTIPLIER:-2}"
  MAX_TOKENS="${MAX_TOKENS:-128}"
  HPA_TARGET_GPU="${HPA_TARGET_GPU:-40}"
  INFLIGHT_PER_GPU="${INFLIGHT_PER_GPU:-64}"
  LOAD_COMPENSATION_SAFETY="${LOAD_COMPENSATION_SAFETY:-3}"
  MAX_COMPENSATION="${MAX_COMPENSATION:-8}"
  MAX_INFLIGHT_PER_POD="${MAX_INFLIGHT_PER_POD:-512}"
  WARMUP_SEC="${WARMUP_SEC:-90}"
  NEW_POD_RAMP_SEC="${NEW_POD_RAMP_SEC:-0}"
  BOOTSTRAP_INFLIGHT="${BOOTSTRAP_INFLIGHT:-8}"
  NEW_POD_WARMUP_PARALLEL="${NEW_POD_WARMUP_PARALLEL:-8}"
  RAMP_SEC="${RAMP_SEC:-20}"
  ESCALATE_INTERVAL_SEC="${ESCALATE_INTERVAL_SEC:-15}"
  ESCALATE_FACTOR="${ESCALATE_FACTOR:-0.4}"
  ESCALATE_MAX_MULT="${ESCALATE_MAX_MULT:-2}"
  SCALE_UP_POLL_SEC="${SCALE_UP_POLL_SEC:-10}"
fi

DURATION_SEC="${DURATION_SEC:-720}"
SCALE_UP_TARGET="${SCALE_UP_TARGET:-${TARGET_PODS}}"
SCALE_UP_WAIT_LOOPS="${SCALE_UP_WAIT_LOOPS:-60}"
HPA_VALUES="${HPA_VALUES:-${CHART_DIR}/values-step2-hpa.yaml}"
LOAD_TEST_HPA_VALUES="${LOAD_TEST_HPA_VALUES:-${CHART_DIR}/values-load-test-hpa.yaml}"
SCALE_DOWN_WAIT_LOOPS="${SCALE_DOWN_WAIT_LOOPS:-40}"
ROLLOUT_TIMEOUT="${ROLLOUT_TIMEOUT:-900}"
DEPLOYMENT="${DEPLOYMENT:-$(RELEASE="${RELEASE}" CHART_NAME=nemoclaw-gpu hpa_common_agent_deployment)}"
SERVICE="${SERVICE:-$(RELEASE="${RELEASE}" CHART_NAME=nemoclaw-gpu hpa_common_agent_service)}"
SERVICE_PORT="${SERVICE_PORT:-8081}"
# shellcheck disable=SC2034 # passed by name to hpa_common_log_hpa_if_changed
LAST_HPA_LINE=""

require_cmd kubectl
require_cmd helm

ALLOW_INSECURE_VALUE="$(hpa_common_ingress_allow_insecure_value)"

kubectl get apiservice v1beta1.metrics.k8s.io 2>/dev/null | grep -q True || {
  echo "metrics-server not ready" >&2
  exit 1
}
hpa_common_verify_gpu_nodes || exit 1
hpa_common_verify_gpu_hpa_metric "${NAMESPACE}" || exit 1

if [[ "${TARGET_PODS}" -gt "${ALLOC_GPUS}" ]]; then
  TARGET_PODS="${ALLOC_GPUS}"
  SCALE_UP_TARGET="${ALLOC_GPUS}"
fi

if ! hpa_common_ensure_agent_ready "${NAMESPACE}" "${RELEASE}" "${CHART_DIR}" \
  "${HPA_VALUES}" "${ROLLOUT_TIMEOUT}"; then
  echo "Baseline pod not ready — HPA test cannot start" >&2
  exit 1
fi

hpa_common_gpu_recreate_stale_workload "${NAMESPACE}" "${DEPLOYMENT}" "${SERVICE}"

INFERENCE_MODEL="${INFERENCE_MODEL:-llama3.2:3b}"
helm upgrade --install "${RELEASE}" "${CHART_DIR}" \
  --namespace "${NAMESPACE}" \
  --create-namespace \
  --set namespace.create=false \
  -f "${HPA_VALUES}" \
  -f "${LOAD_TEST_HPA_VALUES}" \
  --set inference.model="${INFERENCE_MODEL}" \
  --set probes.readinessChecksInference=true \
  --set autoscaling.enabled=true \
  --set autoscaling.mode=gpu \
  --set autoscaling.minReplicas=1 \
  --set autoscaling.maxReplicas="${TARGET_PODS}" \
  --set "autoscaling.targetGPUUtilizationPercentage=${HPA_TARGET_GPU}" \
  --set "ingress.allowInsecureHttp=${ALLOW_INSECURE_VALUE}" \
  >/dev/null

hpa_common_verify_hpa_bounds "${NAMESPACE}" "${DEPLOYMENT}" "${DEPLOYMENT}" 1 "${TARGET_PODS}" || true
hpa_common_wait_rollout "${DEPLOYMENT}" "${NAMESPACE}" "${ROLLOUT_TIMEOUT}"
hpa_common_print_hpa "${NAMESPACE}"

# Ensure agent pods are Ready (Ollama loaded) before load starts.
kubectl wait --for=condition=ready pod -l app.kubernetes.io/name=nemoclaw-gpu,component=gpu-agent \
  -n "${NAMESPACE}" --timeout=600s >/dev/null 2>&1 || {
  echo "Agent pods not Ready — run ./scripts/hpa-reset.sh then retry" >&2
  exit 1
}

# Wait for inference ready (Ollama model loaded) before starting load Job.
hpa_common_log "Waiting for agent /readyz (model loaded)..."
READY_OK=0
for _ in $(seq 1 60); do
  AGENT_POD="$(kubectl get pods -n "${NAMESPACE}" -l app.kubernetes.io/name=nemoclaw-gpu,component=gpu-agent \
    --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  if [[ -n "${AGENT_POD}" ]] && kubectl exec -n "${NAMESPACE}" "${AGENT_POD}" -c agent -- \
    node -e "fetch('http://127.0.0.1:${SERVICE_PORT}/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    >/dev/null 2>&1; then
    READY_OK=1
    break
  fi
  sleep 3
done
if [[ "${READY_OK}" -ne 1 ]]; then
  echo "Agent /readyz not stable — Ollama may still be pulling the model. Run ./scripts/hpa-reset.sh then retry" >&2
  exit 1
fi

# Smoke-test one chat completion before load Job starts.
hpa_common_log "Smoke test: chat completion on agent pod..."
SMOKE_OK=0
for _ in $(seq 1 60); do
  AGENT_POD="$(kubectl get pods -n "${NAMESPACE}" -l app.kubernetes.io/name=nemoclaw-gpu,component=gpu-agent \
    --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  if [[ -n "${AGENT_POD}" ]] && kubectl exec -n "${NAMESPACE}" "${AGENT_POD}" -c agent -- \
    node -e "fetch('http://127.0.0.1:${SERVICE_PORT}/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:[{role:'user',content:'Say OK.'}],max_tokens:8,stream:false})}).then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1));" \
    >/dev/null 2>&1; then
    SMOKE_OK=1
    break
  fi
  sleep 5
done
if [[ "${SMOKE_OK}" -ne 1 ]]; then
  echo "Chat smoke test failed — inference not serving yet" >&2
  exit 1
fi
hpa_common_log "Smoke test OK — starting load generators"

LOAD_SA="${JOB_NAME}-sa"
cleanup() {
  # Remove every resource this script creates (Job, RBAC, ConfigMap) so repeated runs
  # don't accumulate unused ServiceAccounts/Roles/RoleBindings/ConfigMaps in the namespace.
  hpa_common_cleanup_load_test_resources "${NAMESPACE}" "${JOB_NAME}"
}
trap cleanup EXIT

kubectl delete job "${JOB_NAME}" -n "${NAMESPACE}" --ignore-not-found=true >/dev/null 2>&1 || true

kubectl apply -f - >/dev/null <<EOF
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ${LOAD_SA}
  namespace: ${NAMESPACE}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: ${JOB_NAME}-endpoints-reader
  namespace: ${NAMESPACE}
rules:
  - apiGroups: [""]
    resources: ["endpoints", "pods"]
    verbs: ["get", "list"]
  - apiGroups: ["discovery.k8s.io"]
    resources: ["endpointslices"]
    verbs: ["get", "list"]
  - apiGroups: ["autoscaling"]
    resources: ["horizontalpodautoscalers"]
    verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: ${JOB_NAME}-endpoints-reader
  namespace: ${NAMESPACE}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: ${JOB_NAME}-endpoints-reader
subjects:
  - kind: ServiceAccount
    name: ${LOAD_SA}
    namespace: ${NAMESPACE}
EOF

kubectl delete configmap "${JOB_NAME}-scripts" -n "${NAMESPACE}" --ignore-not-found=true >/dev/null 2>&1 || true
kubectl create configmap "${JOB_NAME}-scripts" -n "${NAMESPACE}" \
  --from-file=load-generator.ts="${CHART_DIR}/files/load-generator.ts" \
  --from-file=questions.txt="${CHART_DIR}/files/questions-sample.txt" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null

cat <<EOF | kubectl apply -f - >/dev/null
apiVersion: batch/v1
kind: Job
metadata:
  name: ${JOB_NAME}
  namespace: ${NAMESPACE}
  labels:
    app.kubernetes.io/name: nemoclaw-gpu
    app.kubernetes.io/instance: ${RELEASE}
    nemoclaw.ai/workload-type: load-test
spec:
  backoffLimit: 0
  parallelism: ${JOB_PARALLELISM}
  completions: ${JOB_PARALLELISM}
  ttlSecondsAfterFinished: 600
  template:
    metadata:
      labels:
        app.kubernetes.io/name: nemoclaw-gpu
        app.kubernetes.io/instance: ${RELEASE}
        nemoclaw.ai/workload-type: load-test
    spec:
      serviceAccountName: ${LOAD_SA}
      restartPolicy: Never
      containers:
        - name: load-generator
          image: node:22-bookworm-slim@sha256:8607a9064d4a571140998ae9e52a3b3fcf9cff361d04642d5971e6cd76d39e27
          command: ["node", "/scripts/load-generator.ts"]
          env:
            - name: TARGET_PODS
              value: "${TARGET_PODS}"
            - name: HPA_TARGET_GPU
              value: "${HPA_TARGET_GPU}"
            - name: JOB_PARALLELISM
              value: "${JOB_PARALLELISM}"
            - name: INFLIGHT_PER_GPU
              value: "${INFLIGHT_PER_GPU}"
            - name: LOAD_MULTIPLIER
              value: "${LOAD_MULTIPLIER}"
            - name: LOAD_COMPENSATION_SAFETY
              value: "${LOAD_COMPENSATION_SAFETY}"
            - name: MAX_COMPENSATION
              value: "${MAX_COMPENSATION}"
            - name: NEW_POD_RAMP_SEC
              value: "${NEW_POD_RAMP_SEC}"
            - name: MAX_INFLIGHT_PER_POD
              value: "${MAX_INFLIGHT_PER_POD}"
            - name: WARMUP_SEC
              value: "${WARMUP_SEC}"
            - name: BOOTSTRAP_INFLIGHT
              value: "${BOOTSTRAP_INFLIGHT}"
            - name: NEW_POD_WARMUP_PARALLEL
              value: "${NEW_POD_WARMUP_PARALLEL}"
            - name: ERROR_BACKOFF_FACTOR
              value: "${ERROR_BACKOFF_FACTOR}"
            - name: ERROR_BACKOFF_MIN
              value: "${ERROR_BACKOFF_MIN}"
            - name: ERROR_BACKOFF_RECOVERY
              value: "${ERROR_BACKOFF_RECOVERY}"
            - name: CIRCUIT_BREAKER_BACKOFF
              value: "${CIRCUIT_BREAKER_BACKOFF}"
            - name: MIN_INFLIGHT_FLOOR
              value: "${MIN_INFLIGHT_FLOOR}"
            - name: MIN_RECOVERY_INFLIGHT
              value: "${MIN_RECOVERY_INFLIGHT}"
            - name: READYZ_GRACE_SEC
              value: "${READYZ_GRACE_SEC}"
            - name: REQUIRE_CHAT_PROBE
              value: "false"
            - name: TARGET_POLL_SEC
              value: "${TARGET_POLL_SEC:-1}"
            - name: K8S_NAMESPACE
              value: "${NAMESPACE}"
            - name: AGENT_SERVICE
              value: "${SERVICE}"
            - name: HPA_NAME
              value: "${DEPLOYMENT}"
            - name: AGENT_PORT
              value: "${SERVICE_PORT}"
            - name: RAMP_SEC
              value: "${RAMP_SEC}"
            - name: DURATION_SEC
              value: "${DURATION_SEC}"
            - name: MAX_TOKENS
              value: "${MAX_TOKENS}"
            - name: ESCALATE_INTERVAL_SEC
              value: "${ESCALATE_INTERVAL_SEC}"
            - name: ESCALATE_FACTOR
              value: "${ESCALATE_FACTOR}"
            - name: ESCALATE_MAX_MULT
              value: "${ESCALATE_MAX_MULT}"
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
              - key: load-generator.ts
                path: load-generator.ts
        - name: questions
          configMap:
            name: ${JOB_NAME}-scripts
            items:
              - key: questions.txt
                path: questions.txt
EOF

PER_POD_PEAK=$((INFLIGHT_PER_GPU * LOAD_MULTIPLIER))
hpa_common_log "GPU load: ${JOB_PARALLELISM} generators × ${MAX_TOKENS} tokens → each Ready agent pod; base ~${PER_POD_PEAK} in-flight/pod (${LOAD_MULTIPLIER}×), cap ${MAX_INFLIGHT_PER_POD}/pod, warmup ${WARMUP_SEC}s, bootstrap ${BOOTSTRAP_INFLIGHT}; HPA target ${HPA_TARGET_GPU}% → max ${TARGET_PODS} replicas"

kubectl wait --for=condition=ready pod -l "job-name=${JOB_NAME}" -n "${NAMESPACE}" --timeout=120s >/dev/null 2>&1 || {
  echo "Load-generator pods not ready — check: kubectl get pods -n ${NAMESPACE} -l job-name=${JOB_NAME}" >&2
}

if ! kubectl logs -n "${NAMESPACE}" -l "job-name=${JOB_NAME}" --tail=200 2>/dev/null \
  | grep -q 'targetsReady'; then
  hpa_common_log "Waiting for load generators to discover agent pods..."
  for _ in $(seq 1 15); do
    kubectl logs -n "${NAMESPACE}" -l "job-name=${JOB_NAME}" --tail=200 2>/dev/null \
      | grep -q 'targetsReady' && break
    sleep 1
  done
fi

SCALE_UP_OK=0
SCALE_UP_POLL_SEC="${SCALE_UP_POLL_SEC:-10}"
for _ in $(seq 1 "${SCALE_UP_WAIT_LOOPS}"); do
  hpa_common_log_hpa_if_changed "${NAMESPACE}" LAST_HPA_LINE
  REPLICAS="$(kubectl get hpa -n "${NAMESPACE}" -o jsonpath='{.items[0].status.currentReplicas}' 2>/dev/null || echo 0)"
  if [[ "${REPLICAS}" -ge "${SCALE_UP_TARGET}" ]]; then
    SCALE_UP_OK=1
    hpa_common_log "Scale-up OK: ${REPLICAS}/${SCALE_UP_TARGET} replicas"
    break
  fi
  sleep "${SCALE_UP_POLL_SEC}"
done

if [[ "${SCALE_UP_OK}" -ne 1 ]]; then
  echo "HPA did not scale to ${SCALE_UP_TARGET} replicas" >&2
fi

kubectl wait --for=condition=complete "job/${JOB_NAME}" -n "${NAMESPACE}" --timeout="$((DURATION_SEC + 180))s" >/dev/null 2>&1 || true
kubectl delete job "${JOB_NAME}" -n "${NAMESPACE}" --ignore-not-found=true >/dev/null 2>&1 || true

SCALE_DOWN_OK=0
for _ in $(seq 1 "${SCALE_DOWN_WAIT_LOOPS}"); do
  hpa_common_log_hpa_if_changed "${NAMESPACE}" LAST_HPA_LINE
  REPLICAS="$(kubectl get hpa -n "${NAMESPACE}" -o jsonpath='{.items[0].status.currentReplicas}' 2>/dev/null || echo 0)"
  if [[ "${REPLICAS}" -le 1 ]]; then
    SCALE_DOWN_OK=1
    break
  fi
  sleep 15
done

hpa_common_print_hpa "${NAMESPACE}"

cleanup
trap - EXIT
if [[ "${SCALE_UP_OK}" -ne 1 ]]; then
  echo "HPA load test incomplete: did not reach ${SCALE_UP_TARGET} replicas" >&2
fi
if [[ "${SCALE_DOWN_OK}" -ne 1 ]]; then
  echo "HPA load test incomplete: did not scale down to 1 replica" >&2
fi
if [[ "${SCALE_UP_OK}" -ne 1 || "${SCALE_DOWN_OK}" -ne 1 ]]; then
  exit 1
fi
hpa_common_log "Load test complete: scaled to ${SCALE_UP_TARGET}/${TARGET_PODS} GPU replicas and back to 1"
