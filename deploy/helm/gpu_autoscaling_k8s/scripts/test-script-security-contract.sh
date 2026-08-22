#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=hpa-common.sh
source "${SCRIPT_DIR}/hpa-common.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "${TEST_TMP}"' EXIT

cat >"${TEST_TMP}/kubectl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail

if [[ "$*" == "get hpa -n test-namespace -o json" ]]; then
  printf '%s' "${HPA_FORMAT_FIXTURE:?}"
elif [[ "$*" == "get nodes -o json" ]]; then
  case "${MOCK_NODE_MODE:-private}" in
    private)
      printf '%s' '{"items":[{"status":{"addresses":[{"type":"InternalIP","address":"10.1.2.3"}]}}]}'
      ;;
    external)
      printf '%s' '{"items":[{"status":{"addresses":[{"type":"InternalIP","address":"10.1.2.3"},{"type":"ExternalIP","address":"203.0.113.10"}]}}]}'
      ;;
  esac
elif [[ "$*" == get\ services\ -n\ envoy-gateway-system* ]]; then
  case "${MOCK_SERVICE_MODE:-missing}" in
    internal)
      printf '%s' '{"items":[{"metadata":{"name":"envoy-nemoclaw-gpu-metrics-proxy"},"spec":{"type":"ClusterIP"},"status":{}}]}'
      ;;
    external)
      printf '%s' '{"items":[{"metadata":{"name":"envoy-nemoclaw-gpu-metrics-proxy"},"spec":{"type":"LoadBalancer"},"status":{"loadBalancer":{"ingress":[{"ip":"203.0.113.20"}]}}}]}'
      ;;
    missing)
      printf '%s' '{"items":[]}'
      ;;
  esac
elif [[ "$*" == get\ pods\ -n\ envoy-gateway-system* ]]; then
  # Distinguish control-plane vs dataplane by label argument.
  if [[ "$*" == *app.kubernetes.io/component=proxy* ]]; then
    case "${MOCK_POD_MODE:-internal}" in
      internal)
        printf '%s' '{"items":[{"metadata":{"name":"envoy-proxy"},"spec":{"hostNetwork":false,"containers":[{"ports":[{"containerPort":10080}]}]}}]}'
        ;;
      host-network)
        printf '%s' '{"items":[{"metadata":{"name":"envoy-proxy"},"spec":{"hostNetwork":true,"containers":[{}]}}]}'
        ;;
      host-port)
        printf '%s' '{"items":[{"metadata":{"name":"envoy-proxy"},"spec":{"hostNetwork":false,"containers":[{"ports":[{"containerPort":10080,"hostPort":80}]}]}}]}'
        ;;
    esac
  else
    case "${MOCK_CONTROLLER_MODE:-internal}" in
      internal)
        printf '%s' '{"items":[{"metadata":{"name":"envoy-gateway"},"spec":{"hostNetwork":false,"containers":[{"ports":[{"containerPort":18000}]}]}}]}'
        ;;
      host-network)
        printf '%s' '{"items":[{"metadata":{"name":"envoy-gateway"},"spec":{"hostNetwork":true,"containers":[{}]}}]}'
        ;;
      host-port)
        printf '%s' '{"items":[{"metadata":{"name":"envoy-gateway"},"spec":{"hostNetwork":false,"containers":[{"ports":[{"containerPort":18000,"hostPort":18000}]}]}}]}'
        ;;
      missing)
        printf '%s' '{"items":[]}'
        ;;
    esac
  fi
elif [[ "$*" == get\ pods\ -n\ nemoclaw-gpu* || "$*" == get\ services\ -n\ nemoclaw-gpu* ]]; then
  printf '%s' '{"items":[]}'
else
  echo "unexpected kubectl call: $*" >&2
  exit 1
fi
MOCK
chmod +x "${TEST_TMP}/kubectl"

