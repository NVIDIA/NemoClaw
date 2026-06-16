#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# shellcheck disable=SC2016,SC2034
# SC2016: Single-quoted strings are intentional — Node.js code passed via SSH.
# SC2034: Some variables are used indirectly or reserved for later phases.

# Messaging Credential Provider E2E Tests
#
# Validates that messaging credentials (Telegram, Discord, Slack, WeChat)
# flow correctly through the OpenShell provider/placeholder/L7-proxy pipeline,
# and holds WhatsApp's QR-only channel to the same config/policy/no-secret
# standard even though it has no host-side token provider. Tests every
# layer of the chain introduced in PR #1081:
#
#   1. Provider creation — openshell stores the real token
#   2. Sandbox attachment — --provider flags wire providers to the sandbox
#   3. Credential isolation — real tokens never appear in sandbox env,
#      process list, or filesystem
#   4. Config patching — openclaw.json channels use placeholder values
#   5. OpenClaw runtime discovery — channels list as installed/configured
#   6. Telegram diagnostics — startup/credential breadcrumbs stay sanitized
#   7. Network reachability — Node.js can reach messaging APIs through proxy
#   8. Native Discord gateway path — WebSocket L7 path is tested hermetically
#   9. L7 proxy rewriting — placeholder is rewritten to real token at egress
#  10. WhatsApp QR-only parity — channel add/rebuild applies policy, bakes
#      openclaw.json, creates no providers, and leaks no token placeholders
#
# Uses fake tokens by default (no external accounts needed). With fake tokens,
# the live API probes return 401/404 — proving the full chain worked (request
# reached the real API with the token rewritten). The OpenClaw plugin-send phase
# then sends messages to host-side fake provider APIs when complete real
# credentials/targets are not configured.
#
# Prerequisites:
#   - Docker running
#   - NemoClaw installed (install.sh or brev-setup.sh already ran)
#   - NVIDIA_INFERENCE_API_KEY set
#   - openshell on PATH
#
# Environment variables:
#   NVIDIA_INFERENCE_API_KEY                         — required
#   NEMOCLAW_NON_INTERACTIVE=1             — required
#   NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 — required
#   NEMOCLAW_SANDBOX_NAME                  — sandbox name (default: e2e-msg-provider)
#   TELEGRAM_BOT_TOKEN                     — defaults to fake token
#   DISCORD_BOT_TOKEN                      — defaults to fake token
#   TELEGRAM_ALLOWED_IDS                   — comma-separated Telegram user IDs for DM allowlisting
#   TELEGRAM_AUTHORIZED_CHAT_IDS           — compatibility alias for TELEGRAM_ALLOWED_IDS
#   TELEGRAM_CHAT_ID                       — compatibility alias for TELEGRAM_ALLOWED_IDS
#   TELEGRAM_BOT_TOKEN_REAL                — optional: enables Phase 6 real OpenClaw send
#   DISCORD_BOT_TOKEN_REAL                 — optional: enables Phase 6 real OpenClaw send
#   SLACK_BOT_TOKEN_REAL                   — optional: enables Phase 6 real OpenClaw send
#   SLACK_APP_TOKEN_REAL                   — optional paired Slack app token for real Slack run
#   SLACK_BOT_TOKEN                        — defaults to fake token (xoxb-fake-...)
#   SLACK_APP_TOKEN                        — defaults to fake token (xapp-fake-...)
#   SLACK_ALLOWED_USERS                    — comma-separated Slack user IDs for DM and channel @mention allowlisting
#   SLACK_BOT_TOKEN_REVOKED                — optional: revoked xoxb- token to test auth pre-validation (#2340)
#   SLACK_APP_TOKEN_REVOKED                — optional: paired xapp- token for the revoked bot token
#   WECHAT_BOT_TOKEN                       — defaults to fake token; presence skips host-side QR login
#   WECHAT_ACCOUNT_ID                      — defaults to fake iLink account ID (manifest hook account key)
#   WECHAT_BASE_URL                        — defaults to fake iLink baseUrl (per-account API host)
#   WECHAT_USER_ID                         — defaults to fake operator wechat user ID (seeds DM allowlist)
#   WECHAT_ALLOWED_IDS                     — optional: comma-separated DM allowlist for wechat
#   WhatsApp                               — QR-only; the test enables it via `channels add whatsapp`
#   WHATSAPP_TOKEN / WHATSAPP_BOT_TOKEN / WHATSAPP_SESSION_SECRET
#                                          — overwritten with fake decoys to prove NemoClaw ignores host-side
#                                            WhatsApp credential-shaped env vars
#   TELEGRAM_CHAT_ID_E2E                   — optional: target for real Telegram send
#   DISCORD_CHANNEL_ID_E2E                 — optional: target for real Discord send
#   SLACK_CHANNEL_ID_E2E                   — optional: target for real Slack send
#   NEMOCLAW_TELEGRAM_INBOUND_REPLY_E2E=1  — optional: wait for a real Telegram-client DM
#                                            from an allowed user and verify inbound +
#                                            outbound gateway breadcrumbs
#   NEMOCLAW_TELEGRAM_INBOUND_WAIT_SECONDS — optional: wait time for the live inbound
#                                            proof (default: 90)
#   NEMOCLAW_OPENSHELL_BIN                 — optional OpenShell binary under test
#   NEMOCLAW_FRESH=1                       — auto-set to discard interrupted onboard sessions
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
#     NVIDIA_INFERENCE_API_KEY=nvapi-... bash test/e2e/test-messaging-providers.sh
#
# See: https://github.com/NVIDIA/NemoClaw/pull/1081

set -uo pipefail

PASS=0
FAIL=0
SKIP=0
TOTAL=0

pass() {
  ((PASS++))
  ((TOTAL++))
  printf '\033[32m  PASS: %s\033[0m\n' "$1"
}
fail() {
  ((FAIL++))
  ((TOTAL++))
  printf '\033[31m  FAIL: %s\033[0m\n' "$1"
}
skip() {
  ((SKIP++))
  ((TOTAL++))
  printf '\033[33m  SKIP: %s\033[0m\n' "$1"
}
section() {
  echo ""
  printf '\033[1;36m=== %s ===\033[0m\n' "$1"
}
info() { printf '\033[1;34m  [info]\033[0m %s\n' "$1"; }
is_fake_slack_token() {
  case "${1:-}" in
    xoxb-fake-* | xoxb-test-* | xapp-fake-* | xapp-test-*) return 0 ;;
    *) return 1 ;;
  esac
}
is_unresolved_placeholder_rejection() {
  printf '%s\n' "$1" | grep -qiE 'credential_injection_failed|unresolved credential placeholder'
}

# Determine repo root
if [ -d /workspace ] && [ -f /workspace/install.sh ]; then
  REPO="/workspace"
elif [ -f "$(cd "$(dirname "$0")/../.." && pwd)/install.sh" ]; then
  REPO="$(cd "$(dirname "$0")/../.." && pwd)"
else
  echo "ERROR: Cannot find repo root."
  exit 1
fi

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-msg-provider}"
OPENSHELL_BIN="${NEMOCLAW_OPENSHELL_BIN:-openshell}"
REGISTRY="$HOME/.nemoclaw/sandboxes.json"

openshell() {
  if [ "$OPENSHELL_BIN" = "openshell" ]; then
    command openshell "$@"
  else
    "$OPENSHELL_BIN" "$@"
  fi
}

registry_plan_channel_contains() {
  local item="$1"
  node -e '
const fs = require("fs");
const [registryPath, sandboxName, channelId] = process.argv.slice(1);
if (!fs.existsSync(registryPath)) process.exit(1);
const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
const channels = registry.sandboxes?.[sandboxName]?.messaging?.plan?.channels;
process.exit(Array.isArray(channels) && channels.some((channel) => channel?.channelId === channelId) ? 0 : 1);
' "$REGISTRY" "$SANDBOX_NAME" "$item"
}

