#!/bin/bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# OpenClaw Slack pairing E2E (#3730/#3737).
#
# This test keeps Slack hermetic while covering the failure boundary from the
# DGX Spark report:
#   1. Slack-style Socket Mode event reaches sandbox code over native websocket
#      policy with xapp placeholder rewriting.
#   2. OpenShell-tracked Slack Socket Mode flow writes a Slack pending request.
#   3. Connect-shell `openclaw pairing approve slack <code>` finds and approves
#      the request created by the runtime flow.
#   4. Approval creates the Slack allowFrom store entry where OpenClaw resolves it.
#
# Environment variables:
#   NEMOCLAW_NON_INTERACTIVE=1              - required
#   NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 - required
#   NVIDIA_INFERENCE_API_KEY                         - required for onboarding
#   NEMOCLAW_SANDBOX_NAME                  - sandbox name (default: e2e-openclaw-slack-pairing)
#   SLACK_BOT_TOKEN                        - defaults to a fake xoxb- token
#   SLACK_APP_TOKEN                        - defaults to a fake xapp- token
#
# Usage:
#   NEMOCLAW_NON_INTERACTIVE=1 NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
#     NVIDIA_INFERENCE_API_KEY=nvapi-... bash test/e2e/test-openclaw-slack-pairing.sh

# shellcheck disable=SC2016
# SC2016: Single-quoted strings are intentional for commands evaluated inside
# the sandbox rather than on the host.

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

if [ -d /workspace ] && [ -f /workspace/install.sh ]; then
  REPO="/workspace"
elif [ -f "$(cd "$(dirname "$0")/../.." && pwd)/install.sh" ]; then
  REPO="$(cd "$(dirname "$0")/../.." && pwd)"
else
  echo "ERROR: Cannot find repo root."
  exit 1
fi

SANDBOX_NAME="${NEMOCLAW_SANDBOX_NAME:-e2e-openclaw-slack-pairing}"
OPENSHELL_BIN="${NEMOCLAW_OPENSHELL_BIN:-openshell}"
SLACK_TOKEN="${SLACK_BOT_TOKEN:-xoxb-fake-slack-pairing-e2e}"
SLACK_APP="${SLACK_APP_TOKEN:-xapp-fake-slack-pairing-e2e}"
SLACK_PAIRING_USER="${NEMOCLAW_SLACK_PAIRING_USER:-U3730E2E}"

export NEMOCLAW_SANDBOX_NAME="$SANDBOX_NAME"
export NEMOCLAW_RECREATE_SANDBOX=1
export NEMOCLAW_FRESH=1
export NEMOCLAW_POLICY_TIER="${NEMOCLAW_POLICY_TIER:-open}"
export SLACK_BOT_TOKEN="$SLACK_TOKEN"
export SLACK_APP_TOKEN="$SLACK_APP"
if [ -z "${NEMOCLAW_SKIP_SLACK_AUTH_VALIDATION:-}" ] \
  && { is_fake_slack_token "$SLACK_TOKEN" || is_fake_slack_token "$SLACK_APP"; }; then
  export NEMOCLAW_SKIP_SLACK_AUTH_VALIDATION=1
  info "Skipping onboarding Slack auth validation for fake-token E2E"
fi

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
  openshell sandbox exec --name "$SANDBOX_NAME" -- sh -lc "$remote_cmd"
}

# shellcheck source=test/e2e/lib/sandbox-teardown.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/sandbox-teardown.sh"
register_sandbox_for_teardown "$SANDBOX_NAME"

# shellcheck source=test/e2e/lib/slack-api-proof.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/slack-api-proof.sh"

