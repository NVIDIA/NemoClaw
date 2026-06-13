#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Channel stop/start lifecycle E2E test.
#
# Covers Test 1 from issue #3462 ("onboard telegram -> channels stop -> channels start").
# The regression surface is exercised for both supported agents (OpenClaw and
# Hermes) and every messaging channel (telegram, discord, wechat, slack,
# whatsapp). Set NEMOCLAW_CHANNELS_STOP_START_AGENT=openclaw or hermes to run a
# single-agent shard.
#
# Regression coverage:
#   - #3453: `channels stop <ch>` + rebuild must actually remove the channel
#            from the baked agent config while preserving cached credentials.
#   - #3381: `channels start <ch>` + rebuild must reattach cached providers
#            without re-prompting.
#
# Prerequisites:
#   - Docker running
#   - NVIDIA_INFERENCE_API_KEY set
#   - NEMOCLAW_NON_INTERACTIVE=1
#   - NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
#     NVIDIA_INFERENCE_API_KEY=nvapi-... bash test/e2e/test-channels-stop-start.sh

set -uo pipefail

export NEMOCLAW_E2E_DEFAULT_TIMEOUT="${NEMOCLAW_E2E_DEFAULT_TIMEOUT:-7200}"
SCRIPT_DIR_TIMEOUT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=test/e2e/e2e-timeout.sh
source "${SCRIPT_DIR_TIMEOUT}/e2e-timeout.sh"

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
pass_msg() {
  ((PASS++))
  ((TOTAL++))
  printf '\033[32m  PASS: %s\033[0m\n' "$1"
}
fail_msg() {
  ((FAIL++))
  ((TOTAL++))
  printf '\033[31m  FAIL: %s\033[0m\n' "$1"
}

print_summary() {
  section "Summary"
  echo "  Total: $TOTAL  Pass: $PASS  Fail: $FAIL  Skip: $SKIP"
  if [ "$FAIL" -gt 0 ]; then
    echo ""
    echo "FAILED"
    exit 1
  fi
  echo ""
  if [ "$SKIP" -gt 0 ]; then
    echo "PASSED (with $SKIP skipped)"
  else
    echo "ALL PASSED"
  fi
}

if [ -d /workspace ] && [ -f /workspace/install.sh ]; then
  REPO="/workspace"
elif [ -f "$(cd "$(dirname "$0")/../.." && pwd)/install.sh" ]; then
  REPO="$(cd "$(dirname "$0")/../.." && pwd)"
else
  echo "ERROR: Cannot find repo root."
  exit 1
fi

BASE_SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-channels-stop-start}"
OPENCLAW_SANDBOX_NAME="${NEMOCLAW_CHANNELS_OPENCLAW_SANDBOX_NAME:-${BASE_SANDBOX_NAME}-openclaw}"
HERMES_SANDBOX_NAME="${NEMOCLAW_CHANNELS_HERMES_SANDBOX_NAME:-${BASE_SANDBOX_NAME}-hermes}"
REQUESTED_AGENT="${NEMOCLAW_CHANNELS_STOP_START_AGENT:-all}"
REGISTRY="$HOME/.nemoclaw/sandboxes.json"
OPENSHELL_BIN="${NEMOCLAW_OPENSHELL_BIN:-openshell}"
CHANNELS=(telegram discord wechat slack whatsapp)
TOKENLESS_CHANNELS=(whatsapp)
SELECTED_AGENT_SCENARIOS=()

case "$REQUESTED_AGENT" in
  all)
    SELECTED_AGENT_SCENARIOS=("openclaw:${OPENCLAW_SANDBOX_NAME}" "hermes:${HERMES_SANDBOX_NAME}")
    ;;
  openclaw)
    SELECTED_AGENT_SCENARIOS=("openclaw:${OPENCLAW_SANDBOX_NAME}")
    ;;
  hermes)
    SELECTED_AGENT_SCENARIOS=("hermes:${HERMES_SANDBOX_NAME}")
    ;;
  *)
    section "Phase 0: Prerequisites"
    fail_msg "C0: NEMOCLAW_CHANNELS_STOP_START_AGENT must be all, openclaw, or hermes (got ${REQUESTED_AGENT})"
    print_summary
    ;;
esac

ACTIVE_AGENT=""
ACTIVE_SANDBOX=""

