#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Compatibility wrapper for the TypeScript sandbox DNS proxy setup.
#
# Usage: ./scripts/setup-dns-proxy.sh [gateway-name] <sandbox-name>

set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "Usage: $0 [gateway-name] <sandbox-name>"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLI_JS="${NEMOCLAW_CLI_JS:-$REPO_ROOT/dist/nemoclaw.js}"

if [ -f "$CLI_JS" ]; then
  exec node "$CLI_JS" internal dns setup-proxy "$@"
fi

exec nemoclaw internal dns setup-proxy "$@"
