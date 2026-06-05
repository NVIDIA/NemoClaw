#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# platform-macos step: macos-smoke
# Assert basic macOS-specific expectations. GitHub-hosted macOS does not
# provide a usable Docker daemon, so this step intentionally stays below
# sandbox/onboarding coverage and mirrors legacy macos-e2e skip semantics.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(cd "${SCRIPT_DIR}/../../../runtime/lib" && pwd)"
# shellcheck source=../../../runtime/lib/env.sh
. "${LIB_DIR}/env.sh"
# shellcheck source=../../../runtime/lib/context.sh
. "${LIB_DIR}/context.sh"

echo "platform-macos:macos-smoke"
e2e_context_require E2E_PLATFORM_OS

if e2e_env_is_dry_run; then
  echo "[dry-run] would run macOS-specific smoke checks"
  exit 0
fi

os="$(e2e_context_get E2E_PLATFORM_OS)"
if [[ "${os}" != "macos" ]]; then
  echo "platform-macos: E2E_PLATFORM_OS should be 'macos', got '${os}'" >&2
  exit 1
fi
