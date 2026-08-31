#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

: "\${GITHUB_WORKSPACE:?GITHUB_WORKSPACE must name the source checkout}"
cd -- "$GITHUB_WORKSPACE"

test -f package-lock.json
test -f nemoclaw/package-lock.json

npm run clean:cli
npm --prefix nemoclaw run clean
npm --prefix nemoclaw run build
npm run build:cli
npx tsx scripts/check-dist-sourcemaps.mts dist

test -s dist/nemoclaw.js
test -s nemoclaw/dist/index.js
test -s nemoclaw/dist/shared/sandbox-name.cjs
