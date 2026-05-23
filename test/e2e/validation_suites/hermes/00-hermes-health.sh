#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# hermes-specific step: hermes-health
# Placeholder: real assertions migrate with the existing Hermes E2E scripts.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(cd "${SCRIPT_DIR}/../../runtime/lib" && pwd)"
# shellcheck source=../../runtime/lib/env.sh
. "${LIB_DIR}/env.sh"
# shellcheck source=../../runtime/lib/context.sh
. "${LIB_DIR}/context.sh"

echo "hermes-specific:hermes-health"
e2e_context_require E2E_AGENT
if e2e_env_is_dry_run; then
  echo "[dry-run] would run Hermes health checks"
  exit 0
fi
agent="$(e2e_context_get E2E_AGENT)"
if [[ "${agent}" != "hermes" ]]; then
  echo "hermes-specific: E2E_AGENT should be 'hermes', got '${agent}'" >&2
  exit 1
fi
