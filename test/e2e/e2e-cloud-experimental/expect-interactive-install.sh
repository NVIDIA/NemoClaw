#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Thin wrapper: real logic lives in test/e2e/test-e2e-cloud-experimental.sh (Phase 3 expect branch).
#
# Prereq: repo checkout at cwd or run from repo; NVIDIA_API_KEY for cloud onboard unless creds on disk.
#
# Usage (full suite; Phase 3 is interactive by default in test-e2e-cloud-experimental.sh — this wrapper is optional):
#   NVIDIA_API_KEY=nvapi-... bash test/e2e/e2e-cloud-experimental/expect-interactive-install.sh
#
# Offline expect-only smoke:
#   DEMO_FAKE_ONLY=1 bash test/e2e/e2e-cloud-experimental/expect-interactive-install.sh
#
# Optional env: INTERACTIVE_SANDBOX_NAME (default: e2e-expect-demo), INTERACTIVE_* sends,
#   NEMOCLAW_INSTALL_SCRIPT_URL, NEMOCLAW_CLOUD_EXPERIMENTAL_MODEL, etc. — see test-e2e-cloud-experimental.sh header.

set -euo pipefail

_root="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$_root"

if [[ "${DEMO_FAKE_ONLY:-0}" == "1" ]]; then
  exec bash test/e2e/test-e2e-cloud-experimental.sh
fi

export RUN_E2E_CLOUD_EXPERIMENTAL_INTERACTIVE_INSTALL=1 # redundant with script default; keeps intent explicit
exec bash test/e2e/test-e2e-cloud-experimental.sh
