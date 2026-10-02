#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Sandbox-side provision for Hermes + vLLM with GPU-utilization HPA
# (DCGM gpu_utilization_percent, target 40%). One sandbox per end user.
# Clients send hermes -z into each sandbox. They call inference.local →
# Envoy → vLLM.
#
# Default is 3 users at 4Gi (2Gi + inflight 2 OOMed dgx-19). Inflight stays 1.
# Isolated eval without TLS must set ALLOW_INSECURE_HTTP=1 explicitly.
# Run ./scripts/uninstall-e2e.sh first if OpenClaw sandboxes or client.sh
# are still running. GPU inference can stay; this script helm-upgrades the
# same release to INFERENCE_RUNTIME (default vllm).
#
# The client does not know this metric. Use ./scripts/client_hermes.sh after
# sandboxes are Ready. For LLM-latency HPA use
# ./scripts/agentscaling_hermes_latency.sh.
#
# Defaults in this script: AGENT_NAME=hermes INFERENCE_RUNTIME=vllm
# INFERENCE_MODEL=nvidia/NVIDIA-Nemotron-3-Nano-4B-FP8. Override GPU backend:
#   INFERENCE_RUNTIME=ollama ./scripts/agentscaling_hermes_gpuutil.sh
# Other vLLM id:
#   INFERENCE_MODEL=meta-llama/Llama-3.1-8B-Instruct ./scripts/agentscaling_hermes_gpuutil.sh
# Other agent: agentscaling_gpuutil.sh or agentscaling_deepagents_gpuutil.sh
#
# Usage:
#   cd deploy/helm/gpu_autoscaling_k8s
#   E2E_USERS=3 ALLOW_INSECURE_HTTP=1 ./scripts/agentscaling_hermes_gpuutil.sh
#   E2E_USERS=3 ./scripts/agentscaling_hermes_gpuutil.sh start
#   ./scripts/agentscaling_hermes_gpuutil.sh stop
#   ./scripts/agentscaling_hermes_gpuutil.sh cleanup

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=versions.env
source "${CHART_DIR}/versions.env"
# shellcheck source=hpa-common.sh
source "${SCRIPT_DIR}/hpa-common.sh"
# shellcheck source=agent-common.sh
source "${SCRIPT_DIR}/agent-common.sh"
# shellcheck source=agentscaling-hermes-common.sh
source "${SCRIPT_DIR}/agentscaling-hermes-common.sh"
hpa_common_load_local_env "${CHART_DIR}"

export HPA_METRIC="gpu_utilization"
export GPU_TARGET="${GPU_TARGET:-40}"
agentscaling_hermes_common_main "${1:-bringup}"
