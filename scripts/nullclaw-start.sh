#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# NemoClaw sandbox entrypoint for the NullClaw runtime.
# Configures NullClaw to use the OpenShell-managed inference.local endpoint,
# then starts the gateway inside the sandbox.

set -euo pipefail

NULLCLAW_CMD=("$@")
PUBLIC_PORT="${PUBLIC_PORT:-3000}"
NULLCLAW_MODEL="${NULLCLAW_MODEL:-nvidia/nemotron-3-super-120b-a12b}"
NULLCLAW_PROVIDER="${NULLCLAW_PROVIDER:-custom:https://inference.local/v1}"
NULLCLAW_API_KEY="${NULLCLAW_API_KEY:-openshell-managed}"

echo "Setting up NemoClaw (NullClaw runtime)..."
mkdir -p "${HOME}/.nullclaw"

nullclaw onboard \
  --api-key "${NULLCLAW_API_KEY}" \
  --provider "${NULLCLAW_PROVIDER}" \
  --model "${NULLCLAW_MODEL}" \
  > /tmp/nullclaw-onboard.log 2>&1

if [ ${#NULLCLAW_CMD[@]} -gt 0 ]; then
  exec "${NULLCLAW_CMD[@]}"
fi

nohup nullclaw gateway --host 0.0.0.0 --port "${PUBLIC_PORT}" > /tmp/nullclaw-gateway.log 2>&1 &
echo "[gateway] nullclaw gateway launched (pid $!)"
echo "[gateway] health: http://127.0.0.1:${PUBLIC_PORT}/health"
