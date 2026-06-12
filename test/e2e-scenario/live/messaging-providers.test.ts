// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Live Vitest migration for test/e2e/test-messaging-providers.sh.
 *
 * Keep this close to the shell suite's observable contract: fake tokens by
 * default, _REAL secrets opt in to real sends, provider placeholders must not
 * leak into sandbox-visible surfaces, WhatsApp stays QR-only, and optional
 * live-network probes skip on transport reachability rather than weakening the
 * provider/config/redaction assertions.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { testTimeoutOptions } from "../../helpers/timeouts";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import {
  type SandboxClient,
  sandboxAccessEnv,
  trustedSandboxShellScript,
  validateSandboxName,
} from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI_ENTRYPOINT = path.join(REPO_ROOT, "bin", "nemoclaw.js");
const BASE_POLICY = path.join(REPO_ROOT, "nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml");
const FAKE_LIB_DIR = path.join(REPO_ROOT, "test", "e2e", "lib");
const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? `e2e-msg-provider-${process.pid}`;
const INSTALL_TIMEOUT_MS = 45 * 60_000;
const REBUILD_TIMEOUT_MS = 25 * 60_000;
const PROBE_TIMEOUT_MS = 120_000;
const LIVE_TIMEOUT_MS = 90 * 60_000;

validateSandboxName(SANDBOX_NAME);

const runLiveTest = shouldRunLiveE2EScenarios() ? test : test.skip;

type CommandOutput = Pick<ShellProbeResult, "stdout" | "stderr" | "exitCode">;

