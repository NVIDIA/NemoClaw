#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Sandbox-side provision for Hermes + vLLM with LLM-latency HPA
# (nemoclaw_llm_latency_avg_milliseconds, target 3000 ms). Same sandboxes
# and client path as GPU-util: users send hermes -z into each sandbox.
#
# Switches the cluster HPA metric, then creates sandboxes.
# Provision keeps current replicas at 1 (maxReplicas stays 8). Run
# ./scripts/client_hermes.sh after sandboxes are Ready (laptop: E2E_CLIENT_HOST=dgx-ip).
# The client does not set HPA_METRIC. For GPU-util HPA use
# ./scripts/agentscaling_hermes_gpuutil.sh.
#
# Usage:
#   E2E_USERS=10 ./scripts/agentscaling_hermes_latency.sh
#   E2E_USERS=10 ./scripts/agentscaling_hermes_latency.sh start
#   ./scripts/agentscaling_hermes_latency.sh stop
#   ./scripts/agentscaling_hermes_latency.sh cleanup

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

export HPA_METRIC="latency_avg"
export HPA_TARGET_LATENCY_MS="${HPA_TARGET_LATENCY_MS:-3000}"
export MAX_TOKENS="${MAX_TOKENS:-${E2E_HERMES_LATENCY_TOKEN_START:-2048}}"
agentscaling_hermes_common_main "${1:-bringup}"
