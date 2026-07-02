// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { type E2ETargetFixtures, expect } from "../fixtures/e2e-test.ts";
import {
  applyFakePolicy,
  assertDiscordGatewayCapture,
  assertSlackRestCapture,
  assertSlackSocketModeCapture,
  runDiscordGatewayProof,
  runSlackRestProof,
  runSlackSocketModeProof,
  startFakeDiscordGateway,
  startFakeSlackApi,
} from "./openclaw-pairing-helpers.ts";
import {
  type AgentKind,
  bestEffort,
  CLI,
  cleanupSandbox,
  dockerInfo,
  expectExitZero,
  expectSandboxReady,
  installSandboxOrSkipOnRateLimit,
  phase6Env,
  resultText,
  sandboxSh,
  shellQuote,
} from "./phase6-messaging-helpers.ts";

const REGISTRY_FILE = path.join(process.env.HOME ?? os.homedir(), ".nemoclaw", "sandboxes.json");

export const CHANNELS = ["telegram", "discord", "wechat", "slack", "whatsapp", "teams"] as const;
export type MessagingChannel = (typeof CHANNELS)[number];
export type ChannelState = "active" | "disabled" | "removed";
export type ChannelLifecycleKind = "add-remove" | "stop-start";
type ChannelLifecycleFixtures = Pick<
  E2ETargetFixtures,
  "artifacts" | "cleanup" | "host" | "sandbox" | "secrets"
> & {
  skip: (note?: string) => never;
};

type JsonRecord = Record<string, unknown>;
type Phase6Tokens = {
  telegram: string;
  discord: string;
  slackBot: string;
  slackApp: string;
  wechat: string;
  teamsClientSecret: string;
};

const PROVIDERS: Record<MessagingChannel, (sandbox: string) => string[]> = {
  telegram: (sandbox) => [`${sandbox}-telegram-bridge`],
  discord: (sandbox) => [`${sandbox}-discord-bridge`],
  wechat: (sandbox) => [`${sandbox}-wechat-bridge`],
  slack: (sandbox) => [`${sandbox}-slack-bridge`, `${sandbox}-slack-app`],
  whatsapp: () => [],
  teams: (sandbox) => [`${sandbox}-teams-bridge`],
};

export function channelLifecycleTestName(agent: AgentKind, kind: ChannelLifecycleKind): string {
  return `${agent}-channels-${kind}`;
}

export function channelLifecycleSandboxName(agent: AgentKind, kind: ChannelLifecycleKind): string {
  return process.env.NEMOCLAW_SANDBOX_NAME ?? `e2e-${channelLifecycleTestName(agent, kind)}`;
}

export function assertChannelLifecycleSandboxName(
  sandboxName: string,
  agent?: AgentKind,
  kind?: ChannelLifecycleKind,
): void {
  const prefixes =
    agent && kind
      ? [`e2e-${channelLifecycleTestName(agent, kind)}`]
      : [
          "e2e-openclaw-channels-add-remove",
          "e2e-hermes-channels-add-remove",
          "e2e-openclaw-channels-stop-start",
          "e2e-hermes-channels-stop-start",
        ];
  if (!prefixes.some((prefix) => sandboxName.startsWith(prefix))) {
    throw new Error(
      `channels lifecycle live tests are destructive and only accept sandbox names with prefixes ${prefixes.join(", ")}; got ${sandboxName}`,
    );
  }
}

function phase6Tokens(suffix: string): Phase6Tokens {
  return {
    telegram: process.env.TELEGRAM_BOT_TOKEN ?? `test-fake-telegram-token-${suffix}`,
    discord: process.env.DISCORD_BOT_TOKEN ?? `test-fake-discord-token-${suffix}`,
    slackBot: process.env.SLACK_BOT_TOKEN ?? `xoxb-fake-slack-token-${suffix}`,
    slackApp: process.env.SLACK_APP_TOKEN ?? `xapp-fake-slack-token-${suffix}`,
    wechat: process.env.WECHAT_BOT_TOKEN ?? `test-fake-wechat-token-${suffix}`,
    teamsClientSecret:
      process.env.MSTEAMS_APP_PASSWORD ?? `test-fake-teams-client-secret-${suffix}`,
  };
}

function smallHash(value: string): number {
  let hash = 0;
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) % 1000;
  }
  return hash;
}

function teamsWebhookPort(sandboxName: string): string {
  return process.env.MSTEAMS_PORT ?? String(39_780 + smallHash(sandboxName));
}

function teamsAppId(sandboxName: string): string {
  return process.env.MSTEAMS_APP_ID ?? `test-teams-app-id-${sandboxName}`;
}

function teamsTenantId(sandboxName: string): string {
  return process.env.MSTEAMS_TENANT_ID ?? `test-teams-tenant-id-${sandboxName}`;
}

function teamsAllowedUsers(): string {
  return process.env.TEAMS_ALLOWED_USERS ?? "00000000-0000-0000-0000-000000000001";
}

function teamsRequireMention(): string {
  return process.env.TEAMS_REQUIRE_MENTION ?? "0";
}

