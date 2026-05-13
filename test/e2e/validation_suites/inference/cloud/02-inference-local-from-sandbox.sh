#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# inference step: sandbox-inference-local
# Verifies that the sandbox can reach the `inference-local` route.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(cd "${SCRIPT_DIR}/../../../runtime/lib" && pwd)"
# shellcheck source=../../../runtime/lib/env.sh
. "${LIB_DIR}/env.sh"
# shellcheck source=../../../runtime/lib/context.sh
. "${LIB_DIR}/context.sh"

echo "inference:sandbox-inference-local"
e2e_context_require E2E_SANDBOX_NAME E2E_INFERENCE_ROUTE

if e2e_env_is_dry_run; then
  echo "[dry-run] would resolve inference-local from inside the sandbox"
  exit 0
fi

name="$(e2e_context_get E2E_SANDBOX_NAME)"
route="$(e2e_context_get E2E_INFERENCE_ROUTE)"
# CodeRabbit review item #13: capture then truncate to avoid `| head` racing
# curl under `pipefail` and flagging a successful request as failed.
body="$(nemoclaw shell "${name}" -- curl -fsS --max-time 10 "http://${route}/v1/models")"
printf '%s\n' "${body:0:512}"
