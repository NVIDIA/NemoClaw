// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import { isIPv4 } from "node:net";
import os from "node:os";
import path from "node:path";

import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import {
  assertExitZero as expectExitZero,
  resultText,
  shellQuote,
} from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import {
  type SandboxClient,
  sandboxAccessEnv,
  validateSandboxName,
} from "../fixtures/clients/sandbox.ts";
import { expect } from "../fixtures/e2e-test.ts";
import { CLI_ENTRYPOINT, REPO_ROOT } from "../fixtures/paths.ts";
import { buildProcessTokenProbe } from "../fixtures/process-token-probe.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

export { CLI_ENTRYPOINT, expectExitZero, REPO_ROOT };

export const BASE_POLICY = path.join(
  REPO_ROOT,
  "nemoclaw-blueprint",
  "policies",
  "openclaw-sandbox.yaml",
);
export const FAKE_LIB_DIR = path.join(REPO_ROOT, "test", "e2e", "lib");
export const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? `e2e-msg-${process.pid}`;
export const INSTALL_TIMEOUT_MS = 45 * 60_000;
export const REBUILD_TIMEOUT_MS = 25 * 60_000;
export const PROBE_TIMEOUT_MS = 120_000;
export const LIVE_TIMEOUT_MS = 90 * 60_000;
export const OPENSHELL_EXEC_ARGUMENT_LIMIT_BYTES = 32_768;
const FAKE_API_IMAGE =
  "node:22-trixie-slim@sha256:db8a96a63e5264607ada2d206758876ebbed6a12be2ada7517793cbfb0c2a29c";
const DEFAULT_OPENSHELL_DOCKER_NETWORK = "openshell-docker";
export const FAKE_API_PROXY_READINESS_PORT = 8079;
export const FAKE_API_PROXY_SOURCE = String.raw`
const net = require("node:net");
const upstream = process.env.NEMOCLAW_FAKE_API_UPSTREAM;
const listenAddress = process.env.NEMOCLAW_FAKE_API_PROXY_LISTEN_ADDRESS || "0.0.0.0";
const readinessPort = Number(process.env.NEMOCLAW_FAKE_API_PROXY_READINESS_PORT);
const portMappings = (process.env.NEMOCLAW_FAKE_API_PROXY_PORTS || "")
  .split(",")
  .filter(Boolean)
  .map((mapping) => mapping.split(":").map(Number));

if (
  !upstream ||
  !net.isIPv4(listenAddress) ||
  !Number.isInteger(readinessPort) ||
  readinessPort < 1 ||
  readinessPort > 65535 ||
  portMappings.length === 0 ||
  portMappings.some(
    (mapping) =>
      mapping.length !== 2 ||
      mapping.some((port) => !Number.isInteger(port) || port < 1 || port > 65535),
  )
) {
  process.exit(2);
}

function upstreamAcceptsConnection(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, upstream);
    let settled = false;
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

const proxyServers = portMappings.map(([listenPort, upstreamPort]) => {
  const server = net.createServer((client) => {
    const backend = net.connect(upstreamPort, upstream);
    const close = () => {
      client.destroy();
      backend.destroy();
    };
    client.on("error", close);
    backend.on("error", close);
    client.pipe(backend).pipe(client);
  });
  return { listenPort, server };
});

const readinessServer = net.createServer(async (client) => {
  client.on("error", () => client.destroy());
  const ready = (
    await Promise.all(portMappings.map(([, upstreamPort]) => upstreamAcceptsConnection(upstreamPort)))
  ).every(Boolean);
  ready ? client.end("ready\n") : client.destroy();
});

Promise.all(
  proxyServers.map(
    ({ listenPort, server }) =>
      new Promise((resolve) => {
        server.once("error", () => process.exit(3));
        server.listen(listenPort, listenAddress, resolve);
      }),
  ),
)
  .then(() => {
    readinessServer.once("error", () => process.exit(3));
    readinessServer.listen(readinessPort, listenAddress);
  })
  .catch(() => process.exit(3));
`;
export const FAKE_API_PROXY_READINESS_SOURCE = String.raw`
const net = require("node:net");
const host = process.argv[1];
const port = Number(process.argv[2]);

if (!net.isIPv4(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
  process.exit(2);
}

function reachesUpstream() {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let response = "";
    let settled = false;
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ready);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(750, () => finish(false));
    socket.on("data", (chunk) => {
      response += chunk;
      if (response.includes("ready\n")) finish(true);
    });
    socket.once("end", () => finish(response.includes("ready\n")));
    socket.once("error", () => finish(false));
  });
}

(async () => {
  const deadline = Date.now() + 10000;
  do {
    if (await reachesUpstream()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  console.error("proxy did not connect to the upstream API before the readiness deadline");
  process.exit(3);
})().catch(() => process.exit(4));
`;

// Keep each source chunk at or below half of OpenShell's 32,768-byte argument limit.
const SANDBOX_SOURCE_CHUNK_BYTES = 16_384;
const SANDBOX_SHELL_BOOTSTRAP = `set -eu; printf '%s' "$@" | base64 -d | sh`;

validateSandboxName(SANDBOX_NAME);

export type CommandOutput = Pick<ShellProbeResult, "stdout" | "stderr" | "exitCode">;

export type MessagingTokens = {
  telegram: string;
  discord: string;
  slackBot: string;
  slackApp: string;
  wechat: string;
  whatsappDecoys: readonly string[];
  extraTelegramA: string;
  extraTelegramB: string;
  extraGithub: string;
};

export type MessagingEnv = {
  env: NodeJS.ProcessEnv;
  tokens: MessagingTokens;
  telegramIds: string;
  telegramAllowlistKey:
    | "TELEGRAM_ALLOWED_IDS"
    | "TELEGRAM_AUTHORIZED_CHAT_IDS"
    | "TELEGRAM_CHAT_ID";
  slackIds: string;
  wechatAccount: string;
};

export type OpenClawConfig = {
  channels?: Record<string, ChannelConfig>;
  plugins?: {
    entries?: Record<string, { enabled?: unknown }>;
    installs?: Record<string, Record<string, unknown>>;
  };
  proxy?: { enabled?: unknown; proxyUrl?: unknown };
};

export type ChannelConfig = {
  enabled?: unknown;
  accounts?: Record<string, AccountConfig>;
};

