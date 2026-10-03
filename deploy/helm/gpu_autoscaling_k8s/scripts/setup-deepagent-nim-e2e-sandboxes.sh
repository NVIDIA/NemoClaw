#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Create, start, stop, or destroy N OpenShell sandboxes (one Deep Agents agent per end
# user) for the Deep Agents Code + NIM HPA e2e. The model stays on NIM GPU pods in
# nemoclaw-gpu. Traffic: sandbox → inference.local → Envoy → NIM HPA.
#
# Sandboxes are light CPU front ends (default 1 CPU / 4Gi). They do not run
# inference; GPUs do. All sandboxes share one OpenShell gateway. bringup does
# not start a per-sandbox Deep Agents listener: the client uses dcode -n
# (no :8642). Prefer ./scripts/agentscaling_deepagents_gpuutil.sh or
# ./scripts/agentscaling_deepagents_latency.sh over calling this file directly.
#
# Does not run openshell gateway start, nemohermes launch, or the
# metrics-proxy chat-completions Job. Does not destroy sandboxes outside
# SANDBOX_PREFIX (default deepagent-nim-e2e-). Does not touch openclaw-ollama-e2e-*
# or deepagents-onprem.
#
# Usage:
#   cd deploy/helm/gpu_autoscaling_k8s
#   ./scripts/agentscaling_deepagents_gpuutil.sh                      # default E2E_USERS=3, GPU util HPA
#   E2E_USERS=3 ./scripts/agentscaling_deepagents_latency.sh bringup   # LLM latency HPA
#   ./scripts/setup-deepagent-nim-e2e-sandboxes.sh 3
#   ./scripts/setup-deepagent-nim-e2e-sandboxes.sh start
#   ./scripts/setup-deepagent-nim-e2e-sandboxes.sh refresh-inference
#   ./scripts/setup-deepagent-nim-e2e-sandboxes.sh stop
#   ./scripts/setup-deepagent-nim-e2e-sandboxes.sh cleanup
#
# Run ./scripts/uninstall-e2e.sh first if OpenClaw sandboxes or client.sh are still up.

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

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"
}

require_cmd openshell
require_cmd kubectl
require_cmd python3

export PATH="${HOME}/.local/bin:${PATH}"

E2E_USERS_FROM_ENV="${E2E_USERS:-}"
E2E_USERS="${E2E_USERS:-3}"
ACTION="${1:-}"
if [[ -z "${ACTION}" ]]; then
  ACTION="${E2E_USERS}"
fi
export AGENT_NAME="${AGENT_NAME:-deepagents}"
[[ "${AGENT_NAME}" == "deepagents" ]] \
  || fail "setup-deepagent-nim-e2e-sandboxes.sh is Deep Agents-only (got AGENT_NAME=${AGENT_NAME})"
agent_common_validate "${AGENT_NAME}"
export INFERENCE_RUNTIME="${INFERENCE_RUNTIME:-$(agent_common_default_inference_runtime deepagents)}"
agent_common_validate_runtime_pairing "${AGENT_NAME}" "${INFERENCE_RUNTIME}"
INFERENCE_MODEL="$(agent_common_resolve_inference_model "${INFERENCE_RUNTIME}")"
export INFERENCE_MODEL
AGENT_DISPLAY_NAME="$(agent_common_display_name "${AGENT_NAME}")"
SANDBOX_PREFIX="${SANDBOX_PREFIX:-deepagent-nim-e2e-}"
[[ "${SANDBOX_PREFIX}" =~ ^[a-z][a-z0-9-]{0,40}$ ]] \
  || fail "SANDBOX_PREFIX must be a lowercase Kubernetes-style prefix"
[[ "${SANDBOX_PREFIX}" == deepagent-nim-e2e-* || "${SANDBOX_PREFIX}" == "deepagent-nim-e2e-" ]] \
  || fail "SANDBOX_PREFIX must stay under deepagent-nim-e2e- so OpenClaw e2e / deepagents-onprem are not destroyed"