function phase6TokenEnv(tokens: Phase6Tokens, sandboxName: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    TELEGRAM_BOT_TOKEN: tokens.telegram,
    TELEGRAM_ALLOWED_IDS: process.env.TELEGRAM_ALLOWED_IDS ?? "123456789,987654321",
    TELEGRAM_REQUIRE_MENTION: process.env.TELEGRAM_REQUIRE_MENTION ?? "0",
    DISCORD_BOT_TOKEN: tokens.discord,
    DISCORD_SERVER_ID: process.env.DISCORD_SERVER_ID ?? "1491590992753590594",
    DISCORD_SERVER_IDS:
      process.env.DISCORD_SERVER_IDS ?? process.env.DISCORD_SERVER_ID ?? "1491590992753590594",
    DISCORD_USER_ID: process.env.DISCORD_USER_ID ?? "1005536447329222676",
    DISCORD_ALLOWED_IDS:
      process.env.DISCORD_ALLOWED_IDS ?? process.env.DISCORD_USER_ID ?? "1005536447329222676",
    DISCORD_REQUIRE_MENTION: process.env.DISCORD_REQUIRE_MENTION ?? "0",
    SLACK_BOT_TOKEN: tokens.slackBot,
    SLACK_APP_TOKEN: tokens.slackApp,
    SLACK_ALLOWED_USERS: process.env.SLACK_ALLOWED_USERS ?? "U0123456789,U09ABCDEFGH",
    WECHAT_BOT_TOKEN: tokens.wechat,
    WECHAT_ACCOUNT_ID: process.env.WECHAT_ACCOUNT_ID ?? `e2e-fake-account-${sandboxName}`,
    WECHAT_BASE_URL: process.env.WECHAT_BASE_URL ?? "https://ilinkai.wechat.com",
    WECHAT_USER_ID: process.env.WECHAT_USER_ID ?? "wxid_e2e_operator",
    WECHAT_ALLOWED_IDS:
      process.env.WECHAT_ALLOWED_IDS ?? process.env.WECHAT_USER_ID ?? "wxid_e2e_operator",
    MSTEAMS_APP_ID: teamsAppId(sandboxName),
    MSTEAMS_APP_PASSWORD: tokens.teamsClientSecret,
    MSTEAMS_TENANT_ID: teamsTenantId(sandboxName),
    TEAMS_ALLOWED_USERS: teamsAllowedUsers(),
    MSTEAMS_PORT: teamsWebhookPort(sandboxName),
    TEAMS_REQUIRE_MENTION: teamsRequireMention(),
  };
  if (tokens.telegram.includes("fake")) env.NEMOCLAW_SKIP_TELEGRAM_REACHABILITY = "1";
  if (
    /^(xoxb|xapp)-(fake|test)-/.test(tokens.slackBot) ||
    /^(xoxb|xapp)-(fake|test)-/.test(tokens.slackApp)
  ) {
    env.NEMOCLAW_SKIP_SLACK_AUTH_VALIDATION = "1";
  }
  return env;
}

