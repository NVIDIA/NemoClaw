#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Independent 8× H100 on-prem HPA scale-up / scale-down test (DCGM → HPA), then
# an Envoy LeastRequest distribution check. Separate from the 4× L40S AWS script
# (hpa-load-test-brev-4xl40s.sh). This Job (files/load-generator.ts) is the fast
# HPA-only path. Keep it. The OpenClaw/Hermes sandbox e2e scripts are additional
# architecture coverage and do not replace this test.
#
# After HPA reaches maxReplicas (8), generators stop *new* chats. Already
# in-flight work finishes, then HPA scales down toward minReplicas (1).
# Do not raise minReplicas. Envoy LeastRequest is checked at 8 Ready pods
# after leftovers are idle, with scale-down paused so replicas do not drop
# under the probe.
#
# Usage:
#   cd deploy/helm/gpu_autoscaling_k8s
#   ./scripts/hpa-load-test-dgx-8xh100.sh
# Optional: SKIP_ENVOY_LB_TEST=1 to skip the Envoy distribution check.
# ENABLE_ENVOY_LB=0 also skips that check (no Envoy load balancer to probe).
# Latency: HPA_METRIC=latency_avg HPA_TARGET_LATENCY_MS=3000 ./scripts/hpa-load-test-dgx-8xh100.sh
set -euo pipefail

if [[ -n "${TARGET_PODS:-}" && "${TARGET_PODS}" != "8" ]]; then
  echo "hpa-load-test-dgx-8xh100.sh always tests 8 pods." >&2
  exit 1
fi

# H100 defaults. Keep ALLOW_INSECURE_HTTP explicit: it is a security
# acknowledgement, not a portable chart default.
: "${MAX_REPLICAS:=8}"
TARGET_PODS=8
HPA_LOAD_PROFILE=dgx-8xh100
HPA_LOAD_PROFILE_REQUESTED=dgx-8xh100
: "${JOB_PARALLELISM:=4}"
: "${MAX_TOKENS:=128}"
: "${LOAD_MULTIPLIER:=2}"
: "${LOAD_COMPENSATION_SAFETY:=2}"
: "${RAMP_SEC:=45}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=hpa-common.sh
source "${SCRIPT_DIR}/hpa-common.sh"
# shellcheck source=agent-common.sh
source "${SCRIPT_DIR}/agent-common.sh"
hpa_common_load_local_env "${CHART_DIR}"
NAMESPACE="${NAMESPACE:-nemoclaw-gpu}"
RELEASE="${RELEASE:-nemoclaw-gpu}"
JOB_NAME="${JOB_NAME:-nemoclaw-gpu-hpa-load-test}"
INFERENCE_RUNTIME="${INFERENCE_RUNTIME:-ollama}"
INFERENCE_MODEL="${INFERENCE_MODEL:-$(agent_common_default_inference_model "${INFERENCE_RUNTIME}")}"
# Pin generators to the DGX 8× H100 node so they do not land on other GPU nodes.
# Hostname comes from gitignored local.env (NEMOCLAW_TARGET_NODE).
HPA_LOAD_NODE_NAME="${HPA_LOAD_NODE_NAME:-${NEMOCLAW_TARGET_NODE:-}}"
# Shared kube-prometheus-stack only scrapes ServiceMonitors with this label.
# Without it, GPU util still works (DCGM) but latency HPA stays ?/target.
HPA_SERVICEMONITOR_RELEASE="${HPA_SERVICEMONITOR_RELEASE:-${PROM_RELEASE:-kube-prometheus-stack}}"
require_cmd kubectl
require_cmd helm
hpa_common_require_nim_credentials "${INFERENCE_RUNTIME}" "${NAMESPACE}" || exit 1
hpa_common_verify_gpu_nodes || exit 1

# 8×H100 needs more in-flight than 4× L40S once load is split across several
# fast GPUs. Bootstrap must reach the 640-request/pod ceiling that avoided
# the 502s seen at 768.
HPA_LOAD_DEFAULT_INFLIGHT_PER_GPU=320
HPA_LOAD_DEFAULT_MAX_INFLIGHT_PER_POD=640
HPA_LOAD_DEFAULT_BOOTSTRAP_INFLIGHT=160
HPA_LOAD_DEFAULT_DURATION_SEC=900
HPA_LOAD_DEFAULT_SCALE_UP_WAIT_LOOPS=90

# Apply one-Pod HPA steps during every load test, then restore the configured
# production behavior in cleanup. Once replicas hit max, generators stop *new*
# chats; leftover in-flight work drains, then HPA scales toward minReplicas=1.
HPA_TEST_DEFAULT_SCALE_UP_PODS=1
HPA_TEST_DEFAULT_SCALE_UP_PERIOD_SEC=10
HPA_TEST_DEFAULT_SCALE_DOWN_PODS=1
HPA_TEST_DEFAULT_SCALE_DOWN_PERIOD_SEC=15
HPA_TEST_DEFAULT_SCALE_DOWN_STABILIZATION_SEC=60
HPA_TEST_DEFAULT_GPU_TARGET=40

