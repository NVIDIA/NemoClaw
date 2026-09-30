#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# End-to-end 8×H100 saturator for Hermes: N end users, each with one CPU Hermes
# sandbox. The load generator sends hermes -z prompts into those sandboxes;
# Hermes calls inference.local → Envoy → GPU HPA (the model runs on GPU pods,
# not in the sandbox). Same minReplicas=1 / maxReplicas=8 as the OpenClaw e2e.
#
# It does not start files/load-generator.ts. Does not source e2e-common.sh
# (pairing tests force ENABLE_AUTOSCALING=0). Does not reinstall Prometheus,
# the Envoy load balancer, or OpenShell. Does not change the 4× L40S profile. Does not
# create or destroy openclaw-e2e-* or hermes-onprem.
#
# Do not run this while the OpenClaw e2e owns the GPUs.
#
# Usage:
#   cd deploy/helm/gpu_autoscaling_k8s
#   ./scripts/test-hermes-e2e-hpa.sh

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
export AGENT_NAME="${AGENT_NAME:-hermes}"
[[ "${AGENT_NAME}" == "hermes" ]] \
  || fail "test-hermes-e2e-hpa.sh is Hermes-only (got AGENT_NAME=${AGENT_NAME})"
agent_common_validate "${AGENT_NAME}"
export INFERENCE_RUNTIME="${INFERENCE_RUNTIME:-vllm}"
agent_common_validate_runtime_pairing "${AGENT_NAME}" "${INFERENCE_RUNTIME}"
export INFERENCE_MODEL="${INFERENCE_MODEL:-$(agent_common_default_inference_model "${INFERENCE_RUNTIME}")}"
AGENT_DISPLAY_NAME="$(agent_common_display_name "${AGENT_NAME}")"

export NAMESPACE="${NAMESPACE:-nemoclaw-gpu}"
export RELEASE="${RELEASE:-nemoclaw-gpu}"
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
export SANDBOX_PREFIX="${SANDBOX_PREFIX:-hermes-e2e-}"
export AGENT_SANDBOX_IMAGE="${AGENT_SANDBOX_IMAGE:-ghcr.io/nvidia/nemoclaw/hermes-sandbox@sha256:28b9578ab9676ef046de37fa6feb9b7b61824b87d77fd08978758bd01c03cb54}"
export AGENT_SANDBOX_CPU="${AGENT_SANDBOX_CPU:-1}"
export AGENT_SANDBOX_MEMORY="${AGENT_SANDBOX_MEMORY:-1Gi}"
export DURATION_SEC="${DURATION_SEC:-900}"
export MAX_REPLICAS_HOLD_SEC="${MAX_REPLICAS_HOLD_SEC:-0}"
export SCALE_DOWN_WAIT_LOOPS="${SCALE_DOWN_WAIT_LOOPS:-40}"
HPA_BASELINE_WAIT_SEC="${HPA_BASELINE_WAIT_SEC:-240}"
E2E_INFLIGHT_PER_USER="${E2E_INFLIGHT_PER_USER:-4}"
E2E_OUTPUT_DIR="${E2E_OUTPUT_DIR:-${CHART_DIR}/e2e-results/hermes}"
# hermes -z is the user→sandbox query and does not need :8642.
START_GATEWAYS="${START_GATEWAYS:-0}"
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
  fail "this e2e requires ENABLE_AUTOSCALING=1 (pairing tests are test-hermes-nim.sh)"
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
  echo "Enabling the existing GPU HPA backend (minReplicas=1 maxReplicas=8, Envoy on, no Prometheus/Envoy reinstall)"
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

if [[ "${SKIP_CREATE_SANDBOXES}" != "1" ]]; then
  "${SCRIPT_DIR}/setup-hermes-e2e-sandboxes.sh" "${E2E_USERS}"
fi
if [[ "${START_GATEWAYS}" == "1" ]]; then
  E2E_USERS="${E2E_USERS}" "${SCRIPT_DIR}/setup-hermes-e2e-sandboxes.sh" start
fi

echo "${E2E_USERS} users sending hermes -z prompts into ${E2E_USERS} CPU ${AGENT_DISPLAY_NAME} sandboxes (not Envoy-direct, not load-generator.ts)"
set +e
python3 "${SCRIPT_DIR}/e2e-hermes-load-test.py" \
  --users "${E2E_USERS}" \
  --prefix "${SANDBOX_PREFIX}" \
  --output "${E2E_OUTPUT_DIR}" \
  --model "${INFERENCE_MODEL}" \
  --duration "${DURATION_SEC}" \
  --inflight-per-user "${E2E_INFLIGHT_PER_USER}" \
  --target-pods "${TARGET_PODS}" \
  --hold-sec "${MAX_REPLICAS_HOLD_SEC}" \
  --hpa-namespace "${NAMESPACE}" \
  --hpa-name "${HPA_NAME}" \
  --scale-down-wait-loops "${SCALE_DOWN_WAIT_LOOPS}"
LOAD_RC=$?
set -e

hpa_common_print_hpa "${NAMESPACE}" || true
if [[ "${LOAD_RC}" -ne 0 ]]; then
  fail "Hermes user→sandbox load failed (exit ${LOAD_RC}); results in ${E2E_OUTPUT_DIR}"
fi
echo "OK: ${E2E_USERS} CPU ${AGENT_DISPLAY_NAME} agent sandboxes drove GPU HPA ${NAMESPACE}/${RELEASE} through Envoy (1→8→1)."
echo "Tear down only these sandboxes with: ./scripts/setup-hermes-e2e-sandboxes.sh cleanup"
