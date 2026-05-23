#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/lib/messaging_providers.sh"
e2e_messaging_load_context
provider="$(e2e_messaging_provider_name)"
case "${provider}" in
  slack-bot | slack-app) ;;
  *) e2e_fail "expected-state.messaging.slack.provider-state expected slack provider, got ${provider}" ;;
esac
e2e_messaging_assert_provider_attached
e2e_pass "expected-state.messaging.slack.provider-state ${provider} provider state configured"