# Backoff / floor — never drive all GPUs to 0% when HPA has 2+ replicas (circuit breaker keeps probe load).
ERROR_BACKOFF_FACTOR="${ERROR_BACKOFF_FACTOR:-0.92}"
ERROR_BACKOFF_MIN="${ERROR_BACKOFF_MIN:-0.4}"
ERROR_BACKOFF_RECOVERY="${ERROR_BACKOFF_RECOVERY:-1.15}"
CIRCUIT_BREAKER_BACKOFF="${CIRCUIT_BREAKER_BACKOFF:-0.15}"
MIN_INFLIGHT_FLOOR="${MIN_INFLIGHT_FLOOR:-12}"
MIN_RECOVERY_INFLIGHT="${MIN_RECOVERY_INFLIGHT:-4}"
READYZ_GRACE_SEC="${READYZ_GRACE_SEC:-45}"

# Defaults avoid overload → 502/503 → 0% GPU → retry spikes (see README.md).
# Override any knob via env, e.g. INFLIGHT_PER_GPU=256 ./scripts/hpa-load-test-dgx-8xh100.sh
JOB_PARALLELISM="${JOB_PARALLELISM:-4}"
MAX_TOKENS="${MAX_TOKENS:-128}"
HPA_TARGET_GPU="${HPA_TARGET_GPU:-40}"
INFLIGHT_PER_GPU="${INFLIGHT_PER_GPU:-${HPA_LOAD_DEFAULT_INFLIGHT_PER_GPU}}"
LOAD_MULTIPLIER="${LOAD_MULTIPLIER:-2}"
LOAD_COMPENSATION_SAFETY="${LOAD_COMPENSATION_SAFETY:-2}"
MAX_COMPENSATION="${MAX_COMPENSATION:-4}"
MAX_INFLIGHT_PER_POD="${MAX_INFLIGHT_PER_POD:-${HPA_LOAD_DEFAULT_MAX_INFLIGHT_PER_POD}}"
WARMUP_SEC="${WARMUP_SEC:-90}"
NEW_POD_RAMP_SEC="${NEW_POD_RAMP_SEC:-0}"
BOOTSTRAP_INFLIGHT="${BOOTSTRAP_INFLIGHT:-${HPA_LOAD_DEFAULT_BOOTSTRAP_INFLIGHT}}"
NEW_POD_WARMUP_PARALLEL="${NEW_POD_WARMUP_PARALLEL:-8}"
RAMP_SEC="${RAMP_SEC:-45}"
ESCALATE_INTERVAL_SEC="${ESCALATE_INTERVAL_SEC:-15}"
ESCALATE_FACTOR="${ESCALATE_FACTOR:-0.35}"
ESCALATE_MAX_MULT="${ESCALATE_MAX_MULT:-1.5}"
TARGET_POLL_SEC="${TARGET_POLL_SEC:-1}"
SCALE_UP_POLL_SEC="${SCALE_UP_POLL_SEC:-10}"