ORIG_TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
ORIG_TELEGRAM_ALLOWED_IDS="${TELEGRAM_ALLOWED_IDS:-}"
ORIG_TELEGRAM_REQUIRE_MENTION="${TELEGRAM_REQUIRE_MENTION:-}"
ORIG_DISCORD_BOT_TOKEN="${DISCORD_BOT_TOKEN:-}"
ORIG_DISCORD_SERVER_ID="${DISCORD_SERVER_ID:-}"
ORIG_DISCORD_SERVER_IDS="${DISCORD_SERVER_IDS:-}"
ORIG_DISCORD_USER_ID="${DISCORD_USER_ID:-}"
ORIG_DISCORD_ALLOWED_IDS="${DISCORD_ALLOWED_IDS:-}"
ORIG_DISCORD_REQUIRE_MENTION="${DISCORD_REQUIRE_MENTION:-}"
ORIG_SLACK_BOT_TOKEN="${SLACK_BOT_TOKEN:-}"
ORIG_SLACK_APP_TOKEN="${SLACK_APP_TOKEN:-}"
ORIG_SLACK_ALLOWED_USERS="${SLACK_ALLOWED_USERS:-}"
ORIG_WECHAT_BOT_TOKEN="${WECHAT_BOT_TOKEN:-}"
ORIG_WECHAT_ACCOUNT_ID="${WECHAT_ACCOUNT_ID:-}"
ORIG_WECHAT_BASE_URL="${WECHAT_BASE_URL:-}"
ORIG_WECHAT_USER_ID="${WECHAT_USER_ID:-}"
ORIG_WECHAT_ALLOWED_IDS="${WECHAT_ALLOWED_IDS:-}"

openshell() {
  if [ "$OPENSHELL_BIN" = "openshell" ]; then
    command openshell "$@"
  else
    "$OPENSHELL_BIN" "$@"
  fi
}

# shellcheck source=test/e2e/lib/sandbox-teardown.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/sandbox-teardown.sh"
for scenario in "${SELECTED_AGENT_SCENARIOS[@]}"; do
  register_sandbox_for_teardown "${scenario#*:}"
done

refresh_path() {
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
}

sandbox_exec() {
  local cmd="$1"
  local ssh_config
  ssh_config="$(mktemp)"
  openshell sandbox ssh-config "$ACTIVE_SANDBOX" >"$ssh_config" 2>/dev/null

  local result
  result=$(run_with_timeout 60 ssh -F "$ssh_config" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 \
    -o LogLevel=ERROR \
    "openshell-${ACTIVE_SANDBOX}" \
    "$cmd" \
    2>&1) || true

  rm -f "$ssh_config"
  echo "$result"
}

registry_field() {
  local field="$1"
  if [ ! -f "$REGISTRY" ]; then
    echo "null"
    return
  fi
  if command -v jq >/dev/null 2>&1; then
    jq -c --arg name "$ACTIVE_SANDBOX" --arg field "$field" \
      '.sandboxes[$name][$field]' "$REGISTRY" 2>/dev/null || echo "null"
  else
    node -e "
const r = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
const v = (r.sandboxes || {})[process.argv[2]]?.[process.argv[3]];
process.stdout.write(JSON.stringify(v ?? null));
" "$REGISTRY" "$ACTIVE_SANDBOX" "$field" 2>/dev/null || echo "null"
  fi
}

registry_array_contains() {
  local field="$1"
  local item="$2"
  local value
  value="$(registry_field "$field")"
  printf '%s' "$value" | grep -Fq "\"${item}\""
}

registry_plan_channel_contains() {
  local item="$1"
  node -e '
const fs = require("fs");
const [registryPath, sandboxName, channelId] = process.argv.slice(1);
if (!fs.existsSync(registryPath)) process.exit(1);
const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
const plan = registry.sandboxes?.[sandboxName]?.messaging?.plan;
const channels = Array.isArray(plan?.channels) ? plan.channels : [];
process.exit(channels.some((channel) => channel?.channelId === channelId) ? 0 : 1);
' "$REGISTRY" "$ACTIVE_SANDBOX" "$item"
}

registry_plan_disabled_contains() {
  local item="$1"
  node -e '
const fs = require("fs");
const [registryPath, sandboxName, channelId] = process.argv.slice(1);
if (!fs.existsSync(registryPath)) process.exit(1);
const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
const disabled = registry.sandboxes?.[sandboxName]?.messaging?.plan?.disabledChannels;
process.exit(Array.isArray(disabled) && disabled.includes(channelId) ? 0 : 1);
' "$REGISTRY" "$ACTIVE_SANDBOX" "$item"
}

provider_names_for_channel() {
  local sandbox="$1"
  local channel="$2"
  case "$channel" in
    telegram) printf '%s\n' "${sandbox}-telegram-bridge" ;;
    discord) printf '%s\n' "${sandbox}-discord-bridge" ;;
    wechat) printf '%s\n' "${sandbox}-wechat-bridge" ;;
    slack)
      printf '%s\n' "${sandbox}-slack-bridge"
      printf '%s\n' "${sandbox}-slack-app"
      ;;
  esac
}

