#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Configure OpenShell's gateway-scoped inference route through the Envoy load balancer
# (LeastRequest) when ENABLE_ENVOY_LB=1 / a Gateway exists, otherwise through the
# metrics-proxy Service, then create a sandbox for the agent selected by AGENT_NAME
# (openclaw | hermes | deepagents) without assigning it a GPU.
# Envoy LeastRequest uses the dataplane pod IP (not ClusterIP): same-node kube-proxy
# hairpin is why the HPA Job (files/load-generator.ts) also targets pod IPs.
#
# Usage:
#   cd deploy/helm/gpu_autoscaling_k8s
#   AGENT_NAME=hermes AGENT_SANDBOX_IMAGE=registry.example.com/team/nemoclaw-hermes-k8s:v0.0.104 \
#     ./scripts/create-agent-sandbox.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=versions.env
source "${CHART_DIR}/versions.env"
# shellcheck source=hpa-common.sh
source "${SCRIPT_DIR}/hpa-common.sh"
# shellcheck source=agent-common.sh
source "${SCRIPT_DIR}/agent-common.sh"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"
}

require_cmd git
require_cmd helm
require_cmd kubectl
require_cmd openshell
require_cmd python3

AGENT_NAME="${AGENT_NAME:-}"
agent_common_validate "${AGENT_NAME}"
agent_common_validate_runtime_pairing "${AGENT_NAME}" "${INFERENCE_RUNTIME:-}"
AGENT_DISPLAY_NAME="$(agent_common_display_name "${AGENT_NAME}")"

SANDBOX_IMAGE="${AGENT_SANDBOX_IMAGE:-}"
SANDBOX_NAME="${AGENT_SANDBOX_NAME:-$(agent_common_default_sandbox_name "${AGENT_NAME}")}"
INFERENCE_NAMESPACE="${NAMESPACE:-nemoclaw-gpu}"
INFERENCE_RELEASE="${RELEASE:-nemoclaw-gpu}"
# Helm fullname: release "nemoclaw-gpu" → nemoclaw-gpu-metrics-proxy; release
# "deepagents-vllm" → deepagents-vllm-nemoclaw-gpu-metrics-proxy.
INFERENCE_GATEWAY="${INFERENCE_GATEWAY:-$(
  RELEASE="${INFERENCE_RELEASE}" CHART_NAME=nemoclaw-gpu hpa_common_metrics_proxy_deployment
)}"
INFERENCE_SERVICE="${INFERENCE_SERVICE:-${INFERENCE_GATEWAY}}"
INFERENCE_PORT="${SERVICE_PORT:-8081}"
MODEL="${INFERENCE_MODEL:-$(agent_common_default_inference_model "${INFERENCE_RUNTIME:-ollama}")}"
PROVIDER_NAME="${OPENSHELL_PROVIDER_NAME:-$(agent_common_default_provider_name "${AGENT_NAME}")}"
IMAGE_NAME="${SANDBOX_IMAGE##*/}"

[[ -n "${SANDBOX_IMAGE}" ]] || fail "set AGENT_SANDBOX_IMAGE to the pushed image"
[[ "${SANDBOX_IMAGE}" =~ ^[A-Za-z0-9][A-Za-z0-9._:/@-]+$ ]] \
  || fail "AGENT_SANDBOX_IMAGE contains unsupported characters"
if [[ "${SANDBOX_IMAGE}" == *@* ]]; then
  [[ "${SANDBOX_IMAGE}" =~ @sha256:[0-9a-f]{64}$ ]] \
    || fail "AGENT_SANDBOX_IMAGE contains an invalid digest"
else
  [[ "${IMAGE_NAME}" == *:* && "${SANDBOX_IMAGE}" != *:latest ]] \
    || fail "AGENT_SANDBOX_IMAGE must use a non-latest tag or an image digest"
