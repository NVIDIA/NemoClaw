#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Shared sandbox-side steps for OpenClaw + Ollama e2e. Sourced by
# agentscaling_gpuutil.sh and agentscaling_latency.sh. The caller must set
# HPA_METRIC (gpu_utilization or latency_avg). Clients do not source this.

agentscaling_common_fail() {
  echo "ERROR: $*" >&2
  exit 1
}

agentscaling_common_pin_openclaw_ollama() {
  export PATH="${HOME}/.local/bin:${PATH}"
  if [[ -n "${AGENT_NAME:-}" && "${AGENT_NAME}" != "openclaw" ]]; then
    agentscaling_common_fail "OpenClaw e2e (got AGENT_NAME=${AGENT_NAME})"
  fi
  export AGENT_NAME="openclaw"
  export INFERENCE_RUNTIME="${INFERENCE_RUNTIME:-$(agent_common_default_inference_runtime openclaw)}"
  agent_common_validate_runtime_pairing "${AGENT_NAME}" "${INFERENCE_RUNTIME}"
  INFERENCE_MODEL="$(agent_common_resolve_inference_model "${INFERENCE_RUNTIME}")"
  export INFERENCE_MODEL
  export NAMESPACE="${NAMESPACE:-nemoclaw-gpu}"
  export RELEASE="${RELEASE:-nemoclaw-gpu}"
  if [[ "${NAMESPACE}" != "nemoclaw-gpu" || "${RELEASE}" != "nemoclaw-gpu" ]]; then
    agentscaling_common_fail "uses NAMESPACE=nemoclaw-gpu RELEASE=nemoclaw-gpu (got ${NAMESPACE}/${RELEASE})"
  fi
  export ENABLE_ENVOY_LB="${ENABLE_ENVOY_LB:-1}"
  export ALLOW_INSECURE_HTTP="${ALLOW_INSECURE_HTTP:-0}"
  export ENABLE_AUTOSCALING="${ENABLE_AUTOSCALING:-1}"
  export MIN_REPLICAS="${MIN_REPLICAS:-1}"
  export MAX_REPLICAS="${MAX_REPLICAS:-8}"
  export TARGET_PODS="${TARGET_PODS:-8}"
  export SKIP_MONITORING="${SKIP_MONITORING:-1}"
  export USE_EXISTING_PROMETHEUS="${USE_EXISTING_PROMETHEUS:-1}"
  export INGRESS_SERVICE_TYPE="${INGRESS_SERVICE_TYPE:-ClusterIP}"
  export E2E_USERS="${E2E_USERS:-5}"
  export SANDBOX_PREFIX="${SANDBOX_PREFIX:-openclaw-ollama-e2e-}"
  AGENT_SANDBOX_IMAGE="$(agent_common_resolve_sandbox_image openclaw)"
  export AGENT_SANDBOX_IMAGE
  agent_common_require_sandbox_image_for_agent openclaw "${AGENT_SANDBOX_IMAGE}"
  export AGENT_SANDBOX_CPU="${AGENT_SANDBOX_CPU:-1}"
  export AGENT_SANDBOX_MEMORY="${AGENT_SANDBOX_MEMORY:-8Gi}"
  export NEMOCLAW_MINIMAL_BOOTSTRAP="${NEMOCLAW_MINIMAL_BOOTSTRAP:-1}"
  if [[ "${MIN_REPLICAS}" != "1" ]]; then
    agentscaling_common_fail "minReplicas must stay 1 (got MIN_REPLICAS=${MIN_REPLICAS})"
  fi
  if [[ "${MAX_REPLICAS}" != "8" || "${TARGET_PODS}" != "8" ]]; then
    agentscaling_common_fail "this 8×H100 path uses MAX_REPLICAS/TARGET_PODS=8"
  fi
  if [[ "${ENABLE_ENVOY_LB}" != "1" ]]; then
    agentscaling_common_fail "ENABLE_ENVOY_LB=1 is required so sandboxes reach GPUs through Envoy"
  fi
  if [[ "${ENABLE_AUTOSCALING}" != "1" ]]; then
    agentscaling_common_fail "ENABLE_AUTOSCALING=1 is required"
  fi
}