channel_presence() {
  local channel="$1"
  local config_channel="$channel"
  local out
  if [ "$ACTIVE_AGENT" = "openclaw" ]; then
    # NemoClaw's wechat channel maps to OpenClaw's upstream plugin key.
    if [ "$channel" = "wechat" ]; then
      config_channel="openclaw-weixin"
    fi
    out=$(sandbox_exec "python3 -c 'import json,sys; d=json.load(open(\"/sandbox/.openclaw/openclaw.json\")); print(\"yes\" if sys.argv[1] in d.get(\"channels\", {}) else \"no\")' '$config_channel'" | tail -1) || true
  else
    local probe
    case "$channel" in
      telegram)
        probe='grep -Eq "^TELEGRAM_BOT_TOKEN=openshell:resolve:env:TELEGRAM_BOT_TOKEN$" /sandbox/.hermes/.env'
        ;;
      discord)
        probe='grep -Eq "^DISCORD_BOT_TOKEN=openshell:resolve:env:DISCORD_BOT_TOKEN$" /sandbox/.hermes/.env'
        ;;
      wechat)
        probe='grep -Eq "^WEIXIN_TOKEN=openshell:resolve:env:WECHAT_BOT_TOKEN$" /sandbox/.hermes/.env'
        ;;
      slack)
        probe='grep -Eq "^SLACK_BOT_TOKEN=xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN$" /sandbox/.hermes/.env && grep -Eq "^SLACK_APP_TOKEN=xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN$" /sandbox/.hermes/.env'
        ;;
      whatsapp)
        probe='grep -Eq "^WHATSAPP_ENABLED=true$" /sandbox/.hermes/.env && grep -Eq "^WHATSAPP_MODE=bot$" /sandbox/.hermes/.env'
        ;;
    esac
    out=$(sandbox_exec "if [ -r /sandbox/.hermes/.env ]; then if ${probe}; then echo yes; else echo no; fi; else echo missing; fi" | tail -1) || true
  fi

  case "$out" in
    yes) echo "yes" ;;
    no) echo "no" ;;
    *) echo "error:${out}" ;;
  esac
}

dump_channel_state() {
  info "registry.messaging.plan.channels: $(node -e 'const fs=require("fs"); const [p,n]=process.argv.slice(1); const r=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,"utf8")):{}; const c=r.sandboxes?.[n]?.messaging?.plan?.channels; process.stdout.write(JSON.stringify(Array.isArray(c)?c.map((x)=>x?.channelId):null));' "$REGISTRY" "$ACTIVE_SANDBOX" 2>/dev/null || echo null)"
  info "registry.messaging.plan.disabledChannels: $(node -e 'const fs=require("fs"); const [p,n]=process.argv.slice(1); const r=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,"utf8")):{}; process.stdout.write(JSON.stringify(r.sandboxes?.[n]?.messaging?.plan?.disabledChannels ?? null));' "$REGISTRY" "$ACTIVE_SANDBOX" 2>/dev/null || echo null)"
  info "registry.providerCredentialHashes: $(registry_field providerCredentialHashes)"
  if [ "$ACTIVE_AGENT" = "openclaw" ]; then
    info "openclaw.json channels:"
    sandbox_exec "python3 -c 'import json; print(list(json.load(open(\"/sandbox/.openclaw/openclaw.json\")).get(\"channels\", {}).keys()))' 2>&1" | head -10 || true
  else
    info ".hermes/.env messaging keys:"
    sandbox_exec "grep -E '^(TELEGRAM_BOT_TOKEN|DISCORD_BOT_TOKEN|SLACK_BOT_TOKEN|SLACK_APP_TOKEN|WEIXIN_TOKEN|WHATSAPP_ENABLED|WHATSAPP_MODE|WHATSAPP_ALLOWED_USERS)=' /sandbox/.hermes/.env 2>/dev/null || true" | head -20 || true
  fi
}

assert_all_config_channels() {
  local expected="$1"
  local context="$2"
  local channel status msg
  for channel in "${CHANNELS[@]}"; do
    status="$(channel_presence "$channel")"
    if [ "$expected" = "present" ] && [ "$status" = "yes" ]; then
      msg="${ACTIVE_AGENT}/${channel}: agent config contains channel ${context}"
      pass_msg "$msg"
    elif [ "$expected" = "absent" ] && [ "$status" = "no" ]; then
      msg="${ACTIVE_AGENT}/${channel}: agent config excludes channel ${context}"
      pass_msg "$msg"
    else
      msg="${ACTIVE_AGENT}/${channel}: expected channel ${expected} in agent config ${context}, got ${status}"
      fail_msg "$msg"
      dump_channel_state
    fi
  done
}

assert_registry_channels() {
  local expected="$1"
  local context="$2"
  local channel msg
  for channel in "${CHANNELS[@]}"; do
    if [ "$expected" = "present" ] && registry_plan_channel_contains "$channel"; then
      msg="${ACTIVE_AGENT}/${channel}: registry.messaging.plan.channels contains channel ${context}"
      pass_msg "$msg"
    elif [ "$expected" = "absent" ] && ! registry_plan_channel_contains "$channel"; then
      msg="${ACTIVE_AGENT}/${channel}: registry.messaging.plan.channels excludes channel ${context}"
      pass_msg "$msg"
    else
      msg="${ACTIVE_AGENT}/${channel}: registry.messaging.plan.channels expected ${expected} ${context}"
      fail_msg "$msg"
    fi
  done
}

