#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Render the E2E scenario coverage report as Markdown to stdout.
#
# Usage:
#   bash test/e2e/runtime/coverage-report.sh > coverage.md

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

TSX_BIN="${REPO_ROOT}/node_modules/.bin/tsx"
if [[ -x "${TSX_BIN}" ]]; then
  "${TSX_BIN}" "${SCRIPT_DIR}/resolver/index.ts" coverage
else
  # CodeRabbit review items #3, #10: fall back to --no-install so we rely on
  # the lockfile-pinned tsx rather than a network fetch, and fail closed
  # with a clear hint if tsx is not installed.
  if ! (cd "${REPO_ROOT}" && npx --no-install tsx "${SCRIPT_DIR}/resolver/index.ts" coverage); then
    echo "coverage-report: tsx not available. Run 'npm ci' at the repo root to install devDependencies." >&2
    exit 1
  fi
fi
