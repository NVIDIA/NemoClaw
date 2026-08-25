#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Install GPU HPA (DCGM → prometheus-adapter → gpu_utilization_percent) and, when
# ENABLE_ENVOY_LB=1 (default), the Envoy Gateway control plane that load-balances
# traffic across HPA replicas with LeastRequest. Set ENABLE_ENVOY_LB=0 to skip Envoy
# and use the metrics-proxy Service only.
# Script output is HPA-focused only; see ../README.md for full operations.
#
# Usage:
#   cd deploy/helm/gpu_autoscaling_k8s
#   ./scripts/install-hpa.sh
#   ENABLE_ENVOY_LB=0 ./scripts/install-hpa.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=hpa-common.sh
source "${SCRIPT_DIR}/hpa-common.sh"
hpa_common_load_local_env "${CHART_DIR}"

NAMESPACE="${NAMESPACE:-nemoclaw-gpu}"
RELEASE="${RELEASE:-nemoclaw-gpu}"
MONITORING_NS="${MONITORING_NS:-monitoring}"
DCGM_NAMESPACE="${DCGM_NAMESPACE:-gpu-operator-resources}"
PROM_RELEASE="${PROM_RELEASE:-kube-prometheus}"
ADAPTER_RELEASE="${ADAPTER_RELEASE:-prometheus-adapter}"
# 0 (default) preserves the Brev-tested behavior: use the configured release and install
# it if missing. Set auto to discover/reuse one deployed kube-prometheus-stack in another
# namespace, or 1 to require the configured release to already exist. The adapter is always
# configured with this recipe's GPU HPA rules.
USE_EXISTING_PROMETHEUS="${USE_EXISTING_PROMETHEUS:-0}"
INGRESS_NS="${INGRESS_NS:-envoy-gateway-system}"
INGRESS_RELEASE="${INGRESS_RELEASE:-eg}"
INGRESS_CLASS="${INGRESS_CLASS:-eg}"
INGRESS_SERVICE_TYPE="${INGRESS_SERVICE_TYPE:-ClusterIP}"
INGRESS_HELM_TIMEOUT="${INGRESS_HELM_TIMEOUT:-5m}"
INGRESS_HOST="${INGRESS_HOST:-}"
# Pinned to reviewed chart versions — installing by name alone (no --version) would let a
# later run silently pull whatever the maintainers most recently published upstream.
# Bump deliberately: `helm search repo <repo>/<chart> --versions` to pick a new version.
PROM_CHART_VERSION="${PROM_CHART_VERSION:-87.19.0}"
ADAPTER_CHART_VERSION="${ADAPTER_CHART_VERSION:-5.3.0}"
# shellcheck disable=SC1091
source "${CHART_DIR}/versions.env"
ENVOY_GATEWAY_CHART_VERSION="${ENVOY_GATEWAY_CHART_VERSION:-v1.8.3}"
DEPLOYMENT="${DEPLOYMENT:-$(RELEASE="${RELEASE}" CHART_NAME=nemoclaw-gpu hpa_common_metrics_proxy_deployment)}"
HPA_NAME="${HPA_NAME:-${DEPLOYMENT}}"
HPA_VALUES="${HPA_VALUES:-${CHART_DIR}/values.yaml}"
MIN_REPLICAS="${MIN_REPLICAS:-1}"
# Empty → resolve to allocatable GPU count after GPU nodes are verified (MAX_REPLICAS=N).
MAX_REPLICAS="${MAX_REPLICAS:-}"
ROLLOUT_TIMEOUT="${ROLLOUT_TIMEOUT:-900}"
INFERENCE_MODEL="${INFERENCE_MODEL:-llama3.2:3b}"
# ollama | vllm | nim — see README runtime comparison table. Switching runtimes usually also
# means changing INFERENCE_MODEL to match (e.g. an HF repo id for vllm, a NIM catalog id for nim).
INFERENCE_RUNTIME="${INFERENCE_RUNTIME:-ollama}"
GPU_TARGET="${GPU_TARGET:-40}"
PROM_HELM_TIMEOUT="${PROM_HELM_TIMEOUT:-25m}"
PROM_VALUES="${PROM_VALUES:-${CHART_DIR}/monitoring/kube-prometheus-microk8s.yaml}"
ADAPTER_VALUES="${ADAPTER_VALUES:-${CHART_DIR}/monitoring/prometheus-adapter-gpu-values.yaml}"