assert_disabled_channels() {
  local expected="$1"
  local context="$2"
  local channel msg
  for channel in "${CHANNELS[@]}"; do
    if [ "$expected" = "present" ] && registry_plan_disabled_contains "$channel"; then
      msg="${ACTIVE_AGENT}/${channel}: registry.messaging.plan.disabledChannels contains channel ${context}"
      pass_msg "$msg"
    elif [ "$expected" = "absent" ] && ! registry_plan_disabled_contains "$channel"; then
      msg="${ACTIVE_AGENT}/${channel}: registry.messaging.plan.disabledChannels excludes channel ${context}"
      pass_msg "$msg"
    else
      msg="${ACTIVE_AGENT}/${channel}: registry.messaging.plan.disabledChannels expected ${expected} ${context}"
      fail_msg "$msg"
    fi
  done
}

assert_host_messaging_config() {
  local context="$1"
  local output msg
  if output="$(node -e '
const fs = require("fs");
const [registryPath, sandboxName, ...pairs] = process.argv.slice(1);
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
if (!fs.existsSync(registryPath)) fail("registry file not found: " + registryPath);
const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
const entry = registry.sandboxes?.[sandboxName];
if (!entry) fail("sandbox " + sandboxName + " missing from registry");
const plan = entry.messaging?.plan;
if (!plan || plan.schemaVersion !== 1) fail("messaging.plan missing or schemaVersion != 1");
const channels = Array.isArray(plan.channels) ? plan.channels : [];
const inputMap = {
  TELEGRAM_ALLOWED_IDS: ["telegram", "allowedIds"],
  TELEGRAM_REQUIRE_MENTION: ["telegram", "requireMention"],
  DISCORD_SERVER_ID: ["discord", "serverId"],
  DISCORD_USER_ID: ["discord", "userId"],
  DISCORD_REQUIRE_MENTION: ["discord", "requireMention"],
  SLACK_ALLOWED_USERS: ["slack", "allowedUsers"],
  WECHAT_ALLOWED_IDS: ["wechat", "allowedIds"],
};
for (let i = 0; i < pairs.length; i += 2) {
  const key = pairs[i];
  const expected = pairs[i + 1];
  const mapping = inputMap[key];
  if (!mapping) fail("no plan input mapping for " + key);
  const [channelId, inputId] = mapping;
  const channel = channels.find((item) => item?.channelId === channelId);
  if (!channel) fail(channelId + " missing from messaging.plan.channels");
  const inputs = Array.isArray(channel.inputs) ? channel.inputs : [];
  const actual = inputs.find((input) => input?.inputId === inputId)?.value;
  if (actual !== expected) {
    fail(key + " expected " + expected + ", got " + JSON.stringify(actual));
  }
}
' "$REGISTRY" "$ACTIVE_SANDBOX" \
    TELEGRAM_ALLOWED_IDS "$TELEGRAM_ALLOWED_IDS" \
    TELEGRAM_REQUIRE_MENTION "$TELEGRAM_REQUIRE_MENTION" \
    DISCORD_SERVER_ID "$DISCORD_SERVER_ID" \
    DISCORD_USER_ID "$DISCORD_USER_ID" \
    DISCORD_REQUIRE_MENTION "$DISCORD_REQUIRE_MENTION" \
    SLACK_ALLOWED_USERS "$SLACK_ALLOWED_USERS" \
    WECHAT_ALLOWED_IDS "$WECHAT_ALLOWED_IDS" 2>&1)"; then
    msg="${ACTIVE_AGENT}: host registry messaging.plan persists channel config ${context}"
    pass_msg "$msg"
  else
    msg="${ACTIVE_AGENT}: host registry messaging.plan missing channel config ${context}: ${output}"
    fail_msg "$msg"
  fi
}

