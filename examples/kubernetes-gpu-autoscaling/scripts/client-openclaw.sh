#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# End-user client for OpenClaw + Ollama. Same development-profile kubectl-exec
# bypass as client-hermes.sh. Defaults point at the OpenClaw deployment, which
# uses its own namespace and state directory so the Hermes deployment stays up.
#
#   E2E_USERS=10 ./scripts/client-openclaw.sh
#
# Env: NEMOCLAW_V1_STATE_DIR (default .local/gpu-autoscaling-openclaw),
# V1_NAMESPACE (default nemoclaw-v1-gpu-autoscaling-openclaw), E2E_OUTPUT_DIR.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export V1_AGENT_KIND=openclaw
export NEMOCLAW_V1_STATE_DIR="${NEMOCLAW_V1_STATE_DIR:-${SCRIPT_DIR}/../.local/gpu-autoscaling-openclaw}"
export V1_NAMESPACE="${V1_NAMESPACE:-nemoclaw-v1-gpu-autoscaling-openclaw}"
# YAML harness timeoutSeconds is 300. OpenClaw + llama3.2:3b turns often
# exceed the Hermes client's 180s default (user 0 ran 290s before disconnect).
export E2E_PROMPT_TIMEOUT_SEC="${E2E_PROMPT_TIMEOUT_SEC:-300}"
exec "${SCRIPT_DIR}/client-hermes.sh" "$@"