export MOCK_NODE_MODE=private
export MOCK_CONTROLLER_MODE=internal
export MOCK_SERVICE_MODE=missing
export MOCK_POD_MODE=internal
export INGRESS_NS=envoy-gateway-system
export NAMESPACE=nemoclaw-gpu
export INGRESS_SERVICE_TYPE=ClusterIP
[[ "$(PATH="${TEST_TMP}:${PATH}" ALLOW_INSECURE_HTTP=1 hpa_common_ingress_allow_insecure_value)" == "true" ]] \
  || fail "isolated Envoy Gateway control plane did not pass the cleartext preflight"

export MOCK_NODE_MODE=external
if PATH="${TEST_TMP}:${PATH}" ALLOW_INSECURE_HTTP=1 \
  hpa_common_ingress_allow_insecure_value >/dev/null 2>&1; then
  fail "cleartext preflight accepted a node ExternalIP"
fi

export MOCK_NODE_MODE=private
export MOCK_SERVICE_MODE=external
if PATH="${TEST_TMP}:${PATH}" ALLOW_INSECURE_HTTP=1 \
  hpa_common_ingress_allow_insecure_value >/dev/null 2>&1; then
  fail "cleartext preflight accepted an external Envoy dataplane Service"
fi

export MOCK_SERVICE_MODE=missing
export MOCK_CONTROLLER_MODE=missing
if PATH="${TEST_TMP}:${PATH}" ALLOW_INSECURE_HTTP=1 \
  hpa_common_ingress_allow_insecure_value >/dev/null 2>&1; then
  fail "cleartext preflight accepted a missing Envoy Gateway control plane"
fi

export MOCK_CONTROLLER_MODE=internal
export INGRESS_SERVICE_TYPE=LoadBalancer
if PATH="${TEST_TMP}:${PATH}" ALLOW_INSECURE_HTTP=1 \
  hpa_common_ingress_allow_insecure_value >/dev/null 2>&1; then
  fail "cleartext preflight accepted a non-ClusterIP dataplane Service type before Gateway creation"
fi
export INGRESS_SERVICE_TYPE=ClusterIP

export MOCK_CONTROLLER_MODE=host-network
if PATH="${TEST_TMP}:${PATH}" ALLOW_INSECURE_HTTP=1 \
  hpa_common_ingress_allow_insecure_value >/dev/null 2>&1; then
  fail "cleartext preflight accepted Envoy Gateway control-plane hostNetwork"
fi

export MOCK_CONTROLLER_MODE=host-port
if PATH="${TEST_TMP}:${PATH}" ALLOW_INSECURE_HTTP=1 \
  hpa_common_ingress_allow_insecure_value >/dev/null 2>&1; then
  fail "cleartext preflight accepted Envoy Gateway control-plane hostPort"
fi

export MOCK_CONTROLLER_MODE=internal
export MOCK_SERVICE_MODE=internal
export MOCK_POD_MODE=host-network
if PATH="${TEST_TMP}:${PATH}" ALLOW_INSECURE_HTTP=1 \
  hpa_common_ingress_allow_insecure_value >/dev/null 2>&1; then
  fail "cleartext preflight accepted Envoy dataplane hostNetwork"
fi

export MOCK_POD_MODE=host-port
if PATH="${TEST_TMP}:${PATH}" ALLOW_INSECURE_HTTP=1 \
  hpa_common_ingress_allow_insecure_value >/dev/null 2>&1; then
  fail "cleartext preflight accepted Envoy dataplane hostPort"
fi

[[ "$(ALLOW_INSECURE_HTTP=0 hpa_common_ingress_allow_insecure_value)" == "false" ]] \
  || fail "cleartext opt-in default is not false"

grep -Fq -- '--set autoscaling.maxGpus="${max}"' "${SCRIPT_DIR}/hpa-common.sh" \
  || fail "normal HPA upgrades do not synchronize the GPU cap with the requested maximum"
