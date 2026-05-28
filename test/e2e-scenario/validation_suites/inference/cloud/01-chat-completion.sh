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
e2e_context_require E2E_SANDBOX_NAME

if e2e_env_is_dry_run; then
  echo "[dry-run] would POST a chat completion to inference.local from inside the sandbox"
  exit 0
fi

name="$(e2e_context_get E2E_SANDBOX_NAME)"
payload='{"model":"nvidia/nemotron-3-super-120b-a12b","messages":[{"role":"user","content":"Reply with exactly one word: PONG"}],"max_tokens":100}'
response="$(openshell sandbox exec --name "${name}" -- curl -fsS --max-time 60 -H 'Content-Type: application/json' \
  -d "${payload}" "https://inference.local/v1/chat/completions")"
# CodeRabbit review item #12: substring expansion instead of `| head`
# avoids SIGPIPE-driven false failures under `set -o pipefail`.
printf '%s\n' "${response:0:1024}"
if [[ -z "${response}" ]]; then
  echo "inference:chat-completion: empty response" >&2
  exit 1
fi
