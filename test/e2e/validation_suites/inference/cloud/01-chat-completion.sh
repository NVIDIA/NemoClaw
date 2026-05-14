#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# inference step: chat-completion

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(cd "${SCRIPT_DIR}/../../../runtime/lib" && pwd)"
# shellcheck source=../../../runtime/lib/env.sh
. "${LIB_DIR}/env.sh"
# shellcheck source=../../../runtime/lib/context.sh
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
# CodeRabbit review item #12: substring expansion instead of `| head`
# avoids SIGPIPE-driven false failures under `set -o pipefail`.
printf '%s\n' "${response:0:1024}"
if [[ -z "${response}" ]]; then
  echo "inference:chat-completion: empty response" >&2
  exit 1
fi
