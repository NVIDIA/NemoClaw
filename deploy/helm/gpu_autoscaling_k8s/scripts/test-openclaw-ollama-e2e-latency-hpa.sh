#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# OpenClaw + Ollama e2e using LLM latency HPA (not GPU util).
# Same user → sandbox → inference.local → Envoy → Ollama path as
# test-openclaw-ollama-e2e-hpa.sh, but the HPA metric is the one the
# fast Job uses for latency:
#
#   metrics-proxy times in-pod chat/completions (including streams)
#   → rolling avg gauge nemoclaw_llm_latency_avg_milliseconds
#     (window 128, idle-expire 60s)
#   → Prometheus ServiceMonitor → prometheus-adapter
#   → HPA Pods AverageValue target 3000 ms
#
# That is files/metrics-proxy-metrics.ts + files/metrics-proxy-server.ts
# (recordLlmLatency) and monitoring/prometheus-adapter-gpu-values.yaml.
# Same knobs as hpa-load-test-dgx-8xh100.sh:
#   HPA_METRIC=latency_avg HPA_TARGET_LATENCY_MS=3000
#
# Do not copy the Job's 640 in-flight chats *per GPU pod* into one OpenClaw
# sandbox — that OOMKills the 4Gi CPU agent (exit 137). Use more agents and
# a small per-agent inflight (start 2, cap 16).
#
# Does not replace hpa-load-test-dgx-8xh100.sh. Does not replace the GPU-util
# sandbox e2e. Does not source e2e-common.sh. Does not reinstall Prometheus,
# Envoy, or OpenShell. minReplicas stays 1.
#
# Usage:
#   cd deploy/helm/gpu_autoscaling_k8s
#   ./scripts/test-openclaw-ollama-e2e-latency-hpa.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=versions.env
source "${CHART_DIR}/versions.env"
# shellcheck source=hpa-common.sh
source "${SCRIPT_DIR}/hpa-common.sh"
# shellcheck source=agent-common.sh
source "${SCRIPT_DIR}/agent-common.sh"
hpa_common_load_local_env "${CHART_DIR}"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

export PATH="${HOME}/.local/bin:${PATH}"
if [[ -n "${INFERENCE_RUNTIME:-}" && "${INFERENCE_RUNTIME}" != "ollama" ]]; then
  fail "this e2e is OpenClaw + Ollama (got INFERENCE_RUNTIME=${INFERENCE_RUNTIME})"
fi
if [[ -n "${AGENT_NAME:-}" && "${AGENT_NAME}" != "openclaw" ]]; then
  fail "this e2e is OpenClaw + Ollama (got AGENT_NAME=${AGENT_NAME})"
fi
agent_common_pin_example_pairing openclaw ollama
if [[ "${INFERENCE_MODEL}" != "llama3.2:3b" ]]; then
  fail "this e2e is OpenClaw + Ollama llama3.2:3b (got INFERENCE_MODEL=${INFERENCE_MODEL})"
fi
AGENT_DISPLAY_NAME="$(agent_common_display_name "${AGENT_NAME}")"

export NAMESPACE="${NAMESPACE:-nemoclaw-gpu}"
export RELEASE="${RELEASE:-nemoclaw-gpu}"
if [[ "${NAMESPACE}" != "nemoclaw-gpu" || "${RELEASE}" != "nemoclaw-gpu" ]]; then
  fail "OpenClaw + Ollama e2e uses NAMESPACE=nemoclaw-gpu RELEASE=nemoclaw-gpu (got ${NAMESPACE}/${RELEASE})"
