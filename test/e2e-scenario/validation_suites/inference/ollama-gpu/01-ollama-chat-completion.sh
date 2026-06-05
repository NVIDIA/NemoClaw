#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# local-ollama-inference step: ollama-chat-completion

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(cd "${SCRIPT_DIR}/../../../runtime/lib" && pwd)"
# shellcheck source=../../../runtime/lib/env.sh
. "${LIB_DIR}/env.sh"
# shellcheck source=../../../runtime/lib/context.sh
. "${LIB_DIR}/context.sh"

echo "local-ollama-inference:ollama-chat-completion"
e2e_context_require E2E_SANDBOX_NAME
if e2e_env_is_dry_run; then
  echo "[dry-run] would POST chat completion from sandbox to host-network Ollama"
  exit 0
fi
name="$(e2e_context_get E2E_SANDBOX_NAME)"
model="$(curl -fsS --max-time 10 http://127.0.0.1:11434/api/tags \
  | node -e "const fs=require('fs'); const data=JSON.parse(fs.readFileSync(0,'utf8')); process.stdout.write(data.models?.[0]?.name || data.models?.[0]?.model || 'default');")"
payload="$(node -e "process.stdout.write(JSON.stringify({model: process.argv[1], messages: [{role: 'user', content: 'say ok'}], max_tokens: 8}))" "${model}")"
container_id="$(docker ps --quiet \
  --filter "label=openshell.ai/managed-by=openshell" \
  --filter "label=openshell.ai/sandbox-name=${name}" \
  | head -n 1)"
if [[ -z "${container_id}" ]]; then
  echo "local-ollama-inference: OpenShell-managed Docker container not found for ${name}" >&2
  exit 1
fi
# Docker GPU host networking gives the sandbox a direct loopback path to
# Ollama; use docker exec like legacy test-gpu-e2e.sh instead of the normal
# OpenShell dashboard/gateway forward path.
body="$(docker exec "${container_id}" sh -lc "curl -fsS --max-time 30 -H 'Content-Type: application/json' -d '$payload' http://127.0.0.1:11434/v1/chat/completions")"
printf '%s\n' "${body:0:1024}"
