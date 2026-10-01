#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Optional one-process wrapper for Hermes + vLLM GPU-util HPA. Prefer two terminals:
#   E2E_USERS=3 ./scripts/agentscaling_hermes_gpuutil.sh
#   E2E_USERS=3 ./scripts/client_hermes.sh
# This does not replace hpa-load-test-dgx-8xh100.sh.
# LLM latency is ./scripts/agentscaling_hermes_latency.sh then the same client_hermes.sh.
# Run ./scripts/uninstall-e2e.sh first if OpenClaw sandboxes or client.sh are still up.
#
# Usage:
#   cd deploy/helm/gpu_autoscaling_k8s
#   ./scripts/test-hermes-e2e-hpa.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export E2E_USERS="${E2E_USERS:-3}"
"${SCRIPT_DIR}/agentscaling_hermes_gpuutil.sh" bringup
exec "${SCRIPT_DIR}/client_hermes.sh"