fi
export ENABLE_ENVOY_LB="${ENABLE_ENVOY_LB:-1}"
export ENABLE_AUTOSCALING="${ENABLE_AUTOSCALING:-1}"
export MIN_REPLICAS="${MIN_REPLICAS:-1}"
export MAX_REPLICAS="${MAX_REPLICAS:-8}"
export TARGET_PODS="${TARGET_PODS:-8}"
export SKIP_MONITORING="${SKIP_MONITORING:-1}"
export USE_EXISTING_PROMETHEUS="${USE_EXISTING_PROMETHEUS:-1}"
export INGRESS_SERVICE_TYPE="${INGRESS_SERVICE_TYPE:-ClusterIP}"
export E2E_USERS="${E2E_USERS:-10}"
export SANDBOX_PREFIX="${SANDBOX_PREFIX:-openclaw-ollama-e2e-}"
export AGENT_SANDBOX_IMAGE="${AGENT_SANDBOX_IMAGE:-ghcr.io/nvidia/nemoclaw/openclaw-sandbox@sha256:bd935f0198b99889d9479fea123b62a59e3797da13e392dcc2160f114216c1ba}"
export AGENT_SANDBOX_CPU="${AGENT_SANDBOX_CPU:-1}"
export AGENT_SANDBOX_MEMORY="${AGENT_SANDBOX_MEMORY:-4Gi}"
# Match the Job's completion size so each proxied chat holds the GPU long enough
# for metrics-proxy's rolling latency_avg (128-sample window) to rise.
export MAX_TOKENS="${MAX_TOKENS:-128}"
export DURATION_SEC="${DURATION_SEC:-900}"
export MAX_REPLICAS_HOLD_SEC="${MAX_REPLICAS_HOLD_SEC:-30}"
export SCALE_DOWN_WAIT_LOOPS="${SCALE_DOWN_WAIT_LOOPS:-40}"
HPA_BASELINE_WAIT_SEC="${HPA_BASELINE_WAIT_SEC:-240}"
LATENCY_METRIC_WAIT_SEC="${LATENCY_METRIC_WAIT_SEC:-180}"
HPA_SERVICEMONITOR_RELEASE="${HPA_SERVICEMONITOR_RELEASE:-${PROM_RELEASE:-kube-prometheus-stack}}"

# This script is latency-only. GPU util remains test-openclaw-ollama-e2e-hpa.sh.
if [[ -n "${HPA_METRIC:-}" && "${HPA_METRIC}" != "latency_avg" ]]; then
  fail "this script is LLM latency HPA (got HPA_METRIC=${HPA_METRIC}). GPU util is ./scripts/test-openclaw-ollama-e2e-hpa.sh"
fi
export HPA_METRIC="latency_avg"
export HPA_TARGET_LATENCY_MS="${HPA_TARGET_LATENCY_MS:-3000}"

# CPU RAM: 4 agents × 640 inflight OOMKilled 4Gi sandboxes. Prefer more agents,
# few concurrent chats each. Do not inherit the Job's 640/pod into OpenClaw.
E2E_INFLIGHT_START_PER_USER="${E2E_INFLIGHT_START_PER_USER:-2}"
E2E_INFLIGHT_PER_USER="${E2E_INFLIGHT_PER_USER:-16}"
if ((E2E_INFLIGHT_PER_USER > 32)); then
  echo "E2E_INFLIGHT_PER_USER=${E2E_INFLIGHT_PER_USER} is too high for CPU RAM (4Gi OpenClaw OOM at ~640). Capping at 32." >&2
  E2E_INFLIGHT_PER_USER=32
fi
if ((E2E_INFLIGHT_START_PER_USER > E2E_INFLIGHT_PER_USER)); then
  E2E_INFLIGHT_START_PER_USER="${E2E_INFLIGHT_PER_USER}"
fi
export E2E_INFLIGHT_START_PER_USER E2E_INFLIGHT_PER_USER

E2E_OUTPUT_DIR="${E2E_OUTPUT_DIR:-${CHART_DIR}/e2e-results/openclaw-ollama-latency}"
START_AGENTS="${START_AGENTS:-${START_GATEWAYS:-1}}"
SKIP_INSTALL_HPA="${SKIP_INSTALL_HPA:-0}"
SKIP_CREATE_SANDBOXES="${SKIP_CREATE_SANDBOXES:-0}"

if [[ "${MIN_REPLICAS}" != "1" ]]; then
  fail "minReplicas must stay 1 for this e2e (got MIN_REPLICAS=${MIN_REPLICAS})"
fi
if [[ "${MAX_REPLICAS}" != "8" || "${TARGET_PODS}" != "8" ]]; then
  fail "this 8×H100 e2e saturates 8 GPU replicas (MAX_REPLICAS/TARGET_PODS must be 8)"
