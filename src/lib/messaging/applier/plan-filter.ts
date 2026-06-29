// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  MessagingChannelId,
  SandboxMessagingChannelPlan,
  SandboxMessagingPlan,
} from "../manifest";

export function enabledPlanChannels(plan: SandboxMessagingPlan): SandboxMessagingChannelPlan[] {
  const disabled = disabledPlanChannelIds(plan);
  return plan.channels.filter(
    (channel) => channel.active && !channel.disabled && !disabled.has(channel.channelId),
  );
}

export function enabledPlanChannelIds(plan: SandboxMessagingPlan): Set<MessagingChannelId> {
  return new Set(enabledPlanChannels(plan).map((channel) => channel.channelId));
}

export function filterEnabledPlanEntries<T extends { readonly channelId: MessagingChannelId }>(
  plan: SandboxMessagingPlan,
  entries: readonly T[],
): T[] {
  const enabled = enabledPlanChannelIds(plan);
  return entries.filter((entry) => enabled.has(entry.channelId));
}

function disabledPlanChannelIds(plan: SandboxMessagingPlan): Set<MessagingChannelId> {
  return new Set(plan.disabledChannels);
}
