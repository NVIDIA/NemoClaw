// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import type {
  ChannelAuthMode,
  MessagingAgentId,
  MessagingChannelId,
  MessagingCompilerWorkflow,
  SandboxMessagingCredentialBindingPlan,
  SandboxMessagingPlan,
} from "../../src/lib/messaging";

type DockerfilePlanChannel = {
  channelId?: unknown;
  active?: unknown;
};

type DockerfilePlan = {
  channels?: DockerfilePlanChannel[];
};

export interface TestMessagingPlanOptions {
  readonly sandboxName?: string;
  readonly channels?: readonly MessagingChannelId[];
  readonly disabledChannels?: readonly MessagingChannelId[];
  readonly agent?: MessagingAgentId;
  readonly workflow?: MessagingCompilerWorkflow;
  readonly authMode?: ChannelAuthMode;
  readonly credentialBindings?: readonly SandboxMessagingCredentialBindingPlan[];
}

export function makeMessagingPlan(options: TestMessagingPlanOptions = {}): SandboxMessagingPlan {
  const {
    sandboxName = "my-assistant",
    channels = [],
    disabledChannels = [],
    agent = "openclaw",
    workflow = "onboard",
    authMode,
    credentialBindings = [],
  } = options;
  const disabled = new Set(disabledChannels);
  return {
    schemaVersion: 1,
    sandboxName,
    agent,
    workflow,
    channels: channels.map((channelId) => ({
      channelId,
      displayName: channelId,
      authMode: authMode ?? (channelId === "whatsapp" ? "in-sandbox-qr" : "token-paste"),
      active: !disabled.has(channelId),
      selected: true,
      configured: true,
      disabled: disabled.has(channelId),
      inputs: [],
      hooks: [],
    })),
    disabledChannels: [...disabledChannels],
    credentialBindings: credentialBindings.map((binding) => ({ ...binding })),
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };
}

export function encodeMessagingPlan(plan: SandboxMessagingPlan): string {
  return Buffer.from(JSON.stringify(plan), "utf8").toString("base64");
}

const CREDENTIAL_BINDINGS: Record<string, readonly SandboxMessagingCredentialBindingPlan[]> = {
  discord: [
    {
      channelId: "discord",
      credentialId: "discordBotToken",
      sourceInput: "botToken",
      providerName: "my-assistant-discord-bridge",
      providerEnvKey: "DISCORD_BOT_TOKEN",
      placeholder: "openshell:resolve:env:DISCORD_BOT_TOKEN",
      credentialAvailable: true,
      credentialHash: "discord-bot-token-hash",
    },
  ],
  slack: [
    {
      channelId: "slack",
      credentialId: "slackBotToken",
      sourceInput: "botToken",
      providerName: "my-assistant-slack-bridge",
      providerEnvKey: "SLACK_BOT_TOKEN",
      placeholder: "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
      credentialAvailable: true,
      credentialHash: "slack-bot-token-hash",
    },
    {
      channelId: "slack",
      credentialId: "slackAppToken",
      sourceInput: "appToken",
      providerName: "my-assistant-slack-app",
      providerEnvKey: "SLACK_APP_TOKEN",
      placeholder: "xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN",
      credentialAvailable: true,
      credentialHash: "slack-app-token-hash",
    },
  ],
  telegram: [
    {
      channelId: "telegram",
      credentialId: "telegramBotToken",
      sourceInput: "botToken",
      providerName: "my-assistant-telegram-bridge",
      providerEnvKey: "TELEGRAM_BOT_TOKEN",
      placeholder: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
      credentialAvailable: true,
      credentialHash: "telegram-bot-token-hash",
    },
  ],
};

export function encodeMessagingPlanForChannels(
  channels: readonly MessagingChannelId[],
  disabledChannels: readonly MessagingChannelId[] = [],
): string {
  return encodeMessagingPlan(makeMessagingPlan({ channels, disabledChannels, authMode: "none" }));
}

export function messagingPlanLiteral(
  channels: readonly MessagingChannelId[],
  disabledChannels: readonly MessagingChannelId[] = [],
): string {
  return JSON.stringify(
    makeMessagingPlan({
      channels,
      disabledChannels,
      credentialBindings: channels.flatMap((channelId) => CREDENTIAL_BINDINGS[channelId] ?? []),
    }),
  );
}

export function parseMessagingFixturePayload<T = Record<string, any>>(stdout: string): T {
  const line = stdout
    .trim()
    .split("\n")
    .reverse()
    .find((value) => /^[{[]/.test(value) && /[}\]]$/.test(value));
  assert.ok(line, `expected JSON payload in stdout:\n${stdout}`);
  return JSON.parse(line);
}

export function writeCustomMessagingDockerfile(directory: string): string {
  const dockerfilePath = path.join(directory, "Dockerfile");
  fs.writeFileSync(
    dockerfilePath,
    [
      "FROM scratch",
      "ARG NEMOCLAW_MESSAGING_PLAN_B64=",
      "ARG NEMOCLAW_TOOL_DISCLOSURE=progressive",
      "ENV NEMOCLAW_TOOL_DISCLOSURE=${NEMOCLAW_TOOL_DISCLOSURE}",
    ].join("\n"),
  );
  return dockerfilePath;
}

function readMessagingPlanFromDockerfile(dockerfileContent: string | undefined): DockerfilePlan {
  assert.ok(dockerfileContent, "expected Dockerfile content");
  const prefix = "ARG NEMOCLAW_MESSAGING_PLAN_B64=";
  const line = dockerfileContent.split("\n").find((entry) => entry.startsWith(prefix));
  assert.ok(line, "expected messaging plan build arg in Dockerfile");
  return JSON.parse(Buffer.from(line.slice(prefix.length), "base64").toString("utf8"));
}

export function activeChannelsFromDockerfile(dockerfileContent: string | undefined): string[] {
  const plan = readMessagingPlanFromDockerfile(dockerfileContent);
  return (plan.channels ?? [])
    .filter((channel) => channel.active === true && typeof channel.channelId === "string")
    .map((channel) => String(channel.channelId))
    .sort();
}