require_cmd kubectl
require_cmd helm
hpa_common_verify_target_node 0 || exit 1

if [[ ${#DCGM_NAMESPACE} -gt 63 || ! "${DCGM_NAMESPACE}" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]]; then
  echo "DCGM_NAMESPACE must be a valid Kubernetes namespace name" >&2
  exit 1
fi

case "${USE_EXISTING_PROMETHEUS}" in
  0 | 1 | auto) ;;
  *)
    echo "USE_EXISTING_PROMETHEUS must be auto, 0, or 1" >&2
    exit 1
    ;;
esac

case "${INGRESS_SERVICE_TYPE}" in
  ClusterIP | NodePort | LoadBalancer) ;;
  *)
    echo "INGRESS_SERVICE_TYPE must be ClusterIP, NodePort, or LoadBalancer" >&2
    exit 1
    ;;
esac
case "${INFERENCE_RUNTIME}" in
  ollama | vllm | nim) ;;
  *)
    echo "INFERENCE_RUNTIME must be ollama, vllm, or nim" >&2
    exit 1
    ;;
esac
hpa_common_require_nim_credentials "${INFERENCE_RUNTIME}" "${NAMESPACE}" || exit 1
case "${ENABLE_ENVOY_LB:-1}" in
  0 | 1) ;;
  *)
    echo "ENABLE_ENVOY_LB must be 0 or 1" >&2
    exit 1
    ;;
esac
# OpenShell's hostname-unrestricted cleartext HTTP listener must not be exposed via
# NodePort/LoadBalancer (would bypass hostname-scoped HTTPS redirect and Basic auth).
if hpa_common_envoy_lb_enabled && [[ "${INGRESS_SERVICE_TYPE}" != "ClusterIP" ]]; then
  echo "ENABLE_ENVOY_LB=1 requires INGRESS_SERVICE_TYPE=ClusterIP while the OpenShell cleartext HTTP listener is present. NodePort/LoadBalancer would expose that route externally and bypass Gateway TLS and Basic authentication. Use ClusterIP (port-forward), or set ENABLE_ENVOY_LB=0." >&2
  exit 1
fi
if [[ "${ALLOW_INSECURE_HTTP:-0}" == "1" && "${INGRESS_SERVICE_TYPE}" != "ClusterIP" ]]; then
  echo "ALLOW_INSECURE_HTTP=1 requires INGRESS_SERVICE_TYPE=ClusterIP" >&2
  exit 1
fi

# TLS / cleartext Gateway policy applies only when Envoy LB is enabled.
if hpa_common_envoy_lb_enabled; then
  case "${ALLOW_INSECURE_HTTP:-0}" in
    0)
      INGRESS_RENDER_ERROR=""
      if ! INGRESS_RENDER_ERROR="$(helm template ingress-policy-check "${CHART_DIR}" -f "${HPA_VALUES}" \
        --set ingress.gateway.enabled=true \
        --set ingress.allowInsecureHttp=false \
        --set ingress.auth.enabled=false 2>&1 >/dev/null)"; then
        if [[ "${INGRESS_RENDER_ERROR}" == *"ingress.tls is empty"* ]]; then
          echo "TLS is required when ENABLE_ENVOY_LB=1. Configure ingress.tls in HPA_VALUES, or set ALLOW_INSECURE_HTTP=1 for an isolated cluster." >&2
        else
          printf '%s\n' "${INGRESS_RENDER_ERROR}" >&2
        fi
        exit 1
      fi
      ;;
    1) ;;
    *)
      echo "ALLOW_INSECURE_HTTP must be 0 or 1" >&2
      exit 1
      ;;
  esac
fi

aggregated_api_ready() {
  local api_service="$1"
  local api_path="$2"

  # An APIService condition can temporarily be True when only one API server can
  # reach the backing service. Check the proxied endpoint repeatedly so HPA setup
  # does not continue on a flapping aggregated API.
  kubectl get apiservice "${api_service}" 2>/dev/null | grep -q True || return 1
  for _ in $(seq 1 3); do
    kubectl get --raw "${api_path}" >/dev/null 2>&1 || return 1
  done
}

metrics_server_ready() {
  aggregated_api_ready v1beta1.metrics.k8s.io /apis/metrics.k8s.io/v1beta1
}

custom_metrics_ready() {
  aggregated_api_ready v1beta1.custom.metrics.k8s.io /apis/custom.metrics.k8s.io/v1beta1
}

