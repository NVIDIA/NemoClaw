#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Launch-readiness lease acceptance requires Linux and the util-linux PTY driver." >&2
  exit 2
fi

if [[ $# -ne 1 || -z "$1" ]]; then
  echo "Usage: scripts/test-launch-readiness-lease.sh <openclaw-sandbox>" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$repo_root"

npm run clean:cli
npm run build:cli
NEMOCLAW_RUN_LIVE_E2E=1 \
  NEMOCLAW_ACCEPTANCE_SANDBOX="$1" \
  npx vitest run --project e2e-live \
  test/e2e/live/launch-readiness-lease-acceptance.test.ts
