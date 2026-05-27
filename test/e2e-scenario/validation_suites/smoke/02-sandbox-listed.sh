#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# smoke step: sandbox-listed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(cd "${SCRIPT_DIR}/../../runtime/lib" && pwd)"
# shellcheck source=../../runtime/lib/env.sh
. "${LIB_DIR}/env.sh"
# shellcheck source=../../runtime/lib/context.sh
. "${LIB_DIR}/context.sh"
ASSERT_DIR="$(cd "${SCRIPT_DIR}/../assert" && pwd)"
# shellcheck source=../assert/sandbox-alive.sh
. "${ASSERT_DIR}/sandbox-alive.sh"

echo "smoke:sandbox-listed"
e2e_context_require E2E_SANDBOX_NAME
e2e_sandbox_assert_running