assert_host_messaging_plan_state() {
  local expected="$1"
  local context="$2"
  local channel output msg
  for channel in "${CHANNELS[@]}"; do
    if output="$(node -e '
const fs = require("fs");
const [registryPath, sandboxName, agent, channelId, expected] = process.argv.slice(1);
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
if (!fs.existsSync(registryPath)) fail("registry file not found: " + registryPath);
const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
const entry = registry.sandboxes?.[sandboxName];
if (!entry) fail("sandbox " + sandboxName + " missing from registry");
const state = entry.messaging;
if (!state || state.schemaVersion !== 1) fail("messaging state missing or schemaVersion != 1");
const plan = state.plan;
if (!plan || plan.schemaVersion !== 1) fail("messaging.plan missing or schemaVersion != 1");
if (plan.sandboxName !== sandboxName) {
  fail("messaging.plan.sandboxName expected " + sandboxName + ", got " + JSON.stringify(plan.sandboxName));
}
if (plan.agent !== agent) fail("messaging.plan.agent expected " + agent + ", got " + JSON.stringify(plan.agent));
const channels = Array.isArray(plan.channels) ? plan.channels : [];
const channel = channels.find((item) => item?.channelId === channelId);
if (!channel) fail(channelId + " missing from messaging.plan.channels");
if (channel.configured !== true) {
  fail(channelId + " messaging.plan configured expected true, got " + JSON.stringify(channel.configured));
}
const disabledChannels = Array.isArray(plan.disabledChannels) ? plan.disabledChannels : [];
if (expected === "active") {
  if (channel.active !== true) fail(channelId + " messaging.plan active expected true, got " + JSON.stringify(channel.active));
  if (channel.disabled === true) fail(channelId + " messaging.plan disabled unexpectedly true");
  if (disabledChannels.includes(channelId)) fail(channelId + " unexpectedly listed in messaging.plan.disabledChannels");
} else if (expected === "disabled") {
  if (channel.disabled !== true) fail(channelId + " messaging.plan disabled expected true, got " + JSON.stringify(channel.disabled));
  if (channel.active === true) fail(channelId + " messaging.plan active unexpectedly true");
  if (!disabledChannels.includes(channelId)) fail(channelId + " missing from messaging.plan.disabledChannels");
} else {
  fail("unknown expected plan state: " + expected);
}
const networkEntries = Array.isArray(plan.networkPolicy?.entries) ? plan.networkPolicy.entries : [];
const networkPresets = Array.isArray(plan.networkPolicy?.presets) ? plan.networkPolicy.presets : [];
if (!networkPresets.includes(channelId)) fail(channelId + " missing from messaging.plan.networkPolicy.presets");
if (!networkEntries.some((entry) => entry?.channelId === channelId)) {
  fail(channelId + " missing from messaging.plan.networkPolicy.entries");
}
const credentialBindings = Array.isArray(plan.credentialBindings) ? plan.credentialBindings : [];
if (channelId !== "whatsapp" && !credentialBindings.some((entry) => entry?.channelId === channelId)) {
  fail(channelId + " credential binding missing from messaging.plan");
}
if (Object.hasOwn(plan, "agentRender")) fail("messaging.plan.agentRender should not be persisted");
if (channels.some((item) => item && Object.hasOwn(item, "hooks"))) fail("messaging.plan.channels hooks should not be persisted");
' "$REGISTRY" "$ACTIVE_SANDBOX" "$ACTIVE_AGENT" "$channel" "$expected" 2>&1)"; then
      msg="${ACTIVE_AGENT}/${channel}: host registry messaging.plan has channel ${expected} ${context}"
      pass_msg "$msg"
    else
      msg="${ACTIVE_AGENT}/${channel}: host registry messaging.plan expected ${expected} ${context}: ${output}"
      fail_msg "$msg"
    fi
  done
}

assert_provider_records_exist() {
  local context="$1"
  local channel provider msg
  for channel in "${CHANNELS[@]}"; do
    while IFS= read -r provider; do
      if openshell provider get "$provider" >/dev/null 2>&1; then
        msg="${ACTIVE_AGENT}/${provider}: provider record exists ${context}"
        pass_msg "$msg"
      else
        msg="${ACTIVE_AGENT}/${provider}: provider record missing ${context}"
        fail_msg "$msg"
      fi
    done < <(provider_names_for_channel "$ACTIVE_SANDBOX" "$channel")
  done
}

assert_policy_preset_active() {
  local channel="$1"
  local expected="$2"
  local context="$3"
  local log="/tmp/nc-channels-${ACTIVE_AGENT}-policy-list-${channel}.log"
  local msg
  if ! nemoclaw "$ACTIVE_SANDBOX" policy-list >"$log" 2>&1; then
    msg="${ACTIVE_AGENT}/${channel}: policy-list failed ${context}"
    fail_msg "$msg"
    tail -30 "$log" 2>/dev/null || true
    return
  fi

  if [ "$expected" = "active" ]; then
    if grep -q "● ${channel}" "$log"; then
      msg="${ACTIVE_AGENT}/${channel}: channel policy preset active ${context}"
      pass_msg "$msg"
    else
      msg="${ACTIVE_AGENT}/${channel}: channel policy preset not active ${context}"
      fail_msg "$msg"
      grep -F "$channel" "$log" | head -5 || true
    fi
  else
    if grep -q "● ${channel}" "$log"; then
      msg="${ACTIVE_AGENT}/${channel}: channel policy preset still active ${context}"
      fail_msg "$msg"
      grep -F "$channel" "$log" | head -5 || true
    else
      msg="${ACTIVE_AGENT}/${channel}: channel policy preset inactive ${context}"
      pass_msg "$msg"
    fi
  fi
}

is_fake_telegram_token() {
  case "${1:-}" in
    *fake*) return 0 ;;
    *) return 1 ;;
  esac
}
is_fake_slack_token() {
  case "${1:-}" in
    xoxb-fake-* | xoxb-test-* | xapp-fake-* | xapp-test-*) return 0 ;;
    *) return 1 ;;
  esac
}

