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
#   6. Native Discord gateway path — WebSocket path is probed separately from REST
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
#   TELEGRAM_CHAT_ID_E2E                   — optional: enables sendMessage test
#   NEMOCLAW_E2E_STRICT_DISCORD_GATEWAY    — fail instead of skip on known Discord gateway blockers
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

# Default to fake tokens if not provided
TELEGRAM_TOKEN="${TELEGRAM_BOT_TOKEN:-test-fake-telegram-token-e2e}"
DISCORD_TOKEN="${DISCORD_BOT_TOKEN:-test-fake-discord-token-e2e}"
TELEGRAM_IDS="${TELEGRAM_ALLOWED_IDS:-123456789,987654321}"
export TELEGRAM_BOT_TOKEN="$TELEGRAM_TOKEN"
export DISCORD_BOT_TOKEN="$DISCORD_TOKEN"
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
info "Sandbox name: $SANDBOX_NAME"
STRICT_DISCORD_GATEWAY="${NEMOCLAW_E2E_STRICT_DISCORD_GATEWAY:-0}"

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
if command -v openshell >/dev/null 2>&1; then
  openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true
  openshell gateway destroy -g nemoclaw 2>/dev/null || true
fi
pass "Pre-cleanup complete"

# Run install.sh --non-interactive which installs Node.js, openshell,
# NemoClaw, and runs onboard. Messaging tokens are already exported so
# the onboard step creates providers and attaches them to the sandbox.
info "Running install.sh --non-interactive..."
info "This installs Node.js, openshell, NemoClaw, and runs onboard with messaging providers."
info "Expected duration: 5-10 minutes on first run."

export NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME"
export NEMOCLAW_RECREATE_SANDBOX=1

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
if ! command -v openshell >/dev/null 2>&1; then
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

