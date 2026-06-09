// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { MessagingChannelConfig } from "../messaging-channel-config";
import type { SandboxMessagingPlan } from "../messaging/manifest";

export function parseSandboxMessagingPlan(value: unknown): SandboxMessagingPlan | null {
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
  return value as unknown as SandboxMessagingPlan;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Derive the equivalent of session.messagingChannels from a plan. */
export function getChannelsFromPlan(
  plan: SandboxMessagingPlan | null | undefined,
): string[] | null {
  if (!plan || plan.channels.length === 0) return null;
  return plan.channels.map((c) => c.channelId);
}

/** Derive the equivalent of session.disabledChannels from a plan. */
export function getDisabledChannelsFromPlan(
  plan: SandboxMessagingPlan | null | undefined,
): string[] | null {
  if (!plan) return null;
  return plan.disabledChannels.length > 0 ? [...plan.disabledChannels] : null;
}

/**
 * Derive the equivalent of session.messagingChannelConfig from a plan.
 * Config inputs (kind === "config") carry their resolved env-key/value pairs
 * in plan.channels[].inputs, populated at compile time from process.env.
 */
export function getMessagingChannelConfigFromPlan(
  plan: SandboxMessagingPlan | null | undefined,
): MessagingChannelConfig | null {
  if (!plan) return null;
  const config: Record<string, string> = {};
  for (const channel of plan.channels) {
    for (const input of channel.inputs) {
      if (input.kind === "config" && input.sourceEnv && input.value != null) {
        config[input.sourceEnv] = String(input.value);
      }
    }
  }
  return Object.keys(config).length > 0 ? config : null;
}
