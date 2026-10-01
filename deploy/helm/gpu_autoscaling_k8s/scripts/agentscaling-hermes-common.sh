#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Shared sandbox-side steps for Hermes + vLLM e2e. Sourced by
# agentscaling_hermes_gpuutil.sh and agentscaling_hermes_latency.sh.
# The caller must set HPA_METRIC (gpu_utilization or latency_avg).
# Clients do not source this. Pairing (no HPA) is test-hermes-nim.sh.

agentscaling_hermes_common_fail() {
  echo "ERROR: $*" >&2
  exit 1
}

agentscaling_hermes_common_pin() {
  export PATH="${HOME}/.local/bin:${PATH}"
  if [[ -n "${AGENT_NAME:-}" && "${AGENT_NAME}" != "hermes" ]]; then
    agentscaling_hermes_common_fail "Hermes + vLLM e2e (got AGENT_NAME=${AGENT_NAME})"
  fi
  if [[ -n "${INFERENCE_RUNTIME:-}" && "${INFERENCE_RUNTIME}" != "vllm" ]]; then
    agentscaling_hermes_common_fail "Hermes + vLLM e2e (got INFERENCE_RUNTIME=${INFERENCE_RUNTIME}). Pairing without HPA is test-hermes-nim.sh."
  fi
  export AGENT_NAME="hermes"
  export INFERENCE_RUNTIME="vllm"
  agent_common_validate_runtime_pairing "${AGENT_NAME}" "${INFERENCE_RUNTIME}"
  export INFERENCE_MODEL="${INFERENCE_MODEL:-$(agent_common_default_inference_model "${INFERENCE_RUNTIME}")}"
  if [[ "${INFERENCE_MODEL}" != "nvidia/NVIDIA-Nemotron-3-Nano-4B-FP8" ]]; then
    agentscaling_hermes_common_fail "Hermes + vLLM uses nvidia/NVIDIA-Nemotron-3-Nano-4B-FP8 (got INFERENCE_MODEL=${INFERENCE_MODEL})"
  fi
  export NAMESPACE="${NAMESPACE:-nemoclaw-gpu}"
  export RELEASE="${RELEASE:-nemoclaw-gpu}"
  if [[ "${NAMESPACE}" != "nemoclaw-gpu" || "${RELEASE}" != "nemoclaw-gpu" ]]; then
    agentscaling_hermes_common_fail "uses NAMESPACE=nemoclaw-gpu RELEASE=nemoclaw-gpu (got ${NAMESPACE}/${RELEASE})"
  fi
  export ENABLE_ENVOY_LB="${ENABLE_ENVOY_LB:-1}"
  export ENABLE_AUTOSCALING="${ENABLE_AUTOSCALING:-1}"
  export MIN_REPLICAS="${MIN_REPLICAS:-1}"
  export MAX_REPLICAS="${MAX_REPLICAS:-8}"
  export TARGET_PODS="${TARGET_PODS:-8}"
  export SKIP_MONITORING="${SKIP_MONITORING:-1}"
  export USE_EXISTING_PROMETHEUS="${USE_EXISTING_PROMETHEUS:-1}"
  export INGRESS_SERVICE_TYPE="${INGRESS_SERVICE_TYPE:-ClusterIP}"
  # Fewer sandboxes than OpenClaw's 5×8Gi path. 2Gi is the floor so concurrent
  # hermes -z processes do not OOMKill the CPU cgroup (1Gi did with inflight 4).
  export E2E_USERS="${E2E_USERS:-3}"
  export SANDBOX_PREFIX="${SANDBOX_PREFIX:-hermes-e2e-}"
  export AGENT_SANDBOX_IMAGE="${AGENT_SANDBOX_IMAGE:-ghcr.io/nvidia/nemoclaw/hermes-sandbox@sha256:28b9578ab9676ef046de37fa6feb9b7b61824b87d77fd08978758bd01c03cb54}"
  export AGENT_SANDBOX_CPU="${AGENT_SANDBOX_CPU:-1}"
  export AGENT_SANDBOX_MEMORY="${AGENT_SANDBOX_MEMORY:-2Gi}"
  if [[ "${MIN_REPLICAS}" != "1" ]]; then
    agentscaling_hermes_common_fail "minReplicas must stay 1 (got MIN_REPLICAS=${MIN_REPLICAS})"
  fi
  if [[ "${MAX_REPLICAS}" != "8" || "${TARGET_PODS}" != "8" ]]; then
    agentscaling_hermes_common_fail "this 8×H100 path uses MAX_REPLICAS/TARGET_PODS=8"
  fi
  if [[ "${ENABLE_ENVOY_LB}" != "1" ]]; then
    agentscaling_hermes_common_fail "ENABLE_ENVOY_LB=1 is required so sandboxes reach GPUs through Envoy"
  fi
  if [[ "${ENABLE_AUTOSCALING}" != "1" ]]; then
    agentscaling_hermes_common_fail "ENABLE_AUTOSCALING=1 is required"
  fi
}