agentscaling_common_hpa_mode() {
  kubectl get hpa "${HPA_NAME}" -n "${NAMESPACE}" \
    -o jsonpath='{.metadata.annotations.nemoclaw\.ai/hpa-mode}' 2>/dev/null || true
}

agentscaling_common_chart_runtime() {
  hpa_common_live_inference_runtime "${NAMESPACE}" \
    "$(RELEASE="${RELEASE}" CHART_NAME=nemoclaw-gpu hpa_common_metrics_proxy_deployment)"
}

agentscaling_common_wait_baseline() {
  local deadline=$((SECONDS + HPA_BASELINE_WAIT_SEC))
  local hpa_status current desired
  echo "Waiting for HPA baseline 1/1 (up to ${HPA_BASELINE_WAIT_SEC}s)"
  while ((SECONDS < deadline)); do
    hpa_status="$(kubectl get hpa "${HPA_NAME}" -n "${NAMESPACE}" \
      -o jsonpath='{.status.currentReplicas}{" "}{.status.desiredReplicas}' 2>/dev/null || true)"
    read -r current desired <<<"${hpa_status}"
    if hpa_common_replicas_at_want "${current}" "${desired}" 1; then
      hpa_common_replicas_ready_message "${NAMESPACE}" "${HPA_NAME}" "${current}" "${desired}"
      return 0
    fi
    sleep 5
  done
  echo "HPA was not 1/1 after ${HPA_BASELINE_WAIT_SEC}s; continuing (current=${current:-?} desired=${desired:-?})"
}

agentscaling_common_apply_hpa() {
  local current_mode wanted="${HPA_METRIC}" current_runtime
  HPA_NAME="${HPA_NAME:-$(RELEASE="${RELEASE}" CHART_NAME=nemoclaw-gpu hpa_common_metrics_proxy_deployment)}"
  export HPA_NAME
  export INFERENCE_SERVICE="${INFERENCE_SERVICE:-$(RELEASE="${RELEASE}" CHART_NAME=nemoclaw-gpu hpa_common_metrics_proxy_service)}"
  current_mode="$(agentscaling_common_hpa_mode)"
  current_runtime="$(agentscaling_common_chart_runtime)"
  echo "Live GPU runtime=${current_runtime:-missing} HPA metric=${current_mode:-unknown} (want INFERENCE_RUNTIME=${INFERENCE_RUNTIME} + ${wanted})"
  if [[ "${SKIP_INSTALL_HPA}" == "1" ]]; then
    echo "SKIP_INSTALL_HPA=1; leaving runtime=${current_runtime:-unknown} HPA metric=${current_mode:-unknown}"
  elif [[ "${current_runtime}" == "${INFERENCE_RUNTIME}" && "${current_mode}" == "${wanted}" ]]; then
    echo "HPA ${NAMESPACE}/${HPA_NAME} already uses ${INFERENCE_RUNTIME} and ${wanted}"
  else
    echo "Setting ${NAMESPACE}/${RELEASE} to INFERENCE_RUNTIME=${INFERENCE_RUNTIME} + HPA ${wanted} (minReplicas=1 maxReplicas=${MAX_REPLICAS})"
    SKIP_MONITORING=1 USE_EXISTING_PROMETHEUS=1 \
      INFERENCE_RUNTIME="${INFERENCE_RUNTIME}" \
      INFERENCE_MODEL="${INFERENCE_MODEL}" \
      HPA_METRIC="${wanted}" \
      ALLOW_INSECURE_HTTP="${ALLOW_INSECURE_HTTP}" \
      "${SCRIPT_DIR}/install-hpa.sh"
  fi
  hpa_common_require_live_runtime "${NAMESPACE}" "${HPA_NAME}" "${INFERENCE_RUNTIME}" \
    || agentscaling_common_fail "OpenClaw will not start sandboxes until the GPU pods are ${INFERENCE_RUNTIME}"
  kubectl get gateway "${HPA_NAME}" -n "${NAMESPACE}" >/dev/null 2>&1 \
    || agentscaling_common_fail "Gateway ${HPA_NAME} missing in ${NAMESPACE}; sandboxes cannot use Envoy"
  hpa_common_wait_for_envoy_dataplane_on_target_node "${NAMESPACE}" "${HPA_NAME}" 180
  if [[ "${wanted}" == "latency_avg" ]]; then
    kubectl get apiservice v1beta1.custom.metrics.k8s.io 2>/dev/null | grep -q True \
      || agentscaling_common_fail "custom.metrics.k8s.io is not ready; latency HPA cannot run"
  fi
  hpa_common_hold_hpa_until_client "${NAMESPACE}" "${HPA_NAME}" "${HPA_NAME}" "${MAX_REPLICAS}" \
    || agentscaling_common_fail "HPA is not 1 current replica; leftover load would scale before client.sh"
  hpa_common_print_hpa "${NAMESPACE}" || true
  agentscaling_common_wait_baseline
}

