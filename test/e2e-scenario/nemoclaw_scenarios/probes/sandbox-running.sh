#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Probe: sandbox-running
#
# Asserts the sandbox declared by E2E_SANDBOX_NAME (seeded by
# onboarding) is present in `nemoclaw list`. Mirrors the legacy
# validation_suites/assert/sandbox-alive.sh::e2e_sandbox_assert_running
# contract; promoted to a typed phase action so runtime suites cannot
# silently run against an absent sandbox.

set -euo pipefail

_THIS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SANDBOX_HELPER="$(cd "${_THIS_DIR}/../../validation_suites/assert" && pwd)/sandbox-alive.sh"

if [[ ! -f "${SANDBOX_HELPER}" ]]; then
  echo "probe sandbox-running: legacy helper not found: ${SANDBOX_HELPER}" >&2
  exit 1
fi

# shellcheck source=/dev/null
. "${SANDBOX_HELPER}"

if ! e2e_sandbox_assert_running; then
  exit 1
fi

echo "probe sandbox-running: ok"
exit 0
