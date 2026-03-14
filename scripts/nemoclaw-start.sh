#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# NemoClaw sandbox entrypoint. Sets up OpenClaw with NVIDIA provider
# and drops the user into a ready-to-use environment.
#
# Required env: NVIDIA_API_KEY

set -euo pipefail

# Save any passed command for later
NEMOCLAW_CMD=("$@")

if [ -z "${NVIDIA_API_KEY:-}" ]; then
  echo "ERROR: NVIDIA_API_KEY is not set."
  echo "Pass it when creating the sandbox:"
  echo "  openshell sandbox create --from ./Dockerfile --name nemoclaw -- env NVIDIA_API_KEY=nvapi-..."
  exit 1
fi

echo "Setting up NemoClaw..."

# Fix config if needed
openclaw doctor --fix > /dev/null 2>&1 || true

# Set Nemotron 3 Super as the default model
openclaw models set nvidia/nvidia/nemotron-3-super-120b-a12b > /dev/null 2>&1

# Write auth profile so the nvidia provider is activated
python3 -c "
import json, os
path = os.path.expanduser('~/.openclaw/agents/main/agent/auth-profiles.json')
os.makedirs(os.path.dirname(path), exist_ok=True)
json.dump({
    'nvidia:manual': {
        'type': 'api_key',
        'provider': 'nvidia',
        'keyRef': {'source': 'env', 'id': 'NVIDIA_API_KEY'},
        'profileId': 'nvidia:manual',
    }
}, open(path, 'w'))
os.chmod(path, 0o600)
"

# Install NemoClaw plugin
openclaw plugins install /opt/nemoclaw > /dev/null 2>&1 || true

echo ""
echo "NemoClaw ready. Nemotron 3 Super 120B configured."
echo ""
echo "  openclaw agent --agent main --local -m 'your prompt' --session-id test1"
echo ""

# If arguments were passed, run them; otherwise drop into interactive shell
if [ ${#NEMOCLAW_CMD[@]} -gt 0 ]; then
  exec "${NEMOCLAW_CMD[@]}"
else
  exec /bin/bash
fi