grep -Fq -- '--set autoscaling.maxGpus="${TARGET_PODS}"' "${SCRIPT_DIR}/hpa-load-test.sh" \
  || fail "load tests do not synchronize the GPU cap with the requested target"
grep -Fq 'hpa_common_verify_envoy_least_request_distribution' "${SCRIPT_DIR}/hpa-load-test.sh" \
  || fail "hpa-load-test.sh must verify Envoy LeastRequest distribution after scale-up"
grep -Fq 'hpa_common_verify_envoy_least_request_distribution()' "${SCRIPT_DIR}/hpa-common.sh" \
  || fail "hpa-common.sh must define the Envoy LeastRequest distribution helper"
grep -Fq 'hpa_common_sha_htpasswd_line' "${SCRIPT_DIR}/hpa-common.sh" \
  || fail "installer helpers do not generate Envoy {SHA} htpasswd"
grep -Fq 'ingress.auth.htpasswd' "${SCRIPT_DIR}/hpa-common.sh" \
  || fail "GPU Helm upgrades do not pass Envoy basic-auth htpasswd"

MOCK_ISOLATION_STATUS=17
hpa_common_verify_insecure_ingress_isolation() { return "${MOCK_ISOLATION_STATUS}"; }
if hpa_common_verify_insecure_ingress_isolation; then
  fail "cleartext preflight failure override unexpectedly passed"
else
  status=$?
  [[ "${status}" == "17" ]] || fail "cleartext preflight failure override returned ${status}"
fi
if ALLOW_INSECURE_HTTP=1 hpa_common_ingress_allow_insecure_value >/dev/null 2>&1; then
  fail "cleartext opt-in bypassed the isolation preflight"
else
  status=$?
  [[ "${status}" == "1" ]] || fail "cleartext opt-in did not return the preflight failure"
fi

MOCK_ISOLATION_STATUS=0
[[ "$(ALLOW_INSECURE_HTTP=1 hpa_common_ingress_allow_insecure_value)" == "true" ]] \
  || fail "verified cleartext opt-in did not return true"

if ALLOW_INSECURE_HTTP=yes hpa_common_ingress_allow_insecure_value >/dev/null 2>&1; then
  fail "invalid cleartext opt-in value was accepted"
fi

assert_hpa_format() {
  local fixture="${1:?fixture}"
  shift
  local output
  output="$(HPA_FORMAT_FIXTURE="${fixture}" PATH="${TEST_TMP}:${PATH}" \
    hpa_common_format_hpa test-namespace 1 script)"
  local expected
  for expected in "$@"; do
    [[ "${output}" == *"${expected}"* ]] \
      || fail "HPA output does not contain ${expected}: ${output}"
  done
}

assert_hpa_format \
  '{"items":[{"metadata":{"name":"gpu-hpa"},"spec":{"scaleTargetRef":{"kind":"Deployment","name":"metrics-proxy"},"metrics":[{"type":"Pods","pods":{"metric":{"name":"gpu_utilization_percent"},"target":{"type":"AverageValue","averageValue":"40"}}}]},"status":{"currentMetrics":[{"type":"Pods","pods":{"current":{"averageValue":"30250m"}}}]}}]}' \
  'GPU utilization rate (avg per pod): current / target' \
  'GPU UTIL %' \
  '30.25%/40%'

# Latency HPA targets are AbsoluteValue milliseconds; Kubernetes serializes 3000 as "3k".
assert_hpa_format \
  '{"items":[{"metadata":{"name":"latency-hpa"},"spec":{"scaleTargetRef":{"kind":"Deployment","name":"metrics-proxy"},"metrics":[{"type":"Pods","pods":{"metric":{"name":"nemoclaw_llm_latency_avg_milliseconds"},"target":{"type":"AverageValue","averageValue":"3k"}}}]},"status":{"currentMetrics":[{"type":"Pods","pods":{"current":{"averageValue":"1836"}}}]}}]}' \
  '1836/3000'

KUBECTL_LOG="${TEST_TMP}/kubectl.log"
export KUBECTL_LOG