fi
[[ "${INFERENCE_NAMESPACE}" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] \
  || fail "NAMESPACE must be a valid lowercase Kubernetes namespace"
[[ "${INFERENCE_GATEWAY}" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] \
  || fail "INFERENCE_GATEWAY must be a valid lowercase Kubernetes Gateway name"
[[ "${INFERENCE_SERVICE}" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] \
  || fail "INFERENCE_SERVICE must be a valid lowercase Kubernetes Service name"
if [[ ! "${INFERENCE_PORT}" =~ ^[0-9]+$ ]] \
  || ((10#${INFERENCE_PORT} < 1 || 10#${INFERENCE_PORT} > 65535)); then
  fail "SERVICE_PORT must be an integer from 1 to 65535"
fi
[[ "${MODEL}" =~ ^[A-Za-z0-9][A-Za-z0-9._:/-]*$ ]] || fail "INFERENCE_MODEL is invalid"
[[ "${PROVIDER_NAME}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] \
  || fail "OPENSHELL_PROVIDER_NAME is invalid"
[[ "${SANDBOX_NAME}" =~ ^[a-z][a-z0-9-]{0,61}[a-z0-9]$ ]] \
  || fail "AGENT_SANDBOX_NAME must be a 2-63 character lowercase Kubernetes-style name"
hpa_common_verify_target_node 1 || exit 1

ACTUAL_OPENSHELL_VERSION="$(openshell --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1)"
[[ "${ACTUAL_OPENSHELL_VERSION}" == "${OPENSHELL_VERSION}" ]] \
  || fail "OpenShell CLI ${OPENSHELL_VERSION} is required; found ${ACTUAL_OPENSHELL_VERSION:-unknown}"
openshell status >/dev/null

IFS=$'\t' read -r DEPLOYED_INFERENCE_SECRET DEPLOYED_INFERENCE_SECRET_KEY < <(
  hpa_common_inference_secret_contract \
    "${INFERENCE_NAMESPACE}" "${INFERENCE_RELEASE}" "${INFERENCE_SERVICE}-inference-api"
)
INFERENCE_SECRET="${INFERENCE_API_SECRET:-${DEPLOYED_INFERENCE_SECRET}}"
INFERENCE_SECRET_KEY="${INFERENCE_API_SECRET_KEY:-${DEPLOYED_INFERENCE_SECRET_KEY}}"
[[ "${INFERENCE_SECRET}" =~ ^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$ ]] \
  || fail "INFERENCE_API_SECRET is not a valid Kubernetes Secret name"
[[ "${INFERENCE_SECRET_KEY}" =~ ^[A-Za-z0-9._-]+$ ]] \
  || fail "INFERENCE_API_SECRET_KEY is invalid"

POLICY_FILE="${AGENT_SANDBOX_POLICY_FILE:-}"
if [[ -z "${POLICY_FILE}" ]]; then
  LOCAL_POLICY="$(cd "${CHART_DIR}/../../.." && pwd)/$(agent_common_policy_rel_path "${AGENT_NAME}")"
  if [[ -f "${LOCAL_POLICY}" ]]; then
    POLICY_FILE="${LOCAL_POLICY}"
  fi
fi
SOURCE_ROOT=""
if [[ -z "${POLICY_FILE}" ]]; then
  SOURCE_ROOT="$(mktemp -d)"
  trap 'rm -rf -- "${SOURCE_ROOT}"' EXIT
  git clone --quiet --depth 1 --branch "${NEMOCLAW_VERSION}" \
    https://github.com/NVIDIA/NemoClaw.git "${SOURCE_ROOT}/nemoclaw"
  ACTUAL_NEMOCLAW_COMMIT="$(git -C "${SOURCE_ROOT}/nemoclaw" rev-parse HEAD)"
  [[ "${ACTUAL_NEMOCLAW_COMMIT}" == "${NEMOCLAW_COMMIT}" ]] \
    || fail "NemoClaw ${NEMOCLAW_VERSION} resolved to unexpected commit ${ACTUAL_NEMOCLAW_COMMIT}"
  POLICY_FILE="${SOURCE_ROOT}/nemoclaw/$(agent_common_policy_rel_path "${AGENT_NAME}")"
fi
[[ -f "${POLICY_FILE}" ]] || fail "${AGENT_DISPLAY_NAME} policy is missing: ${POLICY_FILE}"

API_KEY="$(
  kubectl get secret "${INFERENCE_SECRET}" -n "${INFERENCE_NAMESPACE}" -o json \
    | python3 -c 'import base64,json,sys; print(base64.b64decode(json.load(sys.stdin)["data"][sys.argv[1]]).decode())' \
      "${INFERENCE_SECRET_KEY}"
)"
[[ -n "${API_KEY}" ]] || fail "inference API key is empty"

BASE_URL="$(
  hpa_common_openshell_inference_base_url \
    "${INFERENCE_NAMESPACE}" \
    "${INFERENCE_GATEWAY}" \
    "${INFERENCE_SERVICE}" \
    "${INFERENCE_PORT}"
)"
[[ "${BASE_URL}" =~ ^https?://.+/v1$ ]] \
  || fail "resolved OpenShell inference base URL is invalid: ${BASE_URL}"
OPENSHELL_LOG_DIR="${E2E_OPENSHELL_LOG_DIR:-${CHART_DIR}/e2e-results/openshell-create}"
mkdir -p "${OPENSHELL_LOG_DIR}"
OPENSHELL_LOG="${OPENSHELL_LOG_DIR}/${SANDBOX_NAME}.log"
SANDBOX_NS="${OPENSHELL_NAMESPACE:-nemoclaw-sandboxes}"
SANDBOX_READY_TIMEOUT_SEC="${SANDBOX_READY_TIMEOUT_SEC:-600}"

# Provider + inference.local backend are gateway-scoped, not per-sandbox.
# Parallel e2e creates serialize here so 10 sandboxes do not race the same API.
configure_openshell_inference() {
  if [[ "${SKIP_PROVIDER_SETUP:-0}" == "1" ]]; then
    return 0
  fi
  local want="${PROVIDER_NAME} ${BASE_URL} ${MODEL}"
  if [[ -f "${OPENSHELL_LOG_DIR}/.provider.done" ]] \
    && [[ "$(<"${OPENSHELL_LOG_DIR}/.provider.done")" == "${want}" ]]; then
    return 0
  fi
  if openshell provider get "${PROVIDER_NAME}" >/dev/null 2>&1; then
    OPENAI_API_KEY="${API_KEY}" openshell provider update "${PROVIDER_NAME}" \
      --credential OPENAI_API_KEY \
      --config "OPENAI_BASE_URL=${BASE_URL}" \
      >>"${OPENSHELL_LOG}" 2>&1
  else
    OPENAI_API_KEY="${API_KEY}" openshell provider create \
      --name "${PROVIDER_NAME}" \
      --type openai \
      --credential OPENAI_API_KEY \
      --config "OPENAI_BASE_URL=${BASE_URL}" \
      >>"${OPENSHELL_LOG}" 2>&1
  fi
  local -a inference_set_args=(
    --provider "${PROVIDER_NAME}"
    --model "${MODEL}"
    --timeout 300
  )
  # Parallel e2e create must not run N chat/completions verifies against one GPU replica.
  if [[ "${SKIP_INFERENCE_VERIFY:-0}" == "1" ]]; then
    inference_set_args+=(--no-verify)
  fi
  openshell inference set "${inference_set_args[@]}" >>"${OPENSHELL_LOG}" 2>&1
  printf '%s' "${want}" >"${OPENSHELL_LOG_DIR}/.provider.done"
}

# OpenShell 0.0.85 prints "Error: supervisor session not connected" / ssh 255
# while the sandbox is still booting. That is a wait, not a failed create.
# Keep the CLI output in a log and print a waiting line on the terminal.
(
  flock 9
  configure_openshell_inference
) 9>"${OPENSHELL_LOG_DIR}/.provider.lock"
unset API_KEY

sandbox_already_present=0
if openshell sandbox get "${SANDBOX_NAME}" >/dev/null 2>&1; then
  echo "sandbox ${SANDBOX_NAME} already exists; finishing supervisor/policy instead of creating again"
  sandbox_already_present=1
fi

SANDBOX_CREATE_ARGS=(
  --name "${SANDBOX_NAME}"
  --from "${SANDBOX_IMAGE}"
  --policy "${POLICY_FILE}"
  --cpu "${AGENT_SANDBOX_CPU:-2}"
  --memory "${AGENT_SANDBOX_MEMORY:-4Gi}"
)
# Official OpenClaw GHCR images bake NVIDIA Nemotron as the agent model.
# This recipe's OpenClaw + Ollama path must use INFERENCE_MODEL (llama3.2:3b).
if [[ "${AGENT_NAME}" == "openclaw" ]]; then
  SANDBOX_CREATE_ARGS+=(--env "NEMOCLAW_MODEL_OVERRIDE=${MODEL}")
  if [[ "${NEMOCLAW_MINIMAL_BOOTSTRAP:-}" == "1" ]]; then
    SANDBOX_CREATE_ARGS+=(--env "NEMOCLAW_MINIMAL_BOOTSTRAP=1")
  fi
fi
if [[ -n "${NEMOCLAW_TARGET_NODE:-}" ]]; then
  DRIVER_CONFIG_JSON="$(python3 - "${NEMOCLAW_TARGET_NODE}" <<'PYEOF'
import json
import sys

print(json.dumps({
    "kubernetes": {
        "pod": {
            "node_selector": {"kubernetes.io/hostname": sys.argv[1]},
            "tolerations": [{
                "key": "nvidia.com/gpu",
                "operator": "Exists",
                "effect": "NoSchedule",
            }],
        },
    },
}))
PYEOF
)"
  SANDBOX_CREATE_ARGS+=(--driver-config-json "${DRIVER_CONFIG_JSON}")
fi

wait_sandbox_ready() {
  local name="${1:?sandbox}"
  local i phase="" remaining
  echo "  ${name}: waiting for Ready (up to ${SANDBOX_READY_TIMEOUT_SEC}s)"
  for ((i = 1; i <= SANDBOX_READY_TIMEOUT_SEC; i += 2)); do
    if kubectl get pod "${name}" -n "${SANDBOX_NS}" >/dev/null 2>&1; then
      remaining=$((SANDBOX_READY_TIMEOUT_SEC - i + 2))
      if ((remaining < 5)); then
        remaining=5
      fi
      if kubectl wait --for=condition=Ready "pod/${name}" -n "${SANDBOX_NS}" \
        --timeout="${remaining}s" >/dev/null 2>&1; then
        echo "  ${name}: Ready"
        return 0
      fi
      break
    fi
    sleep 2
  done
  for ((i = 1; i <= 30; i += 1)); do
    phase="$(
      python3 - "${name}" <<'PY'
import json, subprocess, sys
name = sys.argv[1]
raw = subprocess.check_output(["openshell", "sandbox", "list", "-o", "json"], text=True)
for item in json.loads(raw):
    if isinstance(item, dict) and item.get("name") == name:
        print(item.get("phase") or "")
        break
PY
    )" || true
    if [[ "${phase}" == "Ready" ]]; then
      echo "  ${name}: Ready"
      return 0
    fi
    sleep 2
  done
  echo "WARNING: ${name} did not report Ready (phase=${phase:-unknown})" >&2
  return 1
}

wait_supervisor_exec() {
  local name="${1:?sandbox}"
  local i
  echo "  ${name}: waiting for OpenShell supervisor"
  for ((i = 1; i <= 20; i += 1)); do
    if timeout --foreground 8 openshell sandbox exec -n "${name}" --no-tty -- \
      /bin/true >>"${OPENSHELL_LOG}" 2>&1; then
      echo "  ${name}: supervisor ready"
      return 0
    fi
    sleep 2
  done
  echo "  ${name}: still waiting for supervisor (continuing; see ${OPENSHELL_LOG})"
  return 1
}

wait_inference_local() {
  local name="${1:?sandbox}"
  local i
  echo "  ${name}: waiting for https://inference.local"
  for ((i = 1; i <= 20; i += 1)); do
    if timeout --foreground 12 openshell sandbox exec -n "${name}" --no-tty -- \
      python3 -c "${AGENT_COMMON_INFERENCE_MODELS_PY}" 5 >>"${OPENSHELL_LOG}" 2>&1; then
      echo "  ${name}: inference.local reachable"
      return 0
    fi
    if [[ $((i % 5)) -eq 0 ]]; then
      echo "  ${name}: still waiting for inference.local (${i}/20)"
    fi
    sleep 2
  done
  echo "ERROR: ${name}: https://inference.local not reachable (OpenShell MITM). The HPA Job uses metrics-proxy pod IPs and does not catch this." >&2
  return 1
}

CREATE_PID=""
ready_ok=1
if [[ "${sandbox_already_present}" -eq 0 ]]; then
  # OpenShell 0.0.85 keeps create attached until supervisor SSH is up; that
  # wait fails/hangs after the pod is Ready. Create in the background, wait
  # for Ready, then detach the CLI.
  echo "  ${SANDBOX_NAME}: waiting for OpenShell to allocate the sandbox"
  openshell sandbox create "${SANDBOX_CREATE_ARGS[@]}" --no-tty \
    >>"${OPENSHELL_LOG}" 2>&1 &
  CREATE_PID=$!
  wait_sandbox_ready "${SANDBOX_NAME}" || ready_ok=0
  if [[ -n "${CREATE_PID}" ]] && kill -0 "${CREATE_PID}" 2>/dev/null; then
    kill "${CREATE_PID}" 2>/dev/null || true
    wait "${CREATE_PID}" 2>/dev/null || true
  fi
else
  wait_sandbox_ready "${SANDBOX_NAME}" || ready_ok=0
fi
((ready_ok == 1)) || fail "${SANDBOX_NAME} did not become Ready; see ${OPENSHELL_LOG}"

# Patch nproc via kubectl before any OpenShell exec. Connect-shell re-applies
# nproc=512; RLIMIT_NPROC is per-UID on the node, so 10 e2e sandboxes EAGAIN.
if [[ "${AGENT_NAME}" == "openclaw" ]]; then
  echo "  ${SANDBOX_NAME}: skipping connect-shell nproc=512 (OpenShell exec EAGAIN)"
  kubectl exec -n "${SANDBOX_NS}" "${SANDBOX_NAME}" -c agent -- bash -c '
    cat > /etc/profile.d/nemoclaw-rlimits.sh << "EOF"
# Connect-shell must not re-apply nproc=512 (RLIMIT_NPROC is per-UID on the node).
true
EOF
    if [ -f /usr/local/lib/nemoclaw/sandbox-rlimits.sh ]; then
      sed -i "s/^NEMOCLAW_SANDBOX_NPROC_LIMIT=512$/NEMOCLAW_SANDBOX_NPROC_LIMIT=8192/" \
        /usr/local/lib/nemoclaw/sandbox-rlimits.sh
    fi
  ' >/dev/null 2>&1 || true
fi

# E2E create is light: pod Ready is enough. Supervisor SSH, NVIDIA policy, and
# inference.local waits are the slow path and are not needed to schedule CPU
# front ends. Pairing (SKIP_CREATE_SMOKE=0) still runs them.
if [[ "${SKIP_CREATE_SMOKE:-0}" == "1" ]]; then
  echo "  ${SANDBOX_NAME}: SKIP_CREATE_SMOKE=1; skipping supervisor/policy/smoke waits"
  echo "${AGENT_DISPLAY_NAME} sandbox ${SANDBOX_NAME} is ready without a GPU."
  exit 0
fi

wait_supervisor_exec "${SANDBOX_NAME}" || true

if agent_common_grants_nvidia_endpoint "${AGENT_NAME}"; then
  policy_ok=0
  for attempt in 1 2 3; do
    echo "  ${SANDBOX_NAME}: waiting for sandbox policy (${attempt}/3)"
    if openshell policy update "${SANDBOX_NAME}" \
      --remove-endpoint integrate.api.nvidia.com:443 \
      --wait \
      --timeout 20 \
      >>"${OPENSHELL_LOG}" 2>&1; then
      policy_ok=1
      break
    fi
    sleep 3
  done
  if [[ "${policy_ok}" -ne 1 ]]; then
    echo "  ${SANDBOX_NAME}: policy still applying (continuing; see ${OPENSHELL_LOG})"
  fi
fi
EFFECTIVE_POLICY="$(openshell policy get "${SANDBOX_NAME}" --full -o json 2>/dev/null || true)"
if grep -Fq 'integrate.api.nvidia.com' <<<"${EFFECTIVE_POLICY}"; then
  echo "WARNING: effective sandbox policy still lists integrate.api.nvidia.com" >&2
fi
unset EFFECTIVE_POLICY
case "${SKIP_WAIT_INFERENCE_LOCAL:-0}" in
  1)
    echo "  ${SANDBOX_NAME}: SKIP_WAIT_INFERENCE_LOCAL=1 (e2e checks inference.local in parallel after create)"
    ;;
  0)
    wait_inference_local "${SANDBOX_NAME}" \
      || fail "${SANDBOX_NAME}: https://inference.local not reachable. OpenShell MITM must work before the agent starts; the HPA Job's pod-IP path does not cover this."
    ;;
  *)
    fail "SKIP_WAIT_INFERENCE_LOCAL must be 0 or 1"
    ;;
esac

if [[ "${AGENT_NAME}" == "hermes" ]]; then
  echo "  ${SANDBOX_NAME}: pinning Hermes model.default=${MODEL}"
  agent_common_pin_hermes_model "${SANDBOX_NAME}" "${MODEL}" \
    || fail "${SANDBOX_NAME}: hermes config set model.default ${MODEL} failed"
fi

case "${SKIP_CREATE_SMOKE:-0}" in
  0)
    agent_common_create_smoke_test "${AGENT_NAME}" "${SANDBOX_NAME}"
    ;;
  1)
    echo "SKIP_CREATE_SMOKE=1: not running create-time smoke tests for ${SANDBOX_NAME}."
    ;;
  *)
    fail "SKIP_CREATE_SMOKE must be 0 or 1"
    ;;