function redactionValues(apiKey: string | undefined, tokens: Phase6Tokens): string[] {
  return [apiKey, ...Object.values(tokens)].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

function arrayRecords(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.filter((item): item is JsonRecord => Boolean(item) && typeof item === "object")
    : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function readRegistryEntry(sandboxName: string): JsonRecord {
  expect(fs.existsSync(REGISTRY_FILE), `${REGISTRY_FILE} missing`).toBe(true);
  const registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")) as {
    sandboxes?: Record<string, JsonRecord>;
  };
  const entry = registry.sandboxes?.[sandboxName];
  expect(entry, `registry entry ${sandboxName} missing`).toBeTruthy();
  if (!entry) throw new Error(`registry entry ${sandboxName} missing`);
  return entry;
}

function messagingState(sandboxName: string): JsonRecord {
  const messaging = readRegistryEntry(sandboxName).messaging;
  expect(messaging && typeof messaging === "object", "registry messaging state missing").toBe(true);
  if (!messaging || typeof messaging !== "object")
    throw new Error("registry messaging state missing");
  const state = messaging as JsonRecord;
  expect(state.schemaVersion, "messaging.schemaVersion").toBe(1);
  return state;
}

function messagingPlan(sandboxName: string): JsonRecord {
  const plan = messagingState(sandboxName).plan;
  expect(plan && typeof plan === "object", "registry messaging.plan missing").toBe(true);
  if (!plan || typeof plan !== "object") throw new Error("registry messaging.plan missing");
  const record = plan as JsonRecord;
  expect(record.schemaVersion, "messaging.plan.schemaVersion").toBe(1);
  expect(record.sandboxName, "messaging.plan.sandboxName").toBe(sandboxName);
  return record;
}

function planChannel(sandboxName: string, channelId: string) {
  return arrayRecords(messagingPlan(sandboxName).channels).find(
    (channel) => channel.channelId === channelId,
  );
}

function optionalMessagingPlan(sandboxName: string): JsonRecord | undefined {
  const messaging = readRegistryEntry(sandboxName).messaging;
  if (!messaging || typeof messaging !== "object") return undefined;
  const state = messaging as JsonRecord;
  if (state.schemaVersion !== 1 || !state.plan || typeof state.plan !== "object") {
    return undefined;
  }
  return state.plan as JsonRecord;
}

function expectPlanChannelState(
  sandboxName: string,
  agent: AgentKind,
  channelId: MessagingChannel,
  expected: ChannelState,
): void {
  const plan =
    expected === "removed"
      ? (optionalMessagingPlan(sandboxName) ?? {})
      : messagingPlan(sandboxName);
  const channels = arrayRecords(plan.channels);
  const channel = channels.find((entry) => entry.channelId === channelId);
  if (Object.hasOwn(plan, "agent")) {
    expect(plan.agent, "messaging.plan.agent").toBe(agent);
  }

  const disabledChannels = stringArray(plan.disabledChannels);
  const networkPolicy =
    plan.networkPolicy && typeof plan.networkPolicy === "object"
      ? (plan.networkPolicy as Record<string, unknown>)
      : {};
  const networkPresets = stringArray(networkPolicy.presets);
  const networkEntries = arrayRecords(networkPolicy.entries);
  const credentialBindings = arrayRecords(plan.credentialBindings);

  if (expected === "removed") {
    expect(channel, `${channelId} still present in messaging.plan.channels`).toBeUndefined();
    expect(disabledChannels, `${channelId} still present in disabledChannels`).not.toContain(
      channelId,
    );
    expect(networkPresets, `${channelId} still present in policy presets`).not.toContain(channelId);
    expect(
      networkEntries.some((entry) => entry.channelId === channelId),
      `${channelId} still present in policy entries`,
    ).toBe(false);
    expect(
      credentialBindings.some((entry) => entry.channelId === channelId),
      `${channelId} credential binding still present`,
    ).toBe(false);
    return;
  }

  expect(channel, `${channelId} missing from messaging.plan.channels`).toBeTruthy();
  expect(channel?.configured, `${channelId} configured`).toBe(true);
  if (expected === "active") {
    expect(channel?.active, `${channelId} active`).toBe(true);
    expect(channel?.disabled, `${channelId} disabled unexpectedly`).not.toBe(true);
    expect(disabledChannels, `${channelId} unexpectedly disabled`).not.toContain(channelId);
  } else {
    expect(channel?.disabled, `${channelId} disabled`).toBe(true);
    expect(channel?.active, `${channelId} active unexpectedly`).not.toBe(true);
    expect(disabledChannels, `${channelId} missing from disabledChannels`).toContain(channelId);
  }

  expect(networkPresets, `${channelId} policy preset`).toContain(channelId);
  expect(
    networkEntries.some((entry) => entry.channelId === channelId),
    `${channelId} policy entry`,
  ).toBe(true);
  if (channelId !== "whatsapp") {
    expect(
      credentialBindings.some((entry) => entry.channelId === channelId),
      `${channelId} credential binding`,
    ).toBe(true);
  }
  expect(Object.hasOwn(plan, "agentRender"), "messaging.plan.agentRender should not persist").toBe(
    false,
  );
  expect(
    channels.some((entry) => Object.hasOwn(entry, "hooks")),
    "messaging.plan.channels hooks should not persist",
  ).toBe(false);
}

function expectChannelInputs(sandboxName: string): void {
  const expected: Record<string, Record<string, string>> = {
    telegram: {
      allowedIds: process.env.TELEGRAM_ALLOWED_IDS ?? "123456789,987654321",
      requireMention: process.env.TELEGRAM_REQUIRE_MENTION ?? "0",
    },
    discord: {
      serverId: process.env.DISCORD_SERVER_ID ?? "1491590992753590594",
      userId: process.env.DISCORD_USER_ID ?? "1005536447329222676",
      requireMention: process.env.DISCORD_REQUIRE_MENTION ?? "0",
    },
    slack: { allowedUsers: process.env.SLACK_ALLOWED_USERS ?? "U0123456789,U09ABCDEFGH" },
    wechat: {
      allowedIds:
        process.env.WECHAT_ALLOWED_IDS ?? process.env.WECHAT_USER_ID ?? "wxid_e2e_operator",
    },
    teams: {
      appId: teamsAppId(sandboxName),
      tenantId: teamsTenantId(sandboxName),
      allowedUsers: teamsAllowedUsers(),
      webhookPort: teamsWebhookPort(sandboxName),
      requireMention: teamsRequireMention(),
    },
  };
  for (const [channelId, inputs] of Object.entries(expected)) {
    const channel = planChannel(sandboxName, channelId);
    const planInputs = arrayRecords(channel?.inputs);
    for (const [inputId, value] of Object.entries(inputs)) {
      expect(
        planInputs.find((input) => input.inputId === inputId)?.value,
        `${channelId}.${inputId}`,
      ).toBe(value);
    }
  }
}

function openClawChannelKey(channel: string): string {
  if (channel === "teams") return "msteams";
  return channel === "wechat" ? "openclaw-weixin" : channel;
}

function grepFixedLine(line: string, file: string): string {
  return `grep -Fxq ${shellQuote(line)} ${shellQuote(file)}`;
}

function hermesChannelProbe(channel: MessagingChannel, sandboxName: string): string {
  const hermesEnv = "/sandbox/.hermes/.env";
  const probes: Record<MessagingChannel, string> = {
    telegram: grepFixedLine(
      "TELEGRAM_BOT_TOKEN=openshell:resolve:env:TELEGRAM_BOT_TOKEN",
      hermesEnv,
    ),
    discord: grepFixedLine("DISCORD_BOT_TOKEN=openshell:resolve:env:DISCORD_BOT_TOKEN", hermesEnv),
    wechat: grepFixedLine("WEIXIN_TOKEN=openshell:resolve:env:WECHAT_BOT_TOKEN", hermesEnv),
    slack: [
      grepFixedLine("SLACK_BOT_TOKEN=xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN", hermesEnv),
      grepFixedLine("SLACK_APP_TOKEN=xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN", hermesEnv),
    ].join(" && "),
    whatsapp: [
      grepFixedLine("WHATSAPP_ENABLED=true", hermesEnv),
      grepFixedLine("WHATSAPP_MODE=bot", hermesEnv),
    ].join(" && "),
    teams: [
      grepFixedLine(`TEAMS_CLIENT_ID=${teamsAppId(sandboxName)}`, hermesEnv),
      grepFixedLine("TEAMS_CLIENT_SECRET=openshell:resolve:env:MSTEAMS_APP_PASSWORD", hermesEnv),
      grepFixedLine(`TEAMS_TENANT_ID=${teamsTenantId(sandboxName)}`, hermesEnv),
      grepFixedLine(`TEAMS_ALLOWED_USERS=${teamsAllowedUsers()}`, hermesEnv),
      grepFixedLine(`TEAMS_PORT=${teamsWebhookPort(sandboxName)}`, hermesEnv),
    ].join(" && "),
  };
  return probes[channel];
}

async function agentConfigContains(
  sandbox: import("../fixtures/clients/sandbox.ts").SandboxClient,
  agent: AgentKind,
  sandboxName: string,
  channel: MessagingChannel,
  redactions: string[],
): Promise<boolean> {
  if (agent === "openclaw") {
    const result = await sandboxSh(
      sandbox,
      sandboxName,
      `python3 -c ${shellQuote(
        `import json; channel=${JSON.stringify(
          openClawChannelKey(channel),
        )}; cfg=json.load(open('/sandbox/.openclaw/openclaw.json')); print('yes' if channel in cfg.get('channels', {}) else 'no')`,
      )}`,
      { artifactName: `config-channel-${agent}-${channel}`, redactionValues: redactions },
    );
    expectExitZero(result, `read OpenClaw channel ${channel}`);
    return result.stdout.trim() === "yes";
  }

  const probe = hermesChannelProbe(channel, sandboxName);
  const result = await sandboxSh(
    sandbox,
    sandboxName,
    `if [ -r /sandbox/.hermes/.env ] && ${probe}; then echo yes; else echo no; fi`,
    { artifactName: `config-channel-${agent}-${channel}`, redactionValues: redactions },
  );
  expectExitZero(result, `read Hermes channel ${channel}`);
  return result.stdout.trim() === "yes";
}

async function expectAgentConfig(
  sandbox: import("../fixtures/clients/sandbox.ts").SandboxClient,
  agent: AgentKind,
  sandboxName: string,
  expected: "present" | "absent",
  redactions: string[],
): Promise<void> {
  for (const channel of CHANNELS) {
    const present = await agentConfigContains(sandbox, agent, sandboxName, channel, redactions);
    expect(present, `${agent}/${channel} config ${expected}`).toBe(expected === "present");
  }
}

async function expectRawTokensAbsent(
  sandbox: import("../fixtures/clients/sandbox.ts").SandboxClient,
  sandboxName: string,
  tokens: Phase6Tokens,
  redactions: string[],
): Promise<void> {
  for (const [label, token] of Object.entries(tokens)) {
    const result = await sandboxSh(
      sandbox,
      sandboxName,
      `if grep -R -F ${shellQuote(token)} /sandbox/.openclaw /sandbox/.hermes 2>/dev/null; then exit 1; fi`,
      { artifactName: `raw-token-absent-${label}`, redactionValues: redactions },
    );
    expectExitZero(result, `raw ${label} token absent from sandbox config`);
  }
}

async function expectProviders(
  host: import("../fixtures/clients/host.ts").HostCliClient,
  sandboxName: string,
  env: NodeJS.ProcessEnv,
  redactions: string[],
  expected: "present" | "absent",
  context: string,
): Promise<void> {
  for (const channel of CHANNELS) {
    for (const provider of PROVIDERS[channel](sandboxName)) {
      const result = await host.command("openshell", ["provider", "get", provider], {
        artifactName: `provider-${provider}-${context}`,
        env,
        redactionValues: redactions,
        timeoutMs: 60_000,
      });
      if (expected === "present") {
        expectExitZero(result, `${provider} exists ${context}`);
      } else {
        expect(result.exitCode, `${provider} absent ${context}\n${resultText(result)}`).not.toBe(0);
      }
    }
  }
}

async function precleanProviders(
  host: import("../fixtures/clients/host.ts").HostCliClient,
  sandboxName: string,
  env: NodeJS.ProcessEnv,
  redactions: string[],
  context: string,
): Promise<void> {
  for (const channel of CHANNELS) {
    for (const provider of PROVIDERS[channel](sandboxName)) {
      await host.command("openshell", ["provider", "delete", provider], {
        artifactName: `provider-delete-${provider}-${context}`,
        env,
        redactionValues: redactions,
        timeoutMs: 60_000,
      });
      const result = await host.command("openshell", ["provider", "get", provider], {
        artifactName: `provider-absent-${provider}-${context}`,
        env,
        redactionValues: redactions,
        timeoutMs: 60_000,
      });
      expect(
        result.exitCode,
        `${provider} absent after provider pre-clean\n${resultText(result)}`,
      ).not.toBe(0);
    }
  }
}

async function destroyNemoclawGateway(
  host: import("../fixtures/clients/host.ts").HostCliClient,
  env: NodeJS.ProcessEnv,
  redactions: string[],
  artifactName: string,
): Promise<void> {
  await bestEffort(() =>
    host.command("openshell", ["gateway", "destroy", "-g", "nemoclaw"], {
      artifactName,
      env,
      redactionValues: redactions,
      timeoutMs: 60_000,
    }),
  );
}

async function stopTeamsForward(
  host: import("../fixtures/clients/host.ts").HostCliClient,
  sandboxName: string,
  env: NodeJS.ProcessEnv,
  redactions: string[],
  artifactName: string,
): Promise<void> {
  const port = env.MSTEAMS_PORT ?? teamsWebhookPort(sandboxName);
  await bestEffort(() =>
    host.command("openshell", ["forward", "stop", String(port), sandboxName], {
      artifactName,
      env,
      redactionValues: redactions,
      timeoutMs: 60_000,
    }),
  );
}

async function rebuildSandbox(
  host: import("../fixtures/clients/host.ts").HostCliClient,
  sandboxName: string,
  env: NodeJS.ProcessEnv,
  redactions: string[],
  artifactName: string,
) {
  return host.command("node", [CLI, sandboxName, "rebuild", "--yes"], {
    artifactName,
    env,
    redactionValues: redactions,
    timeoutMs: 30 * 60_000,
  });
}

async function policyPresetActive(
  host: import("../fixtures/clients/host.ts").HostCliClient,
  sandboxName: string,
  env: NodeJS.ProcessEnv,
  redactions: string[],
  channel: MessagingChannel,
): Promise<boolean> {
  const result = await host.command(
    "node",
    [process.env.NEMOCLAW_CLI_BIN ?? "bin/nemoclaw.js", sandboxName, "policy-list"],
    {
      artifactName: `policy-list-${channel}-${sandboxName}`,
      env,
      redactionValues: redactions,
      timeoutMs: 60_000,
    },
  );
  expectExitZero(result, `policy-list ${channel}`);
  return resultText(result).includes(`● ${channel}`);
}

async function expectPolicyPresets(
  host: import("../fixtures/clients/host.ts").HostCliClient,
  sandboxName: string,
  env: NodeJS.ProcessEnv,
  redactions: string[],
  expected: "active" | "inactive",
): Promise<void> {
  for (const channel of CHANNELS) {
    expect(
      await policyPresetActive(host, sandboxName, env, redactions, channel),
      `${channel} policy ${expected}`,
    ).toBe(expected === "active");
  }
}

async function runChannelCommand(
  host: import("../fixtures/clients/host.ts").HostCliClient,
  sandboxName: string,
  env: NodeJS.ProcessEnv,
  redactions: string[],
  action: "add" | "remove" | "stop" | "start",
  channel: MessagingChannel,
): Promise<void> {
  const result = await host.command(
    "node",
    [process.env.NEMOCLAW_CLI_BIN ?? "bin/nemoclaw.js", sandboxName, "channels", action, channel],
    {
      artifactName: `channels-${action}-${channel}-${sandboxName}`,
      env,
      redactionValues: redactions,
      timeoutMs: 10 * 60_000,
    },
  );
  expectExitZero(result, `channels ${action} ${channel}`);
  const text = resultText(result);
  if (action === "add") {
    expect(text).toMatch(new RegExp(`(Enabled|Registered) ${channel}`));
  } else if (action === "remove") {
    expect(text).toContain(`Removed ${channel}`);
  } else {
    expect(text).toContain(`Marked ${channel} ${action === "stop" ? "disabled" : "enabled"}`);
  }
}

async function expectHermesProtocolCredentialRewrite(options: {
  cleanup: ChannelLifecycleFixtures["cleanup"];
  host: ChannelLifecycleFixtures["host"];
  sandbox: ChannelLifecycleFixtures["sandbox"];
  sandboxName: string;
  env: NodeJS.ProcessEnv;
  tokens: Phase6Tokens;
  redactions: string[];
}): Promise<void> {
  const fakeSlack = await startFakeSlackApi(
    options.host,
    options.cleanup,
    options.env,
    options.tokens.slackBot,
    options.tokens.slackApp,
    options.redactions,
  );
  await applyFakePolicy({
    host: options.host,
    sandboxName: options.sandboxName,
    api: fakeSlack,
    protocol: "rest",
    rewrite: "request-body-credential-rewrite",
    env: options.env,
    redactions: options.redactions,
    artifactName: "apply-hermes-slack-rest-policy",
  });
  await applyFakePolicy({
    host: options.host,
    sandboxName: options.sandboxName,
    api: fakeSlack,
    protocol: "websocket",
    rewrite: "websocket-credential-rewrite",
    env: options.env,
    redactions: options.redactions,
    artifactName: "apply-hermes-slack-websocket-policy",
  });

  const slackAuth = await runSlackRestProof({
    sandbox: options.sandbox,
    sandboxName: options.sandboxName,
    port: fakeSlack.port,
    apiPath: "/api/auth.test",
    authorization: "Bearer xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
    redactions: options.redactions,
  });
  expectExitZero(slackAuth, "Hermes Slack auth.test rewrite proof");
  expect(resultText(slackAuth)).toMatch(/^200\b/);
  assertSlackRestCapture(fakeSlack.captureFile, "/api/auth.test");

  const slackApp = await runSlackRestProof({
    sandbox: options.sandbox,
    sandboxName: options.sandboxName,
    port: fakeSlack.port,
    apiPath: "/api/apps.connections.open",
    authorization: "Bearer xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN",
    redactions: options.redactions,
  });
  expectExitZero(slackApp, "Hermes Slack apps.connections.open rewrite proof");
  expect(resultText(slackApp)).toMatch(/^200\b/);
  assertSlackRestCapture(fakeSlack.captureFile, "/api/apps.connections.open");

  const slackSocket = await runSlackSocketModeProof({
    sandbox: options.sandbox,
    sandboxName: options.sandboxName,
    port: fakeSlack.port,
    redactions: options.redactions,
  });
  expectExitZero(slackSocket, "Hermes Slack Socket Mode rewrite proof");
  expect(resultText(slackSocket)).toContain("UPGRADE");
  expect(resultText(slackSocket)).toContain("HELLO_SENT_PLACEHOLDER");
  expect(resultText(slackSocket)).toContain("EVENT_RECEIVED");
  expect(resultText(slackSocket)).toContain("EVENT_ACK");
  assertSlackSocketModeCapture(fakeSlack.captureFile, options.tokens.slackApp);

  const fakeGateway = await startFakeDiscordGateway(
    options.host,
    options.cleanup,
    options.env,
    options.tokens.discord,
    options.redactions,
  );
  await applyFakePolicy({
    host: options.host,
    sandboxName: options.sandboxName,
    api: fakeGateway,
    protocol: "websocket",
    rewrite: "websocket-credential-rewrite",
    env: options.env,
    redactions: options.redactions,
    artifactName: "apply-hermes-discord-gateway-policy",
  });
  const gatewayProof = await runDiscordGatewayProof({
    sandbox: options.sandbox,
    sandboxName: options.sandboxName,
    port: fakeGateway.port,
    redactions: options.redactions,
  });
  expectExitZero(gatewayProof, "Hermes Discord Gateway rewrite proof");
  expect(resultText(gatewayProof)).toContain("UPGRADE");
  expect(resultText(gatewayProof)).toContain("HELLO");
  expect(resultText(gatewayProof)).toContain("IDENTIFY_SENT_PLACEHOLDER");
  expect(resultText(gatewayProof)).toContain("READY");
  expect(resultText(gatewayProof)).toContain("HEARTBEAT_ACK");
  assertDiscordGatewayCapture(fakeGateway.captureFile, options.tokens.discord);
}

function lifecycleEnv(options: {
  agent: AgentKind;
  sandboxName: string;
  apiKey?: string;
  tokens?: Phase6Tokens;
  policyMode?: "skip";
}): NodeJS.ProcessEnv {
  return phase6Env({
    sandboxName: options.sandboxName,
    agent: options.agent,
    apiKey: options.apiKey,
    extra: {
      ...(options.tokens ? phase6TokenEnv(options.tokens, options.sandboxName) : {}),
      ...(options.policyMode ? { NEMOCLAW_POLICY_MODE: options.policyMode } : {}),
    },
  });
}

async function cleanupLifecycleSandbox(options: {
  host: import("../fixtures/clients/host.ts").HostCliClient;
  sandboxName: string;
  env: NodeJS.ProcessEnv;
  redactions: string[];
  prefix: string;
}): Promise<void> {
  await cleanupSandbox(
    options.host,
    options.sandboxName,
    options.env,
    options.redactions,
    options.prefix,
  );
  await stopTeamsForward(
    options.host,
    options.sandboxName,
    options.env,
    options.redactions,
    `${options.prefix}-openshell-forward-stop-teams`,
  );
  await destroyNemoclawGateway(
    options.host,
    options.env,
    options.redactions,
    `${options.prefix}-openshell-gateway-destroy`,
  );
}

export const CHANNELS_ADD_REMOVE_TIMEOUT_MS = 90 * 60_000;
export const CHANNELS_STOP_START_TIMEOUT_MS = 80 * 60_000;

export async function runChannelsAddRemoveTarget(
  agent: AgentKind,
  { artifacts, cleanup, host, sandbox, secrets, skip }: ChannelLifecycleFixtures,
): Promise<void> {
  const sandboxName = channelLifecycleSandboxName(agent, "add-remove");
  assertChannelLifecycleSandboxName(sandboxName, agent, "add-remove");
  const apiKey = secrets.required("NVIDIA_INFERENCE_API_KEY");
  const tokens = phase6Tokens(`${agent}-add-remove`);
  const installEnv = lifecycleEnv({ agent, sandboxName, apiKey, policyMode: "skip" });
  const channelEnv = lifecycleEnv({ agent, sandboxName, tokens, policyMode: "skip" });
  const authenticatedChannelEnv = lifecycleEnv({
    agent,
    sandboxName,
    apiKey,
    tokens,
    policyMode: "skip",
  });
  const redactions = redactionValues(apiKey, tokens);

  await artifacts.writeJson("target.json", {
    id: channelLifecycleTestName(agent, "add-remove"),
    boundary:
      "install.sh no-channel onboarding + channels add/remove CLI + rebuild + registry/provider/policy/sandbox config probes",
    agent,
    sandboxName,
    channels: CHANNELS,
  });

  cleanup.add(`destroy channels add/remove sandbox ${sandboxName}`, async () => {
    await cleanupLifecycleSandbox({
      host,
      sandboxName,
      env: authenticatedChannelEnv,
      redactions,
      prefix: `cleanup-${agent}-channels-add-remove`,
    });
  });
  await cleanupLifecycleSandbox({
    host,
    sandboxName,
    env: authenticatedChannelEnv,
    redactions,
    prefix: `preclean-${agent}-channels-add-remove`,
  });
  await precleanProviders(
    host,
    sandboxName,
    authenticatedChannelEnv,
    redactions,
    `preclean-${agent}-channels-add-remove`,
  );

  const docker = await dockerInfo(host, installEnv);
  expect(docker.exitCode, resultText(docker)).toBe(0);
  const install = await installSandboxOrSkipOnRateLimit(
    host,
    installEnv,
    redactions,
    `install-${agent}-channels-add-remove`,
    skip,
    "NVIDIA endpoint validation was rate-limited before channel add/remove assertions ran",
  );
  expectExitZero(install, `${agent} install.sh without channels`);
  await expectSandboxReady(
    host,
    sandboxName,
    installEnv,
    redactions,
    `sandbox-list-${agent}-channels-add-remove`,
  );
  await expectAgentConfig(sandbox, agent, sandboxName, "absent", redactions);
  await expectProviders(
    host,
    sandboxName,
    authenticatedChannelEnv,
    redactions,
    "absent",
    "baseline",
  );
  await expectPolicyPresets(host, sandboxName, authenticatedChannelEnv, redactions, "inactive");

  for (const channel of CHANNELS) {
    await runChannelCommand(host, sandboxName, channelEnv, redactions, "add", channel);
    expectPlanChannelState(sandboxName, agent, channel, "active");
  }
  expectChannelInputs(sandboxName);

  const addRebuild = await rebuildSandbox(
    host,
    sandboxName,
    channelEnv,
    redactions,
    `rebuild-after-add-${agent}-channels-add-remove`,
  );
  expect(resultText(addRebuild)).not.toContain("provider credential not found");
  expectExitZero(addRebuild, "rebuild after adding all channels");
  await expectAgentConfig(sandbox, agent, sandboxName, "present", redactions);
  await expectRawTokensAbsent(sandbox, sandboxName, tokens, redactions);
  await expectProviders(
    host,
    sandboxName,
    authenticatedChannelEnv,
    redactions,
    "present",
    "after-add",
  );
  await expectPolicyPresets(host, sandboxName, authenticatedChannelEnv, redactions, "active");

  if (agent === "hermes") {
    await expectHermesProtocolCredentialRewrite({
      cleanup,
      host,
      sandbox,
      sandboxName,
      env: authenticatedChannelEnv,
      tokens,
      redactions,
    });
  }

  for (const channel of CHANNELS) {
    await runChannelCommand(
      host,
      sandboxName,
      authenticatedChannelEnv,
      redactions,
      "remove",
      channel,
    );
    expectPlanChannelState(sandboxName, agent, channel, "removed");
  }

  const removeRebuild = await rebuildSandbox(
    host,
    sandboxName,
    authenticatedChannelEnv,
    redactions,
    `rebuild-after-remove-${agent}-channels-add-remove`,
  );
  expectExitZero(removeRebuild, "rebuild after removing all channels");
  await expectAgentConfig(sandbox, agent, sandboxName, "absent", redactions);
  await expectProviders(
    host,
    sandboxName,
    authenticatedChannelEnv,
    redactions,
    "absent",
    "after-remove",
  );
  await expectPolicyPresets(host, sandboxName, authenticatedChannelEnv, redactions, "inactive");
  for (const channel of CHANNELS) {
    expectPlanChannelState(sandboxName, agent, channel, "removed");
  }
}

export async function runChannelsStopStartTarget(
  agent: AgentKind,
  { artifacts, cleanup, host, sandbox, secrets, skip }: ChannelLifecycleFixtures,
): Promise<void> {
  const sandboxName = channelLifecycleSandboxName(agent, "stop-start");
  assertChannelLifecycleSandboxName(sandboxName, agent, "stop-start");
  const apiKey = secrets.required("NVIDIA_INFERENCE_API_KEY");
  const tokens = phase6Tokens(`${agent}-stop-start`);
  const env = lifecycleEnv({ agent, sandboxName, apiKey, tokens });
  const redactions = redactionValues(apiKey, tokens);

  await artifacts.writeJson("target.json", {
    id: channelLifecycleTestName(agent, "stop-start"),
    boundary:
      "install.sh messaging onboard + channels stop/start CLI + rebuild + registry/provider/policy/sandbox config probes",
    agent,
    sandboxName,
    channels: CHANNELS,
  });

  cleanup.add(`destroy channels stop/start sandbox ${sandboxName}`, async () => {
    await cleanupLifecycleSandbox({
      host,
      sandboxName,
      env,
      redactions,
      prefix: `cleanup-${agent}-channels-stop-start`,
    });
  });
  await cleanupLifecycleSandbox({
    host,
    sandboxName,
    env,
    redactions,
    prefix: `preclean-${agent}-channels-stop-start`,
  });
  await precleanProviders(
    host,
    sandboxName,
    env,
    redactions,
    `preclean-${agent}-channels-stop-start`,
  );

  const docker = await dockerInfo(host, env);
  expect(docker.exitCode, resultText(docker)).toBe(0);
  const install = await installSandboxOrSkipOnRateLimit(
    host,
    env,
    redactions,
    `install-${agent}-channels-stop-start`,
    skip,
    "NVIDIA endpoint validation was rate-limited before channel lifecycle assertions ran",
  );
  expectExitZero(install, `${agent} install.sh`);
  await expectSandboxReady(
    host,
    sandboxName,
    env,
    redactions,
    `sandbox-list-${agent}-channels-stop-start`,
  );

  if (!planChannel(sandboxName, "whatsapp")) {
    await runChannelCommand(host, sandboxName, env, redactions, "add", "whatsapp");
    const rebuild = await rebuildSandbox(
      host,
      sandboxName,
      env,
      redactions,
      `rebuild-add-whatsapp-${agent}-channels-stop-start`,
    );
    expectExitZero(rebuild, "rebuild after adding WhatsApp");
  }

  expectChannelInputs(sandboxName);
  for (const channel of CHANNELS) expectPlanChannelState(sandboxName, agent, channel, "active");
  await expectAgentConfig(sandbox, agent, sandboxName, "present", redactions);
  await expectRawTokensAbsent(sandbox, sandboxName, tokens, redactions);
  await expectProviders(host, sandboxName, env, redactions, "present", "baseline");
  await expectPolicyPresets(host, sandboxName, env, redactions, "active");

  for (const channel of CHANNELS) {
    await runChannelCommand(host, sandboxName, env, redactions, "stop", channel);
  }
  expectChannelInputs(sandboxName);
  for (const channel of CHANNELS) expectPlanChannelState(sandboxName, agent, channel, "disabled");
  const stopRebuild = await rebuildSandbox(
    host,
    sandboxName,
    env,
    redactions,
    `rebuild-stop-all-${agent}-channels-stop-start`,
  );
  expectExitZero(stopRebuild, "rebuild after stopping all channels");
  await expectAgentConfig(sandbox, agent, sandboxName, "absent", redactions);
  await expectProviders(host, sandboxName, env, redactions, "present", "after-stop");
  for (const channel of CHANNELS) expectPlanChannelState(sandboxName, agent, channel, "disabled");
  await expectPolicyPresets(host, sandboxName, env, redactions, "inactive");

  for (const channel of CHANNELS) {
    await runChannelCommand(host, sandboxName, env, redactions, "start", channel);
  }
  expectChannelInputs(sandboxName);
  for (const channel of CHANNELS) expectPlanChannelState(sandboxName, agent, channel, "active");
  const startRebuild = await rebuildSandbox(
    host,
    sandboxName,
    env,
    redactions,
    `rebuild-start-all-${agent}-channels-stop-start`,
  );
  expectExitZero(startRebuild, "rebuild after starting all channels");
  await expectAgentConfig(sandbox, agent, sandboxName, "present", redactions);
  await expectProviders(host, sandboxName, env, redactions, "present", "after-start");
  for (const channel of CHANNELS) expectPlanChannelState(sandboxName, agent, channel, "active");
  await expectPolicyPresets(host, sandboxName, env, redactions, "active");

  if (agent === "hermes") {
    await expectHermesProtocolCredentialRewrite({
      cleanup,
      host,
      sandbox,
      sandboxName,
      env,
      tokens,
      redactions,
    });
  }
}
