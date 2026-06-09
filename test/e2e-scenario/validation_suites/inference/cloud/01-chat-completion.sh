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
# shellcheck source=../../sandbox-exec.sh
. "${SCRIPT_DIR}/../../sandbox-exec.sh"

echo "inference:chat-completion"
e2e_context_require E2E_SANDBOX_NAME

name="$(e2e_context_get E2E_SANDBOX_NAME)"
payload='{"model":"nvidia/nemotron-3-ultra-550b-a55b","messages":[{"role":"user","content":"Reply with exactly one word: PONG"}],"max_tokens":100}'
# Orchestrator step cap is 60s; widen the wrapper cap to 50s so a hung
# upstream surfaces with a clear diagnostic before SIGTERM. Inner curl
# --max-time stays ~10s under the wrapper cap.
# shellcheck disable=SC2034 # consumed by e2e_sandbox_exec via env
E2E_SANDBOX_EXEC_TIMEOUT_SECONDS=50 \
  response="$(e2e_sandbox_exec "${name}" -- curl -fsS --max-time 40 -H 'Content-Type: application/json' \
    -d "${payload}" "https://inference.local/v1/chat/completions")"
# CodeRabbit review item #12: substring expansion instead of `| head`
# avoids SIGPIPE-driven false failures under `set -o pipefail`.
printf '%s\n' "${response:0:1024}"
if [[ -z "${response}" ]]; then
  echo "inference:chat-completion: empty response" >&2
  exit 1
fi