esac

echo "${AGENT_DISPLAY_NAME} sandbox ${SANDBOX_NAME} is ready without a GPU."
if kubectl get gateway "${INFERENCE_GATEWAY}" -n "${INFERENCE_NAMESPACE}" >/dev/null 2>&1; then
  echo "Inference routes through OpenShell → Envoy load balancer (LeastRequest) → ${BASE_URL}; only the GPU HPA pods request GPUs."
else
  echo "Inference routes through OpenShell → metrics-proxy Service → ${BASE_URL} (Envoy LB disabled); only the GPU HPA pods request GPUs."
fi
if [[ "$(agent_common_run_mode "${AGENT_NAME}")" == "gateway" ]]; then
  echo "Start ${AGENT_DISPLAY_NAME} in a dedicated terminal, then verify it:"
  echo "  AGENT_NAME=${AGENT_NAME} ./scripts/run-agent-sandbox.sh"
  echo "  AGENT_NAME=${AGENT_NAME} ./scripts/verify-agent-sandbox.sh"
else
  echo "Verify the terminal agent, then run one-shot prompts with:"
  echo "  AGENT_NAME=${AGENT_NAME} ./scripts/verify-agent-sandbox.sh"
  echo "  AGENT_NAME=${AGENT_NAME} ./scripts/run-agent-prompt.sh \"your prompt here\""
fi
