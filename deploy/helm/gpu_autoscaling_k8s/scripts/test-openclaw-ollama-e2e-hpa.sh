#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# OpenClaw + Ollama e2e 8×H100 saturator: N end users, each with one CPU
# OpenClaw sandbox. Users send prompts into those sandboxes; each sandbox
# calls inference.local → Envoy → Ollama GPU HPA in
# namespace/release nemoclaw-gpu.
# Same minReplicas=1 / maxReplicas=8 as hpa-load-test-dgx-8xh100.sh.
# This does not replace that Job (files/load-generator.ts); keep the Job as
# the fast HPA-only test. It does not start load-generator.ts. Does not
# source e2e-common.sh (pairing tests force ENABLE_AUTOSCALING=0). Does not
# reinstall Prometheus, the Envoy load balancer, or OpenShell. Does not add extra
# OpenShell gateways — START_AGENTS starts N OpenClaw sandboxes.
# Does not change the 4× L40S profile. Does not use the Deep Agents + vLLM
# stack (nemoclaw-deepagents-vllm). Hermes + vLLM e2e is
# test-hermes-e2e-hpa.sh and is not run from this script.
# LLM latency HPA is a separate script: test-openclaw-ollama-e2e-latency-hpa.sh
#
# Usage:
#   cd deploy/helm/gpu_autoscaling_k8s
#   ./scripts/test-openclaw-ollama-e2e-hpa.sh

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
  fail "this e2e is OpenClaw + Ollama (got INFERENCE_RUNTIME=${INFERENCE_RUNTIME}). Hermes + vLLM is ./scripts/test-hermes-e2e-hpa.sh and is not run now."
fi
if [[ -n "${AGENT_NAME:-}" && "${AGENT_NAME}" != "openclaw" ]]; then
  fail "this e2e is OpenClaw + Ollama (got AGENT_NAME=${AGENT_NAME})"
fi
agent_common_pin_example_pairing openclaw ollama
if [[ "${INFERENCE_MODEL}" != "llama3.2:3b" ]]; then
  fail "this e2e is OpenClaw + Ollama llama3.2:3b (got INFERENCE_MODEL=${INFERENCE_MODEL}). Do not point it at Hermes/vLLM/NIM models."
fi
AGENT_DISPLAY_NAME="$(agent_common_display_name "${AGENT_NAME}")"

export NAMESPACE="${NAMESPACE:-nemoclaw-gpu}"
export RELEASE="${RELEASE:-nemoclaw-gpu}"
if [[ "${NAMESPACE}" != "nemoclaw-gpu" || "${RELEASE}" != "nemoclaw-gpu" ]]; then
  fail "OpenClaw + Ollama e2e uses NAMESPACE=nemoclaw-gpu RELEASE=nemoclaw-gpu (got ${NAMESPACE}/${RELEASE}). Do not point this test at deepagents-vllm."
fi
export ENABLE_ENVOY_LB="${ENABLE_ENVOY_LB:-1}"
export ENABLE_AUTOSCALING="${ENABLE_AUTOSCALING:-1}"
export MIN_REPLICAS="${MIN_REPLICAS:-1}"
export MAX_REPLICAS="${MAX_REPLICAS:-8}"
export TARGET_PODS="${TARGET_PODS:-8}"
export GPU_TARGET="${GPU_TARGET:-40}"
export SKIP_MONITORING="${SKIP_MONITORING:-1}"
export USE_EXISTING_PROMETHEUS="${USE_EXISTING_PROMETHEUS:-1}"
export INGRESS_SERVICE_TYPE="${INGRESS_SERVICE_TYPE:-ClusterIP}"
export E2E_USERS="${E2E_USERS:-10}"
export SANDBOX_PREFIX="${SANDBOX_PREFIX:-openclaw-ollama-e2e-}"
export AGENT_SANDBOX_IMAGE="${AGENT_SANDBOX_IMAGE:-ghcr.io/nvidia/nemoclaw/openclaw-sandbox@sha256:bd935f0198b99889d9479fea123b62a59e3797da13e392dcc2160f114216c1ba}"
export AGENT_SANDBOX_CPU="${AGENT_SANDBOX_CPU:-1}"
export AGENT_SANDBOX_MEMORY="${AGENT_SANDBOX_MEMORY:-8Gi}"
export NEMOCLAW_MINIMAL_BOOTSTRAP="${NEMOCLAW_MINIMAL_BOOTSTRAP:-1}"
export INFLIGHT_PER_GPU="${INFLIGHT_PER_GPU:-320}"
export LOAD_MULTIPLIER="${LOAD_MULTIPLIER:-2}"
export MAX_INFLIGHT_PER_POD="${MAX_INFLIGHT_PER_POD:-640}"
# Job questions tokenize at ~38 llama3.2 tokens (Ollama prompt_eval_count).
# max_tokens is the answer cap; 16× that is a long reply vs the ~38-token ask.
export QUESTION_AVG_TOKENS="${QUESTION_AVG_TOKENS:-38}"
export MAX_TOKENS="${MAX_TOKENS:-$((QUESTION_AVG_TOKENS * 16))}"
export DURATION_SEC="${DURATION_SEC:-900}"
export MAX_REPLICAS_HOLD_SEC="${MAX_REPLICAS_HOLD_SEC:-0}"
export SCALE_DOWN_WAIT_LOOPS="${SCALE_DOWN_WAIT_LOOPS:-40}"
export E2E_PROMPT_TIMEOUT_SEC="${E2E_PROMPT_TIMEOUT_SEC:-600}"
HPA_BASELINE_WAIT_SEC="${HPA_BASELINE_WAIT_SEC:-240}"
# 1–2 chats per user (typical turn). Path stays user → sandbox → Envoy.
E2E_INFLIGHT_START_PER_USER="${E2E_INFLIGHT_START_PER_USER:-1}"
E2E_INFLIGHT_PER_USER="${E2E_INFLIGHT_PER_USER:-2}"
if ((E2E_INFLIGHT_PER_USER > 16)); then
  echo "E2E_INFLIGHT_PER_USER=${E2E_INFLIGHT_PER_USER} is too high for 4Gi OpenClaw RAM. Capping at 16." >&2
  E2E_INFLIGHT_PER_USER=16