helm_release_deployed() {
  local release="$1"
  local namespace="$2"
  local deployed_releases=""

  deployed_releases="$(helm list --namespace "${namespace}" --deployed --filter "^${release}$" -q 2>/dev/null)" || return 1
  [[ "${deployed_releases}" == "${release}" ]]
}

prometheus_service_name() {
  local svc=""
  svc="$(kubectl get svc -n "${MONITORING_NS}" \
    -l 'app=kube-prometheus-stack-prometheus' \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  if [[ -z "${svc}" ]]; then
    svc="$(kubectl get svc -n "${MONITORING_NS}" -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' \
      | grep -E 'kube-prome-prometheus$' | head -1 || true)"
  fi
  [[ -n "${svc}" ]] || return 1
  printf '%s' "${svc}"
}

discover_existing_prometheus_stack() {
  local candidate_namespace=""
  local candidate_release=""
  local selected=""
  local -a candidates=()
  local -A seen=()

  # A kube-prometheus-stack Prometheus CR retains the Helm release name/namespace in
  # annotations. Confirm that the release still exists because Helm intentionally leaves
  # some custom resources behind after an uninstall.
  while IFS=$'\t' read -r candidate_namespace candidate_release; do
    [[ -n "${candidate_namespace}" && -n "${candidate_release}" ]] || continue
    helm_release_deployed "${candidate_release}" "${candidate_namespace}" || continue
    selected="${candidate_namespace}/${candidate_release}"
    [[ -n "${seen[${selected}]:-}" ]] && continue
    seen[${selected}]=1
    candidates+=("${selected}")
  done < <(kubectl get prometheus -A -l app.kubernetes.io/part-of=kube-prometheus-stack \
    -o jsonpath='{range .items[*]}{.metadata.namespace}{"\t"}{.metadata.annotations.meta\.helm\.sh/release-name}{"\n"}{end}' \
    2>/dev/null || true)

  case "${#candidates[@]}" in
    0) return 0 ;;
    1)
      MONITORING_NS="${candidates[0]%%/*}"
      PROM_RELEASE="${candidates[0]#*/}"
      USE_EXISTING_PROMETHEUS=1
      echo "Auto-discovered Prometheus release ${PROM_RELEASE} in namespace ${MONITORING_NS}; reusing it instead of installing a second stack." >&2
      ;;
    *)
      printf 'Multiple kube-prometheus-stack releases found: %s. Set MONITORING_NS and PROM_RELEASE, then set USE_EXISTING_PROMETHEUS=1.\n' "${candidates[*]}" >&2
      exit 1
      ;;
  esac
}

