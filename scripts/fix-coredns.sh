#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Compatibility wrapper for the TypeScript CoreDNS patcher.
#
# Usage: ./scripts/fix-coredns.sh [gateway-name]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLI_JS="${NEMOCLAW_CLI_JS:-$REPO_ROOT/dist/nemoclaw.js}"

if [ -f "$CLI_JS" ]; then
  exec node "$CLI_JS" internal dns fix-coredns "$@"
fi

exec nemoclaw internal dns fix-coredns "$@"