export NAMESPACE="${NAMESPACE:-nemoclaw-gpu}"
export RELEASE="${RELEASE:-nemoclaw-gpu}"
if [[ "${NAMESPACE}" != "nemoclaw-gpu" || "${RELEASE}" != "nemoclaw-gpu" ]]; then
  fail "Deep Agents Code + NIM e2e uses NAMESPACE=nemoclaw-gpu RELEASE=nemoclaw-gpu (got ${NAMESPACE}/${RELEASE})"
fi
export ENABLE_ENVOY_LB="${ENABLE_ENVOY_LB:-1}"
export INFERENCE_SERVICE="${INFERENCE_SERVICE:-$(RELEASE="${RELEASE}" CHART_NAME=nemoclaw-gpu hpa_common_metrics_proxy_service)}"
AGENT_SANDBOX_IMAGE="$(agent_common_resolve_sandbox_image deepagents)"
export AGENT_SANDBOX_IMAGE
agent_common_require_sandbox_image_for_agent deepagents "${AGENT_SANDBOX_IMAGE}"
export AGENT_SANDBOX_CPU="${AGENT_SANDBOX_CPU:-1}"
# 2Gi + inflight 2 OOMed dgx-19. 4Gi with inflight 1. 8Gi is OpenClaw-only.
export AGENT_SANDBOX_MEMORY="${AGENT_SANDBOX_MEMORY:-4Gi}"
export SKIP_CREATE_SMOKE="${SKIP_CREATE_SMOKE:-1}"
export SKIP_WAIT_INFERENCE_LOCAL="${SKIP_WAIT_INFERENCE_LOCAL:-1}"
export SKIP_INFERENCE_VERIFY="${SKIP_INFERENCE_VERIFY:-1}"
export OPENSHELL_PROVIDER_NAME="${OPENSHELL_PROVIDER_NAME:-$(agent_common_default_provider_name "${AGENT_NAME}")}"

STATE_DIR="${E2E_STATE_DIR:-${CHART_DIR}/e2e-results/deepagents-agents}"
mkdir -p "${STATE_DIR}"
E2E_SANDBOX_NS="${OPENSHELL_NAMESPACE:-nemoclaw-sandboxes}"
E2E_INFERENCE_URL=""
E2E_API_KEY=""

sandbox_name() {
  printf '%s%04d' "${SANDBOX_PREFIX}" "${1:?index}"
}

sandbox_label() {
  local name="${1:?}"
  local idx="${name#"${SANDBOX_PREFIX}"}"
  if [[ "${idx}" =~ ^[0-9]+$ ]]; then
    printf 'sandbox %s' "$((10#${idx}))"
  else
    printf '%s' "${name}"
  fi
}

list_prefix_sandboxes() {
  python3 - "${SANDBOX_PREFIX}" <<'PY'
import json, subprocess, sys
prefix = sys.argv[1]
try:
    raw = subprocess.check_output(["openshell", "sandbox", "list", "-o", "json"], text=True)
except subprocess.CalledProcessError:
    raise SystemExit(0)
try:
    items = json.loads(raw)
except json.JSONDecodeError:
    raise SystemExit(0)
names = []
if isinstance(items, list):
    for item in items:
        name = item.get("name") if isinstance(item, dict) else item
        if isinstance(name, str) and name.startswith(prefix):
            names.append(name)
elif isinstance(items, dict):
    for item in items.get("sandboxes") or items.get("items") or []:
        name = item.get("name") if isinstance(item, dict) else item
        if isinstance(name, str) and name.startswith(prefix):
            names.append(name)
for name in sorted(names):
    print(name)
PY
}

