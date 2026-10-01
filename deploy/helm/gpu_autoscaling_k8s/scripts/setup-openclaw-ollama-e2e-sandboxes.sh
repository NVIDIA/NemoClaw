#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Create, start, stop, or destroy N OpenShell sandboxes (one OpenClaw agent per end
# user) for the OpenClaw + Ollama HPA e2e. The model stays on Ollama GPU pods
# in nemoclaw-gpu. Traffic: sandbox → inference.local → Envoy → Ollama HPA.
#
# Sandboxes are light CPU front ends (default 1 CPU / 8Gi). They do not run
# inference; GPUs do. Create skips smoke, supervisor SSH waits, and NVIDIA
# policy retries. Start is parallel, pins a slim OpenClaw config (nemoclaw
# plugin only, empty extra channels), sets NEMOCLAW_MINIMAL_BOOTSTRAP=1, and
# strips unused .openclaw/npm plugin trees so start does not walk hundreds of
# MiB of messaging node_modules. Do not spawn a second Node CLI. Prefer
# ./scripts/agentscaling_gpuutil.sh or ./scripts/agentscaling_latency.sh
# over calling this file directly.
#
# Does not run openshell gateway start, nemoclaw launch, or the metrics-proxy
# chat-completions Job (hpa-load-test-*.sh). Keep that Job as the fast HPA-only
# test. Does not destroy sandboxes outside SANDBOX_PREFIX (default
# openclaw-ollama-e2e-). Does not touch hermes-onprem or hermes-e2e-*.
# Hermes + vLLM is a later e2e.
#
# Usage:
#   cd deploy/helm/gpu_autoscaling_k8s
#   ./scripts/agentscaling_gpuutil.sh                         # default E2E_USERS=5, GPU util HPA
#   E2E_USERS=5 ./scripts/agentscaling_latency.sh bringup     # LLM latency HPA
#   ./scripts/setup-openclaw-ollama-e2e-sandboxes.sh 4
#   ./scripts/setup-openclaw-ollama-e2e-sandboxes.sh start
#   ./scripts/setup-openclaw-ollama-e2e-sandboxes.sh refresh-inference
#   ./scripts/setup-openclaw-ollama-e2e-sandboxes.sh stop
#   ./scripts/setup-openclaw-ollama-e2e-sandboxes.sh cleanup
#
# bringup creates N sandboxes and starts N OpenClaw agents in the same
# parallel wave (one agent per sandbox). Do not wait for all sandboxes
# before launching agents. All sandboxes share one OpenShell gateway.

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

export PATH="${HOME}/.local/bin:${PATH}"
require_cmd openshell
require_cmd kubectl
require_cmd python3

E2E_USERS="${E2E_USERS:-5}"
ACTION="${1:-}"
if [[ -z "${ACTION}" ]]; then
  ACTION="${E2E_USERS}"
fi
export AGENT_NAME="${AGENT_NAME:-openclaw}"
if [[ "${AGENT_NAME}" != "openclaw" ]]; then
  fail "setup-openclaw-ollama-e2e-sandboxes.sh is OpenClaw + Ollama only (got AGENT_NAME=${AGENT_NAME})"
fi
if [[ -n "${INFERENCE_RUNTIME:-}" && "${INFERENCE_RUNTIME}" != "ollama" ]]; then
  fail "this e2e is OpenClaw + Ollama (got INFERENCE_RUNTIME=${INFERENCE_RUNTIME}). Hermes + vLLM is later and is not started here."
fi
agent_common_pin_example_pairing openclaw ollama
if [[ "${INFERENCE_MODEL}" != "llama3.2:3b" ]]; then
  fail "this e2e is OpenClaw + Ollama llama3.2:3b (got INFERENCE_MODEL=${INFERENCE_MODEL}). Do not point it at Hermes/vLLM/NIM models."
fi
AGENT_DISPLAY_NAME="$(agent_common_display_name "${AGENT_NAME}")"
PIN_OPENCLAW_MODEL_PY="${CHART_DIR}/files/pin-openclaw-ollama-model.py"
SANDBOX_PREFIX="${SANDBOX_PREFIX:-openclaw-ollama-e2e-}"
[[ "${SANDBOX_PREFIX}" =~ ^[a-z][a-z0-9-]{0,40}$ ]] \
  || fail "SANDBOX_PREFIX must be a lowercase Kubernetes-style prefix"
