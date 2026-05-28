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
    e2e_pass "expected-state.messaging.slack.runtime-discovery dry-run"
  else
    content="$(e2e_messaging_read_config_surface)"
    if ! printf '%s\n' "${content}" | python3 -c '
import json
import sys
cfg = json.load(sys.stdin)
assert cfg["channels"]["slack"]["enabled"] is True
assert cfg["plugins"]["entries"]["slack"]["enabled"] is True
'; then
      e2e_fail "expected-state.messaging.slack.openclaw-enabled missing channels.slack.enabled or plugins.entries.slack.enabled"
    fi
    e2e_pass "expected-state.messaging.slack.openclaw-enabled channel and plugin enabled"

    sandbox_name="$(e2e_context_get E2E_SANDBOX_NAME)"
    runtime_json="$(openshell sandbox exec --name "${sandbox_name}" -- timeout 45 openclaw channels list --all --json --no-color 2>/dev/null || true)"
    runtime_state="$(printf '%s\n' "${runtime_json}" | python3 -c '
import json
import sys
try:
    data = json.load(sys.stdin)
    slack = data.get("chat", {}).get("slack", {})
    accounts = slack.get("accounts", [])
    if slack.get("installed") is True and slack.get("origin") == "configured" and "default" in accounts:
        print("yes")
    else:
        print("no installed=%s origin=%s accounts=%s" % (slack.get("installed"), slack.get("origin"), accounts))
except Exception as exc:
    print("error %s" % exc)
' 2>/dev/null || true)"
    if [[ "${runtime_state}" != "yes" ]]; then
      e2e_fail "expected-state.messaging.slack.runtime-discovery OpenClaw did not report Slack installed/configured (${runtime_state}; output=${runtime_json:0:300})"
    fi
    e2e_pass "expected-state.messaging.slack.runtime-discovery OpenClaw reports Slack installed and configured"
  fi
fi
e2e_pass "expected-state.messaging.slack.provider-state ${provider} provider state configured"
