#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Compatibility wrapper for the TypeScript NemoClaw uninstaller.
#
# Usage: ./uninstall.sh [--yes] [--keep-openshell] [--delete-models]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI_JS="${NEMOCLAW_CLI_JS:-$SCRIPT_DIR/dist/nemoclaw.js}"

if [ -f "$CLI_JS" ]; then
  NODE_BIN="${NEMOCLAW_NODE:-${NODE:-}}"
  if [ -z "$NODE_BIN" ]; then
    NODE_BIN="$(command -v node || true)"
  fi
  if [ -z "$NODE_BIN" ]; then
    echo "ERROR: node is required to run the NemoClaw uninstaller." >&2
    exit 127
  fi
  exec "$NODE_BIN" "$CLI_JS" internal uninstall run-plan "$@"
fi

exec nemoclaw internal uninstall run-plan "$@"
