#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/lib/messaging_providers.sh"
e2e_messaging_load_context
if [[ -n "${E2E_DRY_RUN:-}" ]]; then
  provider="$(e2e_messaging_provider_name)"
  e2e_pass "expected-state.messaging.${provider}.bridge-reachable dry-run"
  exit 0
fi
e2e_messaging_assert_bridge_reachable
