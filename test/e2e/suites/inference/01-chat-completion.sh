#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# inference step: chat-completion

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(cd "${SCRIPT_DIR}/../../lib" && pwd)"
# shellcheck source=../../lib/env.sh
. "${LIB_DIR}/env.sh"
# shellcheck source=../../lib/context.sh
. "${LIB_DIR}/context.sh"

echo "inference:chat-completion"
e2e_context_require E2E_GATEWAY_URL

if e2e_env_is_dry_run; then
  echo "[dry-run] would POST a chat completion to \${E2E_GATEWAY_URL}/v1/chat/completions"
  exit 0
fi

url="$(e2e_context_get E2E_GATEWAY_URL)"
payload='{"model":"default","messages":[{"role":"user","content":"say ok"}],"max_tokens":8}'
response="$(curl -fsS --max-time 30 -H 'Content-Type: application/json' \
  -d "${payload}" "${url%/}/v1/chat/completions")"
echo "${response}" | head -c 1024
echo
if [[ -z "${response}" ]]; then
  echo "inference:chat-completion: empty response" >&2
  exit 1
fi
