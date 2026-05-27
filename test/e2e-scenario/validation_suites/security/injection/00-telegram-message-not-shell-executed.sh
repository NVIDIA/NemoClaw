#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "${SCRIPT_DIR}/../../lib/security_policy_credentials.sh"
echo "injection:telegram-message-not-shell-executed"
payload="${E2E_TELEGRAM_PAYLOAD_FIXTURE:-$(spc_context_get E2E_TELEGRAM_PAYLOAD_FIXTURE)}"
spc_assert_telegram_payload_not_shell_executed "${payload}"
