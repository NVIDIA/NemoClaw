#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Test-drive wrapper for this recipe: install GPU inference (Ollama, vLLM, or NIM) + HPA,
# run the synthetic HPA load test (scale-up → Envoy LeastRequest check → scale-down), then
# build/create/start/verify one CPU sandbox agent (OpenClaw, Hermes, or Deep Agents Code).
# This just calls the recipe's own scripts in order with AGENT_NAME / INFERENCE_RUNTIME
# wired through — see ../README.md and ../AGENT-SELECTION.md for what each step does and
# for the non-shortcut (TLS + OIDC) path.
#
# Run this against a cluster kubectl already points at, from this directory:
#   ./scripts/try-it.sh
#
# Everything you'd want to change lives in the block below (or override any of these as
# env vars before running, e.g. `AGENT_NAME=openclaw ./scripts/try-it.sh`).
#
# SECURITY: this script does NOT default to an insecure configuration. See the
# ALLOW_INSECURE_HTTP / ALLOW_UNAUTHENTICATED_OPENSHELL block below — you must explicitly
# opt in before it will run at all.

set -euo pipefail

# ============================================================================
# EDIT THESE
# ============================================================================
AGENT_NAME="${AGENT_NAME:-hermes}"               # openclaw | hermes | deepagents
INFERENCE_RUNTIME="${INFERENCE_RUNTIME:-vllm}"   # ollama | vllm | nim — see
                                                  # ../README.md#agent-and-runtime-support and
                                                  # ../AGENT-SELECTION.md#notes for which pairings
                                                  # are documented/tested. ollama + deepagents is
                                                  # not currently documented upstream: this script
                                                  # still runs it, but prints a warning below.
REGISTRY="${REGISTRY:-localhost:32000}"          # registry every cluster node can pull from
                                                  # (MicroK8s local registry default)

# NIM only — get a key from https://ngc.nvidia.com (Setup > API Keys). This one key
# authenticates both the nvcr.io image pull (imagePullSecret, auto-created) and the
# in-container model profile download (NGC_API_KEY) — see ../README.md#nvidia-nim-registry-access.
# export NIM_NGC_API_KEY=nvapi-...

# Optional: pin everything to one GPU node (recommended on a shared cluster).
# export NEMOCLAW_TARGET_NODE=dgx02

# Runs ./scripts/hpa-load-test.sh after installing GPU inference, so this script actually
# demonstrates GPU scale-up, Envoy LeastRequest load balancing, and scale-down — not just
# an idle install. Takes roughly 10-20 minutes depending on hardware and TARGET_PODS. Set
# to 0 to skip straight to the agent sandbox steps.
RUN_LOAD_TEST="${RUN_LOAD_TEST:-1}"

# SECURITY (required — no default): this shortcut does not silently enable an insecure
# configuration for you. It has exactly two supported modes:
#
#   1. Isolated/dedicated eval cluster (no other tenants, port-forward only, never
#      exposed externally) — explicitly acknowledge cleartext HTTP + unauthenticated
#      OpenShell for a fast test by exporting all three of:
#        export ALLOW_INSECURE_HTTP=1
#        export ALLOW_UNAUTHENTICATED_OPENSHELL=1
#        export OPENSHELL_UNAUTHENTICATED_ACK=dedicated-cluster-port-forward-only
#
#   2. Shared/production cluster — leave all three unset (the default) and instead
#      configure ingress.tls + OPENSHELL_OIDC_ISSUER before running; see
#      ../README.md#tls-values. This shortcut has no flags for your certificates or OIDC
#      issuer, so ./scripts/install-hpa.sh / ./scripts/install-openshell-k8s.sh below will
#      fail fast with instructions if those aren't configured — that failure is intentional,
#      not a bug, and follows the recipe's normal secure-by-default scripts.
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
  ollama)
    INFERENCE_MODEL="${INFERENCE_MODEL:-llama3.2:3b}"
    if [[ "${AGENT_NAME}" == "deepagents" ]]; then
      echo "WARNING: AGENT_NAME=deepagents with INFERENCE_RUNTIME=ollama is not currently" \
        "documented upstream (see ../README.md#agent-and-runtime-support and" \
        "../AGENT-SELECTION.md#notes) — continuing, but treat this pairing as" \
        "unsupported/untested, not a validated combination." >&2
    fi
    ;;
  vllm)
    INFERENCE_MODEL="${INFERENCE_MODEL:-nvidia/NVIDIA-Nemotron-3-Nano-4B-FP8}"
    ;;
  nim)
    INFERENCE_MODEL="${INFERENCE_MODEL:-nvidia/nemotron-3-nano}"
    : "${NIM_NGC_API_KEY:?export NIM_NGC_API_KEY=nvapi-... before running (NIM needs an NGC key)}"
    ;;
  *)
    echo "ERROR: INFERENCE_RUNTIME must be ollama, vllm, or nim (got '${INFERENCE_RUNTIME}')." >&2
    exit 1
    ;;
