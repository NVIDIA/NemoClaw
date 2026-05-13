#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# shellcheck disable=SC2016,SC2034
# SC2016: Single-quoted strings are intentional — Node.js code passed via SSH.
# SC2034: Some variables are used indirectly or reserved for later phases.

# Messaging Credential Provider E2E Tests
#
# Validates that messaging credentials (Telegram, Discord) flow correctly
# through the OpenShell provider/placeholder/L7-proxy pipeline. Tests every
# layer of the chain introduced in PR #1081:
#
#   1. Provider creation — openshell stores the real token
#   2. Sandbox attachment — --provider flags wire providers to the sandbox
#   3. Credential isolation — real tokens never appear in sandbox env,
#      process list, or filesystem
#   4. Config patching — openclaw.json channels use placeholder values
#   5. Network reachability — Node.js can reach messaging APIs through proxy
#   6. Native Discord gateway path — WebSocket L7 path is tested hermetically
#   7. L7 proxy rewriting — placeholder is rewritten to real token at egress
#
# Uses fake tokens by default (no external accounts needed). With fake tokens,
# the API returns 401 — proving the full chain worked (request reached the
# real API with the token rewritten). Optional real tokens enable a bonus
# round-trip phase.
#
# Prerequisites:
#   - Docker running
#   - NemoClaw installed (install.sh or brev-setup.sh already ran)
#   - NVIDIA_API_KEY set
#   - openshell on PATH
#
# Environment variables:
#   NVIDIA_API_KEY                         — required
#   NEMOCLAW_NON_INTERACTIVE=1             — required
#   NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 — required
#   NEMOCLAW_SANDBOX_NAME                  — sandbox name (default: e2e-msg-provider)
#   TELEGRAM_BOT_TOKEN                     — defaults to fake token
#   DISCORD_BOT_TOKEN                      — defaults to fake token
#   TELEGRAM_ALLOWED_IDS                   — comma-separated Telegram user IDs for DM allowlisting
#   TELEGRAM_BOT_TOKEN_REAL                — optional: enables Phase 6 real round-trip
#   DISCORD_BOT_TOKEN_REAL                 — optional: enables Phase 6 real round-trip
#   SLACK_BOT_TOKEN                        — defaults to fake token (xoxb-fake-...)
#   SLACK_APP_TOKEN                        — defaults to fake token (xapp-fake-...)
#   SLACK_BOT_TOKEN_REVOKED                — optional: revoked xoxb- token to test auth pre-validation (#2340)
#   SLACK_APP_TOKEN_REVOKED                — optional: paired xapp- token for the revoked bot token
#   TELEGRAM_CHAT_ID_E2E                   — optional: enables sendMessage test
#   NEMOCLAW_OPENSHELL_BIN                 — optional OpenShell binary under test
#   NEMOCLAW_FRESH=1                       — auto-set to discard interrupted onboard sessions
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
#     NVIDIA_API_KEY=nvapi-... bash test/e2e/test-messaging-providers.sh
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

openshell() {
  if [ "$OPENSHELL_BIN" = "openshell" ]; then
    command openshell "$@"
  else
    "$OPENSHELL_BIN" "$@"
  fi
}

# shellcheck source=test/e2e/lib/sandbox-teardown.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/sandbox-teardown.sh"
register_sandbox_for_teardown "$SANDBOX_NAME"

# Default to fake tokens if not provided
TELEGRAM_TOKEN="${TELEGRAM_BOT_TOKEN:-test-fake-telegram-token-e2e}"
DISCORD_TOKEN="${DISCORD_BOT_TOKEN:-test-fake-discord-token-e2e}"
SLACK_TOKEN="${SLACK_BOT_TOKEN:-xoxb-fake-slack-token-e2e}"
SLACK_APP="${SLACK_APP_TOKEN:-xapp-fake-slack-app-token-e2e}"
TELEGRAM_IDS="${TELEGRAM_ALLOWED_IDS:-123456789,987654321}"
export TELEGRAM_BOT_TOKEN="$TELEGRAM_TOKEN"
export DISCORD_BOT_TOKEN="$DISCORD_TOKEN"
export SLACK_BOT_TOKEN="$SLACK_TOKEN"
export SLACK_APP_TOKEN="$SLACK_APP"
export TELEGRAM_ALLOWED_IDS="$TELEGRAM_IDS"

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

# shellcheck source=test/e2e/lib/discord-gateway-proof.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/discord-gateway-proof.sh"
# shellcheck source=test/e2e/lib/slack-api-proof.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/slack-api-proof.sh"

# ══════════════════════════════════════════════════════════════════
# Phase 0: Prerequisites
# ══════════════════════════════════════════════════════════════════
section "Phase 0: Prerequisites"

if [ -z "${NVIDIA_API_KEY:-}" ]; then
  fail "NVIDIA_API_KEY not set"
  exit 1
fi
pass "NVIDIA_API_KEY is set"

if ! docker info >/dev/null 2>&1; then
  fail "Docker is not running"
  exit 1
fi
pass "Docker is running"

info "Telegram token: ${TELEGRAM_TOKEN:0:10}... (${#TELEGRAM_TOKEN} chars)"
info "Discord token: ${DISCORD_TOKEN:0:10}... (${#DISCORD_TOKEN} chars)"
info "Slack bot token: configured (${#SLACK_TOKEN} chars)"
info "Slack app token: configured (${#SLACK_APP} chars)"
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
  if ! curl -fsS --max-time 10 https://api.telegram.org/ >/dev/null 2>&1; then
    export NEMOCLAW_SKIP_TELEGRAM_REACHABILITY=1
    info "Host cannot reach api.telegram.org; skipping onboarding Telegram reachability probe for fake-token E2E"
  fi
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