load_e2e_inference_env() {
  local secret_name secret_key gateway_name
  [[ -z "${E2E_INFERENCE_URL}" ]] || return 0
  gateway_name="$(RELEASE="${RELEASE}" CHART_NAME=nemoclaw-gpu hpa_common_metrics_proxy_deployment)"
  E2E_INFERENCE_URL="$(hpa_common_envoy_dataplane_pod_v1_url "${NAMESPACE}" "${gateway_name}")"
  [[ "${E2E_INFERENCE_URL}" =~ ^https?://.+/v1$ ]] \
    || fail "could not resolve Envoy dataplane URL"
  IFS=$'\t' read -r secret_name secret_key < <(
    hpa_common_inference_secret_contract \
      "${NAMESPACE}" "${RELEASE}" "${gateway_name}-inference-api"
  )
  E2E_API_KEY="$(
    kubectl get secret "${secret_name}" -n "${NAMESPACE}" -o json \
      | python3 -c 'import base64,json,sys; print(base64.b64decode(json.load(sys.stdin)["data"][sys.argv[1]]).decode())' \
        "${secret_key}"
  )"
  [[ -n "${E2E_API_KEY}" ]] || fail "inference API key is empty"
}

sandbox_pod_ready() {
  local name="${1:?sandbox}"
  kubectl get pod "${name}" -n "${E2E_SANDBOX_NS}" \
    -o jsonpath='{.status.phase}' 2>/dev/null | grep -qx Running \
    && [[ "$(kubectl get pod "${name}" -n "${E2E_SANDBOX_NS}" \
      -o jsonpath='{.status.containerStatuses[0].ready}' 2>/dev/null)" == "true" ]]
}

gateway_health_ok() {
  local name="${1:?sandbox}"
  # shellcheck disable=SC2016 # remote script: ${code} must expand inside the sandbox
  timeout --foreground 20 openshell sandbox exec -n "${name}" --no-tty -- \
    bash -c 'code="$(curl -sS -o /dev/null -w "%{http_code}" --max-time 3 http://localhost:8642/health 2>/dev/null || true)"; case "${code}" in 200|401) exit 0 ;; esac; exit 1' \
    >/dev/null 2>&1
}

print_e2e_layout() {
  local count="${1:?count}"
  local i name sandbox_st
  echo ""
  echo "========================================================================"
  echo "E2E test: ${AGENT_DISPLAY_NAME} + NIM"
  echo "------------------------------------------------------------------------"
  printf "  %-10s  %-12s  %s\n" "end user" "sandbox" "status"
  for ((i = 0; i < count; i += 1)); do
    name="$(sandbox_name "${i}")"
    if sandbox_pod_ready "${name}"; then
      sandbox_st="Ready"
    else
      sandbox_st="NOT READY"
    fi
    printf "  %-10s  %-12s  %s\n" "user ${i}" "sandbox ${i}" "${sandbox_st}"
  done
  echo "========================================================================"
}

refresh_openshell_inference_backend() {
  # One gateway-scoped provider for all e2e sandboxes. Envoy dataplane pod IP,
  # not ClusterIP (hairpin on a DGX H100 node drops SYNs).
  load_e2e_inference_env
  local log="${STATE_DIR}/openshell-provider.log"
  mkdir -p "${STATE_DIR}"
  if openshell provider get "${OPENSHELL_PROVIDER_NAME}" >/dev/null 2>&1; then
    OPENAI_API_KEY="${E2E_API_KEY}" openshell provider update "${OPENSHELL_PROVIDER_NAME}" \
      --credential OPENAI_API_KEY \
      --config "OPENAI_BASE_URL=${E2E_INFERENCE_URL}" \
      >>"${log}" 2>&1 || fail "openshell provider update ${OPENSHELL_PROVIDER_NAME} failed (see ${log})"
  else
    OPENAI_API_KEY="${E2E_API_KEY}" openshell provider create \
      --name "${OPENSHELL_PROVIDER_NAME}" \
      --type openai \
      --credential OPENAI_API_KEY \
      --config "OPENAI_BASE_URL=${E2E_INFERENCE_URL}" \
      >>"${log}" 2>&1 || fail "openshell provider create ${OPENSHELL_PROVIDER_NAME} failed (see ${log})"
  fi
  openshell inference set \
    --provider "${OPENSHELL_PROVIDER_NAME}" \
    --model "${INFERENCE_MODEL}" \
    --timeout 300 \
    --no-verify \
    >>"${log}" 2>&1 || fail "openshell inference set ${OPENSHELL_PROVIDER_NAME}/${INFERENCE_MODEL} failed (see ${log})"
}

inference_local_ok() {
  local name="${1:?sandbox}"
  # OpenShell MITM injects credentials. Do not copy the gateway API key into the sandbox.
  timeout --foreground 12 openshell sandbox exec -n "${name}" --no-tty -- \
    curl -fsS --http1.1 --max-time 5 https://inference.local/v1/models >/dev/null 2>&1
}

skip_connect_shell_nproc() {
  local name="${1:?sandbox}"
  # OpenShell exec sources this hook. harden+verify set nproc=512, and
  # RLIMIT_NPROC is per real UID on the node. Several e2e sandboxes share that
  # UID, so the verify fork fails with EAGAIN and dcode -n never runs.
  # shellcheck disable=SC2016 # remote script must not expand on the host
  kubectl exec -n "${E2E_SANDBOX_NS}" "${name}" -c agent -- bash -c '
    cat > /etc/profile.d/nemoclaw-rlimits.sh << "EOF"
# Connect-shell must not re-apply nproc=512 (RLIMIT_NPROC is per-UID on the node).
true
EOF
    if [[ -f /usr/local/lib/nemoclaw/sandbox-rlimits.sh ]]; then
      sed -i "s/^NEMOCLAW_SANDBOX_NPROC_LIMIT=512$/NEMOCLAW_SANDBOX_NPROC_LIMIT=8192/" \
        /usr/local/lib/nemoclaw/sandbox-rlimits.sh
    fi
  ' >/dev/null
}

start_one_gateway() {
  local name="${1:?sandbox}"
  local log="${STATE_DIR}/${name}.log"
  local pidfile="${STATE_DIR}/${name}.pid"
  if gateway_health_ok "${name}"; then
    return 0
  fi
  if [[ -f "${pidfile}" ]]; then
    local old_pid
    old_pid="$(cat "${pidfile}" 2>/dev/null || true)"
    if [[ -n "${old_pid}" ]] && kill -0 "${old_pid}" 2>/dev/null; then
      echo "  ${name}: waiting for existing nemoclaw-start pid ${old_pid}"
    else
      rm -f "${pidfile}"
    fi
  fi
  if [[ ! -f "${pidfile}" ]]; then
    openshell sandbox exec -n "${name}" --no-tty -- \
      /usr/local/bin/nemoclaw-start >"${log}" 2>&1 &
    echo $! >"${pidfile}"
  fi
  local i
  for ((i = 1; i <= 90; i += 1)); do
    if gateway_health_ok "${name}"; then
      return 0
    fi
    sleep 2
  done
  echo "ERROR: ${name} Deep Agents gateway did not become healthy; see ${log}" >&2
  return 1
}

stop_one_gateway() {
  local name="${1:?sandbox}"
  local pidfile="${STATE_DIR}/${name}.pid"
  if [[ -f "${pidfile}" ]]; then
    local pid
    pid="$(cat "${pidfile}" 2>/dev/null || true)"
    if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
      kill "${pid}" 2>/dev/null || true
      wait "${pid}" 2>/dev/null || true
    fi
    rm -f "${pidfile}"
  fi
  echo "  ${name}: gateway start process stopped"
}

count_from_existing() {
  local names max=0 n
  names="$(list_prefix_sandboxes)"
  [[ -n "${names}" ]] || fail "no ${SANDBOX_PREFIX}* sandboxes; run ./scripts/agentscaling_deepagents_gpuutil.sh or ./scripts/agentscaling_deepagents_latency.sh first"
  while IFS= read -r n; do
    [[ -z "${n}" ]] && continue
    n="${n#"${SANDBOX_PREFIX}"}"
    n=$((10#${n}))
    if ((n + 1 > max)); then
      max=$((n + 1))
    fi
  done <<<"${names}"
  printf '%s' "${max}"
}

start_gateways() {
  local count="${1:?count}"
  local i name
  echo "Starting Deep Agents gateways"
  for ((i = 0; i < count; i += 1)); do
    name="$(sandbox_name "${i}")"
    openshell sandbox get "${name}" >/dev/null 2>&1 \
      || fail "sandbox ${name} does not exist"
    start_one_gateway "${name}"
  done
}

stop_gateways() {
  local name
  echo "Stopping Deep Agents gateway start processes for ${SANDBOX_PREFIX}*"
  while IFS= read -r name; do
    [[ -z "${name}" ]] && continue
    stop_one_gateway "${name}"
  done < <(list_prefix_sandboxes)
}

cleanup_sandboxes() {
  local name
  local -a names=() pids=()
  stop_gateways || true
  echo "Destroying sandboxes named ${SANDBOX_PREFIX}* in parallel (not deepagents-onprem, not openclaw-ollama-e2e-*)"
  while IFS= read -r name; do
    [[ -z "${name}" ]] && continue
    names+=("${name}")
    echo "  destroying ${name}"
    openshell sandbox destroy "${name}" --force >/dev/null 2>&1 &
    pids+=("$!")
  done < <(list_prefix_sandboxes)
  for pid in "${pids[@]}"; do
    wait "${pid}" || true
  done
  echo "Cleanup complete (${#names[@]} ${SANDBOX_PREFIX}* sandboxes). deepagents-onprem was not touched."
}

create_one_sandbox() {
  local name="${1:?sandbox}"
  local log="${STATE_DIR}/${name}.create.log"
  echo "  creating ${name} (parallel, light ${AGENT_SANDBOX_CPU}/${AGENT_SANDBOX_MEMORY})"
  if AGENT_NAME=deepagents AGENT_SANDBOX_NAME="${name}" \
    SKIP_CREATE_SMOKE=1 \
    SKIP_WAIT_INFERENCE_LOCAL=1 \
    SKIP_INFERENCE_VERIFY=1 \
    stdbuf -oL -eL "${SCRIPT_DIR}/create-agent-sandbox.sh" >"${log}" 2>&1; then
    echo "  ${name}: sandbox Ready"
    return 0
  fi
  echo "ERROR: ${name}: create failed; see ${log}" >&2
  return 1
}

wait_inference_local_parallel() {
  local timeout_sec="${INFERENCE_LOCAL_TIMEOUT_SEC:-180}"
  local deadline=$((SECONDS + timeout_sec))
  local name
  ((${#} > 0)) || return 0
  echo "Checking https://inference.local on ${#} sandboxes one at a time (up to ${timeout_sec}s)"
  for name in "$@"; do
    while ! inference_local_ok "${name}"; do
      if ((SECONDS >= deadline)); then
        echo "ERROR: inference.local still failing for: ${name}" >&2
        return 1
      fi
      echo "  ${name}: still waiting for inference.local"
      sleep 2
    done
  done
}

bringup_one() {
  local name="${1:?sandbox}"
  if sandbox_pod_ready "${name}" && inference_local_ok "${name}"; then
    echo "  ${name}: reusing existing OpenShell sandbox"
    return 0
  fi
  if sandbox_pod_ready "${name}"; then
    echo "  ${name}: reusing existing OpenShell sandbox"
  else
    create_one_sandbox "${name}" || return 1
  fi
  skip_connect_shell_nproc "${name}" || return 1
  agent_common_pin_deepagents_model "${name}" "${INFERENCE_MODEL}" || return 1
}

bringup_sandboxes() {
  local count="${1:?count}"
  local i name started_at="${SECONDS}"
  local -a names=() pids=() failed=()
  [[ "${count}" =~ ^[1-9][0-9]*$ ]] || fail "sandbox count must be a positive integer"
  ((count <= 200)) || fail "refusing more than 200 sandboxes in one run"
  openshell status >/dev/null \
    || fail "OpenShell gateway is not connected; port-forward service/openshell and re-register the gateway"
  hpa_common_verify_target_node 1 || exit 1
  echo "E2E test: Deep Agents + NIM — ${count} sandboxes"
  rm -f "${E2E_OPENSHELL_LOG_DIR:-${CHART_DIR}/e2e-results/openshell-create}/.provider.done"
  refresh_openshell_inference_backend \
    || fail "could not update OpenShell provider ${OPENSHELL_PROVIDER_NAME} to ${E2E_INFERENCE_URL:-unknown}"
  for ((i = 0; i < count; i += 1)); do
    names+=("$(sandbox_name "${i}")")
  done
  for name in "${names[@]}"; do
    bringup_one "${name}" &
    pids+=("$!")
  done
  for i in "${!pids[@]}"; do
    if ! wait "${pids[$i]}"; then
      failed+=("${names[$i]}")
    fi
  done
  if ((${#failed[@]} > 0)); then
    fail "bringup failed for: ${failed[*]}"
  fi
  wait_inference_local_parallel "${names[@]}" \
    || fail "Envoy inference check failed after parallel sandbox create"
  echo "Ready: ${count} end users → ${count} Deep Agents in ${count} OpenShell sandboxes; LLM on GPUs ($((SECONDS - started_at))s)"
  print_e2e_layout "${count}"
}

create_sandboxes() {
  local count="${1:?count}"
  local i name started_at="${SECONDS}"
  local -a to_create=() existing=() pids=() creating=() failed=() retry_pids=() retry_names=() all_names=()
  E2E_USERS="${count}"
  export E2E_USERS
  [[ "${count}" =~ ^[1-9][0-9]*$ ]] || fail "sandbox count must be a positive integer"
  ((count <= 200)) || fail "refusing more than 200 sandboxes in one run"
  openshell status >/dev/null \
    || fail "OpenShell gateway is not connected; port-forward service/openshell and re-register the gateway"
  hpa_common_verify_target_node 1 || exit 1
  echo "Creating ${count} Deep Agents sandboxes"
  rm -f "${E2E_OPENSHELL_LOG_DIR:-${CHART_DIR}/e2e-results/openshell-create}/.provider.done"
  for ((i = 0; i < count; i += 1)); do
    name="$(sandbox_name "${i}")"
    all_names+=("${name}")
    if sandbox_pod_ready "${name}"; then
      echo "  ${name} already exists, skipping create"
      existing+=("${name}")
      continue
    fi
    to_create+=("${name}")
  done
  for name in "${to_create[@]}"; do
    create_one_sandbox "${name}" &
    pids+=("$!")
    creating+=("${name}")
  done
  for i in "${!pids[@]}"; do
    if ! wait "${pids[$i]}"; then
      failed+=("${creating[$i]}")
    fi
  done
  if ((${#failed[@]} > 0)); then
    echo "Retrying ${#failed[@]} failed sandbox create(s) in parallel: ${failed[*]}"
    retry_pids=()
    retry_names=("${failed[@]}")
    failed=()
    for name in "${retry_names[@]}"; do
      create_one_sandbox "${name}" &
      retry_pids+=("$!")
    done
    for i in "${!retry_pids[@]}"; do
      if ! wait "${retry_pids[$i]}"; then
        failed+=("${retry_names[$i]}")
      fi
    done
  fi
  if ((${#failed[@]} > 0)); then
    fail "failed to create: ${failed[*]}"
  fi
  echo "Ready: ${count}/${count} sandboxes in $((SECONDS - started_at))s"
}

case "${ACTION}" in
  cleanup)
    cleanup_sandboxes
    ;;
  bringup)
    bringup_sandboxes "${E2E_USERS}"
    ;;
  layout)
    print_e2e_layout "${E2E_USERS}"
    ;;
  start)
    start_gateways "${E2E_USERS_FROM_ENV:-$(count_from_existing)}"
    ;;
  refresh-inference)
    refresh_openshell_inference_backend \
      || fail "could not update OpenShell provider ${OPENSHELL_PROVIDER_NAME} to ${E2E_INFERENCE_URL:-unknown}"
    ;;
  stop)
    stop_gateways
    ;;
  '' | *[!0-9]*)
    fail "usage: $0 <count>|bringup|layout|start|stop|refresh-inference|cleanup"
    ;;
  *)
    create_sandboxes "${ACTION}"
    ;;
esac
