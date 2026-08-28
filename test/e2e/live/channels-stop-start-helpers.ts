// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect } from "../fixtures/e2e-test.ts";
import {
  type OpenClawChannelConfigState,
  openClawChannelIsActive,
  openClawChannelIsInert,
  openClawChannelStateProbeScript,
} from "./channels-stop-start-config-state.ts";
import { startChannelsStopStartProgress } from "./channels-stop-start-progress.ts";
import { assertChannelsStopStartSandboxName } from "./channels-stop-start-safety.ts";
import { GOOGLECHAT_E2E_ACCESS_TOKEN } from "./channels-stop-start-googlechat-entry.ts";
import { expectGooglechatCredentialBoundary } from "./channels-stop-start-googlechat-proof.ts";
import {
  type AgentKind,
  runSecondaryCleanup as bestEffortPreclean,
  CLI,
  dockerInfo,
  expectExitZero,
  expectSandboxReady,
  installSandboxOrSkipOnRateLimit,
  phase6Env,
  precleanSandbox,
  REPO_ROOT,
  resultText,
  sandboxSh,
  shellQuote,
  stripAnsi,
  trackSandboxCleanup,
} from "./phase6-messaging-helpers.ts";
import { parsePolicyPresetState } from "./policy-list-state.ts";

const AGENT = (process.env.NEMOCLAW_CHANNELS_STOP_START_AGENT ??
  process.env.NEMOCLAW_AGENT ??
  "openclaw") as AgentKind;
if (AGENT !== "openclaw" && AGENT !== "hermes") {
  throw new Error(`NEMOCLAW_CHANNELS_STOP_START_AGENT must be openclaw or hermes, got ${AGENT}`);
}
const SANDBOX_NAME =
  process.env.NEMOCLAW_SANDBOX_NAME ??
  (AGENT === "openclaw" ? "e2e-oc-ch-cycle" : "e2e-hm-ch-cycle");
assertChannelsStopStartSandboxName(SANDBOX_NAME, AGENT);
const REGISTRY_FILE = path.join(process.env.HOME ?? os.homedir(), ".nemoclaw", "sandboxes.json");
const CHANNELS = [
  "telegram",
  "discord",
  "wechat",
  "slack",
  "whatsapp",
  "teams",
  "googlechat",
] as const;
const PROVIDERS: Record<string, (sandbox: string) => string[]> = {
  telegram: (sandbox) => [`${sandbox}-telegram-bridge`],
  discord: (sandbox) => [`${sandbox}-discord-bridge`],
  wechat: (sandbox) => [`${sandbox}-wechat-bridge`],
  slack: (sandbox) => [`${sandbox}-slack-bridge`, `${sandbox}-slack-app`],
  whatsapp: () => [],
  teams: (sandbox) => [`${sandbox}-teams-bridge`],
  googlechat: (sandbox) => [`${sandbox}-googlechat-bridge`],
};
// Channels that emit no credentialBinding, each for its own reason. Independent oracle —
// hardcoded on purpose, not derived from the manifest under test (that would be circular).
const CHANNELS_WITHOUT_CREDENTIAL_BINDING: Record<string, string> = {
  whatsapp: "in-sandbox pairing — no host credential",
  googlechat: "gateway bridge-refresh material — not a per-channel binding",
};
export const LIVE_TIMEOUT_MS = 80 * 60_000;

type ChannelState = "active" | "disabled";
type AgentConfigState = "active" | "inert";
type JsonRecord = Record<string, unknown>;
type Phase6Tokens = {
  telegram: string;
  discord: string;
  slackBot: string;
  slackApp: string;
  wechat: string;
  teams: string;
  googlechat: string;
  googlechatAccessToken: string;
};

