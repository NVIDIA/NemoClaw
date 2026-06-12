// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import {
  type SandboxClient,
  sandboxAccessEnv,
  validateSandboxName,
} from "../fixtures/clients/sandbox.ts";
import { expect } from "../fixtures/e2e-test.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

export const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
export const CLI_ENTRYPOINT = path.join(REPO_ROOT, "bin", "nemoclaw.js");
export const BASE_POLICY = path.join(
  REPO_ROOT,
  "nemoclaw-blueprint",
  "policies",
  "openclaw-sandbox.yaml",
);
export const FAKE_LIB_DIR = path.join(REPO_ROOT, "test", "e2e", "lib");
export const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? `e2e-msg-provider-${process.pid}`;
export const INSTALL_TIMEOUT_MS = 45 * 60_000;
export const REBUILD_TIMEOUT_MS = 25 * 60_000;
export const PROBE_TIMEOUT_MS = 120_000;
export const LIVE_TIMEOUT_MS = 90 * 60_000;

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

export type FakeDockerApi = {
  kind: string;
  port: string;
  dir: string;
  captureFile: string;
  container: string;
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

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
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

export function isUnresolvedPlaceholderRejection(text: string): boolean {
  return /credential_injection_failed|unresolved credential placeholder/i.test(text);
}

export function isNvidiaEndpointRateLimitFailure(text: string): boolean {
  return (
    /\b429\b|too many requests|rate limit/i.test(text) &&
    /NVIDIA|endpoint|validation|models|inference/i.test(text)
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
  const wechat = nonEmpty(process.env.WECHAT_BOT_TOKEN) ?? "test-fake-wechat-token-e2e";
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
    NVIDIA_API_KEY: process.env.NVIDIA_API_KEY,
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

export async function bestEffort(run: () => Promise<unknown>): Promise<void> {
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
    timeoutMs?: number;
  },
): Promise<ShellProbeResult> {
  return host.command(command, args, {
    artifactName: options.artifactName,
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
  const encodedScript = base64(script);
  const wrapper = `printf '%s' ${shellQuote(encodedScript)} | base64 -d | sh`;
  return sandbox.exec(SANDBOX_NAME, ["sh", "-lc", wrapper], {
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
    timeoutMs?: number;
  },
): Promise<ShellProbeResult> {
  const envLines = Object.entries(options.env ?? {})
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join("\n");
  const scriptName = `/tmp/nemoclaw-${options.artifactName.replace(/[^a-zA-Z0-9_.-]/g, "-")}.mjs`;
  return runSandboxShell(
    sandbox,
    `
set -eu
${envLines}
printf '%s' ${shellQuote(base64(source))} | base64 -d > ${shellQuote(scriptName)}
node --preserve-symlinks ${shellQuote(scriptName)}
`,
    options,
  );
}

export function expectExitZero(result: ShellProbeResult, label: string): void {
  expect(result.exitCode, `${label}\n${outputText(result)}`).toBe(0);
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

  # Slack - pre-merged for messaging provider Vitest E2E (#2340)
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
        ? `token="$(printf '%s' ${shellQuote(tokenB64)} | base64 -d)"
if cat /proc/[0-9]*/cmdline 2>/dev/null | tr '\\0' '\\n' | grep -Fq "$token"; then echo FOUND; else echo ABSENT; fi`
        : `token="$(printf '%s' ${shellQuote(tokenB64)} | base64 -d)"
if grep -rIlm1 -F "$token" /sandbox /home /etc /tmp /var 2>/dev/null | head -1; then true; else echo ABSENT; fi`;
  return sandboxOutput(sandbox, probe, artifactName, redactionValues);
}

export async function startFakeDockerApi(
  host: HostCliClient,
  cleanup: (name: string, run: () => Promise<void>) => void,
  options: {
    kind: "slack" | "telegram" | "discord-gateway" | "discord-message";
    imageScript: string;
    containerPrefix: string;
    portEnv: string;
    portFileEnv: string;
    captureFileEnv: string;
    expectedEnv: Record<string, string>;
    redactionValues: string[];
    env: NodeJS.ProcessEnv;
  },
): Promise<FakeDockerApi> {
  fs.mkdirSync(path.join(REPO_ROOT, ".tmp"), { recursive: true });
  const dir = fs.mkdtempSync(path.join(REPO_ROOT, ".tmp", `fake-${options.kind}.`));
  const portFile = path.join(dir, "port");
  const captureFile = path.join(dir, "capture.jsonl");
  const container = uniqueContainerName(options.containerPrefix);
  fs.writeFileSync(captureFile, "");

  const dockerArgs = [
    "run",
    "-d",
    "--rm",
    "--name",
    container,
    "-p",
    "0:8080",
    "-e",
    `${options.portEnv}=8080`,
    "-e",
    `${options.portFileEnv}=/tmp/fake/port`,
    "-e",
    `${options.captureFileEnv}=/tmp/fake/capture.jsonl`,
  ];
  for (const [key, value] of Object.entries(options.expectedEnv)) {
    dockerArgs.push("-e", `${key}=${value}`);
  }
  dockerArgs.push(
    "-v",
    `${dir}:/tmp/fake`,
    "-v",
    `${FAKE_LIB_DIR}:/opt/nemoclaw-e2e:ro`,
    "node:22-bookworm-slim",
    "node",
    `/opt/nemoclaw-e2e/${options.imageScript}`,
  );

  cleanup(`remove ${container}`, async () => {
    await bestEffort(() =>
      runHost(host, "docker", ["rm", "-f", container], {
        artifactName: `cleanup-${container}`,
        env: options.env,
        redactionValues: options.redactionValues,
        timeoutMs: 60_000,
      }),
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const start = await runHost(host, "docker", dockerArgs, {
    artifactName: `start-fake-${options.kind}-api`,
    env: options.env,
    redactionValues: options.redactionValues,
    timeoutMs: 120_000,
  });
  expectExitZero(start, `start fake ${options.kind} API`);

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fs.existsSync(portFile) && fs.statSync(portFile).size > 0) {
      const port = await runHost(host, "docker", ["port", container, "8080/tcp"], {
        artifactName: `port-fake-${options.kind}-api`,
        env: options.env,
        redactionValues: options.redactionValues,
        timeoutMs: 30_000,
      });
      const published = port.stdout.trim().split(":").at(-1)?.trim();
      if (published) {
        return { kind: options.kind, port: published, dir, captureFile, container };
      }
    }
    await sleep(100);
  }

  throw new Error(`fake ${options.kind} API did not publish a port`);
}

export async function applyRestRewritePolicy(
  host: HostCliClient,
  api: FakeDockerApi,
  env: NodeJS.ProcessEnv,
  redactionValues: string[],
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
}

export async function applyWebSocketRewritePolicy(
  host: HostCliClient,
  api: FakeDockerApi,
  env: NodeJS.ProcessEnv,
  redactionValues: string[],
): Promise<void> {
  const result = await runHost(
    host,
    "openshell",
    [
      "policy",
      "update",
      SANDBOX_NAME,
      "--add-endpoint",
      `host.openshell.internal:${api.port}:read-write:websocket:enforce:websocket-credential-rewrite,allowed-ip=10.0.0.0/8,allowed-ip=172.16.0.0/12,allowed-ip=192.168.0.0/16`,
      "--add-allow",
      `host.openshell.internal:${api.port}:GET:/**`,
      "--add-allow",
      `host.openshell.internal:${api.port}:WEBSOCKET_TEXT:/**`,
      "--binary",
      "/usr/local/bin/node",
      "--binary",
      "/usr/bin/node",
      "--wait",
    ],
    {
      artifactName: `apply-${api.kind}-websocket-policy`,
      env,
      redactionValues,
      timeoutMs: 120_000,
    },
  );
  expectExitZero(result, `apply ${api.kind} fake WebSocket policy`);
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

export async function runDiscordGatewayClient(
  sandbox: SandboxClient,
  port: string,
  identifyToken: string,
  redactionValues: string[],
): Promise<string> {
  const result = await runSandboxNode(
    sandbox,
    `
import crypto from "node:crypto";
import net from "node:net";

const host = "host.openshell.internal";
const port = Number(process.env.FAKE_DISCORD_GATEWAY_PORT);
const identifyToken = process.env.FAKE_DISCORD_IDENTIFY_TOKEN ?? "";
const results = [];

function finish(message) {
  if (message) results.push(message);
  console.log(results.join("\\n"));
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
  }
  if (buffer.length < offset + payloadLength) return null;
  return { opcode, payload: buffer.slice(offset, offset + payloadLength), totalLength: offset + payloadLength };
}

const socket = net.createConnection({ host, port });
const timer = setTimeout(() => {
  socket.destroy();
  finish("TIMEOUT");
}, 20000);
let handshake = Buffer.alloc(0);
let framed = Buffer.alloc(0);
let upgraded = false;

socket.on("connect", () => {
  const key = crypto.randomBytes(16).toString("base64");
  socket.write([
    "GET /gateway?v=10&encoding=json HTTP/1.1",
    \`Host: \${host}:\${port}\`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    \`Sec-WebSocket-Key: \${key}\`,
    "Sec-WebSocket-Version: 13",
    "\\r\\n",
  ].join("\\r\\n"));
});

socket.on("data", (chunk) => {
  if (!upgraded) {
    handshake = Buffer.concat([handshake, chunk]);
    const end = handshake.indexOf("\\r\\n\\r\\n");
    if (end === -1) return;
    const statusLine = handshake.slice(0, end).toString("latin1").split("\\r\\n")[0] ?? "";
    if (!statusLine.includes("101")) {
      clearTimeout(timer);
      finish(\`HTTP_\${statusLine}\`);
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
      socket.end();
      finish();
    }
  }
});
socket.on("error", (error) => {
  clearTimeout(timer);
  finish(\`ERROR \${error.message}\`);
});
`,
    {
      artifactName: "fake-discord-gateway-client",
      env: {
        FAKE_DISCORD_GATEWAY_PORT: port,
        FAKE_DISCORD_IDENTIFY_TOKEN: identifyToken,
      },
      redactionValues,
      timeoutMs: 60_000,
    },
  );
  expectExitZero(result, "fake Discord Gateway client");
  return result.stdout.trim();
}
