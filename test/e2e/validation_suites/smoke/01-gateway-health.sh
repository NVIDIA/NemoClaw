#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# smoke step: gateway-health

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(cd "${SCRIPT_DIR}/../../runtime/lib" && pwd)"
# shellcheck source=../../runtime/lib/env.sh
. "${LIB_DIR}/env.sh"
# shellcheck source=../../runtime/lib/context.sh
. "${LIB_DIR}/context.sh"
ASSERT_DIR="$(cd "${SCRIPT_DIR}/../assert" && pwd)"
# shellcheck source=../assert/gateway-alive.sh
. "${ASSERT_DIR}/gateway-alive.sh"

echo "smoke:gateway-health"
e2e_context_require E2E_GATEWAY_URL
e2e_gateway_assert_healthy