fi
if [[ "${ENABLE_ENVOY_LB}" != "1" ]]; then
  fail "this e2e requires ENABLE_ENVOY_LB=1 so sandboxes reach GPUs through Envoy"
fi
if [[ "${ENABLE_AUTOSCALING}" != "1" ]]; then
  fail "this e2e requires ENABLE_AUTOSCALING=1"
fi

DEPLOYMENT="$(RELEASE="${RELEASE}" CHART_NAME=nemoclaw-gpu hpa_common_metrics_proxy_deployment)"
export HPA_NAME="${HPA_NAME:-${DEPLOYMENT}}"
export INFERENCE_SERVICE="${INFERENCE_SERVICE:-$(RELEASE="${RELEASE}" CHART_NAME=nemoclaw-gpu hpa_common_metrics_proxy_service)}"

command -v openshell >/dev/null 2>&1 || fail "missing command: openshell"
command -v kubectl >/dev/null 2>&1 || fail "missing command: kubectl"
command -v helm >/dev/null 2>&1 || fail "missing command: helm"
command -v python3 >/dev/null 2>&1 || fail "missing command: python3"

openshell status >/dev/null \
  || fail "OpenShell gateway is not connected; port-forward service/openshell first"
hpa_common_verify_target_node 1 || exit 1
hpa_common_verify_gpu_capacity "${MAX_REPLICAS}" || exit 1
kubectl get apiservice v1beta1.metrics.k8s.io 2>/dev/null | grep -q True \
  || fail "metrics-server not ready"
kubectl get apiservice v1beta1.custom.metrics.k8s.io 2>/dev/null | grep -q True \
  || fail "custom.metrics.k8s.io not ready (prometheus-adapter); latency HPA cannot run"

if ! kubectl get gatewayclass "${INGRESS_CLASS:-eg}" >/dev/null 2>&1; then
  fail "GatewayClass ${INGRESS_CLASS:-eg} is missing; Envoy control plane must already be installed (do not reinstall it here)"
fi

cd "${CHART_DIR}"
mkdir -p "${E2E_OUTPUT_DIR}"

echo "E2E load (LLM latency HPA, same metric as hpa-load-test-dgx-8xh100.sh):"
echo "  HPA_METRIC=latency_avg  target=${HPA_TARGET_LATENCY_MS} ms"
echo "  metrics-proxy rolling avg nemoclaw_llm_latency_avg_milliseconds (not GPU %)"
echo "  ${E2E_USERS} CPU agents, inflight start ${E2E_INFLIGHT_START_PER_USER}/user ramp to ${E2E_INFLIGHT_PER_USER}/user (not Job 640/pod)"
echo "  TARGETS on kubectl get hpa is milliseconds (e.g. 46514/3000), not 20666m GPU util"

if [[ "${SKIP_INSTALL_HPA}" != "1" ]]; then
  echo "Switching ${NAMESPACE}/${RELEASE} HPA to latency_avg (minReplicas=1 maxReplicas=8, no Prometheus/Envoy reinstall)"
  SKIP_MONITORING=1 USE_EXISTING_PROMETHEUS=1 \
    HPA_METRIC=latency_avg HPA_TARGET_LATENCY_MS="${HPA_TARGET_LATENCY_MS}" \
    "${SCRIPT_DIR}/install-hpa.sh"
fi

kubectl get gateway "${DEPLOYMENT}" -n "${NAMESPACE}" >/dev/null 2>&1 \
  || fail "Gateway ${DEPLOYMENT} missing in ${NAMESPACE}; sandboxes cannot use Envoy"
hpa_common_wait_for_envoy_dataplane_on_target_node "${NAMESPACE}" "${DEPLOYMENT}" 180

# Same wait as hpa-load-test-dgx-8xh100.sh: latency HPA stays ?/target until
# Prometheus scrapes metrics-proxy and the adapter exposes the gauge.
echo "Waiting up to ${LATENCY_METRIC_WAIT_SEC}s for nemoclaw_llm_latency_avg_milliseconds (ServiceMonitor release=${HPA_SERVICEMONITOR_RELEASE})"
LATENCY_METRIC_READY=0
LATENCY_METRIC_DEADLINE=$((SECONDS + LATENCY_METRIC_WAIT_SEC))
while ((SECONDS < LATENCY_METRIC_DEADLINE)); do
  if hpa_common_verify_gpu_hpa_metric "${NAMESPACE}" >/dev/null 2>&1; then
    LATENCY_METRIC_READY=1
    break
  fi
  sleep 5