kubectl() {
  printf '%s\n' "$*" >>"${KUBECTL_LOG}"
  if [[ "$*" == *"get deployment/test-metrics-proxy"* ]]; then
    printf '%s' "${MOCK_DEPLOYMENT_REPLICAS:-}"
  elif [[ "$*" == get\ node\ test-gpu* ]]; then
    case "${MOCK_NODE_INVENTORY_MODE:-target-ready}" in
      target-ready) printf 'test-gpu\tTrue\t5\ttrue\n' ;;
      target-not-ready) printf 'test-gpu\tFalse\t5\ttrue\n' ;;
      target-no-gpu) printf 'test-gpu\tTrue\t0\ttrue\n' ;;
      target-unlabeled) printf 'test-gpu\tTrue\t5\t\n' ;;
      missing) return 1 ;;
    esac
  elif [[ "$*" == get\ nodes* ]]; then
    printf 'gpu-a\tTrue\t4\ttrue\ngpu-b\tFalse\t8\ttrue\ngpu-c\tTrue\t2\ttrue\ngpu-unlabeled\tTrue\t9\t\n'
  elif [[ "$*" == *"get pods"*"app.kubernetes.io/instance=test-release"* ]]; then
    printf 'metrics-proxy-pod'
  elif [[ "$*" == *"get pods"*"job-name=test-load-job"* ]]; then
    printf 'load-pod'
  fi
}

: >"${KUBECTL_LOG}"
MOCK_NODE_INVENTORY_MODE=target-ready NEMOCLAW_TARGET_NODE=test-gpu \
  hpa_common_verify_gpu_nodes || fail "Ready target GPU node was rejected"
[[ "$(MOCK_NODE_INVENTORY_MODE=target-ready NEMOCLAW_TARGET_NODE=test-gpu hpa_common_allocatable_gpus)" == "5" ]] \
  || fail "target-node GPU count included another node"
[[ "$(NEMOCLAW_TARGET_NODE=test-gpu hpa_common_target_node_helm_value)" == 'nodeSelector.kubernetes\.io/hostname=test-gpu' ]] \
  || fail "target-node Helm selector is malformed"
if MOCK_NODE_INVENTORY_MODE=target-ready NEMOCLAW_TARGET_NODE=test-gpu \
  hpa_common_verify_gpu_capacity 6 >/dev/null 2>&1; then
  fail "target node accepted more replicas than its allocatable GPUs"
fi
if MOCK_NODE_INVENTORY_MODE=target-not-ready NEMOCLAW_TARGET_NODE=test-gpu \
  hpa_common_verify_target_node >/dev/null 2>&1; then
  fail "NotReady target node was accepted"
fi
if MOCK_NODE_INVENTORY_MODE=target-no-gpu NEMOCLAW_TARGET_NODE=test-gpu \
  hpa_common_verify_target_node >/dev/null 2>&1; then
  fail "target node without GPUs was accepted for GPU work"
fi
if MOCK_NODE_INVENTORY_MODE=target-unlabeled NEMOCLAW_TARGET_NODE=test-gpu \
  hpa_common_verify_target_node >/dev/null 2>&1; then
  fail "target node without the chart's GPU label was accepted for GPU work"
fi
if MOCK_NODE_INVENTORY_MODE=missing NEMOCLAW_TARGET_NODE=test-gpu \
  hpa_common_verify_target_node >/dev/null 2>&1; then
  fail "missing target node was accepted"
fi
if NEMOCLAW_TARGET_NODE='Not_A_Node' hpa_common_verify_target_node >/dev/null 2>&1; then
  fail "invalid target node name was accepted"
fi
[[ "$(NEMOCLAW_TARGET_NODE= hpa_common_allocatable_gpus)" == "6" ]] \
  || fail "portable GPU count included a NotReady node"