HPA_CONFIGURED_GPU_TARGET="${HPA_TARGET_GPU}"
# 0 = stop new queries as soon as all 8 GPUs are up. Leftover in-flight chats
# then finish on their own; HPA min stays 1, max stays 8.
MAX_REPLICAS_HOLD_SEC="${MAX_REPLICAS_HOLD_SEC:-0}"
DURATION_SEC="${DURATION_SEC:-${HPA_LOAD_DEFAULT_DURATION_SEC}}"
SCALE_UP_TARGET="${SCALE_UP_TARGET:-${TARGET_PODS}}"
SCALE_UP_WAIT_LOOPS="${SCALE_UP_WAIT_LOOPS:-${HPA_LOAD_DEFAULT_SCALE_UP_WAIT_LOOPS}}"
HPA_VALUES="${HPA_VALUES:-${CHART_DIR}/values.yaml}"
SCALE_DOWN_WAIT_LOOPS="${SCALE_DOWN_WAIT_LOOPS:-40}"
ROLLOUT_TIMEOUT="${ROLLOUT_TIMEOUT:-900}"
DEPLOYMENT="${DEPLOYMENT:-$(RELEASE="${RELEASE}" CHART_NAME=nemoclaw-gpu hpa_common_metrics_proxy_deployment)}"
HPA_NAME="${HPA_NAME:-${DEPLOYMENT}}"
SERVICE="${SERVICE:-$(RELEASE="${RELEASE}" CHART_NAME=nemoclaw-gpu hpa_common_metrics_proxy_service)}"
SERVICE_PORT="${SERVICE_PORT:-8081}"
# A test must begin from the HPA floor so its scale-up result is meaningful. This
# is intentionally a wait, not an automatic scale-down: forcing replicas down
# could interrupt real traffic that happens to share the deployment.
HPA_BASELINE_WAIT_SEC="${HPA_BASELINE_WAIT_SEC:-240}"
# The test applies one-Pod HPA steps only while it runs and restores the
# configured behavior from HPA_VALUES in cleanup.
HPA_TEST_SCALE_UP_PODS="${HPA_TEST_SCALE_UP_PODS:-${HPA_TEST_DEFAULT_SCALE_UP_PODS}}"
HPA_TEST_SCALE_UP_PERIOD_SEC="${HPA_TEST_SCALE_UP_PERIOD_SEC:-${HPA_TEST_DEFAULT_SCALE_UP_PERIOD_SEC}}"
HPA_TEST_SCALE_DOWN_PODS="${HPA_TEST_SCALE_DOWN_PODS:-${HPA_TEST_DEFAULT_SCALE_DOWN_PODS}}"
HPA_TEST_SCALE_DOWN_PERIOD_SEC="${HPA_TEST_SCALE_DOWN_PERIOD_SEC:-${HPA_TEST_DEFAULT_SCALE_DOWN_PERIOD_SEC}}"
HPA_TEST_SCALE_DOWN_STABILIZATION_SEC="${HPA_TEST_SCALE_DOWN_STABILIZATION_SEC:-${HPA_TEST_DEFAULT_SCALE_DOWN_STABILIZATION_SEC}}"
HPA_TEST_GPU_TARGET="${HPA_TEST_GPU_TARGET:-${HPA_TEST_DEFAULT_GPU_TARGET}}"
HPA_EFFECTIVE_GPU_TARGET="${HPA_CONFIGURED_GPU_TARGET}"
HPA_TEST_BEHAVIOR_APPLIED=0
HPA_SCALE_DOWN_PAUSED=0
HPA_RESTORE_HELM_ARGS=()
# shellcheck disable=SC2034 # passed by name to hpa_common_log_hpa_if_changed
LAST_HPA_LINE=""

ALLOW_INSECURE_VALUE="$(hpa_common_ingress_allow_insecure_value)"

kubectl get apiservice v1beta1.metrics.k8s.io 2>/dev/null | grep -q True || {
  echo "metrics-server not ready" >&2
  exit 1
}
hpa_common_verify_gpu_capacity "${TARGET_PODS}" || exit 1
if [[ "${HPA_METRIC:-gpu_utilization}" != "latency_avg" ]]; then
  hpa_common_verify_gpu_hpa_metric "${NAMESPACE}" || exit 1
fi

# Free GPUs held by historical *-agent leftovers before any Helm upgrade / rollout wait.
hpa_common_migrate_pre_metrics_proxy_resources "${NAMESPACE}" "${RELEASE}"

if ! hpa_common_ensure_metrics_proxy_ready "${NAMESPACE}" "${RELEASE}" "${CHART_DIR}" \
  "${HPA_VALUES}" "${ROLLOUT_TIMEOUT}"; then
  echo "Baseline pod not ready — HPA test cannot start" >&2
  exit 1
fi

HPA_HELM_ARGS=(
  upgrade --install "${RELEASE}" "${CHART_DIR}"
  --namespace "${NAMESPACE}"
  --create-namespace
  --set namespace.create=false
  --set "namespace.name=${NAMESPACE}"
  -f "${HPA_VALUES}"
  --set probes.readinessChecksInference=true
  --set autoscaling.enabled=true
  --set autoscaling.minReplicas=1
  --set autoscaling.maxReplicas="${TARGET_PODS}"
  --set autoscaling.maxGpus="${TARGET_PODS}"
  --set "autoscaling.metric=${HPA_METRIC:-gpu_utilization}"
  --set "autoscaling.targetGPUUtilizationPercentage=${HPA_CONFIGURED_GPU_TARGET}"
  --set "autoscaling.targetLatencyMilliseconds=${HPA_TARGET_LATENCY_MS:-5000}"
  --set "ingress.allowInsecureHttp=${ALLOW_INSECURE_VALUE}"
  --set "ingress.gateway.enabled=$(hpa_common_envoy_lb_helm_value)"
  --set "ingress.gateway.serviceType=${INGRESS_SERVICE_TYPE:-ClusterIP}"
  --set "ingress.gateway.className=${INGRESS_CLASS:-eg}"
)
hpa_common_append_target_node_helm_sets HPA_HELM_ARGS
hpa_common_append_servicemonitor_release_helm_set HPA_HELM_ARGS
hpa_common_append_inference_runtime_helm_sets HPA_HELM_ARGS \
  "${INFERENCE_RUNTIME}" \
  "${INFERENCE_MODEL}"

