#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# platform-wsl step: wsl-smoke. Mirrors platform-macos; WSL-specific probes
# land as wsl-e2e coverage migrates.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(cd "${SCRIPT_DIR}/../../../runtime/lib" && pwd)"
# shellcheck source=../../../runtime/lib/env.sh
. "${LIB_DIR}/env.sh"
# shellcheck source=../../../runtime/lib/context.sh
. "${LIB_DIR}/context.sh"

echo "platform-wsl:wsl-smoke"
e2e_context_require E2E_PLATFORM_OS E2E_SANDBOX_NAME

if e2e_env_is_dry_run; then
  echo "[dry-run] would run WSL-specific smoke checks"
  exit 0
fi

os="$(e2e_context_get E2E_PLATFORM_OS)"
if [[ "${os}" != "wsl" ]]; then
  echo "platform-wsl: E2E_PLATFORM_OS should be 'wsl', got '${os}'" >&2
  exit 1
fi