function phase6Tokens(suffix: string): Phase6Tokens {
  return {
    telegram: process.env.TELEGRAM_BOT_TOKEN ?? `test-fake-telegram-token-${suffix}`,
    discord: process.env.DISCORD_BOT_TOKEN ?? `test-fake-discord-token-${suffix}`,
    slackBot: process.env.SLACK_BOT_TOKEN ?? `xoxb-fake-slack-token-${suffix}`,
    slackApp: process.env.SLACK_APP_TOKEN ?? `xapp-fake-slack-token-${suffix}`,
    wechat: process.env.WECHAT_BOT_TOKEN ?? `test-fake-wechat-token-${suffix}`,
    teams: process.env.MSTEAMS_APP_PASSWORD ?? `test-fake-teams-secret-${suffix}`,
    googlechat:
      process.env.GOOGLECHAT_SERVICE_ACCOUNT ??
      JSON.stringify({
        client_email: `e2e-fake-${suffix}@e2e-fake.iam.gserviceaccount.com`,
        private_key: "fake-e2e-not-a-real-private-key",
      }),
    googlechatAccessToken: GOOGLECHAT_E2E_ACCESS_TOKEN,
  };
}

function phase6TokenEnv(tokens: Phase6Tokens): NodeJS.ProcessEnv {
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
    WECHAT_ACCOUNT_ID: process.env.WECHAT_ACCOUNT_ID ?? `e2e-fake-account-${SANDBOX_NAME}`,
    WECHAT_BASE_URL: process.env.WECHAT_BASE_URL ?? "https://ilinkai.wechat.com",
    WECHAT_USER_ID: process.env.WECHAT_USER_ID ?? "wxid_e2e_operator",
    WECHAT_ALLOWED_IDS:
      process.env.WECHAT_ALLOWED_IDS ?? process.env.WECHAT_USER_ID ?? "wxid_e2e_operator",
    WHATSAPP_MODE: "bot",
    WHATSAPP_ALLOWED_IDS: process.env.WHATSAPP_ALLOWED_IDS ?? "15551234567,15557654321",
    MSTEAMS_APP_ID: process.env.MSTEAMS_APP_ID ?? "00000000-0000-0000-0000-000000000000",
    MSTEAMS_APP_PASSWORD: tokens.teams,
    MSTEAMS_TENANT_ID: process.env.MSTEAMS_TENANT_ID ?? "11111111-1111-1111-1111-111111111111",
    TEAMS_ALLOWED_USERS: process.env.TEAMS_ALLOWED_USERS ?? "22222222-2222-2222-2222-222222222222",
    MSTEAMS_PORT: process.env.MSTEAMS_PORT ?? "3978",
    TEAMS_REQUIRE_MENTION: process.env.TEAMS_REQUIRE_MENTION ?? "0",
  };
  if (tokens.telegram.includes("fake")) env.NEMOCLAW_SKIP_TELEGRAM_REACHABILITY = "1";
  if (
    /^(xoxb|xapp)-(fake|test)-/.test(tokens.slackBot) ||
    /^(xoxb|xapp)-(fake|test)-/.test(tokens.slackApp)
  ) {
    env.NEMOCLAW_SKIP_SLACK_AUTH_VALIDATION = "1";
  }
  // The initial production onboarding receives an environment with these values
  // stripped. A test-only composition entrypoint later grants the OpenClaw
  // audience capability, creates a fixed non-secret provider credential, and
  // adds the channel for either supported agent.
  env.GOOGLECHAT_SERVICE_ACCOUNT = tokens.googlechat;
  env.GOOGLECHAT_AUDIENCE =
    process.env.GOOGLECHAT_AUDIENCE ?? "https://e2e-fake.trycloudflare.com/googlechat";
  env.GOOGLECHAT_APP_PRINCIPAL = process.env.GOOGLECHAT_APP_PRINCIPAL ?? "123456789012345678901";
  env.GOOGLECHAT_ALLOWED_USERS =
    process.env.GOOGLECHAT_ALLOWED_USERS ??
    (AGENT === "openclaw" ? "users/1234567890" : "e2e-operator@example.com");
  env.GOOGLE_CHAT_PROJECT_ID = process.env.GOOGLE_CHAT_PROJECT_ID ?? "nemoclaw-e2e";
  env.GOOGLE_CHAT_SUBSCRIPTION_NAME =
    process.env.GOOGLE_CHAT_SUBSCRIPTION_NAME ?? "projects/nemoclaw-e2e/subscriptions/hermes-chat";
  return env;
}

