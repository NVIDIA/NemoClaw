#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Render the E2E scenario coverage report as Markdown to stdout.
#
# Usage:
#   bash test/e2e/coverage-report.sh > coverage.md

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

TSX_BIN="${REPO_ROOT}/node_modules/.bin/tsx"
if [[ -x "${TSX_BIN}" ]]; then
  "${TSX_BIN}" "${SCRIPT_DIR}/resolver/index.ts" coverage
else
  (cd "${REPO_ROOT}" && npx --yes tsx "${SCRIPT_DIR}/resolver/index.ts" coverage)
fi
