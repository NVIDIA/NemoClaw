#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Optional one-process wrapper for Hermes + vLLM LLM-latency HPA. Prefer two terminals:
#   E2E_USERS=3 ./scripts/agentscaling_hermes_latency.sh
#   E2E_USERS=3 ./scripts/client_hermes.sh
# Same client as GPU util. The client does not set HPA_METRIC.
# This does not replace hpa-load-test-dgx-8xh100.sh.
# Do not run this while the OpenClaw e2e owns the GPUs.
#
# Usage:
#   cd deploy/helm/gpu_autoscaling_k8s
#   ./scripts/test-hermes-e2e-latency-hpa.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export E2E_USERS="${E2E_USERS:-3}"
"${SCRIPT_DIR}/agentscaling_hermes_latency.sh" bringup
exec "${SCRIPT_DIR}/client_hermes.sh"