[[ "${SANDBOX_PREFIX}" == openclaw-ollama-e2e-* || "${SANDBOX_PREFIX}" == "openclaw-ollama-e2e-" ]] \
  || fail "SANDBOX_PREFIX must stay under openclaw-ollama-e2e- so other agent sandboxes are not destroyed"

export NAMESPACE="${NAMESPACE:-nemoclaw-gpu}"
export RELEASE="${RELEASE:-nemoclaw-gpu}"
if [[ "${NAMESPACE}" != "nemoclaw-gpu" || "${RELEASE}" != "nemoclaw-gpu" ]]; then
  fail "OpenClaw + Ollama e2e uses NAMESPACE=nemoclaw-gpu RELEASE=nemoclaw-gpu (got ${NAMESPACE}/${RELEASE})"
fi
export ENABLE_ENVOY_LB="${ENABLE_ENVOY_LB:-1}"
export INFERENCE_SERVICE="${INFERENCE_SERVICE:-$(RELEASE="${RELEASE}" CHART_NAME=nemoclaw-gpu hpa_common_metrics_proxy_service)}"
if [[ -z "${AGENT_SANDBOX_IMAGE:-}" ]]; then
  case "${AGENT_NAME}" in
    openclaw)
      AGENT_SANDBOX_IMAGE="ghcr.io/nvidia/nemoclaw/openclaw-sandbox@sha256:bd935f0198b99889d9479fea123b62a59e3797da13e392dcc2160f114216c1ba"
      ;;
    *)
      fail "set AGENT_SANDBOX_IMAGE for AGENT_NAME=${AGENT_NAME} (Hermes / Deep Agents e2e reuse this layout later)"
      ;;
  esac
fi
export AGENT_SANDBOX_IMAGE
# E2E sandboxes only proxy prompts. Keep requests small so N pods schedule
# quickly; pairing/create-agent-sandbox.sh still defaults to 2 CPU / 4Gi.
export AGENT_SANDBOX_CPU="${AGENT_SANDBOX_CPU:-1}"
# 1Gi/2Gi/4Gi OOM-kill OpenClaw before :18789 binds when leftover Node
# workers remain (openclaw-devices ~150–220Mi each). 8Gi is the floor
# that lets one OpenClaw listen for the client.
export AGENT_SANDBOX_MEMORY="${AGENT_SANDBOX_MEMORY:-8Gi}"
export QUESTION_AVG_TOKENS="${QUESTION_AVG_TOKENS:-38}"
export MAX_TOKENS="${MAX_TOKENS:-$((QUESTION_AVG_TOKENS * 16))}"
export NEMOCLAW_MINIMAL_BOOTSTRAP="${NEMOCLAW_MINIMAL_BOOTSTRAP:-1}"
export SKIP_CREATE_SMOKE="${SKIP_CREATE_SMOKE:-1}"
export SKIP_WAIT_INFERENCE_LOCAL="${SKIP_WAIT_INFERENCE_LOCAL:-1}"
export SKIP_INFERENCE_VERIFY="${SKIP_INFERENCE_VERIFY:-1}"
export AGENT_START_TIMEOUT_SEC="${AGENT_START_TIMEOUT_SEC:-300}"
export OPENSHELL_PROVIDER_NAME="${OPENSHELL_PROVIDER_NAME:-$(agent_common_default_provider_name "${AGENT_NAME}")}"

STATE_DIR="${E2E_STATE_DIR:-${CHART_DIR}/e2e-results/openclaw-ollama-agents}"
mkdir -p "${STATE_DIR}"
E2E_SANDBOX_NS="${OPENSHELL_NAMESPACE:-nemoclaw-sandboxes}"
E2E_INFERENCE_URL=""
E2E_API_KEY=""

sandbox_name() {
  printf '%s%04d' "${SANDBOX_PREFIX}" "${1:?index}"
}

