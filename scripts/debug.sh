#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Compatibility wrapper for the TypeScript NemoClaw debug collector.
#
# Usage:
#   ./scripts/debug.sh [--quick] [--sandbox NAME] [--output PATH]
#   nemoclaw debug [--quick] [--sandbox NAME] [--output PATH]

set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]:-$0}"
case "$SCRIPT_PATH" in
  */*) SCRIPT_DIR="${SCRIPT_PATH%/*}" ;;
  *) SCRIPT_DIR="." ;;
esac
SCRIPT_DIR="$(cd "$SCRIPT_DIR" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
CLI_JS="${NEMOCLAW_CLI_JS:-$REPO_ROOT/dist/nemoclaw.js}"

if [ -f "$CLI_JS" ]; then
  NODE_BIN="${NEMOCLAW_NODE:-${NODE:-}}"
  if [ -z "$NODE_BIN" ]; then
    NODE_BIN="$(command -v node || true)"
  fi
  if [ -z "$NODE_BIN" ]; then
    echo "ERROR: node is required to run NemoClaw diagnostics." >&2
    exit 127
  fi
  exec "$NODE_BIN" "$CLI_JS" debug "$@"
fi

exec nemoclaw debug "$@"