HELM_LOG="${TEST_TMP}/helm.log"
helm() {
  printf '%s\n' "$*" >>"${HELM_LOG}"
}
: >"${HELM_LOG}"
ALLOW_INSECURE_HTTP=0 NEMOCLAW_TARGET_NODE=test-gpu \
  hpa_common_gpu_helm_upgrade test-release /tmp/test-chart test-namespace /tmp/test-values.yaml
grep -Fq -- '--set-string nodeSelector.kubernetes\.io/hostname=test-gpu' "${HELM_LOG}" \
  || fail "GPU Helm upgrade did not apply the selected node"
grep -Fq -- '--set ingress.gateway.serviceType=ClusterIP' "${HELM_LOG}" \
  || fail "GPU Helm upgrade did not pin Envoy dataplane Service type"
grep -Fq -- '--set ingress.gateway.enabled=true' "${HELM_LOG}" \
  || fail "GPU Helm upgrade did not default Envoy LB to enabled"

: >"${HELM_LOG}"
ALLOW_INSECURE_HTTP=0 ENABLE_ENVOY_LB=0 NEMOCLAW_TARGET_NODE=test-gpu \
  hpa_common_gpu_helm_upgrade test-release /tmp/test-chart test-namespace /tmp/test-values.yaml
grep -Fq -- '--set ingress.gateway.enabled=false' "${HELM_LOG}" \
  || fail "GPU Helm upgrade did not honor ENABLE_ENVOY_LB=0"

[[ "$(ENABLE_ENVOY_LB=0 hpa_common_envoy_lb_helm_value)" == "false" ]] \
  || fail "ENABLE_ENVOY_LB=0 did not map to helm false"
[[ "$(ENABLE_ENVOY_LB=1 hpa_common_envoy_lb_helm_value)" == "true" ]] \
  || fail "ENABLE_ENVOY_LB=1 did not map to helm true"
[[ "$(ENABLE_ENVOY_LB=0 hpa_common_ingress_allow_insecure_value)" == "false" ]] \
  || fail "ENABLE_ENVOY_LB=0 should force allowInsecureHttp=false"
METRICS_PROXY_URL="$(ENABLE_ENVOY_LB=0 NAMESPACE=test-namespace RELEASE=test-release \
  hpa_common_metrics_proxy_service_base_url test-namespace test-release-metrics-proxy 8081)"
[[ "${METRICS_PROXY_URL}" == "http://test-release-metrics-proxy.test-namespace.svc.cluster.local:8081/v1" ]] \
  || fail "metrics-proxy Service base URL helper is wrong: ${METRICS_PROXY_URL}"

: >"${KUBECTL_LOG}"
MOCK_DEPLOYMENT_REPLICAS=not-a-number \
  hpa_common_enforce_replica_floor test-namespace test-metrics-proxy 2
grep -Fq 'patch deployment/test-metrics-proxy -n test-namespace --type=merge -p {"spec":{"replicas":2}}' \
  "${KUBECTL_LOG}" || fail "malformed Deployment replica count did not trigger the replica floor"

: >"${KUBECTL_LOG}"
MOCK_DEPLOYMENT_REPLICAS=3 \
  hpa_common_enforce_replica_floor test-namespace test-metrics-proxy 2
if grep -Fq 'patch deployment/test-metrics-proxy' "${KUBECTL_LOG}"; then
  fail "valid Deployment replica count above the floor triggered a patch"
fi

RELEASE=test-release CHART_NAME=nemoclaw-gpu \
  hpa_common_clear_stuck_pods test-namespace test-load-job

grep -q 'job-name=test-load-job' "${KUBECTL_LOG}" \
  || fail "load-test pod cleanup did not use the exact Job name"
grep -q 'app.kubernetes.io/name=nemoclaw-gpu,app.kubernetes.io/instance=test-release' \
  "${KUBECTL_LOG}" || fail "pod cleanup did not use the Helm release selector"
if grep -Eq -- '(^| )-l job-name( |$)' "${KUBECTL_LOG}"; then
  fail "pod cleanup used an existential job-name selector"
