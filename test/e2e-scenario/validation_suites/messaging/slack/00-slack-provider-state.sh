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
  # This scenario asserts the static enablement contract Hermes' gateway uses
  # to start its Slack adapter:
  #   1) config.yaml carries platforms.slack.enabled=true so the gateway
  #      instantiates the Slack platform at boot. Without it, Hermes runs only
  #      api_server and slack_bolt never starts.
  #   2) gateway.log shows the Slack adapter completed Socket Mode connection
  #      and the Bolt app reached the running state.
  #   3) SLACK_ALLOWED_CHANNELS, when configured, is present in .env so the
  #      allowlist values reach the adapter's environment.
  if [[ -n "${E2E_DRY_RUN:-}" ]]; then
    e2e_pass "expected-state.messaging.slack.hermes-platforms-enabled dry-run"
    e2e_pass "expected-state.messaging.slack.hermes-allowed-channels-scoped dry-run"
    e2e_pass "expected-state.messaging.slack.hermes-gateway-running dry-run"
  else
    sandbox_name="$(e2e_context_get E2E_SANDBOX_NAME)"
    # The Hermes venv is the same Python that loads config.yaml at runtime, so
    # PyYAML is guaranteed there even when the host runner ships a minimal
    # python3. Parsing inside the sandbox removes the awk fallback path.
    platforms_state="$(openshell sandbox exec --name "${sandbox_name}" -- /opt/hermes/.venv/bin/python -c '
import sys
import yaml

try:
    with open("/sandbox/.hermes/config.yaml", "r", encoding="utf-8") as fh:
        cfg = yaml.safe_load(fh) or {}
except FileNotFoundError:
    print("missing-config")
    sys.exit(0)
except Exception as exc:
    print("error %s" % exc)
    sys.exit(0)
platforms = cfg.get("platforms") or {}
slack = platforms.get("slack") or {}
if isinstance(slack, dict) and slack.get("enabled") is True:
    print("yes")
else:
    print("no slack=%r" % (slack,))
' 2>/dev/null || true)"
    case "${platforms_state}" in
      yes)
        e2e_pass "expected-state.messaging.slack.hermes-platforms-enabled platforms.slack.enabled true in config.yaml"
        ;;
      missing-config)
        e2e_fail "expected-state.messaging.slack.hermes-platforms-enabled /sandbox/.hermes/config.yaml not found"
        ;;
      *)
        e2e_fail "expected-state.messaging.slack.hermes-platforms-enabled platforms.slack.enabled not true (${platforms_state})"
        ;;
    esac

    env_state="$(openshell sandbox exec --name "${sandbox_name}" -- sh -c 'grep -E "^SLACK_ALLOWED_CHANNELS=" /sandbox/.hermes/.env 2>/dev/null | head -n1' 2>/dev/null || true)"
    case "${env_state}" in
      SLACK_ALLOWED_CHANNELS=*[!\ ]*)
        e2e_pass "expected-state.messaging.slack.hermes-allowed-channels-scoped allowlist present in .env"
        ;;
      "")
        e2e_pass "expected-state.messaging.slack.hermes-allowed-channels-scoped no channel allowlist requested (open scope)"
        ;;
      *)
        e2e_fail "expected-state.messaging.slack.hermes-allowed-channels-scoped malformed SLACK_ALLOWED_CHANNELS entry"
        ;;
    esac

    # Hermes ships two surfaces that carry the gateway boot trace:
    #   - /sandbox/.hermes/logs/gateway.log: Hermes' own structured logger.
    #   - <tmpdir>/gateway.log: stdout captured by agents/hermes/start.sh:862,910
    #     when `hermes gateway run` is supervised by the entrypoint.
    # Tail both; either is acceptable evidence the Slack platform booted.
    tmp_dir=/tmp
    gateway_log_basename=gateway.log
    gateway_log=""
    for log_path in "/sandbox/.hermes/logs/${gateway_log_basename}" "${tmp_dir}/${gateway_log_basename}"; do
      chunk="$(openshell sandbox exec --name "${sandbox_name}" -- sh -c "tail -n 200 ${log_path} 2>/dev/null || true" 2>/dev/null || true)"
      if [[ -n "${chunk}" ]]; then
        if [[ -n "${gateway_log}" ]]; then
          gateway_log="${gateway_log}"$'\n'"${chunk}"
        else
          gateway_log="${chunk}"
        fi
      fi
    done
    if [[ -z "${gateway_log}" ]]; then
      e2e_fail "expected-state.messaging.slack.hermes-gateway-running could not read gateway log from sandbox or entrypoint surface"
    fi
    if printf '%s\n' "${gateway_log}" | grep -qE '\[Slack\] Socket Mode connected|✓ slack connected|slack_bolt\.AsyncApp.*Bolt app is running'; then
      e2e_pass "expected-state.messaging.slack.hermes-gateway-running gateway booted slack platform"
    else
      sanitized_tail="$(printf '%s\n' "${gateway_log}" | tail -n 20 | sed -E \
        -e 's/xox[bpaors]-[A-Za-z0-9-]+/<redacted-slack-token>/g' \
        -e 's/xapp-[A-Za-z0-9-]+/<redacted-slack-app-token>/g' \
        -e 's/[Tt][0-9A-Z]{8,}/<redacted-team-id>/g' \
        -e 's/[UCWBDG][0-9A-Z]{8,}/<redacted-slack-id>/g')"
      e2e_fail "expected-state.messaging.slack.hermes-gateway-running gateway log shows slack platform never started (sanitized tail: ${sanitized_tail})"
    fi
  fi
fi
e2e_pass "expected-state.messaging.slack.provider-state ${provider} provider state configured"
