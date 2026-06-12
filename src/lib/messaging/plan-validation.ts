// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { MessagingChannelConfig } from "../messaging-channel-config";
import type { MessagingAgentId, MessagingChannelId, SandboxMessagingPlan } from "./manifest";

export interface SandboxMessagingPlanParseOptions {
  sandboxName?: string | null;
  agent?: MessagingAgentId | string | null;
  supportedChannelIds?: readonly MessagingChannelId[] | readonly string[] | null;
}

export function parseSandboxMessagingPlan(
  value: unknown,
  options: SandboxMessagingPlanParseOptions = {},
): SandboxMessagingPlan | null {
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    typeof value.sandboxName !== "string" ||
    typeof value.agent !== "string" ||
    typeof value.workflow !== "string" ||
    !Array.isArray(value.channels) ||
    !Array.isArray(value.disabledChannels) ||
    !Array.isArray(value.credentialBindings) ||
    !isObject(value.networkPolicy) ||
    !Array.isArray(value.agentRender) ||
    !Array.isArray(value.buildSteps) ||
    !Array.isArray(value.stateUpdates) ||
    !Array.isArray(value.healthChecks)
  ) {
    return null;
  }

  if (options.sandboxName && value.sandboxName !== options.sandboxName) return null;
  if (options.agent && value.agent !== options.agent) return null;

  const supported =
    options.supportedChannelIds && options.supportedChannelIds.length > 0
      ? new Set(options.supportedChannelIds)
      : null;
  for (const [index, channel] of value.channels.entries()) {
    if (!isObject(channel) || typeof channel.channelId !== "string") return null;
    if (typeof channel.configured !== "boolean") return null;
    if (typeof channel.active !== "boolean") return null;
    if (typeof channel.disabled !== "boolean") return null;
    if (!Array.isArray(channel.inputs)) return null;
    if (supported && !supported.has(channel.channelId)) return null;
    if (
      value.channels.findIndex(
        (candidate) => isObject(candidate) && candidate.channelId === channel.channelId,
      ) !== index
    ) {
      return null;
    }
  }
  if (!value.disabledChannels.every((channelId) => typeof channelId === "string")) return null;

  return cloneSandboxMessagingPlan(value as unknown as SandboxMessagingPlan);
}

export function cloneSandboxMessagingPlan(plan: SandboxMessagingPlan): SandboxMessagingPlan {
  return JSON.parse(JSON.stringify(plan)) as SandboxMessagingPlan;
}

export function getConfiguredChannelIdsFromPlan(
  plan: SandboxMessagingPlan | null | undefined,
): string[] {
  if (!plan) return [];
  return plan.channels.filter((channel) => channel.configured).map((channel) => channel.channelId);
}

export function getActiveChannelIdsFromPlan(
  plan: SandboxMessagingPlan | null | undefined,
): string[] {
  if (!plan) return [];
  const disabled = new Set(plan.disabledChannels);
  return plan.channels
    .filter((channel) => channel.active && !channel.disabled && !disabled.has(channel.channelId))
    .map((channel) => channel.channelId);
}

export function getDisabledChannelIdsFromPlan(
  plan: SandboxMessagingPlan | null | undefined,
): string[] {
  return plan ? [...plan.disabledChannels] : [];
}

export function getMessagingChannelConfigFromPlan(
  plan: SandboxMessagingPlan | null | undefined,
): MessagingChannelConfig | null {
  if (!plan) return null;
  const config: MessagingChannelConfig = {};
  for (const channel of plan.channels) {
    for (const input of channel.inputs) {
      if (input.kind !== "config" || !input.sourceEnv || input.value == null) continue;
      config[input.sourceEnv] = String(input.value);
    }
  }
  return Object.keys(config).length > 0 ? config : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
