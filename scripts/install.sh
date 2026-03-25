#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Legacy installer compatibility wrapper.
# The supported installer entrypoint is the repository-root install.sh:
#   curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash

set -euo pipefail

ROOT_INSTALLER_URL="https://www.nvidia.com/nemoclaw.sh"

warn_legacy_path() {
  echo "[install] scripts/install.sh is a deprecated compatibility wrapper." >&2
  echo "[install] Use the supported installer instead:" >&2
  echo "[install]   curl -fsSL ${ROOT_INSTALLER_URL} | bash" >&2
}

SCRIPT_PATH="${BASH_SOURCE[0]-}"
SCRIPT_DIR=""
if [[ -n "$SCRIPT_PATH" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
fi

ROOT_INSTALLER=""
if [[ -n "$SCRIPT_DIR" ]]; then
  ROOT_INSTALLER="${SCRIPT_DIR}/../install.sh"
fi

if [[ -n "$ROOT_INSTALLER" && -f "$ROOT_INSTALLER" ]]; then
  warn_legacy_path
  exec bash "$ROOT_INSTALLER" "$@"
fi

warn_legacy_path
echo "[install] This wrapper only works from a NemoClaw repository checkout." >&2
exit 1
