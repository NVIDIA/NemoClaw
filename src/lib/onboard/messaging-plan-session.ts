// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxMessagingPlan } from "../messaging/manifest";
import { parseValidSandboxMessagingPlan } from "../messaging/plan-validation";
import type { MessagingChannelConfig } from "../messaging-channel-config";

export function parseSandboxMessagingPlan(value: unknown): SandboxMessagingPlan | null {
  return parseValidSandboxMessagingPlan(value);
}

/** Derive configured channel ids from a plan. */
export function getChannelsFromPlan(
  plan: SandboxMessagingPlan | null | undefined,
): string[] | null {
  const validPlan = parseSandboxMessagingPlan(plan);
  if (!validPlan) return null;
  return validPlan.channels.map((c) => c.channelId);
}

/** Derive active, non-disabled channels from a plan for build/provider setup. */
export function getActiveChannelsFromPlan(
  plan: SandboxMessagingPlan | null | undefined,
): string[] | null {
  const validPlan = parseSandboxMessagingPlan(plan);
  if (!validPlan) return null;
  const disabled = new Set(validPlan.disabledChannels);
  return validPlan.channels
    .filter((channel) => channel.active && !channel.disabled && !disabled.has(channel.channelId))
    .map((channel) => channel.channelId);
}

/** Derive disabled channel ids from a plan. */
export function getDisabledChannelsFromPlan(
  plan: SandboxMessagingPlan | null | undefined,
): string[] | null {
  const validPlan = parseSandboxMessagingPlan(plan);
  if (!validPlan) return null;
  return validPlan.disabledChannels.length > 0 ? [...validPlan.disabledChannels] : null;
}

/**
 * Derive non-secret channel config from a plan. Config inputs
 * (kind === "config") carry their resolved env-key/value pairs in
 * plan.channels[].inputs, populated at compile time from process.env.
 */
export function getMessagingChannelConfigFromPlan(
  plan: SandboxMessagingPlan | null | undefined,
): MessagingChannelConfig | null {
  const validPlan = parseSandboxMessagingPlan(plan);
  if (!validPlan) return null;
  const config: Record<string, string> = {};
  for (const channel of validPlan.channels) {
    for (const input of channel.inputs) {
      if (input.kind === "config" && input.sourceEnv && input.value != null) {
        config[input.sourceEnv] = String(input.value);
      }
    }
  }
  return Object.keys(config).length > 0 ? config : null;
}
