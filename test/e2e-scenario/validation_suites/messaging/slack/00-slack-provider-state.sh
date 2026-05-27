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
if [[ "$(e2e_context_get E2E_AGENT)" == "openclaw" ]]; then
  if [[ -n "${E2E_DRY_RUN:-}" ]]; then
    e2e_pass "expected-state.messaging.slack.openclaw-enabled dry-run"
  else
    content="$(e2e_messaging_read_config_surface)"
    if ! printf '%s\n' "${content}" | python3 -c 'import json, sys; cfg=json.load(sys.stdin); assert cfg["channels"]["slack"]["enabled"] is True; assert cfg["plugins"]["entries"]["slack"]["enabled"] is True'; then
      e2e_fail "expected-state.messaging.slack.openclaw-enabled missing channels.slack.enabled or plugins.entries.slack.enabled"
    fi
    e2e_pass "expected-state.messaging.slack.openclaw-enabled channel and plugin enabled"
  fi
fi
e2e_pass "expected-state.messaging.slack.provider-state ${provider} provider state configured"
