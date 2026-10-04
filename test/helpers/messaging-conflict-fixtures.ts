// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxMessagingPlan } from "../../src/lib/messaging/manifest";
import type { SandboxMessagingState } from "../../src/lib/state/registry";
import type { ConflictRegistryEntry } from "../../src/lib/messaging/applier/conflict-detection";

export function makePlan(
  sandboxName: string,
  overrides: Partial<SandboxMessagingPlan> = {},
): SandboxMessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName,
    agent: "openclaw",
    workflow: "onboard",
    channels: [],
    disabledChannels: [],
    credentialBindings: [],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
    ...overrides,
  };
}

export function tgChannel(active = true, disabled = false) {
  return {
    channelId: "telegram" as const,
    displayName: "Telegram",
    authMode: "token-paste" as const,
    active,
    selected: true,
    configured: true,
    disabled,
    inputs: [],
    hooks: [],
  };
}

export function slackChannel() {
  return {
    channelId: "slack" as const,
    displayName: "Slack",
    authMode: "token-paste" as const,
    active: true,
    selected: true,
    configured: true,
    disabled: false,
    inputs: [],
    hooks: [],
  };
}

export function discordChannel() {
  return {
    channelId: "discord" as const,
    displayName: "Discord",
    authMode: "token-paste" as const,
    active: true,
    selected: true,
    configured: true,
    disabled: false,
    inputs: [],
    hooks: [],
  };
}

export function whatsappChannel() {
  return {
    channelId: "whatsapp" as const,
    displayName: "WhatsApp",
    authMode: "in-sandbox-qr" as const,
    active: true,
    selected: true,
    configured: true,
    disabled: false,
    inputs: [],
    hooks: [],
  };
}

export function tgBinding(hash?: string): SandboxMessagingPlan["credentialBindings"][number] {
  return {
    channelId: "telegram",
    credentialId: "telegramBotToken",
    sourceInput: "botToken",
    providerName: "sb-telegram-bridge",
    providerEnvKey: "TELEGRAM_BOT_TOKEN",
    placeholder: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
    credentialAvailable: true,
    ...(hash !== undefined ? { credentialHash: hash } : {}),
  };
}

export function discordBinding(hash?: string): SandboxMessagingPlan["credentialBindings"][number] {
  return {
    channelId: "discord",
    credentialId: "discordBotToken",
    sourceInput: "botToken",
    providerName: "sb-discord-bridge",
    providerEnvKey: "DISCORD_BOT_TOKEN",
    placeholder: "openshell:resolve:env:DISCORD_BOT_TOKEN",
    credentialAvailable: true,
    ...(hash !== undefined ? { credentialHash: hash } : {}),
  };
}

export function slackBotBinding(
  hash?: string,
  sandboxName = "sb",
): SandboxMessagingPlan["credentialBindings"][number] {
  return {
    channelId: "slack",
    credentialId: "slackBotToken",
    sourceInput: "botToken",
    providerName: `${sandboxName}-slack-bridge`,
    providerEnvKey: "SLACK_BOT_TOKEN",
    placeholder: "openshell:resolve:env:SLACK_BOT_TOKEN",
    credentialAvailable: true,
    ...(hash !== undefined ? { credentialHash: hash } : {}),
  };
}

export function slackAppBinding(
  hash?: string,
  sandboxName = "sb",
): SandboxMessagingPlan["credentialBindings"][number] {
  return {
    channelId: "slack",
    credentialId: "slackAppToken",
    sourceInput: "appToken",
    providerName: `${sandboxName}-slack-app`,
    providerEnvKey: "SLACK_APP_TOKEN",
    placeholder: "openshell:resolve:env:SLACK_APP_TOKEN",
    credentialAvailable: true,
    ...(hash !== undefined ? { credentialHash: hash } : {}),
  };
}

export function slackBindings(botHash?: string, appHash?: string, sandboxName = "sb") {
  return [slackBotBinding(botHash, sandboxName), slackAppBinding(appHash, sandboxName)];
}

export function planEntry(name: string, plan: SandboxMessagingPlan): ConflictRegistryEntry {
  const state: SandboxMessagingState = { schemaVersion: 1, plan };
  return { name, messaging: state };
}