# The test restores the configured policy in cleanup. Require all five knobs
# together so a half-configured override cannot leave an invalid HPA policy behind.
HPA_TEST_BEHAVIOR_VALUES=(
  "${HPA_TEST_SCALE_UP_PODS}"
  "${HPA_TEST_SCALE_UP_PERIOD_SEC}"
  "${HPA_TEST_SCALE_DOWN_PODS}"
  "${HPA_TEST_SCALE_DOWN_PERIOD_SEC}"
  "${HPA_TEST_SCALE_DOWN_STABILIZATION_SEC}"
)
HPA_TEST_BEHAVIOR_SET=0
for value in "${HPA_TEST_BEHAVIOR_VALUES[@]}"; do
  [[ -n "${value}" ]] && HPA_TEST_BEHAVIOR_SET=$((HPA_TEST_BEHAVIOR_SET + 1))
done
if [[ "${HPA_TEST_BEHAVIOR_SET}" -ne 0 && "${HPA_TEST_BEHAVIOR_SET}" -ne 5 ]]; then
  echo "Set all HPA_TEST_SCALE_{UP,DOWN}_* values together, or leave all unset" >&2
  exit 1
fi
if [[ "${HPA_TEST_BEHAVIOR_SET}" -eq 5 ]]; then
  for value in "${HPA_TEST_BEHAVIOR_VALUES[@]}"; do
    if [[ ! "${value}" =~ ^[1-9][0-9]*$ ]]; then
      echo "HPA_TEST_SCALE_* values must be positive integers" >&2
      exit 1
    fi
  done
  if [[ ! "${HPA_TEST_GPU_TARGET}" =~ ^([1-9]|[1-9][0-9]|100)$ ]]; then
    echo "HPA_TEST_GPU_TARGET must be an integer from 1 to 100" >&2
    exit 1
  fi
  HPA_EFFECTIVE_GPU_TARGET="${HPA_TEST_GPU_TARGET}"
  HPA_RESTORE_HELM_ARGS=("${HPA_HELM_ARGS[@]}")
  HPA_HELM_ARGS+=(
    --set "autoscaling.targetGPUUtilizationPercentage=${HPA_EFFECTIVE_GPU_TARGET}"
    --set "autoscaling.behavior.scaleUp.policies[0].value=${HPA_TEST_SCALE_UP_PODS}"
    --set "autoscaling.behavior.scaleUp.policies[0].periodSeconds=${HPA_TEST_SCALE_UP_PERIOD_SEC}"
    --set "autoscaling.behavior.scaleDown.stabilizationWindowSeconds=${HPA_TEST_SCALE_DOWN_STABILIZATION_SEC}"
    --set "autoscaling.behavior.scaleDown.policies[0].value=${HPA_TEST_SCALE_DOWN_PODS}"
    --set "autoscaling.behavior.scaleDown.policies[0].periodSeconds=${HPA_TEST_SCALE_DOWN_PERIOD_SEC}"
  )
  HPA_TEST_BEHAVIOR_APPLIED=1
fi

cleanup() {
  # Remove every resource this script creates (Job, RBAC, ConfigMap) so repeated runs
  # don't accumulate unused ServiceAccounts/Roles/RoleBindings/ConfigMaps in the namespace.
  hpa_common_cleanup_load_test_resources "${NAMESPACE}" "${JOB_NAME}"
  kubectl delete pod "${LB_TEST_PROBE_POD:-nemoclaw-gpu-envoy-lb-probe}" \
    -n "${NAMESPACE}" --ignore-not-found >/dev/null 2>&1 || true
  if [[ "${HPA_SCALE_DOWN_PAUSED}" -eq 1 ]]; then
    hpa_common_resume_hpa_scale_down "${NAMESPACE}" "${HPA_NAME}" || true
    HPA_SCALE_DOWN_PAUSED=0
  fi
  if [[ "${HPA_TEST_BEHAVIOR_APPLIED}" -eq 1 ]]; then
    hpa_common_log "Restoring the configured HPA scale behavior..."
    helm "${HPA_RESTORE_HELM_ARGS[@]}" >/dev/null \
      || echo "Warning: could not restore configured HPA behavior; rerun ./scripts/install-hpa.sh" >&2
  fi
}
trap cleanup EXIT

helm "${HPA_HELM_ARGS[@]}" >/dev/null
hpa_common_wait_for_envoy_dataplane_on_target_node "${NAMESPACE}" "${DEPLOYMENT}" 180

