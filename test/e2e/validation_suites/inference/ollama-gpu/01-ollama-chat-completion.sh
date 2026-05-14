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
e2e_context_require E2E_GATEWAY_URL
if e2e_env_is_dry_run; then
  echo "[dry-run] would POST chat completion via ollama-compatible route"
  exit 0
fi
url="$(e2e_context_get E2E_GATEWAY_URL)"
payload='{"model":"default","messages":[{"role":"user","content":"say ok"}],"max_tokens":8}'
# CodeRabbit review item #15: capture then truncate; `curl | head` is brittle
# under `pipefail` and can fail successful requests.
body="$(curl -fsS --max-time 30 -H 'Content-Type: application/json' \
  -d "${payload}" "${url%/}/v1/chat/completions")"
printf '%s\n' "${body:0:1024}"