export_fake_channel_env() {
  local suffix="$1"
  export TELEGRAM_BOT_TOKEN="${ORIG_TELEGRAM_BOT_TOKEN:-test-fake-telegram-token-${suffix}}"
  export TELEGRAM_ALLOWED_IDS="${ORIG_TELEGRAM_ALLOWED_IDS:-123456789,987654321}"
  export TELEGRAM_REQUIRE_MENTION="${ORIG_TELEGRAM_REQUIRE_MENTION:-0}"

  export DISCORD_BOT_TOKEN="${ORIG_DISCORD_BOT_TOKEN:-test-fake-discord-token-${suffix}}"
  export DISCORD_SERVER_ID="${ORIG_DISCORD_SERVER_ID:-1491590992753590594}"
  export DISCORD_SERVER_IDS="${ORIG_DISCORD_SERVER_IDS:-${DISCORD_SERVER_ID}}"
  export DISCORD_USER_ID="${ORIG_DISCORD_USER_ID:-1005536447329222676}"
  export DISCORD_ALLOWED_IDS="${ORIG_DISCORD_ALLOWED_IDS:-${DISCORD_USER_ID}}"
  export DISCORD_REQUIRE_MENTION="${ORIG_DISCORD_REQUIRE_MENTION:-0}"

  export SLACK_BOT_TOKEN="${ORIG_SLACK_BOT_TOKEN:-xoxb-fake-slack-token-${suffix}}"
  export SLACK_APP_TOKEN="${ORIG_SLACK_APP_TOKEN:-xapp-fake-slack-app-token-${suffix}}"
  export SLACK_ALLOWED_USERS="${ORIG_SLACK_ALLOWED_USERS:-U0123456789,U09ABCDEFGH}"

  export WECHAT_BOT_TOKEN="${ORIG_WECHAT_BOT_TOKEN:-test-fake-wechat-token-${suffix}}"
  export WECHAT_ACCOUNT_ID="${ORIG_WECHAT_ACCOUNT_ID:-e2e-fake-account-${suffix}}"
  export WECHAT_BASE_URL="${ORIG_WECHAT_BASE_URL:-https://ilinkai.wechat.com}"
  export WECHAT_USER_ID="${ORIG_WECHAT_USER_ID:-wxid_${suffix}_operator}"
  export WECHAT_ALLOWED_IDS="${ORIG_WECHAT_ALLOWED_IDS:-${WECHAT_USER_ID}}"
}

pre_cleanup_sandbox() {
  local sandbox="$1"
  info "Pre-cleanup for ${sandbox}..."
  if command -v nemoclaw >/dev/null 2>&1; then
    nemoclaw "$sandbox" destroy --yes 2>/dev/null || true
  fi
  if openshell --version >/dev/null 2>&1; then
    openshell sandbox delete "$sandbox" 2>/dev/null || true
    local channel provider
    for channel in "${CHANNELS[@]}"; do
      while IFS= read -r provider; do
        openshell provider delete "$provider" 2>/dev/null || true
      done < <(provider_names_for_channel "$sandbox" "$channel")
    done
    openshell gateway destroy -g nemoclaw 2>/dev/null || true
  fi
}

install_for_active_agent() {
  local log="/tmp/nemoclaw-e2e-channels-${ACTIVE_AGENT}-install.log"
  export NEMOCLAW_SANDBOX_NAME="$ACTIVE_SANDBOX"
  export NEMOCLAW_AGENT="$ACTIVE_AGENT"
  export NEMOCLAW_POLICY_TIER="${NEMOCLAW_POLICY_TIER:-open}"
  export NEMOCLAW_RECREATE_SANDBOX=1
  export NEMOCLAW_FRESH=1

  if [ -z "${NEMOCLAW_SKIP_TELEGRAM_REACHABILITY:-}" ]; then
    if is_fake_telegram_token "${TELEGRAM_BOT_TOKEN:-}"; then
      export NEMOCLAW_SKIP_TELEGRAM_REACHABILITY=1
      info "Skipping onboarding Telegram reachability probe for fake-token E2E"
    elif ! curl -fsS --max-time 10 https://api.telegram.org/ >/dev/null 2>&1; then
      export NEMOCLAW_SKIP_TELEGRAM_REACHABILITY=1
      info "api.telegram.org unreachable from host; setting NEMOCLAW_SKIP_TELEGRAM_REACHABILITY=1"
    fi
  fi
  if [ -z "${NEMOCLAW_SKIP_SLACK_AUTH_VALIDATION:-}" ] \
    && { is_fake_slack_token "$SLACK_BOT_TOKEN" || is_fake_slack_token "$SLACK_APP_TOKEN"; }; then
    # This E2E normally uses fake Slack tokens to exercise channel lifecycle
    # plumbing, not the live Slack API.
    export NEMOCLAW_SKIP_SLACK_AUTH_VALIDATION=1
    info "Skipping onboarding Slack auth validation for fake-token E2E"
  fi

  info "Running install.sh --non-interactive for ${ACTIVE_AGENT} (${ACTIVE_SANDBOX})..."
  bash install.sh --non-interactive >"$log" 2>&1 &
  local install_pid=$!
  tail -f "$log" --pid=$install_pid 2>/dev/null &
  local tail_pid=$!
  wait $install_pid
  local install_exit=$?
  kill $tail_pid 2>/dev/null || true
  wait $tail_pid 2>/dev/null || true
  cp "$log" /tmp/nemoclaw-e2e-install.log 2>/dev/null || true

  refresh_path

  local msg
  if [ "$install_exit" -eq 0 ]; then
    msg="${ACTIVE_AGENT}: install.sh + onboard completed"
    pass_msg "$msg"
  else
    msg="${ACTIVE_AGENT}: install.sh failed with exit ${install_exit}"
    fail_msg "$msg"
    tail -40 "$log" 2>/dev/null || true
    print_summary
  fi
}

