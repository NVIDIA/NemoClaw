#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# OpenClaw Discord pairing E2E (#4061).
#
# This keeps Discord hermetic while covering the failure boundary from the
# macOS report:
#   1. Discord is configured with a provider-backed token and managed proxy.
#   2. A Discord-shaped gateway probe reaches a fake Gateway through OpenShell
#      and proves placeholder-to-token rewrite.
#   3. OpenClaw's runtime writes a Discord pending pairing request into the
#      shared state root.
#   4. Connect-shell `openclaw pairing approve discord <code>` finds and
#      approves that request.
#   5. Approval creates the Discord allowFrom store entry where OpenClaw reads it.
#
# Environment variables:
#   NEMOCLAW_NON_INTERACTIVE=1              - required
#   NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 - required
#   NVIDIA_INFERENCE_API_KEY                         - required for onboarding
#   NEMOCLAW_SANDBOX_NAME                  - sandbox name (default: e2e-openclaw-discord-pairing)
#   DISCORD_BOT_TOKEN                      - defaults to a fake token
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
#     NVIDIA_INFERENCE_API_KEY=nvapi-... bash test/e2e/test-openclaw-discord-pairing.sh

# shellcheck disable=SC2016,SC2329
# SC2016: Single-quoted strings are intentional for commands evaluated inside
# the sandbox rather than on the host.
# SC2329: sandbox_exec_stdin is used by sourced Discord helper functions.

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

run_with_timeout() {
  local seconds="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$seconds" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$seconds" "$@"
  else
    "$@"
  fi
}

require_timeout_command() {
  if command -v timeout >/dev/null 2>&1 || command -v gtimeout >/dev/null 2>&1; then
    return 0
  fi
  fail "Neither timeout nor gtimeout is available; cannot enforce INSTALL_TIMEOUT_SECONDS"
  exit 1
}

if [ -d /workspace ] && [ -f /workspace/install.sh ]; then
  REPO="/workspace"
elif [ -f "$(cd "$(dirname "$0")/../.." && pwd)/install.sh" ]; then
  REPO="$(cd "$(dirname "$0")/../.." && pwd)"
else
  echo "ERROR: Cannot find repo root."
  exit 1
fi

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-openclaw-discord-pairing}"
OPENSHELL_BIN="${NEMOCLAW_OPENSHELL_BIN:-openshell}"
DISCORD_TOKEN="${DISCORD_BOT_TOKEN:-test-fake-discord-pairing-e2e}"
DISCORD_PAIRING_USER="${NEMOCLAW_DISCORD_PAIRING_USER:-1005536447329222676}"
DISCORD_DM_CHANNEL="${NEMOCLAW_DISCORD_DM_CHANNEL:-1199988877766655554}"

export NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME"
export NEMOCLAW_RECREATE_SANDBOX=1
export NEMOCLAW_FRESH=1
export NEMOCLAW_POLICY_TIER="${NEMOCLAW_POLICY_TIER:-open}"
export DISCORD_BOT_TOKEN="$DISCORD_TOKEN"
# The issue path is the pairing flow. Do not seed an allowlist that would bypass
# pairing and hide this regression.
unset DISCORD_ALLOWED_IDS
unset DISCORD_USER_ID

openshell() {
  if [ "$OPENSHELL_BIN" = "openshell" ]; then
    command openshell "$@"
  else
    "$OPENSHELL_BIN" "$@"
  fi
}

sandbox_exec() {
  local cmd="$1"
  local ssh_config
  ssh_config="$(mktemp)"
  openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_config" 2>/dev/null

  local result status
  result=$(run_with_timeout 60 ssh -F "$ssh_config" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 \
    -o LogLevel=ERROR \
    "openshell-${SANDBOX_NAME}" \
    "$cmd" \
    2>&1)
  status=$?

  rm -f "$ssh_config"
  printf '%s\n' "$result"
  return "$status"
}

sandbox_exec_stdin() {
  local cmd="$1"
  local ssh_config
  ssh_config="$(mktemp)"
  openshell sandbox ssh-config "$SANDBOX_NAME" >"$ssh_config" 2>/dev/null

  local result status
  result=$(run_with_timeout 60 ssh -F "$ssh_config" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=10 \
    -o LogLevel=ERROR \
    "openshell-${SANDBOX_NAME}" \
    "$cmd" \
    2>/dev/null)
  status=$?

  rm -f "$ssh_config"
  printf '%s\n' "$result"
  return "$status"
}