IFS=$'\t' read -r DEPLOYED_INFERENCE_SECRET DEPLOYED_INFERENCE_SECRET_KEY < <(
  hpa_common_inference_secret_contract "${NAMESPACE}" "${RELEASE}" "${SERVICE}-inference-api"
)
INFERENCE_API_SECRET="${INFERENCE_API_SECRET:-${DEPLOYED_INFERENCE_SECRET}}"
INFERENCE_API_SECRET_KEY="${INFERENCE_API_SECRET_KEY:-${DEPLOYED_INFERENCE_SECRET_KEY}}"
if [[ ! "${INFERENCE_API_SECRET}" =~ ^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$ ]]; then
  echo "INFERENCE_API_SECRET must be a valid Kubernetes Secret name" >&2
  exit 1
fi
if [[ ! "${INFERENCE_API_SECRET_KEY}" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "INFERENCE_API_SECRET_KEY is invalid" >&2
  exit 1
fi

hpa_common_verify_hpa_bounds "${NAMESPACE}" "${DEPLOYMENT}" "${HPA_NAME}" 1 "${TARGET_PODS}" || true
hpa_common_wait_rollout "${DEPLOYMENT}" "${NAMESPACE}" "${ROLLOUT_TIMEOUT}"
hpa_common_verify_metrics_proxy_servicemonitor_release "${NAMESPACE}" || exit 1
hpa_common_print_hpa "${NAMESPACE}"

hpa_wait_for_one_replica_baseline() {
  local deadline hpa_status current desired available
  deadline=$((SECONDS + HPA_BASELINE_WAIT_SEC))
  hpa_common_log "Waiting for HPA baseline: 1 current / 1 desired replica before synthetic load..."

  while (( SECONDS < deadline )); do
    hpa_status="$(kubectl get hpa "${HPA_NAME}" -n "${NAMESPACE}" \
      -o jsonpath='{.status.currentReplicas}{" "}{.status.desiredReplicas}' 2>/dev/null || true)"
    read -r current desired <<<"${hpa_status}"
    available="$(kubectl get deployment "${DEPLOYMENT}" -n "${NAMESPACE}" \
      -o jsonpath='{.status.availableReplicas}' 2>/dev/null || true)"
    if hpa_common_replicas_at_want "${current}" "${desired}" 1 && [[ "${available:-0}" == "1" ]]; then
      hpa_common_replicas_ready_message "${NAMESPACE}" "${HPA_NAME}" "${current}" "${desired}"
      return 0
    fi
    sleep 5
  done

  echo "HPA did not settle to 1 current / 1 desired replica within ${HPA_BASELINE_WAIT_SEC}s." >&2
  echo "Wait for existing traffic or scale-down stabilization to finish, then retry. The test does not force a scale-down to avoid interrupting real traffic." >&2
  hpa_common_print_hpa "${NAMESPACE}" || true
  return 1
}

# Ensure metrics-proxy pods are Ready (inference model loaded) before load starts.
kubectl wait --for=condition=ready pod -l app.kubernetes.io/name=nemoclaw-gpu,component=gpu-metrics-proxy \
  -n "${NAMESPACE}" --timeout=600s >/dev/null 2>&1 || {
  echo "metrics-proxy pods not Ready — run ./scripts/hpa-reset.sh then retry" >&2
  exit 1
}

# Wait for inference ready (runtime model loaded) before starting load Job.
hpa_common_log "Waiting for metrics-proxy /readyz (model loaded)..."
READY_OK=0
for _ in $(seq 1 60); do
  METRICS_PROXY_POD="$(kubectl get pods -n "${NAMESPACE}" -l app.kubernetes.io/name=nemoclaw-gpu,component=gpu-metrics-proxy \
    --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  if [[ -n "${METRICS_PROXY_POD}" ]] && kubectl exec -n "${NAMESPACE}" "${METRICS_PROXY_POD}" -c metrics-proxy -- \
    node -e "fetch('http://127.0.0.1:${SERVICE_PORT}/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    >/dev/null 2>&1; then
    READY_OK=1
    break
  fi
  sleep 3
done
if [[ "${READY_OK}" -ne 1 ]]; then
  echo "metrics-proxy /readyz not stable — the inference runtime may still be pulling the model. Run ./scripts/hpa-reset.sh then retry" >&2
  exit 1
fi

# Smoke-test one chat completion before load Job starts.
hpa_common_log "Smoke test: chat completion on metrics-proxy pod..."
SMOKE_OK=0
for _ in $(seq 1 60); do
  METRICS_PROXY_POD="$(kubectl get pods -n "${NAMESPACE}" -l app.kubernetes.io/name=nemoclaw-gpu,component=gpu-metrics-proxy \
    --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  if [[ -n "${METRICS_PROXY_POD}" ]] && kubectl exec -n "${NAMESPACE}" "${METRICS_PROXY_POD}" -c metrics-proxy -- \
    node -e "fetch('http://127.0.0.1:${SERVICE_PORT}/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+process.env.INFERENCE_API_KEY},body:JSON.stringify({messages:[{role:'user',content:'Say OK.'}],max_tokens:8,stream:false})}).then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1));" \
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

# Latency HPA stays ?/target until Prometheus scrapes metrics-proxy. Label the
# ServiceMonitor (helm --set above), prime the series with the smoke request,
# then wait for the adapter before requiring a 1/1 HPA baseline.
if [[ "${HPA_METRIC:-gpu_utilization}" == "latency_avg" ]]; then
  LATENCY_METRIC_WAIT_SEC="${LATENCY_METRIC_WAIT_SEC:-180}"
  hpa_common_log "Waiting for Prometheus to scrape latency after the smoke request..."
  LATENCY_METRIC_READY=0
  LATENCY_METRIC_DEADLINE=$((SECONDS + LATENCY_METRIC_WAIT_SEC))
  while (( SECONDS < LATENCY_METRIC_DEADLINE )); do
    if hpa_common_verify_gpu_hpa_metric "${NAMESPACE}" >/dev/null 2>&1; then
      LATENCY_METRIC_READY=1
      break
    fi
    sleep 5
  done
  if [[ "${LATENCY_METRIC_READY}" -ne 1 ]]; then
    hpa_common_verify_metrics_proxy_servicemonitor_release "${NAMESPACE}" || true
    hpa_common_verify_gpu_hpa_metric "${NAMESPACE}" || true
    echo "Latency metric did not appear within ${LATENCY_METRIC_WAIT_SEC}s after the smoke request. Prometheus must scrape the metrics-proxy ServiceMonitor (release=${HPA_SERVICEMONITOR_RELEASE})." >&2
    exit 1
  fi
fi

hpa_wait_for_one_replica_baseline || exit 1
hpa_common_log "Smoke test OK — starting load generators"

LOAD_SA="${JOB_NAME}-sa"
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

LOAD_TEST_NODE_SELECTOR=""
if [[ -n "${HPA_LOAD_NODE_NAME:-}" ]]; then
  LOAD_TEST_NODE_SELECTOR="      nodeSelector:
        kubernetes.io/hostname: ${HPA_LOAD_NODE_NAME}
      tolerations:
        - key: nvidia.com/gpu
          operator: Exists
          effect: NoSchedule"
fi

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
${LOAD_TEST_NODE_SELECTOR}
      containers:
        - name: load-generator
          image: node:22-bookworm-slim@sha256:8607a9064d4a571140998ae9e52a3b3fcf9cff361d04642d5971e6cd76d39e27
          command: ["node", "/scripts/load-generator.ts"]
          env:
            - name: TARGET_PODS
              value: "${TARGET_PODS}"
            - name: HPA_TARGET_GPU
              value: "${HPA_EFFECTIVE_GPU_TARGET}"
            - name: HPA_LOAD_PROFILE
              value: "${HPA_LOAD_PROFILE}"
            - name: HPA_LOAD_PROFILE_REQUESTED
              value: "${HPA_LOAD_PROFILE_REQUESTED}"
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
            - name: METRICS_PROXY_SERVICE
              value: "${SERVICE}"
            - name: HPA_NAME
              value: "${DEPLOYMENT}"
            - name: METRICS_PROXY_PORT
              value: "${SERVICE_PORT}"
            - name: RAMP_SEC
              value: "${RAMP_SEC}"
            - name: DURATION_SEC
              value: "${DURATION_SEC}"
            - name: MAX_REPLICAS_HOLD_SEC
              value: "${MAX_REPLICAS_HOLD_SEC}"
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
            - name: INFERENCE_API_KEY
              valueFrom:
                secretKeyRef:
                  name: "${INFERENCE_API_SECRET}"
                  key: "${INFERENCE_API_SECRET_KEY}"
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
if [[ "${HPA_METRIC:-gpu_utilization}" == "latency_avg" ]]; then
  HPA_TEST_METRIC_TARGET="${HPA_TARGET_LATENCY_MS:-5000}ms"
else
  HPA_TEST_METRIC_TARGET="${HPA_EFFECTIVE_GPU_TARGET}%"
fi
hpa_common_log "Load profile=${HPA_LOAD_PROFILE} (requested=${HPA_LOAD_PROFILE_REQUESTED}): ${JOB_PARALLELISM} generators × ${MAX_TOKENS} tokens → each Ready metrics-proxy pod; base ~${PER_POD_PEAK} in-flight/pod (${LOAD_MULTIPLIER}×), cap ${MAX_INFLIGHT_PER_POD}/pod, warmup ${WARMUP_SEC}s, bootstrap ${BOOTSTRAP_INFLIGHT}; metric=${HPA_METRIC:-gpu_utilization} target=${HPA_TEST_METRIC_TARGET} → max ${TARGET_PODS} replicas, then stop new queries (hold ${MAX_REPLICAS_HOLD_SEC}s), drain in-flight, Envoy LeastRequest at 8, then scale-down to min 1"
if [[ "${HPA_TEST_BEHAVIOR_APPLIED}" -eq 1 ]]; then
  hpa_common_log "Temporary test HPA behavior: up to ${HPA_TEST_SCALE_UP_PODS} pods/${HPA_TEST_SCALE_UP_PERIOD_SEC}s; down up to ${HPA_TEST_SCALE_DOWN_PODS} pods/${HPA_TEST_SCALE_DOWN_PERIOD_SEC}s after ${HPA_TEST_SCALE_DOWN_STABILIZATION_SEC}s stabilization"
fi

kubectl wait --for=condition=ready pod -l "job-name=${JOB_NAME}" -n "${NAMESPACE}" --timeout=120s >/dev/null 2>&1 || {
  echo "Load-generator pods not ready — check: kubectl get pods -n ${NAMESPACE} -l job-name=${JOB_NAME}" >&2
}

if ! kubectl logs -n "${NAMESPACE}" -l "job-name=${JOB_NAME}" --tail=200 2>/dev/null \
  | grep -q 'targetsReady'; then
  hpa_common_log "Waiting for load generators to discover metrics-proxy pods..."
  for _ in $(seq 1 15); do
    kubectl logs -n "${NAMESPACE}" -l "job-name=${JOB_NAME}" --tail=200 2>/dev/null \
      | grep -q 'targetsReady' && break
    sleep 1
  done
fi

SCALE_UP_OK=0
SCALE_UP_POLL_SEC="${SCALE_UP_POLL_SEC:-10}"
for ((scale_up_i = 1; scale_up_i <= SCALE_UP_WAIT_LOOPS; scale_up_i += 1)); do
  hpa_common_log_hpa_if_changed "${NAMESPACE}" LAST_HPA_LINE
  REPLICAS="$(kubectl get hpa "${HPA_NAME}" -n "${NAMESPACE}" -o jsonpath='{.status.currentReplicas}' 2>/dev/null || true)"
  REPLICAS="$(hpa_common_nonneg_int "${REPLICAS}")"
  if (( REPLICAS >= SCALE_UP_TARGET )); then
    SCALE_UP_OK=1
    hpa_common_log "Scale-up OK: ${REPLICAS}/${SCALE_UP_TARGET} replicas"
    break
  fi
  sleep "${SCALE_UP_POLL_SEC}"
done

ENVOY_LB_OK=0
RUN_ENVOY_LB_TEST=0
if (( SCALE_UP_OK == 1 )) && (( SCALE_UP_TARGET >= 2 )) \
  && [[ "${SKIP_ENVOY_LB_TEST:-0}" != "1" ]] \
  && hpa_common_envoy_lb_enabled \
  && kubectl get gateway "${DEPLOYMENT}" -n "${NAMESPACE}" >/dev/null 2>&1; then
  RUN_ENVOY_LB_TEST=1
fi

# Hit max (8) → generators stop *new* chats → in-flight finish → Envoy (still 8)
# → resume scale-down toward 1. minReplicas stays 1.
HPA_SCALE_DOWN_PAUSED=0
if (( SCALE_UP_OK == 1 )); then
  hpa_common_log "Reached ${SCALE_UP_TARGET} GPUs — generators must stop new requests (HPA minReplicas=1 maxReplicas=${TARGET_PODS})"
  hpa_common_wait_for_load_stop_at_max "${NAMESPACE}" "${JOB_NAME}" 90 \
    || echo "Warning: proceeding without stopAtMaxReplicas log" >&2
  if hpa_common_pause_hpa_scale_down "${NAMESPACE}" "${HPA_NAME}"; then
    HPA_SCALE_DOWN_PAUSED=1
    hpa_common_log "Paused HPA scale-down so 8 GPUs stay up until in-flight drain and Envoy finish"
  fi
  hpa_common_wait_for_load_job_drain "${NAMESPACE}" "${JOB_NAME}" "${ENVOY_QUEUE_WAIT_SEC:-1800}"
  hpa_common_wait_for_llm_success_counters_idle "${NAMESPACE}" \
    "${ENVOY_QUEUE_IDLE_SEC:-20}" "${ENVOY_QUEUE_WAIT_SEC:-1800}" "${SERVICE_PORT}" \
    || echo "Warning: leftover chats may still be running" >&2
  hpa_common_log "In-flight chats finished (no new generator requests)"
else
  echo "HPA did not scale to ${SCALE_UP_TARGET} replicas" >&2
  hpa_common_log "Scale-up did not reach ${SCALE_UP_TARGET}; stopping load generators"
  hpa_common_wait_for_job_pods_gone "${NAMESPACE}" "${JOB_NAME}" 180
fi

if [[ "${RUN_ENVOY_LB_TEST}" -eq 1 ]]; then
  if kubectl wait --for=condition=ready pod \
    -l 'app.kubernetes.io/name=nemoclaw-gpu,component=gpu-metrics-proxy' \
    -n "${NAMESPACE}" --timeout=600s >/dev/null 2>&1; then
    attempt=1
    envoy_attempts="${ENVOY_LB_ATTEMPTS:-3}"
    while [[ "${attempt}" -le "${envoy_attempts}" ]]; do
      if hpa_common_verify_envoy_least_request_distribution \
        "${NAMESPACE}" \
        "${RELEASE}" \
        "${INFERENCE_API_SECRET}" \
        "${INFERENCE_API_SECRET_KEY}" \
        "${SCALE_UP_TARGET}" \
        "${INFERENCE_MODEL}" \
        "${DEPLOYMENT}"; then
        ENVOY_LB_OK=1
        break
      fi
      if [[ "${attempt}" -lt "${envoy_attempts}" ]]; then
        hpa_common_log "Envoy LeastRequest check attempt ${attempt}/${envoy_attempts} failed; retrying..."
        sleep 20
      fi
      attempt=$((attempt + 1))
    done
  fi
  if [[ "${ENVOY_LB_OK}" -ne 1 ]]; then
    echo "Envoy LeastRequest distribution check failed" >&2
  fi
elif [[ "${SCALE_UP_OK}" -eq 1 && "${SCALE_UP_TARGET}" -ge 2 ]]; then
  if [[ "${SKIP_ENVOY_LB_TEST:-0}" == "1" ]]; then
    hpa_common_log "Skipping Envoy LeastRequest check (SKIP_ENVOY_LB_TEST=1)"
  elif ! hpa_common_envoy_lb_enabled; then
    hpa_common_log "Skipping Envoy LeastRequest check (ENABLE_ENVOY_LB=0)"
  else
    hpa_common_log "Skipping Envoy LeastRequest check (Gateway ${DEPLOYMENT} not found)"
  fi
elif [[ "${SCALE_UP_OK}" -ne 1 ]]; then
  hpa_common_log "Skipping Envoy LeastRequest check because scale-up did not reach ${SCALE_UP_TARGET}"
fi

if [[ "${HPA_SCALE_DOWN_PAUSED}" -eq 1 ]]; then
  hpa_common_resume_hpa_scale_down "${NAMESPACE}" "${HPA_NAME}"
  HPA_SCALE_DOWN_PAUSED=0
  hpa_common_log "Resumed HPA scale-down toward minReplicas=1"
fi

SCALE_DOWN_OK=0
for ((scale_down_i = 1; scale_down_i <= SCALE_DOWN_WAIT_LOOPS; scale_down_i += 1)); do
  hpa_common_log_hpa_if_changed "${NAMESPACE}" LAST_HPA_LINE
  REPLICAS="$(kubectl get hpa "${HPA_NAME}" -n "${NAMESPACE}" -o jsonpath='{.status.currentReplicas}' 2>/dev/null || true)"
  REPLICAS="$(hpa_common_nonneg_int "${REPLICAS}")"
  if (( REPLICAS <= 1 )); then
    SCALE_DOWN_OK=1
    break
  fi
  sleep 15
done

hpa_common_print_hpa "${NAMESPACE}"

cleanup
trap - EXIT
if (( SCALE_UP_OK != 1 )); then
  echo "HPA load test incomplete: did not reach ${SCALE_UP_TARGET} replicas" >&2
fi
if (( SCALE_UP_OK == 1 )) && (( ENVOY_LB_OK != 1 )) && (( RUN_ENVOY_LB_TEST == 1 )); then
  echo "HPA load test incomplete: Envoy LeastRequest distribution check failed" >&2
fi
if (( SCALE_DOWN_OK != 1 )); then
  echo "HPA load test incomplete: did not scale down to 1 replica" >&2
fi
if (( SCALE_UP_OK != 1 || SCALE_DOWN_OK != 1 )); then
  exit 1
fi
if (( RUN_ENVOY_LB_TEST == 1 && ENVOY_LB_OK != 1 )); then
  exit 1
fi
if [[ "${RUN_ENVOY_LB_TEST}" -eq 1 ]]; then
  hpa_common_log "Load test complete: scaled to ${SCALE_UP_TARGET}/${TARGET_PODS} GPU replicas, verified Envoy LeastRequest, and returned to 1"
else
  hpa_common_log "Load test complete: scaled to ${SCALE_UP_TARGET}/${TARGET_PODS} GPU replicas and back to 1"
fi