# M13b: Probe the native Discord gateway path separately from REST.
# This catches failures where REST succeeds but the WebSocket path still fails
# (for example EAI_AGAIN on gateway.discord.gg or proxy misuse returning 400).
dc_gateway=$(sandbox_exec 'node -e "
const url = \"wss://gateway.discord.gg/?v=10&encoding=json\";
if (typeof WebSocket !== \"function\") {
  console.log(\"UNSUPPORTED WebSocket\");
  process.exit(0);
}
const ws = new WebSocket(url);
const done = (msg) => {
  console.log(msg);
  try { ws.close(); } catch {}
  setTimeout(() => process.exit(0), 50);
};
const timer = setTimeout(() => done(\"TIMEOUT\"), 15000);
ws.addEventListener(\"open\", () => console.log(\"OPEN\"));
ws.addEventListener(\"message\", (event) => {
  clearTimeout(timer);
  const body = String(event.data || \"\").slice(0, 200).replace(/\\s+/g, \" \");
  done(\"MESSAGE \" + body);
});
ws.addEventListener(\"error\", (event) => {
  clearTimeout(timer);
  const msg = event?.message || event?.error?.message || \"websocket_error\";
  done(\"ERROR \" + msg);
});
ws.addEventListener(\"close\", (event) => {
  if (event.code && event.code !== 1000) console.log(\"CLOSE \" + event.code);
});
"' 2>/dev/null || true)

info "Discord gateway probe: ${dc_gateway:0:300}"

if echo "$dc_gateway" | grep -q "MESSAGE "; then
  pass "M13b: Native Discord gateway returned a WebSocket message"
elif echo "$dc_gateway" | grep -qiE "EAI_AGAIN|getaddrinfo"; then
  if [ "$STRICT_DISCORD_GATEWAY" = "1" ]; then
    fail "M13b: Native Discord gateway hit DNS resolution failure (${dc_gateway:0:200})"
  else
    skip "M13b: Native Discord gateway hit DNS resolution failure (${dc_gateway:0:200})"
  fi
elif echo "$dc_gateway" | grep -q "400"; then
  if [ "$STRICT_DISCORD_GATEWAY" = "1" ]; then
    fail "M13b: Native Discord gateway probe returned 400 (${dc_gateway:0:200})"
  else
    skip "M13b: Native Discord gateway probe returned 400 (${dc_gateway:0:200})"
  fi
elif echo "$dc_gateway" | grep -q "UNSUPPORTED"; then
  skip "M13b: WebSocket runtime unsupported in sandbox Node.js"
elif echo "$dc_gateway" | grep -q "TIMEOUT"; then
  if [ "$STRICT_DISCORD_GATEWAY" = "1" ]; then
    fail "M13b: Native Discord gateway probe timed out"
  else
    skip "M13b: Native Discord gateway probe timed out"
  fi
elif echo "$dc_gateway" | grep -q "ERROR"; then
  if [ "$STRICT_DISCORD_GATEWAY" = "1" ]; then
    fail "M13b: Native Discord gateway probe failed (${dc_gateway:0:200})"
  else
    skip "M13b: Native Discord gateway probe failed (${dc_gateway:0:200})"
  fi
elif echo "$dc_gateway" | grep -q "CLOSE"; then
  if [ "$STRICT_DISCORD_GATEWAY" = "1" ]; then
    fail "M13b: Native Discord gateway probe closed abnormally (${dc_gateway:0:200})"
  else
    skip "M13b: Native Discord gateway probe closed abnormally (${dc_gateway:0:200})"
  fi
elif echo "$dc_gateway" | grep -q "OPEN"; then
  pass "M13b: Native Discord gateway opened a WebSocket session"
else
  if [ "$STRICT_DISCORD_GATEWAY" = "1" ]; then
    fail "M13b: Native Discord gateway probe returned an unclassified result (${dc_gateway:0:200})"
  else
    skip "M13b: Native Discord gateway probe returned an unclassified result (${dc_gateway:0:200})"
  fi
fi

# M13c: Full Discord gateway handshake via ws-proxy-fix CONNECT tunnel (#1570).
# The `ws` library opens WebSocket connections via https.request() with an
# Upgrade: websocket header.  The preload patches https.request() to issue a
# CONNECT tunnel for Discord gateway hosts.
#
# This test exercises the real Discord gateway protocol end-to-end:
#   1. https.request with Upgrade: websocket → CONNECT tunnel via proxy
#   2. Receive Discord Hello (opcode 10) with heartbeat_interval
#   3. Send a Heartbeat (opcode 1) back to the gateway
#   4. Receive Heartbeat ACK (opcode 11)
#   5. Send close frame and disconnect cleanly
#
# If the CONNECT tunnel is broken the connection never upgrades (400 from L7
# proxy) and none of the protocol steps succeed.
dc_ws_tunnel=$(sandbox_exec 'node -e "
const https = require(\"https\");
const crypto = require(\"crypto\");

// --- Minimal WebSocket framing (no ws dependency) ---
function unmaskFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let payloadLen = buf[1] & 0x7f;
  let offset = 2;
  if (payloadLen === 126) {
    if (buf.length < 4) return null;
    payloadLen = buf.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buf.length < 10) return null;
    payloadLen = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  if (masked) offset += 4;
  if (buf.length < offset + payloadLen) return null;
  const data = buf.slice(offset, offset + payloadLen);
  return { fin, opcode, data, totalLen: offset + payloadLen };
}

function makeFrame(opcode, payload) {
  const buf = Buffer.from(payload);
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) masked[i] = buf[i] ^ mask[i % 4];
  let header;
  if (buf.length < 126) {
    header = Buffer.alloc(6);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | buf.length;
    mask.copy(header, 2);
  } else {
    header = Buffer.alloc(8);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(buf.length, 2);
    mask.copy(header, 4);
  }
  return Buffer.concat([header, masked]);
}

function makeCloseFrame(code) {
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code, 0);
  return makeFrame(8, payload);
}

// --- Handshake ---
const results = [];
const done = () => {
  console.log(results.join(\"\\n\"));
  process.exit(0);
};
const timer = setTimeout(() => { results.push(\"TIMEOUT\"); done(); }, 20000);

const key = crypto.randomBytes(16).toString(\"base64\");
const req = https.request({
  hostname: \"gateway.discord.gg\",
  port: 443,
  path: \"/?v=10&encoding=json\",
  method: \"GET\",
  headers: {
    \"Connection\": \"Upgrade\",
    \"Upgrade\": \"websocket\",
    \"Sec-WebSocket-Key\": key,
    \"Sec-WebSocket-Version\": \"13\",
  },
});

req.on(\"upgrade\", (_res, socket, head) => {
  results.push(\"UPGRADED\");
  let pending = head && head.length ? Buffer.from(head) : Buffer.alloc(0);

  socket.on(\"data\", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (true) {
      const frame = unmaskFrame(pending);
      if (!frame) break;
      pending = pending.slice(frame.totalLen);

      if (frame.opcode === 1) {
        let msg;
        try { msg = JSON.parse(frame.data.toString()); } catch { continue; }

        if (msg.op === 10) {
          const hbInterval = msg.d && msg.d.heartbeat_interval;
          results.push(\"HELLO op=10 heartbeat_interval=\" + hbInterval);

          // Send Heartbeat (opcode 1, d: null)
          const hb = JSON.stringify({ op: 1, d: null });
          socket.write(makeFrame(1, hb));
          results.push(\"SENT_HEARTBEAT op=1\");
        } else if (msg.op === 11) {
          results.push(\"HEARTBEAT_ACK op=11\");
          // Full round-trip complete — close cleanly
          socket.write(makeCloseFrame(1000));
          setTimeout(() => { socket.destroy(); clearTimeout(timer); done(); }, 500);
        }
      } else if (frame.opcode === 8) {
        results.push(\"CLOSE_FRAME code=\" + (frame.data.length >= 2 ? frame.data.readUInt16BE(0) : \"none\"));
        socket.destroy();
        clearTimeout(timer);
        done();
      }
    }
  });

  socket.on(\"error\", (e) => { results.push(\"SOCKET_ERROR \" + e.message); });
  socket.on(\"close\", () => { clearTimeout(timer); done(); });
});

req.on(\"response\", (res) => {
  results.push(\"HTTP_\" + res.statusCode);
  res.resume();
  res.on(\"end\", () => { clearTimeout(timer); done(); });
});
req.on(\"error\", (e) => {
  results.push(\"ERROR \" + e.message);
  clearTimeout(timer);
  done();
});
req.end();
"' 2>/dev/null || true)

info "Discord ws-proxy-fix probe: ${dc_ws_tunnel:0:500}"

# Check each step of the handshake independently
if echo "$dc_ws_tunnel" | grep -q "UPGRADED"; then
  pass "M13c: WebSocket upgrade succeeded via CONNECT tunnel (#1570)"
elif echo "$dc_ws_tunnel" | grep -q "HTTP_400"; then
  if [ "$STRICT_DISCORD_GATEWAY" = "1" ]; then
    fail "M13c: Discord gateway got 400 — CONNECT tunnel not working"
  else
    skip "M13c: Discord gateway got 400 — ws-proxy-fix may not be active"
  fi
elif echo "$dc_ws_tunnel" | grep -qiE "EAI_AGAIN|getaddrinfo"; then
  if [ "$STRICT_DISCORD_GATEWAY" = "1" ]; then
    fail "M13c: Discord gateway DNS failure (${dc_ws_tunnel:0:200})"
  else
    skip "M13c: Discord gateway DNS failure (${dc_ws_tunnel:0:200})"
  fi
elif echo "$dc_ws_tunnel" | grep -q "TIMEOUT"; then
  if [ "$STRICT_DISCORD_GATEWAY" = "1" ]; then
    fail "M13c: Discord gateway CONNECT tunnel timed out"
  else
    skip "M13c: Discord gateway CONNECT tunnel timed out"
  fi
elif echo "$dc_ws_tunnel" | grep -q "ERROR"; then
  if [ "$STRICT_DISCORD_GATEWAY" = "1" ]; then
    fail "M13c: Discord gateway CONNECT tunnel failed (${dc_ws_tunnel:0:200})"
  else
    skip "M13c: Discord gateway CONNECT tunnel failed (${dc_ws_tunnel:0:200})"
  fi
else
  if [ "$STRICT_DISCORD_GATEWAY" = "1" ]; then
    fail "M13c: Discord gateway returned unclassified result (${dc_ws_tunnel:0:200})"
  else
    skip "M13c: Discord gateway returned unclassified result (${dc_ws_tunnel:0:200})"
  fi
fi

if echo "$dc_ws_tunnel" | grep -q "HELLO op=10"; then
  pass "M13d: Received Discord Hello (opcode 10) with heartbeat interval"
elif echo "$dc_ws_tunnel" | grep -q "UPGRADED"; then
  fail "M13d: Upgraded but never received Discord Hello"
else
  skip "M13d: WebSocket upgrade did not complete"
fi

if echo "$dc_ws_tunnel" | grep -q "HEARTBEAT_ACK op=11"; then
  pass "M13e: Sent Heartbeat, received ACK (opcode 11) — full round-trip verified"
elif echo "$dc_ws_tunnel" | grep -q "SENT_HEARTBEAT"; then
  fail "M13e: Sent Heartbeat but never received ACK"
else
  skip "M13e: Heartbeat exchange did not occur"
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
# Phase 7: Cleanup
# ══════════════════════════════════════════════════════════════════
section "Phase 7: Cleanup"

info "Destroying sandbox '$SANDBOX_NAME'..."
nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true
openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true

# Verify cleanup
if openshell sandbox list 2>&1 | grep -q "$SANDBOX_NAME"; then
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
