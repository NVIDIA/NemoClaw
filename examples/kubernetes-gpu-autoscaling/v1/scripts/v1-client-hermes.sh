#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# End-user client for step 6b on NemoClaw v1 (Hermes + vLLM). One simulated user
# per v1 sandbox (1:1). It is the v1 counterpart of ../../scripts/client_hermes.sh.
#
# v0 sends `hermes -z` through the v0.0.85 gateway. A v1 sandbox runs Fabric, so
# each prompt goes through `kubectl exec ... fabric-agent-ctl invoke`. The
# `development` gateway profile gives the operator no token, so this client does
# not use the OpenShell gateway.
#
# Apply a deployment with at least E2E_USERS sandboxes first:
#   E2E_USERS=10 ./scripts/v1-render-sandboxes.sh hermes-vllm > .local/hermes-vllm-10.yaml
#   nemoclaw apply --non-interactive --state-dir .local/gpu-autoscaling .local/hermes-vllm-10.yaml
#
# GPU util (HPA metric gpu_utilization_percent, target 40%):
#   INFLIGHT=2 MAX_TOKENS=1024 E2E_USERS=10 ./scripts/v1-client-hermes.sh
# LLM latency (HPA metric latency_avg, target 3000 ms). Switch the metric first:
#   ./scripts/v1-set-hpa-metric.sh latency_avg
#   E2E_USERS=10 ./scripts/v1-client-hermes.sh
#
# Env: NEMOCLAW_V1_STATE_DIR (default .local/gpu-autoscaling), V1_NAMESPACE,
# E2E_OUTPUT_DIR, TARGET_PODS (default 7), DURATION_SEC.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
V1_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CHART_DIR="$(cd "${V1_DIR}/.." && pwd)"
RECIPE_SCRIPTS="${CHART_DIR}/scripts"
# shellcheck source=../../scripts/agent-common.sh
source "${RECIPE_SCRIPTS}/agent-common.sh"
# shellcheck source=../../scripts/hpa-common.sh
source "${RECIPE_SCRIPTS}/hpa-common.sh"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

export PATH="${HOME}/.local/bin:${PATH}"
export E2E_USERS="${E2E_USERS:-10}"
export V1_NAMESPACE="${V1_NAMESPACE:-nemoclaw-v1-gpu-autoscaling}"
export NEMOCLAW_V1_STATE_DIR="${NEMOCLAW_V1_STATE_DIR:-${V1_DIR}/.local/gpu-autoscaling}"
INFERENCE_RUNTIME="${INFERENCE_RUNTIME:-$(agent_common_default_inference_runtime hermes)}"
export INFERENCE_RUNTIME
agent_common_validate_inference_runtime "${INFERENCE_RUNTIME}"
INFERENCE_MODEL="$(agent_common_resolve_inference_model "${INFERENCE_RUNTIME}")"
export INFERENCE_MODEL
export NAMESPACE="${NAMESPACE:-nemoclaw-gpu}"
export HPA_NAME="${HPA_NAME:-nemoclaw-gpu-metrics-proxy}"
export TARGET_PODS="${TARGET_PODS:-7}"
export DURATION_SEC="${DURATION_SEC:-900}"
export E2E_PROMPT_TIMEOUT_SEC="${E2E_PROMPT_TIMEOUT_SEC:-180}"
agent_common_export_demo_workload hermes
agent_common_export_client_tokens hermes
agent_common_export_client_inflight
# Stop new chats at the target GPU count. Do not hold replicas or pause scale-down.
export MAX_REPLICAS_HOLD_SEC="${MAX_REPLICAS_HOLD_SEC:-0}"
export SCALE_DOWN_WAIT_LOOPS="${SCALE_DOWN_WAIT_LOOPS:-40}"
export E2E_OUTPUT_DIR="${E2E_OUTPUT_DIR:-${CHART_DIR}/e2e-results/hermes-v1}"

