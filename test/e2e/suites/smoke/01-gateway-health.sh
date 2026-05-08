#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# smoke step: gateway-health

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(cd "${SCRIPT_DIR}/../../lib" && pwd)"
# shellcheck source=../../lib/env.sh
. "${LIB_DIR}/env.sh"
# shellcheck source=../../lib/context.sh
. "${LIB_DIR}/context.sh"
# shellcheck source=../../lib/gateway.sh
. "${LIB_DIR}/gateway.sh"

echo "smoke:gateway-health"
e2e_context_require E2E_GATEWAY_URL
e2e_gateway_assert_healthy