const GOOGLECHAT_ONBOARD_ENV_KEYS = [
  "GOOGLECHAT_SERVICE_ACCOUNT",
  "GOOGLECHAT_AUDIENCE_TYPE",
  "GOOGLECHAT_AUDIENCE",
  "GOOGLECHAT_APP_PRINCIPAL",
  "GOOGLECHAT_ALLOWED_USERS",
  "GOOGLE_CHAT_PROJECT_ID",
  "GOOGLE_CHAT_SUBSCRIPTION_NAME",
] as const;

function withoutGooglechatOnboardInputs(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const onboardingEnv = { ...env };
  for (const key of GOOGLECHAT_ONBOARD_ENV_KEYS) delete onboardingEnv[key];
  return onboardingEnv;
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
  return record;
}

function planChannel(channelId: string) {
  return arrayRecords(messagingPlan(SANDBOX_NAME).channels).find(
    (channel) => channel.channelId === channelId,
  );
}

function expectPlanChannelState(channelId: string, expected: ChannelState): void {
  const plan = messagingPlan(SANDBOX_NAME);
  const channels = arrayRecords(plan.channels);
  const channel = channels.find((entry) => entry.channelId === channelId);
  expect(channel, `${channelId} missing from messaging.plan.channels`).toBeTruthy();
  expect(channel?.configured, `${channelId} configured`).toBe(true);
  expect(plan.sandboxName, "messaging.plan.sandboxName").toBe(SANDBOX_NAME);
  expect(plan.agent, "messaging.plan.agent").toBe(AGENT);

  const disabledChannels = stringArray(plan.disabledChannels);
  if (expected === "active") {
    expect(channel?.active, `${channelId} active`).toBe(true);
    expect(channel?.disabled, `${channelId} disabled unexpectedly`).not.toBe(true);
    expect(disabledChannels, `${channelId} unexpectedly disabled`).not.toContain(channelId);
  } else {
    expect(channel?.disabled, `${channelId} disabled`).toBe(true);
    expect(channel?.active, `${channelId} active unexpectedly`).not.toBe(true);
    expect(disabledChannels, `${channelId} missing from disabledChannels`).toContain(channelId);
  }

  const networkPolicy =
    plan.networkPolicy && typeof plan.networkPolicy === "object"
      ? (plan.networkPolicy as Record<string, unknown>)
      : {};
  expect(stringArray(networkPolicy.presets), `${channelId} policy preset`).toContain(channelId);
  expect(
    arrayRecords(networkPolicy.entries).some((entry) => entry.channelId === channelId),
    `${channelId} policy entry`,
  ).toBe(true);
  const credentialBindings = arrayRecords(plan.credentialBindings);
  if (!Object.hasOwn(CHANNELS_WITHOUT_CREDENTIAL_BINDING, channelId)) {
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

function expectPlanChannelRemoved(channelId: string): void {
  const plan = messagingPlan(SANDBOX_NAME);
  expect(
    arrayRecords(plan.channels).some((channel) => channel.channelId === channelId),
    `${channelId} remained in messaging.plan.channels`,
  ).toBe(false);
  expect(stringArray(plan.disabledChannels), `${channelId} remained disabled`).not.toContain(
    channelId,
  );
  const networkPolicy =
    plan.networkPolicy && typeof plan.networkPolicy === "object"
      ? (plan.networkPolicy as Record<string, unknown>)
      : {};
  expect(stringArray(networkPolicy.presets), `${channelId} policy preset remained`).not.toContain(
    channelId,
  );
  expect(
    arrayRecords(networkPolicy.entries).some((entry) => entry.channelId === channelId),
    `${channelId} policy entry remained`,
  ).toBe(false);
  expect(
    arrayRecords(plan.credentialBindings).some((entry) => entry.channelId === channelId),
    `${channelId} credential binding remained`,
  ).toBe(false);
}

function requireEnvValue(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`${key} must be configured for the channels stop/start target`);
  return value;
}

function expectChannelInputs(env: NodeJS.ProcessEnv): void {
  const expected: Record<string, Record<string, string>> = {
    telegram: {
      allowedIds: requireEnvValue(env, "TELEGRAM_ALLOWED_IDS"),
      requireMention: requireEnvValue(env, "TELEGRAM_REQUIRE_MENTION"),
    },
    discord: {
      serverId: requireEnvValue(env, "DISCORD_SERVER_ID"),
      userId: requireEnvValue(env, "DISCORD_USER_ID"),
      requireMention: requireEnvValue(env, "DISCORD_REQUIRE_MENTION"),
    },
    slack: { allowedUsers: requireEnvValue(env, "SLACK_ALLOWED_USERS") },
    wechat: {
      allowedIds: requireEnvValue(env, "WECHAT_ALLOWED_IDS"),
    },
    whatsapp: {
      mode: requireEnvValue(env, "WHATSAPP_MODE"),
      allowedIds: requireEnvValue(env, "WHATSAPP_ALLOWED_IDS"),
    },
    teams: {
      appId: requireEnvValue(env, "MSTEAMS_APP_ID"),
      tenantId: requireEnvValue(env, "MSTEAMS_TENANT_ID"),
      allowedUsers: requireEnvValue(env, "TEAMS_ALLOWED_USERS"),
      webhookPort: requireEnvValue(env, "MSTEAMS_PORT"),
      requireMention: requireEnvValue(env, "TEAMS_REQUIRE_MENTION"),
    },
  };
  expected.googlechat =
    AGENT === "openclaw"
      ? {
          appPrincipal: requireEnvValue(env, "GOOGLECHAT_APP_PRINCIPAL"),
          allowFrom: requireEnvValue(env, "GOOGLECHAT_ALLOWED_USERS"),
        }
      : {
          projectId: requireEnvValue(env, "GOOGLE_CHAT_PROJECT_ID"),
          subscriptionName: requireEnvValue(env, "GOOGLE_CHAT_SUBSCRIPTION_NAME"),
          allowFrom: requireEnvValue(env, "GOOGLECHAT_ALLOWED_USERS"),
        };
  for (const [channelId, inputs] of Object.entries(expected)) {
    const channel = planChannel(channelId);
    const planInputs = arrayRecords(channel?.inputs);
    for (const [inputId, value] of Object.entries(inputs)) {
      expect(
        planInputs.find((input) => input.inputId === inputId)?.value,
        `${channelId}.${inputId}`,
      ).toBe(value);
    }
  }
}

async function readOpenClawChannelState(
  sandbox: import("../fixtures/clients/sandbox.ts").SandboxClient,
  channel: string,
  context: string,
  redactions: string[],
): Promise<OpenClawChannelConfigState> {
  const script = openClawChannelStateProbeScript(channel);
  const result = await sandboxSh(sandbox, SANDBOX_NAME, `python3 -c ${shellQuote(script)}`, {
    artifactName: `config-channel-${AGENT}-${channel}-${context}`,
    redactionValues: redactions,
  });
  expectExitZero(result, `read OpenClaw channel ${channel} ${context}`);
  return JSON.parse(result.stdout.trim()) as OpenClawChannelConfigState;
}

async function hermesChannelIsActive(
  sandbox: import("../fixtures/clients/sandbox.ts").SandboxClient,
  channel: string,
  context: string,
  redactions: string[],
): Promise<boolean> {
  const probes: Record<string, string> = {
    // Telegram and Discord render no token line, for the same reason as Slack
    // below: OpenShell injects the revision-scoped placeholder into the process
    // environment, and a rendered line would shadow it. The allowlist line is
    // what proves the channel still renders.
    //
    // The negative checks match `export KEY=` as well as `KEY=`, because this
    // file can carry either form and a missed negative passes silently. The
    // positive checks are left anchored: a missed positive fails loudly.
    telegram:
      'grep -Eq "^TELEGRAM_ALLOWED_USERS=.+$" /sandbox/.hermes/.env && ! grep -qE "^[[:space:]]*(export[[:space:]]+)?TELEGRAM_BOT_TOKEN=" /sandbox/.hermes/.env',
    discord:
      'grep -Eq "^DISCORD_ALLOWED_USERS=.+$" /sandbox/.hermes/.env && ! grep -qE "^[[:space:]]*(export[[:space:]]+)?DISCORD_BOT_TOKEN=" /sandbox/.hermes/.env',
    wechat:
      'grep -Eq "^WEIXIN_TOKEN=openshell:resolve:env:WECHAT_BOT_TOKEN$" /sandbox/.hermes/.env',
    // Slack renders no token line: OpenShell binds SLACK_* to the policy
    // endpoint and injects revision-scoped placeholders, and Hermes loads .env
    // with override=True, so a rendered line would shadow them. The allowlist
    // line is what proves the channel still renders.
    slack:
      'grep -Eq "^SLACK_ALLOWED_USERS=.+$" /sandbox/.hermes/.env && ! grep -qE "^[[:space:]]*(export[[:space:]]+)?SLACK_(BOT|APP)_TOKEN=" /sandbox/.hermes/.env',
    // The DM policy is derived from the mode and the allowlist rather than
    // supplied, so the live sealed .env is where that derivation is proven.
    whatsapp:
      'grep -Eq "^WHATSAPP_ENABLED=true$" /sandbox/.hermes/.env && grep -Eq "^WHATSAPP_MODE=bot$" /sandbox/.hermes/.env && grep -Eq "^WHATSAPP_DM_POLICY=allowlist$" /sandbox/.hermes/.env && grep -Eq "^WHATSAPP_ALLOWED_USERS=.+$" /sandbox/.hermes/.env',
    teams:
      'grep -Eq "^TEAMS_CLIENT_SECRET=openshell:resolve:env:MSTEAMS_APP_PASSWORD$" /sandbox/.hermes/.env',
    // The access token exists only in the live process environment. A rendered
    // line would shadow the revision-scoped placeholder OpenShell injects.
    googlechat:
      'grep -Eq "^GOOGLE_CHAT_PROJECT_ID=.+$" /sandbox/.hermes/.env && grep -Eq "^GOOGLE_CHAT_SUBSCRIPTION_NAME=projects/[^/]+/subscriptions/[^/]+$" /sandbox/.hermes/.env && grep -Eq "^GOOGLE_CHAT_ALLOWED_USERS=.+$" /sandbox/.hermes/.env && ! grep -qE "^[[:space:]]*(export[[:space:]]+)?GOOGLE_CHAT_ACCESS_TOKEN=" /sandbox/.hermes/.env',
  };
  const result = await sandboxSh(
    sandbox,
    SANDBOX_NAME,
    `if [ -r /sandbox/.hermes/.env ] && ${probes[channel]}; then echo yes; else echo no; fi`,
    {
      artifactName: `config-channel-${AGENT}-${channel}-${context}`,
      redactionValues: redactions,
    },
  );
  expectExitZero(result, `read Hermes channel ${channel} ${context}`);
  return result.stdout.trim() === "yes";
}

async function expectAgentConfig(
  sandbox: import("../fixtures/clients/sandbox.ts").SandboxClient,
  expected: AgentConfigState,
  context: string,
  redactions: string[],
): Promise<void> {
  for (const channel of CHANNELS) {
    if (AGENT === "openclaw") {
      const state = await readOpenClawChannelState(sandbox, channel, context, redactions);
      const matches =
        expected === "active" ? openClawChannelIsActive(state) : openClawChannelIsInert(state);
      expect(
        matches,
        `${AGENT}/${channel} config ${expected}; state=${JSON.stringify(state)}`,
      ).toBe(true);
      continue;
    }

    const active = await hermesChannelIsActive(sandbox, channel, context, redactions);
    expect(active, `${AGENT}/${channel} config ${expected}`).toBe(expected === "active");
  }
}

async function expectProvidersExist(
  host: import("../fixtures/clients/host.ts").HostCliClient,
  env: NodeJS.ProcessEnv,
  redactions: string[],
  context: string,
): Promise<void> {
  for (const channel of CHANNELS) {
    for (const provider of PROVIDERS[channel](SANDBOX_NAME)) {
      const result = await host.command("openshell", ["provider", "get", provider], {
        artifactName: `provider-${provider}-${context}`,
        env,
        redactionValues: redactions,
        timeoutMs: 60_000,
      });
      expectExitZero(result, `${provider} exists ${context}`);
    }
  }
}

async function expectChannelProvidersAbsent(
  host: import("../fixtures/clients/host.ts").HostCliClient,
  env: NodeJS.ProcessEnv,
  redactions: string[],
  channel: string,
  context: string,
): Promise<void> {
  for (const provider of PROVIDERS[channel](SANDBOX_NAME)) {
    const result = await host.command("openshell", ["provider", "get", provider], {
      artifactName: `provider-${provider}-${context}`,
      env,
      redactionValues: redactions,
      timeoutMs: 60_000,
    });
    expect(result.exitCode, `${provider} absent ${context}\n${resultText(result)}`).not.toBe(0);
    expect(
      /not found|does not exist|no provider|unknown provider/i.test(stripAnsi(resultText(result))),
      `${provider} absence check failed for an unexpected reason ${context}\n${resultText(result)}`,
    ).toBe(true);
  }
}

async function precleanProviders(
  host: import("../fixtures/clients/host.ts").HostCliClient,
  env: NodeJS.ProcessEnv,
  redactions: string[],
  context: string,
): Promise<void> {
  for (const channel of CHANNELS) {
    for (const provider of PROVIDERS[channel](SANDBOX_NAME)) {
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

async function precleanNemoclawGateway(
  host: import("../fixtures/clients/host.ts").HostCliClient,
  env: NodeJS.ProcessEnv,
  redactions: string[],
  artifactName: string,
): Promise<void> {
  await bestEffortPreclean(() =>
    host.command("openshell", ["gateway", "destroy", "-g", "nemoclaw"], {
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

async function addGooglechatForLiveE2e(
  host: import("../fixtures/clients/host.ts").HostCliClient,
  env: NodeJS.ProcessEnv,
  redactions: string[],
): Promise<void> {
  const entrypoint = path.join(REPO_ROOT, "test/e2e/live/channels-stop-start-googlechat-entry.ts");
  const tsx = path.join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs");
  const addAndRebuild = await host.command("node", [tsx, entrypoint, SANDBOX_NAME], {
    artifactName: "channels-stop-start-add-and-rebuild-googlechat-live-e2e",
    env,
    redactionValues: redactions,
    timeoutMs: 10 * 60_000,
  });
  expectExitZero(
    addAndRebuild,
    "add and rebuild Google Chat through live-E2E capability composition",
  );
  await expectSandboxReady(
    host,
    SANDBOX_NAME,
    env,
    redactions,
    "sandbox-list-after-googlechat-live-e2e-add",
  );
}

async function rebuildWithGooglechatFixtureForLiveE2e(
  host: import("../fixtures/clients/host.ts").HostCliClient,
  env: NodeJS.ProcessEnv,
  redactions: string[],
) {
  const entrypoint = path.join(REPO_ROOT, "test/e2e/live/channels-stop-start-googlechat-entry.ts");
  const tsx = path.join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs");
  return host.command("node", [tsx, entrypoint, SANDBOX_NAME, "--rebuild-only"], {
    artifactName: `rebuild-start-all-${AGENT}`,
    env,
    redactionValues: redactions,
    timeoutMs: 30 * 60_000,
  });
}

async function policyPresetState(
  host: import("../fixtures/clients/host.ts").HostCliClient,
  env: NodeJS.ProcessEnv,
  redactions: string[],
  channel: string,
  context: string,
): Promise<ReturnType<typeof parsePolicyPresetState>> {
  const result = await host.command(
    "node",
    [process.env.NEMOCLAW_CLI_BIN ?? "bin/nemoclaw.js", SANDBOX_NAME, "policy-list"],
    {
      artifactName: `policy-list-${channel}-${AGENT}-${context}`,
      env,
      redactionValues: redactions,
      timeoutMs: 60_000,
    },
  );
  expectExitZero(result, `policy-list ${channel} ${context}`);
  return parsePolicyPresetState(resultText(result), channel);
}

async function runChannelCommand(
  host: import("../fixtures/clients/host.ts").HostCliClient,
  env: NodeJS.ProcessEnv,
  redactions: string[],
  action: "stop" | "start",
  channel: string,
): Promise<void> {
  const result = await host.command(
    "node",
    [process.env.NEMOCLAW_CLI_BIN ?? "bin/nemoclaw.js", SANDBOX_NAME, "channels", action, channel],
    {
      artifactName: `channels-${action}-${channel}-${AGENT}`,
      env,
      redactionValues: redactions,
      timeoutMs: 10 * 60_000,
    },
  );
  expectExitZero(result, `channels ${action} ${channel}`);
  const expectedText = `Marked ${channel} ${action === "stop" ? "disabled" : "enabled"}`;
  expect(resultText(result)).toContain(expectedText);
  expect(resultText(result)).toContain(
    `Change queued. Run 'nemoclaw ${SANDBOX_NAME} rebuild' to apply`,
  );
}

async function removeGooglechatAndRebuild(
  host: import("../fixtures/clients/host.ts").HostCliClient,
  env: NodeJS.ProcessEnv,
  redactions: string[],
): Promise<void> {
  const remove = await host.command(
    "node",
    [
      process.env.NEMOCLAW_CLI_BIN ?? "bin/nemoclaw.js",
      SANDBOX_NAME,
      "channels",
      "remove",
      "googlechat",
    ],
    {
      artifactName: `channels-remove-googlechat-${AGENT}`,
      env,
      redactionValues: redactions,
      timeoutMs: 10 * 60_000,
    },
  );
  expectExitZero(remove, "channels remove googlechat");
  expect(resultText(remove)).toContain("Removed googlechat");
  expectPlanChannelRemoved("googlechat");

  const rebuild = await rebuildSandbox(
    host,
    SANDBOX_NAME,
    env,
    redactions,
    `rebuild-remove-googlechat-${AGENT}`,
  );
  expectExitZero(rebuild, "rebuild after removing Google Chat");
  await expectSandboxReady(
    host,
    SANDBOX_NAME,
    env,
    redactions,
    `sandbox-list-after-googlechat-remove-${AGENT}`,
  );
}

export const CHANNELS_STOP_START_TEST_NAME = `${AGENT} channels stop/start preserves credentials and validates runtime config lifecycle`;

export async function runChannelsStopStartTarget({
  artifacts,
  cleanup,
  host,
  progress,
  sandbox,
  secrets,
  skip,
}: import("../fixtures/e2e-test.ts").E2ETargetFixtures & {
  skip: (note?: string) => never;
}): Promise<void> {
  const apiKey = secrets.required("NVIDIA_INFERENCE_API_KEY");
  const tokens = phase6Tokens(AGENT);
  const env = phase6Env({
    sandboxName: SANDBOX_NAME,
    agent: AGENT,
    apiKey,
    extra: phase6TokenEnv(tokens),
  });
  const redactions = redactionValues(apiKey, tokens);

  await artifacts.target.declare({
    id: "channels-stop-start",
    boundary:
      "messaging onboard + channel lifecycle + Google Chat provider cleanup + revision-scoped outbound credential rewrite + installed Hermes pull/ack",
    agent: AGENT,
    sandboxName: SANDBOX_NAME,
    channels: CHANNELS,
  });

  const heartbeat = startChannelsStopStartProgress(AGENT);
  cleanup.trackDisposable("stop channels stop/start heartbeat", heartbeat.stop);

  cleanup.trackGateway(host, "nemoclaw", {
    artifactName: `cleanup-openshell-gateway-destroy-${AGENT}`,
    env,
    redactionValues: redactions,
    timeoutMs: 60_000,
  });
  trackSandboxCleanup(
    cleanup,
    host,
    sandbox,
    SANDBOX_NAME,
    env,
    redactions,
    `cleanup-channels-stop-start-${AGENT}`,
  );
  await precleanSandbox(
    host,
    SANDBOX_NAME,
    env,
    redactions,
    `preclean-channels-stop-start-${AGENT}`,
  );
  await precleanNemoclawGateway(
    host,
    env,
    redactions,
    `preclean-openshell-gateway-destroy-${AGENT}`,
  );
  await precleanProviders(host, env, redactions, `preclean-channels-stop-start-${AGENT}`);

  const docker = await dockerInfo(host, env);
  expect(docker.exitCode, resultText(docker)).toBe(0);
  progress.phase("onboard sandbox with all messaging channels");
  const onboardingEnv = withoutGooglechatOnboardInputs(env);
  const install = await installSandboxOrSkipOnRateLimit(
    host,
    onboardingEnv,
    redactions,
    `install-channels-stop-start-${AGENT}`,
    skip,
    "NVIDIA endpoint validation was rate-limited before channel lifecycle assertions ran",
  );
  expectExitZero(install, `${AGENT} install.sh`);
  await expectSandboxReady(
    host,
    SANDBOX_NAME,
    env,
    redactions,
    `sandbox-list-channels-stop-start-${AGENT}`,
  );
  await addGooglechatForLiveE2e(host, env, redactions);

  progress.phase("validate active channel integrations");
  expectChannelInputs(env);
  for (const channel of CHANNELS) expectPlanChannelState(channel, "active");
  await expectAgentConfig(sandbox, "active", "baseline", redactions);
  await expectGooglechatCredentialBoundary(sandbox, SANDBOX_NAME, AGENT, "baseline", redactions);
  await expectProvidersExist(host, env, redactions, "baseline");
  for (const channel of CHANNELS) {
    expect(
      await policyPresetState(host, env, redactions, channel, "baseline"),
      `${channel} policy active`,
    ).toBe("active");
  }

  progress.phase("disable channels and rebuild sandbox");
  for (const channel of CHANNELS) await runChannelCommand(host, env, redactions, "stop", channel);
  expectChannelInputs(env);
  for (const channel of CHANNELS) expectPlanChannelState(channel, "disabled");
  const stopRebuild = await rebuildSandbox(
    host,
    SANDBOX_NAME,
    env,
    redactions,
    `rebuild-stop-all-${AGENT}`,
  );
  expectExitZero(stopRebuild, "rebuild after stopping all channels");
  expectChannelInputs(env);
  await expectAgentConfig(sandbox, "inert", "after-stop", redactions);
  await expectProvidersExist(host, env, redactions, "after-stop");
  for (const channel of CHANNELS) expectPlanChannelState(channel, "disabled");
  for (const channel of CHANNELS) {
    expect(
      await policyPresetState(host, env, redactions, channel, "after-stop"),
      `${channel} policy inactive after stop+rebuild`,
    ).toBe("inactive");
  }

  progress.phase("re-enable channels, rebuild sandbox, and validate lifecycle state");
  for (const channel of CHANNELS) await runChannelCommand(host, env, redactions, "start", channel);
  expectChannelInputs(env);
  for (const channel of CHANNELS) expectPlanChannelState(channel, "active");
  const startRebuild = await rebuildWithGooglechatFixtureForLiveE2e(host, env, redactions);
  expectExitZero(startRebuild, "rebuild after starting all channels");
  expectChannelInputs(env);
  await expectAgentConfig(sandbox, "active", "after-start", redactions);
  await expectGooglechatCredentialBoundary(sandbox, SANDBOX_NAME, AGENT, "after-start", redactions);
  await expectProvidersExist(host, env, redactions, "after-start");
  for (const channel of CHANNELS) expectPlanChannelState(channel, "active");
  for (const channel of CHANNELS) {
    expect(
      await policyPresetState(host, env, redactions, channel, "after-start"),
      `${channel} policy active after start+rebuild`,
    ).toBe("active");
  }

  progress.phase("remove Google Chat and validate provider cleanup");
  await removeGooglechatAndRebuild(host, env, redactions);
  expectPlanChannelRemoved("googlechat");
  await expectChannelProvidersAbsent(host, env, redactions, "googlechat", "after-remove");
  expect(
    await policyPresetState(host, env, redactions, "googlechat", "after-remove"),
    "Google Chat policy inactive after removal",
  ).toBe("inactive");
  if (AGENT === "openclaw") {
    const state = await readOpenClawChannelState(sandbox, "googlechat", "after-remove", redactions);
    expect(openClawChannelIsInert(state), "OpenClaw Google Chat config removed").toBe(true);
  } else {
    // Assert absence directly. The active probe already carries a negative
    // GOOGLE_CHAT_ACCESS_TOKEN conjunct, so inverting it would report success
    // for exactly the leftover token line this step must catch.
    const removed = await sandboxSh(
      sandbox,
      SANDBOX_NAME,
      'if [ ! -r /sandbox/.hermes/.env ] || ! grep -qE "^[[:space:]]*(export[[:space:]]+)?GOOGLE_CHAT_" /sandbox/.hermes/.env; then echo yes; else echo no; fi',
      {
        artifactName: `config-channel-${AGENT}-googlechat-after-remove-absent`,
        redactionValues: redactions,
      },
    );
    expectExitZero(removed, "read Hermes googlechat after-remove");
    expect(removed.stdout.trim(), "Hermes Google Chat config removed").toBe("yes");
  }
}
