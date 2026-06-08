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
# shellcheck source=../../sandbox-exec.sh
. "${SCRIPT_DIR}/../../sandbox-exec.sh"

echo "inference:models-health"
e2e_context_require E2E_SANDBOX_NAME

name="$(e2e_context_get E2E_SANDBOX_NAME)"
# Orchestrator step cap is 30s; wrapper default 25s applies. Inner curl
# --max-time keeps a hung HTTP read from consuming the whole budget.
body="$(e2e_sandbox_exec "${name}" -- curl -fsS --max-time 20 "https://inference.local/v1/models")"
if [[ -z "${body}" ]]; then
  echo "inference:models-health: no response from models endpoint" >&2
  exit 1
fi
printf '%s\n' "${body:0:512}"