ensure_prometheus_stack() {
  local adapter_chart_version=""

  helm repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null 2>&1 || true
  helm repo update prometheus-community >/dev/null 2>&1 || helm repo update >/dev/null 2>&1

  if [[ "${USE_EXISTING_PROMETHEUS}" == "auto" ]] && ! helm_release_deployed "${PROM_RELEASE}" "${MONITORING_NS}"; then
    discover_existing_prometheus_stack
    [[ "${USE_EXISTING_PROMETHEUS}" == "auto" ]] && USE_EXISTING_PROMETHEUS=0
  fi

  if [[ "${USE_EXISTING_PROMETHEUS}" == "1" ]]; then
    helm_release_deployed "${PROM_RELEASE}" "${MONITORING_NS}" || {
      echo "Existing Prometheus release ${PROM_RELEASE} not found in namespace ${MONITORING_NS}. Set USE_EXISTING_PROMETHEUS=0 to let this recipe install its own stack, or correct MONITORING_NS/PROM_RELEASE." >&2
      exit 1
    }
    echo "Using existing Prometheus release ${PROM_RELEASE} in namespace ${MONITORING_NS}." >&2
  else
    kubectl create namespace "${MONITORING_NS}" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

    if ! helm_release_deployed "${PROM_RELEASE}" "${MONITORING_NS}"; then
      echo "Installing Prometheus release ${PROM_RELEASE} in namespace ${MONITORING_NS}; this can take up to ${PROM_HELM_TIMEOUT}." >&2
      helm upgrade --install "${PROM_RELEASE}" prometheus-community/kube-prometheus-stack \
        --namespace "${MONITORING_NS}" \
        --create-namespace \
        --version "${PROM_CHART_VERSION}" \
        -f "${PROM_VALUES}" \
        --set prometheus.prometheusSpec.serviceMonitorSelectorNilUsesHelmValues=false \
        --set prometheus.prometheusSpec.podMonitorSelectorNilUsesHelmValues=false \
        --set prometheus.prometheusSpec.ruleSelectorNilUsesHelmValues=false \
        --timeout "${PROM_HELM_TIMEOUT}" \
        --wait >/dev/null || {
        echo "Prometheus install failed. If this cluster already has a Prometheus stack, configure USE_EXISTING_PROMETHEUS=1 with its MONITORING_NS and PROM_RELEASE instead of installing a duplicate." >&2
        exit 1
      }
    fi
  fi

  echo "Waiting for Prometheus in namespace ${MONITORING_NS} to become ready." >&2
  kubectl wait --for=condition=ready pod \
    -l app.kubernetes.io/name=prometheus \
    -n "${MONITORING_NS}" \
    --timeout=600s >/dev/null || {
    echo "Prometheus is not ready in namespace ${MONITORING_NS} — GPU HPA metric pipeline unavailable" >&2
    exit 1
  }

  sed -e "s|__DCGM_NAMESPACE__|${DCGM_NAMESPACE}|g" \
    -e "s|__PROM_RELEASE__|${PROM_RELEASE}|g" \
    "${CHART_DIR}/monitoring/dcgm-servicemonitor.yaml" | kubectl apply -f - >/dev/null

  PROM_SVC="$(prometheus_service_name)" || {
    echo "Prometheus not found — GPU HPA metric pipeline unavailable" >&2
    exit 1
  }
  PROM_URL="http://${PROM_SVC}.${MONITORING_NS}.svc"

  if [[ "${USE_EXISTING_PROMETHEUS}" == "1" ]] && helm_release_deployed "${ADAPTER_RELEASE}" "${MONITORING_NS}"; then
    adapter_chart_version="$(helm get metadata "${ADAPTER_RELEASE}" -n "${MONITORING_NS}" -o json | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
    [[ -n "${adapter_chart_version}" ]] || {
      echo "Could not determine the installed chart version for Prometheus Adapter ${ADAPTER_RELEASE}." >&2
      exit 1
    }
    echo "Configuring existing Prometheus Adapter ${ADAPTER_RELEASE} with chart version ${adapter_chart_version}." >&2
    helm upgrade "${ADAPTER_RELEASE}" prometheus-community/prometheus-adapter \
      --namespace "${MONITORING_NS}" \
      --version "${adapter_chart_version}" \
      --reuse-values \
      -f "${ADAPTER_VALUES}" \
      --set rules.default=true \
      --set "prometheus.url=${PROM_URL}" \
      --set prometheus.port=9090 \
      --wait --timeout 10m >/dev/null
  else
    echo "Installing Prometheus Adapter ${ADAPTER_RELEASE} in namespace ${MONITORING_NS}." >&2
    helm upgrade --install "${ADAPTER_RELEASE}" prometheus-community/prometheus-adapter \
      --namespace "${MONITORING_NS}" \
      --version "${ADAPTER_CHART_VERSION}" \
      -f "${ADAPTER_VALUES}" \
      --set "prometheus.url=${PROM_URL}" \
      --set prometheus.port=9090 \
      --wait --timeout 10m >/dev/null
  fi

  for _ in $(seq 1 36); do
    custom_metrics_ready && break
    sleep 5
  done
  custom_metrics_ready || {
    echo "custom.metrics.k8s.io is not consistently reachable — HPA cannot use ${HPA_METRIC:-gpu_utilization} metrics. Check kubectl get apiservice v1beta1.custom.metrics.k8s.io and kubectl get --raw /apis/custom.metrics.k8s.io/v1beta1." >&2
    exit 1
  }
}

INFERENCE_MODEL="${INFERENCE_MODEL:-llama3.2:3b}"

