#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# ollama-proxy step: proxy-reachable

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(cd "${SCRIPT_DIR}/../../../runtime/lib" && pwd)"
# shellcheck source=../../../runtime/lib/env.sh
. "${LIB_DIR}/env.sh"
# shellcheck source=../../../runtime/lib/context.sh
. "${LIB_DIR}/context.sh"

echo "ollama-proxy:proxy-reachable"
e2e_context_require E2E_SANDBOX_NAME
if e2e_env_is_dry_run; then
  echo "[dry-run] would verify the Ollama auth proxy is reachable from the sandbox"
  exit 0
fi
name="$(e2e_context_get E2E_SANDBOX_NAME)"
# The Ollama auth proxy intentionally rejects unauthenticated requests to
# /api/tags (legacy test-gpu-e2e.sh accepts 401/403 as proof the proxy is
# live and enforcing auth). Do not use curl -f here.
status="$(openshell sandbox exec --name "${name}" -- curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "http://inference-local/api/tags" 2>/dev/null || echo 000)"
case "${status}" in
  200 | 401 | 403)
    echo "ollama-proxy:proxy-reachable status=${status}"
    ;;
  *)
    echo "ollama-proxy: expected HTTP 200/401/403 from proxy, got ${status}" >&2
    exit 1
    ;;
esac
