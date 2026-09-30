#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Provision OpenClaw sandboxes for the OpenClaw + Ollama e2e: one sandbox
# per end user. Sandboxes listen on :18789 for that user's chat. They call
# inference.local → Envoy load balancer → Ollama.
#
# End-user clients must not run this. They do not build images, create
# sandboxes, or start OpenClaw. Use ./scripts/client.sh after this returns.
#
# Usage:
#   cd deploy/helm/gpu_autoscaling_k8s
#   E2E_USERS=5 ./scripts/agentscaling.sh          # create + start (bringup)
#   E2E_USERS=5 ./scripts/agentscaling.sh start    # start OpenClaw in existing sandboxes
#   ./scripts/agentscaling.sh stop
#   ./scripts/agentscaling.sh cleanup

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cmd="${1:-bringup}"
exec "${SCRIPT_DIR}/setup-openclaw-ollama-e2e-sandboxes.sh" "${cmd}"