done
if [[ "${LATENCY_METRIC_READY}" -ne 1 ]]; then
  hpa_common_verify_gpu_hpa_metric "${NAMESPACE}" || true
  fail "Latency metric did not appear within ${LATENCY_METRIC_WAIT_SEC}s. Prometheus must scrape the metrics-proxy ServiceMonitor."
fi

hpa_common_print_hpa "${NAMESPACE}" || true
deadline=$((SECONDS + HPA_BASELINE_WAIT_SEC))
echo "Waiting for HPA baseline 1/1 before sandbox load (up to ${HPA_BASELINE_WAIT_SEC}s)"
while ((SECONDS < deadline)); do
  hpa_status="$(kubectl get hpa "${HPA_NAME}" -n "${NAMESPACE}" \
    -o jsonpath='{.status.currentReplicas}{" "}{.status.desiredReplicas}' 2>/dev/null || true)"
  read -r current desired <<<"${hpa_status}"
  if [[ "${current:-0}" == "1" && "${desired:-0}" == "1" ]]; then
    echo "HPA baseline ready: 1 current / 1 desired replica"
    break
  fi
  sleep 5
done

if [[ "${SKIP_CREATE_SANDBOXES}" != "1" && "${START_AGENTS}" == "1" ]]; then
  E2E_USERS="${E2E_USERS}" "${SCRIPT_DIR}/setup-openclaw-ollama-e2e-sandboxes.sh" bringup
elif [[ "${SKIP_CREATE_SANDBOXES}" != "1" ]]; then
  "${SCRIPT_DIR}/setup-openclaw-ollama-e2e-sandboxes.sh" "${E2E_USERS}"
elif [[ "${START_AGENTS}" == "1" ]]; then
  E2E_USERS="${E2E_USERS}" "${SCRIPT_DIR}/setup-openclaw-ollama-e2e-sandboxes.sh" start
fi

echo "E2E test: OpenClaw + Ollama — LLM latency HPA"
echo "  ${E2E_USERS} end users → ${E2E_USERS} CPU OpenClaw agents → inference.local → Envoy → Ollama"
echo "  Scale-out when average metrics-proxy chat latency > ${HPA_TARGET_LATENCY_MS} ms"
echo "  One OpenShell gateway. Agents stay on CPU; do not pack Job-sized inflight into one sandbox."
set +e
python3 "${SCRIPT_DIR}/e2e-openclaw-ollama-load-test.py" \
  --users "${E2E_USERS}" \
  --prefix "${SANDBOX_PREFIX}" \
  --output "${E2E_OUTPUT_DIR}" \
  --model "${INFERENCE_MODEL}" \
  --duration "${DURATION_SEC}" \
  --inflight-per-user "${E2E_INFLIGHT_PER_USER}" \
  --inflight-start "${E2E_INFLIGHT_START_PER_USER}" \
  --target-pods "${TARGET_PODS}" \
  --hold-sec "${MAX_REPLICAS_HOLD_SEC}" \
  --hpa-namespace "${NAMESPACE}" \
  --hpa-name "${HPA_NAME}" \
  --scale-down-wait-loops "${SCALE_DOWN_WAIT_LOOPS}"
LOAD_RC=$?
set -e

hpa_common_print_hpa "${NAMESPACE}" || true
if [[ "${LOAD_RC}" -ne 0 ]]; then
  fail "sandbox saturator failed (exit ${LOAD_RC}); results in ${E2E_OUTPUT_DIR}"
fi
echo "OK: OpenClaw + Ollama latency e2e — ${E2E_USERS} CPU agents; HPA ${NAMESPACE}/${RELEASE} scaled 1→8→1 on latency_avg ${HPA_TARGET_LATENCY_MS} ms."
echo "Tear down only these sandboxes with: ./scripts/setup-openclaw-ollama-e2e-sandboxes.sh cleanup"
