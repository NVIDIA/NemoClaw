#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Sandbox-side provision for Deep Agents Code + NIM with LLM-latency HPA
# (nemoclaw_llm_latency_avg_milliseconds, target 3000 ms). Same sandboxes
# and client path as GPU-util: users send dcode -n into each sandbox.
#
# Switches the cluster HPA metric, then creates sandboxes.
# Kubernetes needs both NIM Secrets (kubelet image pull + running NIM model
# profile). After 6b, run ./scripts/apply-local-secrets.sh --replace if
# ngc-registry is missing.
# Provision keeps current replicas at 1 (maxReplicas stays 8). Run
# ./scripts/client_deepagents.sh after sandboxes are Ready (no HTTP UI).
# The client does not set HPA_METRIC. For GPU-util HPA use
# ./scripts/agentscaling_deepagents_gpuutil.sh.
#
# Usage:
#   E2E_USERS=10 ./scripts/agentscaling_deepagents_latency.sh
#   E2E_USERS=10 ./scripts/agentscaling_deepagents_latency.sh start
#   ./scripts/agentscaling_deepagents_latency.sh stop
#   ./scripts/agentscaling_deepagents_latency.sh cleanup

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

export HPA_METRIC="latency_avg"
export HPA_TARGET_LATENCY_MS="${HPA_TARGET_LATENCY_MS:-3000}"
export MAX_TOKENS="${MAX_TOKENS:-${E2E_LATENCY_TOKEN_START:-64}}"
agentscaling_deepagents_common_main "${1:-bringup}"
