// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxMessagingPlan } from "../messaging/manifest";

type MessagingEntry = {
  messaging?: { schemaVersion?: number; plan?: SandboxMessagingPlan } | null;
};

export function getMessagingPlanFromEntry(
  entry: MessagingEntry | null | undefined,
): SandboxMessagingPlan | null {
  const plan = entry?.messaging?.schemaVersion === 1 ? entry.messaging.plan : null;
  return plan?.schemaVersion === 1 ? plan : null;
}

export function getConfiguredMessagingChannelsFromEntry(
  entry: MessagingEntry | null | undefined,
): string[] {
  const plan = getMessagingPlanFromEntry(entry);
  if (!plan) return [];
  return plan.channels
    .filter((channel) => channel.configured)
    .map((channel) => channel.channelId);
}

export function getActiveMessagingChannelsFromEntry(
  entry: MessagingEntry | null | undefined,
): string[] {
  const plan = getMessagingPlanFromEntry(entry);
  if (!plan) return [];
  const disabled = new Set(plan.disabledChannels);
  return plan.channels
    .filter((channel) => channel.active && !channel.disabled && !disabled.has(channel.channelId))
    .map((channel) => channel.channelId);
}

export function getDisabledMessagingChannelsFromEntry(
  entry: MessagingEntry | null | undefined,
): string[] {
  const plan = getMessagingPlanFromEntry(entry);
  return plan ? [...plan.disabledChannels] : [];
}
