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
nemoclaw shell "${name}" -- curl -fsS --max-time 10 "http://inference-local/api/tags" >/dev/null
