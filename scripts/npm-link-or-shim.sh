#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Dev-install helper invoked by `npm install` via package.json `prepare`.
# The implementation lives in TypeScript behind an internal oclif command;
# this wrapper exists so existing prepare scripts and manual invocations keep
# working from source checkouts.

set -eu

if [ -n "${NEMOCLAW_INSTALLING:-}" ]; then
  exit 0
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
CLI_JS="${NEMOCLAW_CLI_JS:-$REPO_ROOT/dist/nemoclaw.js}"
NODE_BIN="${NEMOCLAW_NODE:-${NODE:-}}"

if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node 2>/dev/null || true)"
fi

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  printf '[nemoclaw] cannot expose CLI: node is not available\n' >&2
  exit 1
fi

if [ ! -f "$CLI_JS" ]; then
  printf '[nemoclaw] skipping dev shim: %s is missing. Run npm run build:cli and retry.\n' "$CLI_JS" >&2
  exit 0
fi

exec "$NODE_BIN" "$CLI_JS" internal dev npm-link-or-shim --repo-root "$REPO_ROOT"