agentscaling_hermes_common_hpa_mode() {
  kubectl get hpa "${HPA_NAME}" -n "${NAMESPACE}" \
    -o jsonpath='{.metadata.annotations.nemoclaw\.ai/hpa-mode}' 2>/dev/null || true
}

agentscaling_hermes_common_chart_runtime() {
  helm get values "${RELEASE}" -n "${NAMESPACE}" -o json 2>/dev/null \
    | python3 -c 'import json,sys; print((json.load(sys.stdin).get("inference") or {}).get("runtime") or "")' \
    2>/dev/null || true
}

agentscaling_hermes_common_wait_baseline() {
  local deadline=$((SECONDS + HPA_BASELINE_WAIT_SEC))
  local hpa_status current desired
  echo "Waiting for HPA baseline 1/1 (up to ${HPA_BASELINE_WAIT_SEC}s)"
  while ((SECONDS < deadline)); do
    hpa_status="$(kubectl get hpa "${HPA_NAME}" -n "${NAMESPACE}" \
      -o jsonpath='{.status.currentReplicas}{" "}{.status.desiredReplicas}' 2>/dev/null || true)"
    read -r current desired <<<"${hpa_status}"
    if [[ "${current:-0}" == "1" && "${desired:-0}" == "1" ]]; then
      echo "HPA baseline ready: 1 current / 1 desired replica"
      return 0
    fi
    sleep 5
  done
  echo "HPA was not 1/1 after ${HPA_BASELINE_WAIT_SEC}s; continuing (current=${current:-?} desired=${desired:-?})"
}

