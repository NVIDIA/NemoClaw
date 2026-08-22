#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Test-drive wrapper for this recipe: install GPU inference (vLLM or NIM) + HPA, then
# build/create/verify/run one CPU sandbox agent (OpenClaw, Hermes, or Deep Agents Code).
# This just calls the recipe's own scripts in order with AGENT_NAME / INFERENCE_RUNTIME
# wired through — see ../README.md and ../AGENT-SELECTION.md for what each step does and
# for the non-shortcut (TLS + OIDC) path.
#
# Run this against a cluster kubectl already points at, from this directory:
#   ./scripts/try-it.sh
#
# Everything you'd want to change lives in the block below (or override any of these as
# env vars before running, e.g. `AGENT_NAME=openclaw ./scripts/try-it.sh`).

set -euo pipefail

# ============================================================================
# EDIT THESE
# ============================================================================
AGENT_NAME="${AGENT_NAME:-hermes}"               # openclaw | hermes | deepagents
INFERENCE_RUNTIME="${INFERENCE_RUNTIME:-vllm}"   # vllm | nim
REGISTRY="${REGISTRY:-localhost:32000}"          # registry every cluster node can pull from
                                                  # (MicroK8s local registry default)

# NIM only — get a key from https://ngc.nvidia.com (Setup > API Keys):
# export NIM_NGC_API_KEY=nvapi-...

# Optional: pin everything to one GPU node (recommended on a shared cluster).
# export NEMOCLAW_TARGET_NODE=dgx02

# Isolated/dedicated eval cluster only — skips TLS + OIDC setup for a fast test.
# Do NOT set these on a shared/production cluster; see ../README.md#tls-values instead.
ALLOW_INSECURE_HTTP="${ALLOW_INSECURE_HTTP:-1}"
ALLOW_UNAUTHENTICATED_OPENSHELL="${ALLOW_UNAUTHENTICATED_OPENSHELL:-1}"
OPENSHELL_UNAUTHENTICATED_ACK="${OPENSHELL_UNAUTHENTICATED_ACK:-dedicated-cluster-port-forward-only}"
export ALLOW_INSECURE_HTTP ALLOW_UNAUTHENTICATED_OPENSHELL OPENSHELL_UNAUTHENTICATED_ACK
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${CHART_DIR}"
# shellcheck source=versions.env
source versions.env
# shellcheck source=agent-common.sh
source "${SCRIPT_DIR}/agent-common.sh"

agent_common_validate "${AGENT_NAME}"
export AGENT_NAME

case "${INFERENCE_RUNTIME}" in
  vllm)
    INFERENCE_MODEL="${INFERENCE_MODEL:-nvidia/NVIDIA-Nemotron-3-Nano-4B-FP8}"
    ;;
  nim)
    INFERENCE_MODEL="${INFERENCE_MODEL:-nvidia/nemotron-3-nano}"
    : "${NIM_NGC_API_KEY:?export NIM_NGC_API_KEY=nvapi-... before running (NIM needs an NGC key)}"
    ;;
  *)
    echo "ERROR: INFERENCE_RUNTIME must be vllm or nim (got '${INFERENCE_RUNTIME}')" >&2
    exit 1
    ;;
esac
export INFERENCE_RUNTIME INFERENCE_MODEL

echo "=== 1/6: GPU + DCGM sanity check ==="
kubectl get nodes \
  -o jsonpath='{range .items[*]}{.metadata.name}{" GPUs="}{.status.allocatable.nvidia\.com/gpu}{"\n"}{end}'
kubectl get pods -n gpu-operator-resources -l app=nvidia-dcgm-exporter

echo "=== 2/6: Install GPU inference (${INFERENCE_RUNTIME}) + HPA ==="
./scripts/install-hpa.sh
kubectl get pods,service,hpa -n nemoclaw-gpu
./scripts/get-hpa.sh -n nemoclaw-gpu

echo "=== 3/6: Agent Sandbox CRDs + build ${AGENT_NAME} sandbox image ==="
kubectl apply -f \
  "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${AGENT_SANDBOX_VERSION}/manifest.yaml"
microk8s enable registry 2>/dev/null || true   # no-op if already on / not MicroK8s
AGENT_SANDBOX_IMAGE="${REGISTRY}/nemoclaw-${AGENT_NAME}-k8s:${NEMOCLAW_VERSION}"
export AGENT_SANDBOX_IMAGE
./scripts/build-agent-sandbox-image.sh

echo "=== 4/6: Install OpenShell gateway ==="
./scripts/install-openshell-k8s.sh

echo "=== 5/6: Port-forward + connect OpenShell CLI (no second terminal needed) ==="
PF_LOG="$(mktemp)"
kubectl -n nemoclaw-sandboxes port-forward service/openshell 8080:8080 >"${PF_LOG}" 2>&1 &
PF_PID=$!
cleanup() {
  kill "${PF_PID}" 2>/dev/null || true
  rm -f "${PF_LOG}"
}
trap cleanup EXIT INT TERM

echo "Waiting for the OpenShell gateway port-forward to come up..."
for _ in $(seq 1 30); do
  kill -0 "${PF_PID}" 2>/dev/null || { echo "ERROR: port-forward exited early; see below:" >&2; cat "${PF_LOG}" >&2; exit 1; }
  (exec 3<>"/dev/tcp/127.0.0.1/8080") 2>/dev/null && exec 3>&- 3<&- && break
  sleep 1
done

MTLS_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/openshell/gateways/nemoclaw-k8s/mtls"
if [[ -f "${MTLS_DIR}/tls.key" ]] && openshell status >/dev/null 2>&1; then
  echo "OpenShell gateway nemoclaw-k8s is already registered and reachable."
else
  mkdir -p "${MTLS_DIR}"
  for key in ca.crt tls.crt tls.key; do
    kubectl get secret openshell-client-tls -n nemoclaw-sandboxes \
      -o "jsonpath={.data.${key//./\\.}}" | base64 -d >"${MTLS_DIR}/${key}"
  done
  chmod 600 "${MTLS_DIR}"/*
  openshell gateway add https://127.0.0.1:8080 --local --name nemoclaw-k8s
fi
openshell status

echo "=== 6/6: Create, verify, and run ${AGENT_NAME} sandbox ==="
./scripts/create-agent-sandbox.sh
./scripts/verify-agent-sandbox.sh

if [[ "$(agent_common_run_mode "${AGENT_NAME}")" == "terminal" ]]; then
  ./scripts/run-agent-prompt.sh "Explain this repository in one sentence."
else
  echo "Starting ${AGENT_NAME} in the foreground — Ctrl+C to stop:"
  ./scripts/run-agent-sandbox.sh
fi
