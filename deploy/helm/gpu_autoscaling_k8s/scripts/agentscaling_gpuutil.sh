#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Sandbox-side provision for OpenClaw + Ollama with GPU-utilization HPA
# (DCGM gpu_utilization_percent, target 40%). One sandbox per end user.
# Sandboxes listen on :18789. They call inference.local → Envoy → Ollama.
#
# This is the path that scaled on this DGX: 5 users, 8Gi sandboxes,
# llama3.2:3b, then ./scripts/client.sh in another terminal.
# Isolated eval without TLS must set ALLOW_INSECURE_HTTP=1 explicitly.
#
# The client does not know this metric. Use ./scripts/client.sh after
# :18789 is up. For LLM-latency HPA use ./scripts/agentscaling_latency.sh.
#
# Usage:
#   cd deploy/helm/gpu_autoscaling_k8s
#   E2E_USERS=5 ./scripts/agentscaling_gpuutil.sh
#   E2E_USERS=5 ./scripts/agentscaling_gpuutil.sh start
#   ./scripts/agentscaling_gpuutil.sh stop
#   ./scripts/agentscaling_gpuutil.sh cleanup

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=versions.env
source "${CHART_DIR}/versions.env"
# shellcheck source=hpa-common.sh
source "${SCRIPT_DIR}/hpa-common.sh"
# shellcheck source=agent-common.sh
source "${SCRIPT_DIR}/agent-common.sh"
# shellcheck source=agentscaling-common.sh
source "${SCRIPT_DIR}/agentscaling-common.sh"
hpa_common_load_local_env "${CHART_DIR}"

export HPA_METRIC="gpu_utilization"
export GPU_TARGET="${GPU_TARGET:-40}"
agentscaling_common_main "${1:-bringup}"