agentscaling_common_main() {
  local cmd="${1:-bringup}"
  HPA_BASELINE_WAIT_SEC="${HPA_BASELINE_WAIT_SEC:-240}"
  LATENCY_METRIC_WAIT_SEC="${LATENCY_METRIC_WAIT_SEC:-180}"
  SKIP_INSTALL_HPA="${SKIP_INSTALL_HPA:-0}"
  agentscaling_common_pin_openclaw_ollama
  command -v openshell >/dev/null 2>&1 || agentscaling_common_fail "missing command: openshell"
  command -v kubectl >/dev/null 2>&1 || agentscaling_common_fail "missing command: kubectl"
  command -v python3 >/dev/null 2>&1 || agentscaling_common_fail "missing command: python3"
  openshell status >/dev/null \
    || agentscaling_common_fail "OpenShell is not connected. In another terminal run ./scripts/openshell-port-forward.sh. Then rerun this command."
  hpa_common_verify_target_node 1 || exit 1
  hpa_common_verify_gpu_capacity "${MAX_REPLICAS}" || exit 1
  kubectl get apiservice v1beta1.metrics.k8s.io 2>/dev/null | grep -q True \
    || agentscaling_common_fail "metrics-server not ready"
  if ! kubectl get gatewayclass "${INGRESS_CLASS:-eg}" >/dev/null 2>&1; then
    agentscaling_common_fail "GatewayClass ${INGRESS_CLASS:-eg} is missing"
  fi
  case "${cmd}" in
    stop | cleanup | layout | refresh-inference) ;;
    *)
      command -v helm >/dev/null 2>&1 || agentscaling_common_fail "missing command: helm"
      agentscaling_common_apply_hpa
      ;;
  esac
  "${SCRIPT_DIR}/setup-openclaw-ollama-e2e-sandboxes.sh" "${cmd}"
  case "${cmd}" in
    stop | cleanup)
      agent_common_stop_hpa_timeline "$(agent_common_e2e_output_dir openclaw)"
      ;;
    layout | refresh-inference) ;;
    *)
      hpa_common_hold_hpa_until_client "${NAMESPACE}" "${HPA_NAME}" "${HPA_NAME}" "${MAX_REPLICAS}" \
        || agentscaling_common_fail "HPA is not 1 current replica after sandbox bringup; leftover load would scale before client.sh"
      agent_common_stop_hpa_timeline "$(agent_common_e2e_output_dir openclaw)"
      agent_common_start_hpa_timeline "$(agent_common_e2e_output_dir openclaw)" 1
      ;;
  esac
}
