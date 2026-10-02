#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Sandbox-side provision for Deep Agents Code + NIM with GPU-utilization HPA
# (DCGM gpu_utilization_percent, target 40%). One sandbox per end user.
# Clients send dcode -n into each sandbox. They call inference.local →
# Envoy → NIM.
#
# Default is 3 users at 4Gi. Inflight stays 1.
# Isolated eval without TLS must set ALLOW_INSECURE_HTTP=1 explicitly.
# NIM needs NGC Secrets (apply-local-secrets.sh or create-nim-ngc-secrets.sh).
# Run ./scripts/uninstall-e2e.sh first if OpenClaw or Hermes sandboxes or
# clients are still running. GPU inference can stay; this script helm-upgrades
# the same release to INFERENCE_RUNTIME (default nim).
#
# The client does not know this metric. Use ./scripts/client_deepagents.sh after
# sandboxes are Ready. Provision holds HPA at 1 replica; the client arms
# maxReplicas=8 and sends dcode -n. For LLM-latency HPA use
# ./scripts/agentscaling_deepagents_latency.sh.
#
# Defaults in this script: AGENT_NAME=deepagents INFERENCE_RUNTIME=nim
# INFERENCE_MODEL=nvidia/nemotron-3-nano. Override GPU backend:
#   INFERENCE_RUNTIME=vllm ./scripts/agentscaling_deepagents_gpuutil.sh
# Other NIM catalog id:
#   INFERENCE_MODEL=nvidia/<nim-model-id> ./scripts/agentscaling_deepagents_gpuutil.sh
# Other agent: agentscaling_gpuutil.sh or agentscaling_hermes_gpuutil.sh
#
# Usage:
#   cd deploy/helm/gpu_autoscaling_k8s
#   E2E_USERS=3 ALLOW_INSECURE_HTTP=1 ./scripts/agentscaling_deepagents_gpuutil.sh
#   E2E_USERS=3 ./scripts/agentscaling_deepagents_gpuutil.sh start
#   ./scripts/agentscaling_deepagents_gpuutil.sh stop
#   ./scripts/agentscaling_deepagents_gpuutil.sh cleanup

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=versions.env
source "${CHART_DIR}/versions.env"
# shellcheck source=hpa-common.sh
source "${SCRIPT_DIR}/hpa-common.sh"
# shellcheck source=agent-common.sh
source "${SCRIPT_DIR}/agent-common.sh"
# shellcheck source=agentscaling-deepagents-common.sh
source "${SCRIPT_DIR}/agentscaling-deepagents-common.sh"
hpa_common_load_local_env "${CHART_DIR}"

export HPA_METRIC="gpu_utilization"
export GPU_TARGET="${GPU_TARGET:-40}"
agentscaling_deepagents_common_main "${1:-bringup}"