run_rebuild() {
  local phase="$1"
  local log="/tmp/nc-channels-${ACTIVE_AGENT}-rebuild-${phase}.log"
  local msg
  info "Rebuilding ${ACTIVE_SANDBOX} for ${phase}..."
  if nemoclaw "$ACTIVE_SANDBOX" rebuild --yes >"$log" 2>&1; then
    msg="${ACTIVE_AGENT}: rebuild completed after ${phase}"
    pass_msg "$msg"
  else
    msg="${ACTIVE_AGENT}: rebuild failed after ${phase}"
    fail_msg "$msg"
    tail -40 "$log" 2>/dev/null || true
    dump_channel_state
    print_summary
  fi
}

ensure_tokenless_channels_enabled() {
  local added=0
  local channel log rc msg
  for channel in "${TOKENLESS_CHANNELS[@]}"; do
    if registry_plan_channel_contains "$channel"; then
      msg="${ACTIVE_AGENT}/${channel}: tokenless channel already registered"
      pass_msg "$msg"
      continue
    fi
    log="/tmp/nc-channels-${ACTIVE_AGENT}-add-${channel}.log"
    if nemoclaw "$ACTIVE_SANDBOX" channels add "$channel" >"$log" 2>&1; then
      rc=0
    else
      rc=$?
    fi
    cat "$log"
    if [ "$rc" -eq 0 ] && grep -q "Enabled ${channel} channel" "$log"; then
      msg="${ACTIVE_AGENT}/${channel}: channels add registered tokenless QR channel"
      pass_msg "$msg"
      added=1
    else
      msg="${ACTIVE_AGENT}/${channel}: channels add failed or did not register tokenless QR channel"
      fail_msg "$msg"
      tail -30 "$log" 2>/dev/null || true
    fi
  done

  if [ "$added" -eq 1 ]; then
    run_rebuild "add-tokenless-channels"
  fi
}

stop_all_channels() {
  local channel log rc msg
  for channel in "${CHANNELS[@]}"; do
    log="/tmp/nc-channels-${ACTIVE_AGENT}-stop-${channel}.log"
    if nemoclaw "$ACTIVE_SANDBOX" channels stop "$channel" >"$log" 2>&1; then
      rc=0
    else
      rc=$?
    fi
    cat "$log"
    if [ "$rc" -eq 0 ] && grep -q "Marked ${channel} disabled" "$log"; then
      msg="${ACTIVE_AGENT}/${channel}: channels stop registered"
      pass_msg "$msg"
    else
      msg="${ACTIVE_AGENT}/${channel}: channels stop failed or did not register"
      fail_msg "$msg"
      tail -20 "$log" 2>/dev/null || true
    fi
  done
}

start_all_channels() {
  local channel log rc msg
  for channel in "${CHANNELS[@]}"; do
    log="/tmp/nc-channels-${ACTIVE_AGENT}-start-${channel}.log"
    if nemoclaw "$ACTIVE_SANDBOX" channels start "$channel" >"$log" 2>&1; then
      rc=0
    else
      rc=$?
    fi
    cat "$log"
    if [ "$rc" -eq 0 ] && grep -q "Marked ${channel} enabled" "$log"; then
      msg="${ACTIVE_AGENT}/${channel}: channels start registered"
      pass_msg "$msg"
    else
      msg="${ACTIVE_AGENT}/${channel}: channels start failed or did not register"
      fail_msg "$msg"
      tail -20 "$log" 2>/dev/null || true
    fi
  done
}

destroy_completed_sandbox() {
  local sandbox="$1"
  info "Destroying completed sandbox ${sandbox} before the next scenario..."
  if command -v nemoclaw >/dev/null 2>&1; then
    nemoclaw "$sandbox" destroy --yes >/dev/null 2>&1 || true
  fi
  if openshell --version >/dev/null 2>&1; then
    openshell gateway destroy -g nemoclaw >/dev/null 2>&1 || true
  fi
}

