#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# local-ollama-inference step: ollama-models-health

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(cd "${SCRIPT_DIR}/../../../runtime/lib" && pwd)"
# shellcheck source=../../../runtime/lib/env.sh
. "${LIB_DIR}/env.sh"
# shellcheck source=../../../runtime/lib/context.sh
. "${LIB_DIR}/context.sh"

echo "local-ollama-inference:ollama-models-health"
e2e_context_require E2E_GATEWAY_URL
if e2e_env_is_dry_run; then
  echo "[dry-run] would GET ollama /api/tags via gateway"
  exit 0
fi
url="$(e2e_context_get E2E_GATEWAY_URL)"
# CodeRabbit review item #14: capture then truncate; avoids `| head` causing
# curl to receive SIGPIPE mid-response under `pipefail`.
body="$(curl -fsS --max-time 10 "${url%/}/api/tags")"
printf '%s\n' "${body:0:512}"
