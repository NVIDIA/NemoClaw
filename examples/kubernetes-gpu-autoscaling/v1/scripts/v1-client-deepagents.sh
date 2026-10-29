#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# End-user client for step 6c on NemoClaw v1 (Deep Agents + NIM). Same transport
# as v1-client-hermes.sh (kubectl exec + fabric-agent-ctl invoke). Defaults point
# at the Deep Agents deployment, which uses its own namespace and state directory
# so the 6b Hermes deployment stays up.
#
#   E2E_USERS=10 ./scripts/v1-client-deepagents.sh
#
# Env: NEMOCLAW_V1_STATE_DIR (default .local/gpu-autoscaling-deepagents),
# V1_NAMESPACE (default nemoclaw-v1-gpu-autoscaling-dagent), E2E_OUTPUT_DIR.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export V1_AGENT_KIND=deepagents
export NEMOCLAW_V1_STATE_DIR="${NEMOCLAW_V1_STATE_DIR:-${SCRIPT_DIR}/../.local/gpu-autoscaling-deepagents}"
export V1_NAMESPACE="${V1_NAMESPACE:-nemoclaw-v1-gpu-autoscaling-dagent}"
exec "${SCRIPT_DIR}/v1-client-hermes.sh" "$@"