fi

: >"${KUBECTL_LOG}"
hpa_common_cleanup_load_test_resources test-namespace test-load-job
for resource in \
  'job test-load-job' \
  'rolebinding test-load-job-endpoints-reader' \
  'role test-load-job-endpoints-reader' \
  'serviceaccount test-load-job-sa' \
  'configmap test-load-job-scripts'; do
  grep -Fq "delete ${resource} -n test-namespace" "${KUBECTL_LOG}" \
    || fail "load-test cleanup did not delete ${resource}"
done

awk '
  /^cleanup$/ { cleanup_line = NR }
  /^trap - EXIT$/ && cleanup_line < NR { found = 1 }
  END { exit !found }
' "${SCRIPT_DIR}/hpa-load-test.sh" \
  || fail "load test does not run cleanup before disabling its EXIT trap"
if grep -q -- '--all' "${SCRIPT_DIR}/cluster-recover.sh"; then
  fail "cluster recovery contains namespace-wide deletion"
fi
# shellcheck disable=SC2016 # Match the literal default expression in the target script.
grep -Fq 'RESTART_MICROK8S="${RESTART_MICROK8S:-0}"' "${SCRIPT_DIR}/cluster-recover.sh" \
  || fail "cluster recovery enables a MicroK8s restart by default"
# shellcheck disable=SC2016 # Match the literal default expression in the target script.
grep -Fq 'INGRESS_SERVICE_TYPE="${INGRESS_SERVICE_TYPE:-ClusterIP}"' "${SCRIPT_DIR}/install-hpa.sh" \
  || fail "installer gateway Service does not default to ClusterIP"
grep -Fq 'ENABLE_ENVOY_LB=1 requires INGRESS_SERVICE_TYPE=ClusterIP while the OpenShell cleartext HTTP listener is present' \
  "${SCRIPT_DIR}/install-hpa.sh" \
  || fail "installer does not reject NodePort/LoadBalancer while OpenShell cleartext HTTP is present"
grep -Fq 'ingress.gateway.serviceType must be ClusterIP while the OpenShell cleartext HTTP listener is present' \
  "${SCRIPT_DIR}/../templates/gateway.yaml" \
  || fail "chart does not fail closed on non-ClusterIP while OpenShell cleartext HTTP is present"
# shellcheck disable=SC2016 # Match the literal default expression in the target script.
grep -Fq 'INGRESS_NS="${INGRESS_NS:-envoy-gateway-system}"' "${SCRIPT_DIR}/install-hpa.sh" \
  || fail "installer does not default to the Envoy Gateway namespace"

grep -Fq 'hpa_common_migrate_pre_metrics_proxy_resources' "${SCRIPT_DIR}/hpa-common.sh" \
  || fail "hpa-common.sh must define pre-metrics-proxy migration"
grep -Fq 'hpa_common_migrate_pre_metrics_proxy_resources' "${SCRIPT_DIR}/install-hpa.sh" \
  || fail "install-hpa.sh must migrate pre-metrics-proxy leftovers before helm upgrade"
grep -Fq 'hpa_common_migrate_pre_metrics_proxy_resources' "${SCRIPT_DIR}/hpa-load-test.sh" \
  || fail "hpa-load-test.sh must migrate pre-metrics-proxy leftovers"
grep -Fq 'hpa_common_migrate_pre_metrics_proxy_resources' "${SCRIPT_DIR}/hpa-reset.sh" \
  || fail "hpa-reset.sh must migrate pre-metrics-proxy leftovers"