# ══════════════════════════════════════════════════════════════════
# Phase 3: Config Patching — openclaw.json channels
# ══════════════════════════════════════════════════════════════════
section "Phase 3: Config Patching Verification"

# Read openclaw.json and extract channel config
channel_json=$(sandbox_exec "python3 -c \"
import json, sys
try:
    cfg = json.load(open('/sandbox/.openclaw/openclaw.json'))
    channels = cfg.get('channels', {})
    print(json.dumps(channels))
except Exception as e:
    print(json.dumps({'error': str(e)}))
\"" 2>/dev/null || true)

if [ -z "$channel_json" ] || echo "$channel_json" | grep -q '"error"'; then
  fail "M6: Could not read openclaw.json channels (${channel_json:0:200})"
else
  info "Channel config: ${channel_json:0:300}"

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

  # M7: Telegram token is NOT the real/fake host token
  if [ -n "$tg_token" ] && [ "$tg_token" != "$TELEGRAM_TOKEN" ]; then
    pass "M7: Telegram botToken is not the host-side token (placeholder confirmed)"
  elif [ -n "$tg_token" ]; then
    fail "M7: Telegram botToken matches host-side token — credential leaked into config!"
  else
    skip "M7: No Telegram botToken to check"
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

    # Diagnostics: check if the guard was installed and what NODE_OPTIONS looks like
    info "Checking guard installation diagnostics:"
    guard_exists=$(openshell sandbox exec --name "$SANDBOX_NAME" -- ls -la /tmp/nemoclaw-slack-channel-guard.js 2>/dev/null || echo "EXEC_FAILED")
    info "  Guard file: $guard_exists"
    node_opts=$(openshell sandbox exec --name "$SANDBOX_NAME" -- bash -c 'echo "$NODE_OPTIONS"' 2>/dev/null || echo "EXEC_FAILED")
    info "  NODE_OPTIONS: $node_opts"
  else
    skip "M11e: No Slack channel in config"
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

# M13: Node.js can reach discord.com through the proxy
dc_reach=$(sandbox_exec 'node -e "
const https = require(\"https\");
const req = https.get(\"https://discord.com/api/v10/gateway\", (res) => {
  console.log(\"HTTP_\" + res.statusCode);
  res.resume();
});
req.on(\"error\", (e) => console.log(\"ERROR: \" + e.message));
req.setTimeout(15000, () => { req.destroy(); console.log(\"TIMEOUT\"); });
"' 2>/dev/null || true)

if echo "$dc_reach" | grep -q "HTTP_"; then
  pass "M13: Node.js reached discord.com (${dc_reach})"
elif echo "$dc_reach" | grep -q "TIMEOUT"; then
  skip "M13: discord.com timed out (network may be slow)"
else
  fail "M13: Node.js could not reach discord.com (${dc_reach:0:200})"
fi

# M13b-M13f: Hermetic Discord Gateway over OpenShell's native WebSocket L7 path.
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

# ══════════════════════════════════════════════════════════════════
# Phase 6: Real API Round-Trip (Optional)
# ══════════════════════════════════════════════════════════════════
section "Phase 6: Real API Round-Trip (Optional)"

if [ -n "${TELEGRAM_BOT_TOKEN_REAL:-}" ]; then
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

  # M19: sendMessage if chat ID is available
  if [ -n "${TELEGRAM_CHAT_ID_E2E:-}" ]; then
    info "Sending test message to chat ${TELEGRAM_CHAT_ID_E2E}..."
    send_result=$(sandbox_exec "node -e \"
const https = require('https');
const token = process.env.TELEGRAM_BOT_TOKEN || '';
const chatId = '${TELEGRAM_CHAT_ID_E2E}';
const msg = 'NemoClaw E2E test ' + new Date().toISOString();
const data = JSON.stringify({ chat_id: chatId, text: msg });
const options = {
  hostname: 'api.telegram.org',
  path: '/bot' + token + '/sendMessage',
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
};
const req = https.request(options, (res) => {
  let body = '';
  res.on('data', (d) => body += d);
  res.on('end', () => console.log(res.statusCode + ' ' + body.slice(0, 300)));
});
req.on('error', (e) => console.log('ERROR: ' + e.message));
req.setTimeout(30000, () => { req.destroy(); console.log('TIMEOUT'); });
req.write(data);
req.end();
\"" 2>/dev/null || true)

    if echo "$send_result" | grep -q "^200"; then
      pass "M19: Telegram sendMessage succeeded"
    else
      fail "M19: Telegram sendMessage failed: ${send_result:0:200}"
    fi
  else
    skip "M19: TELEGRAM_CHAT_ID_E2E not set — skipping sendMessage test"
  fi
else
  skip "M18: TELEGRAM_BOT_TOKEN_REAL not set — skipping real Telegram round-trip"
  skip "M19: TELEGRAM_BOT_TOKEN_REAL not set — skipping sendMessage test"
fi

if [ -n "${DISCORD_BOT_TOKEN_REAL:-}" ]; then
  if [ "$dc_status" = "200" ]; then
    pass "M20: Discord users/@me returned 200 with real token"
  else
    fail "M20: Expected Discord users/@me 200 with real token, got: $dc_status"
  fi
else
  skip "M20: DISCORD_BOT_TOKEN_REAL not set — skipping real Discord round-trip"
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