export type AccountConfig = Record<string, unknown>;
export { shellQuote };

export function assertDiscordGatewayCapture(captureFile: string, expectedToken: string): void {
  const rows = fs
    .readFileSync(captureFile, "utf8")
    .trim()
    .split(/\n+/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const identify = rows.filter((row) => row.event === "identify").at(-1);
  expect(identify !== undefined, "fake Discord Gateway did not capture IDENTIFY").toBe(true);
  expect(
    identify !== undefined && !Object.hasOwn(identify, "token"),
    "fake Discord Gateway capture persisted token field",
  ).toBe(true);
  expect(
    !rows.some((row) => JSON.stringify(row).includes(expectedToken)),
    "fake Discord Gateway capture persisted raw token",
  ).toBe(true);
  expect(identify?.tokenMatchesExpected, "Discord token rewrite").toBe(true);
  expect(identify?.tokenLooksPlaceholder, "Discord placeholder leaked").toBe(false);
}

export type FakeDockerApiKind = "slack" | "telegram" | "wechat" | "discord-gateway";

export type FakeDockerApi = {
  kind: FakeDockerApiKind;
  port: string;
  alternatePort?: string;
  captureFile: string;
};

export function outputText(result: CommandOutput): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

export function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

export function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

export function uniqueContainerName(prefix: string): string {
  return `${prefix}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isFakeSlackToken(value: string): boolean {
  return /^(xoxb|xapp)-(fake|test)-/.test(value);
}

export function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function parseRuntimeProofPort(rawPort: string): number {
  if (!/^[0-9]+$/u.test(rawPort)) {
    throw new Error("runtime proof port must contain decimal digits only");
  }
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("runtime proof port must be an integer between 1 and 65535");
  }
  return port;
}

export function isUnresolvedPlaceholderRejection(text: string): boolean {
  return /credential_injection_failed|unresolved credential placeholder/i.test(text);
}

export function isNvidiaEndpointRateLimitFailure(text: string): boolean {
  return (
    /NVIDIA Endpoints endpoint validation failed/i.test(text) &&
    /HTTP 429|too many requests|rate limit/i.test(text)
  );
}

export function countCsv(value: string): number {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean).length;
}

export function tokenValues(tokens: MessagingTokens): string[] {
  return [
    tokens.telegram,
    tokens.discord,
    tokens.slackBot,
    tokens.slackApp,
    tokens.wechat,
    tokens.extraTelegramA,
    tokens.extraTelegramB,
    tokens.extraGithub,
    ...tokens.whatsappDecoys,
    ...[
      tokens.telegram,
      tokens.discord,
      tokens.slackBot,
      tokens.slackApp,
      tokens.wechat,
      tokens.extraTelegramA,
      tokens.extraTelegramB,
      tokens.extraGithub,
      ...tokens.whatsappDecoys,
    ].map(base64),
  ].filter(Boolean);
}

export function messagingEnv(): MessagingEnv {
  const telegram =
    nonEmpty(process.env.TELEGRAM_BOT_TOKEN_REAL) ??
    nonEmpty(process.env.TELEGRAM_BOT_TOKEN) ??
    "test-fake-telegram-token-e2e";
  const discord =
    nonEmpty(process.env.DISCORD_BOT_TOKEN_REAL) ??
    nonEmpty(process.env.DISCORD_BOT_TOKEN) ??
    "test-fake-discord-token-e2e";
  const slackBot =
    nonEmpty(process.env.SLACK_BOT_TOKEN_REAL) ??
    nonEmpty(process.env.SLACK_BOT_TOKEN) ??
    "xoxb-fake-slack-token-e2e";
  const slackApp =
    nonEmpty(process.env.SLACK_APP_TOKEN_REAL) ??
    nonEmpty(process.env.SLACK_APP_TOKEN) ??
    "xapp-fake-slack-app-token-e2e";
  const wechat = "test-fake-wechat-token-e2e";
  const wechatAccount = nonEmpty(process.env.WECHAT_ACCOUNT_ID) ?? "e2e-fake-account-12345";
  const slackIds = nonEmpty(process.env.SLACK_ALLOWED_USERS) ?? "U0AR85ATALW,U09E2ESLACK";

  let telegramIds = "123456789,987654321";
  let telegramAllowlistKey: MessagingEnv["telegramAllowlistKey"] = "TELEGRAM_AUTHORIZED_CHAT_IDS";
  if (nonEmpty(process.env.TELEGRAM_ALLOWED_IDS)) {
    telegramIds = nonEmpty(process.env.TELEGRAM_ALLOWED_IDS) ?? telegramIds;
    telegramAllowlistKey = "TELEGRAM_ALLOWED_IDS";
  } else if (nonEmpty(process.env.TELEGRAM_AUTHORIZED_CHAT_IDS)) {
    telegramIds = nonEmpty(process.env.TELEGRAM_AUTHORIZED_CHAT_IDS) ?? telegramIds;
    telegramAllowlistKey = "TELEGRAM_AUTHORIZED_CHAT_IDS";
  } else if (nonEmpty(process.env.TELEGRAM_CHAT_ID)) {
    telegramIds = nonEmpty(process.env.TELEGRAM_CHAT_ID) ?? telegramIds;
    telegramAllowlistKey = "TELEGRAM_CHAT_ID";
  }

  const whatsappDecoys = [
    "test-fake-whatsapp-token-e2e",
    "test-fake-whatsapp-bot-token-e2e",
    "test-fake-whatsapp-session-secret-e2e",
  ] as const;
  const tokens: MessagingTokens = {
    telegram,
    discord,
    slackBot,
    slackApp,
    wechat,
    whatsappDecoys,
    extraTelegramA: "test-fake-telegram-token-agent-a-e2e",
    extraTelegramB: "test-fake-telegram-token-agent-b-e2e",
    extraGithub: "test-fake-host-secret-that-must-not-leak",
  };

  const env: NodeJS.ProcessEnv = {
    ...buildAvailabilityProbeEnv(),
    PATH: [
      path.join(os.homedir(), ".local", "bin"),
      path.join(os.homedir(), ".npm-global", "bin"),
      process.env.PATH ?? "",
    ]
      .filter(Boolean)
      .join(":"),
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    NEMOCLAW_FRESH: "1",
    NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    NVIDIA_INFERENCE_API_KEY: process.env.NVIDIA_INFERENCE_API_KEY,
    TELEGRAM_BOT_TOKEN: telegram,
    DISCORD_BOT_TOKEN: discord,
    SLACK_BOT_TOKEN: slackBot,
    SLACK_APP_TOKEN: slackApp,
    SLACK_ALLOWED_USERS: slackIds,
    WECHAT_BOT_TOKEN: wechat,
    WECHAT_ACCOUNT_ID: wechatAccount,
    WECHAT_BASE_URL: nonEmpty(process.env.WECHAT_BASE_URL) ?? "https://ilinkai.wechat.com",
    WECHAT_USER_ID: nonEmpty(process.env.WECHAT_USER_ID) ?? "wxid_e2efakeoperator",
    WECHAT_ALLOWED_IDS:
      nonEmpty(process.env.WECHAT_ALLOWED_IDS) ??
      nonEmpty(process.env.WECHAT_USER_ID) ??
      "wxid_e2efakeoperator",
    WHATSAPP_TOKEN: whatsappDecoys[0],
    WHATSAPP_BOT_TOKEN: whatsappDecoys[1],
    WHATSAPP_SESSION_SECRET: whatsappDecoys[2],
    NEMOCLAW_EXTRA_PLACEHOLDER_KEYS:
      "TELEGRAM_BOT_TOKEN_AGENT_A TELEGRAM_BOT_TOKEN_AGENT_B TELEGRAM_BOT_TOKEN_AGENT_MISSING GITHUB_TOKEN",
    TELEGRAM_BOT_TOKEN_AGENT_A: tokens.extraTelegramA,
    TELEGRAM_BOT_TOKEN_AGENT_B: tokens.extraTelegramB,
    GITHUB_TOKEN: tokens.extraGithub,
  };

  if (telegramAllowlistKey === "TELEGRAM_ALLOWED_IDS") {
    env.TELEGRAM_ALLOWED_IDS = telegramIds;
    delete env.TELEGRAM_AUTHORIZED_CHAT_IDS;
    delete env.TELEGRAM_CHAT_ID;
  } else if (telegramAllowlistKey === "TELEGRAM_AUTHORIZED_CHAT_IDS") {
    delete env.TELEGRAM_ALLOWED_IDS;
    env.TELEGRAM_AUTHORIZED_CHAT_IDS = telegramIds;
    delete env.TELEGRAM_CHAT_ID;
  } else {
    delete env.TELEGRAM_ALLOWED_IDS;
    delete env.TELEGRAM_AUTHORIZED_CHAT_IDS;
    env.TELEGRAM_CHAT_ID = telegramIds;
  }

  if (
    !process.env.NEMOCLAW_SKIP_TELEGRAM_REACHABILITY &&
    !nonEmpty(process.env.TELEGRAM_BOT_TOKEN_REAL) &&
    telegram.includes("fake")
  ) {
    env.NEMOCLAW_SKIP_TELEGRAM_REACHABILITY = "1";
  }
  if (
    !process.env.NEMOCLAW_SKIP_SLACK_AUTH_VALIDATION &&
    !nonEmpty(process.env.SLACK_BOT_TOKEN_REAL) &&
    !nonEmpty(process.env.SLACK_APP_TOKEN_REAL) &&
    (isFakeSlackToken(slackBot) || isFakeSlackToken(slackApp))
  ) {
    env.NEMOCLAW_SKIP_SLACK_AUTH_VALIDATION = "1";
  }

  return { env, tokens, telegramIds, telegramAllowlistKey, slackIds, wechatAccount };
}

export async function runSecondaryCleanup(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Cleanup and diagnostics should not hide the primary failure.
  }
}

export async function runHost(
  host: HostCliClient,
  command: string,
  args: string[],
  options: {
    artifactName: string;
    env: NodeJS.ProcessEnv;
    redactionValues: string[];
    cwd?: string;
    timeoutMs?: number;
  },
): Promise<ShellProbeResult> {
  return host.command(command, args, {
    artifactName: options.artifactName,
    cwd: options.cwd,
    env: options.env,
    redactionValues: options.redactionValues,
    timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS,
  });
}

export async function runSandboxShell(
  sandbox: SandboxClient,
  script: string,
  options: {
    artifactName: string;
    redactionValues: string[];
    timeoutMs?: number;
  },
): Promise<ShellProbeResult> {
  return sandbox.exec(SANDBOX_NAME, buildSandboxShellInvocation(script), {
    artifactName: options.artifactName,
    env: sandboxAccessEnv(),
    redactionValues: options.redactionValues,
    timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS,
  });
}

export async function runSandboxNode(
  sandbox: SandboxClient,
  source: string,
  options: {
    artifactName: string;
    env?: Record<string, string>;
    redactionValues: string[];
    sandboxName?: string;
    timeoutMs?: number;
  },
): Promise<ShellProbeResult> {
  return sandbox.exec(
    options.sandboxName ?? SANDBOX_NAME,
    buildSandboxNodeInvocation(source, options),
    {
      artifactName: options.artifactName,
      env: sandboxAccessEnv(),
      redactionValues: options.redactionValues,
      timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS,
    },
  );
}

export function buildSandboxNodeInvocation(
  source: string,
  options: {
    artifactName: string;
    env?: Record<string, string>;
  },
): string[] {
  const environment = Object.entries(options.env ?? {}).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      throw new Error(`sandbox Node environment variable name is invalid: ${key}`);
    }
    return `export ${key}=${shellQuote(value)}`;
  });
  const scriptName = `/tmp/nemoclaw-${options.artifactName.replace(/[^a-zA-Z0-9_.-]/g, "-")}.mjs`;
  return buildSandboxShellInvocation(`
set -eu
${environment.join("\n")}
printf '%s' ${shellQuote(base64(source))} | base64 -d > ${shellQuote(scriptName)}
node --preserve-symlinks ${shellQuote(scriptName)}
`);
}

export function buildSandboxShellInvocation(script: string): string[] {
  const encodedScript = base64(script);
  const chunks: string[] = [];
  for (let offset = 0; offset < encodedScript.length; offset += SANDBOX_SOURCE_CHUNK_BYTES) {
    chunks.push(encodedScript.slice(offset, offset + SANDBOX_SOURCE_CHUNK_BYTES));
  }
  if (chunks.length === 0) chunks.push("");

  const invocation = ["sh", "-lc", SANDBOX_SHELL_BOOTSTRAP, "nemoclaw-shell-bootstrap", ...chunks];
  const oversizedArgument = invocation.find(
    (argument) => Buffer.byteLength(argument, "utf8") >= OPENSHELL_EXEC_ARGUMENT_LIMIT_BYTES,
  );
  if (oversizedArgument !== undefined) {
    throw new Error(
      `sandbox invocation argument must be smaller than ${OPENSHELL_EXEC_ARGUMENT_LIMIT_BYTES} bytes`,
    );
  }
  return invocation;
}

export function check(condition: boolean, message: string): void {
  expect.soft(condition, message).toBe(true);
}

export async function skipNote(
  artifacts: ArtifactSink,
  notes: string[],
  message: string,
): Promise<void> {
  notes.push(message);
  console.warn(`[skip] ${message}`);
  await artifacts.writeJson("messaging-provider-skips.json", notes);
}

export function policyTextHasHost(text: string, host: string): boolean {
  const accepted = new Set([
    `host: ${host}`,
    `host: "${host}"`,
    `host: '${host}'`,
    `- host: ${host}`,
    `- host: "${host}"`,
    `- host: '${host}'`,
  ]);
  return text.split(/\r?\n/).some((line) => accepted.has(line.trim()));
}

export async function premergeSlackPolicyIfNeeded(): Promise<() => void> {
  const original = fs.readFileSync(BASE_POLICY, "utf8");
  if (policyTextHasHost(original, "api.slack.com")) {
    return () => {};
  }
  fs.appendFileSync(
    BASE_POLICY,
    `

  # Slack - pre-merged for messaging provider E2E (#2340)
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
`,
  );
  return () => fs.writeFileSync(BASE_POLICY, original);
}

export async function readOpenClawConfig(
  sandbox: SandboxClient,
  redactionValues: string[],
): Promise<OpenClawConfig> {
  const result = await runSandboxShell(
    sandbox,
    `python3 - <<'PY'
import json
print(json.dumps(json.load(open('/sandbox/.openclaw/openclaw.json'))))
PY`,
    { artifactName: "read-openclaw-config-messaging-providers", redactionValues },
  );
  expectExitZero(result, "read openclaw.json");
  return JSON.parse(result.stdout.trim()) as OpenClawConfig;
}

export function channelAccount(
  config: OpenClawConfig,
  channel: string,
  accountId = "default",
): AccountConfig {
  const accounts = config.channels?.[channel]?.accounts;
  if (!accounts || typeof accounts !== "object") return {};
  const account = accounts[accountId] ?? accounts.main ?? Object.values(accounts)[0];
  return account && typeof account === "object" ? account : {};
}

export function channelEnabled(config: OpenClawConfig, channel: string): boolean {
  return config.channels?.[channel]?.enabled === true;
}

export function pluginEnabled(config: OpenClawConfig, plugin: string): boolean {
  return config.plugins?.entries?.[plugin]?.enabled === true;
}

export function accountString(account: AccountConfig, key: string): string {
  const value = account[key];
  return typeof value === "string" ? value : "";
}

export function accountBool(account: AccountConfig, key: string): boolean | undefined {
  const value = account[key];
  return typeof value === "boolean" ? value : undefined;
}

export async function sandboxOutput(
  sandbox: SandboxClient,
  script: string,
  artifactName: string,
  redactionValues: string[],
): Promise<string> {
  const result = await runSandboxShell(sandbox, script, { artifactName, redactionValues });
  expectExitZero(result, artifactName);
  return result.stdout.trim();
}

export async function rawTokenSurfaceProbe(
  sandbox: SandboxClient,
  token: string,
  surface: "env" | "process" | "filesystem",
  artifactName: string,
  redactionValues: string[],
): Promise<string> {
  const tokenB64 = base64(token);
  const probe =
    surface === "env"
      ? `token="$(printf '%s' ${shellQuote(tokenB64)} | base64 -d)"
if env 2>/dev/null | grep -Fq "$token"; then echo FOUND; else echo ABSENT; fi`
      : surface === "process"
        ? buildProcessTokenProbe(token)
        : `token="$(printf '%s' ${shellQuote(tokenB64)} | base64 -d)"
match="$(grep -rIlm1 -F "$token" /sandbox /home /etc /tmp /var 2>/dev/null | head -1 || true)"
if [ -n "$match" ]; then printf '%s\n' "$match"; else echo ABSENT; fi`;
  return sandboxOutput(sandbox, probe, artifactName, redactionValues);
}

async function captureFakeApiContainerDiagnostics(
  host: HostCliClient,
  kind: FakeDockerApiKind,
  component: "api" | "api-proxy",
  container: string,
  env: NodeJS.ProcessEnv,
  redactionValues: string[],
): Promise<void> {
  await runSecondaryCleanup(async () => {
    await runHost(host, "docker", ["inspect", "--format", "{{json .State}}", container], {
      artifactName: `diagnose-fake-${kind}-${component}-state`,
      env,
      redactionValues,
      timeoutMs: 30_000,
    });
  });
  await runSecondaryCleanup(async () => {
    await runHost(host, "docker", ["logs", "--tail", "100", container], {
      artifactName: `diagnose-fake-${kind}-${component}-logs`,
      env,
      redactionValues,
      timeoutMs: 30_000,
    });
  });
}

async function requireFakeApiProxyReady(
  host: HostCliClient,
  options: {
    kind: FakeDockerApiKind;
    proxyContainer: string;
    bridgeAddress: string;
    readinessPort: string;
    captureDiagnostics: () => Promise<void>;
    env: NodeJS.ProcessEnv;
    redactionValues: string[];
  },
): Promise<void> {
  const running = await runHost(
    host,
    "docker",
    ["inspect", "--format", "{{.State.Running}}", options.proxyContainer],
    {
      artifactName: `inspect-fake-${options.kind}-api-proxy-readiness`,
      env: options.env,
      redactionValues: options.redactionValues,
      timeoutMs: 30_000,
    },
  );
  const ready =
    running.exitCode === 0 && running.stdout.trim() === "true"
      ? await runHost(
          host,
          "node",
          ["-e", FAKE_API_PROXY_READINESS_SOURCE, options.bridgeAddress, options.readinessPort],
          {
            artifactName: `probe-fake-${options.kind}-api-proxy-readiness`,
            env: options.env,
            redactionValues: options.redactionValues,
            timeoutMs: 15_000,
          },
        )
      : undefined;
  if (ready?.exitCode === 0) return;

  await options.captureDiagnostics();
  throw new Error(
    `fake ${options.kind} API proxy ${options.proxyContainer} did not become ready; attempted to capture redacted proxy and API diagnostics`,
  );
}

type DockerContainerInspect = {
  Config?: {
    Env?: unknown;
  };
  Name?: unknown;
  HostConfig?: {
    CapDrop?: unknown;
    PidsLimit?: unknown;
    ReadonlyRootfs?: unknown;
    SecurityOpt?: unknown;
  };
  NetworkSettings?: {
    Networks?: unknown;
    Ports?: unknown;
  };
};

function containerNetworks(record: DockerContainerInspect): string[] {
  const networks = record.NetworkSettings?.Networks;
  return networks !== null && typeof networks === "object" ? Object.keys(networks).sort() : [];
}

function publishedPortBindings(record: DockerContainerInspect): Array<{
  containerPort: string;
  hostAddress: string;
  hostPort: string;
}> {
  const ports = record.NetworkSettings?.Ports;
  if (ports === null || typeof ports !== "object") return [];
  return Object.entries(ports).flatMap(([containerPort, bindings]) =>
    Array.isArray(bindings)
      ? bindings.flatMap((binding) => {
          if (binding === null || typeof binding !== "object") return [];
          const { HostIp: hostAddress, HostPort: hostPort } = binding as {
            HostIp?: unknown;
            HostPort?: unknown;
          };
          return typeof hostAddress === "string" && typeof hostPort === "string"
            ? [{ containerPort, hostAddress, hostPort }]
            : [];
        })
      : [],
  );
}

function stringValues(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

const CREDENTIAL_ENVIRONMENT_NAME =
  /(?:^|_)(?:API_?KEY|CREDENTIALS?|PASSWORDS?|SECRETS?|TOKENS?)(?:_|$)/u;

function environmentName(entry: string): string {
  return entry.split("=", 1)[0]!;
}

function environmentContainsCredential(entries: string[], redactionValues: string[]): boolean {
  return entries.some(
    (entry) =>
      CREDENTIAL_ENVIRONMENT_NAME.test(environmentName(entry)) ||
      redactionValues.some((value) => value.length > 0 && entry.includes(value)),
  );
}

async function requireFakeApiDockerTopology(
  host: HostCliClient,
  options: {
    kind: FakeDockerApiKind;
    apiContainer: string;
    proxyContainer: string;
    network: string;
    openshellBridgeAddress: string;
    proxyPorts: readonly number[];
    env: NodeJS.ProcessEnv;
    redactionValues: string[];
  },
): Promise<void> {
  const containerInspect = await runHost(
    host,
    "docker",
    ["inspect", options.apiContainer, options.proxyContainer],
    {
      artifactName: `inspect-fake-${options.kind}-api-topology`,
      env: options.env,
      redactionValues: options.redactionValues,
      timeoutMs: 30_000,
    },
  );
  expectExitZero(containerInspect, `inspect fake ${options.kind} API topology`);
  const networkInspect = await runHost(host, "docker", ["network", "inspect", options.network], {
    artifactName: `inspect-fake-${options.kind}-api-network`,
    env: options.env,
    redactionValues: options.redactionValues,
    timeoutMs: 30_000,
  });
  expectExitZero(networkInspect, `inspect fake ${options.kind} API network`);

  let containers: unknown;
  let networks: unknown;
  try {
    containers = JSON.parse(containerInspect.stdout);
    networks = JSON.parse(networkInspect.stdout);
  } catch {
    throw new Error(`fake ${options.kind} API Docker topology inspection returned invalid JSON`);
  }
  const records = Array.isArray(containers) ? (containers as DockerContainerInspect[]) : [];
  const api = records.find((record) => record.Name === `/${options.apiContainer}`);
  const proxy = records.find((record) => record.Name === `/${options.proxyContainer}`);
  const networkRecord = Array.isArray(networks) && networks.length === 1 ? networks[0] : undefined;
  const apiNetworks = api === undefined ? [] : containerNetworks(api);
  const proxyNetworks = proxy === undefined ? [] : containerNetworks(proxy);
  const apiBindings = api === undefined ? [] : publishedPortBindings(api);
  const proxyBindings = proxy === undefined ? [] : publishedPortBindings(proxy);
  const expectedContainerPorts = options.proxyPorts.map((port) => `${String(port)}/tcp`).sort();
  const observedContainerPorts = proxyBindings.map(({ containerPort }) => containerPort).sort();
  const proxySecurityOptions = stringValues(proxy?.HostConfig?.SecurityOpt);
  const proxyCapabilityDrops = stringValues(proxy?.HostConfig?.CapDrop);
  const inspectedProxyEnvironment = proxy?.Config?.Env;
  const proxyEnvironmentValid = isStringArray(inspectedProxyEnvironment);
  const proxyEnvironment = proxyEnvironmentValid ? inspectedProxyEnvironment : [];
  const networkDriver =
    networkRecord !== null &&
    typeof networkRecord === "object" &&
    typeof (networkRecord as { Driver?: unknown }).Driver === "string"
      ? (networkRecord as { Driver: string }).Driver
      : undefined;
  const networkInternal =
    networkRecord !== null &&
    typeof networkRecord === "object" &&
    (networkRecord as { Internal?: unknown }).Internal === true;
  if (
    api === undefined ||
    proxy === undefined ||
    networkDriver !== "bridge" ||
    !networkInternal ||
    JSON.stringify(apiNetworks) !== JSON.stringify([options.network]) ||
    JSON.stringify(proxyNetworks) !== JSON.stringify(["bridge", options.network].sort()) ||
    apiBindings.length !== 0 ||
    JSON.stringify(observedContainerPorts) !== JSON.stringify(expectedContainerPorts) ||
    proxyBindings.some(
      ({ hostAddress, hostPort }) =>
        hostAddress !== options.openshellBridgeAddress || !/^\d+$/u.test(hostPort),
    ) ||
    proxy?.HostConfig?.ReadonlyRootfs !== true ||
    !proxyCapabilityDrops.includes("ALL") ||
    !proxySecurityOptions.includes("no-new-privileges") ||
    !proxyEnvironmentValid ||
    environmentContainsCredential(proxyEnvironment, options.redactionValues) ||
    proxy?.HostConfig?.PidsLimit !== 32
  ) {
    throw new Error(`fake ${options.kind} API Docker topology did not preserve isolation`);
  }
}

export async function startFakeDockerApi(
  host: HostCliClient,
  cleanup: (name: string, run: () => Promise<void>) => void,
  options: {
    kind: FakeDockerApiKind;
    imageScript: string;
    nodeArgs?: readonly string[];
    containerPrefix: string;
    portEnv: string;
    captureFileEnv: string;
    expectedEnv: Record<string, string>;
    redactionValues: string[];
    env: NodeJS.ProcessEnv;
  },
): Promise<FakeDockerApi> {
  fs.mkdirSync(path.join(REPO_ROOT, ".tmp"), { recursive: true });
  const dir = fs.mkdtempSync(path.join(REPO_ROOT, ".tmp", `fake-${options.kind}.`));
  const captureFile = path.join(dir, "capture.jsonl");
  const container = uniqueContainerName(options.containerPrefix);
  const proxyContainer = uniqueContainerName(`${options.containerPrefix}-proxy`);
  const network = uniqueContainerName("nemoclaw-fake-api-network");
  const containerPorts = options.kind === "slack" ? [8080, 8081] : [8080];
  const proxyPorts = [FAKE_API_PROXY_READINESS_PORT, ...containerPorts];
  fs.writeFileSync(captureFile, "");
  cleanup(`remove ${dir}`, async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  const openshellNetwork =
    options.env.OPENSHELL_DOCKER_NETWORK_NAME ??
    process.env.OPENSHELL_DOCKER_NETWORK_NAME ??
    DEFAULT_OPENSHELL_DOCKER_NETWORK;
  const openshellNetworkInspect = await runHost(
    host,
    "docker",
    ["network", "inspect", openshellNetwork],
    {
      artifactName: `inspect-fake-${options.kind}-openshell-network`,
      env: options.env,
      redactionValues: options.redactionValues,
      timeoutMs: 30_000,
    },
  );
  expectExitZero(openshellNetworkInspect, "inspect OpenShell Docker network");
  let openshellNetworkRecords: unknown;
  try {
    openshellNetworkRecords = JSON.parse(openshellNetworkInspect.stdout);
  } catch {
    throw new Error("OpenShell Docker network inspection returned invalid JSON");
  }
  const openshellBridgeAddresses =
    Array.isArray(openshellNetworkRecords) && openshellNetworkRecords.length === 1
      ? ((
          openshellNetworkRecords[0] as {
            Driver?: unknown;
            IPAM?: { Config?: Array<{ Gateway?: unknown }> };
          }
        ).IPAM?.Config?.flatMap((entry) =>
          typeof entry.Gateway === "string" && isIPv4(entry.Gateway) ? [entry.Gateway] : [],
        ) ?? [])
      : [];
  const openshellBridgeAddress =
    openshellBridgeAddresses.length === 1 ? openshellBridgeAddresses[0] : undefined;
  if (
    (openshellNetworkRecords as Array<{ Driver?: unknown }> | undefined)?.[0]?.Driver !==
      "bridge" ||
    typeof openshellBridgeAddress !== "string"
  ) {
    throw new Error("OpenShell Docker network must expose exactly one IPv4 bridge gateway");
  }

  const networkCreate = await runHost(
    host,
    "docker",
    ["network", "create", "--internal", network],
    {
      artifactName: `create-fake-${options.kind}-api-network`,
      env: options.env,
      redactionValues: options.redactionValues,
      timeoutMs: 30_000,
    },
  );
  expectExitZero(networkCreate, `create fake ${options.kind} API network`);
  cleanup(`remove ${network}`, async () => {
    const remove = await runHost(host, "docker", ["network", "rm", network], {
      artifactName: `cleanup-${network}`,
      env: options.env,
      redactionValues: options.redactionValues,
      timeoutMs: 60_000,
    });
    if (remove.exitCode !== 0 && !/No such network:/iu.test(resultText(remove))) {
      expectExitZero(remove, `remove fake ${options.kind} API network ${network}`);
    }
  });

  const dockerArgs = [
    "run",
    "-d",
    "--name",
    container,
    "--network",
    network,
    "-e",
    `${options.portEnv}=8080`,
    "-e",
    `${options.captureFileEnv}=/tmp/fake/capture.jsonl`,
  ];
  if (options.kind === "slack") dockerArgs.push("-e", "FAKE_SLACK_API_WEBSOCKET_PORT=8081");
  for (const [key, value] of Object.entries(options.expectedEnv)) {
    dockerArgs.push("-e", `${key}=${value}`);
  }
  dockerArgs.push(
    "-v",
    `${dir}:/tmp/fake`,
    "-v",
    `${FAKE_LIB_DIR}:/opt/nemoclaw-e2e:ro`,
    FAKE_API_IMAGE,
    "node",
    ...(options.nodeArgs ?? []),
    `/opt/nemoclaw-e2e/${options.imageScript}`,
  );

  let apiDiagnosticsCaptured = false;
  const captureApiDiagnostics = async (): Promise<void> => {
    if (apiDiagnosticsCaptured) return;
    apiDiagnosticsCaptured = true;
    await captureFakeApiContainerDiagnostics(
      host,
      options.kind,
      "api",
      container,
      options.env,
      options.redactionValues,
    );
  };
  cleanup(`remove ${container}`, async () => {
    await captureApiDiagnostics();
    const remove = await runHost(host, "docker", ["rm", "-f", container], {
      artifactName: `cleanup-${container}`,
      env: options.env,
      redactionValues: options.redactionValues,
      timeoutMs: 60_000,
    });
    if (remove.exitCode !== 0 && !/No such container:/iu.test(resultText(remove))) {
      expectExitZero(remove, `remove fake ${options.kind} API container ${container}`);
    }
  });

  const start = await runHost(host, "docker", dockerArgs, {
    artifactName: `start-fake-${options.kind}-api`,
    env: options.env,
    redactionValues: options.redactionValues,
    timeoutMs: 120_000,
  });
  expectExitZero(start, `start fake ${options.kind} API`);

  let proxyDiagnosticsCaptured = false;
  const captureProxyDiagnostics = async (): Promise<void> => {
    if (proxyDiagnosticsCaptured) return;
    proxyDiagnosticsCaptured = true;
    await captureFakeApiContainerDiagnostics(
      host,
      options.kind,
      "api-proxy",
      proxyContainer,
      options.env,
      options.redactionValues,
    );
  };
  cleanup(`remove ${proxyContainer}`, async () => {
    await captureProxyDiagnostics();
    const remove = await runHost(host, "docker", ["rm", "-f", proxyContainer], {
      artifactName: `cleanup-${proxyContainer}`,
      env: options.env,
      redactionValues: options.redactionValues,
      timeoutMs: 60_000,
    });
    if (remove.exitCode !== 0 && !/No such container:/iu.test(resultText(remove))) {
      expectExitZero(remove, `remove fake ${options.kind} API proxy ${proxyContainer}`);
    }
  });

  const proxyStart = await runHost(
    host,
    "docker",
    [
      "run",
      "-d",
      "--name",
      proxyContainer,
      "--network",
      "bridge",
      ...proxyPorts.flatMap((port) => ["-p", `${openshellBridgeAddress}::${String(port)}`]),
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "32",
      "-e",
      `NEMOCLAW_FAKE_API_UPSTREAM=${container}`,
      "-e",
      `NEMOCLAW_FAKE_API_PROXY_PORTS=${containerPorts.map((port) => `${String(port)}:${String(port)}`).join(",")}`,
      "-e",
      `NEMOCLAW_FAKE_API_PROXY_READINESS_PORT=${String(FAKE_API_PROXY_READINESS_PORT)}`,
      FAKE_API_IMAGE,
      "node",
      "-e",
      FAKE_API_PROXY_SOURCE,
    ],
    {
      artifactName: `start-fake-${options.kind}-api-proxy`,
      env: options.env,
      redactionValues: options.redactionValues,
      timeoutMs: 120_000,
    },
  );
  expectExitZero(proxyStart, `start fake ${options.kind} API proxy`);

  const proxyConnect = await runHost(
    host,
    "docker",
    ["network", "connect", network, proxyContainer],
    {
      artifactName: `connect-fake-${options.kind}-api-proxy`,
      env: options.env,
      redactionValues: options.redactionValues,
      timeoutMs: 30_000,
    },
  );
  expectExitZero(proxyConnect, `connect fake ${options.kind} API proxy`);

  await requireFakeApiDockerTopology(host, {
    kind: options.kind,
    apiContainer: container,
    proxyContainer,
    network,
    openshellBridgeAddress,
    proxyPorts,
    env: options.env,
    redactionValues: options.redactionValues,
  });

  const publishedPort = async (containerPort: number, artifactName: string): Promise<string> => {
    const result = await runHost(
      host,
      "docker",
      ["port", proxyContainer, `${String(containerPort)}/tcp`],
      {
        artifactName,
        env: options.env,
        redactionValues: options.redactionValues,
        timeoutMs: 30_000,
      },
    );
    expectExitZero(result, `read fake ${options.kind} API proxy port`);
    const published = result.stdout.trim().match(/^(\d+\.\d+\.\d+\.\d+):(\d+)$/u);
    if (published?.[1] !== openshellBridgeAddress || !published[2]) {
      throw new Error(
        `fake ${options.kind} API proxy port did not bind only to the OpenShell bridge`,
      );
    }
    return published[2];
  };

  const publishedRestPort = await publishedPort(8080, `port-fake-${options.kind}-api`);
  const publishedWebsocketPort =
    options.kind === "slack" ? await publishedPort(8081, "port-fake-slack-websocket-api") : "";
  const publishedReadinessPort = await publishedPort(
    FAKE_API_PROXY_READINESS_PORT,
    `port-fake-${options.kind}-api-proxy-readiness`,
  );
  await requireFakeApiProxyReady(host, {
    kind: options.kind,
    proxyContainer,
    bridgeAddress: openshellBridgeAddress,
    readinessPort: publishedReadinessPort,
    captureDiagnostics: async () => {
      await captureProxyDiagnostics();
      await captureApiDiagnostics();
    },
    env: options.env,
    redactionValues: options.redactionValues,
  });

  return {
    kind: options.kind,
    port: publishedRestPort,
    ...(options.kind === "slack" ? { alternatePort: publishedWebsocketPort } : {}),
    captureFile,
  };
}

export async function applyRestRewritePolicy(
  host: HostCliClient,
  api: FakeDockerApi,
  env: NodeJS.ProcessEnv,
  redactionValues: string[],
  providerName?: string,
): Promise<void> {
  const result = await runHost(
    host,
    "openshell",
    [
      "policy",
      "update",
      SANDBOX_NAME,
      "--add-endpoint",
      `host.openshell.internal:${api.port}:read-write:rest:enforce:request-body-credential-rewrite,allowed-ip=10.0.0.0/8,allowed-ip=172.16.0.0/12,allowed-ip=192.168.0.0/16`,
      "--add-allow",
      `host.openshell.internal:${api.port}:GET:/**`,
      "--add-allow",
      `host.openshell.internal:${api.port}:POST:/**`,
      "--binary",
      "/usr/local/bin/node",
      "--binary",
      "/usr/bin/node",
      "--wait",
    ],
    {
      artifactName: `apply-${api.kind}-rest-policy`,
      env,
      redactionValues,
      timeoutMs: 120_000,
    },
  );
  expectExitZero(result, `apply ${api.kind} fake REST policy`);
  if (!providerName) return;

  const binding = await runHost(
    host,
    "bash",
    [
      "-lc",
      String.raw`set -eu
policy_file="$(mktemp)"
trap 'rm -f "$policy_file"' EXIT
"$1" policy get --base "$2" >"$policy_file"
node --import tsx "$5" "$policy_file" "$3" host.openshell.internal "$4" rest
"$1" policy set --policy "$policy_file" --wait "$2"`,
      `bind-fake-${api.kind}-rest-policy`,
      host.openshellCommandPath,
      SANDBOX_NAME,
      providerName,
      api.port,
      path.join(REPO_ROOT, "test/e2e/fixtures/hermes-discord-policy-binding.ts"),
    ],
    {
      artifactName: `apply-${api.kind}-rest-policy-credential-binding`,
      cwd: REPO_ROOT,
      env,
      redactionValues,
      timeoutMs: 120_000,
    },
  );
  expectExitZero(binding, `bind ${api.kind} fake REST policy credential`);
}

export function lastJsonLine(
  file: string,
  predicate: (row: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  if (!fs.existsSync(file)) return undefined;
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split(/\n+/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter(predicate)
    .at(-1);
}

export async function runSlackApiRequest(
  sandbox: SandboxClient,
  port: string,
  apiPath: string,
  authorization: string,
  redactionValues: string[],
): Promise<string> {
  const result = await runSandboxNode(
    sandbox,
    `
import http from "node:http";

const authorization = process.env.FAKE_SLACK_AUTH ?? "";
const token = authorization.replace(/^Bearer\\s+/, "");
const data = new URLSearchParams({ token }).toString();
const req = http.request({
  hostname: "host.openshell.internal",
  port: Number(process.env.FAKE_SLACK_PORT),
  path: process.env.FAKE_SLACK_PATH,
  method: "POST",
  headers: {
    Authorization: authorization,
    "Content-Type": "application/x-www-form-urlencoded",
    "Content-Length": Buffer.byteLength(data),
  },
}, (res) => {
  let body = "";
  res.on("data", (chunk) => { body += chunk; });
  res.on("end", () => {
    console.log(\`\${res.statusCode} \${body.slice(0, 300)}\`);
  });
});
req.on("error", (error) => console.log(\`ERROR: \${error.message}\`));
req.setTimeout(30000, () => {
  req.destroy();
  console.log("TIMEOUT");
});
req.write(data);
req.end();
`,
    {
      artifactName: `fake-slack-${apiPath.replace(/[^a-z0-9]+/gi, "-")}`,
      env: {
        FAKE_SLACK_PORT: port,
        FAKE_SLACK_PATH: apiPath,
        FAKE_SLACK_AUTH: authorization,
      },
      redactionValues,
      timeoutMs: 60_000,
    },
  );
  expectExitZero(result, `fake Slack request ${apiPath}`);
  return result.stdout.trim();
}

export type DiscordGatewayIdentifyToken =
  | { readonly kind: "explicit"; readonly value: string }
  | { readonly kind: "revisioned-discord-env" };

export const DISCORD_GATEWAY_CLIENT_SOURCE = String.raw`
import crypto from "node:crypto";
import net from "node:net";

const host = "host.openshell.internal";
const port = Number(process.env.FAKE_DISCORD_GATEWAY_PORT);
function resolveIdentifyToken() {
  const mode = process.env.FAKE_DISCORD_IDENTIFY_MODE || "explicit";
  if (mode === "explicit") return process.env.FAKE_DISCORD_IDENTIFY_TOKEN || "";
  if (mode !== "revisioned-discord-env") {
    throw new Error("Discord Gateway proof identify mode is invalid");
  }
  const value = process.env.DISCORD_BOT_TOKEN || "";
  if (!/^openshell:resolve:env:v[1-9][0-9]*_DISCORD_BOT_TOKEN$/.test(value)) {
    throw new Error("Discord Gateway proof requires the revision-scoped DISCORD_BOT_TOKEN placeholder");
  }
  return value;
}
const identifyToken = resolveIdentifyToken();
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
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x81, 0x80 | body.length]);
  } else if (body.length < 65_536) {
    header = Buffer.from([0x81, 0x80 | 126, body.length >> 8, body.length & 0xff]);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([header, mask, masked]);
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
  return { opcode, payload: buffer.slice(offset, offset + payloadLength), totalLength: offset + payloadLength };
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
  socket.destroy();
  finish("TIMEOUT");
}, 20000);
let handshake = Buffer.alloc(0);
let framed = Buffer.alloc(0);
let upgraded = false;
let finished = false;

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
    const statusLine = handshake.slice(0, end).toString("latin1").split("\r\n")[0] ?? "";
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
    if (frame.opcode !== 1) continue;
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
      results.push(identifyToken.includes("openshell:resolve:env:") ? "IDENTIFY_SENT_PLACEHOLDER" : "IDENTIFY_SENT_NON_PLACEHOLDER");
    } else if (message.op === 0 && message.t === "READY") {
      results.push("READY");
      socket.write(encodeClientText(JSON.stringify({ op: 1, d: message.s ?? null })));
    } else if (message.op === 11) {
      results.push("HEARTBEAT_ACK");
      clearTimeout(timer);
      finished = true;
      socket.end();
      finish();
    }
  }
});
socket.on("error", (error) => {
  clearTimeout(timer);
  if (!finished) finish("ERROR " + error.message);
});
socket.on("close", () => {
  clearTimeout(timer);
  if (!finished) finish("CLOSED");
});
`;

export async function runDiscordGatewayClient(
  sandbox: SandboxClient,
  options: {
    readonly sandboxName?: string;
    readonly port: string;
    readonly identifyToken: DiscordGatewayIdentifyToken;
    readonly redactionValues: string[];
  },
): Promise<string> {
  const identifyEnv: Record<string, string> =
    options.identifyToken.kind === "explicit"
      ? {
          FAKE_DISCORD_IDENTIFY_MODE: "explicit",
          FAKE_DISCORD_IDENTIFY_TOKEN: options.identifyToken.value,
        }
      : { FAKE_DISCORD_IDENTIFY_MODE: "revisioned-discord-env" };
  const result = await runSandboxNode(sandbox, DISCORD_GATEWAY_CLIENT_SOURCE, {
    artifactName: "fake-discord-gateway-client",
    env: {
      FAKE_DISCORD_GATEWAY_PORT: options.port,
      ...identifyEnv,
    },
    redactionValues: options.redactionValues,
    sandboxName: options.sandboxName,
    timeoutMs: 60_000,
  });
  expectExitZero(result, "fake Discord Gateway client");
  return result.stdout.trim();
}
