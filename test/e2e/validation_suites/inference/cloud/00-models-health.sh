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
e2e_context_require E2E_SANDBOX_NAME

if e2e_env_is_dry_run; then
  echo "[dry-run] would GET inference.local/v1/models from inside the sandbox"
  exit 0
fi

name="$(e2e_context_get E2E_SANDBOX_NAME)"
body="$(openshell sandbox exec --name "${name}" -- curl -fsS --max-time 30 "https://inference.local/v1/models")"
if [[ -z "${body}" ]]; then
  echo "inference:models-health: no response from models endpoint" >&2
  exit 1
fi
printf '%s\n' "${body:0:512}"