command -v kubectl >/dev/null 2>&1 || fail "missing command: kubectl"
command -v python3 >/dev/null 2>&1 || fail "missing command: python3"
command -v jq >/dev/null 2>&1 || fail "missing command: jq"
[[ "${E2E_USERS}" =~ ^[1-9][0-9]*$ ]] || fail "E2E_USERS must be a positive integer"
[[ -f "${NEMOCLAW_V1_STATE_DIR}/terraform.tfstate" ]] \
  || fail "missing ${NEMOCLAW_V1_STATE_DIR}/terraform.tfstate. Apply the v1 YAML first."

# Pod name is <workspace>--<sandbox>, and the state's workspace already starts with nc-.
workspace="$(jq -r '[.resources[] | select(.type == "fabric_agent") | .instances[].attributes.sandbox.workspace] | first // empty' \
  "${NEMOCLAW_V1_STATE_DIR}/terraform.tfstate")"
[[ -n "${workspace}" ]] || fail "no fabric_agent sandbox in ${NEMOCLAW_V1_STATE_DIR}/terraform.tfstate"
export SANDBOX_PREFIX="${workspace}--user-"

hpa_common_require_live_runtime "${NAMESPACE}" "${HPA_NAME}" "${INFERENCE_RUNTIME}" \
  || fail "the GPU chart is not serving ${INFERENCE_RUNTIME}"

echo "Client: ${E2E_USERS} end users → ${E2E_USERS} NemoClaw v1 sandboxes (1:1 fabric-agent-ctl invoke)."
echo "HPA metric: ${HPA_METRIC:-unknown}  inflight/user: ${INFLIGHT}  max_tokens: ${MAX_TOKENS}  target GPUs: ${TARGET_PODS}"
agent_common_print_load_banner "${DURATION_SEC}" "${MAX_REPLICAS_HOLD_SEC}" hermes

unhealthy=0
for ((i = 0; i < E2E_USERS; i += 1)); do
  name="$(printf '%s%04d' "${SANDBOX_PREFIX}" "${i}")"
  phase="$(kubectl get pod "${name}" -n "${V1_NAMESPACE}" -o jsonpath='{.status.phase}' 2>/dev/null || true)"
  ready="$(kubectl get pod "${name}" -n "${V1_NAMESPACE}" -o jsonpath='{.status.containerStatuses[0].ready}' 2>/dev/null || true)"
  if [[ "${phase}" == "Running" && "${ready}" == "true" ]]; then
    echo "  user ${i} → ${name}: Ready"
  else
    echo "ERROR: sandbox ${name} is not Ready (phase=${phase:-missing} ready=${ready:-missing}). Apply a YAML with ${E2E_USERS} sandboxes first." >&2
    unhealthy=1
  fi
done
((unhealthy == 0)) || fail "client will not send chats until every sandbox pod is Ready"

mkdir -p "${E2E_OUTPUT_DIR}"
agent_common_start_hpa_timeline "${E2E_OUTPUT_DIR}" 0
cd "${CHART_DIR}" || fail "cannot cd to ${CHART_DIR}"
hpa_common_arm_hpa_for_client "${NAMESPACE}" "${HPA_NAME}" "${TARGET_PODS}"
exec python3 "${SCRIPT_DIR}/e2e-hermes-v1-load-test.py" \
  --users "${E2E_USERS}" \
  --prefix "${SANDBOX_PREFIX}" \
  --output "${E2E_OUTPUT_DIR}" \
  --duration "${DURATION_SEC}" \
  --inflight-per-user "${E2E_INFLIGHT_PER_USER}" \
  --inflight-start "${E2E_INFLIGHT_START_PER_USER}" \
  --target-pods "${TARGET_PODS}" \
  --hold-sec "${MAX_REPLICAS_HOLD_SEC}" \
  --hpa-namespace "${NAMESPACE}" \
  --hpa-name "${HPA_NAME}" \
  --scale-down-wait-loops "${SCALE_DOWN_WAIT_LOOPS}"
