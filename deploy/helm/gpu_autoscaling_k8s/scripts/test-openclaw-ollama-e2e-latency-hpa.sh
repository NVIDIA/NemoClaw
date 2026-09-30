#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Optional one-process wrapper for LLM-latency HPA. Prefer two terminals:
#   E2E_USERS=5 ./scripts/agentscaling_latency.sh
#   E2E_USERS=5 ./scripts/client.sh
# Same client as GPU util. The client does not set HPA_METRIC.
# This does not replace hpa-load-test-dgx-8xh100.sh.
#
# Usage:
#   cd deploy/helm/gpu_autoscaling_k8s
#   ./scripts/test-openclaw-ollama-e2e-latency-hpa.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export E2E_USERS="${E2E_USERS:-5}"
"${SCRIPT_DIR}/agentscaling_latency.sh" bringup
exec "${SCRIPT_DIR}/client.sh"
