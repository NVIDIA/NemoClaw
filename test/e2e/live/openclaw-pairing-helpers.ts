// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import type { ArtifactSink } from "../fixtures/artifacts.ts";
import type { CleanupRegistry } from "../fixtures/cleanup.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import { expect } from "../fixtures/e2e-test.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { type FakeDockerApi, startFakeDockerApi } from "./messaging-providers-helpers.ts";
import {
  cleanupSandbox,
  expectExitZero,
  phase6Env,
  resultText,
  runSecondaryCleanup,
  sandboxNode,
  sandboxSh,
  sandboxShWithArgs,
  shellQuote,
} from "./phase6-messaging-helpers.ts";

export type PairingChannel = "slack" | "discord";

export const PAIRING_USER = {
  slack: process.env.NEMOCLAW_SLACK_PAIRING_USER ?? "U3730E2E",
  discord: process.env.NEMOCLAW_DISCORD_PAIRING_USER ?? "1005536447329222676",
};

export const DISCORD_DM_CHANNEL = process.env.NEMOCLAW_DISCORD_DM_CHANNEL ?? "1199988877766655554";

export function assertDiscordGatewayCapture(captureFile: string, expectedToken: string): void {
  const rows = fs
    .readFileSync(captureFile, "utf8")
    .trim()
    .split(/\n+/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const identify = rows.filter((row) => row.event === "identify").at(-1);
  expect(identify, "fake Discord Gateway did not capture IDENTIFY").toBeTruthy();
  expect(identify).not.toHaveProperty("token");
  expect(JSON.stringify(rows), "fake Discord Gateway capture persisted raw token").not.toContain(
    expectedToken,
  );
  expect(identify?.tokenMatchesExpected, "Discord token rewrite").toBe(true);
  expect(identify?.tokenLooksPlaceholder, "Discord placeholder leaked").toBe(false);
}

export function pairingEnv(options: {
  sandboxName: string;
  apiKey: string;
  channel: PairingChannel;
  slackBot?: string;
  slackApp?: string;
  discordToken?: string;
}): NodeJS.ProcessEnv {
  const extra: NodeJS.ProcessEnv =
    options.channel === "slack"
      ? {
          SLACK_BOT_TOKEN: options.slackBot ?? "xoxb-fake-slack-pairing-e2e",
          SLACK_APP_TOKEN: options.slackApp ?? "xapp-fake-slack-pairing-e2e",
          NEMOCLAW_SKIP_SLACK_AUTH_VALIDATION: "1",
        }
      : {
          DISCORD_BOT_TOKEN: options.discordToken ?? "test-fake-discord-pairing-e2e",
        };
  return phase6Env({
    sandboxName: options.sandboxName,
    agent: "openclaw",
    apiKey: options.apiKey,
    extra,
  });
}

export function pairingRedactions(options: {
  apiKey: string;
  slackBot?: string;
  slackApp?: string;
  discordToken?: string;
}): string[] {
  return [options.apiKey, options.slackBot, options.slackApp, options.discordToken].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

export async function cleanupPairingSandbox(
  host: HostCliClient,
  sandboxName: string,
  env: NodeJS.ProcessEnv,
  redactions: string[],
  prefix: string,
): Promise<void> {
  await cleanupSandbox(host, sandboxName, env, redactions, prefix);
  await runSecondaryCleanup(() =>
    host.command("openshell", ["gateway", "destroy", "-g", "nemoclaw"], {
      artifactName: `${prefix}-openshell-gateway-destroy`,
      env,
      redactionValues: redactions,
      timeoutMs: 120_000,
    }),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function policyEndpointBlock(text: string, host: string): string {
  const lines = text.split(/\r?\n/);
  const hostPattern = new RegExp(`^\\s*-\\s+host:\\s*["']?${escapeRegExp(host)}["']?\\s*$`);
  const start = lines.findIndex((line) => hostPattern.test(line));
  expect(start, `Slack policy includes endpoint block for ${host}`).toBeGreaterThanOrEqual(0);
  const next = lines.findIndex((line, index) => index > start && /^\s*-\s+host:\s*/.test(line));
  return lines.slice(start, next === -1 ? undefined : next).join("\n");
}

export async function assertSlackPresetPolicySemantics(options: {
  host: HostCliClient;
  sandboxName: string;
  env: NodeJS.ProcessEnv;
  redactions: string[];
}): Promise<void> {
  const policy = await options.host.command(
    "openshell",
    ["policy", "get", "--full", options.sandboxName],
    {
      artifactName: "slack-preset-policy-before-fake-overrides",
      env: options.env,
      redactionValues: options.redactions,
      timeoutMs: 60_000,
    },
  );
  expectExitZero(policy, "Slack preset policy before fake-host overrides");
  const text = resultText(policy);
  const requiredRestHosts = ["slack.com", "api.slack.com", "hooks.slack.com"];
  const requiredWebsocketHosts = ["wss-primary.slack.com", "wss-backup.slack.com"];
  for (const host of requiredRestHosts) {
    const block = policyEndpointBlock(text, host);
    expect(
      block,
      `Slack REST endpoint ${host} preserves request-body credential rewrite`,
    ).toContain("request_body_credential_rewrite: true");
  }
  for (const host of requiredWebsocketHosts) {
    const block = policyEndpointBlock(text, host);
    expect(
      block,
      `Slack websocket endpoint ${host} preserves websocket credential rewrite`,
    ).toContain("websocket_credential_rewrite: true");
  }
}

export async function startFakeDiscordGateway(
  host: HostCliClient,
  cleanup: CleanupRegistry,
  env: NodeJS.ProcessEnv,
  token: string,
  redactions: string[],
): Promise<FakeDockerApi> {
  return startFakeDockerApi(host, cleanup.add.bind(cleanup), {
    kind: "discord-gateway",
    imageScript: "fake-discord-gateway.cjs",
    containerPrefix: "nemoclaw-fake-discord-pairing",
    portEnv: "FAKE_DISCORD_GATEWAY_PORT",
    portFileEnv: "FAKE_DISCORD_GATEWAY_PORT_FILE",
    captureFileEnv: "FAKE_DISCORD_GATEWAY_CAPTURE_FILE",
    expectedEnv: { FAKE_DISCORD_GATEWAY_EXPECTED_TOKEN: token },
    env,
    redactionValues: redactions,
  });
}

export async function startFakeSlackApi(
  host: HostCliClient,
  cleanup: CleanupRegistry,
  env: NodeJS.ProcessEnv,
  botToken: string,
  appToken: string,
  redactions: string[],
): Promise<FakeDockerApi> {
  return startFakeDockerApi(host, cleanup.add.bind(cleanup), {
    kind: "slack",
    imageScript: "fake-slack-api.cjs",
    containerPrefix: "nemoclaw-fake-slack-pairing",
    portEnv: "FAKE_SLACK_API_PORT",
    portFileEnv: "FAKE_SLACK_API_PORT_FILE",
    captureFileEnv: "FAKE_SLACK_API_CAPTURE_FILE",
    expectedEnv: {
      FAKE_SLACK_API_EXPECTED_BOT_TOKEN: botToken,
      FAKE_SLACK_API_EXPECTED_APP_TOKEN: appToken,
      FAKE_SLACK_API_SOCKET_USER_ID: PAIRING_USER.slack,
    },
    env,
    redactionValues: redactions,
  });
}

export async function applyFakePolicy(options: {
  host: HostCliClient;
  sandboxName: string;
  api: FakeDockerApi;
  protocol: "rest" | "websocket";
  rewrite: "request-body-credential-rewrite" | "websocket-credential-rewrite";
  env: NodeJS.ProcessEnv;
  redactions: string[];
  artifactName: string;
}): Promise<void> {
  const methods = options.protocol === "rest" ? ["GET", "POST"] : ["GET", "WEBSOCKET_TEXT"];
  const args = [
    "policy",
    "update",
    options.sandboxName,
    "--add-endpoint",
    `host.openshell.internal:${options.api.port}:read-write:${options.protocol}:enforce:${options.rewrite},allowed-ip=10.0.0.0/8,allowed-ip=172.16.0.0/12,allowed-ip=192.168.0.0/16`,
  ];
  for (const method of methods)
    args.push("--add-allow", `host.openshell.internal:${options.api.port}:${method}:/**`);
  args.push("--binary", "/usr/local/bin/node", "--binary", "/usr/bin/node", "--wait");
  const result = await options.host.command("openshell", args, {
    artifactName: options.artifactName,
    env: options.env,
    redactionValues: options.redactions,
    timeoutMs: 120_000,
  });
  expectExitZero(result, options.artifactName);
}

export async function assertOpenClawStateRoot(
  sandbox: SandboxClient,
  sandboxName: string,
  channel: PairingChannel,
  redactions: string[],
): Promise<void> {
  const env = await sandboxSh(
    sandbox,
    sandboxName,
    'printf "OPENCLAW_HOME=%s\\nOPENCLAW_STATE_DIR=%s\\nOPENCLAW_CONFIG_PATH=%s\\nOPENCLAW_OAUTH_DIR=%s\\n" "$OPENCLAW_HOME" "$OPENCLAW_STATE_DIR" "$OPENCLAW_CONFIG_PATH" "$OPENCLAW_OAUTH_DIR"',
    { artifactName: `${channel}-openclaw-state-env`, redactionValues: redactions },
  );
  expectExitZero(env, "OpenClaw state env");
  expect(resultText(env)).toContain("OPENCLAW_HOME=/sandbox");
  expect(resultText(env)).toContain("OPENCLAW_STATE_DIR=/sandbox/.openclaw");
  expect(resultText(env)).toContain("OPENCLAW_CONFIG_PATH=/sandbox/.openclaw/openclaw.json");
  expect(resultText(env)).toContain("OPENCLAW_OAUTH_DIR=/sandbox/.openclaw/credentials");

  const list = await sandboxSh(
    sandbox,
    sandboxName,
    `openclaw pairing list ${channel} --json 2>&1`,
    {
      artifactName: `${channel}-initial-pairing-list`,
      redactionValues: redactions,
    },
  );
  expectExitZero(list, `openclaw pairing list ${channel}`);
  expect(resultText(list)).toMatch(new RegExp(`"channel"\\s*:\\s*"${channel}"`));
}

// Source-of-truth boundary: the live pairing probe imports the conversation
// runtime from the active `openclaw` binary installed in the sandbox. Connect
// shells may shadow that binary with a shell function, so the locator asks bash
// for `type -P openclaw` and intentionally ignores functions/aliases. The invalid
// state is an active OpenClaw package without `dist/plugin-sdk/conversation-runtime.js`;
// this pairing migration fails closed for that installer/package drift instead of
// searching secondary global installs. Support tests cover shell-function shadows
// and the no-runtime path. Remove this locator once OpenClaw exposes a stable
// CLI/import for issuing pairing challenges from E2E probes.
export const LOAD_CONVERSATION_RUNTIME_SOURCE = String.raw`
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function findOpenClawPackageRootFromBinary() {
  let binary = "";
  try { binary = execFileSync("bash", ["-c", "type -P openclaw || command -v openclaw"], { encoding: "utf8" }).trim(); } catch { return null; }
  if (!binary) return null;
  let current = "";
  try { current = fs.realpathSync(binary); } catch { return null; }
  try { if (fs.statSync(current).isFile()) current = path.dirname(current); } catch { return null; }
  for (let depth = 0; depth < 8; depth += 1) {
    const manifest = path.join(current, "package.json");
    if (fs.existsSync(manifest)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
        if (pkg?.name === "openclaw") return current;
      } catch {}
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

async function loadConversationRuntime() {
  const candidates = [];
  const binaryRoot = findOpenClawPackageRootFromBinary();
  if (binaryRoot) candidates.push(binaryRoot);
  for (const root of [...new Set(candidates)]) {
    const runtime = path.join(root, "dist/plugin-sdk/conversation-runtime.js");
    if (fs.existsSync(runtime)) return import(pathToFileURL(runtime).href);
  }
  throw new Error("OpenClaw conversation runtime not found; checked: " + candidates.join(", "));
}
`;

export const DISCORD_PAIRING_SCRIPT = String.raw`
set -eu
set -a
[ -f /tmp/nemoclaw-proxy-env.sh ] && . /tmp/nemoclaw-proxy-env.sh
set +a
discord_pairing_user="$1"
discord_dm_channel="$2"
: "${"$"}{OPENCLAW_HOME:?OPENCLAW_HOME missing}"
: "${"$"}{OPENCLAW_STATE_DIR:?OPENCLAW_STATE_DIR missing}"
: "${"$"}{OPENCLAW_CONFIG_PATH:?OPENCLAW_CONFIG_PATH missing}"
: "${"$"}{OPENCLAW_OAUTH_DIR:?OPENCLAW_OAUTH_DIR missing}"
exec env HOME=/sandbox PATH="/usr/local/bin:/usr/bin:/bin:${"$"}{PATH:-}" OPENCLAW_HOME="$OPENCLAW_HOME" OPENCLAW_STATE_DIR="$OPENCLAW_STATE_DIR" OPENCLAW_CONFIG_PATH="$OPENCLAW_CONFIG_PATH" OPENCLAW_OAUTH_DIR="$OPENCLAW_OAUTH_DIR" HTTP_PROXY="${"$"}{HTTP_PROXY:-}" HTTPS_PROXY="${"$"}{HTTPS_PROXY:-}" http_proxy="${"$"}{http_proxy:-}" https_proxy="${"$"}{https_proxy:-}" NO_PROXY="${"$"}{NO_PROXY:-}" no_proxy="${"$"}{no_proxy:-}" NODE_OPTIONS="${"$"}{NODE_OPTIONS:-}" DISCORD_PAIRING_USER="$discord_pairing_user" DISCORD_DM_CHANNEL="$discord_dm_channel" node --input-type=module <<'NODE'
__LOAD_CONVERSATION_RUNTIME_SOURCE__
const { issuePairingChallenge, upsertChannelPairingRequest } = await loadConversationRuntime();
const senderId = process.env.DISCORD_PAIRING_USER;
const channelId = process.env.DISCORD_DM_CHANNEL;
let replyText = "";
const result = await issuePairingChallenge({
  channel: "discord",
  senderId,
  senderIdLine: "Discord user id: " + senderId,
  meta: { accountId: "default", channelId, isDirectMessage: true },
  upsertPairingRequest: async ({ id, meta }) => upsertChannelPairingRequest({ channel: "discord", id, accountId: "default", meta }),
  sendPairingReply: async (text) => { replyText = text; },
});
if (!result.created || !result.code) throw new Error("pairing challenge was not created: " + JSON.stringify(result));
console.log("DISCORD_PAIRING_E2E_RESULT " + JSON.stringify({ code: result.code, senderId, channelId, replyText }));
NODE
`.replace("__LOAD_CONVERSATION_RUNTIME_SOURCE__", LOAD_CONVERSATION_RUNTIME_SOURCE);

// Source-of-truth boundary: the Slack live probe owns only validation for its
// localized fake API port and proxy environment because those values are injected
// by the Vitest harness before the probe opens direct Node socket/http clients.
// Invalid state: a malformed fake port or proxy env, or a proxy destination other
// than the NemoClaw/OpenShell gateway proxy emitted by scripts/nemoclaw-start.sh,
// would otherwise hide the real pairing failure behind a low-level network error
// or route the fake Slack websocket through an unexpected host. Source-fix
// constraint: do not change global sandbox proxy generation for this probe; fail
// closed here before network access. Support tests cover malformed values and an
// unexpected-but-valid HTTP proxy host. Remove this localized parser once the
// Slack probe delegates Socket Mode/REST traffic to a shared fake-provider client
// instead of hand-rolled sockets.
export const SLACK_PROBE_INPUT_VALIDATION_SOURCE = String.raw`
function parseFakeSlackPort() {
  const raw = process.env.FAKE_SLACK_API_PORT || "";
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("FAKE_SLACK_API_PORT must be an integer in 1..65535");
  return port;
}
function parseProxyTarget() {
  const raw = process.env.HTTP_PROXY || process.env.http_proxy || "";
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("HTTP proxy for Slack pairing probe is malformed");
  }
  if (parsed.protocol !== "http:") throw new Error("Slack pairing probe only supports HTTP proxies");
  const port = Number(parsed.port || "80");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("HTTP proxy port for Slack pairing probe is invalid");
  if (parsed.hostname !== "10.200.0.1" || port !== 3128) throw new Error("unexpected HTTP proxy for Slack pairing probe");
  return { host: parsed.hostname, port };
}
`;

export const SLACK_PAIRING_SCRIPT = String.raw`
set -eu
set -a
[ -f /tmp/nemoclaw-proxy-env.sh ] && . /tmp/nemoclaw-proxy-env.sh
set +a
fake_slack_api_port="$1"
slack_pairing_user="$2"
: "${"$"}{OPENCLAW_HOME:?OPENCLAW_HOME missing}"
: "${"$"}{OPENCLAW_STATE_DIR:?OPENCLAW_STATE_DIR missing}"
: "${"$"}{OPENCLAW_CONFIG_PATH:?OPENCLAW_CONFIG_PATH missing}"
: "${"$"}{OPENCLAW_OAUTH_DIR:?OPENCLAW_OAUTH_DIR missing}"
exec env HOME=/sandbox PATH="/usr/local/bin:/usr/bin:/bin:${"$"}{PATH:-}" OPENCLAW_HOME="$OPENCLAW_HOME" OPENCLAW_STATE_DIR="$OPENCLAW_STATE_DIR" OPENCLAW_CONFIG_PATH="$OPENCLAW_CONFIG_PATH" OPENCLAW_OAUTH_DIR="$OPENCLAW_OAUTH_DIR" HTTP_PROXY="${"$"}{HTTP_PROXY:-}" HTTPS_PROXY="${"$"}{HTTPS_PROXY:-}" http_proxy="${"$"}{http_proxy:-}" https_proxy="${"$"}{https_proxy:-}" NO_PROXY="${"$"}{NO_PROXY:-}" no_proxy="${"$"}{no_proxy:-}" NODE_OPTIONS="${"$"}{NODE_OPTIONS:-}" FAKE_SLACK_API_HOST="host.openshell.internal" FAKE_SLACK_API_PORT="$fake_slack_api_port" SLACK_PAIRING_USER="$slack_pairing_user" node --input-type=module <<'NODE'
__LOAD_CONVERSATION_RUNTIME_SOURCE__
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";

__SLACK_PROBE_INPUT_VALIDATION_SOURCE__
function encodeClientText(payload) {
  const body = Buffer.from(payload, "utf8");
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(body.length);
  for (let i = 0; i < body.length; i += 1) masked[i] = body[i] ^ mask[i % 4];
  if (body.length < 126) return Buffer.concat([Buffer.from([0x81, 0x80 | body.length]), mask, masked]);
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
  return { opcode, payload: buffer.slice(offset, offset + payloadLength), totalLength: offset + payloadLength };
}
function receiveSlackSocketEvent() {
  const host = "host.openshell.internal";
  const port = parseFakeSlackPort();
  const proxy = parseProxyTarget();
  return new Promise((resolve, reject) => {
    const socket = proxy ? net.createConnection({ host: proxy.host, port: proxy.port }) : net.createConnection({ host, port });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("timed out waiting for fake Slack Socket Mode event")); }, 30000);
    let handshake = Buffer.alloc(0);
    let framed = Buffer.alloc(0);
    let upgraded = false;
    socket.on("connect", () => {
      const key = crypto.randomBytes(16).toString("base64");
      const requestTarget = proxy ? "http://" + host + ":" + port + "/socket-mode" : "/socket-mode";
      socket.write([
        "GET " + requestTarget + " HTTP/1.1",
        "Host: " + host + ":" + port,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: " + key,
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
          reject(new Error("fake Slack websocket upgrade failed: " + statusLine));
          return;
        }
        upgraded = true;
        framed = Buffer.concat([framed, handshake.slice(end + 4)]);
        socket.write(encodeClientText(JSON.stringify({ type: "socket_mode_client_hello", token: "xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN" })));
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
    socket.on("error", (error) => { clearTimeout(timer); reject(error); });
  });
}
function postPairingReply(text, channel) {
  const host = "host.openshell.internal";
  const port = parseFakeSlackPort();
  const token = "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN";
  const data = new URLSearchParams({ token, channel, text }).toString();
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: host,
      port,
      path: "/api/chat.postMessage",
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(data),
      },
      timeout: 30000,
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        if (res.statusCode !== 200) reject(new Error("chat.postMessage failed: " + res.statusCode + " " + body.slice(0, 200)));
        else resolve(body);
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("chat.postMessage timed out")));
    req.write(data);
    req.end();
  });
}
const { issuePairingChallenge, upsertChannelPairingRequest } = await loadConversationRuntime();
const envelope = await receiveSlackSocketEvent();
const event = envelope?.payload?.event;
if (!event || event.type !== "message" || !event.user || !event.channel) throw new Error("unexpected fake Slack envelope: " + JSON.stringify(envelope).slice(0, 400));
if (event.user !== process.env.SLACK_PAIRING_USER) throw new Error("unexpected fake Slack user: " + event.user);
const result = await issuePairingChallenge({
  channel: "slack",
  senderId: event.user,
  senderIdLine: "Slack user ID: " + event.user,
  meta: { accountId: "default", channelId: event.channel, teamId: envelope.payload?.team_id || "" },
  upsertPairingRequest: async ({ id, meta }) => upsertChannelPairingRequest({ channel: "slack", id, accountId: "default", meta }),
  sendPairingReply: async (text) => { await postPairingReply(text, event.channel); },
});
if (!result.created || !result.code) throw new Error("pairing challenge was not created: " + JSON.stringify(result));
console.log("PAIRING_E2E_RESULT " + JSON.stringify({ code: result.code, senderId: event.user, channelId: event.channel }));
NODE
`
  .replace("__LOAD_CONVERSATION_RUNTIME_SOURCE__", LOAD_CONVERSATION_RUNTIME_SOURCE)
  .replace("__SLACK_PROBE_INPUT_VALIDATION_SOURCE__", SLACK_PROBE_INPUT_VALIDATION_SOURCE);

export type PairingResult = {
  code: string;
  senderId: string;
  channelId: string;
  replyText: string;
};

export function extractPairingResult(output: string, marker: string): PairingResult {
  const line = output.split(/\r?\n/).find((candidate) => candidate.startsWith(`${marker} `));
  if (!line) throw new Error(`missing ${marker} line: ${output.slice(0, 500)}`);
  const data = JSON.parse(line.slice(marker.length + 1)) as Partial<PairingResult>;
  if (!data.code) throw new Error(`missing pairing code in ${line}`);
  if (!data.senderId) throw new Error(`missing pairing sender in ${line}`);
  if (!data.channelId) throw new Error(`missing pairing channel in ${line}`);
  if (!data.replyText) throw new Error(`missing pairing reply text in ${line}`);
  return {
    code: data.code,
    senderId: data.senderId,
    channelId: data.channelId,
    replyText: data.replyText,
  };
}

export function extractPairingCode(output: string, marker: string): string {
  const line = output.split(/\r?\n/).find((candidate) => candidate.startsWith(`${marker} `));
  if (!line) throw new Error(`missing ${marker} line: ${output.slice(0, 500)}`);
  const data = JSON.parse(line.slice(marker.length + 1)) as { code?: string };
  if (!data.code) throw new Error(`missing pairing code in ${line}`);
  return data.code;
}

export async function issuePairingRequest(options: {
  sandbox: SandboxClient;
  sandboxName: string;
  channel: PairingChannel;
  redactions: string[];
  fakeSlackPort?: string;
}): Promise<ShellProbeResult> {
  const script = options.channel === "slack" ? SLACK_PAIRING_SCRIPT : DISCORD_PAIRING_SCRIPT;
  const args =
    options.channel === "slack"
      ? [options.fakeSlackPort ?? "", PAIRING_USER.slack]
      : [PAIRING_USER.discord, DISCORD_DM_CHANNEL];
  return sandboxShWithArgs(options.sandbox, options.sandboxName, script, args, {
    artifactName: `${options.channel}-issue-pairing-request`,
    redactionValues: options.redactions,
    timeoutMs: 120_000,
  });
}

export function buildPairingPendingCommand(
  channel: PairingChannel,
  code: string,
  user: string,
): string {
  return `test -f /sandbox/.openclaw/credentials/${channel}-pairing.json && grep -F ${shellQuote(code)} /sandbox/.openclaw/credentials/${channel}-pairing.json && grep -F ${shellQuote(user)} /sandbox/.openclaw/credentials/${channel}-pairing.json`;
}

export function buildPairingApproveCommand(channel: PairingChannel, code: string): string {
  return `openclaw pairing approve ${channel} ${shellQuote(code)} 2>&1`;
}

export function buildPairingAllowFromCommand(channel: PairingChannel, user: string): string {
  return `test -f /sandbox/.openclaw/credentials/${channel}-default-allowFrom.json && grep -F ${shellQuote(user)} /sandbox/.openclaw/credentials/${channel}-default-allowFrom.json`;
}

export async function approveAndAssertPairing(options: {
  sandbox: SandboxClient;
  sandboxName: string;
  channel: PairingChannel;
  code: string;
  redactions: string[];
}): Promise<void> {
  const user = PAIRING_USER[options.channel];
  const pending = await sandboxSh(
    options.sandbox,
    options.sandboxName,
    buildPairingPendingCommand(options.channel, options.code, user),
    { artifactName: `${options.channel}-pending-file`, redactionValues: options.redactions },
  );
  expectExitZero(pending, `${options.channel} pending file`);

  const list = await sandboxSh(
    options.sandbox,
    options.sandboxName,
    `openclaw pairing list ${options.channel} --json 2>&1`,
    {
      artifactName: `${options.channel}-pairing-list-before-approve`,
      redactionValues: options.redactions,
    },
  );
  expectExitZero(list, `${options.channel} pairing list before approval`);
  if (!resultText(list).includes(options.code) || !resultText(list).includes(user)) {
    throw new Error(`${options.channel} pairing list did not include pending request`);
  }

  const approve = await sandboxSh(
    options.sandbox,
    options.sandboxName,
    buildPairingApproveCommand(options.channel, options.code),
    { artifactName: `${options.channel}-pairing-approve`, redactionValues: options.redactions },
  );
  expectExitZero(approve, `${options.channel} pairing approve`);
  if (!resultText(approve).includes("Approved") || !resultText(approve).includes(user)) {
    throw new Error(`${options.channel} approve output did not include Approved and user`);
  }

  const after = await sandboxSh(
    options.sandbox,
    options.sandboxName,
    `openclaw pairing list ${options.channel} --json 2>&1`,
    {
      artifactName: `${options.channel}-pairing-list-after-approve`,
      redactionValues: options.redactions,
    },
  );
  expectExitZero(after, `${options.channel} pairing list after approval`);
  if (resultText(after).includes(options.code)) {
    throw new Error(`${options.channel} approved pairing code still pending`);
  }

  const allow = await sandboxSh(
    options.sandbox,
    options.sandboxName,
    buildPairingAllowFromCommand(options.channel, user),
    { artifactName: `${options.channel}-allow-from`, redactionValues: options.redactions },
  );
  expectExitZero(allow, `${options.channel} allowFrom file`);

  const repeat = await sandboxSh(
    options.sandbox,
    options.sandboxName,
    buildPairingApproveCommand(options.channel, options.code),
    { artifactName: `${options.channel}-repeat-approve`, redactionValues: options.redactions },
  );
  if (repeat.exitCode === 0 || !resultText(repeat).includes("No pending pairing request found")) {
    throw new Error(
      `${options.channel} repeat approval did not fail closed: ${resultText(repeat)}`,
    );
  }
}

// Ported from test/e2e/lib/discord-gateway-proof.sh run_fake_discord_gateway_node_client.
// Keep the request framing as raw source so CRLF sequences remain JavaScript
// escapes inside the sandbox node heredoc rather than literal line breaks.
// Source-of-truth boundary: the Discord Gateway proof owns validation for its
// localized sandbox HTTP proxy env because it opens a raw Node socket to the fake
// gateway. Invalid state: malformed proxy env, non-HTTP proxies, invalid ports,
// or proxy destinations other than the NemoClaw/OpenShell gateway proxy would
// hide handshake failures behind low-level network errors or route the proof
// through an unexpected host. Source-fix constraint: keep global sandbox proxy
// generation unchanged; fail closed here before network access. Remove this
// parser once the proof uses a shared fake-provider websocket client.
export const DISCORD_GATEWAY_PROOF_SOURCE = String.raw`
import crypto from "node:crypto";
import net from "node:net";

const host = "host.openshell.internal";
const port = Number(process.env.FAKE_DISCORD_GATEWAY_PORT);
const identifyToken = "openshell:resolve:env:DISCORD_BOT_TOKEN";
const results = [];

function finish(message) {
  if (message) results.push(message);
  console.log(results.join("\n"));
  process.exit(0);
}

function encodeClientText(payload) {
  const body = Buffer.from(payload, "utf8");
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(body.length);
  for (let i = 0; i < body.length; i += 1) masked[i] = body[i] ^ mask[i % 4];
  if (body.length < 126) {
    return Buffer.concat([Buffer.from([0x81, 0x80 | body.length]), mask, masked]);
  }
  if (body.length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(body.length, 2);
    return Buffer.concat([header, mask, masked]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 0x80 | 127;
  header.writeBigUInt64BE(BigInt(body.length), 2);
  return Buffer.concat([header, mask, masked]);
}

function encodeClientClose(code) {
  const body = Buffer.alloc(2);
  body.writeUInt16BE(code, 0);
  const mask = crypto.randomBytes(4);
  for (let i = 0; i < body.length; i += 1) body[i] ^= mask[i % 4];
  return Buffer.concat([Buffer.from([0x88, 0x80 | 2]), mask, body]);
}

function decodeFrame(buffer) {
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

function parseProxyTarget() {
  const raw = process.env.HTTP_PROXY || process.env.http_proxy || "";
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("HTTP proxy for Discord Gateway proof is malformed");
  }
  if (parsed.protocol !== "http:") throw new Error("Discord Gateway proof only supports HTTP proxies");
  const proxyPort = Number(parsed.port || "80");
  if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) throw new Error("HTTP proxy port for Discord Gateway proof is invalid");
  if (parsed.hostname !== "10.200.0.1" || proxyPort !== 3128) throw new Error("unexpected HTTP proxy for Discord Gateway proof");
  return { host: parsed.hostname, port: proxyPort };
}

const proxy = parseProxyTarget();
const socket = proxy
  ? net.createConnection({ host: proxy.host, port: proxy.port })
  : net.createConnection({ host, port });
const timer = setTimeout(() => {
  try { socket.destroy(); } catch {}
  finish("TIMEOUT");
}, 20000);
let handshake = Buffer.alloc(0);
let framed = Buffer.alloc(0);
let upgraded = false;
let sawReady = false;

socket.on("connect", () => {
  const key = crypto.randomBytes(16).toString("base64");
  const requestTarget = proxy
    ? "http://" + host + ":" + port + "/gateway?v=10&encoding=json"
    : "/gateway?v=10&encoding=json";
  socket.write([
    "GET " + requestTarget + " HTTP/1.1",
    "Host: " + host + ":" + port,
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Key: " + key,
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
      finish("HTTP_" + statusLine);
    }
    upgraded = true;
    results.push("UPGRADE");
    framed = Buffer.concat([framed, handshake.slice(end + 4)]);
  } else {
    framed = Buffer.concat([framed, chunk]);
  }

  while (framed.length > 0) {
    const frame = decodeFrame(framed);
    if (!frame) break;
    framed = framed.slice(frame.totalLength);
    if (frame.opcode === 1) {
      const message = JSON.parse(frame.payload.toString("utf8"));
      if (message.op === 10) {
        results.push("HELLO");
        socket.write(encodeClientText(JSON.stringify({
          op: 2,
          d: {
            token: identifyToken,
            intents: 0,
            properties: { os: "linux", browser: "nemoclaw-e2e", device: "nemoclaw-e2e" },
          },
        })));
        results.push("IDENTIFY_SENT_PLACEHOLDER");
      } else if (message.op === 0 && message.t === "READY") {
        sawReady = true;
        results.push("READY");
        socket.write(encodeClientText(JSON.stringify({ op: 1, d: message.s ?? null })));
      } else if (message.op === 11) {
        results.push("HEARTBEAT_ACK");
        socket.write(encodeClientClose(1000));
        clearTimeout(timer);
        finish();
      }
    } else if (frame.opcode === 8) {
      const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 0;
      clearTimeout(timer);
      finish("CLOSE_" + code);
    }
  }
});

socket.on("error", (error) => {
  clearTimeout(timer);
  finish("ERROR " + error.message);
});
socket.on("close", () => {
  clearTimeout(timer);
  if (!sawReady) finish("CLOSED");
});
`;

export async function runDiscordGatewayProof(options: {
  sandbox: SandboxClient;
  sandboxName: string;
  port: string;
  redactions: string[];
}): Promise<ShellProbeResult> {
  return sandboxNode(
    options.sandbox,
    options.sandboxName,
    DISCORD_GATEWAY_PROOF_SOURCE,
    { FAKE_DISCORD_GATEWAY_PORT: options.port },
    {
      artifactName: "discord-gateway-proof",
      redactionValues: options.redactions,
      timeoutMs: 60_000,
    },
  );
}

export async function writePairingArtifacts(
  artifacts: ArtifactSink,
  channel: PairingChannel,
  data: Record<string, unknown>,
): Promise<void> {
  await artifacts.writeJson(`${channel}-pairing-result.json`, data);
}
