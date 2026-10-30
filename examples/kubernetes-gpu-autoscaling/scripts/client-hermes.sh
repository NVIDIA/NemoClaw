#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# End-user client for Hermes + vLLM. One simulated user per sandbox (1:1).
#
# HPA load client. Each prompt is fabric-agent-ctl invoke inside the sandbox via
# kubectl exec. That is a development-profile bypass: it skips gateway auth on
# the prompt hop. Official operator invoke is scripts/invoke.sh after oidc.
#
# Apply a deployment with at least E2E_USERS sandboxes first:
#   E2E_USERS=10 ./scripts/render-sandboxes.sh hermes-vllm > .local/hermes-vllm-10.yaml
#   nemoclaw apply --non-interactive --state-dir .local/gpu-autoscaling .local/hermes-vllm-10.yaml
#
# GPU util takes INFLIGHT and MAX_TOKENS on the client (Hermes 2 and 1024,
# OpenClaw 4 and 2048, Deep Agents 3). Latency omits them. Hermes latency is
# INFLIGHT=1 MAX_TOKENS=2048 in the code and ignores leftovers.
#   INFLIGHT=2 MAX_TOKENS=1024 E2E_USERS=10 ./scripts/client-hermes.sh
#   E2E_USERS=10 ./scripts/client-hermes.sh
# The DGX prints the HPA with ./scripts/get-hpa.sh -n nemoclaw-gpu -w.
# This client does not set maxReplicas and does not print the HPA.
#
# Env: NEMOCLAW_V1_STATE_DIR (default .local/gpu-autoscaling), V1_NAMESPACE,
# E2E_OUTPUT_DIR, DURATION_SEC.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RECIPE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=agent-common.sh
source "${SCRIPT_DIR}/agent-common.sh"
# shellcheck source=hpa-common.sh
source "${SCRIPT_DIR}/hpa-common.sh"

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

export PATH="${HOME}/.local/bin:${PATH}"
export E2E_USERS="${E2E_USERS:-10}"
export V1_NAMESPACE="${V1_NAMESPACE:-nemoclaw-v1-gpu-autoscaling}"
export NEMOCLAW_V1_STATE_DIR="${NEMOCLAW_V1_STATE_DIR:-${RECIPE_DIR}/.local/gpu-autoscaling}"
# hermes (default) or deepagents. client-deepagents.sh sets it.
AGENT_KIND="${V1_AGENT_KIND:-hermes}"
INFERENCE_RUNTIME="${INFERENCE_RUNTIME:-$(agent_common_default_inference_runtime "${AGENT_KIND}")}"
export INFERENCE_RUNTIME
agent_common_validate_inference_runtime "${INFERENCE_RUNTIME}"
INFERENCE_MODEL="$(agent_common_resolve_inference_model "${INFERENCE_RUNTIME}")"
export INFERENCE_MODEL
export NAMESPACE="${NAMESPACE:-nemoclaw-gpu}"
export HPA_NAME="${HPA_NAME:-nemoclaw-gpu-metrics-proxy}"
export DURATION_SEC="${DURATION_SEC:-900}"
export E2E_PROMPT_TIMEOUT_SEC="${E2E_PROMPT_TIMEOUT_SEC:-180}"
agent_common_export_demo_workload "${AGENT_KIND}"
agent_common_export_client_tokens "${AGENT_KIND}"
agent_common_export_client_inflight
# Stop new chats at the target GPU count. Do not hold replicas or pause scale-down.
export MAX_REPLICAS_HOLD_SEC="${MAX_REPLICAS_HOLD_SEC:-0}"
export SCALE_DOWN_WAIT_LOOPS="${SCALE_DOWN_WAIT_LOOPS:-40}"
export E2E_OUTPUT_DIR="${E2E_OUTPUT_DIR:-${RECIPE_DIR}/e2e-results/${AGENT_KIND}}"

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

hpa_max="$(kubectl get hpa "${HPA_NAME}" -n "${NAMESPACE}" -o jsonpath='{.spec.maxReplicas}' 2>/dev/null || true)"
[[ "${hpa_max}" =~ ^[1-9][0-9]*$ ]] || fail "HPA ${NAMESPACE}/${HPA_NAME} has no maxReplicas. Set the ceiling on the DGX with install-hpa.sh."

echo "Client: ${E2E_USERS} end users → ${E2E_USERS} sandboxes (1:1 ${AGENT_KIND})."
echo "inflight/user: ${INFLIGHT}  max_tokens: ${MAX_TOKENS}  HPA maxReplicas: ${hpa_max}"
agent_common_print_load_banner "${DURATION_SEC}" "${MAX_REPLICAS_HOLD_SEC}" "${AGENT_KIND}"

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

# Fabric OpenClaw writes /sandbox/tmp/nemo-fabric-openclaw-*/openclaw.json with no tools
# block, so llama3.2:3b hangs on ask_user until the 290s Fabric deadline.
if [[ "${AGENT_KIND}" == "openclaw" ]]; then
  echo "Pin OpenClaw tools.profile=minimal on ${E2E_USERS} sandboxes."
  for ((i = 0; i < E2E_USERS; i += 1)); do
    name="$(printf '%s%04d' "${SANDBOX_PREFIX}" "${i}")"
    if ! kubectl exec -i -n "${V1_NAMESPACE}" "${name}" -c agent -- python3 - <<'PY'
import glob
import json
import pathlib
import sys

paths = glob.glob("/sandbox/tmp/nemo-fabric-openclaw-*/openclaw.json")
if not paths:
    print("missing Fabric OpenClaw config", file=sys.stderr)
    raise SystemExit(1)
path = pathlib.Path(paths[0])
cfg = json.loads(path.read_text())
tools = cfg.setdefault("tools", {})
if not isinstance(tools, dict):
    tools = {}
    cfg["tools"] = tools
tools["profile"] = "minimal"
deny = tools.get("deny")
if not isinstance(deny, list):
    deny = []
for tool_name in (
    "message",
    "cron",
    "gateway",
    "nodes",
    "sessions_send",
    "exec",
    "process",
    "bash",
    "write",
    "read",
    "edit",
):
    if tool_name not in deny:
        deny.append(tool_name)
tools["deny"] = deny
path.write_text(json.dumps(cfg, indent=2) + "\n")
print(f"pinned {path}")
PY
    then
      fail "could not pin OpenClaw tools on ${name}"
    fi
  done
fi

mkdir -p "${E2E_OUTPUT_DIR}"
cd "${RECIPE_DIR}" || fail "cannot cd to ${RECIPE_DIR}"
exec python3 "${SCRIPT_DIR}/e2e-fabric-load-test.py" \
  --users "${E2E_USERS}" \
  --prefix "${SANDBOX_PREFIX}" \
  --output "${E2E_OUTPUT_DIR}" \
  --duration "${DURATION_SEC}" \
  --inflight-per-user "${E2E_INFLIGHT_PER_USER}" \
  --inflight-start "${E2E_INFLIGHT_START_PER_USER}" \
  --target-pods "${hpa_max}" \
  --hold-sec "${MAX_REPLICAS_HOLD_SEC}" \
  --hpa-namespace "${NAMESPACE}" \
  --hpa-name "${HPA_NAME}" \
  --scale-down-wait-loops "${SCALE_DOWN_WAIT_LOOPS}"