ensure_envoy_gateway() {
  local class_exists=0
  kubectl get gatewayclass "${INGRESS_CLASS}" >/dev/null 2>&1 && class_exists=1

  if ! helm status "${INGRESS_RELEASE}" -n "${INGRESS_NS}" >/dev/null 2>&1 && [[ "${class_exists}" == "1" ]]; then
    # GatewayClass already provided by something this script does not manage — leave it alone.
    return 0
  fi

  helm upgrade --install "${INGRESS_RELEASE}" oci://docker.io/envoyproxy/gateway-helm \
    --namespace "${INGRESS_NS}" \
    --create-namespace \
    --version "${ENVOY_GATEWAY_CHART_VERSION}" \
    --timeout "${INGRESS_HELM_TIMEOUT}" \
    --wait >/dev/null

  kubectl wait --for=condition=available deployment \
    -l "control-plane=envoy-gateway" \
    -n "${INGRESS_NS}" \
    --timeout=300s >/dev/null 2>&1 || true

  # Envoy Gateway v1.8+ expects operators to create the GatewayClass; the Helm chart
  # no longer renders one by default.
  cat <<EOF | kubectl apply -f - >/dev/null
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: ${INGRESS_CLASS}
  labels:
    app.kubernetes.io/name: gateway-helm
    app.kubernetes.io/instance: ${INGRESS_RELEASE}
    app.kubernetes.io/managed-by: nemoclaw-gpu-install-hpa
spec:
  controllerName: gateway.envoyproxy.io/gatewayclass-controller
EOF

  for _ in $(seq 1 36); do
    kubectl get gatewayclass "${INGRESS_CLASS}" >/dev/null 2>&1 && break
    sleep 5
  done
  kubectl get gatewayclass "${INGRESS_CLASS}" >/dev/null 2>&1 || {
    echo "Envoy Gateway installed but GatewayClass ${INGRESS_CLASS} not found — Gateway cannot route traffic" >&2
    exit 1
  }
}

helm_install() {
  hpa_common_gpu_helm_upgrade "${RELEASE}" "${CHART_DIR}" "${NAMESPACE}" "${HPA_VALUES}" \
    "${MIN_REPLICAS}" "${MAX_REPLICAS}" "${GPU_TARGET}" "${INFERENCE_MODEL}" "${INGRESS_HOST}" \
    "${INFERENCE_RUNTIME}"
}

if command -v microk8s >/dev/null 2>&1; then
  microk8s enable gpu 2>/dev/null || true
  microk8s enable metrics-server 2>/dev/null || true
fi
for _ in $(seq 1 36); do
  metrics_server_ready && break
  sleep 5
done
metrics_server_ready || {
  echo "metrics-server is not consistently reachable — CPU/memory HPA APIs unavailable. Check kubectl get apiservice v1beta1.metrics.k8s.io and kubectl get --raw /apis/metrics.k8s.io/v1beta1." >&2
  exit 1
}
hpa_common_verify_gpu_nodes || exit 1
if [[ -z "${MAX_REPLICAS}" ]]; then
  MAX_REPLICAS="$(hpa_common_allocatable_gpus)"
fi
if [[ ! "${MAX_REPLICAS}" =~ ^[1-9][0-9]*$ ]]; then
  echo "MAX_REPLICAS must be a positive integer (got '${MAX_REPLICAS:-}')" >&2
  exit 1
fi
hpa_common_verify_gpu_capacity "${MAX_REPLICAS}" || exit 1
echo "HPA maxReplicas=${MAX_REPLICAS} (allocatable GPUs / MAX_REPLICAS)"
kubectl get pods -n "${DCGM_NAMESPACE}" -l app=nvidia-dcgm-exporter 2>/dev/null | grep -q Running || {
  echo "nvidia-dcgm-exporter not running in namespace ${DCGM_NAMESPACE} — GPU HPA metric unavailable" >&2
  exit 1
}

ensure_prometheus_stack
if hpa_common_envoy_lb_enabled; then
  ensure_envoy_gateway
else
  echo "ENABLE_ENVOY_LB=0: skipping Envoy Gateway install; inference uses the metrics-proxy Service only." >&2
fi

hpa_common_migrate_pre_metrics_proxy_resources "${NAMESPACE}" "${RELEASE}"

helm_install
# hpa_common_kick_deployment returns 0 when the Deployment is already healthy (or a
# rollout restart fixed it) and non-zero only after it deletes an unrecoverable
# Deployment — so helm_install must run on failure (to recreate it), not on success.
hpa_common_kick_deployment "${NAMESPACE}" "${DEPLOYMENT}" || helm_install

if ! hpa_common_wait_rollout "${DEPLOYMENT}" "${NAMESPACE}" "${ROLLOUT_TIMEOUT}"; then
  hpa_common_diagnose_rollout "${NAMESPACE}" "${DEPLOYMENT}"
  exit 1
fi

hpa_common_verify_hpa_bounds "${NAMESPACE}" "${DEPLOYMENT}" "${HPA_NAME}" "${MIN_REPLICAS}" "${MAX_REPLICAS}" || true
hpa_common_print_hpa "${NAMESPACE}"
