#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# End-user client for the OpenClaw + Ollama e2e. One simulated user per
# sandbox (1:1). user-i sends chat.send to sandbox i
# on that sandbox's :18789. Clients do not build images, create sandboxes,
# start OpenClaw, or set the HPA metric.
#
# Provision first (other terminal):
#   ./scripts/agentscaling_gpuutil.sh   # GPU util HPA (this DGX success path)
#   ./scripts/agentscaling_latency.sh   # LLM latency HPA (same client)
#
# This DGX GPU-util run: 5 users, inflight 1, 8Gi, MAX_TOKENS=1024
# (same client pin as client_deepagents.sh). 2048 kept latency ~7s even
# at 8 replicas (target 3000 ms). Inflight 2 OOMed a CPU node (dgx-19).
# Do not raise inflight without extra sandbox RAM.
# Users never talk to the Envoy load balancer. OpenShell is only the exec
# tunnel into each sandbox; it is not the user-facing listener.
#
# Usage (on dgx-20, or from a laptop via: ssh you@dgx-20):
#   cd deploy/helm/gpu_autoscaling_k8s
#   E2E_USERS=5 ./scripts/client.sh
# Do not install OpenShell on the laptop. Agent :18789 is inside the sandbox
# netns on the DGX CPUs.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=agent-common.sh
source "${SCRIPT_DIR}/agent-common.sh"
# shellcheck source=hpa-common.sh
source "${SCRIPT_DIR}/hpa-common.sh"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

export PATH="${HOME}/.local/bin:${PATH}"
export E2E_USERS="${E2E_USERS:-5}"
export SANDBOX_PREFIX="${SANDBOX_PREFIX:-openclaw-ollama-e2e-}"
export INFERENCE_RUNTIME="${INFERENCE_RUNTIME:-$(agent_common_default_inference_runtime openclaw)}"
agent_common_validate_inference_runtime "${INFERENCE_RUNTIME}"
export OPENSHELL_NAMESPACE="${OPENSHELL_NAMESPACE:-nemoclaw-sandboxes}"
export NAMESPACE="${NAMESPACE:-nemoclaw-gpu}"
export HPA_NAME="${HPA_NAME:-nemoclaw-gpu-metrics-proxy}"
export TARGET_PODS="${TARGET_PODS:-8}"
export DURATION_SEC="${DURATION_SEC:-900}"
export MAX_TOKENS="${MAX_TOKENS:-1024}"
export E2E_PROMPT_TIMEOUT_SEC="${E2E_PROMPT_TIMEOUT_SEC:-600}"
export E2E_INFLIGHT_START_PER_USER="${E2E_INFLIGHT_START_PER_USER:-1}"
export E2E_INFLIGHT_PER_USER="${E2E_INFLIGHT_PER_USER:-1}"
export MAX_REPLICAS_HOLD_SEC="${MAX_REPLICAS_HOLD_SEC:-0}"
export SCALE_DOWN_WAIT_LOOPS="${SCALE_DOWN_WAIT_LOOPS:-40}"
E2E_OUTPUT_DIR="${E2E_OUTPUT_DIR:-${CHART_DIR}/e2e-results/openclaw-ollama}"

command -v openshell >/dev/null 2>&1 || fail "missing command: openshell"
command -v kubectl >/dev/null 2>&1 || fail "missing command: kubectl"
command -v python3 >/dev/null 2>&1 || fail "missing command: python3"

[[ "${E2E_USERS}" =~ ^[1-9][0-9]*$ ]] || fail "E2E_USERS must be a positive integer"
openshell status >/dev/null \
  || fail "OpenShell is not connected. In another terminal run ./scripts/openshell-port-forward.sh. Then rerun this command."
hpa_common_require_live_runtime "${NAMESPACE}" "${HPA_NAME}" "${INFERENCE_RUNTIME}" \
  || fail "client.sh will not send chats until GPU pods are ${INFERENCE_RUNTIME}. Re-run agentscaling_* with INFERENCE_RUNTIME=${INFERENCE_RUNTIME}."

echo "Client: ${E2E_USERS} end users → ${E2E_USERS} OpenShell sandboxes (1:1). No sandbox create. HPA metric is not set here."
missing=0
for ((i = 0; i < E2E_USERS; i += 1)); do
  name="$(printf '%s%04d' "${SANDBOX_PREFIX}" "${i}")"
  if ! kubectl get pod "${name}" -n "${OPENSHELL_NAMESPACE}" >/dev/null 2>&1; then
    echo "ERROR: sandbox ${i} does not exist (user ${i}). Run ./scripts/agentscaling_gpuutil.sh or ./scripts/agentscaling_latency.sh first." >&2
    missing=1
    continue
  fi
  echo "  user ${i} → sandbox ${i} :18789"
done
((missing == 0)) || fail "clients do not create sandboxes; start them with ./scripts/agentscaling_gpuutil.sh or ./scripts/agentscaling_latency.sh"

echo "Checking each sandbox listens on :18789 (do not send chat if this fails)"
unhealthy=0
for ((i = 0; i < E2E_USERS; i += 1)); do
  name="$(printf '%s%04d' "${SANDBOX_PREFIX}" "${i}")"
  # curl %{http_code} is literal; do not expand it in the sandbox shell.
  # shellcheck disable=SC2016
  # shellcheck disable=SC2016 # remote script: $ns/$code must expand inside the sandbox
  if kubectl exec -n "${OPENSHELL_NAMESPACE}" "${name}" -c agent -- bash -c '
    for ns in /run/netns/*; do
      [ -e "$ns" ] || continue
      code="$(nsenter --net="$ns" curl -sS -o /dev/null -w "%{http_code}" --max-time 2 http://127.0.0.1:18789/health 2>/dev/null || true)"
      case "$code" in 200|401) exit 0 ;; esac
    done
    exit 1
  ' >/dev/null 2>&1; then
    echo "  sandbox ${i}: :18789 up"
  else
    echo "ERROR: sandbox ${i} is Running but OpenClaw is not listening on :18789. Run agentscaling_gpuutil.sh or agentscaling_latency.sh start." >&2
    unhealthy=1
  fi
done
((unhealthy == 0)) || fail "client will not send chat until every sandbox listens on :18789"

echo "Pinning OpenClaw max_tokens=${MAX_TOKENS} (keep provisioned model; one chat.send per sandbox)"
for ((i = 0; i < E2E_USERS; i += 1)); do
  name="$(printf '%s%04d' "${SANDBOX_PREFIX}" "${i}")"
  agent_common_pin_openclaw_max_tokens "${name}" \
    || fail "could not pin max_tokens on sandbox ${i}"
done

mkdir -p "${E2E_OUTPUT_DIR}"
cd "${CHART_DIR}" || fail "cannot cd to ${CHART_DIR}"
hpa_common_hold_hpa_until_client "${NAMESPACE}" "${HPA_NAME}" "${HPA_NAME}" \
  || fail "HPA is not 1 replica; leftover load would scale before chats start"
hpa_common_arm_hpa_for_client "${NAMESPACE}" "${HPA_NAME}" "${TARGET_PODS:-8}"
exec python3 "${SCRIPT_DIR}/e2e-openclaw-ollama-load-test.py" \
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