agentscaling_hermes_common_apply_hpa() {
  local current_mode wanted="${HPA_METRIC}" current_runtime
  HPA_NAME="${HPA_NAME:-$(RELEASE="${RELEASE}" CHART_NAME=nemoclaw-gpu hpa_common_metrics_proxy_deployment)}"
  export HPA_NAME
  export INFERENCE_SERVICE="${INFERENCE_SERVICE:-$(RELEASE="${RELEASE}" CHART_NAME=nemoclaw-gpu hpa_common_metrics_proxy_service)}"
  current_mode="$(agentscaling_hermes_common_hpa_mode)"
  current_runtime="$(agentscaling_hermes_common_chart_runtime)"
  if [[ "${SKIP_INSTALL_HPA}" == "1" ]]; then
    echo "SKIP_INSTALL_HPA=1; leaving runtime=${current_runtime:-unknown} HPA metric=${current_mode:-unknown}"
  elif [[ "${current_runtime}" == "vllm" && "${current_mode}" == "${wanted}" ]]; then
    echo "HPA ${NAMESPACE}/${HPA_NAME} already uses vLLM and ${wanted}"
  else
    echo "Setting ${NAMESPACE}/${RELEASE} to vLLM + HPA ${wanted} (minReplicas=1 maxReplicas=8)"
    SKIP_MONITORING=1 USE_EXISTING_PROMETHEUS=1 \
      INFERENCE_RUNTIME=vllm \
      INFERENCE_MODEL="${INFERENCE_MODEL}" \
      HPA_METRIC="${wanted}" \
      "${SCRIPT_DIR}/install-hpa.sh"
  fi
  kubectl get gateway "${HPA_NAME}" -n "${NAMESPACE}" >/dev/null 2>&1 \
    || agentscaling_hermes_common_fail "Gateway ${HPA_NAME} missing in ${NAMESPACE}; sandboxes cannot use Envoy"
  hpa_common_wait_for_envoy_dataplane_on_target_node "${NAMESPACE}" "${HPA_NAME}" 180
  if [[ "${wanted}" == "latency_avg" ]]; then
    kubectl get apiservice v1beta1.custom.metrics.k8s.io 2>/dev/null | grep -q True \
      || agentscaling_hermes_common_fail "custom.metrics.k8s.io is not ready; latency HPA cannot run"
    echo "Waiting up to ${LATENCY_METRIC_WAIT_SEC}s for nemoclaw_llm_latency_avg_milliseconds"
    local ready=0
    local deadline=$((SECONDS + LATENCY_METRIC_WAIT_SEC))
    while ((SECONDS < deadline)); do
      if hpa_common_verify_gpu_hpa_metric "${NAMESPACE}" >/dev/null 2>&1; then
        ready=1
        break
      fi
      sleep 5
    done
    if [[ "${ready}" -ne 1 ]]; then
      hpa_common_verify_gpu_hpa_metric "${NAMESPACE}" || true
      agentscaling_hermes_common_fail "Latency metric did not appear within ${LATENCY_METRIC_WAIT_SEC}s"
    fi
  fi
  hpa_common_print_hpa "${NAMESPACE}" || true
  agentscaling_hermes_common_wait_baseline
}

agentscaling_hermes_common_main() {
  local cmd="${1:-bringup}"
  HPA_BASELINE_WAIT_SEC="${HPA_BASELINE_WAIT_SEC:-240}"
  LATENCY_METRIC_WAIT_SEC="${LATENCY_METRIC_WAIT_SEC:-180}"
  SKIP_INSTALL_HPA="${SKIP_INSTALL_HPA:-0}"
  agentscaling_hermes_common_pin
  command -v openshell >/dev/null 2>&1 || agentscaling_hermes_common_fail "missing command: openshell"
  command -v kubectl >/dev/null 2>&1 || agentscaling_hermes_common_fail "missing command: kubectl"
  command -v python3 >/dev/null 2>&1 || agentscaling_hermes_common_fail "missing command: python3"
  openshell status >/dev/null \
    || agentscaling_hermes_common_fail "OpenShell CLI cannot reach 127.0.0.1:8080. In another terminal run ./scripts/openshell-port-forward.sh. Then rerun this command."
  hpa_common_verify_target_node 1 || exit 1
  hpa_common_verify_gpu_capacity "${MAX_REPLICAS}" || exit 1
  kubectl get apiservice v1beta1.metrics.k8s.io 2>/dev/null | grep -q True \
    || agentscaling_hermes_common_fail "metrics-server not ready"
  if ! kubectl get gatewayclass "${INGRESS_CLASS:-eg}" >/dev/null 2>&1; then
    agentscaling_hermes_common_fail "GatewayClass ${INGRESS_CLASS:-eg} is missing"
  fi
  case "${cmd}" in
    stop | cleanup | layout | refresh-inference) ;;
    *)
      command -v helm >/dev/null 2>&1 || agentscaling_hermes_common_fail "missing command: helm"
      agentscaling_hermes_common_apply_hpa
      ;;
  esac
  echo "HPA metric=${HPA_METRIC}. Client ./scripts/client_hermes.sh does not set this."
  echo "After sandboxes are Ready, run the client in another terminal. Do not start Hermes gateways for this load path."
  exec "${SCRIPT_DIR}/setup-hermes-e2e-sandboxes.sh" "${cmd}"
}
