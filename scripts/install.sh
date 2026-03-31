#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Legacy installer compatibility wrapper.
# The supported installer entrypoint is the repository-root install.sh:
#   curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash

set -euo pipefail

ROOT_INSTALLER_URL="https://www.nvidia.com/nemoclaw.sh"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
ROOT_INSTALLER="${SCRIPT_DIR%/scripts}/install.sh"

warn_legacy_path() {
  cat >&2 <<EOF
[install] deprecated compatibility wrapper: scripts/install.sh
[install] supported installer: ${ROOT_INSTALLER_URL}
EOF
}

warn_legacy_path

if [[ ! -f "$ROOT_INSTALLER" ]]; then
  cat <<EOF >&2
[install] scripts/install.sh only works from a NemoClaw repository checkout.
[install] supported installer: ${ROOT_INSTALLER_URL}
EOF
  exit 1
fi

exec bash "$ROOT_INSTALLER" "$@"
