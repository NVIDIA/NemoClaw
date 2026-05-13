#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# inference step: models-health
# Checks that the gateway advertises at least one model via /models.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(cd "${SCRIPT_DIR}/../../../runtime/lib" && pwd)"
# shellcheck source=../../../runtime/lib/env.sh
. "${LIB_DIR}/env.sh"
# shellcheck source=../../../runtime/lib/context.sh
. "${LIB_DIR}/context.sh"

echo "inference:models-health"
e2e_context_require E2E_GATEWAY_URL

if e2e_env_is_dry_run; then
  echo "[dry-run] would GET \${E2E_GATEWAY_URL}/models"
  exit 0
fi

url="$(e2e_context_get E2E_GATEWAY_URL)"
body="$(curl -fsS --max-time 10 "${url%/}/v1/models" 2>/dev/null || curl -fsS --max-time 10 "${url%/}/models")"
if [[ -z "${body}" ]]; then
  echo "inference:models-health: no response from models endpoint" >&2
  exit 1
fi
echo "${body}" | head -c 512
echo
