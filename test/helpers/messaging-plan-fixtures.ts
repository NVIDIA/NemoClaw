// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";

type MessagingPlanChannel = {
  channelId?: unknown;
  active?: unknown;
};

type MessagingPlan = {
  channels?: MessagingPlanChannel[];
};

export const inlineMessagingPlanHelper = String.raw`
function makeMessagingPlan(channelIds, disabledChannels = []) {
  const disabled = new Set(disabledChannels);
  const credentialBindings = {
    discord: [{ channelId: "discord", credentialId: "discordBotToken", sourceInput: "botToken", providerName: "my-assistant-discord-bridge", providerEnvKey: "DISCORD_BOT_TOKEN", placeholder: "openshell:resolve:env:DISCORD_BOT_TOKEN", credentialAvailable: true, credentialHash: "discord-bot-token-hash" }],
    slack: [
      { channelId: "slack", credentialId: "slackBotToken", sourceInput: "botToken", providerName: "my-assistant-slack-bridge", providerEnvKey: "SLACK_BOT_TOKEN", placeholder: "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN", credentialAvailable: true, credentialHash: "slack-bot-token-hash" },
      { channelId: "slack", credentialId: "slackAppToken", sourceInput: "appToken", providerName: "my-assistant-slack-app", providerEnvKey: "SLACK_APP_TOKEN", placeholder: "xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN", credentialAvailable: true, credentialHash: "slack-app-token-hash" },
    ],
    telegram: [{ channelId: "telegram", credentialId: "telegramBotToken", sourceInput: "botToken", providerName: "my-assistant-telegram-bridge", providerEnvKey: "TELEGRAM_BOT_TOKEN", placeholder: "openshell:resolve:env:TELEGRAM_BOT_TOKEN", credentialAvailable: true, credentialHash: "telegram-bot-token-hash" }],
  };
  return { schemaVersion: 1, sandboxName: "my-assistant", agent: "openclaw", workflow: "onboard", channels: channelIds.map((channelId) => ({ channelId, displayName: channelId, authMode: channelId === "whatsapp" ? "in-sandbox-qr" : "token-paste", active: !disabled.has(channelId), selected: true, configured: true, disabled: disabled.has(channelId), inputs: [], hooks: [] })), disabledChannels, credentialBindings: channelIds.flatMap((channelId) => credentialBindings[channelId] || []), networkPolicy: { presets: [], entries: [] }, agentRender: [], buildSteps: [], stateUpdates: [], healthChecks: [] };
}
`.trim();

function readMessagingPlanFromDockerfile(dockerfileContent: string | undefined): MessagingPlan {
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

export function encodeTestMessagingPlan(
  channels: ReadonlyArray<{ readonly channelId: string; readonly active: boolean }>,
): string {
  const plan = {
    schemaVersion: 1,
    sandboxName: "my-assistant",
    agent: "openclaw",
    workflow: "onboard",
    channels: channels.map(({ channelId, active }) => ({
      channelId,
      displayName: channelId,
      authMode: "none",
      active,
      selected: true,
      configured: true,
      disabled: !active,
      inputs: [],
      hooks: [],
    })),
    disabledChannels: channels
      .filter((channel) => !channel.active)
      .map((channel) => channel.channelId),
    credentialBindings: [],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };
  return Buffer.from(JSON.stringify(plan), "utf8").toString("base64");
}
