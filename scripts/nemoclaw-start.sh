#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# NemoClaw container entrypoint. Runs nemoclaw onboard (non-interactive) on
# first boot, then keeps the container alive monitoring the sandbox.
#
# Required env:
#   NVIDIA_API_KEY   API key for NVIDIA-hosted inference
#
# Optional env:
#   NEMOCLAW_SANDBOX_NAME  Sandbox name (default: my-assistant)
#   NEMOCLAW_PROVIDER      Inference provider: cloud, ollama, vllm, nim
#   NEMOCLAW_MODEL         Model override
#   CHAT_UI_URL            Browser origin for the dashboard

set -euo pipefail

export NEMOCLAW_NON_INTERACTIVE=1
SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-my-assistant}"

echo '[nemoclaw-start] Running nemoclaw onboard...'
nemoclaw onboard --non-interactive

echo "[nemoclaw-start] Onboarding complete. Monitoring sandbox '${SANDBOX_NAME}'..."

# Keep the container alive. If the sandbox or gateway exits, the container stops.
# Poll sandbox health so `docker logs` shows ongoing status.
while true; do
    if ! openshell sandbox get "$SANDBOX_NAME" > /dev/null 2>&1; then
        echo "[nemoclaw-start] Sandbox '${SANDBOX_NAME}' is no longer running."
        break
    fi
    sleep 30
done
