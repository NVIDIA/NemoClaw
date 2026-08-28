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
import { listMessagingCredentialMetadata } from "../../src/lib/messaging/channels";

type DockerfilePlanChannel = {
  channelId?: unknown;
  active?: unknown;
};

type DockerfilePlan = {
  channels?: DockerfilePlanChannel[];
};

/** Per-channel fields a caller needs to differ from the default derivation. */
export type TestMessagingPlanChannelOverride = Partial<
  Pick<SandboxMessagingPlan["channels"][number], "active" | "inputs">
>;

export interface TestMessagingPlanOptions {
  readonly sandboxName?: string;
  readonly channels?: readonly MessagingChannelId[];
  readonly disabledChannels?: readonly MessagingChannelId[];
  readonly agent?: MessagingAgentId;
  readonly workflow?: MessagingCompilerWorkflow;
  readonly authMode?: ChannelAuthMode;
  readonly credentialBindings?: readonly SandboxMessagingCredentialBindingPlan[];
  /**
   * The rebuild workflow planner sets `disabled` from the persisted disabled set, then
   * `active` from `!disabled && isChannelPlanStartable(channel)`, so a channel absent from
   * that set can be inactive without being disabled. A fresh manifest compile instead marks
   * a channel with missing required inputs disabled. The channel and disabled lists alone
   * cannot express the planner shape.
   */
  readonly channelOverrides?: Readonly<
    Partial<Record<MessagingChannelId, TestMessagingPlanChannelOverride>>
  >;
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
    channelOverrides = {},
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
      active: channelOverrides[channelId]?.active ?? !disabled.has(channelId),
      selected: true,
      configured: true,
      disabled: disabled.has(channelId),
      // Clone so repeated calls and caller-owned inputs stay isolated (#8357).
      inputs: structuredClone(channelOverrides[channelId]?.inputs ?? []),
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

/**
 * Synthetic credential bindings for conflict preflight only. `enforceMessagingChannelConflicts`
 * aborts unless an active credential-bearing channel carries a complete hash, so a fixture with
 * active credential channels needs an entry per manifest credential. Resolving the set from the
 * manifests keeps the fixture tracking them instead of restating them.
 *
 * These are not compiled bindings: `providerName` stays a `{sandboxName}` template and each hash
 * is a deterministic sentinel, so two fixtures built from the same channels look like they share
 * a credential. Do not use them where a test compares hashes across sandboxes.
 */
export function messagingCredentialBindingsForChannels(
  channelIds: readonly MessagingChannelId[],
): SandboxMessagingCredentialBindingPlan[] {
  const wanted = new Set<string>(channelIds);
  return listMessagingCredentialMetadata()
    .filter((credential) => wanted.has(credential.channelId))
    .map((credential) => ({
      channelId: credential.channelId as MessagingChannelId,
      credentialId: credential.credentialId,
      sourceInput: credential.sourceInput,
      providerName: credential.providerNameTemplate,
      providerEnvKey: credential.providerEnvKey,
      placeholder: credential.placeholder,
      credentialAvailable: true,
      credentialHash: `hash-${credential.channelId}-${credential.credentialId}`,
    }));
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
