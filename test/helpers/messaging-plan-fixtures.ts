// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  MessagingAgentId,
  MessagingCompilerWorkflow,
  SandboxMessagingPlan,
} from "../../src/lib/messaging/manifest";
import type { SandboxMessagingState } from "../../src/lib/state/registry";

export function makeMessagingPlan(
  sandboxName: string,
  channels: readonly string[],
  disabledChannels: readonly string[] = [],
  agent: string = "openclaw",
  workflow: string = "onboard",
  config: Record<string, string> = {},
): SandboxMessagingPlan {
  const disabled = new Set(disabledChannels);
  return {
    schemaVersion: 1,
    sandboxName,
    agent: agent as MessagingAgentId,
    workflow: workflow as MessagingCompilerWorkflow,
    channels: channels.map((channelId) => ({
      channelId,
      displayName: channelId,
      authMode: channelId === "whatsapp" ? "in-sandbox-qr" : "token-paste",
      active: !disabled.has(channelId),
      selected: true,
      configured: true,
      disabled: disabled.has(channelId),
      inputs:
        channelId === "telegram"
          ? Object.entries(config).map(([sourceEnv, value]) => ({
              channelId,
              inputId: sourceEnv,
              kind: "config",
              required: false,
              sourceEnv,
              value,
            }))
          : [],
      hooks: [],
    })),
    disabledChannels,
    credentialBindings: [],
    networkPolicy: { presets: channels.filter((channel) => !disabled.has(channel)), entries: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };
}

export function makeMessagingState(
  sandboxName: string,
  channels: readonly string[],
  disabledChannels: readonly string[] = [],
  agent: string = "openclaw",
  workflow: string = "onboard",
  config: Record<string, string> = {},
): SandboxMessagingState {
  return {
    schemaVersion: 1,
    plan: makeMessagingPlan(sandboxName, channels, disabledChannels, agent, workflow, config),
  };
}

export function encodedMessagingPlan(plan: unknown): string {
  return JSON.stringify(Buffer.from(JSON.stringify(plan), "utf8").toString("base64"));
}

export function registeredChannels(
  entry: { messaging?: { plan?: { channels?: Array<{ channelId: string }> } } } | undefined,
) {
  return entry?.messaging?.plan?.channels?.map((channel) => channel.channelId);
}

export function registeredDisabledChannels(
  entry: { messaging?: { plan?: { disabledChannels?: string[] } } } | undefined,
) {
  return entry?.messaging?.plan?.disabledChannels;
}