run_agent_scenario() {
  local agent="$1"
  local sandbox="$2"
  ACTIVE_AGENT="$agent"
  ACTIVE_SANDBOX="$sandbox"
  export NEMOCLAW_AGENT="$ACTIVE_AGENT"

  section "Scenario: ${agent} all messaging channels"
  pre_cleanup_sandbox "$ACTIVE_SANDBOX"
  export_fake_channel_env "${agent}"

  cd "$REPO" || exit 1
  install_for_active_agent

  local msg
  if ! openshell --version >/dev/null 2>&1; then
    msg="${ACTIVE_AGENT}: openshell not on PATH after install"
    fail_msg "$msg"
    print_summary
  fi
  msg="${ACTIVE_AGENT}: openshell installed"
  pass_msg "$msg"

  if ! command -v nemoclaw >/dev/null 2>&1; then
    msg="${ACTIVE_AGENT}: nemoclaw not on PATH after install"
    fail_msg "$msg"
    print_summary
  fi
  msg="${ACTIVE_AGENT}: nemoclaw installed"
  pass_msg "$msg"

  if openshell sandbox list 2>&1 | grep -q "${ACTIVE_SANDBOX}.*Ready"; then
    msg="${ACTIVE_AGENT}: sandbox ${ACTIVE_SANDBOX} is Ready"
    pass_msg "$msg"
  else
    msg="${ACTIVE_AGENT}: sandbox ${ACTIVE_SANDBOX} is not Ready"
    fail_msg "$msg"
    openshell sandbox list 2>&1 || true
    print_summary
  fi

  ensure_tokenless_channels_enabled

  section "${agent}: baseline with all channels active"
  assert_provider_records_exist "at baseline"
  assert_all_config_channels "present" "at baseline"
  assert_registry_channels "present" "at baseline"
  assert_disabled_channels "absent" "at baseline"
  assert_host_messaging_config "at baseline"
  assert_host_messaging_plan_state "active" "at baseline"
  for channel in "${CHANNELS[@]}"; do
    assert_policy_preset_active "$channel" "active" "at baseline"
  done

  section "${agent}: channels stop all + rebuild"
  stop_all_channels
  assert_host_messaging_config "after channels stop"
  assert_host_messaging_plan_state "disabled" "after channels stop"
  run_rebuild "stop-all"

  section "${agent}: verify stopped state"
  assert_all_config_channels "absent" "after stop+rebuild"
  assert_registry_channels "present" "after stop"
  assert_disabled_channels "present" "after stop"
  assert_provider_records_exist "after stop"
  assert_host_messaging_config "after stop+rebuild"
  assert_host_messaging_plan_state "disabled" "after stop+rebuild"

  section "${agent}: channels start all + rebuild"
  start_all_channels
  assert_host_messaging_config "after channels start"
  assert_host_messaging_plan_state "active" "after channels start"
  run_rebuild "start-all"

  section "${agent}: verify restarted state"
  assert_all_config_channels "present" "after start+rebuild"
  assert_registry_channels "present" "after start"
  assert_disabled_channels "absent" "after start"
  assert_provider_records_exist "after start"
  assert_host_messaging_config "after start+rebuild"
  assert_host_messaging_plan_state "active" "after start+rebuild"
}

section "Phase 0: Prerequisites"

if [ -z "${NVIDIA_INFERENCE_API_KEY:-}" ]; then
  msg="C0: NVIDIA_INFERENCE_API_KEY is required"
  fail_msg "$msg"
  print_summary
fi
msg="C0: NVIDIA_INFERENCE_API_KEY is set"
pass_msg "$msg"

if [ "${NEMOCLAW_NON_INTERACTIVE:-}" != "1" ]; then
  msg="C0: NEMOCLAW_NON_INTERACTIVE=1 is required"
  fail_msg "$msg"
  print_summary
fi
msg="C0: NEMOCLAW_NON_INTERACTIVE=1 is set"
pass_msg "$msg"

if [ "${NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE:-}" != "1" ]; then
  msg="C0: NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 is required"
  fail_msg "$msg"
  print_summary
fi
msg="C0: NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 is set"
pass_msg "$msg"

if docker info >/dev/null 2>&1; then
  msg="C0: Docker is running"
  pass_msg "$msg"
else
  msg="C0: Docker is not running"
  fail_msg "$msg"
  print_summary
fi

refresh_path

for index in "${!SELECTED_AGENT_SCENARIOS[@]}"; do
  scenario="${SELECTED_AGENT_SCENARIOS[$index]}"
  run_agent_scenario "${scenario%%:*}" "${scenario#*:}"
  if [ "$index" -lt "$((${#SELECTED_AGENT_SCENARIOS[@]} - 1))" ]; then
    destroy_completed_sandbox "${scenario#*:}"
  fi
done

print_summary
