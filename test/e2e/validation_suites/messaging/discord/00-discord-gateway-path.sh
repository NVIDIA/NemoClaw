#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/lib/messaging_providers.sh"
e2e_messaging_load_context
provider="$(e2e_messaging_provider_name)"
if [[ "${provider}" != "discord" ]]; then
  e2e_fail "expected-state.messaging.discord.gateway-path expected discord provider, got ${provider}"
fi
e2e_messaging_assert_gateway_path "discord"