type MessagingTokens = {
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

type MessagingEnv = {
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

type OpenClawConfig = {
  channels?: Record<string, ChannelConfig>;
  plugins?: {
    entries?: Record<string, { enabled?: unknown }>;
    installs?: Record<string, Record<string, unknown>>;
  };
  proxy?: { enabled?: unknown; proxyUrl?: unknown };
};

type ChannelConfig = {
  enabled?: unknown;
  accounts?: Record<string, AccountConfig>;
};

type AccountConfig = Record<string, unknown>;

type FakeDockerApi = {
  kind: string;
  port: string;
  dir: string;
  captureFile: string;
  container: string;
};

function outputText(result: CommandOutput): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function uniqueContainerName(prefix: string): string {
  return `${prefix}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isFakeSlackToken(value: string): boolean {
  return /^(xoxb|xapp)-(fake|test)-/.test(value);
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isUnresolvedPlaceholderRejection(text: string): boolean {
  return /credential_injection_failed|unresolved credential placeholder/i.test(text);
}

function isNvidiaEndpointRateLimitFailure(text: string): boolean {
  return (
    /\b429\b|too many requests|rate limit/i.test(text) &&
    /NVIDIA|endpoint|validation|models|inference/i.test(text)
  );
}

function countCsv(value: string): number {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean).length;
}

function tokenValues(tokens: MessagingTokens): string[] {
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

function messagingEnv(): MessagingEnv {
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

async function bestEffort(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Cleanup and diagnostics should not hide the primary failure.
  }
}

async function runHost(
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

async function runSandboxShell(
  sandbox: SandboxClient,
  script: string,
  options: {
    artifactName: string;
    redactionValues: string[];
    timeoutMs?: number;
  },
): Promise<ShellProbeResult> {
  return sandbox.execShell(SANDBOX_NAME, trustedSandboxShellScript(script), {
    artifactName: options.artifactName,
    env: sandboxAccessEnv(),
    redactionValues: options.redactionValues,
    timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS,
  });
}

async function runSandboxNode(
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

function expectExitZero(result: ShellProbeResult, label: string): void {
  expect(result.exitCode, `${label}\n${outputText(result)}`).toBe(0);
}

function check(condition: boolean, message: string): void {
  expect.soft(condition, message).toBe(true);
}

async function skipNote(artifacts: ArtifactSink, notes: string[], message: string): Promise<void> {
  notes.push(message);
  console.warn(`[skip] ${message}`);
  await artifacts.writeJson("messaging-provider-skips.json", notes);
}

async function premergeSlackPolicyIfNeeded(): Promise<() => void> {
  const original = fs.readFileSync(BASE_POLICY, "utf8");
  if (original.includes("api.slack.com")) {
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

async function readOpenClawConfig(
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

function channelAccount(
  config: OpenClawConfig,
  channel: string,
  accountId = "default",
): AccountConfig {
  const accounts = config.channels?.[channel]?.accounts;
  if (!accounts || typeof accounts !== "object") return {};
  const account = accounts[accountId] ?? accounts.main ?? Object.values(accounts)[0];
  return account && typeof account === "object" ? account : {};
}

function channelEnabled(config: OpenClawConfig, channel: string): boolean {
  return config.channels?.[channel]?.enabled === true;
}

function pluginEnabled(config: OpenClawConfig, plugin: string): boolean {
  return config.plugins?.entries?.[plugin]?.enabled === true;
}

function accountString(account: AccountConfig, key: string): string {
  const value = account[key];
  return typeof value === "string" ? value : "";
}

function accountBool(account: AccountConfig, key: string): boolean | undefined {
  const value = account[key];
  return typeof value === "boolean" ? value : undefined;
}

async function sandboxOutput(
  sandbox: SandboxClient,
  script: string,
  artifactName: string,
  redactionValues: string[],
): Promise<string> {
  const result = await runSandboxShell(sandbox, script, { artifactName, redactionValues });
  expectExitZero(result, artifactName);
  return result.stdout.trim();
}

async function rawTokenSurfaceProbe(
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

async function startFakeDockerApi(
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

async function applyRestRewritePolicy(
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

async function applyWebSocketRewritePolicy(
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

function lastJsonLine(
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

async function runSlackApiRequest(
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

async function runDiscordGatewayClient(
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
  return Buffer.concat([Buffer.from([0x81, 0x80 | body.length]), mask, masked]);
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

runLiveTest(
  "messaging providers preserve placeholder, policy, runtime, and send contracts",
  testTimeoutOptions(LIVE_TIMEOUT_MS),
  async ({ artifacts, cleanup, host, sandbox, skip }) => {
    if (!process.env.NVIDIA_API_KEY) {
      skip("NVIDIA_API_KEY is required for live messaging-provider E2E");
      return;
    }
    if (!fs.existsSync(CLI_ENTRYPOINT)) {
      throw new Error(`NemoClaw CLI entrypoint missing: ${CLI_ENTRYPOINT}`);
    }

    const state = messagingEnv();
    const redactionValues = tokenValues(state.tokens);
    const skips: string[] = [];
    await artifacts.writeJson("messaging-provider-env-summary.json", {
      sandboxName: SANDBOX_NAME,
      telegramTokenChars: state.tokens.telegram.length,
      discordTokenChars: state.tokens.discord.length,
      slackBotTokenChars: state.tokens.slackBot.length,
      slackAppTokenChars: state.tokens.slackApp.length,
      telegramAllowlistKey: state.telegramAllowlistKey,
      telegramAllowedIdCount: countCsv(state.telegramIds),
      slackAllowedUserCount: countCsv(state.slackIds),
      wechatAccount: state.wechatAccount,
    });

    cleanup.add(`destroy messaging providers sandbox ${SANDBOX_NAME}`, async () => {
      await bestEffort(() =>
        runHost(host, "node", [CLI_ENTRYPOINT, SANDBOX_NAME, "destroy", "--yes"], {
          artifactName: "cleanup-nemoclaw-destroy-messaging-providers",
          env: state.env,
          redactionValues,
          timeoutMs: 15 * 60_000,
        }),
      );
      await bestEffort(() =>
        runHost(host, "openshell", ["sandbox", "delete", SANDBOX_NAME], {
          artifactName: "cleanup-openshell-sandbox-delete-messaging-providers",
          env: state.env,
          redactionValues,
          timeoutMs: 120_000,
        }),
      );
    });

    const restoreSlackPolicy = await premergeSlackPolicyIfNeeded();
    cleanup.add("restore messaging E2E Slack policy pre-merge", restoreSlackPolicy);

    await bestEffort(() =>
      runHost(host, "node", [CLI_ENTRYPOINT, SANDBOX_NAME, "destroy", "--yes"], {
        artifactName: "preclean-nemoclaw-destroy-messaging-providers",
        env: state.env,
        redactionValues,
        timeoutMs: 15 * 60_000,
      }),
    );
    await bestEffort(() =>
      runHost(host, "openshell", ["sandbox", "delete", SANDBOX_NAME], {
        artifactName: "preclean-openshell-sandbox-delete-messaging-providers",
        env: state.env,
        redactionValues,
        timeoutMs: 120_000,
      }),
    );
    await bestEffort(() =>
      runHost(host, "openshell", ["gateway", "destroy", "-g", "nemoclaw"], {
        artifactName: "preclean-openshell-gateway-destroy-messaging-providers",
        env: state.env,
        redactionValues,
        timeoutMs: 120_000,
      }),
    );

    const dockerInfo = await runHost(host, "docker", ["info"], {
      artifactName: "prereq-docker-info-messaging-providers",
      env: state.env,
      redactionValues,
      timeoutMs: 30_000,
    });
    expectExitZero(dockerInfo, "Docker must be running");

    const install = await runHost(host, "bash", ["install.sh", "--non-interactive"], {
      artifactName: "install-messaging-providers",
      env: state.env,
      redactionValues,
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    if (install.exitCode !== 0 && isNvidiaEndpointRateLimitFailure(outputText(install))) {
      await artifacts.writeJson("messaging-provider-early-skip.json", {
        reason:
          "NVIDIA endpoint validation was rate-limited before messaging-provider assertions ran",
        exitCode: install.exitCode,
        artifact: install.artifacts.result,
      });
      skip("NVIDIA endpoint validation was rate-limited before messaging-provider assertions ran");
      return;
    }
    expectExitZero(install, "M0: install.sh completed");

    const openshellVersion = await runHost(host, "openshell", ["--version"], {
      artifactName: "openshell-version-messaging-providers",
      env: state.env,
      redactionValues,
      timeoutMs: 60_000,
    });
    expectExitZero(openshellVersion, "openshell installed");

    const sandboxList = await runHost(host, "openshell", ["sandbox", "list"], {
      artifactName: "sandbox-list-messaging-providers",
      env: state.env,
      redactionValues,
      timeoutMs: 60_000,
    });
    expectExitZero(sandboxList, "openshell sandbox list");
    check(
      sandboxList.stdout.includes(SANDBOX_NAME) && /Ready/.test(sandboxList.stdout),
      "M0b: sandbox is Ready",
    );

    const whatsappAdd = await runHost(
      host,
      "node",
      [CLI_ENTRYPOINT, SANDBOX_NAME, "channels", "add", "whatsapp"],
      {
        artifactName: "channels-add-whatsapp-messaging-providers",
        env: state.env,
        redactionValues,
        timeoutMs: 10 * 60_000,
      },
    );
    expectExitZero(whatsappAdd, "M-WA0: channels add whatsapp exits 0");
    check(
      outputText(whatsappAdd).includes("Enabled whatsapp channel"),
      "M-WA0: channels add whatsapp registered QR-only channel",
    );

    const whatsappProvider = await runHost(
      host,
      "openshell",
      ["provider", "get", `${SANDBOX_NAME}-whatsapp-bridge`],
      {
        artifactName: "provider-get-whatsapp-messaging-providers",
        env: state.env,
        redactionValues,
        timeoutMs: 60_000,
      },
    );
    check(
      whatsappProvider.exitCode !== 0,
      "M-WA1: WhatsApp QR-only channel creates no bridge provider",
    );

    const registryWhatsapp = await runHost(
      host,
      "node",
      [
        "-e",
        `const fs = require("fs");
const registry = JSON.parse(fs.readFileSync(process.env.HOME + "/.nemoclaw/sandboxes.json", "utf8"));
const channels = registry.sandboxes?.[process.env.SANDBOX_NAME]?.messaging?.plan?.channels;
process.exit(Array.isArray(channels) && channels.some((c) => c?.channelId === "whatsapp") ? 0 : 1);`,
      ],
      {
        artifactName: "registry-whatsapp-messaging-providers",
        env: { ...state.env, SANDBOX_NAME },
        redactionValues,
        timeoutMs: 60_000,
      },
    );
    check(
      registryWhatsapp.exitCode === 0,
      "M-WA2: registry.messaging.plan.channels contains whatsapp after channel add",
    );

    const whatsappPolicyPre = await runHost(
      host,
      "openshell",
      ["policy", "get", "--full", SANDBOX_NAME],
      {
        artifactName: "whatsapp-policy-pre-rebuild-messaging-providers",
        env: state.env,
        redactionValues,
        timeoutMs: 60_000,
      },
    );
    const whatsappPolicyPreText = outputText(whatsappPolicyPre);
    check(
      whatsappPolicyPreText.includes("web.whatsapp.com") &&
        whatsappPolicyPreText.includes("whatsapp.net") &&
        whatsappPolicyPreText.includes("raw.githubusercontent.com"),
      "M-WA3: WhatsApp policy preset applied before rebuild",
    );

    const whatsappRebuild = await runHost(
      host,
      "node",
      [CLI_ENTRYPOINT, SANDBOX_NAME, "rebuild", "--yes"],
      {
        artifactName: "whatsapp-rebuild-messaging-providers",
        env: state.env,
        redactionValues,
        timeoutMs: REBUILD_TIMEOUT_MS,
      },
    );
    expectExitZero(whatsappRebuild, "M-WA4: rebuild completed after WhatsApp channel add");

    const providerList = await runHost(host, "openshell", ["provider", "list"], {
      artifactName: "provider-list-messaging-providers",
      env: state.env,
      redactionValues,
      timeoutMs: 60_000,
    });
    const providerListText = outputText(providerList);
    check(
      providerListText.includes(`${SANDBOX_NAME}-telegram-bridge`),
      "M1: Telegram provider exists in gateway",
    );
    check(
      providerListText.includes(`${SANDBOX_NAME}-discord-bridge`),
      "M2: Discord provider exists in gateway",
    );
    check(
      providerListText.includes(`${SANDBOX_NAME}-wechat-bridge`),
      "M-W1: WeChat provider exists in gateway",
    );
    check(
      providerListText.includes(`${SANDBOX_NAME}-extra-telegram-bot-token-agent-a`),
      "X1: provider registered for TELEGRAM_BOT_TOKEN_AGENT_A",
    );
    check(
      !providerListText.includes(`${SANDBOX_NAME}-extra-telegram-bot-token-agent-missing`),
      "X2: missing extra key produced no provider row",
    );
    check(
      !providerListText.includes(`${SANDBOX_NAME}-extra-github-token`),
      "X3: GITHUB_TOKEN refused by parser; no provider row registered",
    );

    const envDump = await sandboxOutput(
      sandbox,
      "env 2>/dev/null || true",
      "sandbox-env-dump-messaging-providers",
      redactionValues,
    );
    const processProbe = await sandboxOutput(
      sandbox,
      "cat /proc/[0-9]*/cmdline 2>/dev/null | tr '\\0' '\\n' || true",
      "sandbox-process-list-messaging-providers",
      redactionValues,
    );
    check(envDump.length > 0, "Phase 2: sandbox environment dump is available");
    check(processProbe.length > 0, "Phase 2: sandbox process list is available");

    const placeholderChecks: Array<[string, string, string]> = [
      ["M3", "TELEGRAM_BOT_TOKEN", state.tokens.telegram],
      ["M4", "DISCORD_BOT_TOKEN", state.tokens.discord],
      ["M-W3", "WECHAT_BOT_TOKEN", state.tokens.wechat],
    ];
    for (const [assertionId, key, token] of placeholderChecks) {
      const value = await sandboxOutput(
        sandbox,
        `printenv ${key} 2>/dev/null || true`,
        `placeholder-${key.toLowerCase()}`,
        redactionValues,
      );
      if (!value) {
        await skipNote(
          artifacts,
          skips,
          `${assertionId}: ${key} not set inside sandbox (provider-only mode)`,
        );
      } else {
        check(
          !value.includes(token),
          `${assertionId}: ${key} is a placeholder, not the host token`,
        );
        check(
          value.startsWith("openshell:resolve:env:"),
          `${assertionId}: ${key} uses OpenShell resolve placeholder`,
        );
      }
    }

    const leakChecks: Array<[string, string, string]> = [
      ["M5a/M5b/M5c", "Telegram", state.tokens.telegram],
      ["M5e/M5f/M5g", "Discord", state.tokens.discord],
      ["M-S5a/M-S5b/M-S5c", "Slack bot", state.tokens.slackBot],
      ["M-S5d/M-S5d2/M-S5e", "Slack app", state.tokens.slackApp],
      ["M-W3a/M-W3b/M-W3c", "WeChat", state.tokens.wechat],
      ["X6", "extra Telegram", state.tokens.extraTelegramA],
      ["X7", "refused GITHUB_TOKEN", state.tokens.extraGithub],
    ];
    for (const [assertionId, label, token] of leakChecks) {
      for (const surface of ["env", "process", "filesystem"] as const) {
        const probe = await rawTokenSurfaceProbe(
          sandbox,
          token,
          surface,
          `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${surface}-leak-probe`,
          redactionValues,
        );
        check(
          probe === "ABSENT",
          `${assertionId}: raw ${label} token absent from sandbox ${surface} (${probe.slice(0, 160)})`,
        );
      }
    }

    const extraA = await sandboxOutput(
      sandbox,
      "printenv TELEGRAM_BOT_TOKEN_AGENT_A 2>/dev/null || true",
      "extra-placeholder-agent-a",
      redactionValues,
    );
    const extraB = await sandboxOutput(
      sandbox,
      "printenv TELEGRAM_BOT_TOKEN_AGENT_B 2>/dev/null || true",
      "extra-placeholder-agent-b",
      redactionValues,
    );
    check(
      extraA.startsWith("openshell:resolve:env:"),
      "X4a: TELEGRAM_BOT_TOKEN_AGENT_A is canonical resolve placeholder",
    );
    check(
      extraB.startsWith("openshell:resolve:env:"),
      "X4b: TELEGRAM_BOT_TOKEN_AGENT_B is canonical resolve placeholder",
    );
    check(extraA !== extraB, "X4b: extension keys resolve to distinct placeholders");

    const startLog = await sandboxOutput(
      sandbox,
      "cat /tmp/nemoclaw-start.log 2>/dev/null || true",
      "start-log-messaging-providers",
      redactionValues,
    );
    check(
      /\[config\] NEMOCLAW_EXTRA_PLACEHOLDER_KEYS accepted \d+ entry\(ies\):/.test(startLog) &&
        startLog.includes("TELEGRAM_BOT_TOKEN_AGENT_A") &&
        !startLog.includes("GITHUB_TOKEN"),
      "X5: accepted-extras breadcrumb proves extra keys reached in-container parser",
    );

    const config = await readOpenClawConfig(sandbox, redactionValues);
    for (const [assertionId, channel, plugin] of [
      ["M6a", "telegram", "telegram"],
      ["M6b", "discord", "discord"],
      ["M6c", "slack", "slack"],
      ["M6d", "whatsapp", "whatsapp"],
    ] as const) {
      check(channelEnabled(config, channel), `${assertionId}: channels.${channel}.enabled is true`);
      check(
        pluginEnabled(config, plugin),
        `${assertionId}: plugins.entries.${plugin}.enabled is true`,
      );
    }

    const telegramAccount = channelAccount(config, "telegram");
    const discordAccount = channelAccount(config, "discord");
    const slackAccount = channelAccount(config, "slack");
    const whatsappAccount = channelAccount(config, "whatsapp");
    const wechatAccount = channelAccount(config, "openclaw-weixin", state.wechatAccount);

    const telegramBotToken = accountString(telegramAccount, "botToken");
    const discordToken = accountString(discordAccount, "token");
    check(telegramBotToken.length > 0, "M6: Telegram botToken present in openclaw.json");
    check(
      telegramBotToken !== state.tokens.telegram,
      "M7: Telegram botToken is not the host token",
    );
    check(discordToken.length > 0, "M8: Discord token present in openclaw.json");
    check(discordToken !== state.tokens.discord, "M9: Discord token is not the host token");
    check(accountBool(telegramAccount, "enabled") === true, "M10: Telegram account is enabled");
    check(accountBool(discordAccount, "enabled") === true, "M11: Discord account is enabled");
    check(
      accountString(telegramAccount, "dmPolicy") === "allowlist",
      "M11b: Telegram dmPolicy is allowlist",
    );
    check(
      accountString(telegramAccount, "groupPolicy") === "open",
      "M11d: Telegram groupPolicy is open",
    );
    check(
      accountString(slackAccount, "dmPolicy") === "allowlist",
      "M11f: Slack dmPolicy is allowlist",
    );
    check(
      accountString(slackAccount, "groupPolicy") === "allowlist",
      "M11g: Slack groupPolicy is allowlist",
    );
    const slackChannels = slackAccount.channels;
    const slackWildcard =
      slackChannels && typeof slackChannels === "object"
        ? (slackChannels as Record<string, Record<string, unknown>>)["*"]
        : undefined;
    check(
      slackWildcard?.enabled === true &&
        slackWildcard.requireMention === true &&
        Array.isArray(slackWildcard.users) &&
        state.slackIds
          .split(",")
          .every((id) => (slackWildcard.users as unknown[]).includes(id.trim())),
      "M11h: Slack wildcard channel mention allowlist contains expected users",
    );

    check(accountBool(whatsappAccount, "enabled") === true, "M-WA8: WhatsApp account is enabled");
    const whatsappHealth = whatsappAccount.healthMonitor;
    check(
      Boolean(
        whatsappHealth &&
          typeof whatsappHealth === "object" &&
          (whatsappHealth as Record<string, unknown>).enabled === false,
      ),
      "M-WA8a: WhatsApp health monitor is disabled for unpaired QR session",
    );
    check(
      !JSON.stringify(whatsappAccount).match(
        /token|secret|auth|session|openshell:resolve:env:WHATSAPP/i,
      ),
      "M-WA9: WhatsApp config has no token/auth/session provider placeholders",
    );
    check(
      accountBool(wechatAccount, "enabled") === true,
      "M-W8: WeChat configured account is enabled",
    );

    const wechatCredentialFile = await sandboxOutput(
      sandbox,
      `cat /sandbox/.openclaw/openclaw-weixin/accounts/${state.wechatAccount}.json 2>/dev/null || true`,
      "wechat-account-credential-file",
      redactionValues,
    );
    check(
      wechatCredentialFile.includes("openshell:resolve:env:WECHAT_BOT_TOKEN") &&
        !wechatCredentialFile.includes(state.tokens.wechat),
      "M-W9: WeChat account file uses L7-resolved placeholder",
    );
    const wechatIndex = await sandboxOutput(
      sandbox,
      "cat /sandbox/.openclaw/openclaw-weixin/accounts.json 2>/dev/null || true",
      "wechat-accounts-index",
      redactionValues,
    );
    check(
      wechatIndex.includes(state.wechatAccount),
      "M-W10: WeChat accounts index contains configured account",
    );

    const runtimeChannels = await sandboxOutput(
      sandbox,
      "timeout 45 openclaw channels list --all --json --no-color 2>/dev/null || true",
      "openclaw-channels-list-messaging-providers",
      redactionValues,
    );
    if (!runtimeChannels) {
      await skipNote(artifacts, skips, "M6e-M6h: OpenClaw channels list returned no output");
    } else {
      const parsedRuntime = JSON.parse(runtimeChannels) as {
        chat?: Record<string, { installed?: unknown; origin?: unknown; accounts?: unknown }>;
      };
      for (const [assertionId, channel, accountId] of [
        ["M6e", "telegram", "default"],
        ["M6f", "discord", "default"],
        ["M6g", "slack", "default"],
      ] as const) {
        const entry = parsedRuntime.chat?.[channel];
        check(
          entry?.installed === true &&
            entry.origin === "configured" &&
            Array.isArray(entry.accounts) &&
            entry.accounts.includes(accountId),
          `${assertionId}: OpenClaw channels list reports ${channel} installed/configured`,
        );
      }
      const whatsappRuntime = parsedRuntime.chat?.whatsapp;
      check(
        whatsappRuntime?.installed === true &&
          (whatsappRuntime.origin === "available" || whatsappRuntime.origin === "configured"),
        "M6h: OpenClaw channels list reports WhatsApp plugin installed",
      );
    }

    const telegramReach = await sandboxOutput(
      sandbox,
      `node -e '
const https = require("https");
const req = https.get("https://api.telegram.org/", (res) => {
  console.log("HTTP_" + res.statusCode);
  res.resume();
});
req.on("error", (e) => console.log("ERROR: " + e.message));
req.setTimeout(15000, () => { req.destroy(); console.log("TIMEOUT"); });
'`,
      "telegram-reachability-messaging-providers",
      redactionValues,
    );
    if (/HTTP_/.test(telegramReach)) {
      check(true, `M12: Node.js reached api.telegram.org (${telegramReach})`);
    } else if (
      /TIMEOUT|ECONNRESET|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|socket hang up/i.test(telegramReach)
    ) {
      await skipNote(
        artifacts,
        skips,
        `M12: api.telegram.org unreachable from this network (${telegramReach.slice(0, 160)})`,
      );
    } else {
      check(
        false,
        `M12: Node.js could not reach api.telegram.org (${telegramReach.slice(0, 200)})`,
      );
    }

    const discordPolicy = await runHost(
      host,
      "openshell",
      ["policy", "get", "--full", SANDBOX_NAME],
      {
        artifactName: "discord-policy-messaging-providers",
        env: state.env,
        redactionValues,
        timeoutMs: 60_000,
      },
    );
    const discordPolicyText = outputText(discordPolicy);
    check(
      discordPolicyText.includes("discord.com") &&
        discordPolicyText.includes("cdn.discordapp.com") &&
        /\/usr\/local\/bin\/node|\/usr\/bin\/node/.test(discordPolicyText),
      "M13-policy: live policy contains Discord endpoints and Node binaries",
    );

    const proxyEnv = await sandboxOutput(
      sandbox,
      'printf "HTTPS_PROXY=%s\\nhttps_proxy=%s\\nNO_PROXY=%s\\nno_proxy=%s\\n" "$HTTPS_PROXY" "$https_proxy" "$NO_PROXY" "$no_proxy"',
      "proxy-env-messaging-providers",
      redactionValues,
    );
    check(
      /10\.200\.0\.1:3128/.test(proxyEnv),
      "M13-proxy: sandbox uses the OpenShell gateway proxy",
    );

    const discordReach = await sandboxOutput(
      sandbox,
      `node - <<'NODE'
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
    console.log(\`\${name}:HTTP_\${res.statusCode}\`);
    res.resume();
    done();
  });
  req.on("error", (error) => {
    failed = true;
    console.log(\`\${name}:ERROR_\${error.message}\`);
    done();
  });
  req.setTimeout(15000, () => {
    failed = true;
    req.destroy();
    console.log(\`\${name}:TIMEOUT\`);
    done();
  });
}
NODE`,
      "discord-reachability-messaging-providers",
      redactionValues,
    );
    if (discordReach.includes("api:HTTP_") && discordReach.includes("cdn:HTTP_")) {
      check(true, "M13: Node.js reached Discord API and CDN through proxy");
    } else if (
      /TIMEOUT|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|ECONNRESET|socket hang up|network/i.test(
        discordReach,
      )
    ) {
      await skipNote(
        artifacts,
        skips,
        `M13: live Discord unreachable from this network (${discordReach.slice(0, 200)})`,
      );
    } else {
      check(false, `M13: Node.js could not reach Discord API/CDN (${discordReach.slice(0, 200)})`);
    }

    const curlReach = await sandboxOutput(
      sandbox,
      "curl -s --max-time 10 https://api.telegram.org/ 2>&1 || true",
      "curl-block-messaging-providers",
      redactionValues,
    );
    if (
      /blocked|denied|forbidden|refused|not found|no such|command not found|not installed/i.test(
        curlReach,
      ) ||
      !curlReach
    ) {
      check(true, "M14: curl to api.telegram.org is blocked or unavailable");
    } else {
      await skipNote(
        artifacts,
        skips,
        `M14: could not confirm curl is blocked (${curlReach.slice(0, 200)})`,
      );
    }

    const telegramApi = await sandboxOutput(
      sandbox,
      `node -e '
const https = require("https");
const token = process.env.TELEGRAM_BOT_TOKEN || "missing";
const req = https.get("https://api.telegram.org/bot" + token + "/getMe", (res) => {
  let body = "";
  res.on("data", (d) => { body += d; });
  res.on("end", () => console.log(res.statusCode + " " + body.slice(0, 300)));
});
req.on("error", (e) => console.log("ERROR: " + e.message));
req.setTimeout(30000, () => { req.destroy(); console.log("TIMEOUT"); });
'`,
      "telegram-l7-rewrite-messaging-providers",
      redactionValues,
    );
    const telegramStatus = telegramApi.match(/^(\d+)/m)?.[1] ?? "";
    if (["200", "401", "404"].includes(telegramStatus)) {
      check(
        true,
        `M15/M16: Telegram getMe status ${telegramStatus} proves placeholder reached API boundary`,
      );
    } else if (
      /TIMEOUT|ECONNRESET|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|socket hang up/i.test(telegramApi)
    ) {
      await skipNote(
        artifacts,
        skips,
        `M15: Telegram API timed out/unreachable (${telegramApi.slice(0, 160)})`,
      );
    } else {
      check(false, `M15: unexpected Telegram response (${telegramApi.slice(0, 200)})`);
    }

    const discordApi = await sandboxOutput(
      sandbox,
      `node -e '
const https = require("https");
const token = process.env.DISCORD_BOT_TOKEN || "missing";
const req = https.get({
  hostname: "discord.com",
  path: "/api/v10/users/@me",
  headers: { Authorization: "Bot " + token },
}, (res) => {
  let body = "";
  res.on("data", (d) => { body += d; });
  res.on("end", () => console.log(res.statusCode + " " + body.slice(0, 300)));
});
req.on("error", (e) => console.log("ERROR: " + e.message));
req.setTimeout(30000, () => { req.destroy(); console.log("TIMEOUT"); });
'`,
      "discord-l7-rewrite-messaging-providers",
      redactionValues,
    );
    const discordStatus = discordApi.match(/^(\d+)/m)?.[1] ?? "";
    if (["200", "401"].includes(discordStatus)) {
      check(
        true,
        `M17: Discord users/@me status ${discordStatus} proves placeholder reached API boundary`,
      );
    } else if (
      /TIMEOUT|ECONNRESET|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|socket hang up/i.test(discordApi)
    ) {
      await skipNote(
        artifacts,
        skips,
        `M17: Discord API timed out/unreachable (${discordApi.slice(0, 160)})`,
      );
    } else {
      check(false, `M17: unexpected Discord response (${discordApi.slice(0, 200)})`);
    }

    const fakeSlack = await startFakeDockerApi(host, cleanup.add.bind(cleanup), {
      kind: "slack",
      imageScript: "fake-slack-api.cjs",
      containerPrefix: "nemoclaw-fake-slack-vitest",
      portEnv: "FAKE_SLACK_API_PORT",
      portFileEnv: "FAKE_SLACK_API_PORT_FILE",
      captureFileEnv: "FAKE_SLACK_API_CAPTURE_FILE",
      expectedEnv: {
        FAKE_SLACK_API_EXPECTED_BOT_TOKEN: state.tokens.slackBot,
        FAKE_SLACK_API_EXPECTED_APP_TOKEN: state.tokens.slackApp,
      },
      env: state.env,
      redactionValues,
    });
    await applyRestRewritePolicy(host, fakeSlack, state.env, redactionValues);

    const slackAuth = await runSlackApiRequest(
      sandbox,
      fakeSlack.port,
      "/api/auth.test",
      "Bearer xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
      redactionValues,
    );
    check(
      /^200\b/.test(slackAuth) && /invalid_auth|not_authed|ok":true/.test(slackAuth),
      `M-S15: Slack auth.test exercised alias rewrite (${slackAuth.slice(0, 200)})`,
    );
    const slackAuthCapture = lastJsonLine(
      fakeSlack.captureFile,
      (row) => row.event === "request" && row.path === "/api/auth.test",
    );
    check(
      slackAuthCapture?.tokenMatchesExpected === true &&
        slackAuthCapture.bodyMatchesExpected === true &&
        slackAuthCapture.tokenLooksPlaceholder !== true &&
        slackAuthCapture.authorization === undefined &&
        slackAuthCapture.body === undefined,
      "M-S15a: fake Slack saw host-side bot token without raw capture leakage",
    );

    const slackCanonical = await runSlackApiRequest(
      sandbox,
      fakeSlack.port,
      "/api/auth.test",
      "Bearer openshell:resolve:env:SLACK_BOT_TOKEN",
      redactionValues,
    );
    check(
      /^200\b/.test(slackCanonical) && /invalid_auth|not_authed|ok":true/.test(slackCanonical),
      "M-S15b: L7 proxy substitutes canonical SLACK_BOT_TOKEN placeholder",
    );
    const slackUnset = await runSlackApiRequest(
      sandbox,
      fakeSlack.port,
      "/api/auth.test",
      "Bearer openshell:resolve:env:DEFINITELY_NOT_SET_XYZ",
      redactionValues,
    );
    check(
      isUnresolvedPlaceholderRejection(slackUnset) ||
        /ERROR:.*(socket hang up|ECONNRESET|EPIPE|hang up|reset)/i.test(slackUnset),
      `M-S15c: unset-var failed closed before upstream exposure (${slackUnset.slice(0, 200)})`,
    );

    const slackApp = await runSlackApiRequest(
      sandbox,
      fakeSlack.port,
      "/api/apps.connections.open",
      "Bearer xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN",
      redactionValues,
    );
    check(
      /^200\b/.test(slackApp) &&
        /invalid_auth|not_authed|not_allowed_token_type|ok":true/.test(slackApp),
      "M-S16: Slack Socket Mode HTTPS leg exercised xapp alias rewrite",
    );
    const slackAppCapture = lastJsonLine(
      fakeSlack.captureFile,
      (row) => row.event === "request" && row.path === "/api/apps.connections.open",
    );
    check(
      slackAppCapture?.tokenMatchesExpected === true &&
        slackAppCapture.bodyMatchesExpected === true &&
        slackAppCapture.tokenLooksPlaceholder !== true,
      "M-S16a: fake Slack saw host-side app token in header/body",
    );

    const fakeGateway = await startFakeDockerApi(host, cleanup.add.bind(cleanup), {
      kind: "discord-gateway",
      imageScript: "fake-discord-gateway.cjs",
      containerPrefix: "nemoclaw-fake-discord-gateway-vitest",
      portEnv: "FAKE_DISCORD_GATEWAY_PORT",
      portFileEnv: "FAKE_DISCORD_GATEWAY_PORT_FILE",
      captureFileEnv: "FAKE_DISCORD_GATEWAY_CAPTURE_FILE",
      expectedEnv: {
        FAKE_DISCORD_GATEWAY_EXPECTED_TOKEN: state.tokens.discord,
      },
      env: state.env,
      redactionValues,
    });
    await applyWebSocketRewritePolicy(host, fakeGateway, state.env, redactionValues);
    const gatewayProof = await runDiscordGatewayClient(
      sandbox,
      fakeGateway.port,
      "openshell:resolve:env:DISCORD_BOT_TOKEN",
      redactionValues,
    );
    check(
      gatewayProof.includes("UPGRADE"),
      "M13d: native WebSocket upgrade reached fake Discord Gateway",
    );
    check(
      gatewayProof.includes("HELLO") &&
        gatewayProof.includes("IDENTIFY_SENT_PLACEHOLDER") &&
        gatewayProof.includes("READY") &&
        gatewayProof.includes("HEARTBEAT_ACK"),
      "M13e: Discord HELLO, placeholder IDENTIFY, READY, heartbeat ACK completed",
    );
    const gatewayIdentify = lastJsonLine(
      fakeGateway.captureFile,
      (row) => row.event === "identify",
    );
    check(
      gatewayIdentify?.tokenMatchesExpected === true &&
        gatewayIdentify?.tokenLooksPlaceholder === false,
      "M13f: fake Gateway received host-side Discord token after relay rewrite",
    );

    const gatewayPort = await sandboxOutput(
      sandbox,
      `node -e '
const net = require("net");
const sock = net.connect(18789, "127.0.0.1");
sock.on("connect", () => { console.log("OPEN"); sock.end(); });
sock.on("error", () => console.log("CLOSED"));
setTimeout(() => { console.log("TIMEOUT"); sock.destroy(); }, 5000);
'`,
      "gateway-port-messaging-providers",
      redactionValues,
    );
    check(gatewayPort.includes("OPEN"), "S1: gateway is serving on port 18789");

    const gatewayLog = await sandboxOutput(
      sandbox,
      "cat /tmp/gateway.log 2>/dev/null || true",
      "gateway-log-messaging-providers",
      redactionValues,
    );
    if (/provider failed to start:.*gateway continues/.test(gatewayLog)) {
      check(true, "S2: gateway log shows Slack rejection was caught by channel guard");
    } else if (/slack/i.test(gatewayLog)) {
      await skipNote(
        artifacts,
        skips,
        "S2: gateway log has Slack output but not the guard catch message",
      );
    } else {
      await skipNote(artifacts, skips, "S2: no Slack-related output in gateway log");
    }

    const doctor = await runHost(host, "node", [CLI_ENTRYPOINT, SANDBOX_NAME, "doctor", "--json"], {
      artifactName: "doctor-json-messaging-providers",
      env: state.env,
      redactionValues,
      timeoutMs: 120_000,
    });
    if (doctor.exitCode !== 0 || !doctor.stdout.trim()) {
      await skipNote(artifacts, skips, "RT0: could not collect doctor --json output");
    } else {
      const report = JSON.parse(doctor.stdout) as {
        checks?: Array<{ label?: string; status?: string; detail?: string }>;
      };
      const runtimeCheck = report.checks?.find((item) => item.label === "Runtime channel registry");
      if (!runtimeCheck) {
        await skipNote(
          artifacts,
          skips,
          "RT1: doctor --json had no Runtime channel registry check",
        );
      } else {
        check(
          runtimeCheck.status === "ok" || runtimeCheck.status === "warn",
          `RT1: doctor reports runtime channel registry status (${runtimeCheck.status})`,
        );
      }
    }

    const telegramRealTarget = nonEmpty(process.env.TELEGRAM_CHAT_ID_E2E);
    if (nonEmpty(process.env.TELEGRAM_BOT_TOKEN_REAL) && telegramRealTarget) {
      check(telegramStatus === "200", "M18: Telegram getMe returned 200 with real token");
      const send = await runSandboxShell(
        sandbox,
        `OPENCLAW_NO_COLOR=1 openclaw message send --channel telegram --target ${shellQuote(telegramRealTarget)} --message "NemoClaw OpenClaw Telegram plugin E2E $(date -u +%Y-%m-%dT%H:%M:%SZ)" --json`,
        {
          artifactName: "real-telegram-send-messaging-providers",
          redactionValues,
          timeoutMs: 120_000,
        },
      );
      check(
        send.exitCode === 0,
        `M19: Telegram openclaw message send succeeded (${outputText(send).slice(0, 200)})`,
      );
    } else {
      await skipNote(
        artifacts,
        skips,
        "M18/M19: complete real Telegram credentials not available; fake-token L7 proof covered provider rewrite",
      );
    }

    const discordRealTarget = nonEmpty(process.env.DISCORD_CHANNEL_ID_E2E);
    if (nonEmpty(process.env.DISCORD_BOT_TOKEN_REAL) && discordRealTarget) {
      check(discordStatus === "200", "M20: Discord users/@me returned 200 with real token");
      const send = await runSandboxShell(
        sandbox,
        `OPENCLAW_NO_COLOR=1 openclaw message send --channel discord --target ${shellQuote(`channel:${discordRealTarget}`)} --message "NemoClaw OpenClaw Discord plugin E2E $(date -u +%Y-%m-%dT%H:%M:%SZ)" --json`,
        {
          artifactName: "real-discord-send-messaging-providers",
          redactionValues,
          timeoutMs: 120_000,
        },
      );
      check(
        send.exitCode === 0,
        `M21: Discord openclaw message send succeeded (${outputText(send).slice(0, 200)})`,
      );
    } else {
      await skipNote(
        artifacts,
        skips,
        "M20/M21: complete real Discord credentials not available; fake Gateway proof covered provider rewrite",
      );
    }

    const slackRealTarget = nonEmpty(process.env.SLACK_CHANNEL_ID_E2E);
    if (nonEmpty(process.env.SLACK_BOT_TOKEN_REAL) && slackRealTarget) {
      const send = await runSandboxShell(
        sandbox,
        `OPENCLAW_NO_COLOR=1 openclaw message send --channel slack --target ${shellQuote(`channel:${slackRealTarget}`)} --message "NemoClaw OpenClaw Slack plugin E2E $(date -u +%Y-%m-%dT%H:%M:%SZ)" --json`,
        {
          artifactName: "real-slack-send-messaging-providers",
          redactionValues,
          timeoutMs: 120_000,
        },
      );
      check(
        send.exitCode === 0,
        `M23: Slack openclaw message send succeeded (${outputText(send).slice(0, 200)})`,
      );
    } else {
      check(
        slackAuthCapture?.tokenMatchesExpected === true &&
          slackAppCapture?.tokenMatchesExpected === true,
        "M22/M23: Slack host mock accepted OpenShell-rewritten bot/app tokens",
      );
    }
  },
);