quote_for_remote_sh() {
  local value="${1:-}"
  printf "'%s'" "$(printf '%s' "$value" | sed "s/'/'\\\\''/g")"
}

sandbox_exec_sh_script() {
  local script="$1"
  shift
  local encoded remote_cmd arg
  encoded="$(printf '%s' "$script" | base64 | tr -d '\n')"
  remote_cmd="tmp=\$(mktemp); trap 'rm -f \"\$tmp\"' EXIT; printf %s $(quote_for_remote_sh "$encoded") | base64 -d > \"\$tmp\"; sh \"\$tmp\""
  for arg in "$@"; do
    remote_cmd+=" $(quote_for_remote_sh "$arg")"
  done
  run_with_timeout 60 openshell sandbox exec --name "$SANDBOX_NAME" -- sh -lc "$remote_cmd"
}

# shellcheck source=test/e2e/lib/sandbox-teardown.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/sandbox-teardown.sh"
register_sandbox_for_teardown "$SANDBOX_NAME"

# shellcheck source=test/e2e/lib/discord-gateway-proof.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/discord-gateway-proof.sh"

check_fake_discord_gateway_capture() {
  node - "$FAKE_DISCORD_GATEWAY_CAPTURE_FILE" "$DISCORD_TOKEN" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const expected = process.argv[3];
const rows = fs
  .readFileSync(file, "utf8")
  .trim()
  .split(/\n+/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const identify = rows.filter((row) => row.event === "identify").at(-1);
if (!identify) {
  console.log("NO_IDENTIFY");
  process.exit(2);
}
if (identify.tokenMatchesExpected !== true || identify.token !== expected) {
  console.log("BAD_TOKEN_REWRITE");
  process.exit(3);
}
if (identify.tokenLooksPlaceholder) {
  console.log("PLACEHOLDER_LEAK");
  process.exit(4);
}
console.log("OK");
NODE
}

section "Phase 0: Prerequisites"

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

info "Sandbox name: $SANDBOX_NAME"
info "Discord token: configured (${#DISCORD_TOKEN} chars)"
info "Discord pairing user: $DISCORD_PAIRING_USER"

section "Phase 1: Install NemoClaw with Discord enabled"

cd "$REPO" || exit 1

info "Pre-cleanup..."
if command -v nemoclaw >/dev/null 2>&1; then
  nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true
fi
if openshell --version >/dev/null 2>&1; then
  openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true
  if [[ "${CI:-}" = "true" || "${NEMOCLAW_E2E_DESTROY_GATEWAY:-}" = "1" ]]; then
    openshell gateway destroy -g nemoclaw 2>/dev/null || true
  fi
fi
pass "Pre-cleanup complete"

INSTALL_LOG="/tmp/nemoclaw-e2e-openclaw-discord-pairing-install.log"
INSTALL_TIMEOUT_SECONDS="${NEMOCLAW_E2E_INSTALL_TIMEOUT_SECONDS:-1800}"
require_timeout_command
info "Running install.sh --non-interactive..."
run_with_timeout "$INSTALL_TIMEOUT_SECONDS" bash install.sh --non-interactive >"$INSTALL_LOG" 2>&1 &
install_pid=$!
tail -f "$INSTALL_LOG" --pid=$install_pid 2>/dev/null &
tail_pid=$!
wait $install_pid
install_exit=$?
kill $tail_pid 2>/dev/null || true
wait $tail_pid 2>/dev/null || true

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
  pass "Install completed"
else
  fail "install.sh failed (exit $install_exit)"
  info "Last 40 lines of install log:"
  tail -40 "$INSTALL_LOG" 2>/dev/null || true
  exit 1
fi

sandbox_list=$(openshell sandbox list 2>&1 || true)
if echo "$sandbox_list" | grep -q "$SANDBOX_NAME.*Ready"; then
  pass "Sandbox '$SANDBOX_NAME' is Ready"
else
  fail "Sandbox '$SANDBOX_NAME' not Ready (list: ${sandbox_list:0:300})"
  exit 1
fi

if openshell provider get "${SANDBOX_NAME}-discord-bridge" >/dev/null 2>&1; then
  pass "Discord provider exists in OpenShell"
else
  fail "Discord provider missing in OpenShell"
fi

discord_config_check=$(sandbox_exec "python3 - <<'PY'
import json
cfg = json.load(open('/sandbox/.openclaw/openclaw.json'))
account = (cfg.get('channels', {}).get('discord', {}).get('accounts', {}).get('default') or {})
proxy = cfg.get('proxy') or {}
print(json.dumps({
    'hasToken': bool(account.get('token')),
    'token': account.get('token', ''),
    'dmPolicy': account.get('dmPolicy', ''),
    'allowFrom': account.get('allowFrom', []),
    'accountProxy': account.get('proxy', ''),
    'managedProxy': proxy.get('proxyUrl', '') if proxy.get('enabled') is True else '',
}))
PY")
info "Discord config summary: ${discord_config_check:0:500}"
if echo "$discord_config_check" | grep -q '"hasToken": true' \
  && echo "$discord_config_check" | grep -Eq 'openshell:resolve:env:[^"]*DISCORD_BOT_TOKEN' \
  && ! echo "$discord_config_check" | grep -q '"dmPolicy": "allowlist"'; then
  pass "Discord config uses a placeholder token and remains on pairing policy"
else
  fail "Discord config is not set up for pairing: ${discord_config_check:0:500}"
fi

section "Phase 2: Runtime state root contract"

state_env=$(sandbox_exec 'printf "OPENCLAW_HOME=%s\nOPENCLAW_STATE_DIR=%s\nOPENCLAW_CONFIG_PATH=%s\nOPENCLAW_OAUTH_DIR=%s\n" "$OPENCLAW_HOME" "$OPENCLAW_STATE_DIR" "$OPENCLAW_CONFIG_PATH" "$OPENCLAW_OAUTH_DIR"')
state_env_status=$?
info "OpenClaw env from connect shell: ${state_env//$'\n'/; }"
if [ $state_env_status -eq 0 ] \
  && echo "$state_env" | grep -q '^OPENCLAW_HOME=/sandbox$' \
  && echo "$state_env" | grep -q '^OPENCLAW_STATE_DIR=/sandbox/.openclaw$' \
  && echo "$state_env" | grep -q '^OPENCLAW_CONFIG_PATH=/sandbox/.openclaw/openclaw.json$' \
  && echo "$state_env" | grep -q '^OPENCLAW_OAUTH_DIR=/sandbox/.openclaw/credentials$'; then
  pass "Connect-shell OpenClaw env resolves to /sandbox/.openclaw"
else
  fail "Connect-shell OpenClaw env does not resolve to the shared state root"
fi

pairing_list_empty=$(sandbox_exec 'openclaw pairing list discord --json 2>&1')
pairing_list_empty_status=$?
info "Initial Discord pairing list: ${pairing_list_empty:0:300}"
if [ $pairing_list_empty_status -eq 0 ] \
  && echo "$pairing_list_empty" | grep -q '"channel"[[:space:]]*:[[:space:]]*"discord"'; then
  pass "openclaw pairing list discord works in connect shell"
else
  fail "openclaw pairing list discord failed before request creation: ${pairing_list_empty:0:300}"
fi

section "Phase 3: Hermetic Discord gateway proof"

fake_gateway_ready=0
if start_fake_discord_gateway "$DISCORD_TOKEN"; then
  fake_gateway_ready=1
  pass "Hermetic fake Discord Gateway started on host port ${FAKE_DISCORD_GATEWAY_PORT}"
else
  fail "Failed to start hermetic fake Discord Gateway"
fi

if [ "$fake_gateway_ready" = "1" ] \
  && apply_fake_discord_gateway_policy "$SANDBOX_NAME" "$FAKE_DISCORD_GATEWAY_PORT" >/tmp/nemoclaw-fake-discord-pairing-policy.log 2>&1; then
  pass "Applied native WebSocket policy with credential rewrite for fake Discord Gateway"
else
  fail "Failed to apply fake Discord Gateway policy: $(tail -20 /tmp/nemoclaw-fake-discord-pairing-policy.log 2>/dev/null | tr '\n' ' ' | cut -c1-300)"
fi

dc_ws_native=""
if [ "$fake_gateway_ready" = "1" ]; then
  dc_ws_native=$(run_fake_discord_gateway_node_client "$FAKE_DISCORD_GATEWAY_PORT" "openshell:resolve:env:DISCORD_BOT_TOKEN" || true)
fi
info "Native fake Discord Gateway probe: ${dc_ws_native:0:500}"

if echo "$dc_ws_native" | grep -q "^UPGRADE$" \
  && echo "$dc_ws_native" | grep -q "^HELLO$" \
  && echo "$dc_ws_native" | grep -q "^IDENTIFY_SENT_PLACEHOLDER$" \
  && echo "$dc_ws_native" | grep -q "^READY$" \
  && echo "$dc_ws_native" | grep -q "^HEARTBEAT_ACK$"; then
  pass "Discord Gateway HELLO, placeholder IDENTIFY, READY, and heartbeat ACK completed"
else
  fail "Discord Gateway protocol proof incomplete: ${dc_ws_native:0:400}"
fi

capture_check=$(check_fake_discord_gateway_capture 2>&1 || true)
if [ "$capture_check" = "OK" ]; then
  pass "Fake Discord Gateway saw rewritten host-side token, not the sandbox placeholder"
else
  fail "Fake Discord Gateway capture did not prove token rewriting: ${capture_check:0:300}"
fi

section "Phase 4: Hermetic Discord pairing request"

gateway_issue_script=$(
  cat <<'SCRIPT'
    set -a
    [ -f /tmp/nemoclaw-proxy-env.sh ] && . /tmp/nemoclaw-proxy-env.sh
    set +a
    discord_pairing_user="$1"
    discord_dm_channel="$2"
    : "${OPENCLAW_HOME:?OPENCLAW_HOME missing from runtime shell env}"
    : "${OPENCLAW_STATE_DIR:?OPENCLAW_STATE_DIR missing from runtime shell env}"
    : "${OPENCLAW_CONFIG_PATH:?OPENCLAW_CONFIG_PATH missing from runtime shell env}"
    : "${OPENCLAW_OAUTH_DIR:?OPENCLAW_OAUTH_DIR missing from runtime shell env}"
    printf 'GATEWAY_OPENCLAW_ENV uid=%s gid=%s OPENCLAW_STATE_DIR=%s OPENCLAW_OAUTH_DIR=%s\n' "$(id -u)" "$(id -g)" "$OPENCLAW_STATE_DIR" "$OPENCLAW_OAUTH_DIR"
    exec env \
      HOME=/sandbox \
      OPENCLAW_HOME="$OPENCLAW_HOME" \
      OPENCLAW_STATE_DIR="$OPENCLAW_STATE_DIR" \
      OPENCLAW_CONFIG_PATH="$OPENCLAW_CONFIG_PATH" \
      OPENCLAW_OAUTH_DIR="$OPENCLAW_OAUTH_DIR" \
      HTTP_PROXY="${HTTP_PROXY:-}" \
      HTTPS_PROXY="${HTTPS_PROXY:-}" \
      http_proxy="${http_proxy:-}" \
      https_proxy="${https_proxy:-}" \
      NO_PROXY="${NO_PROXY:-}" \
      no_proxy="${no_proxy:-}" \
      NODE_OPTIONS="${NODE_OPTIONS:-}" \
      DISCORD_PAIRING_USER="$discord_pairing_user" \
      DISCORD_DM_CHANNEL="$discord_dm_channel" \
      node --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function findOpenClawPackageRootFromBinary() {
  let binary = "";
  try {
    binary = execFileSync("sh", ["-lc", "command -v openclaw"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
  if (!binary) return null;

  let current = "";
  try {
    current = fs.realpathSync(binary);
  } catch {
    return null;
  }
  if (fs.statSync(current).isFile()) current = path.dirname(current);

  for (let depth = 0; depth < 8; depth += 1) {
    const manifest = path.join(current, "package.json");
    if (fs.existsSync(manifest)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
        if (pkg?.name === "openclaw") return current;
      } catch {
        // Keep walking toward the filesystem root.
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function loadConversationRuntime() {
  const candidates = [];
  const binaryRoot = findOpenClawPackageRootFromBinary();
  if (binaryRoot) candidates.push(binaryRoot);
  try {
    const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    if (globalRoot) candidates.push(path.join(globalRoot, "openclaw"));
  } catch {
    // Keep the explicit global-root fallbacks below.
  }
  candidates.push(
    "/usr/local/lib/node_modules/openclaw",
    "/usr/lib/node_modules/openclaw",
  );
  const uniqueCandidates = [...new Set(candidates)];
  for (const root of uniqueCandidates) {
    const runtime = path.join(root, "dist/plugin-sdk/conversation-runtime.js");
    if (fs.existsSync(runtime)) return import(pathToFileURL(runtime).href);
  }
  throw new Error(`OpenClaw conversation runtime not found; checked: ${uniqueCandidates.join(", ")}`);
}

const {
  issuePairingChallenge,
  upsertChannelPairingRequest,
} = await loadConversationRuntime();

const senderId = process.env.DISCORD_PAIRING_USER;
const channelId = process.env.DISCORD_DM_CHANNEL;
let replyText = "";

const result = await issuePairingChallenge({
  channel: "discord",
  senderId,
  senderIdLine: `Discord user id: ${senderId}`,
  meta: {
    accountId: "default",
    channelId,
    isDirectMessage: true,
  },
  upsertPairingRequest: async ({ id, meta }) => upsertChannelPairingRequest({
    channel: "discord",
    id,
    accountId: "default",
    meta,
  }),
  sendPairingReply: async (text) => {
    replyText = text;
  },
});

if (!result.created || !result.code) {
  throw new Error(`pairing challenge was not created: ${JSON.stringify(result)}`);
}

console.log(`DISCORD_PAIRING_E2E_RESULT ${JSON.stringify({
  code: result.code,
  senderId,
  channelId,
  replyText,
})}`);
NODE
SCRIPT
)

gateway_issue_output=$(sandbox_exec_sh_script "$gateway_issue_script" "$DISCORD_PAIRING_USER" "$DISCORD_DM_CHANNEL" 2>&1)
gateway_issue_status=$?
info "Discord pairing issue output: ${gateway_issue_output:0:700}"
if [ $gateway_issue_status -eq 0 ] && echo "$gateway_issue_output" | grep -q '^DISCORD_PAIRING_E2E_RESULT '; then
  pass "OpenClaw runtime created a Discord pending pairing request"
else
  fail "OpenClaw runtime did not create a Discord pending pairing request"
fi

pairing_result_line=$(printf '%s\n' "$gateway_issue_output" | grep '^DISCORD_PAIRING_E2E_RESULT ' | tail -1 || true)
pairing_json="${pairing_result_line#DISCORD_PAIRING_E2E_RESULT }"
pairing_code=$(node -e 'const data = JSON.parse(process.argv[1]); process.stdout.write(data.code || "");' "$pairing_json" 2>/dev/null || true)
if [ -n "$pairing_code" ]; then
  pass "Pairing code extracted from fake Discord reply path"
else
  fail "Failed to extract Discord pairing code"
  pairing_code="__missing_pairing_code__"
fi

if echo "$pairing_json" | grep -qF "$DISCORD_PAIRING_USER" \
  && echo "$pairing_json" | grep -qF "$pairing_code"; then
  pass "Discord pairing reply includes the code and sender identity"
else
  fail "Discord pairing reply did not include expected code/user"
fi

section "Phase 5: Connect-shell approval"

pending_file_check=$(sandbox_exec "test -f /sandbox/.openclaw/credentials/discord-pairing.json && grep -F '$pairing_code' /sandbox/.openclaw/credentials/discord-pairing.json && grep -F '$DISCORD_PAIRING_USER' /sandbox/.openclaw/credentials/discord-pairing.json")
pending_file_status=$?
if [ $pending_file_status -eq 0 ] \
  && echo "$pending_file_check" | grep -qF "$pairing_code" \
  && echo "$pending_file_check" | grep -qF "$DISCORD_PAIRING_USER"; then
  pass "Runtime-created Discord pending request is in the shared OpenClaw state root"
else
  fail "Discord pending request missing from /sandbox/.openclaw/credentials/discord-pairing.json"
fi

pairing_list=$(sandbox_exec 'openclaw pairing list discord --json 2>&1')
pairing_list_status=$?
info "Pairing list after fake Discord event: ${pairing_list:0:500}"
if [ $pairing_list_status -eq 0 ] \
  && echo "$pairing_list" | grep -qF "$pairing_code" \
  && echo "$pairing_list" | grep -qF "$DISCORD_PAIRING_USER"; then
  pass "Connect-shell openclaw pairing list sees runtime-created Discord request"
else
  fail "Connect-shell openclaw pairing list does not see the Discord request"
fi

approve_output=$(sandbox_exec "openclaw pairing approve discord '$pairing_code' 2>&1")
approve_status=$?
info "Pairing approve output: ${approve_output:0:500}"
if [ $approve_status -eq 0 ] \
  && echo "$approve_output" | grep -q "Approved" \
  && echo "$approve_output" | grep -qF "$DISCORD_PAIRING_USER"; then
  pass "Connect-shell openclaw pairing approve approved the Discord request"
else
  fail "Connect-shell openclaw pairing approve failed: ${approve_output:0:500}"
fi

pairing_list_after=$(sandbox_exec 'openclaw pairing list discord --json 2>&1')
pairing_list_after_status=$?
if [ $pairing_list_after_status -ne 0 ]; then
  fail "openclaw pairing list discord failed after approval: ${pairing_list_after:0:300}"
elif echo "$pairing_list_after" | grep -qF "$pairing_code"; then
  fail "Approved Discord pairing code is still pending"
else
  pass "Approved Discord pairing code was consumed"
fi

allow_from_check=$(sandbox_exec "test -f /sandbox/.openclaw/credentials/discord-default-allowFrom.json && grep -F '$DISCORD_PAIRING_USER' /sandbox/.openclaw/credentials/discord-default-allowFrom.json")
allow_from_status=$?
if [ $allow_from_status -eq 0 ] \
  && echo "$allow_from_check" | grep -qF "$DISCORD_PAIRING_USER"; then
  pass "Discord allowFrom store contains the approved user"
else
  fail "Discord allowFrom store missing approved user"
fi

repeat_approve=$(sandbox_exec "openclaw pairing approve discord '$pairing_code' 2>&1")
repeat_approve_status=$?
if [ $repeat_approve_status -ne 0 ] \
  && echo "$repeat_approve" | grep -q "No pending pairing request found"; then
  pass "Second approval fails closed after request consumption"
else
  fail "Second approval did not report missing pending request: ${repeat_approve:0:300}"
fi

section "Phase 6: Cleanup"

if [[ "${NEMOCLAW_E2E_KEEP_SANDBOX:-}" = "1" ]]; then
  skip "Cleanup: NEMOCLAW_E2E_KEEP_SANDBOX=1 - leaving sandbox '$SANDBOX_NAME' for inspection"
else
  nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true
  openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true
fi

if [[ "${NEMOCLAW_E2E_KEEP_SANDBOX:-}" = "1" ]]; then
  pass "Cleanup: Sandbox '$SANDBOX_NAME' intentionally kept"
elif openshell sandbox list 2>&1 | grep -q "$SANDBOX_NAME"; then
  fail "Cleanup: Sandbox '$SANDBOX_NAME' still present after cleanup"
else
  pass "Cleanup: Sandbox '$SANDBOX_NAME' removed"
fi

echo ""
echo "=========================================="
echo "  OpenClaw Discord Pairing E2E Results:"
echo "    Passed:  $PASS"
echo "    Failed:  $FAIL"
echo "    Skipped: $SKIP"
echo "    Total:   $TOTAL"
echo "=========================================="

if [ "$FAIL" -eq 0 ]; then
  printf '\n\033[1;32m  OpenClaw Discord pairing E2E PASSED.\033[0m\n'
  exit 0
else
  printf '\n\033[1;31m  %d test(s) FAILED.\033[0m\n' "$FAIL"
  exit 1
fi
