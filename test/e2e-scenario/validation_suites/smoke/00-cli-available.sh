#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# smoke step: cli-available
# Verifies that the `nemoclaw` CLI is on PATH.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(cd "${SCRIPT_DIR}/../../runtime/lib" && pwd)"
# shellcheck source=../../runtime/lib/env.sh
. "${LIB_DIR}/env.sh"
# shellcheck source=../../runtime/lib/context.sh
. "${LIB_DIR}/context.sh"

echo "smoke:cli-available"

e2e_context_require E2E_SCENARIO

if e2e_env_is_dry_run; then
  echo "[dry-run] would check that nemoclaw CLI is on PATH"
  exit 0
fi

if ! command -v nemoclaw >/dev/null 2>&1; then
  echo "smoke:cli-available: nemoclaw CLI not on PATH" >&2
  exit 1
fi

nemoclaw --version