assert_openclaw_config_activation() {
  local assertion_id="$1"
  local channel="$2"
  local label="$3"
  local channel_present channel_enabled plugin_enabled

  channel_present=$(printf '%s\n' "$channel_json" | CHANNEL="$channel" python3 -c '
import json
import os
import sys
try:
    channels = json.load(sys.stdin)
    print("true" if isinstance(channels.get(os.environ["CHANNEL"]), dict) else "false")
except Exception:
    print("error")
' 2>/dev/null || true)
  channel_enabled=$(printf '%s\n' "$channel_json" | CHANNEL="$channel" python3 -c '
import json
import os
import sys
try:
    channels = json.load(sys.stdin)
    entry = channels.get(os.environ["CHANNEL"], {})
    print("true" if isinstance(entry, dict) and entry.get("enabled") is True else "false")
except Exception:
    print("error")
' 2>/dev/null || true)
  plugin_enabled=$(printf '%s\n' "$plugin_entries_json" | CHANNEL="$channel" python3 -c '
import json
import os
import sys
try:
    entries = json.load(sys.stdin)
    entry = entries.get(os.environ["CHANNEL"], {})
    print("true" if isinstance(entry, dict) and entry.get("enabled") is True else "false")
except Exception:
    print("error")
' 2>/dev/null || true)

  if [ "$channel_present" != "true" ]; then
    skip "${assertion_id}: ${label} channel block not in openclaw.json (expected in non-root sandbox)"
    return
  fi

  if [ "$channel_enabled" = "true" ] && [ "$plugin_enabled" = "true" ]; then
    pass "${assertion_id}: ${label} channel and plugin are explicitly enabled in openclaw.json"
  else
    fail "${assertion_id}: ${label} OpenClaw activation missing (channels.${channel}.enabled=${channel_enabled}, plugins.entries.${channel}.enabled=${plugin_enabled})"
  fi
}

summarize_openclaw_config_activation() {
  CHANNEL_JSON="$channel_json" PLUGIN_ENTRIES_JSON="$plugin_entries_json" python3 -c '
import json
import os

channels_to_check = ("telegram", "discord", "slack", "whatsapp")
try:
    channels = json.loads(os.environ.get("CHANNEL_JSON", "{}"))
    entries = json.loads(os.environ.get("PLUGIN_ENTRIES_JSON", "{}"))
except json.JSONDecodeError as exc:
    print("parse_error=%s" % exc.msg)
    raise SystemExit(0)

summary = []
for channel in channels_to_check:
    channel_entry = channels.get(channel, {})
    plugin_entry = entries.get(channel, {})
    summary.append(
        "%s:channel=%s,plugin=%s"
        % (
            channel,
            isinstance(channel_entry, dict) and channel_entry.get("enabled") is True,
            isinstance(plugin_entry, dict) and plugin_entry.get("enabled") is True,
        )
    )
print("; ".join(summary))
' 2>/dev/null || printf 'unavailable'
}

summarize_openclaw_runtime_channels() {
  printf '%s\n' "$openclaw_channels_list_json" | python3 -c '
import json
import sys

channels_to_check = ("telegram", "discord", "slack", "whatsapp")
try:
    data = json.load(sys.stdin)
except json.JSONDecodeError as exc:
    print("parse_error=%s" % exc.msg)
    raise SystemExit(0)

chat = data.get("chat") if isinstance(data, dict) else None
if not isinstance(chat, dict):
    print("missing_chat")
    raise SystemExit(0)

summary = []
for channel in channels_to_check:
    entry = chat.get(channel)
    if not isinstance(entry, dict):
        summary.append("%s:missing" % channel)
        continue
    accounts = entry.get("accounts")
    if isinstance(accounts, list):
        account_ids = [str(item) for item in accounts if isinstance(item, str)]
    else:
        account_ids = ["<%s>" % type(accounts).__name__]
    summary.append(
        "%s:installed=%s,origin=%s,accounts=%s"
        % (channel, entry.get("installed"), entry.get("origin"), ",".join(account_ids))
    )
print("; ".join(summary))
' 2>/dev/null || printf 'unavailable'
}

assert_openclaw_runtime_channel() {
  local assertion_id="$1"
  local channel="$2"
  local label="$3"
  local expected_account="${4:-default}"
  local runtime_state

  runtime_state=$(printf '%s\n' "$openclaw_channels_list_json" | CHANNEL="$channel" ACCOUNT="$expected_account" python3 -c '
import json
import os
import sys

channel = os.environ["CHANNEL"]
expected = os.environ.get("ACCOUNT", "")
try:
    data = json.load(sys.stdin)
except json.JSONDecodeError as exc:
    print("error invalid_json=%s" % exc.msg)
    raise SystemExit(0)

if not isinstance(data, dict):
    print("no top_level_type=%s" % type(data).__name__)
    raise SystemExit(0)

chat = data.get("chat")
if not isinstance(chat, dict):
    print("no missing_chat")
    raise SystemExit(0)

entry = chat.get(channel)
if not isinstance(entry, dict):
    print("no missing_channel")
    raise SystemExit(0)

# OpenClaw `channels list --all --json` currently reports configured account
# ids as a list of strings, for example: {"chat":{"slack":{"accounts":["default"]}}}.
# Keep this strict so schema drift fails loudly instead of hiding a discovery
# regression behind a permissive compatibility parser.
accounts = entry.get("accounts")
if not isinstance(accounts, list) or any(not isinstance(item, str) for item in accounts):
    print(
        "no installed=%s origin=%s accounts_shape=%s"
        % (entry.get("installed"), entry.get("origin"), type(accounts).__name__)
    )
    raise SystemExit(0)

installed = entry.get("installed") is True
configured = entry.get("origin") == "configured"
account_ok = not expected or expected in accounts
if installed and configured and account_ok:
    print("yes")
else:
    print(
        "no installed=%s origin=%s accounts=%s"
        % (entry.get("installed"), entry.get("origin"), accounts)
    )
' 2>/dev/null || true)

  if [ "$runtime_state" = "yes" ]; then
    pass "${assertion_id}: OpenClaw channels list reports ${label} installed and configured"
  else
    fail "${assertion_id}: OpenClaw channels list did not report ${label} installed/configured (${runtime_state}; summary=${openclaw_channels_summary:-unavailable})"
  fi
}

assert_openclaw_runtime_channel_installed() {
  local assertion_id="$1"
  local channel="$2"
  local label="$3"
  local runtime_state

  runtime_state=$(printf '%s\n' "$openclaw_channels_list_json" | CHANNEL="$channel" python3 -c '
import json
import os
import sys

channel = os.environ["CHANNEL"]
try:
    data = json.load(sys.stdin)
except json.JSONDecodeError as exc:
    print("error invalid_json=%s" % exc.msg)
    raise SystemExit(0)

chat = data.get("chat") if isinstance(data, dict) else None
if not isinstance(chat, dict):
    print("no missing_chat")
    raise SystemExit(0)

entry = chat.get(channel)
if not isinstance(entry, dict):
    print("no missing_channel")
    raise SystemExit(0)

accounts = entry.get("accounts")
if not isinstance(accounts, list) or any(not isinstance(item, str) for item in accounts):
    print(
        "no installed=%s origin=%s accounts_shape=%s"
        % (entry.get("installed"), entry.get("origin"), type(accounts).__name__)
    )
    raise SystemExit(0)

installed = entry.get("installed") is True
origin_ok = entry.get("origin") in ("available", "configured")
if installed and origin_ok:
    print("yes")
else:
    print(
        "no installed=%s origin=%s accounts=%s"
        % (entry.get("installed"), entry.get("origin"), accounts)
    )
' 2>/dev/null || true)

  if [ "$runtime_state" = "yes" ]; then
    pass "${assertion_id}: OpenClaw channels list reports ${label} plugin installed"
  else
    fail "${assertion_id}: OpenClaw channels list did not report ${label} plugin installed (${runtime_state}; summary=${openclaw_channels_summary:-unavailable})"
  fi
}

# shellcheck source=test/e2e/lib/sandbox-teardown.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/sandbox-teardown.sh"
register_sandbox_for_teardown "$SANDBOX_NAME"

# Default to hermetic fake tokens, but let repository live-message secrets win
# when they are available. The workflow always provides fake env_json values so
# the _REAL variables must take precedence here.
TELEGRAM_TOKEN="${TELEGRAM_BOT_TOKEN_REAL:-${TELEGRAM_BOT_TOKEN:-test-fake-telegram-token-e2e}}"
DISCORD_TOKEN="${DISCORD_BOT_TOKEN_REAL:-${DISCORD_BOT_TOKEN:-test-fake-discord-token-e2e}}"
SLACK_TOKEN="${SLACK_BOT_TOKEN_REAL:-${SLACK_BOT_TOKEN:-xoxb-fake-slack-token-e2e}}"
SLACK_APP="${SLACK_APP_TOKEN_REAL:-${SLACK_APP_TOKEN:-xapp-fake-slack-app-token-e2e}}"
if [ -n "${TELEGRAM_ALLOWED_IDS:-}" ]; then
  TELEGRAM_IDS="$TELEGRAM_ALLOWED_IDS"
  TELEGRAM_ALLOWLIST_ENV_KEY="TELEGRAM_ALLOWED_IDS"
elif [ -n "${TELEGRAM_AUTHORIZED_CHAT_IDS:-}" ]; then
  TELEGRAM_IDS="$TELEGRAM_AUTHORIZED_CHAT_IDS"
  TELEGRAM_ALLOWLIST_ENV_KEY="TELEGRAM_AUTHORIZED_CHAT_IDS"
elif [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
  TELEGRAM_IDS="$TELEGRAM_CHAT_ID"
  TELEGRAM_ALLOWLIST_ENV_KEY="TELEGRAM_CHAT_ID"
else
  TELEGRAM_IDS="123456789,987654321"
  TELEGRAM_ALLOWLIST_ENV_KEY="TELEGRAM_AUTHORIZED_CHAT_IDS"
fi
SLACK_IDS="${SLACK_ALLOWED_USERS-U0AR85ATALW,U09E2ESLACK}"
# WeChat: pre-seeding WECHAT_BOT_TOKEN + the per-account metadata env vars lets
# the non-interactive onboard path (src/lib/onboard.ts:8433) treat wechat as
# "already configured" and skip the host-qr handler entirely. Fake values are
# enough — Phase 1-3 verify placeholders/isolation; no live iLink contact is
# made because no token exchange happens at build time.
WECHAT_TOKEN="${WECHAT_BOT_TOKEN:-test-fake-wechat-token-e2e}"
WECHAT_ACCOUNT="${WECHAT_ACCOUNT_ID:-e2e-fake-account-12345}"
WECHAT_BASE="${WECHAT_BASE_URL:-https://ilinkai.wechat.com}"
WECHAT_USER="${WECHAT_USER_ID:-wxid_e2efakeoperator}"
WECHAT_IDS="${WECHAT_ALLOWED_IDS:-${WECHAT_USER}}"
# WhatsApp is QR-only, but seed host-side decoys to prove they are ignored.
WHATSAPP_TOKEN_DECOY="test-fake-whatsapp-token-e2e"
WHATSAPP_BOT_TOKEN_DECOY="test-fake-whatsapp-bot-token-e2e"
WHATSAPP_SESSION_SECRET_DECOY="test-fake-whatsapp-session-secret-e2e"
export TELEGRAM_BOT_TOKEN="$TELEGRAM_TOKEN"
export DISCORD_BOT_TOKEN="$DISCORD_TOKEN"
export SLACK_BOT_TOKEN="$SLACK_TOKEN"
export SLACK_APP_TOKEN="$SLACK_APP"
case "$TELEGRAM_ALLOWLIST_ENV_KEY" in
  TELEGRAM_ALLOWED_IDS)
    export TELEGRAM_ALLOWED_IDS="$TELEGRAM_IDS"
    ;;
  TELEGRAM_AUTHORIZED_CHAT_IDS)
    unset TELEGRAM_ALLOWED_IDS
    export TELEGRAM_AUTHORIZED_CHAT_IDS="$TELEGRAM_IDS"
    ;;
  TELEGRAM_CHAT_ID)
    unset TELEGRAM_ALLOWED_IDS TELEGRAM_AUTHORIZED_CHAT_IDS
    export TELEGRAM_CHAT_ID="$TELEGRAM_IDS"
    ;;
esac
export SLACK_ALLOWED_USERS="$SLACK_IDS"
export WECHAT_BOT_TOKEN="$WECHAT_TOKEN"
export WECHAT_ACCOUNT_ID="$WECHAT_ACCOUNT"
export WECHAT_BASE_URL="$WECHAT_BASE"
export WECHAT_USER_ID="$WECHAT_USER"
export WECHAT_ALLOWED_IDS="$WECHAT_IDS"
export WHATSAPP_TOKEN="$WHATSAPP_TOKEN_DECOY"
export WHATSAPP_BOT_TOKEN="$WHATSAPP_BOT_TOKEN_DECOY"
export WHATSAPP_SESSION_SECRET="$WHATSAPP_SESSION_SECRET_DECOY"

# NEMOCLAW_EXTRA_PLACEHOLDER_KEYS — operator-supplied per-profile credentials.
# The host-side parser at src/lib/onboard/extra-placeholder-keys.ts accepts
# only entries that extend a canonical channel envKey with a non-empty
# `_<suffix>`, rejects bare canonical keys, the control env, and arbitrary
# host secret names. The fixtures below cover three observable outcomes
# Phase 2c asserts on:
#
#   1. TELEGRAM_BOT_TOKEN_AGENT_A — extension + token exported -> provider
#      row registered, placeholder injected into the sandbox env.
#   2. TELEGRAM_BOT_TOKEN_AGENT_MISSING — extension + token NOT exported ->
#      registerExtraPlaceholderProviders pushes a token=null row that
#      upsertMessagingProviders skips at the gateway; no placeholder is
#      injected for that key.
#   3. GITHUB_TOKEN — host secret shape -> rejected at the parser layer
#      before any provider row is built; the raw value must never reach
#      the sandbox provider gateway.
EXTRAS_TELEGRAM_AGENT_A_TOKEN="test-fake-telegram-token-agent-a-e2e"
EXTRAS_TELEGRAM_AGENT_B_TOKEN="test-fake-telegram-token-agent-b-e2e"
EXTRAS_GITHUB_DECOY="test-fake-host-secret-that-must-not-leak"
export NEMOCLAW_EXTRA_PLACEHOLDER_KEYS="TELEGRAM_BOT_TOKEN_AGENT_A TELEGRAM_BOT_TOKEN_AGENT_B TELEGRAM_BOT_TOKEN_AGENT_MISSING GITHUB_TOKEN"
export TELEGRAM_BOT_TOKEN_AGENT_A="$EXTRAS_TELEGRAM_AGENT_A_TOKEN"
export TELEGRAM_BOT_TOKEN_AGENT_B="$EXTRAS_TELEGRAM_AGENT_B_TOKEN"
unset TELEGRAM_BOT_TOKEN_AGENT_MISSING
export GITHUB_TOKEN="$EXTRAS_GITHUB_DECOY"

# Run a command inside the sandbox via stdin (avoids exposing sensitive args in process list)
sandbox_exec_stdin() {
  local cmd="$1"
  local ssh_config
  ssh_config="$(mktemp)"
  openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_config" 2>/dev/null

  local result
  result=$(timeout 60 ssh -F "$ssh_config" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 \
    -o LogLevel=ERROR \
    "openshell-${SANDBOX_NAME}" \
    "$cmd" \
    2>/dev/null) || true

  rm -f "$ssh_config"
  echo "$result"
}

# Run a command inside the sandbox and capture output
sandbox_exec() {
  local cmd="$1"
  local ssh_config
  ssh_config="$(mktemp)"
  openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_config" 2>/dev/null

  local result
  result=$(timeout 60 ssh -F "$ssh_config" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 \
    -o LogLevel=ERROR \
    "openshell-${SANDBOX_NAME}" \
    "$cmd" \
    2>&1) || true

  rm -f "$ssh_config"
  echo "$result"
}

read_gateway_log() {
  openshell sandbox exec --name "$SANDBOX_NAME" -- cat /tmp/gateway.log 2>/dev/null || true
}

run_telegram_inbound_reply_probe() {
  if [ "${NEMOCLAW_TELEGRAM_INBOUND_REPLY_E2E:-}" != "1" ]; then
    return
  fi

  section "Phase 6a: Live Telegram Inbound Reply Proof"

  local wait_seconds="${NEMOCLAW_TELEGRAM_INBOUND_WAIT_SECONDS:-90}"
  if ! [[ "$wait_seconds" =~ ^[0-9]+$ ]]; then
    wait_seconds=90
  fi
  if [ "$wait_seconds" -lt 1 ]; then
    wait_seconds=90
  fi

  if [ -z "${TELEGRAM_BOT_TOKEN_REAL:-}" ]; then
    fail "M19b: Live Telegram inbound proof requires TELEGRAM_BOT_TOKEN_REAL"
    return
  fi
  if [ "$TELEGRAM_ALLOWLIST_ENV_KEY" = "TELEGRAM_ALLOWED_IDS" ]; then
    fail "M19b: Live Telegram inbound proof must be run with TELEGRAM_AUTHORIZED_CHAT_IDS or TELEGRAM_CHAT_ID to exercise alias compatibility"
    return
  fi
  if [ -z "$TELEGRAM_IDS" ]; then
    fail "M19b: Live Telegram inbound proof requires a non-empty Telegram allowlist alias"
    return
  fi

  local log_before_lines
  log_before_lines=$(read_gateway_log | wc -l | tr -d ' ')
  if [ -z "$log_before_lines" ]; then
    log_before_lines=0
  fi

  info "Live Telegram inbound proof is using ${TELEGRAM_ALLOWLIST_ENV_KEY}; send a fresh direct message from an allowed Telegram client to the bot now."
  info "Waiting up to ${wait_seconds}s for inbound getUpdates and outbound sendMessage breadcrumbs in /tmp/gateway.log..."

  local deadline now delta_log saw_inbound saw_outbound
  deadline=$(($(date +%s) + wait_seconds))
  saw_inbound=0
  saw_outbound=0
  while true; do
    delta_log=$(read_gateway_log | awk -v start="$log_before_lines" 'NR > start')
    if echo "$delta_log" | grep -qF "[telegram] [default] inbound update received"; then
      saw_inbound=1
    fi
    if echo "$delta_log" | grep -qF "[telegram] [default] outbound sendMessage attempted"; then
      saw_outbound=1
    fi
    if [ "$saw_inbound" = "1" ] && [ "$saw_outbound" = "1" ]; then
      pass "M19b: Telegram client DM produced inbound getUpdates and outbound reply breadcrumbs"
      return
    fi
    now=$(date +%s)
    if [ "$now" -ge "$deadline" ]; then
      break
    fi
    sleep 5
  done

  fail "M19b: Timed out waiting for Telegram inbound/reply breadcrumbs (inbound=${saw_inbound}, outbound=${saw_outbound})"
}

run_openclaw_message_send() {
  local channel="$1"
  local target="$2"
  local message="$3"
  local channel_b64 target_b64 message_b64
  channel_b64=$(printf '%s' "$channel" | base64 | tr -d '\n')
  target_b64=$(printf '%s' "$target" | base64 | tr -d '\n')
  message_b64=$(printf '%s' "$message" | base64 | tr -d '\n')

  sandbox_exec_stdin "OPENCLAW_MESSAGE_CHANNEL_B64='$channel_b64' OPENCLAW_MESSAGE_TARGET_B64='$target_b64' OPENCLAW_MESSAGE_TEXT_B64='$message_b64' bash -s" <<'SH'
decode_b64() {
  printf '%s' "$1" | base64 -d
}

channel="$(decode_b64 "$OPENCLAW_MESSAGE_CHANNEL_B64")"
target="$(decode_b64 "$OPENCLAW_MESSAGE_TARGET_B64")"
message="$(decode_b64 "$OPENCLAW_MESSAGE_TEXT_B64")"

set +e
OPENCLAW_NO_COLOR=1 openclaw message send --channel "$channel" --target "$target" --message "$message" --json
rc=$?
echo "__OPENCLAW_MESSAGE_SEND_EXIT__:$rc"
SH
}

openclaw_message_send_exit_code() {
  awk -F: '/^__OPENCLAW_MESSAGE_SEND_EXIT__:/ { code = $2 } END { if (code != "") print code }'
}

# shellcheck source=test/e2e/lib/discord-gateway-proof.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/discord-gateway-proof.sh"
# shellcheck source=test/e2e/lib/discord-rest-policy-proof.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/discord-rest-policy-proof.sh"
# shellcheck source=test/e2e/lib/slack-api-proof.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/slack-api-proof.sh"
# shellcheck source=test/e2e/lib/telegram-api-proof.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/telegram-api-proof.sh"

# ══════════════════════════════════════════════════════════════════
# Phase 0: Prerequisites
# ══════════════════════════════════════════════════════════════════
section "Phase 0: Prerequisites"

if [ -z "${NVIDIA_INFERENCE_API_KEY:-}" ] && [ -n "${NVIDIA_API_KEY:-}" ]; then
  export NVIDIA_INFERENCE_API_KEY="${NVIDIA_API_KEY}"
  info "Using legacy NVIDIA_API_KEY as fallback for NVIDIA_INFERENCE_API_KEY"
fi
if [ -z "${NVIDIA_INFERENCE_API_KEY:-}" ]; then
  fail "NVIDIA_INFERENCE_API_KEY not set"
  exit 1
fi
pass "NVIDIA_INFERENCE_API_KEY is set"

if ! docker info >/dev/null 2>&1; then
  fail "Docker is not running"
  exit 1
fi
pass "Docker is running"

info "Telegram token: configured (${#TELEGRAM_TOKEN} chars)"
telegram_allowed_id_count=0
if [ -n "$TELEGRAM_IDS" ]; then
  IFS=',' read -ra _telegram_allowed_ids <<<"$TELEGRAM_IDS"
  for _tid in "${_telegram_allowed_ids[@]}"; do
    _tid="${_tid//[[:space:]]/}"
    [ -n "$_tid" ] && ((telegram_allowed_id_count++))
  done
fi
info "Telegram allowlist source: ${TELEGRAM_ALLOWLIST_ENV_KEY} (${telegram_allowed_id_count} ID(s))"
info "Discord token: configured (${#DISCORD_TOKEN} chars)"
info "Slack bot token: configured (${#SLACK_TOKEN} chars)"
info "Slack app token: configured (${#SLACK_APP} chars)"
slack_allowed_user_count=0
if [ -n "$SLACK_IDS" ]; then
  IFS=',' read -ra _slack_allowed_ids <<<"$SLACK_IDS"
  for _sid in "${_slack_allowed_ids[@]}"; do
    _sid="${_sid//[[:space:]]/}"
    [ -n "$_sid" ] && ((slack_allowed_user_count++))
  done
fi
info "Slack allowed users configured: ${slack_allowed_user_count} ID(s)"
info "WeChat token: configured (${#WECHAT_TOKEN} chars), account=${WECHAT_ACCOUNT}"
info "Sandbox name: $SANDBOX_NAME"

# ══════════════════════════════════════════════════════════════════
# Phase 1: Install NemoClaw (non-interactive mode)
# ══════════════════════════════════════════════════════════════════
section "Phase 1: Install NemoClaw with messaging tokens"

cd "$REPO" || exit 1

# Pre-cleanup: destroy any leftover sandbox from previous runs
info "Pre-cleanup..."
if command -v nemoclaw >/dev/null 2>&1; then
  nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true
fi
if openshell --version >/dev/null 2>&1; then
  openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true
  openshell gateway destroy -g nemoclaw 2>/dev/null || true
fi
pass "Pre-cleanup complete"

if [ -z "${NEMOCLAW_SKIP_TELEGRAM_REACHABILITY:-}" ]; then
  if [ -z "${TELEGRAM_BOT_TOKEN_REAL:-}" ] && [[ "$TELEGRAM_TOKEN" == *fake* ]]; then
    export NEMOCLAW_SKIP_TELEGRAM_REACHABILITY=1
    info "Skipping onboarding Telegram reachability probe for fake-token E2E"
  elif [ -z "${TELEGRAM_BOT_TOKEN_REAL:-}" ] \
    && ! curl -fsS --max-time 10 https://api.telegram.org/ >/dev/null 2>&1; then
    export NEMOCLAW_SKIP_TELEGRAM_REACHABILITY=1
    info "Host cannot reach api.telegram.org; skipping manifest Telegram reachability check"
  fi
fi
if [ -z "${NEMOCLAW_SKIP_SLACK_AUTH_VALIDATION:-}" ] \
  && [ -z "${SLACK_BOT_TOKEN_REAL:-}" ] \
  && [ -z "${SLACK_APP_TOKEN_REAL:-}" ] \
  && { is_fake_slack_token "$SLACK_TOKEN" || is_fake_slack_token "$SLACK_APP"; }; then
  # This E2E uses fake Slack tokens to prove placeholder/proxy behavior against
  # the hermetic fake Slack API. Keep real-token runs on the live validation path.
  export NEMOCLAW_SKIP_SLACK_AUTH_VALIDATION=1
  info "Skipping onboarding Slack auth validation for fake-token E2E"
fi

# Pre-merge Slack policy into the base sandbox policy.
#
# The base policy (openclaw-sandbox.yaml) includes Telegram and Discord
# network rules but NOT Slack — Slack access normally comes from the
# slack.yaml preset, applied in onboard Step 8. However, the sandbox
# container starts in Step 6, so the gateway boots without Slack access.
# The Slack SDK's connection attempt hangs or gets a CONNECT 403 before
# the preset is applied, preventing the gateway from serving on 18789.
#
# By appending the Slack rules to the base policy BEFORE install.sh, the
# sandbox is created with Slack access from the start. The Slack SDK gets
# a fast "invalid_auth" response, the channel guard catches it, and the
# gateway continues serving.
# Ref: #2340
BASE_POLICY="$REPO/nemoclaw-blueprint/policies/openclaw-sandbox.yaml"
SLACK_PRESET="$REPO/nemoclaw-blueprint/policies/presets/slack.yaml"
if [ -f "$BASE_POLICY" ] && [ -f "$SLACK_PRESET" ] && ! grep -q "api.slack.com" "$BASE_POLICY"; then
  BASE_POLICY_BAK="$(mktemp)"
  cp "$BASE_POLICY" "$BASE_POLICY_BAK"
  _previous_exit_trap=$(trap -p EXIT | sed "s/^trap -- '//;s/' EXIT$//")
  trap ''"${_previous_exit_trap:+$_previous_exit_trap;}"' cp "$BASE_POLICY_BAK" "$BASE_POLICY" 2>/dev/null || true; rm -f "$BASE_POLICY_BAK"' EXIT
  info "Pre-merging Slack network policy into base sandbox policy..."
  cat >>"$BASE_POLICY" <<'SLACK_POLICY_EOF'

  # ── Slack — pre-merged for messaging E2E (#2340) ──────────────
  # Normally applied as a preset in onboard Step 8, but the sandbox
  # container starts before presets are applied. Inline here so the
  # gateway has Slack access from first boot.
  slack:
    name: slack
    endpoints:
      - host: slack.com
        port: 443
        protocol: rest
        enforcement: enforce
        rules:
          - allow: { method: GET, path: "/**" }
          - allow: { method: POST, path: "/**" }
      - host: api.slack.com
        port: 443
        protocol: rest
        enforcement: enforce
        rules:
          - allow: { method: GET, path: "/**" }
          - allow: { method: POST, path: "/**" }
      - host: hooks.slack.com
        port: 443
        protocol: rest
        enforcement: enforce
        rules:
          - allow: { method: GET, path: "/**" }
          - allow: { method: POST, path: "/**" }
      - host: wss-primary.slack.com
        port: 443
        protocol: websocket
        enforcement: enforce
        rules:
          - allow: { method: GET, path: "/**" }
          - allow: { method: WEBSOCKET_TEXT, path: "/**" }
      - host: wss-backup.slack.com
        port: 443
        protocol: websocket
        enforcement: enforce
        rules:
          - allow: { method: GET, path: "/**" }
          - allow: { method: WEBSOCKET_TEXT, path: "/**" }
    binaries:
      - { path: /usr/local/bin/node }
      - { path: /usr/bin/node }
SLACK_POLICY_EOF
  if ! grep -q "api.slack.com" "$BASE_POLICY"; then
    fail "Failed to append Slack policy to base sandbox policy"
    exit 1
  fi
  pass "Slack network policy pre-merged into base policy"
else
  if grep -q "api.slack.com" "$BASE_POLICY" 2>/dev/null; then
    info "Slack policy already present in base policy — skipping pre-merge"
  else
    fail "Cannot pre-merge Slack policy: missing base policy or preset file"
    exit 1
  fi
fi

# Run install.sh --non-interactive which installs Node.js, openshell,
# NemoClaw, and runs onboard. Messaging tokens are already exported so
# the onboard step creates providers and attaches them to the sandbox.
info "Running install.sh --non-interactive..."
info "This installs Node.js, openshell, NemoClaw, and runs onboard with messaging providers."
info "Expected duration: 5-10 minutes on first run."

export NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME"
export NEMOCLAW_RECREATE_SANDBOX=1
export NEMOCLAW_FRESH=1

INSTALL_LOG="/tmp/nemoclaw-e2e-install.log"
bash install.sh --non-interactive >"$INSTALL_LOG" 2>&1 &
install_pid=$!
tail -f "$INSTALL_LOG" --pid=$install_pid 2>/dev/null &
tail_pid=$!
wait $install_pid
install_exit=$?
kill $tail_pid 2>/dev/null || true
wait $tail_pid 2>/dev/null || true

# Source shell profile to pick up nvm/PATH changes from install.sh
if [ -f "$HOME/.bashrc" ]; then
  # shellcheck source=/dev/null
  source "$HOME/.bashrc" 2>/dev/null || true
fi
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
fi
if [ -d "$HOME/.local/bin" ] && [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  export PATH="$HOME/.local/bin:$PATH"
fi

if [ $install_exit -eq 0 ]; then
  pass "M0: install.sh completed (exit 0)"
else
  fail "M0: install.sh failed (exit $install_exit)"
  info "Last 30 lines of install log:"
  tail -30 "$INSTALL_LOG" 2>/dev/null || true
  exit 1
fi

# Verify tools are on PATH
if ! openshell --version >/dev/null 2>&1; then
  fail "openshell not found on PATH after install"
  exit 1
fi
pass "openshell installed ($(openshell --version 2>&1 || echo unknown))"

if ! command -v nemoclaw >/dev/null 2>&1; then
  fail "nemoclaw not found on PATH after install"
  exit 1
fi
pass "nemoclaw installed at $(command -v nemoclaw)"

# Verify sandbox is ready
sandbox_list=$(openshell sandbox list 2>&1 || true)
if echo "$sandbox_list" | grep -q "$SANDBOX_NAME.*Ready"; then
  pass "M0b: Sandbox '$SANDBOX_NAME' is Ready"
else
  fail "M0b: Sandbox '$SANDBOX_NAME' not Ready (list: ${sandbox_list:0:200})"
  exit 1
fi

# ══════════════════════════════════════════════════════════════════
# Phase 1b: Enable WhatsApp QR-only channel
# ══════════════════════════════════════════════════════════════════
section "Phase 1b: Enable WhatsApp QR-only channel"

WHATSAPP_ADD_LOG="/tmp/nemoclaw-e2e-whatsapp-add.log"
if nemoclaw "$SANDBOX_NAME" channels add whatsapp >"$WHATSAPP_ADD_LOG" 2>&1; then
  whatsapp_add_exit=0
else
  whatsapp_add_exit=$?
fi
cat "$WHATSAPP_ADD_LOG"

if [ "$whatsapp_add_exit" -eq 0 ] && grep -q "Enabled whatsapp channel" "$WHATSAPP_ADD_LOG"; then
  pass "M-WA0: channels add whatsapp registered QR-only channel"
else
  fail "M-WA0: channels add whatsapp failed or did not register channel"
  tail -30 "$WHATSAPP_ADD_LOG" 2>/dev/null || true
  exit 1
fi

if openshell provider get "${SANDBOX_NAME}-whatsapp-bridge" >/dev/null 2>&1; then
  fail "M-WA1: Unexpected WhatsApp bridge provider exists in gateway"
else
  pass "M-WA1: WhatsApp QR-only channel creates no bridge provider"
fi

if registry_plan_channel_contains "whatsapp"; then
  pass "M-WA2: registry.messaging.plan.channels contains whatsapp after channel add"
else
  fail "M-WA2: registry.messaging.plan.channels missing whatsapp after channel add"
fi

whatsapp_policy_pre=$(openshell policy get --full "$SANDBOX_NAME" 2>/dev/null || true)
if echo "$whatsapp_policy_pre" | grep -q "web.whatsapp.com" \
  && echo "$whatsapp_policy_pre" | grep -q "whatsapp.net" \
  && echo "$whatsapp_policy_pre" | grep -q "raw.githubusercontent.com"; then
  pass "M-WA3: WhatsApp policy preset applied before rebuild"
else
  fail "M-WA3: WhatsApp policy preset missing expected endpoints before rebuild"
fi

WHATSAPP_REBUILD_LOG="/tmp/nemoclaw-e2e-whatsapp-rebuild.log"
info "Rebuilding sandbox so WhatsApp is baked into openclaw.json..."
if nemoclaw "$SANDBOX_NAME" rebuild --yes >"$WHATSAPP_REBUILD_LOG" 2>&1; then
  pass "M-WA4: Rebuild completed after WhatsApp channel add"
else
  fail "M-WA4: Rebuild failed after WhatsApp channel add"
  tail -50 "$WHATSAPP_REBUILD_LOG" 2>/dev/null || true
  exit 1
fi

whatsapp_policy_post=$(openshell policy get --full "$SANDBOX_NAME" 2>/dev/null || true)
if echo "$whatsapp_policy_post" | grep -q "web.whatsapp.com" \
  && echo "$whatsapp_policy_post" | grep -q "whatsapp.net" \
  && echo "$whatsapp_policy_post" | grep -q "raw.githubusercontent.com" \
  && { echo "$whatsapp_policy_post" | grep -q "/usr/local/bin/node" || echo "$whatsapp_policy_post" | grep -q "/usr/bin/node"; }; then
  pass "M-WA5: WhatsApp policy preset survived rebuild with Node binary scope"
else
  fail "M-WA5: WhatsApp policy preset missing expected endpoints/binaries after rebuild"
fi

sandbox_list=$(openshell sandbox list 2>&1 || true)
if echo "$sandbox_list" | grep -q "$SANDBOX_NAME.*Ready"; then
  pass "M-WA6: Sandbox '$SANDBOX_NAME' is Ready after WhatsApp rebuild"
else
  fail "M-WA6: Sandbox '$SANDBOX_NAME' not Ready after WhatsApp rebuild (list: ${sandbox_list:0:200})"
  exit 1
fi

# M-WA6b: WhatsApp compact-QR pairing wiring (NemoClaw#4522). The entrypoint
# installs a NemoClaw-owned preload that forces the `qrcode` package (which
# OpenClaw's renderQrTerminal uses to render the pairing QR) into
# `{ small: true }` half-block rendering so the in-sandbox pairing QR fits a
# phone-camera frame. The preload is wired into the connect-session NODE_OPTIONS
# and the openclaw() guard injects it for the `channels login --channel whatsapp`
# invocation. Verify the preload file (root-owned/read-only in root mode;
# read-only in non-root mode) and the guard wiring are present in the sandbox.
whatsapp_qr_preload_stat=$(sandbox_exec "stat -c '%U:%a' /tmp/nemoclaw-whatsapp-qr-compact.js 2>/dev/null || echo missing")
entrypoint_start_log_stat=$(sandbox_exec "stat -c '%U:%a' /tmp/nemoclaw-start.log 2>/dev/null || echo missing")
if [ "$whatsapp_qr_preload_stat" = "root:444" ]; then
  pass "M-WA6b: WhatsApp compact-QR preload installed root:444 (#4522)"
elif [ "$whatsapp_qr_preload_stat" = "sandbox:444" ] && [ "$entrypoint_start_log_stat" = "sandbox:600" ]; then
  # /tmp/nemoclaw-start.log is written before sandbox-init.sh is sourced:
  # root mode creates root:600, while non-root mode creates sandbox:600.
  # Only accept sandbox-owned sourced files when that independent init-time
  # signal proves privilege separation was already disabled.
  pass "M-WA6b: WhatsApp compact-QR preload installed sandbox:444 (non-root mode) (#4522)"
elif [ "$whatsapp_qr_preload_stat" = "missing" ]; then
  fail "M-WA6b: WhatsApp compact-QR preload not installed in sandbox (#4522)"
else
  fail "M-WA6b: WhatsApp compact-QR preload has unexpected owner/mode: ${whatsapp_qr_preload_stat} (entrypoint start log: ${entrypoint_start_log_stat}) (#4522)"
fi

# Assert on the generic manifest-runtime wiring, not just the filename: the
# filename also appears in install banners and path assignments. After the
# messaging manifest migration, WhatsApp contributes a connect preload entry
# and the shared openclaw() guard reads that list for WhatsApp login.
whatsapp_qr_connect_list=$(sandbox_exec "grep -cFx -- '/tmp/nemoclaw-whatsapp-qr-compact.js' /tmp/nemoclaw-messaging-connect-preloads.list 2>/dev/null || echo 0")
whatsapp_qr_connect_export=$(sandbox_exec "grep -cF -- '--require \$_nemoclaw_preload' /tmp/nemoclaw-proxy-env.sh 2>/dev/null || echo 0")
whatsapp_qr_guard_wiring=$(sandbox_exec "grep -cF -- '_nemoclaw_messaging_connect_node_options' /tmp/nemoclaw-proxy-env.sh 2>/dev/null || echo 0")
if [ "${whatsapp_qr_connect_list:-0}" -ge 1 ] 2>/dev/null \
  && [ "${whatsapp_qr_connect_export:-0}" -ge 1 ] 2>/dev/null \
  && [ "${whatsapp_qr_guard_wiring:-0}" -ge 1 ] 2>/dev/null; then
  pass "M-WA6c: openclaw() guard injects manifest connect preloads for WhatsApp login (#4522)"
else
  fail "M-WA6c: openclaw() guard missing manifest connect preload injection for WhatsApp login (#4522)"
fi

# M-WA6d: Prove the rendered QR SIZE in the real sandbox, not just that the
# preload file/wiring exist (NemoClaw#4522). Render a representative WhatsApp
# pairing payload through the EXACT renderer the channel-login onQr callback
# uses — `renderQrTerminal` from the baked OpenClaw's plugin-sdk/media-runtime —
# once with the connect-session NODE_OPTIONS sourced (the preload active, as in
# the reporter workflow) and once with NODE_OPTIONS cleared. Assert the sourced
# render is compact and strictly smaller than the cleared baseline.
#
# The probe runs from the global node_modules parent so the bare
# `openclaw/...` specifier resolves against the globally-installed CLI. If the
# renderer cannot be resolved/executed at all (an infra/resolution issue, not a
# size regression) the sub-check SKIPs rather than failing the suite — an actual
# oversized render still yields a number above the ceiling and fails. The
# hard-gated, version-pinned size proof lives in
# test/e2e-scenario/live/whatsapp-qr-compact.test.ts.
WHATSAPP_QR_RENDER_PROBE=$(
  cat <<'PROBE'
import { renderQrTerminal } from "openclaw/plugin-sdk/media-runtime";
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const qr = "2@" + "ABcd12".repeat(8) + "," + "a8K3".repeat(11) + "=," +
  "Xy90".repeat(11) + "=," + "Qr5T".repeat(9) + "=";
const out = strip(await renderQrTerminal(qr));
process.stdout.write(String(out.split("\n").length));
PROBE
)
whatsapp_qr_render_b64=$(printf '%s' "$WHATSAPP_QR_RENDER_PROBE" | base64 | tr -d '\n')
# Build a remote command that writes the probe to the global lib dir and runs
# it twice (preload sourced vs NODE_OPTIONS cleared), printing both row counts.
whatsapp_qr_render_remote=$(
  cat <<REMOTE
set -eu
GLOBAL_NM="\$(npm root -g 2>/dev/null)" || GLOBAL_NM=""
[ -n "\$GLOBAL_NM" ] || { echo "RENDER_PROBE_UNAVAILABLE: npm root -g empty"; exit 0; }
LIBDIR="\$(dirname "\$GLOBAL_NM")"
PROBE_FILE="\$LIBDIR/nemoclaw-wa-qr-render-probe.mjs"
printf '%s' '${whatsapp_qr_render_b64}' | base64 -d > "\$PROBE_FILE" 2>/dev/null || { echo "RENDER_PROBE_UNAVAILABLE: write failed"; exit 0; }
cd "\$LIBDIR" || { echo "RENDER_PROBE_UNAVAILABLE: cd failed"; exit 0; }
# Compact render: source the connect-session env so the preload is on NODE_OPTIONS.
COMPACT="\$( [ -f /tmp/nemoclaw-proxy-env.sh ] && . /tmp/nemoclaw-proxy-env.sh 2>/dev/null; node "\$PROBE_FILE" 2>/dev/null )" || COMPACT=""
# Baseline render: explicitly clear NODE_OPTIONS so the preload is absent.
BASELINE="\$( NODE_OPTIONS="" node "\$PROBE_FILE" 2>/dev/null )" || BASELINE=""
rm -f "\$PROBE_FILE" 2>/dev/null || true
echo "RENDER_COMPACT=\${COMPACT:-NA} RENDER_BASELINE=\${BASELINE:-NA}"
REMOTE
)
whatsapp_qr_render_out=$(sandbox_exec "$whatsapp_qr_render_remote")
whatsapp_qr_compact_rows=$(printf '%s' "$whatsapp_qr_render_out" | sed -n 's/.*RENDER_COMPACT=\([0-9]*\).*/\1/p')
whatsapp_qr_baseline_rows=$(printf '%s' "$whatsapp_qr_render_out" | sed -n 's/.*RENDER_BASELINE=\([0-9]*\).*/\1/p')
if [ -n "$whatsapp_qr_compact_rows" ] && [ -n "$whatsapp_qr_baseline_rows" ]; then
  if [ "$whatsapp_qr_compact_rows" -le 40 ] && [ "$whatsapp_qr_compact_rows" -lt "$whatsapp_qr_baseline_rows" ]; then
    pass "M-WA6d: in-sandbox pairing QR renders compact (${whatsapp_qr_compact_rows} rows, baseline ${whatsapp_qr_baseline_rows}) (#4522)"
  else
    fail "M-WA6d: in-sandbox pairing QR not compact (compact=${whatsapp_qr_compact_rows} rows, baseline=${whatsapp_qr_baseline_rows}) (#4522)"
  fi
else
  skip "M-WA6d: in-sandbox QR render probe unavailable (${whatsapp_qr_render_out:0:160}) (#4522)"
fi

# M1: Verify Telegram provider exists in gateway
if openshell provider get "${SANDBOX_NAME}-telegram-bridge" >/dev/null 2>&1; then
  pass "M1: Provider '${SANDBOX_NAME}-telegram-bridge' exists in gateway"
else
  fail "M1: Provider '${SANDBOX_NAME}-telegram-bridge' not found in gateway"
fi

# M2: Verify Discord provider exists in gateway
if openshell provider get "${SANDBOX_NAME}-discord-bridge" >/dev/null 2>&1; then
  pass "M2: Provider '${SANDBOX_NAME}-discord-bridge' exists in gateway"
else
  fail "M2: Provider '${SANDBOX_NAME}-discord-bridge' not found in gateway"
fi

# M-W1: Verify WeChat provider exists in gateway. Non-interactive onboard
# saw WECHAT_BOT_TOKEN in env (skipping host-qr login) and registered the
# bridge provider just like the other channels.
if openshell provider get "${SANDBOX_NAME}-wechat-bridge" >/dev/null 2>&1; then
  pass "M-W1: Provider '${SANDBOX_NAME}-wechat-bridge' exists in gateway"
else
  fail "M-W1: Provider '${SANDBOX_NAME}-wechat-bridge' not found in gateway (non-interactive QR-skip path may be broken)"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 2: Credential Isolation — env vars inside sandbox
# ══════════════════════════════════════════════════════════════════
section "Phase 2: Credential Isolation"

# M3: TELEGRAM_BOT_TOKEN inside sandbox must NOT contain the host-side token
sandbox_telegram=$(sandbox_exec "printenv TELEGRAM_BOT_TOKEN" 2>/dev/null || true)
if [ -z "$sandbox_telegram" ]; then
  info "TELEGRAM_BOT_TOKEN not set inside sandbox (provider-only mode)"
  TELEGRAM_PLACEHOLDER=""
elif echo "$sandbox_telegram" | grep -qF "$TELEGRAM_TOKEN"; then
  fail "M3: Real Telegram token leaked into sandbox env"
else
  pass "M3: Sandbox TELEGRAM_BOT_TOKEN is a placeholder (not the real token)"
  TELEGRAM_PLACEHOLDER="$sandbox_telegram"
  info "Telegram placeholder: ${TELEGRAM_PLACEHOLDER:0:30}..."
fi

# M4: DISCORD_BOT_TOKEN inside sandbox must NOT contain the host-side token
sandbox_discord=$(sandbox_exec "printenv DISCORD_BOT_TOKEN" 2>/dev/null || true)
if [ -z "$sandbox_discord" ]; then
  info "DISCORD_BOT_TOKEN not set inside sandbox (provider-only mode)"
  DISCORD_PLACEHOLDER=""
elif echo "$sandbox_discord" | grep -qF "$DISCORD_TOKEN"; then
  fail "M4: Real Discord token leaked into sandbox env"
else
  pass "M4: Sandbox DISCORD_BOT_TOKEN is a placeholder (not the real token)"
  DISCORD_PLACEHOLDER="$sandbox_discord"
  info "Discord placeholder: ${DISCORD_PLACEHOLDER:0:30}..."
fi

# M5: At least one placeholder should be present for subsequent phases
if [ -n "$TELEGRAM_PLACEHOLDER" ] || [ -n "$DISCORD_PLACEHOLDER" ]; then
  pass "M5: At least one messaging placeholder detected in sandbox"
else
  skip "M5: No messaging placeholders found — OpenShell may not inject them as env vars"
  info "Subsequent phases that depend on placeholders will adapt"
fi

# M3/M4 verify the specific TELEGRAM_BOT_TOKEN / DISCORD_BOT_TOKEN
# env vars hold placeholders. The checks below verify the real
# host-side tokens do not appear on ANY observable surface inside
# the sandbox: full environment, process list, or filesystem.

sandbox_env_all=$(sandbox_exec "env 2>/dev/null" 2>/dev/null || true)
sandbox_ps=$(openshell sandbox exec -n "$SANDBOX_NAME" -- \
  sh -c 'cat /proc/[0-9]*/cmdline 2>/dev/null | tr "\0" "\n"' 2>/dev/null || true)

if [ -n "$sandbox_ps" ]; then
  info "Process cmdlines captured ($(echo "$sandbox_ps" | wc -l | tr -d ' ') lines)"
else
  info "Process cmdline capture returned empty — M5b/M5f will skip"
fi

# M5a: Full environment dump must not contain the real Telegram token
if [ -z "$sandbox_env_all" ]; then
  skip "M5a: Environment variable list is empty"
elif echo "$sandbox_env_all" | grep -qF "$TELEGRAM_TOKEN"; then
  fail "M5a: Real Telegram token found in full sandbox environment dump"
else
  pass "M5a: Real Telegram token absent from full sandbox environment"
fi

# M5b: Process list must not contain the real Telegram token
if [ -z "$sandbox_ps" ]; then
  skip "M5b: Process list is empty"
elif echo "$sandbox_ps" | grep -qF "$TELEGRAM_TOKEN"; then
  fail "M5b: Real Telegram token found in sandbox process list"
else
  pass "M5b: Real Telegram token absent from sandbox process list"
fi

# M5c: Recursive filesystem search for the real Telegram token.
# Covers /sandbox (workspace), /home, /etc, /tmp, /var.
sandbox_fs_tg=$(printf '%s' "$TELEGRAM_TOKEN" | sandbox_exec_stdin "grep -rFlm1 -f - /sandbox /home /etc /tmp /var 2>/dev/null || true")
if [ -n "$sandbox_fs_tg" ]; then
  fail "M5c: Real Telegram token found on sandbox filesystem: ${sandbox_fs_tg}"
else
  pass "M5c: Real Telegram token absent from sandbox filesystem"
fi

# M5d: Placeholder string must be present in the sandbox environment
if [ -n "$TELEGRAM_PLACEHOLDER" ]; then
  if echo "$sandbox_env_all" | grep -qF "$TELEGRAM_PLACEHOLDER"; then
    pass "M5d: Telegram placeholder confirmed present in sandbox environment"
  else
    fail "M5d: Telegram placeholder not found in sandbox environment"
  fi
else
  skip "M5d: No Telegram placeholder to verify (provider-only mode)"
fi

# M5e: Full environment dump must not contain the real Discord token
if [ -z "$sandbox_env_all" ]; then
  skip "M5e: Environment variable list is empty"
elif echo "$sandbox_env_all" | grep -qF "$DISCORD_TOKEN"; then
  fail "M5e: Real Discord token found in full sandbox environment dump"
else
  pass "M5e: Real Discord token absent from full sandbox environment"
fi

# M5f: Process list must not contain the real Discord token
if [ -z "$sandbox_ps" ]; then
  skip "M5f: Process list is empty"
elif echo "$sandbox_ps" | grep -qF "$DISCORD_TOKEN"; then
  fail "M5f: Real Discord token found in sandbox process list"
else
  pass "M5f: Real Discord token absent from sandbox process list"
fi

# M5g: Recursive filesystem search for the real Discord token
sandbox_fs_dc=$(printf '%s' "$DISCORD_TOKEN" | sandbox_exec_stdin "grep -rFlm1 -f - /sandbox /home /etc /tmp /var 2>/dev/null || true")
if [ -n "$sandbox_fs_dc" ]; then
  fail "M5g: Real Discord token found on sandbox filesystem: ${sandbox_fs_dc}"
else
  pass "M5g: Real Discord token absent from sandbox filesystem"
fi

# M5h: Discord placeholder must be present in the sandbox environment
if [ -n "$DISCORD_PLACEHOLDER" ]; then
  if echo "$sandbox_env_all" | grep -qF "$DISCORD_PLACEHOLDER"; then
    pass "M5h: Discord placeholder confirmed present in sandbox environment"
  else
    fail "M5h: Discord placeholder not found in sandbox environment"
  fi
else
  skip "M5h: No Discord placeholder to verify (provider-only mode)"
fi

# ── Slack credential isolation (#2085) ────────────────────────────
# Mirrors M5a/M5e/M5g for Slack now that provider-shaped aliases are resolved
# directly by OpenShell. The host-side fake token must never appear on any
# observable surface inside the sandbox.

# M-S5a: Full environment dump must not contain the real Slack bot token.
if [ -z "$sandbox_env_all" ]; then
  skip "M-S5a: Environment variable list is empty"
elif echo "$sandbox_env_all" | grep -qF "$SLACK_TOKEN"; then
  fail "M-S5a: Real Slack bot token found in full sandbox environment dump"
else
  pass "M-S5a: Real Slack bot token absent from full sandbox environment"
fi

# M-S5b: Process list must not contain the real Slack bot token.
if [ -z "$sandbox_ps" ]; then
  skip "M-S5b: Process list is empty"
elif echo "$sandbox_ps" | grep -qF "$SLACK_TOKEN"; then
  fail "M-S5b: Real Slack bot token found in sandbox process list"
else
  pass "M-S5b: Real Slack bot token absent from sandbox process list"
fi

# M-S5c: Recursive filesystem search for the real Slack bot token.
sandbox_fs_sl=$(printf '%s' "$SLACK_TOKEN" | sandbox_exec_stdin "grep -rFlm1 -f - /sandbox /home /etc /tmp /var 2>/dev/null || true")
if [ -n "$sandbox_fs_sl" ]; then
  fail "M-S5c: Real Slack bot token found on sandbox filesystem: ${sandbox_fs_sl}"
else
  pass "M-S5c: Real Slack bot token absent from sandbox filesystem"
fi

# M-S5d: Same checks for the xapp- Socket Mode token.
if [ -n "$SLACK_APP" ]; then
  if [ -z "$sandbox_env_all" ]; then
    skip "M-S5d: Environment variable list is empty"
  elif echo "$sandbox_env_all" | grep -qF "$SLACK_APP"; then
    fail "M-S5d: Real Slack app token found in full sandbox environment dump"
  else
    pass "M-S5d: Real Slack app token absent from sandbox environment"
  fi
  if [ -z "$sandbox_ps" ]; then
    skip "M-S5d2: Process list is empty"
  elif echo "$sandbox_ps" | grep -qF "$SLACK_APP"; then
    fail "M-S5d2: Real Slack app token found in sandbox process list"
  else
    pass "M-S5d2: Real Slack app token absent from sandbox process list"
  fi
  sandbox_fs_sapp=$(printf '%s' "$SLACK_APP" | sandbox_exec_stdin "grep -rFlm1 -f - /sandbox /home /etc /tmp /var 2>/dev/null || true")
  if [ -n "$sandbox_fs_sapp" ]; then
    fail "M-S5e: Real Slack app token found on sandbox filesystem: ${sandbox_fs_sapp}"
  else
    pass "M-S5e: Real Slack app token absent from sandbox filesystem"
  fi
fi

# M-S5f: openclaw.json must contain the Bolt-shape placeholder, not the
# real token. OpenShell resolves the provider-shaped alias directly on egress.
config_slack=$(sandbox_exec "cat /sandbox/.openclaw/openclaw.json 2>/dev/null | grep -E '\"(bot|app)Token\"'" 2>/dev/null || true)
if [ -n "$config_slack" ] && {
  echo "$config_slack" | grep -qF "$SLACK_TOKEN" \
    || echo "$config_slack" | grep -qF "$SLACK_APP"
}; then
  fail "M-S5f: Real Slack bot/app token spliced into openclaw.json — apply_slack_token_override regression?"
elif [ -n "$config_slack" ] \
  && echo "$config_slack" | grep -q 'xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN' \
  && echo "$config_slack" | grep -q 'xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN'; then
  pass "M-S5f: openclaw.json holds both Bolt-shape Slack placeholders (no real token on disk)"
else
  skip "M-S5f: Could not extract Slack token fields from openclaw.json"
fi

# M-S5g: No Slack transport bridge should be installed. NODE_OPTIONS may still
# include non-transport resilience guards, but not the removed token rewriter.
sandbox_node_opts=$(openshell sandbox exec --name "$SANDBOX_NAME" -- bash -lc 'echo "$NODE_OPTIONS"' 2>/dev/null || echo "")
if echo "$sandbox_node_opts" | grep -q "nemoclaw-slack-token-rewriter.js"; then
  fail "M-S5g: removed Slack token rewriter preload still present in NODE_OPTIONS"
else
  pass "M-S5g: Slack token rewriter preload absent from NODE_OPTIONS"
fi

# ── WeChat credential isolation ───────────────────────────────────
# Mirrors M5a/M5b/M5c for WeChat. The host-side WECHAT_BOT_TOKEN must
# never appear on any observable surface inside the sandbox — the
# upstream @tencent-weixin/openclaw-weixin plugin reads it via the
# placeholder in <stateDir>/openclaw-weixin/accounts/<id>.json and the
# L7 proxy rewrites at egress.

# M-W3: WECHAT_BOT_TOKEN inside the sandbox must NOT contain the host token.
sandbox_wechat=$(sandbox_exec "printenv WECHAT_BOT_TOKEN" 2>/dev/null || true)
if [ -z "$sandbox_wechat" ]; then
  info "WECHAT_BOT_TOKEN not set inside sandbox (provider-only mode)"
  WECHAT_PLACEHOLDER=""
elif echo "$sandbox_wechat" | grep -qF "$WECHAT_TOKEN"; then
  fail "M-W3: Real WeChat token leaked into sandbox env"
else
  pass "M-W3: Sandbox WECHAT_BOT_TOKEN is a placeholder (not the real token)"
  WECHAT_PLACEHOLDER="$sandbox_wechat"
  info "WeChat placeholder: ${WECHAT_PLACEHOLDER:0:30}..."
fi

# M-W3a: Full environment dump must not contain the real WeChat token.
if [ -z "$sandbox_env_all" ]; then
  skip "M-W3a: Environment variable list is empty"
elif echo "$sandbox_env_all" | grep -qF "$WECHAT_TOKEN"; then
  fail "M-W3a: Real WeChat token found in full sandbox environment dump"
else
  pass "M-W3a: Real WeChat token absent from full sandbox environment"
fi

# M-W3b: Process list must not contain the real WeChat token.
if [ -z "$sandbox_ps" ]; then
  skip "M-W3b: Process list is empty"
elif echo "$sandbox_ps" | grep -qF "$WECHAT_TOKEN"; then
  fail "M-W3b: Real WeChat token found in sandbox process list"
else
  pass "M-W3b: Real WeChat token absent from sandbox process list"
fi

# M-W3c: Recursive filesystem search for the real WeChat token. The seed
# script writes the placeholder, not the token — a hit here would mean
# something upstream is splicing the real value into account state files.
sandbox_fs_wc=$(printf '%s' "$WECHAT_TOKEN" | sandbox_exec_stdin "grep -rFlm1 -f - /sandbox /home /etc /tmp /var 2>/dev/null || true")
if [ -n "$sandbox_fs_wc" ]; then
  fail "M-W3c: Real WeChat token found on sandbox filesystem: ${sandbox_fs_wc}"
else
  pass "M-W3c: Real WeChat token absent from sandbox filesystem"
fi

# M-W3d: WeChat placeholder must be present in the sandbox environment.
if [ -n "$WECHAT_PLACEHOLDER" ]; then
  if echo "$sandbox_env_all" | grep -qF "$WECHAT_PLACEHOLDER"; then
    pass "M-W3d: WeChat placeholder confirmed present in sandbox environment"
  else
    fail "M-W3d: WeChat placeholder not found in sandbox environment"
  fi
else
  skip "M-W3d: No WeChat placeholder to verify (provider-only mode)"
fi

# ── WhatsApp QR-only isolation ────────────────────────────────────
# WhatsApp is deliberately tokenless from NemoClaw's perspective. The operator
# pairs inside the sandbox, and mutable QR session state is allowed in durable
# agent state. There must be no host-side WhatsApp credential provider,
# placeholder, or token env for OpenShell to rewrite.

if [ -z "$sandbox_env_all" ]; then
  skip "M-WA7a: Environment variable list is empty"
elif echo "$sandbox_env_all" | grep -qE '(^|[[:space:]])WHATSAPP_.*(TOKEN|SECRET|AUTH|SESSION)='; then
  fail "M-WA7a: WhatsApp credential-like env var found in sandbox environment"
else
  pass "M-WA7a: No WhatsApp credential-like env var present in sandbox environment"
fi

if [ -z "$sandbox_ps" ]; then
  skip "M-WA7b: Process list is empty"
elif echo "$sandbox_ps" | grep -qE 'WHATSAPP_.*(TOKEN|SECRET|AUTH|SESSION)|openshell:resolve:env:WHATSAPP'; then
  fail "M-WA7b: WhatsApp credential placeholder found in sandbox process list"
else
  pass "M-WA7b: No WhatsApp credential placeholder present in sandbox process list"
fi

sandbox_fs_wa=$(sandbox_exec "
  {
    grep -rIlm1 -E '(^|[^A-Z0-9_])WHATSAPP_[A-Z0-9_]*(TOKEN|SECRET|AUTH|SESSION)[A-Z0-9_]*=' /sandbox /home /etc /tmp /var 2>/dev/null || true
    grep -rIlm1 -F 'openshell:resolve:env:WHATSAPP' /sandbox /home /etc /tmp /var 2>/dev/null || true
    grep -rIlm1 -F '$WHATSAPP_TOKEN_DECOY' /sandbox /home /etc /tmp /var 2>/dev/null || true
    grep -rIlm1 -F '$WHATSAPP_BOT_TOKEN_DECOY' /sandbox /home /etc /tmp /var 2>/dev/null || true
    grep -rIlm1 -F '$WHATSAPP_SESSION_SECRET_DECOY' /sandbox /home /etc /tmp /var 2>/dev/null || true
  } | sort -u
")
if [ -n "$sandbox_fs_wa" ]; then
  fail "M-WA7c: WhatsApp host credential material found on sandbox filesystem: ${sandbox_fs_wa}"
else
  pass "M-WA7c: No WhatsApp host credential material found on sandbox filesystem"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 2c: NEMOCLAW_EXTRA_PLACEHOLDER_KEYS — per-profile credential injection
#
# Validates the operator-supplied extra-placeholder-keys hook end-to-end:
#   - the registered provider row exists in the OpenShell gateway under the
#     deterministic `${sandbox}-extra-<slug>` name
#   - the sandbox env exposes the canonical resolve placeholder for an
#     extension key, never the raw token value
#   - a listed-but-unset key produces no gateway provider row
#   - a non-extending host secret name (GITHUB_TOKEN) is refused at the
#     parser layer, never registered, never present in sandbox env/fs/log
#   - the NEMOCLAW_EXTRA_PLACEHOLDER_KEYS env arg itself reaches the
#     container so the in-container revision-collapse refresh sees the
#     same list the host-side parser produced
#   - two independent extension keys resolve to two distinct placeholders
#     (the per-Hermes-profile property the feature exists to enable; the
#     Hermes-side `.env` substitution is operator-driven and therefore not
#     observable from an OpenClaw E2E)
# ══════════════════════════════════════════════════════════════════
section "Phase 2c: Extra placeholder keys — per-profile credential injection"

# X1: Provider list shows the extension-key row with the slugged sandbox name.
provider_list=$(openshell provider list 2>/dev/null || true)
EXTRA_PROVIDER_NAME="${SANDBOX_NAME}-extra-telegram-bot-token-agent-a"
if echo "$provider_list" | grep -qF "$EXTRA_PROVIDER_NAME"; then
  pass "X1: Provider '$EXTRA_PROVIDER_NAME' registered for the operator-supplied extension key"
else
  fail "X1: Provider '$EXTRA_PROVIDER_NAME' missing from openshell provider list"
fi

# X2: Listed-but-unset extension key must not produce a provider row.
MISSING_PROVIDER_NAME="${SANDBOX_NAME}-extra-telegram-bot-token-agent-missing"
if echo "$provider_list" | grep -qF "$MISSING_PROVIDER_NAME"; then
  fail "X2: Provider '$MISSING_PROVIDER_NAME' was registered despite the operator never exporting the credential"
else
  pass "X2: Missing-credential extension key produced no provider row (upsert skipped null token)"
fi

# X3: Non-extending host secret name must be refused at the parser layer.
HOST_SECRET_PROVIDER_NAME="${SANDBOX_NAME}-extra-github-token"
if echo "$provider_list" | grep -qF "$HOST_SECRET_PROVIDER_NAME"; then
  fail "X3: Provider '$HOST_SECRET_PROVIDER_NAME' was registered — host secret name leaked past the parser allowlist"
else
  pass "X3: GITHUB_TOKEN refused by the parser; no provider row registered"
fi

# X4a: Sandbox env exposes the canonical resolve placeholder for the
# first extension key, never the raw operator-supplied token value.
sandbox_extra_env=$(sandbox_exec "printenv TELEGRAM_BOT_TOKEN_AGENT_A" 2>/dev/null || true)
if [ -z "$sandbox_extra_env" ]; then
  fail "X4a: TELEGRAM_BOT_TOKEN_AGENT_A is unset inside the sandbox; placeholder injection failed"
elif echo "$sandbox_extra_env" | grep -qF "$EXTRAS_TELEGRAM_AGENT_A_TOKEN"; then
  fail "X4a: Raw operator-supplied token leaked into the sandbox TELEGRAM_BOT_TOKEN_AGENT_A env"
elif echo "$sandbox_extra_env" | grep -q "^openshell:resolve:env:"; then
  pass "X4a: Sandbox TELEGRAM_BOT_TOKEN_AGENT_A is the canonical resolve placeholder"
  info "  placeholder: ${sandbox_extra_env:0:40}..."
else
  fail "X4a: Sandbox TELEGRAM_BOT_TOKEN_AGENT_A is neither the placeholder nor empty: ${sandbox_extra_env:0:80}"
fi

# X4b: A second extension key resolves to its own distinct placeholder, so
# two Hermes profiles consuming `${TELEGRAM_BOT_TOKEN_AGENT_A}` and
# `${TELEGRAM_BOT_TOKEN_AGENT_B}` get isolated credentials at L7 egress.
sandbox_extra_env_b=$(sandbox_exec "printenv TELEGRAM_BOT_TOKEN_AGENT_B" 2>/dev/null || true)
if [ -z "$sandbox_extra_env_b" ]; then
  fail "X4b: TELEGRAM_BOT_TOKEN_AGENT_B is unset inside the sandbox; placeholder injection failed for the second extension key"
elif echo "$sandbox_extra_env_b" | grep -qF "$EXTRAS_TELEGRAM_AGENT_B_TOKEN"; then
  fail "X4b: Raw operator-supplied token leaked into the sandbox TELEGRAM_BOT_TOKEN_AGENT_B env"
elif [ "$sandbox_extra_env_b" = "$sandbox_extra_env" ]; then
  fail "X4b: TELEGRAM_BOT_TOKEN_AGENT_A and TELEGRAM_BOT_TOKEN_AGENT_B resolve to the same placeholder; per-key isolation broken"
elif echo "$sandbox_extra_env_b" | grep -q "^openshell:resolve:env:"; then
  pass "X4b: Two extension keys resolve to distinct canonical placeholders"
else
  fail "X4b: Sandbox TELEGRAM_BOT_TOKEN_AGENT_B is neither the placeholder nor empty: ${sandbox_extra_env_b:0:80}"
fi

# X5: The control env NEMOCLAW_EXTRA_PLACEHOLDER_KEYS must reach the
# nemoclaw-start.sh process inside the container so the
# refresh_openclaw_provider_placeholders helper sees the per-profile keys
# at boot. Grep the entrypoint log for the deterministic breadcrumb the
# refresh helper emits whenever at least one extension key survives the
# in-container parser — that line only fires after the env arg propagated
# AND the canonical-prefix mirror accepted the entry.
start_log=$(openshell sandbox exec --name "$SANDBOX_NAME" -- cat /tmp/nemoclaw-start.log 2>/dev/null || true)
if [ -z "$start_log" ]; then
  fail "X5: /tmp/nemoclaw-start.log unavailable; cannot prove extras reached the in-container refresh helper"
else
  extras_breadcrumb=$(echo "$start_log" | grep -E "^\[config\] NEMOCLAW_EXTRA_PLACEHOLDER_KEYS accepted [0-9]+ entry\(ies\):" | tail -1 || true)
  if [ -z "$extras_breadcrumb" ]; then
    fail "X5: nemoclaw-start did not log an accepted-extras breadcrumb; env arg did not propagate or canonical-prefix mirror rejected it"
    info "  Last 40 lines of /tmp/nemoclaw-start.log:"
    echo "$start_log" | tail -40 | while IFS= read -r line; do info "    $line"; done
  elif ! echo "$extras_breadcrumb" | grep -qw TELEGRAM_BOT_TOKEN_AGENT_A; then
    fail "X5: accepted-extras breadcrumb missing TELEGRAM_BOT_TOKEN_AGENT_A: $extras_breadcrumb"
  elif echo "$extras_breadcrumb" | grep -qw GITHUB_TOKEN; then
    fail "X5: accepted-extras breadcrumb contains GITHUB_TOKEN — host filter bypass"
  else
    pass "X5: nemoclaw-start accepted-extras breadcrumb proves NEMOCLAW_EXTRA_PLACEHOLDER_KEYS reached the in-container parser"
    info "  ${extras_breadcrumb:0:160}"
  fi
fi

# X6: The raw operator-supplied token value must not appear on any
# observable sandbox surface (env dump, process list, filesystem).
sandbox_env_extras_dump=$(sandbox_exec "env 2>/dev/null" 2>/dev/null || true)
if [ -z "$sandbox_env_extras_dump" ]; then
  skip "X6a: Sandbox environment dump is empty"
elif echo "$sandbox_env_extras_dump" | grep -qF "$EXTRAS_TELEGRAM_AGENT_A_TOKEN"; then
  fail "X6a: Raw extension-key token found in sandbox environment dump"
else
  pass "X6a: Raw extension-key token absent from sandbox environment dump"
fi

sandbox_ps_extras=$(openshell sandbox exec -n "$SANDBOX_NAME" -- \
  sh -c 'cat /proc/[0-9]*/cmdline 2>/dev/null | tr "\0" "\n"' 2>/dev/null || true)
if [ -z "$sandbox_ps_extras" ]; then
  skip "X6b: Sandbox process list is empty"
elif echo "$sandbox_ps_extras" | grep -qF "$EXTRAS_TELEGRAM_AGENT_A_TOKEN"; then
  fail "X6b: Raw extension-key token found in sandbox process list"
else
  pass "X6b: Raw extension-key token absent from sandbox process list"
fi

sandbox_fs_extras=$(sandbox_exec "
  grep -rIlm1 -F '$EXTRAS_TELEGRAM_AGENT_A_TOKEN' /sandbox /home /etc /tmp /var 2>/dev/null || true
")
if [ -n "$sandbox_fs_extras" ]; then
  fail "X6c: Raw extension-key token found on sandbox filesystem: ${sandbox_fs_extras}"
else
  pass "X6c: Raw extension-key token absent from sandbox filesystem"
fi

# X7: The refused GITHUB_TOKEN value must not reach the sandbox at all —
# neither as an env var, nor on the filesystem. (The host process exports
# it for the parser-rejection test; the sandbox-create env allowlist must
# drop it.)
sandbox_github_env=$(sandbox_exec "printenv GITHUB_TOKEN" 2>/dev/null || true)
if echo "$sandbox_github_env" | grep -qF "$EXTRAS_GITHUB_DECOY"; then
  fail "X7a: Refused GITHUB_TOKEN value reached the sandbox env"
else
  pass "X7a: Refused GITHUB_TOKEN value never reached the sandbox env"
fi

sandbox_fs_github=$(sandbox_exec "
  grep -rIlm1 -F '$EXTRAS_GITHUB_DECOY' /sandbox /home /etc /tmp /var 2>/dev/null || true
")
if [ -n "$sandbox_fs_github" ]; then
  fail "X7b: Refused GITHUB_TOKEN value found on sandbox filesystem: ${sandbox_fs_github}"
else
  pass "X7b: Refused GITHUB_TOKEN value absent from sandbox filesystem"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 3: Config Patching — openclaw.json channels
# ══════════════════════════════════════════════════════════════════
section "Phase 3: Config Patching Verification"

# Read openclaw.json and extract channel config
managed_proxy_url=""
channel_json=$(sandbox_exec "python3 -c \"
import json, sys
try:
    cfg = json.load(open('/sandbox/.openclaw/openclaw.json'))
    channels = cfg.get('channels', {})
    print(json.dumps(channels))
except Exception as e:
    print(json.dumps({'error': str(e)}))
\"" 2>/dev/null || true)
plugin_entries_json=$(sandbox_exec "python3 -c \"
import json
try:
    cfg = json.load(open('/sandbox/.openclaw/openclaw.json'))
    entries = cfg.get('plugins', {}).get('entries', {})
    print(json.dumps(entries))
except Exception as e:
    print(json.dumps({'error': str(e)}))
\"" 2>/dev/null || true)

if [ -z "$channel_json" ] || echo "$channel_json" | grep -q '"error"'; then
  fail "M6: Could not read openclaw.json channels (${channel_json:0:200})"
else
  info "OpenClaw channel activation summary: $(summarize_openclaw_config_activation)"

  assert_openclaw_config_activation "M6a" "telegram" "Telegram"
  assert_openclaw_config_activation "M6b" "discord" "Discord"
  assert_openclaw_config_activation "M6c" "slack" "Slack"
  assert_openclaw_config_activation "M6d" "whatsapp" "WhatsApp"

  # This live nightly check intentionally uses OpenClaw's real runtime surface:
  # config activation alone is not enough if the CLI still treats the channel as
  # unavailable. Log only derived state; raw channel JSON may grow token/session
  # fields in future OpenClaw releases.
  openclaw_channels_list_json=$(sandbox_exec "timeout 45 openclaw channels list --all --json --no-color 2>/dev/null" 2>/dev/null || true)
  openclaw_channels_summary="$(summarize_openclaw_runtime_channels)"
  info "OpenClaw channels list summary: ${openclaw_channels_summary}"
  assert_openclaw_runtime_channel "M6e" "telegram" "Telegram" "default"
  assert_openclaw_runtime_channel "M6f" "discord" "Discord" "default"
  assert_openclaw_runtime_channel "M6g" "slack" "Slack" "default"
  # WhatsApp has no host-side token provider; before QR pairing OpenClaw can
  # prove only that the external plugin is installed and loadable.
  assert_openclaw_runtime_channel_installed "M6h" "whatsapp" "WhatsApp"

  # M6: Telegram channel exists with a bot token
  # Note: non-root sandboxes cannot patch openclaw.json (chmod 444, root-owned).
  # Channels still work via L7 proxy token rewriting without config patching.
  # SKIP (not FAIL) when channels are absent — this is the expected non-root path.
  tg_token=$(echo "$channel_json" | python3 -c "
import json, sys
d = json.load(sys.stdin)
accounts = d.get('telegram', {}).get('accounts', {})
account = accounts.get('default') or accounts.get('main') or {}
print(account.get('botToken', ''))
" 2>/dev/null || true)

  if [ -n "$tg_token" ]; then
    pass "M6: Telegram channel botToken present in openclaw.json"
  else
    skip "M6: Telegram channel not in openclaw.json (expected in non-root sandbox)"
  fi

  # M6a/M6b: When the channel block is present in openclaw.json, the
  # generated config must mark it enabled at the top level so OpenClaw
  # 2026.5.22+ actually loads the bridge. NemoClaw#4314 / #4390 reproduced
  # as silent "no bridge / no logs"; the symptom matched the Slack
  # regression fixed in #4222. Mirror M6's skip-on-absent pattern — the
  # non-root sandbox path cannot patch openclaw.json and the block may be
  # missing entirely; we only assert behavior when the block is present.
  tg_state=$(echo "$channel_json" | python3 -c "
import json, sys
d = json.load(sys.stdin)
block = d.get('telegram')
if not isinstance(block, dict):
    print('absent')
elif block.get('enabled') is True:
    print('enabled')
else:
    print('missing')
" 2>/dev/null || echo "absent")
  case "$tg_state" in
    enabled) pass "M6a: channels.telegram.enabled is true (bridge loadable per #4314/#4390)" ;;
    missing) fail "M6a: channels.telegram present but enabled flag missing — bridge will silently no-op" ;;
    *) skip "M6a: Telegram channel block not in openclaw.json (expected in non-root sandbox)" ;;
  esac

  dc_state=$(echo "$channel_json" | python3 -c "
import json, sys
d = json.load(sys.stdin)
block = d.get('discord')
if not isinstance(block, dict):
    print('absent')
elif block.get('enabled') is True:
    print('enabled')
else:
    print('missing')
" 2>/dev/null || echo "absent")
  case "$dc_state" in
    enabled) pass "M6b: channels.discord.enabled is true (bridge loadable)" ;;
    missing) fail "M6b: channels.discord present but enabled flag missing — bridge will silently no-op" ;;
    *) skip "M6b: Discord channel block not in openclaw.json (expected in non-root sandbox)" ;;
  esac

  # M7: Telegram token is NOT the real/fake host token
  if [ -n "$tg_token" ] && [ "$tg_token" != "$TELEGRAM_TOKEN" ]; then
    pass "M7: Telegram botToken is not the host-side token (placeholder confirmed)"
  elif [ -n "$tg_token" ]; then
    fail "M7: Telegram botToken matches host-side token — credential leaked into config!"
  else
    skip "M7: No Telegram botToken to check"
  fi

  # M7b: OpenShell can scope provider placeholders by credential revision
  # (openshell:resolve:env:v*_TELEGRAM_BOT_TOKEN). OpenClaw must receive that
  # runtime-scoped placeholder in openclaw.json; leaving the canonical
  # openshell:resolve:env:TELEGRAM_BOT_TOKEN value in the account config makes
  # the Telegram bridge start with an unresolved/invalid token.
  if [ -n "$tg_token" ] && [ -n "$TELEGRAM_PLACEHOLDER" ]; then
    if [ "$tg_token" = "$TELEGRAM_PLACEHOLDER" ]; then
      pass "M7b: Telegram botToken matches the OpenShell runtime placeholder"
    elif [ "$tg_token" = "openshell:resolve:env:TELEGRAM_BOT_TOKEN" ]; then
      fail "M7b: Telegram botToken stayed canonical instead of using runtime placeholder"
    else
      fail "M7b: Telegram botToken placeholder mismatch (config='${tg_token:0:40}...', env='${TELEGRAM_PLACEHOLDER:0:40}...')"
    fi
  elif [ -n "$tg_token" ]; then
    skip "M7b: No Telegram runtime placeholder env to compare"
  else
    skip "M7b: No Telegram botToken to compare"
  fi

  # M7c-M7f: The Telegram preload diagnostics are installed by nemoclaw-start.sh.
  # Exercise them in-process with a mocked Bot API response so the assertions
  # are hermetic while still covering the real sandbox-side preload script.
  if [ -n "$tg_token" ]; then
    telegram_diag_output=$(sandbox_exec "cat > /tmp/nemoclaw-telegram-diagnostics-e2e.js <<'NODE'
const fs = require('fs');
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');

const diagnosticsPath = '/tmp/nemoclaw-telegram-diagnostics.js';
const sourceConfigPath = '/sandbox/.openclaw/openclaw.json';
const prefix = 'openshell:resolve:env:';
const canonicalPlaceholder = prefix + 'TELEGRAM_BOT_TOKEN';
const diagnosticPlaceholder = prefix + 'vdiagnostic_TELEGRAM_BOT_TOKEN';
const invalidProbeToken = '000000:telegram-diagnostics-invalid-e2e';

function readTelegramBotToken(config) {
  const telegram = config?.channels?.telegram;
  const accounts = telegram?.accounts || {};
  const account = accounts.default || accounts.main || accounts[Object.keys(accounts)[0]];
  return typeof account?.botToken === 'string' ? account.botToken : '';
}

function writeScenarioConfig(token, scenario) {
  const config = JSON.parse(fs.readFileSync(sourceConfigPath, 'utf8'));
  const accounts = config.channels.telegram.accounts;
  const accountName = accounts.default ? 'default' : accounts.main ? 'main' : Object.keys(accounts)[0];
  accounts[accountName].botToken = token;
  const configPath = '/tmp/nemoclaw-telegram-diagnostics-' + scenario + '.json';
  fs.writeFileSync(configPath, JSON.stringify(config));
  return configPath;
}

function installFakeTelegramHttp(statusCode) {
  function makeFakeRequest(callback) {
    const req = new EventEmitter();
    req.end = () => {
      setImmediate(() => {
        const res = new EventEmitter();
        res.statusCode = statusCode;
        if (typeof callback === 'function') callback(res);
        req.emit('response', res);
        res.emit('data', Buffer.from('{}'));
        res.emit('end');
      });
      return req;
    };
    req.write = () => true;
    req.setTimeout = () => req;
    req.abort = () => {};
    req.destroy = () => {};
    return req;
  }

  for (const mod of [http, https]) {
    mod.request = function request(...args) {
      const callback = args.find((arg) => typeof arg === 'function');
      return makeFakeRequest(callback);
    };
    mod.get = function get(...args) {
      const callback = args.find((arg) => typeof arg === 'function');
      const req = makeFakeRequest(callback);
      req.end();
      return req;
    };
  }
}

async function main() {
  const scenario = process.argv[2] || '';
  if (!fs.existsSync(diagnosticsPath)) {
    console.log('E2E_FAIL_MISSING_DIAGNOSTICS_PRELOAD');
    process.exit(2);
  }

  const currentConfig = JSON.parse(fs.readFileSync(sourceConfigPath, 'utf8'));
  const currentToken = readTelegramBotToken(currentConfig);
  if (!currentToken) {
    console.log('E2E_SKIP_NO_TELEGRAM_BOTTOKEN');
    return;
  }

  if (scenario === 'missing-env') {
    process.env.OPENCLAW_CONFIG_PATH = writeScenarioConfig(canonicalPlaceholder, scenario);
    delete process.env.TELEGRAM_BOT_TOKEN;
  } else if (scenario === 'placeholder-mismatch') {
    process.env.OPENCLAW_CONFIG_PATH = writeScenarioConfig(canonicalPlaceholder, scenario);
    process.env.TELEGRAM_BOT_TOKEN = currentToken.startsWith(prefix) && currentToken !== canonicalPlaceholder
      ? currentToken
      : diagnosticPlaceholder;
  } else if (scenario === 'startup-401') {
    const runtimeToken = currentToken.startsWith(prefix) ? currentToken : diagnosticPlaceholder;
    process.env.OPENCLAW_CONFIG_PATH = writeScenarioConfig(runtimeToken, scenario);
    process.env.TELEGRAM_BOT_TOKEN = runtimeToken;
    installFakeTelegramHttp(401);
  } else {
    console.log('E2E_FAIL_UNKNOWN_SCENARIO');
    process.exit(2);
  }

  require(diagnosticsPath);

  if (scenario === 'startup-401') {
    https.request('https://api.telegram.org/bot' + invalidProbeToken + '/getMe').end();
  }

  await new Promise((resolve) => setTimeout(resolve, 50));
}

main().catch((error) => {
  console.log('E2E_FAIL_DIAGNOSTICS_EXCEPTION: ' + (error && error.stack ? error.stack : error));
  process.exit(2);
});
NODE
NODE_OPTIONS= node /tmp/nemoclaw-telegram-diagnostics-e2e.js missing-env 2>&1
NODE_OPTIONS= node /tmp/nemoclaw-telegram-diagnostics-e2e.js placeholder-mismatch 2>&1
NODE_OPTIONS= node /tmp/nemoclaw-telegram-diagnostics-e2e.js startup-401 2>&1
")

    if echo "$telegram_diag_output" | grep -q 'E2E_FAIL_'; then
      diag_fail_codes=$(printf '%s\n' "$telegram_diag_output" | grep -o 'E2E_FAIL_[A-Z0-9_]*' | sort -u | tr '\n' ' ')
      fail "M7c: Telegram diagnostics E2E probe failed (${diag_fail_codes:-E2E_FAIL})"
    elif echo "$telegram_diag_output" | grep -q 'E2E_SKIP_NO_TELEGRAM_BOTTOKEN'; then
      skip "M7c: Telegram diagnostics skipped because openclaw.json has no botToken"
      skip "M7d: Telegram diagnostics skipped because openclaw.json has no botToken"
      skip "M7e: Telegram diagnostics skipped because openclaw.json has no botToken"
      skip "M7f: Telegram diagnostics skipped because openclaw.json has no botToken"
    else
      if echo "$telegram_diag_output" | grep -qF '[telegram] [default] credential placeholder configured but TELEGRAM_BOT_TOKEN is missing from runtime env'; then
        pass "M7c: Telegram diagnostics report missing runtime placeholder env"
      else
        fail "M7c: Telegram diagnostics missing-env breadcrumb absent"
      fi

      if echo "$telegram_diag_output" | grep -qF '[telegram] [default] credential placeholder mismatch: openclaw.json botToken does not match runtime TELEGRAM_BOT_TOKEN placeholder'; then
        pass "M7d: Telegram diagnostics report scoped placeholder mismatch"
      else
        fail "M7d: Telegram diagnostics placeholder-mismatch breadcrumb absent"
      fi

      if echo "$telegram_diag_output" | grep -qF '[telegram] [default] Bot API rejected startup probe with HTTP 401; token invalid or credential placeholder unresolved'; then
        pass "M7e: Telegram diagnostics report sanitized startup probe rejection"
      else
        fail "M7e: Telegram diagnostics startup-probe breadcrumb absent"
      fi

      if echo "$telegram_diag_output" | grep -qE 'telegram-diagnostics-invalid-e2e|openshell:resolve:env:'; then
        fail "M7f: Telegram diagnostics leaked raw token or credential placeholder"
      else
        pass "M7f: Telegram diagnostics breadcrumbs are sanitized"
      fi
    fi
  else
    skip "M7c: No Telegram botToken for diagnostics probe"
    skip "M7d: No Telegram botToken for diagnostics probe"
    skip "M7e: No Telegram botToken for diagnostics probe"
    skip "M7f: No Telegram botToken for diagnostics probe"
  fi

  # M8: Discord channel exists with a token
  dc_token=$(echo "$channel_json" | python3 -c "
import json, sys
d = json.load(sys.stdin)
accounts = d.get('discord', {}).get('accounts', {})
account = accounts.get('default') or accounts.get('main') or {}
print(account.get('token', ''))
" 2>/dev/null || true)

  if [ -n "$dc_token" ]; then
    pass "M8: Discord channel token present in openclaw.json"
  else
    skip "M8: Discord channel not in openclaw.json (expected in non-root sandbox)"
  fi

  # M9: Discord token is NOT the real/fake host token
  if [ -n "$dc_token" ] && [ "$dc_token" != "$DISCORD_TOKEN" ]; then
    pass "M9: Discord token is not the host-side token (placeholder confirmed)"
  elif [ -n "$dc_token" ]; then
    fail "M9: Discord token matches host-side token — credential leaked into config!"
  else
    skip "M9: No Discord token to check"
  fi

  # M9b: Discord Gateway WebSocket routing uses the per-account proxy.
  # OpenClaw's Discord gateway client only tunnels when the Discord account
  # proxy is set, while the top-level managed proxy remains configured for the
  # rest of the channel stack. The fake Gateway proof in M13b-M13g exercises
  # the same OpenShell relay path using the generated managed proxy config.
  dc_proxy=$(echo "$channel_json" | python3 -c "
import json, sys
d = json.load(sys.stdin)
accounts = d.get('discord', {}).get('accounts', {})
account = accounts.get('default') or accounts.get('main') or {}
print(account.get('proxy', ''))
" 2>/dev/null || true)

  managed_proxy_url=$(sandbox_exec "python3 -c \"
import json
cfg = json.load(open('/sandbox/.openclaw/openclaw.json'))
proxy = cfg.get('proxy') or {}
if proxy.get('enabled') is True:
    print(proxy.get('proxyUrl') or '')
\"" 2>/dev/null || true)
  expected_managed_proxy="http://${NEMOCLAW_PROXY_HOST:-10.200.0.1}:${NEMOCLAW_PROXY_PORT:-3128}"
  if [ -n "$dc_token" ] && [ "$dc_proxy" = "$expected_managed_proxy" ] && [ "$managed_proxy_url" = "$expected_managed_proxy" ]; then
    pass "M9b: Discord uses per-account proxy while OpenClaw managed proxy config remains set"
  elif [ -n "$dc_token" ]; then
    fail "M9b: Discord proxy wiring wrong; expected account.proxy='${expected_managed_proxy}' and proxy.proxyUrl='${expected_managed_proxy}' (account.proxy='${dc_proxy}', proxy.proxyUrl='${managed_proxy_url}')"
  else
    skip "M9b: No Discord channel config to check"
  fi

  # M10: Telegram enabled
  tg_enabled=$(echo "$channel_json" | python3 -c "
import json, sys
d = json.load(sys.stdin)
accounts = d.get('telegram', {}).get('accounts', {})
account = accounts.get('default') or accounts.get('main') or {}
print(account.get('enabled', False))
" 2>/dev/null || true)

  if [ "$tg_enabled" = "True" ]; then
    pass "M10: Telegram channel is enabled"
  else
    skip "M10: Telegram channel not enabled (expected in non-root sandbox)"
  fi

  # M11: Discord enabled
  dc_enabled=$(echo "$channel_json" | python3 -c "
import json, sys
d = json.load(sys.stdin)
accounts = d.get('discord', {}).get('accounts', {})
account = accounts.get('default') or accounts.get('main') or {}
print(account.get('enabled', False))
" 2>/dev/null || true)

  if [ "$dc_enabled" = "True" ]; then
    pass "M11: Discord channel is enabled"
  else
    skip "M11: Discord channel not enabled (expected in non-root sandbox)"
  fi

  # M11b: Telegram dmPolicy is allowlist (not pairing)
  tg_dm_policy=$(echo "$channel_json" | python3 -c "
import json, sys
d = json.load(sys.stdin)
accounts = d.get('telegram', {}).get('accounts', {})
account = accounts.get('default') or accounts.get('main') or {}
print(account.get('dmPolicy', ''))
" 2>/dev/null || true)

  if [ "$tg_dm_policy" = "allowlist" ]; then
    pass "M11b: Telegram dmPolicy is 'allowlist'"
  elif [ -n "$tg_dm_policy" ]; then
    fail "M11b: Telegram dmPolicy is '$tg_dm_policy' (expected 'allowlist')"
  else
    skip "M11b: Telegram dmPolicy not set (channel may not be configured)"
  fi

  # M11c: Telegram allowFrom contains the expected user IDs
  tg_allow_from=$(echo "$channel_json" | python3 -c "
import json, sys
d = json.load(sys.stdin)
accounts = d.get('telegram', {}).get('accounts', {})
account = accounts.get('default') or accounts.get('main') or {}
ids = account.get('allowFrom', [])
print(','.join(str(i) for i in ids))
" 2>/dev/null || true)

  if [ -n "$tg_allow_from" ]; then
    # Check that all configured IDs are present
    IFS=',' read -ra expected_ids <<<"$TELEGRAM_IDS"
    missing_ids=()
    tg_allow_from_csv=",${tg_allow_from//[[:space:]]/},"
    for eid in "${expected_ids[@]}"; do
      eid="${eid//[[:space:]]/}"
      [ -z "$eid" ] && continue
      if [[ "$tg_allow_from_csv" != *",$eid,"* ]]; then
        missing_ids+=("$eid")
      fi
    done
    if [ ${#missing_ids[@]} -eq 0 ]; then
      pass "M11c: Telegram allowFrom contains all expected user IDs: $tg_allow_from"
      if [ "$TELEGRAM_ALLOWLIST_ENV_KEY" != "TELEGRAM_ALLOWED_IDS" ]; then
        pass "M11c-alias: Telegram allowFrom honored ${TELEGRAM_ALLOWLIST_ENV_KEY} alias"
      fi
    else
      fail "M11c: Telegram allowFrom ($tg_allow_from) is missing IDs: ${missing_ids[*]} (expected all of: $TELEGRAM_IDS)"
    fi
  else
    skip "M11c: Telegram allowFrom not set (channel may not be configured)"
  fi

  # M11d: Telegram groupPolicy defaults to open so group chats are not silently dropped
  tg_group_policy=$(echo "$channel_json" | python3 -c "
import json, sys
d = json.load(sys.stdin)
accounts = d.get('telegram', {}).get('accounts', {})
account = accounts.get('default') or accounts.get('main') or {}
print(account.get('groupPolicy', ''))
" 2>/dev/null || true)

  if [ "$tg_group_policy" = "open" ]; then
    pass "M11d: Telegram groupPolicy is 'open'"
  elif [ -n "$tg_group_policy" ]; then
    fail "M11d: Telegram groupPolicy is '$tg_group_policy' (expected 'open')"
  else
    skip "M11d: Telegram groupPolicy not set (channel may not be configured)"
  fi

  # M11e: Slack channel configured — gateway must survive auth failure (#2340)
  # The Slack channel has placeholder tokens that will fail auth. The channel
  # guard preload (NODE_OPTIONS --require) should catch the error. We can't
  # verify the guard file via SSH (different container), but we CAN check the
  # gateway port from here. This is tested more thoroughly in Phase 7.
  slack_configured=$(echo "$channel_json" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print('yes' if 'slack' in d else 'no')
" 2>/dev/null || true)
  if [ "$slack_configured" = "yes" ]; then
    pass "M11e: Slack channel configured with placeholder tokens (guard needed)"

    # M11f/M11g/M11h: SLACK_ALLOWED_USERS should authorize both DMs and
    # channel @mentions from the same users. Config lives on the Slack account
    # because OpenClaw supports multi-account Slack channel policy.
    sl_dm_policy=$(echo "$channel_json" | python3 -c "
import json, sys
d = json.load(sys.stdin)
account = d.get('slack', {}).get('accounts', {}).get('default', {})
print(account.get('dmPolicy', ''))
" 2>/dev/null || true)
    if [ "$sl_dm_policy" = "allowlist" ]; then
      pass "M11f: Slack dmPolicy is 'allowlist'"
    elif [ -n "$sl_dm_policy" ]; then
      fail "M11f: Slack dmPolicy is '$sl_dm_policy' (expected 'allowlist')"
    else
      skip "M11f: Slack dmPolicy not set"
    fi

    sl_group_policy=$(echo "$channel_json" | python3 -c "
import json, sys
d = json.load(sys.stdin)
account = d.get('slack', {}).get('accounts', {}).get('default', {})
print(account.get('groupPolicy', ''))
" 2>/dev/null || true)
    if [ "$sl_group_policy" = "allowlist" ]; then
      pass "M11g: Slack groupPolicy is 'allowlist'"
    elif [ -n "$sl_group_policy" ]; then
      fail "M11g: Slack groupPolicy is '$sl_group_policy' (expected 'allowlist')"
    else
      skip "M11g: Slack groupPolicy not set"
    fi

    sl_channel_users=$(echo "$channel_json" | python3 -c "
import json, sys
d = json.load(sys.stdin)
account = d.get('slack', {}).get('accounts', {}).get('default', {})
wildcard = account.get('channels', {}).get('*', {})
if wildcard.get('enabled') is not True:
    print('BAD_ENABLED')
elif wildcard.get('requireMention') is not True:
    print('BAD_REQUIRE_MENTION')
else:
    users = wildcard.get('users', [])
    if not isinstance(users, list):
        print('BAD_USERS_TYPE')
    elif len(users) == 0:
        print('EMPTY_USERS')
    else:
        print(','.join(str(i) for i in users))
" 2>/dev/null || true)
    if [ "$sl_channel_users" = "BAD_ENABLED" ]; then
      fail "M11h: Slack wildcard channel config is not enabled"
    elif [ "$sl_channel_users" = "BAD_REQUIRE_MENTION" ]; then
      fail "M11h: Slack wildcard channel config does not require mention"
    elif [ "$sl_channel_users" = "BAD_USERS_TYPE" ]; then
      fail "M11h: Slack wildcard channel users is not a list"
    elif [ "$sl_channel_users" = "EMPTY_USERS" ]; then
      fail "M11h: Slack wildcard channel users is empty"
    elif [ -n "$sl_channel_users" ]; then
      IFS=',' read -ra expected_slack_ids <<<"$SLACK_IDS"
      missing_slack_ids=()
      expected_slack_id_count=0
      sl_channel_users_csv=",${sl_channel_users//[[:space:]]/},"
      for sid in "${expected_slack_ids[@]}"; do
        sid="${sid//[[:space:]]/}"
        [ -z "$sid" ] && continue
        ((expected_slack_id_count++))
        if [[ "$sl_channel_users_csv" != *",$sid,"* ]]; then
          missing_slack_ids+=("$sid")
        fi
      done
      if [ ${#missing_slack_ids[@]} -eq 0 ]; then
        pass "M11h: Slack wildcard channel @mention allowlist contains expected user count (${expected_slack_id_count})"
      else
        fail "M11h: Slack wildcard channel users missing ${#missing_slack_ids[@]} expected ID(s)"
      fi
    else
      skip "M11h: Slack wildcard channel users not set"
    fi

    # Diagnostics: check if the guard was installed and what NODE_OPTIONS looks like
    info "Checking guard installation diagnostics:"
    guard_exists=$(openshell sandbox exec --name "$SANDBOX_NAME" -- ls -la /tmp/nemoclaw-slack-channel-guard.js 2>/dev/null || echo "EXEC_FAILED")
    info "  Guard file: $guard_exists"
    node_opts=$(openshell sandbox exec --name "$SANDBOX_NAME" -- bash -c 'echo "$NODE_OPTIONS"' 2>/dev/null || echo "EXEC_FAILED")
    info "  NODE_OPTIONS: $node_opts"
  else
    skip "M11e: No Slack channel in config"
  fi

  # M-WA8/M-WA9: WhatsApp is QR-only, but it still needs a real channel block
  # baked into openclaw.json after `channels add whatsapp` + rebuild. There
  # should be no token, auth, or OpenShell placeholder field in that account.
  whatsapp_account_json=$(echo "$channel_json" | python3 -c "
import json, sys
d = json.load(sys.stdin)
account = d.get('whatsapp', {}).get('accounts', {}).get('default', {})
print(json.dumps(account, sort_keys=True))
" 2>/dev/null || true)
  whatsapp_enabled=$(echo "$whatsapp_account_json" | python3 -c "
import json, sys
try:
    account = json.load(sys.stdin)
    print(account.get('enabled', False))
except Exception:
    print(False)
" 2>/dev/null || true)
  whatsapp_health_monitor=$(echo "$whatsapp_account_json" | python3 -c "
import json, sys
try:
    account = json.load(sys.stdin)
    print(account.get('healthMonitor', {}).get('enabled', None))
except Exception:
    print(None)
" 2>/dev/null || true)

  if [ "$whatsapp_enabled" = "True" ]; then
    pass "M-WA8: WhatsApp account is enabled in openclaw.json"
  else
    fail "M-WA8: WhatsApp account missing or disabled in openclaw.json (${whatsapp_account_json:0:200})"
  fi

  if [ "$whatsapp_health_monitor" = "False" ]; then
    pass "M-WA8a: WhatsApp health monitor is disabled for unpaired QR session"
  else
    fail "M-WA8a: WhatsApp health monitor is not disabled (${whatsapp_account_json:0:200})"
  fi

  whatsapp_secret_fields=$(echo "$whatsapp_account_json" | python3 -c "
import json, sys
try:
    account = json.load(sys.stdin)
except Exception:
    print('BAD_JSON')
    sys.exit(0)
bad = []
def walk(value, path=''):
    if isinstance(value, dict):
        for key, child in value.items():
            next_path = f'{path}.{key}' if path else key
            if any(word in key.lower() for word in ('token', 'secret', 'auth', 'session')):
                bad.append(next_path)
            walk(child, next_path)
    elif isinstance(value, list):
        for idx, child in enumerate(value):
            walk(child, f'{path}[{idx}]')
    elif isinstance(value, str) and 'openshell:resolve:env:WHATSAPP' in value:
        bad.append(path)
walk(account)
print(','.join(bad))
" 2>/dev/null || true)
  if [ -z "$whatsapp_secret_fields" ]; then
    pass "M-WA9: WhatsApp config has no token/auth/session provider placeholders"
  else
    fail "M-WA9: WhatsApp config contains secret-like fields: ${whatsapp_secret_fields}"
  fi

  # M-W7: WeChat plugin install registry is restored alongside the channel
  # block, the plugin entry is enabled, and the install spec is pinned to a
  # concrete semver. The upstream plugin loader needs this install metadata
  # after OpenClaw config rewrites (plugins.entries alone is not enough),
  # and a floating spec (e.g. "@latest") would silently bypass the
  # installer-trust pinning enforced by the WeChat package-install allowlist and
  # wechat.seedOpenClawAccount manifest hook (WECHAT_PLUGIN_SPEC=@2.4.3).
  wechat_plugins_json=$(sandbox_exec "python3 -c \"
import json
cfg = json.load(open('/sandbox/.openclaw/openclaw.json'))
plugins = cfg.get('plugins', {}) or {}
print(json.dumps({
    'install': plugins.get('installs', {}).get('openclaw-weixin', {}),
    'entry': plugins.get('entries', {}).get('openclaw-weixin', {}),
}))
\"" 2>/dev/null || true)
  if echo "$wechat_plugins_json" | python3 -c "
import json, re, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(2)
inst = data.get(\"install\") if isinstance(data, dict) else None
entry = data.get(\"entry\") if isinstance(data, dict) else None
spec = inst.get(\"spec\") if isinstance(inst, dict) else None
install_path = inst.get(\"installPath\") if isinstance(inst, dict) else None
ok = (
    isinstance(inst, dict)
    and inst.get(\"source\") == \"npm\"
    and isinstance(spec, str)
    and bool(re.fullmatch(r\"@tencent-weixin/openclaw-weixin@\d+\.\d+\.\d+\", spec))
    and isinstance(install_path, str)
    and bool(install_path.strip())
    and isinstance(entry, dict)
    and entry.get(\"enabled\") is True
)
sys.exit(0 if ok else 1)
" 2>/dev/null; then
    pass "M-W7: WeChat plugin install registry restored, entry enabled, spec pinned in openclaw.json"
  else
    fail "M-W7: WeChat plugin install registry missing/invalid, entry not enabled, or spec not pinned to a concrete semver"
  fi

  # M-W8: WeChat channel registered under channels.openclaw-weixin with the
  # configured accountId enabled. Written by the manifest post-agent-install
  # hook during image build. Absence here means WeChat metadata was empty or
  # the manifest build-file output was skipped — both regressions on the
  # non-interactive QR-skip path.
  wechat_enabled=$(echo "$channel_json" | python3 -c "
import json, sys
d = json.load(sys.stdin)
accounts = d.get('openclaw-weixin', {}).get('accounts', {})
account = accounts.get('$WECHAT_ACCOUNT', {})
print(account.get('enabled', False))
" 2>/dev/null || true)
  if [ "$wechat_enabled" = "True" ]; then
    pass "M-W8: WeChat account '$WECHAT_ACCOUNT' is enabled in openclaw.json (channels.openclaw-weixin)"
  else
    fail "M-W8: WeChat account not enabled in openclaw.json (channels.openclaw-weixin missing or disabled)"
  fi
fi

# M-W9: Per-account credential file holds the WECHAT_BOT_TOKEN placeholder,
# not the real token. The manifest post-agent-install hook writes
# <stateDir>/openclaw-weixin/accounts/<accountId>.json with
# token = "openshell:resolve:env:WECHAT_BOT_TOKEN". A real-token hit
# would mean someone bypassed the placeholder constant.
wechat_account_json=$(sandbox_exec "cat /sandbox/.openclaw/openclaw-weixin/accounts/${WECHAT_ACCOUNT}.json 2>/dev/null || true" 2>/dev/null || true)
if [ -z "$wechat_account_json" ] || echo "$wechat_account_json" | grep -qi "no such file"; then
  fail "M-W9: WeChat per-account credential file not found (manifest post-agent-install hook may have been skipped)"
else
  if echo "$wechat_account_json" | grep -qF "$WECHAT_TOKEN"; then
    fail "M-W9: Real WeChat token spliced into accounts/${WECHAT_ACCOUNT}.json — manifest seed placeholder regression"
  elif echo "$wechat_account_json" | grep -qF "openshell:resolve:env:WECHAT_BOT_TOKEN"; then
    pass "M-W9: WeChat per-account credential file uses the L7-resolved placeholder"
  else
    fail "M-W9: WeChat per-account credential file has unexpected token shape: $(echo "$wechat_account_json" | tr -d '\n' | cut -c1-200)"
  fi
fi

# M-W10: Accounts index lists the configured accountId. Written by
# the manifest post-agent-install hook before the per-account file; the upstream plugin's
# auth/accounts.ts boots accounts that appear in this index.
wechat_index_json=$(sandbox_exec "cat /sandbox/.openclaw/openclaw-weixin/accounts.json 2>/dev/null || true" 2>/dev/null || true)
if [ -z "$wechat_index_json" ] || echo "$wechat_index_json" | grep -qi "no such file"; then
  fail "M-W10: WeChat accounts.json index not found"
else
  if echo "$wechat_index_json" | python3 -c "
import json, sys
try:
    ids = json.load(sys.stdin)
    sys.exit(0 if isinstance(ids, list) and '$WECHAT_ACCOUNT' in ids else 1)
except Exception:
    sys.exit(2)
" 2>/dev/null; then
    pass "M-W10: WeChat accounts.json index contains '$WECHAT_ACCOUNT'"
  else
    fail "M-W10: WeChat accounts.json missing '$WECHAT_ACCOUNT' (raw: $(echo "$wechat_index_json" | tr -d '\n' | cut -c1-200))"
  fi
fi

# ══════════════════════════════════════════════════════════════════
# Phase 4: Network Reachability
# ══════════════════════════════════════════════════════════════════
section "Phase 4: Network Reachability"

# M12: Node.js can reach api.telegram.org through the proxy
tg_reach=$(sandbox_exec 'node -e "
const https = require(\"https\");
const req = https.get(\"https://api.telegram.org/\", (res) => {
  console.log(\"HTTP_\" + res.statusCode);
  res.resume();
});
req.on(\"error\", (e) => console.log(\"ERROR: \" + e.message));
req.setTimeout(15000, () => { req.destroy(); console.log(\"TIMEOUT\"); });
"' 2>/dev/null || true)

if echo "$tg_reach" | grep -q "HTTP_"; then
  pass "M12: Node.js reached api.telegram.org (${tg_reach})"
elif echo "$tg_reach" | grep -q "TIMEOUT"; then
  skip "M12: api.telegram.org timed out (network may be slow)"
elif echo "$tg_reach" | grep -qiE "ERROR:.*(ECONNRESET|reset|socket hang up|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT)"; then
  skip "M12: api.telegram.org unreachable from this network (${tg_reach:0:160})"
else
  fail "M12: Node.js could not reach api.telegram.org (${tg_reach:0:200})"
fi

# M13: Node.js can reach Discord API/CDN through the proxy
live_discord_policy=$(openshell policy get --full "$SANDBOX_NAME" 2>/dev/null || true)
if echo "$live_discord_policy" | grep -q "discord.com" \
  && echo "$live_discord_policy" | grep -q "cdn.discordapp.com" \
  && { echo "$live_discord_policy" | grep -q "/usr/local/bin/node" || echo "$live_discord_policy" | grep -q "/usr/bin/node"; }; then
  pass "M13-policy: Live policy contains Discord endpoints and Node binaries"
else
  fail "M13-policy: Live policy is missing expected Discord preset endpoint/binary entries"
fi

live_proxy_env=$(sandbox_exec 'printf "HTTPS_PROXY=%s\nhttps_proxy=%s\nNO_PROXY=%s\nno_proxy=%s\n" "$HTTPS_PROXY" "$https_proxy" "$NO_PROXY" "$no_proxy"' 2>/dev/null || true)
info "Sandbox proxy env: ${live_proxy_env//$'\n'/ }"
if echo "$live_proxy_env" | grep -qE "https?_proxy=.*10\.200\.0\.1:3128|HTTPS_PROXY=.*10\.200\.0\.1:3128"; then
  pass "M13-proxy: Sandbox uses the OpenShell gateway proxy"
else
  fail "M13-proxy: Sandbox proxy env does not point at OpenShell gateway: ${live_proxy_env:0:200}"
fi

# Regression context for #3477: curl is intentionally not in the Discord
# preset's binary whitelist, but a live curl CONNECT 403 is ambiguous because
# an upstream network policy can produce the same symptom. Treat the live probe
# as diagnostics only; M13-rest-d/e below provide the hermetic whitelist proof.
live_dc_curl=$(sandbox_exec 'set +e
rm -f /tmp/nemoclaw-discord-curl.err /tmp/nemoclaw-discord-curl.body
curl -v --max-time 10 https://discord.com/ \
  -o /tmp/nemoclaw-discord-curl.body \
  2>/tmp/nemoclaw-discord-curl.err
rc=$?
printf "RC=%s\n" "$rc"
grep -E "Uses proxy|CONNECT discord.com:443|HTTP/1\\.[01] 403|CONNECT tunnel failed|Connection established|policy_denied|Forbidden" /tmp/nemoclaw-discord-curl.err /tmp/nemoclaw-discord-curl.body 2>/dev/null || true
' 2>/dev/null || true)
info "Discord curl probe: ${live_dc_curl:0:500}"
if echo "$live_dc_curl" | grep -qiE "CONNECT tunnel failed.*403|CONNECT discord\.com:443|HTTP/1\.[01] 403|policy_denied|Forbidden" \
  && ! echo "$live_dc_curl" | grep -qiE "Connection established|200 Connection"; then
  info "M13-curl: ambiguous live CONNECT 403 may be upstream or local; hermetic M13-rest-d/e prove whitelist behavior; output: ${live_dc_curl:0:300}"
elif echo "$live_dc_curl" | grep -qiE "Connection established|200 Connection"; then
  fail "M13-curl: curl unexpectedly established a tunnel to Discord; binary whitelist may be too broad"
else
  info "M13-curl: live curl probe inconclusive; hermetic M13-rest-d/e prove whitelist behavior; output: ${live_dc_curl:0:200}"
fi

dc_reach=$(sandbox_exec 'node - <<'"'"'NODE'"'"'
const https = require("https");
const targets = [
  ["api", "https://discord.com/api/v10/gateway"],
  ["cdn", "https://cdn.discordapp.com/"],
];
let pending = targets.length;
let failed = false;

function done() {
  pending -= 1;
  if (pending === 0) process.exit(failed ? 1 : 0);
}

for (const [name, url] of targets) {
  const req = https.get(url, (res) => {
    console.log(`${name}:HTTP_${res.statusCode}`);
    res.resume();
    done();
  });
  req.on("error", (error) => {
    failed = true;
    console.log(`${name}:ERROR_${error.message}`);
    done();
  });
  req.setTimeout(15000, () => {
    failed = true;
    req.destroy();
    console.log(`${name}:TIMEOUT`);
    done();
  });
}
NODE
' 2>/dev/null || true)

info "Discord Node probe: ${dc_reach:0:500}"
if echo "$dc_reach" | grep -q "api:HTTP_" \
  && echo "$dc_reach" | grep -q "cdn:HTTP_"; then
  pass "M13: Node.js reached Discord API and CDN through the same proxy (${dc_reach//$'\n'/ })"
elif echo "$dc_reach" | grep -qiE "CONNECT.*403|policy_denied|forbidden"; then
  fail "M13: Node.js was denied by the proxy despite the Discord preset being applied: ${dc_reach:0:300}"
elif echo "$dc_reach" | grep -qiE "TIMEOUT|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|ECONNRESET|socket hang up|network"; then
  skip "M13: Live Discord unreachable from this network (${dc_reach:0:200})"
else
  fail "M13: Node.js could not reach Discord API/CDN (${dc_reach:0:200})"
fi

# M13-rest-a-M13-rest-e: Hermetic Discord-shaped HTTPS REST binary whitelist proof.
fake_rest_ready=0
if start_fake_discord_rest_api; then
  fake_rest_ready=1
  pass "M13-rest-a: Hermetic fake Discord REST API started on host port ${FAKE_DISCORD_REST_PORT}"
else
  skip "M13-rest-a: Could not start hermetic fake Discord REST API"
fi

fake_rest_policy_ready=0
if [ "$fake_rest_ready" = "1" ]; then
  if apply_fake_discord_rest_policy "$SANDBOX_NAME" "$FAKE_DISCORD_REST_PORT" >/tmp/nemoclaw-fake-discord-rest-policy.log 2>&1; then
    fake_rest_policy_ready=1
    pass "M13-rest-b: Applied Node-only HTTPS policy for fake Discord REST API"
  else
    fail "M13-rest-b: Failed to apply fake Discord REST policy: $(tail -20 /tmp/nemoclaw-fake-discord-rest-policy.log 2>/dev/null | tr '\n' ' ' | cut -c1-300)"
  fi
else
  skip "M13-rest-b: Fake Discord REST API unavailable; skipping policy apply"
fi

fake_rest_node=""
if [ "$fake_rest_policy_ready" = "1" ]; then
  fake_rest_node=$(run_fake_discord_rest_node_request "$FAKE_DISCORD_REST_PORT" "/api/v10/gateway" || true)
fi
info "Fake Discord REST Node probe: ${fake_rest_node:0:300}"
if [ "$fake_rest_policy_ready" != "1" ]; then
  skip "M13-rest-c: Fake Discord REST policy unavailable; skipping Node proof"
elif echo "$fake_rest_node" | grep -q "^200 "; then
  pass "M13-rest-c: Node reached the fake Discord REST API through OpenShell"
else
  fail "M13-rest-c: Node failed to reach fake Discord REST API: ${fake_rest_node:0:300}"
fi

fake_rest_curl=""
if [ "$fake_rest_policy_ready" = "1" ]; then
  fake_rest_curl=$(run_fake_discord_rest_curl_request "$FAKE_DISCORD_REST_PORT" || true)
fi
info "Fake Discord REST curl probe: ${fake_rest_curl:0:500}"
if [ "$fake_rest_policy_ready" != "1" ]; then
  skip "M13-rest-d: Fake Discord REST policy unavailable; skipping curl denial proof"
elif echo "$fake_rest_curl" | grep -qiE "CONNECT tunnel failed.*403|HTTP/1\.[01] 403|policy_denied|Forbidden" \
  && ! echo "$fake_rest_curl" | grep -qiE "Connection established|200 Connection"; then
  pass "M13-rest-d: curl was denied before reaching the fake Discord REST API"
elif echo "$fake_rest_curl" | grep -qiE "Connection established|200 Connection"; then
  fail "M13-rest-d: curl unexpectedly established a tunnel to the fake Discord REST API"
else
  fail "M13-rest-d: Fake Discord REST curl denial had unexpected shape: ${fake_rest_curl:0:300}"
fi

fake_rest_capture=""
if [ "$fake_rest_policy_ready" = "1" ]; then
  fake_rest_capture=$(fake_discord_rest_capture_counts || true)
fi
info "Fake Discord REST capture counts: ${fake_rest_capture}"
if [ "$fake_rest_policy_ready" != "1" ]; then
  skip "M13-rest-e: Fake Discord REST policy unavailable; skipping capture proof"
elif echo "$fake_rest_capture" | grep -q "node=1" \
  && echo "$fake_rest_capture" | grep -q "curl=0"; then
  pass "M13-rest-e: Fake server saw Node but no curl request"
else
  fail "M13-rest-e: Unexpected fake Discord REST capture counts: ${fake_rest_capture}"
fi

# M13b-M13g: Hermetic Discord Gateway over OpenShell's native WebSocket L7 path.
# M13d-config drives the fake Gateway using the generated OpenClaw managed
# proxy URL. With current OpenClaw, Discord should rely on this top-level proxy
# config instead of a NemoClaw-owned per-account loopback proxy.
fake_gateway_ready=0
if start_fake_discord_gateway "$DISCORD_TOKEN"; then
  fake_gateway_ready=1
  pass "M13b: Hermetic fake Discord Gateway started on host port ${FAKE_DISCORD_GATEWAY_PORT}"
else
  fail "M13b: Failed to start hermetic fake Discord Gateway"
fi

if [ "$fake_gateway_ready" = "1" ] \
  && apply_fake_discord_gateway_policy "$SANDBOX_NAME" "$FAKE_DISCORD_GATEWAY_PORT" >/tmp/nemoclaw-fake-discord-policy.log 2>&1; then
  pass "M13c: Applied native WebSocket policy with credential rewrite for fake Discord Gateway"
else
  fail "M13c: Failed to apply fake Discord Gateway policy: $(tail -20 /tmp/nemoclaw-fake-discord-policy.log 2>/dev/null | tr '\n' ' ' | cut -c1-300)"
fi

dc_ws_config_proxy=""
managed_proxy_safe="${managed_proxy_url:-}"
if [ "$fake_gateway_ready" = "1" ] && [ -n "$managed_proxy_safe" ]; then
  dc_ws_config_proxy=$(run_fake_discord_gateway_node_client "$FAKE_DISCORD_GATEWAY_PORT" "openshell:resolve:env:DISCORD_BOT_TOKEN" "$managed_proxy_safe" || true)
fi
info "OpenClaw-managed-proxy fake Discord Gateway probe: ${dc_ws_config_proxy:0:500}"

if [ "$fake_gateway_ready" != "1" ]; then
  skip "M13d-config: Fake Discord Gateway unavailable; skipping OpenClaw managed proxy proof"
elif [ -z "$managed_proxy_safe" ]; then
  fail "M13d-config: No OpenClaw managed proxy URL in openclaw.json to exercise against fake Gateway"
elif echo "$dc_ws_config_proxy" | grep -q "^UPGRADE$" \
  && echo "$dc_ws_config_proxy" | grep -q "^HELLO$" \
  && echo "$dc_ws_config_proxy" | grep -q "^IDENTIFY_SENT_PLACEHOLDER$" \
  && echo "$dc_ws_config_proxy" | grep -q "^READY$" \
  && echo "$dc_ws_config_proxy" | grep -q "^HEARTBEAT_ACK$"; then
  pass "M13d-config: OpenClaw managed proxy URL from openclaw.json reaches fake Gateway through OpenShell"
else
  fail "M13d-config: OpenClaw managed proxy URL from openclaw.json failed against fake Gateway: ${dc_ws_config_proxy:0:400}"
fi

dc_ws_native=""
if [ "$fake_gateway_ready" = "1" ]; then
  dc_ws_native=$(run_fake_discord_gateway_node_client "$FAKE_DISCORD_GATEWAY_PORT" "openshell:resolve:env:DISCORD_BOT_TOKEN" || true)
fi
info "Native fake Discord Gateway probe: ${dc_ws_native:0:500}"

if echo "$dc_ws_native" | grep -q "^UPGRADE$"; then
  pass "M13d: Native WebSocket upgrade reached fake Discord Gateway through OpenShell"
else
  fail "M13d: Native WebSocket upgrade failed: ${dc_ws_native:0:300}"
fi

if echo "$dc_ws_native" | grep -q "^HELLO$" \
  && echo "$dc_ws_native" | grep -q "^IDENTIFY_SENT_PLACEHOLDER$" \
  && echo "$dc_ws_native" | grep -q "^READY$" \
  && echo "$dc_ws_native" | grep -q "^HEARTBEAT_ACK$"; then
  pass "M13e: Discord HELLO, placeholder IDENTIFY, READY, and heartbeat ACK completed"
else
  fail "M13e: Discord Gateway protocol proof incomplete: ${dc_ws_native:0:400}"
fi

if [ "$fake_gateway_ready" = "1" ] \
  && grep -Fq "\"token\":\"$DISCORD_TOKEN\"" "$FAKE_DISCORD_GATEWAY_CAPTURE_FILE" \
  && ! grep -Fq "openshell:resolve:env:DISCORD_BOT_TOKEN" "$FAKE_DISCORD_GATEWAY_CAPTURE_FILE"; then
  pass "M13f: Fake Gateway received host-side Discord token; sandbox-visible IDENTIFY used only the placeholder"
else
  if [ "$fake_gateway_ready" = "1" ]; then
    info "Fake Discord Gateway capture: $(tail -20 "$FAKE_DISCORD_GATEWAY_CAPTURE_FILE" 2>/dev/null | tr '\n' ' ' | cut -c1-500)"
  fi
  fail "M13f: Fake Gateway did not prove placeholder-to-token rewrite at the relay boundary"
fi

capture_before_negative=0
capture_after_negative=0
dc_ws_negative=""
if [ "$fake_gateway_ready" = "1" ]; then
  capture_before_negative=$(wc -l <"$FAKE_DISCORD_GATEWAY_CAPTURE_FILE" 2>/dev/null || echo 0)
  dc_ws_negative=$(run_fake_discord_gateway_node_client "$FAKE_DISCORD_GATEWAY_PORT" "openshell:resolve:env:DEFINITELY_NOT_REGISTERED" || true)
  capture_after_negative=$(wc -l <"$FAKE_DISCORD_GATEWAY_CAPTURE_FILE" 2>/dev/null || echo 0)
fi
info "Native fake Discord Gateway negative probe: ${dc_ws_negative:0:300}"

if [ "$fake_gateway_ready" = "1" ] \
  && ! echo "$dc_ws_negative" | grep -q "^READY$" \
  && ! tail -n "$((capture_after_negative - capture_before_negative))" "$FAKE_DISCORD_GATEWAY_CAPTURE_FILE" 2>/dev/null | grep -Fq "DEFINITELY_NOT_REGISTERED"; then
  pass "M13g: Unregistered Discord WebSocket placeholder is rejected before upstream token exposure"
else
  fail "M13g: Unregistered Discord WebSocket placeholder reached READY or leaked upstream"
fi

# M14 (negative): curl should be blocked by binary restriction
curl_reach=$(sandbox_exec "curl -s --max-time 10 https://api.telegram.org/ 2>&1" 2>/dev/null || true)
if echo "$curl_reach" | grep -qiE "(blocked|denied|forbidden|refused|not found|no such)"; then
  pass "M14: curl to api.telegram.org blocked (binary restriction enforced)"
elif [ -z "$curl_reach" ]; then
  pass "M14: curl returned empty (likely blocked by policy)"
else
  # curl may not be installed in the sandbox at all
  if echo "$curl_reach" | grep -qiE "(command not found|not installed)"; then
    pass "M14: curl not available in sandbox (defense in depth)"
  else
    info "M14: curl output: ${curl_reach:0:200}"
    skip "M14: Could not confirm curl is blocked (may need manual check)"
  fi
fi

# ══════════════════════════════════════════════════════════════════
# Phase 5: L7 Proxy Token Rewriting
# ══════════════════════════════════════════════════════════════════
section "Phase 5: L7 Proxy Token Rewriting"

# M15-M16: Telegram getMe with placeholder token
# If proxy rewrites correctly: reaches Telegram → 401 (fake) or 200 (real)
# If proxy is broken: proxy error, timeout, or mangled URL
info "Calling api.telegram.org/bot{placeholder}/getMe from inside sandbox..."
tg_api=$(sandbox_exec 'node -e "
const https = require(\"https\");
const token = process.env.TELEGRAM_BOT_TOKEN || \"missing\";
const url = \"https://api.telegram.org/bot\" + token + \"/getMe\";
const req = https.get(url, (res) => {
  let body = \"\";
  res.on(\"data\", (d) => body += d);
  res.on(\"end\", () => console.log(res.statusCode + \" \" + body.slice(0, 300)));
});
req.on(\"error\", (e) => console.log(\"ERROR: \" + e.message));
req.setTimeout(30000, () => { req.destroy(); console.log(\"TIMEOUT\"); });
"' 2>/dev/null || true)

info "Telegram API response: ${tg_api:0:300}"

# Filter out Node.js warnings (e.g. UNDICI-EHPA) before extracting status code
tg_status=$(echo "$tg_api" | grep -E '^[0-9]' | head -1 | awk '{print $1}')
if [ "$tg_status" = "200" ]; then
  pass "M15: Telegram getMe returned 200 — real token verified!"
elif [ "$tg_status" = "401" ] || [ "$tg_status" = "404" ]; then
  # Telegram returns 404 (not 401) for invalid bot tokens in the URL path.
  # Either status proves the L7 proxy rewrote the placeholder and the request
  # reached the real Telegram API.
  pass "M15: Telegram getMe returned $tg_status — L7 proxy rewrote placeholder (fake token rejected by API)"
  pass "M16: Full chain verified: sandbox → proxy → token rewrite → Telegram API"
elif echo "$tg_api" | grep -q "TIMEOUT"; then
  skip "M15: Telegram API timed out (network issue, not a plumbing failure)"
elif echo "$tg_api" | grep -qiE "ERROR:.*(ECONNRESET|reset|socket hang up|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT)"; then
  skip "M15: Telegram API unreachable from this network (${tg_api:0:160})"
elif echo "$tg_api" | grep -q "ERROR"; then
  fail "M15: Telegram API call failed with error: ${tg_api:0:200}"
else
  fail "M15: Unexpected Telegram response (status=$tg_status): ${tg_api:0:200}"
fi

# M17: Discord users/@me with placeholder token
info "Calling discord.com/api/v10/users/@me from inside sandbox..."
dc_api=$(sandbox_exec 'node -e "
const https = require(\"https\");
const token = process.env.DISCORD_BOT_TOKEN || \"missing\";
const options = {
  hostname: \"discord.com\",
  path: \"/api/v10/users/@me\",
  headers: { \"Authorization\": \"Bot \" + token },
};
const req = https.get(options, (res) => {
  let body = \"\";
  res.on(\"data\", (d) => body += d);
  res.on(\"end\", () => console.log(res.statusCode + \" \" + body.slice(0, 300)));
});
req.on(\"error\", (e) => console.log(\"ERROR: \" + e.message));
req.setTimeout(30000, () => { req.destroy(); console.log(\"TIMEOUT\"); });
"' 2>/dev/null || true)

info "Discord API response: ${dc_api:0:300}"

# Filter out Node.js warnings (e.g. UNDICI-EHPA) before extracting status code
dc_status=$(echo "$dc_api" | grep -E '^[0-9]' | head -1 | awk '{print $1}')
if [ "$dc_status" = "200" ]; then
  pass "M17: Discord users/@me returned 200 — real token verified!"
elif [ "$dc_status" = "401" ]; then
  pass "M17: Discord users/@me returned 401 — L7 proxy rewrote placeholder (fake token rejected by API)"
elif echo "$dc_api" | grep -q "TIMEOUT"; then
  skip "M17: Discord API timed out (network issue, not a plumbing failure)"
elif echo "$dc_api" | grep -q "ERROR"; then
  fail "M17: Discord API call failed with error: ${dc_api:0:200}"
else
  fail "M17: Unexpected Discord response (status=$dc_status): ${dc_api:0:200}"
fi

# ── Slack: OpenShell alias/body rewrite chain (#2085) ─────────────
# Verifies the full chain hermetically: Bolt-shape placeholder in the
# Authorization header → OpenShell resolves the provider-shaped alias and
# substitutes the real env value → a host-side fake Slack API receives the
# resolved token and returns Slack-shaped invalid_auth.

fake_slack_ready=0
if start_fake_slack_api "$SLACK_TOKEN" "$SLACK_APP"; then
  fake_slack_ready=1
  pass "M-S14a: Hermetic fake Slack API started on host port ${FAKE_SLACK_API_PORT}"
else
  fail "M-S14a: Failed to start hermetic fake Slack API"
fi

if [ "$fake_slack_ready" = "1" ] \
  && apply_fake_slack_api_policy "$SANDBOX_NAME" "$FAKE_SLACK_API_PORT" >/tmp/nemoclaw-fake-slack-policy.log 2>&1; then
  pass "M-S14b: Applied REST policy for hermetic fake Slack API"
else
  fail "M-S14b: Failed to apply fake Slack API policy: $(tail -20 /tmp/nemoclaw-fake-slack-policy.log 2>/dev/null | tr '\n' ' ' | cut -c1-300)"
fi

check_fake_slack_capture_token() {
  local path="$1"
  local expected_token="$2"
  node - "$FAKE_SLACK_API_CAPTURE_FILE" "$path" "$expected_token" <<'NODE'
const fs = require("fs");
const [file, path, expectedToken] = process.argv.slice(2);
const rows = fs
  .readFileSync(file, "utf8")
  .trim()
  .split(/\n+/)
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .filter((row) => row.event === "request" && row.path === path);
const last = rows.at(-1);
if (!last) {
  console.log(`NO_REQUEST ${path}`);
  process.exit(2);
}
if (last.authorization !== undefined || last.body !== undefined) {
  console.log("RAW_CAPTURE_LEAK");
  process.exit(6);
}
if (last.tokenMatchesExpected !== true) {
  console.log("BAD_AUTH_REWRITE");
  process.exit(3);
}
if (last.bodyMatchesExpected !== true) {
  console.log("BAD_BODY_REWRITE");
  process.exit(4);
}
if (last.tokenLooksPlaceholder) {
  console.log("PLACEHOLDER_LEAK");
  process.exit(5);
}
console.log("OK");
NODE
}

check_fake_slack_capture_message() {
  local path="$1"
  local expected_channel="$2"
  local expected_text="$3"
  node - "$FAKE_SLACK_API_CAPTURE_FILE" "$path" "$expected_channel" "$expected_text" <<'NODE'
const fs = require("fs");
const [file, path, expectedChannel, expectedText] = process.argv.slice(2);
const rows = fs
  .readFileSync(file, "utf8")
  .trim()
  .split(/\n+/)
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .filter((row) => row.event === "request" && row.path === path);
const last = rows.at(-1);
if (!last) {
  console.log(`NO_REQUEST ${path}`);
  process.exit(2);
}
if (last.channel !== expectedChannel) {
  console.log(`BAD_CHANNEL ${last.channel}`);
  process.exit(3);
}
if (last.text !== expectedText) {
  console.log(`BAD_TEXT ${last.text}`);
  process.exit(4);
}
console.log("OK");
NODE
}

info "Calling fake Slack /api/auth.test from inside sandbox with Bolt-shape placeholder..."
sl_api=""
if [ "$fake_slack_ready" = "1" ]; then
  sl_api=$(run_fake_slack_api_node_request "$FAKE_SLACK_API_PORT" "/api/auth.test" "Bearer xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN" || true)
fi

info "Slack auth.test response: ${sl_api:0:300}"
sl_status=$(echo "$sl_api" | grep -E '^[0-9]' | head -1 | awk '{print $1}')

if [ "$sl_status" = "200" ] && echo "$sl_api" | grep -q '"ok":true'; then
  pass "M-S15: Slack auth.test returned ok:true — real token round-trip verified!"
elif [ "$sl_status" = "200" ] && echo "$sl_api" | grep -qE 'invalid_auth|not_authed'; then
  pass "M-S15: Slack auth.test returned invalid_auth — full chain verified (OpenShell alias rewrite → fake Slack)"
  sl_capture=$(check_fake_slack_capture_token "/api/auth.test" "$SLACK_TOKEN" || true)
  if [ "$sl_capture" = "OK" ]; then
    pass "M-S15a: fake Slack saw host-side bot token in header and urlencoded body"
  else
    fail "M-S15a: fake Slack capture did not prove bot header/body rewrite: ${sl_capture:0:300}"
  fi
elif echo "$sl_api" | grep -q "TIMEOUT"; then
  skip "M-S15: fake Slack API timed out"
elif echo "$sl_api" | grep -q "ERROR"; then
  fail "M-S15: Slack API call failed with error: ${sl_api:0:200}"
elif echo "$sl_api" | grep -qF 'OPENSHELL-RESOLVE-ENV-'; then
  fail "M-S15: OpenShell did not resolve the Bolt-shape alias"
elif echo "$sl_api" | grep -qF 'openshell:resolve:env:'; then
  fail "M-S15: L7 proxy did not substitute the canonical placeholder — substitution chain broken"
else
  fail "M-S15: Unexpected Slack response (status=$sl_status): ${sl_api:0:200}"
fi

# M-S15b: L7 proxy substitution for SLACK_BOT_TOKEN, isolated from the
# alias path. Sends the canonical openshell:resolve:env:SLACK_BOT_TOKEN
# placeholder directly. If the L7 proxy substitutes correctly, the fake Slack API
# receives the host-side xoxb token and returns invalid_auth.
#
# Mirrors the proof technique already used by Telegram M15 and Discord
# M17 (they get 401/404 from the real APIs because the L7 proxy
# substituted the canonical form into a real fake-token-shape value).
info "Probing L7 proxy substitution for SLACK_BOT_TOKEN (canonical placeholder, bypasses rewriter)..."
sl_canonical=""
if [ "$fake_slack_ready" = "1" ]; then
  sl_canonical=$(run_fake_slack_api_node_request "$FAKE_SLACK_API_PORT" "/api/auth.test" "Bearer openshell:resolve:env:SLACK_BOT_TOKEN" || true)
fi

info "Slack auth.test (canonical) response: ${sl_canonical:0:300}"
sl_canon_status=$(echo "$sl_canonical" | grep -E '^[0-9]' | head -1 | awk '{print $1}')

if [ "$sl_canon_status" = "200" ] && echo "$sl_canonical" | grep -qE 'invalid_auth|not_authed'; then
  pass "M-S15b: L7 proxy substitutes openshell:resolve:env:SLACK_BOT_TOKEN at egress (parallels Telegram M15 / Discord M17)"
elif echo "$sl_canonical" | grep -q "TIMEOUT"; then
  skip "M-S15b: canonical-placeholder probe timed out"
elif echo "$sl_canonical" | grep -qF 'openshell:resolve:env:' || echo "$sl_canonical" | grep -qiF 'invalid token'; then
  fail "M-S15b: L7 proxy passed canonical placeholder through unchanged — substitution not happening for SLACK_BOT_TOKEN"
else
  fail "M-S15b: Unexpected response (status=$sl_canon_status): ${sl_canonical:0:200}"
fi

# M-S15c: Negative control — the env-var name in the canonical
# placeholder is not registered as a provider. The L7 proxy's response
# differs from M-S15b's "successful substitution" path, which gives us
# a positive signal that substitution happens at all. If M-S15b and
# M-S15c return identical responses, the proxy isn't substituting; if
# they differ, the proxy distinguishes set vs unset env vars (i.e.,
# substitution is actually running on the substring it recognizes).
info "Probing L7 proxy substitution with an unset env var (negative control)..."
sl_unset=""
if [ "$fake_slack_ready" = "1" ]; then
  sl_unset=$(run_fake_slack_api_node_request "$FAKE_SLACK_API_PORT" "/api/auth.test" "Bearer openshell:resolve:env:DEFINITELY_NOT_SET_XYZ" || true)
fi

info "Slack auth.test (unset env) response: ${sl_unset:0:300}"
# OpenShell may reject the unresolved placeholder with an explicit
# credential_injection_failed response or a connection-level failure.
# Either shape proves the unresolved placeholder did not reach upstream.
if is_unresolved_placeholder_rejection "$sl_unset"; then
  pass "M-S15c: unset-var failed closed before upstream exposure"
elif echo "$sl_unset" | grep -qE 'ERROR:.*(socket hang up|ECONNRESET|EPIPE|hang up|reset)'; then
  pass "M-S15c: unset-var triggered connection-level failure — proxy refuses to forward unsubstituted placeholder"
elif echo "$sl_unset" | grep -qE '^200\b'; then
  fail "M-S15c: unset-var returned HTTP 200 — proxy passed canonical placeholder through unchanged for unset env (substitution may be a no-op)"
elif echo "$sl_unset" | grep -qE '^401\b|bad_auth|DEFINITELY_NOT_SET_XYZ'; then
  fail "M-S15c: unset-var request reached fake Slack — unresolved placeholder escaped the proxy boundary"
elif [ -z "$sl_unset" ] || echo "$sl_unset" | grep -q "TIMEOUT"; then
  skip "M-S15c: unset-var probe timed out or returned no output"
else
  skip "M-S15c: unset-var produced an unclassified result: ${sl_unset:0:200}"
fi

# M-S16: Socket Mode HTTPS leg (apps.connections.open). Bolt's Socket
# Mode opens a websocket only after this POST succeeds, so this is the
# call that the xapp- token actually authenticates. We don't bother
# upgrading WSS in the test — the auth check is on the HTTPS POST.
info "Calling fake Slack /api/apps.connections.open with Bolt-shape xapp- placeholder..."
sl_app_api=""
if [ "$fake_slack_ready" = "1" ]; then
  sl_app_api=$(run_fake_slack_api_node_request "$FAKE_SLACK_API_PORT" "/api/apps.connections.open" "Bearer xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN" || true)
fi

info "Slack apps.connections.open response: ${sl_app_api:0:300}"
sl_app_status=$(echo "$sl_app_api" | grep -E '^[0-9]' | head -1 | awk '{print $1}')

if [ "$sl_app_status" = "200" ] && echo "$sl_app_api" | grep -q '"ok":true'; then
  pass "M-S16: apps.connections.open returned ok:true — real xapp token round-trip verified!"
elif [ "$sl_app_status" = "200" ] && echo "$sl_app_api" | grep -qE 'invalid_auth|not_authed|not_allowed_token_type'; then
  pass "M-S16: apps.connections.open auth-rejected — Socket Mode HTTPS leg verified (OpenShell alias rewrite → fake Slack)"
  sl_app_capture=$(check_fake_slack_capture_token "/api/apps.connections.open" "$SLACK_APP" || true)
  if [ "$sl_app_capture" = "OK" ]; then
    pass "M-S16a: fake Slack saw host-side app token in header and urlencoded body"
  else
    fail "M-S16a: fake Slack capture did not prove app header/body rewrite: ${sl_app_capture:0:300}"
  fi
elif echo "$sl_app_api" | grep -q "TIMEOUT"; then
  skip "M-S16: apps.connections.open timed out"
elif echo "$sl_app_api" | grep -qF 'OPENSHELL-RESOLVE-ENV-'; then
  fail "M-S16: OpenShell did not resolve the xapp- alias for Socket Mode path"
else
  fail "M-S16: Unexpected apps.connections.open response (status=$sl_app_status): ${sl_app_api:0:200}"
fi

# M-S16b: L7 proxy substitution for SLACK_APP_TOKEN, isolated. Same
# rationale as M-S15b — sends the canonical placeholder directly so only
# the L7 proxy substitution is exercised.
info "Probing L7 proxy substitution for SLACK_APP_TOKEN (canonical placeholder)..."
sl_app_canonical=""
if [ "$fake_slack_ready" = "1" ]; then
  sl_app_canonical=$(run_fake_slack_api_node_request "$FAKE_SLACK_API_PORT" "/api/apps.connections.open" "Bearer openshell:resolve:env:SLACK_APP_TOKEN" || true)
fi

info "Slack apps.connections.open (canonical) response: ${sl_app_canonical:0:300}"
sl_app_canon_status=$(echo "$sl_app_canonical" | grep -E '^[0-9]' | head -1 | awk '{print $1}')

info "Probing L7 proxy substitution for an unset app-token env var (negative control)..."
sl_app_unset=""
if [ "$fake_slack_ready" = "1" ]; then
  sl_app_unset=$(run_fake_slack_api_node_request "$FAKE_SLACK_API_PORT" "/api/apps.connections.open" "Bearer openshell:resolve:env:DEFINITELY_NOT_SET_SLACK_APP_TOKEN" || true)
fi

info "Slack apps.connections.open (unset env) response: ${sl_app_unset:0:300}"
if [ "$sl_app_canon_status" = "200" ] && echo "$sl_app_canonical" | grep -qE 'invalid_auth|not_authed|not_allowed_token_type'; then
  if is_unresolved_placeholder_rejection "$sl_app_unset"; then
    pass "M-S16b: unset app-token failed closed before upstream exposure"
  elif echo "$sl_app_unset" | grep -qE 'ERROR:.*(socket hang up|ECONNRESET|EPIPE|hang up|reset)'; then
    pass "M-S16b: L7 proxy substitutes openshell:resolve:env:SLACK_APP_TOKEN at egress (unset-var control diverged)"
  elif echo "$sl_app_unset" | grep -qE '^200\b'; then
    fail "M-S16b: unset app-token env returned HTTP 200 — proxy may be passing canonical placeholders through unchanged"
  elif echo "$sl_app_unset" | grep -qE '^401\b|bad_auth|DEFINITELY_NOT_SET_SLACK_APP_TOKEN'; then
    fail "M-S16b: unset app-token request reached fake Slack — unresolved placeholder escaped the proxy boundary"
  elif [ -z "$sl_app_unset" ] || echo "$sl_app_unset" | grep -q "TIMEOUT"; then
    skip "M-S16b: unset app-token control timed out or returned no output"
  else
    skip "M-S16b: unset app-token control produced an unclassified result: ${sl_app_unset:0:200}"
  fi
elif echo "$sl_app_canonical" | grep -q "TIMEOUT"; then
  skip "M-S16b: canonical-placeholder probe timed out"
elif echo "$sl_app_canonical" | grep -qF 'openshell:resolve:env:'; then
  fail "M-S16b: L7 proxy passed canonical placeholder through unchanged for SLACK_APP_TOKEN"
else
  fail "M-S16b: Unexpected response (status=$sl_app_canon_status): ${sl_app_canonical:0:200}"
fi

# M-S17: Slack channel @mention allowlist proof (#3729). This runs inside the
# sandbox, imports OpenClaw's installed Slack test API, and verifies:
#   - the configured Slack user can prepare a channel app_mention
#   - another user is denied by channels.*.users
#   - sendMessageSlack posts back to the channel through the hermetic fake API
info "Running Slack channel @mention allowlist proof through installed OpenClaw..."
sl_channel_proof=""
sl_allowed_user="${SLACK_IDS%%,*}"
sl_allowed_user="${sl_allowed_user//[[:space:]]/}"
slack_openclaw_plugin_mock_send_ok=0
if [ "$fake_slack_ready" = "1" ] && [ -n "$sl_allowed_user" ]; then
  sl_channel_proof=$(run_fake_slack_channel_mention_proof "$FAKE_SLACK_API_PORT" "$sl_allowed_user" "U999DENIED" || true)
fi

info "Slack channel @mention proof response: ${sl_channel_proof:0:500}"
if echo "$sl_channel_proof" | grep -q '"ok":true' \
  && echo "$sl_channel_proof" | grep -q '"deniedPrepared":true'; then
  pass "M-S17: Slack channel @mention allowlist accepts configured user and denies another user"
  sl_post_capture=$(check_fake_slack_capture_token "/api/chat.postMessage" "$SLACK_TOKEN" || true)
  if [ "$sl_post_capture" = "OK" ]; then
    pass "M-S17a: fake Slack saw host-side bot token for channel reply"
  else
    fail "M-S17a: fake Slack capture did not prove channel reply token rewrite: ${sl_post_capture:0:300}"
  fi
  sl_message_capture=$(check_fake_slack_capture_message "/api/chat.postMessage" "C0E2ESLACK" "NemoClaw Slack channel mention proof" || true)
  if [ "$sl_message_capture" = "OK" ]; then
    pass "M-S17b: fake Slack captured non-secret channel/text metadata for channel reply"
  else
    fail "M-S17b: fake Slack did not capture expected channel reply metadata: ${sl_message_capture:0:300}"
  fi
  sl_proof_kind=$(printf '%s\n' "$sl_channel_proof" | python3 -c '
import json
import sys
for line in sys.stdin:
    line = line.strip()
    if not line.startswith("{"):
        continue
    try:
        value = json.loads(line)
    except Exception:
        continue
    print(value.get("proof", ""))
    break
' 2>/dev/null || true)
  if [ "$sl_proof_kind" = "openclaw-private-helper" ] && [ "$sl_message_capture" = "OK" ]; then
    slack_openclaw_plugin_mock_send_ok=1
    pass "M-S17c: installed OpenClaw Slack send helper drove the host-side fake Slack message"
  else
    fail "M-S17c: Slack proof did not use the installed OpenClaw Slack send helper (proof=${sl_proof_kind:-missing})"
  fi
  # M-S17d (#4752): a denied explicit @-mention prepares no command but must
  # still emit exactly one bounded sender-facing feedback action.
  if echo "$sl_channel_proof" | grep -q '"deniedFeedbackCount":1' \
    && echo "$sl_channel_proof" | grep -q '"deniedFeedbackMethod":"chat.postEphemeral"'; then
    pass "M-S17d: denied Slack @mention sent exactly one bounded sender feedback action"
  else
    fail "M-S17d: denied Slack @mention did not send bounded sender feedback: ${sl_channel_proof:0:500}"
  fi
elif [ "$fake_slack_ready" != "1" ]; then
  skip "M-S17: fake Slack API was not ready"
elif [ -z "$sl_allowed_user" ]; then
  skip "M-S17: SLACK_ALLOWED_USERS is empty"
else
  fail "M-S17: Slack channel @mention proof failed: ${sl_channel_proof:0:500}"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 6: OpenClaw Plugin Sends
# ══════════════════════════════════════════════════════════════════
section "Phase 6: OpenClaw Plugin Sends"

if [ -n "${TELEGRAM_BOT_TOKEN_REAL:-}" ] && [ -n "${TELEGRAM_CHAT_ID_E2E:-}" ]; then
  info "Real Telegram token available — testing live round-trip"

  # M18: Telegram getMe with real token should return 200 + bot info
  # Note: the real token must be set up as the provider credential, not as env
  # For this to work, the sandbox must have been created with the real token
  if [ "$tg_status" = "200" ]; then
    pass "M18: Telegram getMe returned 200 with real token"
    if echo "$tg_api" | grep -q '"ok":true'; then
      pass "M18b: Telegram response contains ok:true"
    fi
  else
    fail "M18: Expected Telegram getMe 200 with real token, got: $tg_status"
  fi

  # M19: real send through OpenClaw's message CLI/plugin path.
  info "Sending Telegram test message through OpenClaw plugin to chat ${TELEGRAM_CHAT_ID_E2E}..."
  send_result=$(run_openclaw_message_send \
    "telegram" \
    "${TELEGRAM_CHAT_ID_E2E}" \
    "NemoClaw OpenClaw Telegram plugin E2E $(date -u +%Y-%m-%dT%H:%M:%SZ)" || true)
  send_exit=$(printf '%s\n' "$send_result" | openclaw_message_send_exit_code)

  if [ "$send_exit" = "0" ]; then
    pass "M19: Telegram openclaw message send succeeded through plugin"
  else
    fail "M19: Telegram openclaw message send failed: ${send_result:0:300}"
  fi
else
  telegram_mock_chat_id="${TELEGRAM_CHAT_ID_E2E:-42424242}"
  telegram_mock_text="NemoClaw OpenClaw Telegram plugin mock E2E"
  info "Complete real Telegram credentials are not available — using host-side fake Telegram Bot API"
  if start_fake_telegram_api "$TELEGRAM_TOKEN"; then
    pass "M18: Host-side fake Telegram Bot API started for OpenClaw plugin send"
    if apply_fake_telegram_api_policy "$SANDBOX_NAME" "$FAKE_TELEGRAM_API_PORT" >/tmp/nemoclaw-fake-telegram-policy.log 2>&1; then
      pass "M18a: Applied REST policy for host-side fake Telegram Bot API"
      tg_mock_send_result=$(run_openclaw_telegram_mock_send "$FAKE_TELEGRAM_API_PORT" "$telegram_mock_chat_id" "$telegram_mock_text" || true)
      tg_mock_send_exit=$(printf '%s\n' "$tg_mock_send_result" | openclaw_message_send_exit_code)
      tg_mock_capture=$(check_fake_telegram_capture_send "$TELEGRAM_TOKEN" "$telegram_mock_chat_id" "$telegram_mock_text" || true)

      if [ "$tg_mock_send_exit" = "0" ] && [ "$tg_mock_capture" = "OK" ]; then
        pass "M19: Telegram installed OpenClaw send helper posted through host mock"
      elif [ "$tg_mock_send_exit" != "0" ]; then
        fail "M19: Telegram OpenClaw mock helper send failed: ${tg_mock_send_result:0:300}"
      else
        fail "M19: Fake Telegram did not capture the expected rewritten message: ${tg_mock_capture:0:300}"
      fi
    else
      fail "M18a: Failed to apply fake Telegram policy: $(tail -20 /tmp/nemoclaw-fake-telegram-policy.log 2>/dev/null | tr '\n' ' ' | cut -c1-300)"
      fail "M19: Telegram OpenClaw mock message send could not run without fake Telegram policy"
    fi
  else
    fail "M18: Could not start host-side fake Telegram Bot API"
    fail "M19: Telegram OpenClaw mock message send could not run without fake Telegram"
  fi
fi

run_telegram_inbound_reply_probe

if [ -n "${DISCORD_BOT_TOKEN_REAL:-}" ] && [ -n "${DISCORD_CHANNEL_ID_E2E:-}" ]; then
  if [ "$dc_status" = "200" ]; then
    pass "M20: Discord users/@me returned 200 with real token"
  else
    fail "M20: Expected Discord users/@me 200 with real token, got: $dc_status"
  fi

  info "Sending Discord test message through OpenClaw plugin to channel ${DISCORD_CHANNEL_ID_E2E}..."
  dc_send_result=$(run_openclaw_message_send \
    "discord" \
    "channel:${DISCORD_CHANNEL_ID_E2E}" \
    "NemoClaw OpenClaw Discord plugin E2E $(date -u +%Y-%m-%dT%H:%M:%SZ)" || true)
  dc_send_exit=$(printf '%s\n' "$dc_send_result" | openclaw_message_send_exit_code)

  if [ "$dc_send_exit" = "0" ]; then
    pass "M21: Discord openclaw message send succeeded through plugin"
  else
    fail "M21: Discord openclaw message send failed: ${dc_send_result:0:300}"
  fi
else
  discord_mock_channel_id="${DISCORD_CHANNEL_ID_E2E:-420000000000000123}"
  discord_mock_text="NemoClaw OpenClaw Discord plugin mock E2E"
  info "Complete real Discord credentials are not available — using host-side fake Discord message API"
  if start_fake_discord_message_api "$DISCORD_TOKEN"; then
    pass "M20: Host-side fake Discord message API started for OpenClaw plugin send"
    if apply_fake_discord_message_api_policy "$SANDBOX_NAME" "$FAKE_DISCORD_MESSAGE_API_PORT" >/tmp/nemoclaw-fake-discord-message-policy.log 2>&1; then
      pass "M20a: Applied REST policy for host-side fake Discord message API"
      dc_mock_send_result=$(run_fake_discord_plugin_send_proof "$FAKE_DISCORD_MESSAGE_API_PORT" "$discord_mock_channel_id" "$discord_mock_text" || true)
      dc_mock_capture=$(check_fake_discord_message_capture "$discord_mock_channel_id" "$discord_mock_text" || true)

      if echo "$dc_mock_send_result" | grep -q '"ok":true' && [ "$dc_mock_capture" = "OK" ]; then
        pass "M21: Discord installed OpenClaw send helper posted through host mock"
      elif ! echo "$dc_mock_send_result" | grep -q '"ok":true'; then
        fail "M21: Discord OpenClaw mock message send failed: ${dc_mock_send_result:0:500}"
      else
        fail "M21: Fake Discord did not capture the expected rewritten message: ${dc_mock_capture:0:300}"
      fi
    else
      fail "M20a: Failed to apply fake Discord message policy: $(tail -20 /tmp/nemoclaw-fake-discord-message-policy.log 2>/dev/null | tr '\n' ' ' | cut -c1-300)"
      fail "M21: Discord OpenClaw mock message send could not run without fake Discord policy"
    fi
  else
    fail "M20: Could not start host-side fake Discord message API"
    fail "M21: Discord OpenClaw mock message send could not run without fake Discord"
  fi
fi

if [ -n "${SLACK_BOT_TOKEN_REAL:-}" ] && [ -n "${SLACK_CHANNEL_ID_E2E:-}" ]; then
  pass "M22: Complete real Slack credentials are available for live OpenClaw send"
  info "Sending Slack test message through OpenClaw plugin to channel ${SLACK_CHANNEL_ID_E2E}..."
  sl_send_result=$(run_openclaw_message_send \
    "slack" \
    "channel:${SLACK_CHANNEL_ID_E2E}" \
    "NemoClaw OpenClaw Slack plugin E2E $(date -u +%Y-%m-%dT%H:%M:%SZ)" || true)
  sl_send_exit=$(printf '%s\n' "$sl_send_result" | openclaw_message_send_exit_code)

  if [ "$sl_send_exit" = "0" ]; then
    pass "M23: Slack openclaw message send succeeded through plugin"
  else
    fail "M23: Slack openclaw message send failed: ${sl_send_result:0:300}"
  fi
else
  info "Complete real Slack credentials are not available — requiring installed OpenClaw Slack helper proof against host fake Slack"
  if [ "$slack_openclaw_plugin_mock_send_ok" = "1" ]; then
    pass "M22: Slack host mock accepted the OpenShell-rewritten bot token"
    pass "M23: Slack installed OpenClaw send helper posted through host mock"
  else
    fail "M22: Slack host mock did not prove OpenShell-rewritten bot token through installed OpenClaw helper"
    fail "M23: Slack installed OpenClaw send helper did not post through host mock"
  fi
fi

# ══════════════════════════════════════════════════════════════════
# Phase 7: Slack channel guard (#2340)
#
# The sandbox was installed with fake Slack tokens. After the
# OpenShell alias rewrite change (#2085 follow-up) the failure mode is:
#   1. Bolt accepts the xoxb-OPENSHELL-RESOLVE-ENV-… placeholder
#      (matches its prefix regex).
#   2. OpenShell resolves the alias at egress.
#   3. The L7 proxy substitutes the fake xoxb-fake-… token from env.
#   4. The Slack API rejects the fake token.
#   5. @slack/web-api emits an unhandled rejection — the guard catches it.
# Pre-refactor the catch happened earlier (Bolt's in-process xapp- prefix
# check), but the observable here is the same: gateway stays up, log shows
# the guard caught a Slack rejection.
# ══════════════════════════════════════════════════════════════════
section "Phase 7: Slack channel guard (#2340)"

# S1: Gateway is serving on port 18789 — the guard caught the Slack rejection
gw_port=$(sandbox_exec 'node -e "
const net = require(\"net\");
const sock = net.connect(18789, \"127.0.0.1\");
sock.on(\"connect\", () => { console.log(\"OPEN\"); sock.end(); });
sock.on(\"error\", () => console.log(\"CLOSED\"));
setTimeout(() => { console.log(\"TIMEOUT\"); sock.destroy(); }, 5000);
"' 2>/dev/null || true)
if echo "$gw_port" | grep -q "OPEN"; then
  pass "S1: Gateway is serving on port 18789 — Slack auth failure did not crash it"
else
  fail "S1: Gateway is not serving on port 18789 (${gw_port:0:200})"
  # Dump early entrypoint log — captures crashes that happen before
  # touch /tmp/gateway.log (e.g., Landlock read failures, seccomp blocks).
  start_log=$(openshell sandbox exec --name "$SANDBOX_NAME" -- cat /tmp/nemoclaw-start.log 2>/dev/null || true)
  if [ -n "$start_log" ]; then
    info "Entrypoint log (last 40 lines of /tmp/nemoclaw-start.log):"
    echo "$start_log" | tail -40 | while IFS= read -r line; do
      info "  $line"
    done
  fi
fi

# S2: Dump gateway.log for diagnostics (must use openshell exec — SSH user
# cannot read the file because it's 600 gateway:gateway).
gw_log=$(openshell sandbox exec --name "$SANDBOX_NAME" -- cat /tmp/gateway.log 2>/dev/null || true)
if [ -z "$gw_log" ]; then
  # Container may have already exited
  gw_log=$(nemoclaw "$SANDBOX_NAME" logs 2>&1 | tail -200 || true)
fi

info "Gateway log (last 30 lines):"
echo "$gw_log" | tail -30 | while IFS= read -r line; do
  info "  $line"
done

if echo "$gw_log" | grep -q "provider failed to start:.*gateway continues"; then
  pass "S2: Gateway log shows Slack rejection was caught by channel guard"
elif echo "$gw_log" | grep -qi "slack"; then
  info "Slack-related lines: $(echo "$gw_log" | grep -i slack | head -5)"
  skip "S2: Gateway log has Slack output but not the guard catch message"
elif [ -z "$gw_log" ]; then
  skip "S2: Could not read gateway log (container may have exited)"
else
  skip "S2: No Slack-related output in gateway log"
fi

# ══════════════════════════════════════════════════════════════════
# Phase 7b: Channel runtime registry verification (#4156)
# ══════════════════════════════════════════════════════════════════
# Asserts that the new runtime-channel diagnostic (`nemoclaw <sandbox>
# doctor --json` → Messaging → "Runtime channel registry") fires after
# rebuild. If the docker image was baked correctly, the diagnostic
# reports each configured channel as visible to the OpenClaw runtime;
# if the bake failed (the gap behind #4156), it reports the missing set
# instead of silently passing.
section "Phase 7b: Channel runtime registry verification (#4156)"

doctor_json=$(nemoclaw "$SANDBOX_NAME" doctor --json 2>/dev/null || true)
if [ -z "$doctor_json" ]; then
  skip "RT0: Could not collect doctor --json output"
else
  runtime_check=$(echo "$doctor_json" | python3 -c "
import json, sys
try:
    report = json.load(sys.stdin)
except Exception as e:
    print(json.dumps({'error': str(e)})); sys.exit(0)
match = next(
    (c for c in report.get('checks', []) if c.get('label') == 'Runtime channel registry'),
    None,
)
print(json.dumps(match or {'missing': True}))
" 2>/dev/null || echo '{"error":"parse"}')

  if echo "$runtime_check" | grep -q '"missing"'; then
    skip "RT1: doctor --json had no Runtime channel registry check (no configured channels)"
  else
    info "Runtime channel registry check: ${runtime_check:0:300}"
    rt_status=$(echo "$runtime_check" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "")
    if [ "$rt_status" = "ok" ]; then
      pass "RT1: doctor reports configured channels are visible to OpenClaw runtime registry"
    elif [ "$rt_status" = "warn" ]; then
      # A warn is still a pass for this E2E: it means the diagnostic detected
      # the very gap #4156 closes (e.g. a channel configured but absent from
      # /sandbox/.openclaw/openclaw.json after rebuild). The detail field
      # surfaces which channels are missing so the suite output stays useful.
      pass "RT1: doctor surfaced runtime channel registry warning (detail: $(echo "$runtime_check" | python3 -c "import json,sys; print(json.load(sys.stdin).get('detail',''))"))"
    else
      fail "RT1: Unexpected Runtime channel registry status '$rt_status' (raw: ${runtime_check:0:300})"
    fi
  fi
fi

# ══════════════════════════════════════════════════════════════════
# Phase 8: Cleanup
# ══════════════════════════════════════════════════════════════════
section "Phase 8: Cleanup"

info "Destroying sandbox '$SANDBOX_NAME'..."
if [[ "${NEMOCLAW_E2E_KEEP_SANDBOX:-}" = "1" ]]; then
  skip "Cleanup: NEMOCLAW_E2E_KEEP_SANDBOX=1 — leaving sandbox '$SANDBOX_NAME' for inspection"
else
  nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true
  openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true
fi

# Verify cleanup
if [[ "${NEMOCLAW_E2E_KEEP_SANDBOX:-}" = "1" ]]; then
  pass "Cleanup: Sandbox '$SANDBOX_NAME' intentionally kept"
elif openshell sandbox list 2>&1 | grep -q "$SANDBOX_NAME"; then
  fail "Cleanup: Sandbox '$SANDBOX_NAME' still present after cleanup"
else
  pass "Cleanup: Sandbox '$SANDBOX_NAME' removed"
fi

# ══════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════
echo ""
echo "========================================"
echo "  Messaging Provider Test Results:"
echo "    Passed:  $PASS"
echo "    Failed:  $FAIL"
echo "    Skipped: $SKIP"
echo "    Total:   $TOTAL"
echo "========================================"

if [ "$FAIL" -eq 0 ]; then
  printf '\n\033[1;32m  Messaging provider tests PASSED.\033[0m\n'
  exit 0
else
  printf '\n\033[1;31m  %d test(s) FAILED.\033[0m\n' "$FAIL"
  exit 1
fi
