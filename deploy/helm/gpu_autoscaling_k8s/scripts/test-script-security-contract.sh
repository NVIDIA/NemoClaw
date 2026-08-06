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
trap 'rm -f "${TEST_TMP}/kubectl" "${TEST_TMP}/kubectl.log"; rmdir "${TEST_TMP}"' EXIT

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
elif [[ "$*" == get\ services* ]]; then
  case "${MOCK_SERVICE_MODE:-internal}" in
    internal)
      printf '%s' '{"items":[{"metadata":{"name":"ingress-nginx-controller"},"spec":{"type":"ClusterIP"},"status":{}}]}'
      ;;
    external)
      printf '%s' '{"items":[{"metadata":{"name":"ingress-nginx-controller"},"spec":{"type":"LoadBalancer"},"status":{"loadBalancer":{"ingress":[{"ip":"203.0.113.20"}]}}}]}'
      ;;
    missing)
      printf '%s' '{"items":[]}'
      ;;
  esac
elif [[ "$*" == get\ pods* ]]; then
  case "${MOCK_POD_MODE:-internal}" in
    internal)
      printf '%s' '{"items":[{"metadata":{"name":"ingress-nginx-controller"},"spec":{"hostNetwork":false,"containers":[{"ports":[{"containerPort":80}]}]}}]}'
      ;;
    host-network)
      printf '%s' '{"items":[{"metadata":{"name":"ingress-nginx-controller"},"spec":{"hostNetwork":true,"containers":[{}]}}]}'
      ;;
    host-port)
      printf '%s' '{"items":[{"metadata":{"name":"ingress-nginx-controller"},"spec":{"hostNetwork":false,"containers":[{"ports":[{"containerPort":80,"hostPort":80}]}]}}]}'
      ;;
  esac
else
  echo "unexpected kubectl call: $*" >&2
  exit 1
fi
MOCK
chmod +x "${TEST_TMP}/kubectl"

export MOCK_NODE_MODE=private
export MOCK_SERVICE_MODE=internal
export MOCK_POD_MODE=internal
[[ "$(PATH="${TEST_TMP}:${PATH}" ALLOW_INSECURE_HTTP=1 hpa_common_ingress_allow_insecure_value)" == "true" ]] \
  || fail "isolated ClusterIP ingress did not pass the cleartext preflight"

export MOCK_NODE_MODE=external
if PATH="${TEST_TMP}:${PATH}" ALLOW_INSECURE_HTTP=1 \
  hpa_common_ingress_allow_insecure_value >/dev/null 2>&1; then
  fail "cleartext preflight accepted a node ExternalIP"
fi

export MOCK_NODE_MODE=private
export MOCK_SERVICE_MODE=external
if PATH="${TEST_TMP}:${PATH}" ALLOW_INSECURE_HTTP=1 \
  hpa_common_ingress_allow_insecure_value >/dev/null 2>&1; then
  fail "cleartext preflight accepted an external ingress Service"
fi

export MOCK_SERVICE_MODE=missing
if PATH="${TEST_TMP}:${PATH}" ALLOW_INSECURE_HTTP=1 \
  hpa_common_ingress_allow_insecure_value >/dev/null 2>&1; then
  fail "cleartext preflight accepted an unverifiable ingress controller"
fi

export MOCK_SERVICE_MODE=internal
export MOCK_POD_MODE=host-network
if PATH="${TEST_TMP}:${PATH}" ALLOW_INSECURE_HTTP=1 \
  hpa_common_ingress_allow_insecure_value >/dev/null 2>&1; then
  fail "cleartext preflight accepted ingress controller hostNetwork"
fi

export MOCK_POD_MODE=host-port
if PATH="${TEST_TMP}:${PATH}" ALLOW_INSECURE_HTTP=1 \
  hpa_common_ingress_allow_insecure_value >/dev/null 2>&1; then
  fail "cleartext preflight accepted ingress controller hostPort"
fi

[[ "$(ALLOW_INSECURE_HTTP=0 hpa_common_ingress_allow_insecure_value)" == "false" ]] \
  || fail "cleartext opt-in default is not false"

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
  '{"items":[{"metadata":{"name":"gpu-hpa"},"spec":{"scaleTargetRef":{"kind":"Deployment","name":"agent"},"metrics":[{"type":"Pods","pods":{"metric":{"name":"gpu_utilization_percent"},"target":{"type":"AverageValue","averageValue":"40"}}}]},"status":{"currentMetrics":[{"type":"Pods","pods":{"current":{"averageValue":"30250m"}}}]}}]}' \
  'GPU utilization rate (avg per pod): current / target' \
  'GPU UTIL %' \
  '30.25%/40%'

KUBECTL_LOG="${TEST_TMP}/kubectl.log"
export KUBECTL_LOG

kubectl() {
  printf '%s\n' "$*" >>"${KUBECTL_LOG}"
  if [[ "$*" == *"get deployment/test-agent"* ]]; then
    printf '%s' "${MOCK_DEPLOYMENT_REPLICAS:-}"
  elif [[ "$*" == *"get pods"*"app.kubernetes.io/instance=test-release"* ]]; then
    printf 'agent-pod'
  elif [[ "$*" == *"get pods"*"job-name=test-load-job"* ]]; then
    printf 'load-pod'
  fi
}

: >"${KUBECTL_LOG}"
MOCK_DEPLOYMENT_REPLICAS=not-a-number \
  hpa_common_enforce_replica_floor test-namespace test-agent 2
grep -Fq 'patch deployment/test-agent -n test-namespace --type=merge -p {"spec":{"replicas":2}}' \
  "${KUBECTL_LOG}" || fail "malformed Deployment replica count did not trigger the replica floor"

: >"${KUBECTL_LOG}"
MOCK_DEPLOYMENT_REPLICAS=3 \
  hpa_common_enforce_replica_floor test-namespace test-agent 2
if grep -Fq 'patch deployment/test-agent' "${KUBECTL_LOG}"; then
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
  || fail "installer ingress Service does not default to ClusterIP"

echo "OK: recovery ownership, cleartext ingress security, and GPU HPA formatting contracts hold"
