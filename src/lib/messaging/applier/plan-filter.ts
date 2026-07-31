// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { MessagingChannelId, SandboxMessagingChannelPlan } from "../manifest";

export type EnabledPlanChannel = Pick<SandboxMessagingChannelPlan, "channelId"> &
  Partial<Pick<SandboxMessagingChannelPlan, "active" | "disabled">>;

export interface EnabledPlanSelection<Channel extends EnabledPlanChannel = EnabledPlanChannel> {
  readonly channels: readonly Channel[];
  readonly disabledChannels?: readonly MessagingChannelId[];
}

export function normalizeMessagingChannelId(channelId: MessagingChannelId): MessagingChannelId {
  return channelId.trim().toLowerCase();
}

export function enabledPlanChannels<Channel extends EnabledPlanChannel>(
  plan: EnabledPlanSelection<Channel>,
): Channel[] {
  const disabled = disabledPlanChannelIds(plan);
  return plan.channels.filter((channel) => {
    const channelId = normalizeMessagingChannelId(channel.channelId);
    return channelId.length > 0 && channel.active && !channel.disabled && !disabled.has(channelId);
  });
}

export function enabledPlanChannelIds(plan: EnabledPlanSelection): Set<MessagingChannelId> {
  return new Set(
    enabledPlanChannels(plan).map((channel) => normalizeMessagingChannelId(channel.channelId)),
  );
}

export function filterEnabledPlanEntries<T extends { readonly channelId: MessagingChannelId }>(
  plan: EnabledPlanSelection,
  entries: readonly T[],
): T[] {
  const enabled = enabledPlanChannelIds(plan);
  return entries.filter((entry) => enabled.has(normalizeMessagingChannelId(entry.channelId)));
}

function disabledPlanChannelIds(plan: EnabledPlanSelection): Set<MessagingChannelId> {
  return new Set((plan.disabledChannels ?? []).map(normalizeMessagingChannelId).filter(Boolean));
}