# User-facing label. Kubernetes still uses sandbox_name (openclaw-ollama-e2e-NNNN).
sandbox_label() {
  local name="${1:?}"
  local idx="${name#"${SANDBOX_PREFIX}"}"
  if [[ "${idx}" =~ ^[0-9]+$ ]]; then
    printf 'sandbox %s' "$((10#${idx}))"
  else
    printf '%s' "${name}"
  fi
}

sandbox_labels() {
  local name
  local -a labels=()
  for name in "$@"; do
    labels+=("$(sandbox_label "${name}")")
  done
  printf '%s' "${labels[*]}"
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

print_e2e_layout() {
  local count="${1:?count}"
  local i name sandbox_st agent_st
  echo ""
  echo "========================================================================"
  echo "E2E test: ${AGENT_DISPLAY_NAME} + Ollama"
  echo "  ${count} end users send requests to ${count} OpenClaw agents"
  echo "  ${count} OpenClaw agents run in ${count} OpenShell sandboxes"
  echo "  LLM (Ollama ${INFERENCE_MODEL}) runs on GPUs"
  echo "  When end-user demand increases, HPA scales Ollama from 1 to 8 GPUs"
  echo "------------------------------------------------------------------------"
  printf "  %-10s  %-24s  %-12s  %s\n" "end user" "OpenClaw agent" "sandbox" "status"
  for ((i = 0; i < count; i += 1)); do
    name="$(sandbox_name "${i}")"
    if sandbox_pod_ready "${name}"; then
      sandbox_st="Ready"
    else
      sandbox_st="NOT READY"
    fi
    if agent_health_ok "${name}"; then
      agent_st="OpenClaw running :18789"
    else
      agent_st="OpenClaw not listening"
    fi
    printf "  %-10s  %-24s  %-12s  %s\n" "user ${i}" "${agent_st}" "sandbox ${i}" "${sandbox_st}"
  done
  echo "------------------------------------------------------------------------"
  echo "  HPA: Ollama ${INFERENCE_MODEL} in ${NAMESPACE}/${RELEASE} scales 1 → 8 GPUs as demand rises"
  echo "  One OpenShell gateway. One Envoy load balancer."
  echo "  Users talk to sandbox :18789."
  echo "  Client (other terminal; same for GPU util or latency HPA):"
  echo "    E2E_USERS=${count} ./scripts/client.sh"
  echo "  Watch HPA (percent or ms): ./scripts/get-hpa.sh -n ${NAMESPACE} -w"
  echo "========================================================================"
}

refresh_openshell_inference_backend() {
  # One gateway-scoped provider for all e2e sandboxes. Envoy dataplane pod IP,
  # not ClusterIP (hairpin on a DGX H100 node drops SYNs).
  load_e2e_inference_env
  local log="${STATE_DIR}/openshell-provider.log"
  mkdir -p "${STATE_DIR}"
  echo "  OpenShell provider ${OPENSHELL_PROVIDER_NAME} → Envoy dataplane ${E2E_INFERENCE_URL} (pod IP, not ClusterIP)"
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

agent_health_ok() {
  local name="${1:?sandbox}"
  # OpenClaw binds :18789 in the OpenShell sandbox netns, not the pod netns.
  # kubectl exec curl 127.0.0.1:18789 always fails (that is the 180s false timeout).
  # curl %{http_code} is literal; do not expand it in the sandbox shell.
  # shellcheck disable=SC2016
  kubectl exec -n "${E2E_SANDBOX_NS}" "${name}" -c agent -- bash -c '
    for ns in /run/netns/*; do
      [ -e "$ns" ] || continue
      code="$(nsenter --net="$ns" curl -sS -o /dev/null -w "%{http_code}" --max-time 2 http://127.0.0.1:18789/health 2>/dev/null || true)"
      case "$code" in
        200|401) exit 0 ;;
      esac
    done
    exit 1
  ' >/dev/null 2>&1
}

inference_local_ok() {
  local name="${1:?sandbox}"
  # OpenShell MITM injects credentials. Do not copy the gateway API key into the sandbox.
  timeout --foreground 12 openshell sandbox exec -n "${name}" --no-tty -- \
    curl -fsS --http1.1 --max-time 5 https://inference.local/v1/models >/dev/null 2>&1
}

pin_openclaw_ollama_model() {
  local name="${1:?sandbox}"
  local out
  [[ -f "${PIN_OPENCLAW_MODEL_PY}" ]] || fail "missing ${PIN_OPENCLAW_MODEL_PY}"
  out="$(
    kubectl exec -i -n "${E2E_SANDBOX_NS}" "${name}" -c agent -- \
      python3 - "${INFERENCE_MODEL}" "${MAX_TOKENS:-128}" <"${PIN_OPENCLAW_MODEL_PY}"
  )" || fail "$(sandbox_label "${name}"): OpenClaw pin failed"
  echo "  $(sandbox_label "${name}"): ${out}"
}

prune_unused_openclaw_npm() {
  local name="${1:?sandbox}"
  # Official image seeds ~378Mi of unused messaging plugin npm trees.
  # Start walks that tree in normalize_mutable_config_perms. Drop it only
  # after the pin overwrote .bak / last-good so OpenClaw cannot restore
  # those plugin entries and npm-install them.
  kubectl exec -n "${E2E_SANDBOX_NS}" "${name}" -c agent -- \
    bash -c 'rm -rf /sandbox/.openclaw/npm' >/dev/null
}

slim_one_sandbox() {
  local name="${1:?sandbox}"
  skip_connect_shell_nproc "${name}"
  pin_openclaw_ollama_model "${name}"
  prune_unused_openclaw_npm "${name}"
}

skip_connect_shell_nproc() {
  local name="${1:?sandbox}"
  # OpenShell exec sources this hook. harden+verify set nproc=512, and
  # RLIMIT_NPROC is per real UID on the node. Ten e2e sandboxes share that
  # UID, so the verify fork fails with EAGAIN and nemoclaw-start never runs.
  # PID 1 already applied sandbox rlimits; connect-shell does not need them.
  kubectl exec -n "${E2E_SANDBOX_NS}" "${name}" -c agent -- bash -c '
    cat > /etc/profile.d/nemoclaw-rlimits.sh << "EOF"
# Connect-shell must not re-apply nproc=512 (RLIMIT_NPROC is per-UID on the node).
true
EOF
    if [[ -f /usr/local/lib/nemoclaw/sandbox-rlimits.sh ]]; then
      sed -i 's/^NEMOCLAW_SANDBOX_NPROC_LIMIT=512$/NEMOCLAW_SANDBOX_NPROC_LIMIT=8192/' \
        /usr/local/lib/nemoclaw/sandbox-rlimits.sh
    fi
    rm -f /tmp/nemoclaw-start.log /tmp/nemoclaw-start.pid \
      /tmp/nemoclaw-sandbox-safety-net.js /tmp/nemoclaw-http-proxy-fix.js \
      /tmp/nemoclaw-nemotron-inference-fix.js /tmp/nemoclaw-ciao-network-guard.js \
      /tmp/nemoclaw-gateway.pid \
      /tmp/.nemoclaw-start.log.tmp.* /tmp/.nemoclaw-sandbox-safety-net.js.tmp.*
  ' >/dev/null
}

launch_one_agent() {
  local name="${1:?sandbox}"
  local log="${STATE_DIR}/${name}.log"
  local pidfile="${STATE_DIR}/${name}.pid"
  if [[ -f "${pidfile}" ]]; then
    local old_pid
    old_pid="$(cat "${pidfile}" 2>/dev/null || true)"
    if [[ -n "${old_pid}" ]] && kill -0 "${old_pid}" 2>/dev/null; then
      echo "  $(sandbox_label "${name}"): already launching (pid ${old_pid})"
      return 0
    fi
    rm -f "${pidfile}"
  fi
  echo "  $(sandbox_label "${name}"): starting /usr/local/bin/nemoclaw-start (minimal bootstrap)"
  # Keep the OpenShell exec attached: nemoclaw-start must run in the sandbox
  # startup transaction (kubectl nohup is rejected by config-guard).
  openshell sandbox exec -n "${name}" --no-tty \
    --env "NEMOCLAW_MODEL_OVERRIDE=${INFERENCE_MODEL}" \
    --env "NEMOCLAW_MINIMAL_BOOTSTRAP=1" -- \
    /usr/local/bin/nemoclaw-start >"${log}" 2>&1 &
  echo $! >"${pidfile}"
}

wait_names_healthy() {
  local timeout_sec="${AGENT_START_TIMEOUT_SEC:-240}"
  local deadline=$((SECONDS + timeout_sec))
  local -a pending=("$@")
  local -a still hpids hnames
  local i name
  ((${#pending[@]} > 0)) || return 0
  echo "  waiting for ${#pending[@]} OpenClaw agent(s) on :18789 (parallel, up to ${timeout_sec}s)"
  while ((${#pending[@]} > 0)); do
    if ((SECONDS >= deadline)); then
      echo "ERROR: agents still not healthy: $(sandbox_labels "${pending[@]}")" >&2
      return 1
    fi
    still=()
    hpids=()
    hnames=()
    for name in "${pending[@]}"; do
      agent_health_ok "${name}" &
      hpids+=("$!")
      hnames+=("${name}")
    done
    for i in "${!hpids[@]}"; do
      if wait "${hpids[$i]}"; then
        echo "  $(sandbox_label "${hnames[$i]}"): OpenClaw agent healthy"
      else
        still+=("${hnames[$i]}")
      fi
    done
    pending=("${still[@]}")
    if ((${#pending[@]} > 0)); then
      echo "  still waiting (${#pending[@]}): $(sandbox_labels "${pending[@]}")"
      sleep 3
    fi
  done
}

finish_one_agent() {
  local name="${1:?sandbox}"
  if ! inference_local_ok "${name}"; then
    echo "ERROR: $(sandbox_label "${name}"): https://inference.local not reachable after agent start" >&2
    return 1
  fi
  echo "  $(sandbox_label "${name}"): ${INFERENCE_MODEL} via inference.local ok"
}

stop_one_agent() {
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
  # Image/e2e leftovers keep extra nemoclaw-start + openclaw copies. Pin then
  # races those processes, which restore bak.1 plugin entries and hold the
  # startup-migration lock. Match OpenClaw processes only; do not pkill -f
  # the host e2e script name.
  # Copy the killer into the pod. Do not put process-name patterns in
  # kubectl exec argv: awk would match this exec and abort the stop.
  local killer="${CHART_DIR}/files/e2e-stop-openclaw.sh"
  [[ -f "${killer}" ]] || fail "missing ${killer}"
  kubectl cp "${killer}" "${E2E_SANDBOX_NS}/${name}:/tmp/e2e-stop-openclaw.sh" -c agent >/dev/null 2>&1 || true
  kubectl exec -n "${E2E_SANDBOX_NS}" "${name}" -c agent -- \
    sh /tmp/e2e-stop-openclaw.sh >/dev/null 2>&1 || true
  echo "  $(sandbox_label "${name}"): leftover OpenClaw/Node processes stopped"
}

count_from_existing() {
  local names max=0 n
  names="$(list_prefix_sandboxes)"
  [[ -n "${names}" ]] || fail "no ${SANDBOX_PREFIX}* sandboxes; run ./scripts/agentscaling_gpuutil.sh or ./scripts/agentscaling_latency.sh first"
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

start_agents() {
  local count="${1:?count}"
  local i name started_at="${SECONDS}"
  local -a names=() pending=()
  echo "Starting ${count} OpenClaw agents in parallel (sandbox 0 … sandbox $((count - 1))). Cluster still has one OpenShell gateway and one Envoy load balancer."
  echo "  Light sandboxes (${AGENT_SANDBOX_CPU} / ${AGENT_SANDBOX_MEMORY}); GPUs do inference."
  echo "  One agent per sandbox (nemoclaw-start, NEMOCLAW_MINIMAL_BOOTSTRAP=1). Not sequential :18789 waits."
  echo "  pointing OpenShell inference backend at Envoy dataplane pod IP (not ClusterIP)"
  refresh_openshell_inference_backend \
    || fail "could not update OpenShell provider ${OPENSHELL_PROVIDER_NAME} to ${E2E_INFERENCE_URL:-unknown}"
  for ((i = 0; i < count; i += 1)); do
    name="$(sandbox_name "${i}")"
    kubectl get pod "${name}" -n "${E2E_SANDBOX_NS}" >/dev/null 2>&1 \
      || fail "sandbox ${name} does not exist"
    names+=("${name}")
  done
  echo "  stopping leftover OpenClaw gateways so start does not reuse a rotated token"
  for name in "${names[@]}"; do
    stop_one_agent "${name}"
  done
  echo "  patching nproc + slim OpenClaw config (nemoclaw plugin only)"
  for name in "${names[@]}"; do
    slim_one_sandbox "${name}" || fail "could not slim ${name}"
  done
  for name in "${names[@]}"; do
    launch_one_agent "${name}"
    pending+=("${name}")
  done
  wait_names_healthy "${pending[@]}" || fail "parallel agent start timed out; logs in ${STATE_DIR}"
  wait_inference_local_parallel "${names[@]}" \
    || fail "Envoy inference check failed after parallel agent start"
  echo "Ready: ${count}/${count} OpenClaw agents in $((SECONDS - started_at))s (parallel)."
  print_e2e_layout "${count}"
}

stop_agents() {
  local name
  local -a pids=()
  echo "Stopping OpenClaw agent start processes for ${SANDBOX_PREFIX}* in parallel"
  while IFS= read -r name; do
    [[ -z "${name}" ]] && continue
    stop_one_agent "${name}" &
    pids+=("$!")
  done < <(list_prefix_sandboxes)
  for pid in "${pids[@]}"; do
    wait "${pid}" || true
  done
}

cleanup_sandboxes() {
  local name
  local -a names=() pids=()
  stop_agents || true
  echo "Destroying sandboxes named ${SANDBOX_PREFIX}* in parallel"
  while IFS= read -r name; do
    [[ -z "${name}" ]] && continue
    names+=("${name}")
    echo "  destroying $(sandbox_label "${name}")"
    openshell sandbox destroy "${name}" --force >/dev/null 2>&1 &
    pids+=("$!")
  done < <(list_prefix_sandboxes)
  for pid in "${pids[@]}"; do
    wait "${pid}" || true
  done
  echo "Cleanup complete (${#names[@]} ${SANDBOX_PREFIX}* sandboxes). hermes-onprem was not touched."
}

bringup_one() {
  local name="${1:?sandbox}"
  if sandbox_pod_ready "${name}"; then
    echo "  $(sandbox_label "${name}"): reusing existing OpenShell sandbox"
  else
    create_one_sandbox "${name}" || return 1
  fi
  # Stop leftover OpenClaw before pin, or bak.1 / sqlite restores plugins.
  stop_one_agent "${name}" >/dev/null || true
  slim_one_sandbox "${name}" || return 1
  launch_one_agent "${name}"
  wait_names_healthy "${name}" || return 1
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
  echo "E2E test: OpenClaw + Ollama — ${count} end users send requests to ${count} OpenClaw agents in ${count} OpenShell sandboxes (LLM on GPUs)"
  echo "  Reuse a Ready OpenShell sandbox when it already exists. Start the ${count} agents in parallel."
  echo "  One OpenShell gateway for all sandboxes. Do not destroy extras."
  rm -f "${E2E_OPENSHELL_LOG_DIR:-${CHART_DIR}/e2e-results/openshell-create}/.provider.done"
  echo "  pointing OpenShell inference backend at Envoy/metrics-proxy dataplane pod IP (not ClusterIP)"
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
    fail "bringup failed for: $(sandbox_labels "${failed[@]}")"
  fi
  wait_inference_local_parallel "${names[@]}" \
    || fail "Envoy inference check failed after parallel agent start"
  echo "Ready: ${count} end users → ${count} OpenClaw agents in ${count} OpenShell sandboxes; LLM on GPUs ($((SECONDS - started_at))s)"
  print_e2e_layout "${count}"
}

create_one_sandbox() {
  local name="${1:?sandbox}"
  local log="${STATE_DIR}/${name}.create.log"
  echo "  creating $(sandbox_label "${name}") (parallel, light ${AGENT_SANDBOX_CPU}/${AGENT_SANDBOX_MEMORY})"
  if AGENT_SANDBOX_NAME="${name}" \
    SKIP_CREATE_SMOKE=1 \
    SKIP_WAIT_INFERENCE_LOCAL=1 \
    SKIP_INFERENCE_VERIFY=1 \
    NEMOCLAW_MINIMAL_BOOTSTRAP=1 \
    stdbuf -oL -eL "${SCRIPT_DIR}/create-agent-sandbox.sh" >"${log}" 2>&1; then
    echo "  $(sandbox_label "${name}"): sandbox Ready"
    return 0
  fi
  echo "ERROR: $(sandbox_label "${name}"): create failed; see ${log}" >&2
  return 1
}

wait_inference_local_parallel() {
  local timeout_sec="${INFERENCE_LOCAL_TIMEOUT_SEC:-180}"
  local deadline=$((SECONDS + timeout_sec))
  local name
  ((${#} > 0)) || return 0
  echo "Checking https://inference.local on ${#} sandboxes one at a time (up to ${timeout_sec}s)"
  for name in "$@"; do
    echo "  $(sandbox_label "${name}"): checking inference.local"
    while ! inference_local_ok "${name}"; do
      if ((SECONDS >= deadline)); then
        echo "ERROR: inference.local still failing for: $(sandbox_label "${name}")" >&2
        return 1
      fi
      echo "  $(sandbox_label "${name}"): still waiting for inference.local"
      sleep 2
    done
    echo "  $(sandbox_label "${name}"): inference.local ok"
  done
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
  echo "Creating ${count} light OpenClaw + Ollama e2e sandboxes in parallel (sandbox 0 … sandbox $((count - 1)))"
  echo "  Agent: AGENT_NAME=${AGENT_NAME} (${AGENT_SANDBOX_CPU} CPU / ${AGENT_SANDBOX_MEMORY}; no GPU; OpenClaw runs here)"
  echo "  GPU inference backend: Ollama model=${INFERENCE_MODEL} ns=${NAMESPACE} release=${RELEASE} ENABLE_ENVOY_LB=${ENABLE_ENVOY_LB}"
  echo "  Skip smoke/supervisor/policy waits. Wall-clock should be ~one sandbox (plus image pull), not ${count} sequential creates."
  rm -f "${E2E_OPENSHELL_LOG_DIR:-${CHART_DIR}/e2e-results/openshell-create}/.provider.done"
  for ((i = 0; i < count; i += 1)); do
    name="$(sandbox_name "${i}")"
    all_names+=("${name}")
    if openshell sandbox get "${name}" >/dev/null 2>&1 \
      && kubectl get pod "${name}" -n "${OPENSHELL_NAMESPACE:-nemoclaw-sandboxes}" \
        -o jsonpath='{.status.phase}' 2>/dev/null | grep -qx Running \
      && [[ "$(kubectl get pod "${name}" -n "${OPENSHELL_NAMESPACE:-nemoclaw-sandboxes}" \
        -o jsonpath='{.status.containerStatuses[0].ready}' 2>/dev/null)" == "true" ]]; then
      echo "  $(sandbox_label "${name}") already exists, skipping create"
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
    echo "Retrying ${#failed[@]} failed sandbox create(s) in parallel: $(sandbox_labels "${failed[@]}")"
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
    fail "failed to create: $(sandbox_labels "${failed[@]}")"
  fi
  echo "Ready: ${count}/${count} light sandboxes in $((SECONDS - started_at))s (parallel). Envoy check runs at agent start."
  echo "  ./scripts/agentscaling_gpuutil.sh start   # or agentscaling_latency.sh start"
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
    start_agents "${E2E_USERS:-$(count_from_existing)}"
    ;;
  refresh-inference)
    refresh_openshell_inference_backend \
      || fail "could not update OpenShell provider ${OPENSHELL_PROVIDER_NAME} to ${E2E_INFERENCE_URL:-unknown}"
    ;;
  stop)
    stop_agents
    ;;
  '' | *[!0-9]*)
    fail "usage: $0 <count>|bringup|layout|start|stop|refresh-inference|cleanup"
    ;;
  *)
    create_sandboxes "${ACTION}"
    ;;
esac
