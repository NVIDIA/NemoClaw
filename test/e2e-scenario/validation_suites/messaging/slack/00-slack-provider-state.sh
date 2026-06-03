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
agent="$(e2e_context_get E2E_AGENT)"
if [[ "${agent}" == "openclaw" ]]; then
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
if [[ "${agent}" == "hermes" ]]; then
  if [[ -n "${E2E_DRY_RUN:-}" ]]; then
    e2e_pass "expected-state.messaging.slack.hermes-platforms-enabled dry-run"
    e2e_pass "expected-state.messaging.slack.hermes-gateway-running dry-run"
  else
    sandbox_name="$(e2e_context_get E2E_SANDBOX_NAME)"
    config_yaml="$(openshell sandbox exec --name "${sandbox_name}" -- cat /sandbox/.hermes/config.yaml 2>/dev/null || true)"
    if [[ -z "${config_yaml}" ]]; then
      e2e_fail "expected-state.messaging.slack.hermes-platforms-enabled could not read /sandbox/.hermes/config.yaml"
    fi
    platforms_state="$(printf '%s\n' "${config_yaml}" | python3 -c '
import sys
try:
    import yaml
except ImportError:
    print("yaml-missing")
    sys.exit(0)
try:
    cfg = yaml.safe_load(sys.stdin) or {}
    platforms = cfg.get("platforms") or {}
    slack = platforms.get("slack") or {}
    if isinstance(slack, dict) and slack.get("enabled") is True:
        print("yes")
    else:
        print("no slack=%r" % (slack,))
except Exception as exc:
    print("error %s" % exc)
' 2>/dev/null || true)"
    case "${platforms_state}" in
      yes)
        e2e_pass "expected-state.messaging.slack.hermes-platforms-enabled platforms.slack.enabled true in config.yaml"
        ;;
      yaml-missing)
        if printf '%s\n' "${config_yaml}" | grep -E '^[[:space:]]*slack:[[:space:]]*$' -A2 | grep -qE '^[[:space:]]*enabled:[[:space:]]*true[[:space:]]*$'; then
          e2e_pass "expected-state.messaging.slack.hermes-platforms-enabled platforms.slack.enabled true (grep fallback; yaml module absent)"
        else
          e2e_fail "expected-state.messaging.slack.hermes-platforms-enabled platforms.slack.enabled missing (grep fallback; yaml module absent)"
        fi
        ;;
      *)
        e2e_fail "expected-state.messaging.slack.hermes-platforms-enabled platforms.slack.enabled not true (${platforms_state})"
        ;;
    esac

    gateway_log="$(openshell sandbox exec --name "${sandbox_name}" -- sh -c 'tail -n 200 /sandbox/.hermes/logs/gateway.log 2>/dev/null || true' 2>/dev/null || true)"
    if [[ -z "${gateway_log}" ]]; then
      e2e_fail "expected-state.messaging.slack.hermes-gateway-running could not read /sandbox/.hermes/logs/gateway.log"
    fi
    if printf '%s\n' "${gateway_log}" | grep -qE 'Gateway running with [^1] platform\(s\)|Connecting to slack|\[Slack\] Socket Mode connected'; then
      e2e_pass "expected-state.messaging.slack.hermes-gateway-running gateway booted slack platform"
    else
      e2e_fail "expected-state.messaging.slack.hermes-gateway-running gateway log shows slack platform never started (tail: ${gateway_log: -300})"
    fi
  fi
fi
e2e_pass "expected-state.messaging.slack.provider-state ${provider} provider state configured"
