#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Probe: gateway-healthy
#
# Asserts the gateway is reachable and reports a healthy HTTP status
# at ${E2E_GATEWAY_URL}/health (with fallback to the base URL). Mirrors
# the legacy validation_suites/assert/gateway-alive.sh::e2e_gateway_assert_healthy
# contract, but is invoked as a typed phase action by the
# StateValidationOrchestrator BEFORE runtime suites run, so suite
# assertions never execute against a missing or wedged gateway.

set -euo pipefail

# Defer to the legacy bash helper for the actual probe logic so we keep
# a single implementation of the gateway-health contract during the
# transition. The legacy helper consults context.env for the URL.
_THIS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATEWAY_HELPER="$(cd "${_THIS_DIR}/../../validation_suites/assert" && pwd)/gateway-alive.sh"

if [[ ! -f "${GATEWAY_HELPER}" ]]; then
  echo "probe gateway-healthy: legacy helper not found: ${GATEWAY_HELPER}" >&2
  exit 1
fi

# shellcheck source=/dev/null
. "${GATEWAY_HELPER}"

if ! e2e_gateway_assert_healthy; then
  exit 1
fi

echo "probe gateway-healthy: ok"
exit 0
