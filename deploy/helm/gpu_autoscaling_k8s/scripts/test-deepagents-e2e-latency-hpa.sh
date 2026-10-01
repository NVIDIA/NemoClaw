#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Optional one-process wrapper for Deep Agents Code + NIM LLM-latency HPA. Prefer two terminals:
#   E2E_USERS=3 ./scripts/agentscaling_deepagents_latency.sh
#   E2E_USERS=3 ./scripts/client_deepagents.sh
# Same client as GPU util. The client does not set HPA_METRIC.
# This does not replace hpa-load-test-dgx-8xh100.sh.
# Run ./scripts/uninstall-e2e.sh first if OpenClaw sandboxes or client.sh are still up.
#
# Usage:
#   cd deploy/helm/gpu_autoscaling_k8s
#   ./scripts/test-deepagents-e2e-latency-hpa.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export E2E_USERS="${E2E_USERS:-3}"
"${SCRIPT_DIR}/agentscaling_deepagents_latency.sh" bringup
exec "${SCRIPT_DIR}/client_deepagents.sh"