esac
export INFERENCE_RUNTIME INFERENCE_MODEL

case "${RUN_LOAD_TEST}" in
  0 | 1) ;;
  *)
    echo "ERROR: RUN_LOAD_TEST must be 0 or 1 (got '${RUN_LOAD_TEST}')." >&2
    exit 1
    ;;
esac

# Transparency, not enforcement: install-hpa.sh / install-openshell-k8s.sh below are the
# ones that actually validate and enforce these — this just states the mode up front so
# it's never a silent surprise which path you're on.
if [[ "${ALLOW_INSECURE_HTTP:-0}" == "1" || "${ALLOW_UNAUTHENTICATED_OPENSHELL:-0}" == "1" ]]; then
  echo "Security mode: ISOLATED-EVAL SHORTCUT (cleartext HTTP and/or unauthenticated OpenShell requested via env vars)." >&2
else
  echo "Security mode: SECURE (default) — TLS + OIDC required; the install steps below will fail fast with setup instructions if ingress.tls / OPENSHELL_OIDC_ISSUER aren't configured. See ../README.md#tls-values, or opt into the isolated-eval shortcut (see the SECURITY comment at the top of this script)." >&2
fi

echo "=== 1/7: GPU + DCGM sanity check ==="
kubectl get nodes \
  -o jsonpath='{range .items[*]}{.metadata.name}{" GPUs="}{.status.allocatable.nvidia\.com/gpu}{"\n"}{end}'
kubectl get pods -n gpu-operator-resources -l app=nvidia-dcgm-exporter

echo "=== 2/7: Install GPU inference (${INFERENCE_RUNTIME}) + HPA ==="
./scripts/install-hpa.sh
kubectl get pods,service,hpa -n nemoclaw-gpu
./scripts/get-hpa.sh -n nemoclaw-gpu

if [[ "${RUN_LOAD_TEST}" == "1" ]]; then
  echo "=== 3/7: Synthetic HPA load test (scale-up -> Envoy LeastRequest check -> scale-down) ==="
  ./scripts/hpa-load-test.sh
else
  echo "=== 3/7: Synthetic HPA load test skipped (RUN_LOAD_TEST=0) ==="
fi

echo "=== 4/7: Agent Sandbox CRDs + build ${AGENT_NAME} sandbox image ==="
kubectl apply -f \
  "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${AGENT_SANDBOX_VERSION}/manifest.yaml"
microk8s enable registry 2>/dev/null || true   # no-op if already on / not MicroK8s
AGENT_SANDBOX_IMAGE="${REGISTRY}/nemoclaw-${AGENT_NAME}-k8s:${NEMOCLAW_VERSION}"
export AGENT_SANDBOX_IMAGE
./scripts/build-agent-sandbox-image.sh

echo "=== 5/7: Install OpenShell gateway ==="
./scripts/install-openshell-k8s.sh

echo "=== 6/7: Port-forward + connect OpenShell CLI (no second terminal needed) ==="
PF_LOG="$(mktemp)"
AGENT_RUNTIME_LOG=""
AGENT_RUNTIME_PID=""
kubectl -n nemoclaw-sandboxes port-forward service/openshell 8080:8080 >"${PF_LOG}" 2>&1 &
PF_PID=$!
cleanup() {
  if [[ -n "${AGENT_RUNTIME_PID}" ]]; then
    kill "${AGENT_RUNTIME_PID}" 2>/dev/null || true
    wait "${AGENT_RUNTIME_PID}" 2>/dev/null || true
  fi
  kill "${PF_PID}" 2>/dev/null || true
  rm -f "${PF_LOG}"
  [[ -z "${AGENT_RUNTIME_LOG}" ]] || rm -f "${AGENT_RUNTIME_LOG}"
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

echo "=== 7/7: Create, start, and verify ${AGENT_NAME} sandbox ==="
./scripts/create-agent-sandbox.sh

if [[ "$(agent_common_run_mode "${AGENT_NAME}")" == "terminal" ]]; then
  ./scripts/verify-agent-sandbox.sh
  echo "${AGENT_NAME} verification complete. Run more prompts with:"
  echo "  AGENT_NAME=${AGENT_NAME} ./scripts/run-agent-prompt.sh \"your prompt here\""
else
  AGENT_RUNTIME_LOG="$(mktemp)"
  ./scripts/run-agent-sandbox.sh >"${AGENT_RUNTIME_LOG}" 2>&1 &
  AGENT_RUNTIME_PID=$!
  if ! ./scripts/verify-agent-sandbox.sh; then
    echo "ERROR: ${AGENT_NAME} verification failed; runtime log follows:" >&2
    tail -n 100 "${AGENT_RUNTIME_LOG}" >&2 || true
    exit 1
  fi
  echo "${AGENT_NAME} gateway verified and running — Ctrl+C to stop."
  wait "${AGENT_RUNTIME_PID}"
fi