fi
if ((E2E_INFLIGHT_START_PER_USER > E2E_INFLIGHT_PER_USER)); then
  E2E_INFLIGHT_START_PER_USER="${E2E_INFLIGHT_PER_USER}"
fi
export E2E_INFLIGHT_START_PER_USER E2E_INFLIGHT_PER_USER
E2E_OUTPUT_DIR="${E2E_OUTPUT_DIR:-${CHART_DIR}/e2e-results/openclaw-ollama}"
# Start one OpenClaw sandbox per user (not extra OpenShell gateways).
# START_GATEWAYS is a deprecated alias for START_AGENTS.
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
  fail "this e2e requires ENABLE_AUTOSCALING=1 (the one-sandbox pairing test is test-openclaw-ollama.sh)"
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

if ! kubectl get gatewayclass "${INGRESS_CLASS:-eg}" >/dev/null 2>&1; then
  fail "GatewayClass ${INGRESS_CLASS:-eg} is missing; Envoy control plane must already be installed (do not reinstall it here)"
fi

cd "${CHART_DIR}"
mkdir -p "${E2E_OUTPUT_DIR}"

if [[ "${SKIP_INSTALL_HPA}" != "1" ]]; then
  echo "Enabling the OpenClaw + Ollama GPU HPA backend in ${NAMESPACE}/${RELEASE} (minReplicas=1 maxReplicas=8, Envoy on, no Prometheus/Envoy reinstall)"
  SKIP_MONITORING=1 USE_EXISTING_PROMETHEUS=1 \
    "${SCRIPT_DIR}/install-hpa.sh"
fi

kubectl get gateway "${DEPLOYMENT}" -n "${NAMESPACE}" >/dev/null 2>&1 \
  || fail "Gateway ${DEPLOYMENT} missing in ${NAMESPACE}; sandboxes cannot use Envoy"
hpa_common_wait_for_envoy_dataplane_on_target_node "${NAMESPACE}" "${DEPLOYMENT}" 180

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

echo "E2E test: OpenClaw + Ollama — ${E2E_USERS} end users send requests to ${E2E_USERS} sandboxes"
echo "  ${E2E_USERS} OpenClaw sandboxes run on CPU; LLM runs on GPUs"
echo "  When end-user demand increases, GPU HPA scales Ollama from 1 to 8 GPUs"
echo "  All ${E2E_USERS} sandboxes share one OpenShell gateway."
echo "  One sandbox per user; ${AGENT_SANDBOX_CPU} CPU / ${AGENT_SANDBOX_MEMORY}; inflight ${E2E_INFLIGHT_START_PER_USER}→${E2E_INFLIGHT_PER_USER}; question≈${QUESTION_AVG_TOKENS} tok; max_tokens=${MAX_TOKENS}"
echo "  Client ./scripts/client.sh (no sandbox create). ./scripts/agentscaling.sh already ran above."
set +e
"${SCRIPT_DIR}/client.sh"
LOAD_RC=$?
set -e

hpa_common_print_hpa "${NAMESPACE}" || true
if [[ "${LOAD_RC}" -ne 0 ]]; then
  fail "sandbox saturator failed (exit ${LOAD_RC}); results in ${E2E_OUTPUT_DIR}"
fi
echo "OK: OpenClaw + Ollama e2e — ${E2E_USERS} end users → ${E2E_USERS} sandboxes; demand scaled GPU HPA ${NAMESPACE}/${RELEASE} 1→8→1."
echo "Tear down only these sandboxes with: ./scripts/agentscaling.sh cleanup"