# Migration must run before ensure/helm so historical *-agent pods cannot pin all GPUs.
assert_migrate_before_ensure() {
  local script="${1:?script}"
  awk '
    /hpa_common_migrate_pre_metrics_proxy_resources/ && !migrate { migrate = NR }
    /hpa_common_ensure_metrics_proxy_ready/ && !ensure { ensure = NR }
    END { exit !(migrate && ensure && migrate < ensure) }
  ' "${script}" \
    || fail "${script##*/} must call migrate before hpa_common_ensure_metrics_proxy_ready"
}
assert_migrate_before_ensure "${SCRIPT_DIR}/hpa-load-test.sh"
assert_migrate_before_ensure "${SCRIPT_DIR}/hpa-reset.sh"
awk '
  /hpa_common_migrate_pre_metrics_proxy_resources/ && !migrate { migrate = NR }
  /^helm_install$/ && !helm { helm = NR }
  END { exit !(migrate && helm && migrate < helm) }
' "${SCRIPT_DIR}/install-hpa.sh" \
  || fail "install-hpa.sh must call migrate before helm_install"

# Migration must target the historical basename (…-agent), not only the new …-metrics-proxy name.
KUBECTL_LOG="${TEST_TMP}/kubectl-migrate.log"
export KUBECTL_LOG
kubectl() {
  printf '%s\n' "$*" >>"${KUBECTL_LOG}"
  if [[ "$*" == *"get deployment/nemoclaw-gpu-agent"* ]]; then
    return 0
  fi
  if [[ "$*" == get\ deploy*app.kubernetes.io/instance=nemoclaw-gpu* ]]; then
    printf 'nemoclaw-gpu-agent\tagent\nnemoclaw-gpu-metrics-proxy\tgpu-metrics-proxy\n'
    return 0
  fi
  if [[ "$*" == *"get deployment/nemoclaw-gpu-metrics-proxy"* ]]; then
    printf 'gpu-metrics-proxy'
    return 0
  fi
  if [[ "$*" == get\ httproute* || "$*" == get\ referencegrant* || "$*" == get\ securitypolicy* \
    || "$*" == get\ backendtrafficpolicy* || "$*" == get\ envoyproxy* || "$*" == get\ configmap* \
    || "$*" == get\ servicemonitor* ]]; then
    printf 'httproute.gateway.networking.k8s.io/nemoclaw-gpu-agent\n'
    printf 'httproute.gateway.networking.k8s.io/nemoclaw-gpu-agent-http-redirect\n'
    printf 'httproute.gateway.networking.k8s.io/nemoclaw-gpu-metrics-proxy\n'
    return 0
  fi
  return 0
}
: >"${KUBECTL_LOG}"
RELEASE=nemoclaw-gpu hpa_common_migrate_pre_metrics_proxy_resources nemoclaw-gpu nemoclaw-gpu \
  || fail "pre-metrics-proxy migration failed"
grep -Fq 'delete deployment,service,hpa,gateway -n nemoclaw-gpu nemoclaw-gpu-agent' "${KUBECTL_LOG}" \
  || fail "migration did not delete historical pre-metrics-proxy Deployment/Service/HPA/Gateway"
grep -Fq 'httproute.gateway.networking.k8s.io/nemoclaw-gpu-agent' "${KUBECTL_LOG}" \
  || fail "migration did not delete historical Gateway API objects with the old basename"
if grep -Fq 'delete -n nemoclaw-gpu httproute.gateway.networking.k8s.io/nemoclaw-gpu-metrics-proxy' "${KUBECTL_LOG}"; then
  fail "migration must not delete the current *-metrics-proxy Gateway API objects"
fi
grep -Fq 'secret -n nemoclaw-gpu nemoclaw-gpu-agent-inference-api nemoclaw-gpu-agent-ingress-auth' \
  "${KUBECTL_LOG}" \
  || fail "migration did not remove orphaned historical keep-policy Secrets"
if ! grep -E -q 'get deployment/nemoclaw-gpu-agent' "${KUBECTL_LOG}"; then
  fail "migration did not probe the historical pre-metrics-proxy Deployment basename"
fi

echo "OK: node targeting, recovery ownership, Envoy Gateway cleartext security, LeastRequest, and Kubernetes HPA formatting contracts hold"