check_fake_slack_pairing_capture() {
  node - "$FAKE_SLACK_API_CAPTURE_FILE" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const rows = fs
  .readFileSync(file, "utf8")
  .trim()
  .split(/\n+/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const ws = rows
  .filter((row) => row.event === "websocket-message" && row.messageType === "socket_mode_client_hello")
  .at(-1);
if (!ws) {
  console.log("NO_WEBSOCKET_MESSAGE");
  process.exit(2);
}
if (ws.tokenMatchesExpected !== true) {
  console.log("BAD_WEBSOCKET_TOKEN_REWRITE");
  process.exit(3);
}
if (ws.tokenLooksPlaceholder) {
  console.log("WEBSOCKET_PLACEHOLDER_LEAK");
  process.exit(4);
}

const post = rows
  .filter((row) => row.event === "request" && row.path === "/api/chat.postMessage")
  .at(-1);
if (!post) {
  console.log("NO_CHAT_POSTMESSAGE");
  process.exit(5);
}
if (post.authorization !== undefined || post.body !== undefined) {
  console.log("RAW_CAPTURE_LEAK");
  process.exit(6);
}
if (post.tokenMatchesExpected !== true || post.bodyMatchesExpected !== true) {
  console.log("BAD_CHAT_POSTMESSAGE_TOKEN_REWRITE");
  process.exit(7);
}
if (post.tokenLooksPlaceholder) {
  console.log("CHAT_POSTMESSAGE_PLACEHOLDER_LEAK");
  process.exit(8);
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
info "Slack bot token: configured (${#SLACK_TOKEN} chars)"
info "Slack app token: configured (${#SLACK_APP} chars)"

section "Phase 1: Install NemoClaw with Slack enabled"

cd "$REPO" || exit 1

info "Pre-cleanup..."
if command -v nemoclaw >/dev/null 2>&1; then
  nemoclaw "$SANDBOX_NAME" destroy --yes 2>/dev/null || true
fi
if openshell --version >/dev/null 2>&1; then
  openshell sandbox delete "$SANDBOX_NAME" 2>/dev/null || true
  openshell gateway destroy -g nemoclaw 2>/dev/null || true
fi
pass "Pre-cleanup complete"

# Keep this in sync with the Slack boot-time pre-merge in
# test-messaging-providers.sh. Slack presets normally apply after the sandbox
# first starts; pre-merging avoids a slow first-boot Slack SDK CONNECT failure.
BASE_POLICY="$REPO/nemoclaw-blueprint/policies/openclaw-sandbox.yaml"
SLACK_PRESET="$REPO/nemoclaw-blueprint/policies/presets/slack.yaml"
if [ -f "$BASE_POLICY" ] && [ -f "$SLACK_PRESET" ] && ! grep -q "api.slack.com" "$BASE_POLICY"; then
  BASE_POLICY_BAK="$(mktemp)"
  cp "$BASE_POLICY" "$BASE_POLICY_BAK"
  _previous_exit_trap=$(trap -p EXIT | sed "s/^trap -- '//;s/' EXIT$//")
  trap ''"${_previous_exit_trap:+$_previous_exit_trap;}"' cp "$BASE_POLICY_BAK" "$BASE_POLICY" 2>/dev/null || true; rm -f "$BASE_POLICY_BAK"' EXIT
  info "Pre-merging Slack network policy into base sandbox policy..."
  cat >>"$BASE_POLICY" <<'SLACK_POLICY_EOF'

  # ── Slack — pre-merged for Slack pairing E2E (#3730) ──────────
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
  pass "Slack network policy pre-merged into base policy"
else
  if grep -q "api.slack.com" "$BASE_POLICY" 2>/dev/null; then
    info "Slack policy already present in base policy — skipping pre-merge"
  else
    fail "Cannot pre-merge Slack policy: missing base policy or preset file"
    exit 1
  fi
fi

INSTALL_LOG="/tmp/nemoclaw-e2e-openclaw-slack-pairing-install.log"
info "Running install.sh --non-interactive..."
bash install.sh --non-interactive >"$INSTALL_LOG" 2>&1 &
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

if openshell provider get "${SANDBOX_NAME}-slack-bridge" >/dev/null 2>&1 \
  && openshell provider get "${SANDBOX_NAME}-slack-app" >/dev/null 2>&1; then
  pass "Slack bot/app providers exist in OpenShell"
else
  fail "Slack bot/app providers missing in OpenShell"
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

pairing_list_empty=$(sandbox_exec 'openclaw pairing list slack --json 2>&1')
pairing_list_empty_status=$?
info "Initial pairing list: ${pairing_list_empty:0:300}"
if [ $pairing_list_empty_status -eq 0 ] \
  && echo "$pairing_list_empty" | grep -q '"channel"[[:space:]]*:[[:space:]]*"slack"'; then
  pass "openclaw pairing list slack works in connect shell"
else
  fail "openclaw pairing list slack failed before request creation: ${pairing_list_empty:0:300}"
fi

section "Phase 3: Hermetic Slack Socket Mode pairing request"

if start_fake_slack_api "$SLACK_TOKEN" "$SLACK_APP"; then
  pass "Hermetic fake Slack API started on host port ${FAKE_SLACK_API_PORT}"
else
  fail "Failed to start hermetic fake Slack API"
  exit 1
fi

if apply_fake_slack_api_policy "$SANDBOX_NAME" "$FAKE_SLACK_API_PORT" >/tmp/nemoclaw-fake-slack-pairing-rest-policy.log 2>&1; then
  pass "Applied REST policy for fake Slack chat.postMessage"
else
  fail "Failed to apply fake Slack REST policy: $(tail -20 /tmp/nemoclaw-fake-slack-pairing-rest-policy.log 2>/dev/null | tr '\n' ' ' | cut -c1-300)"
fi

if apply_fake_slack_socket_mode_policy "$SANDBOX_NAME" "$FAKE_SLACK_API_PORT" >/tmp/nemoclaw-fake-slack-pairing-ws-policy.log 2>&1; then
  pass "Applied websocket policy for fake Slack Socket Mode"
else
  fail "Failed to apply fake Slack websocket policy: $(tail -20 /tmp/nemoclaw-fake-slack-pairing-ws-policy.log 2>/dev/null | tr '\n' ' ' | cut -c1-300)"
fi

gateway_issue_script=$(
  cat <<'SCRIPT'
    set -a
    [ -f /tmp/nemoclaw-proxy-env.sh ] && . /tmp/nemoclaw-proxy-env.sh
    set +a
    fake_slack_api_port="$1"
    slack_pairing_user="$2"
    fake_slack_api_host="$3"
    pairing_e2e_mode="$4"
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
      FAKE_SLACK_API_HOST="$fake_slack_api_host" \
      FAKE_SLACK_API_PORT="$fake_slack_api_port" \
      SLACK_PAIRING_USER="$slack_pairing_user" \
      PAIRING_E2E_MODE="$pairing_e2e_mode" \
      node --input-type=module <<'NODE'
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
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

function parseProxyTarget() {
  const raw = process.env.HTTP_PROXY || process.env.http_proxy || "";
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:") return null;
    return { host: parsed.hostname, port: Number(parsed.port || "80") };
  } catch {
    return null;
  }
}

function encodeClientText(payload) {
  const body = Buffer.from(payload, "utf8");
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(body.length);
  for (let i = 0; i < body.length; i += 1) masked[i] = body[i] ^ mask[i % 4];
  if (body.length < 126) {
    return Buffer.concat([Buffer.from([0x81, 0x80 | body.length]), mask, masked]);
  }
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 0x80 | 126;
  header.writeUInt16BE(body.length, 2);
  return Buffer.concat([header, mask, masked]);
}

function decodeServerFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  let payloadLength = buffer[1] & 0x7f;
  let offset = 2;
  if (payloadLength === 126) {
    if (buffer.length < 4) return null;
    payloadLength = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLength === 127) {
    if (buffer.length < 10) return null;
    payloadLength = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  if (buffer.length < offset + payloadLength) return null;
  return {
    opcode,
    payload: buffer.slice(offset, offset + payloadLength),
    totalLength: offset + payloadLength,
  };
}

function receiveSlackSocketEvent() {
  const host = process.env.FAKE_SLACK_API_HOST || "host.openshell.internal";
  const port = Number(process.env.FAKE_SLACK_API_PORT);
  const proxy = parseProxyTarget();

  return new Promise((resolve, reject) => {
    const socket = proxy
      ? net.createConnection({ host: proxy.host, port: proxy.port })
      : net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("timed out waiting for fake Slack Socket Mode event"));
    }, 30000);

    let handshake = Buffer.alloc(0);
    let framed = Buffer.alloc(0);
    let upgraded = false;

    socket.on("connect", () => {
      const key = crypto.randomBytes(16).toString("base64");
      const requestTarget = proxy
        ? `http://${host}:${port}/socket-mode`
        : "/socket-mode";
      socket.write([
        `GET ${requestTarget} HTTP/1.1`,
        `Host: ${host}:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "\r\n",
      ].join("\r\n"));
    });

    socket.on("data", (chunk) => {
      if (!upgraded) {
        handshake = Buffer.concat([handshake, chunk]);
        const end = handshake.indexOf("\r\n\r\n");
        if (end === -1) return;
        const statusLine = handshake.slice(0, end).toString("latin1").split("\r\n")[0] || "";
        if (!statusLine.includes("101")) {
          clearTimeout(timer);
          socket.destroy();
          reject(new Error(`fake Slack websocket upgrade failed: ${statusLine}`));
          return;
        }
        upgraded = true;
        framed = Buffer.concat([framed, handshake.slice(end + 4)]);
        socket.write(encodeClientText(JSON.stringify({
          type: "socket_mode_client_hello",
          token: "xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN",
        })));
      } else {
        framed = Buffer.concat([framed, chunk]);
      }

      while (framed.length > 0) {
        const frame = decodeServerFrame(framed);
        if (!frame) break;
        framed = framed.slice(frame.totalLength);
        if (frame.opcode !== 1) continue;
        const envelope = JSON.parse(frame.payload.toString("utf8"));
        socket.write(encodeClientText(JSON.stringify({ envelope_id: envelope.envelope_id })));
        clearTimeout(timer);
        socket.end();
        socket.destroy();
        resolve(envelope);
        return;
      }
    });

    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function postPairingReply(text, channel) {
  const host = process.env.FAKE_SLACK_API_HOST || "host.openshell.internal";
  const port = Number(process.env.FAKE_SLACK_API_PORT);
  const token = "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN";
  const data = new URLSearchParams({ token, channel, text }).toString();

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: host,
      port,
      path: "/api/chat.postMessage",
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(data),
      },
      timeout: 30000,
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new Error(`chat.postMessage failed: ${res.statusCode} ${body.slice(0, 200)}`));
          return;
        }
        resolve(body);
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("chat.postMessage timed out"));
    });
    req.write(data);
    req.end();
  });
}

const {
  issuePairingChallenge,
  upsertChannelPairingRequest,
} = await loadConversationRuntime();

const mode = process.env.PAIRING_E2E_MODE || "full";
const directGateway = mode === "direct-gateway";
const socketProbeOnly = mode === "socket-probe";
const envelope = directGateway
  ? {
      payload: {
        team_id: "T3730E2E",
        event: {
          type: "message",
          channel: "D3730E2E",
          user: process.env.SLACK_PAIRING_USER,
        },
      },
    }
  : await receiveSlackSocketEvent();
const event = envelope?.payload?.event;
if (!event || event.type !== "message" || !event.user || !event.channel) {
  throw new Error(`unexpected fake Slack envelope: ${JSON.stringify(envelope).slice(0, 400)}`);
}
if (event.user !== process.env.SLACK_PAIRING_USER) {
  throw new Error(`unexpected fake Slack user: ${event.user}`);
}

if (socketProbeOnly) {
  await postPairingReply("Slack pairing E2E websocket probe", event.channel);
  console.log(`SLACK_SOCKET_PROBE_RESULT ${JSON.stringify({
    senderId: event.user,
    channelId: event.channel,
  })}`);
  process.exit(0);
}

let replyText = "";
const result = await issuePairingChallenge({
  channel: "slack",
  senderId: event.user,
  senderIdLine: `Slack user ID: ${event.user}`,
  meta: {
    accountId: "default",
    channelId: event.channel,
    teamId: envelope.payload?.team_id || "",
  },
  upsertPairingRequest: async ({ id, meta }) => upsertChannelPairingRequest({
    channel: "slack",
    id,
    accountId: "default",
    meta,
  }),
  sendPairingReply: async (text) => {
    if (directGateway) {
      replyText = text;
    } else {
      await postPairingReply(text, event.channel);
    }
  },
});

if (!result.created || !result.code) {
  throw new Error(`pairing challenge was not created: ${JSON.stringify(result)}`);
}

console.log(`PAIRING_E2E_RESULT ${JSON.stringify({
  code: result.code,
  senderId: event.user,
  channelId: event.channel,
  replyText,
})}`);
NODE
SCRIPT
)
# Drive the hermetic Slack flow through OpenShell's tracked sandbox execution
# path so the request lands in the same state root that the approval CLI reads.
# The gateway-user env inheritance is covered by nemoclaw-start regression tests.
gateway_issue_output=$(sandbox_exec_sh_script "$gateway_issue_script" "$FAKE_SLACK_API_PORT" "$SLACK_PAIRING_USER" "$FAKE_SLACK_API_HOST" full 2>&1)
gateway_issue_status=$?
info "Slack pairing issue output: ${gateway_issue_output:0:600}"
if [ $gateway_issue_status -eq 0 ] && echo "$gateway_issue_output" | grep -q '^PAIRING_E2E_RESULT '; then
  pass "OpenShell-tracked Slack Socket Mode handler created a pairing request"
else
  fail "OpenShell-tracked Slack Socket Mode pairing request creation failed"
fi

pairing_result_line=$(printf '%s\n' "$gateway_issue_output" | grep '^PAIRING_E2E_RESULT ' | tail -1 || true)
pairing_json="${pairing_result_line#PAIRING_E2E_RESULT }"
pairing_code=$(node -e 'const data = JSON.parse(process.argv[1]); process.stdout.write(data.code || "");' "$pairing_json" 2>/dev/null || true)
if [ -n "$pairing_code" ]; then
  pass "Pairing code extracted from fake Slack reply path"
else
  fail "Failed to extract pairing code"
  pairing_code="__missing_pairing_code__"
fi

capture_check=$(check_fake_slack_pairing_capture 2>&1 || true)
if [ "$capture_check" = "OK" ]; then
  pass "Fake Slack saw rewritten xapp websocket frame and xoxb chat.postMessage"
else
  fail "Fake Slack capture did not prove Slack token rewriting: ${capture_check:0:300}"
fi

section "Phase 4: Connect-shell approval"

pending_file_check=$(sandbox_exec "test -f /sandbox/.openclaw/credentials/slack-pairing.json && grep -F '$pairing_code' /sandbox/.openclaw/credentials/slack-pairing.json && grep -F '$SLACK_PAIRING_USER' /sandbox/.openclaw/credentials/slack-pairing.json")
pending_file_status=$?
if [ $pending_file_status -eq 0 ] \
  && echo "$pending_file_check" | grep -qF "$pairing_code" \
  && echo "$pending_file_check" | grep -qF "$SLACK_PAIRING_USER"; then
  pass "Runtime-created Slack pending request is in the shared OpenClaw state root"
else
  fail "Slack pending request missing from /sandbox/.openclaw/credentials/slack-pairing.json"
fi

pairing_list=$(sandbox_exec 'openclaw pairing list slack --json 2>&1')
pairing_list_status=$?
info "Pairing list after fake Slack event: ${pairing_list:0:500}"
if [ $pairing_list_status -eq 0 ] \
  && echo "$pairing_list" | grep -qF "$pairing_code" \
  && echo "$pairing_list" | grep -qF "$SLACK_PAIRING_USER"; then
  pass "Connect-shell openclaw pairing list sees runtime-created Slack request"
else
  fail "Connect-shell openclaw pairing list does not see the Slack request"
fi

approve_output=$(sandbox_exec "openclaw pairing approve slack '$pairing_code' 2>&1")
approve_status=$?
info "Pairing approve output: ${approve_output:0:500}"
if [ $approve_status -eq 0 ] \
  && echo "$approve_output" | grep -q "Approved" \
  && echo "$approve_output" | grep -qF "$SLACK_PAIRING_USER"; then
  pass "Connect-shell openclaw pairing approve approved the Slack request"
else
  fail "Connect-shell openclaw pairing approve failed: ${approve_output:0:500}"
fi

pairing_list_after=$(sandbox_exec 'openclaw pairing list slack --json 2>&1')
pairing_list_after_status=$?
if [ $pairing_list_after_status -ne 0 ]; then
  fail "openclaw pairing list slack failed after approval: ${pairing_list_after:0:300}"
elif echo "$pairing_list_after" | grep -qF "$pairing_code"; then
  fail "Approved Slack pairing code is still pending"
else
  pass "Approved Slack pairing code was consumed"
fi

allow_from_check=$(sandbox_exec "test -f /sandbox/.openclaw/credentials/slack-default-allowFrom.json && grep -F '$SLACK_PAIRING_USER' /sandbox/.openclaw/credentials/slack-default-allowFrom.json")
allow_from_status=$?
if [ $allow_from_status -eq 0 ] \
  && echo "$allow_from_check" | grep -qF "$SLACK_PAIRING_USER"; then
  pass "Slack allowFrom store contains the approved user"
else
  fail "Slack allowFrom store missing approved user"
fi

repeat_approve=$(sandbox_exec "openclaw pairing approve slack '$pairing_code' 2>&1")
if echo "$repeat_approve" | grep -q "No pending pairing request found"; then
  pass "Second approval fails closed after request consumption"
else
  fail "Second approval did not report missing pending request: ${repeat_approve:0:300}"
fi

section "Phase 5: Cleanup"

if [[ "${NEMOCLAW_E2E_KEEP_SANDBOX:-}" = "1" ]]; then
  skip "Cleanup: NEMOCLAW_E2E_KEEP_SANDBOX=1 — leaving sandbox '$SANDBOX_NAME' for inspection"
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
echo "========================================"
echo "  OpenClaw Slack Pairing E2E Results:"
echo "    Passed:  $PASS"
echo "    Failed:  $FAIL"
echo "    Skipped: $SKIP"
echo "    Total:   $TOTAL"
echo "========================================"

if [ "$FAIL" -eq 0 ]; then
  printf '\n\033[1;32m  OpenClaw Slack pairing E2E PASSED.\033[0m\n'
  exit 0
else
  printf '\n\033[1;31m  %d test(s) FAILED.\033[0m\n' "$FAIL"
  exit 1
fi
