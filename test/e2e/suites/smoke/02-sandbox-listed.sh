#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# smoke step: sandbox-listed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(cd "${SCRIPT_DIR}/../../lib" && pwd)"
# shellcheck source=../../lib/env.sh
. "${LIB_DIR}/env.sh"
# shellcheck source=../../lib/context.sh
. "${LIB_DIR}/context.sh"
# shellcheck source=../../lib/sandbox.sh
. "${LIB_DIR}/sandbox.sh"

echo "smoke:sandbox-listed"
e2e_context_require E2E_SANDBOX_NAME
e2e_sandbox_assert_running
