// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "../agent/defs";
import { channelUsesInSandboxQrPairing, type ChannelDef } from "../sandbox/channels";

export type MessagingChannel = { name: string } & ChannelDef;

export function getAvailableMessagingChannelsForAgent<T extends { name: string }>(
  channels: T[],
  agent: AgentDefinition | null = null,
): T[] {
  const supportedPlatforms = agent?.messagingPlatforms;
  if (supportedPlatforms && supportedPlatforms.length > 0) {
    return channels.filter((c) => supportedPlatforms.includes(c.name));
  }
  return channels;
}

export function resolveQrSelectedChannels(
  channels: MessagingChannel[],
  enabledChannels: string[] | null | undefined,
  disabledChannelNames: ReadonlySet<string>,
): string[] {
  if (!Array.isArray(enabledChannels)) return [];
  return enabledChannels.filter((name) => {
    if (disabledChannelNames.has(name)) return false;
    const ch = channels.find((c) => c.name === name);
    return !!ch && channelUsesInSandboxQrPairing(ch);
  });
}

export function resolveMessagingChannelSeed(
  channels: MessagingChannel[],
  existingChannels: string[] | null | undefined,
  hasChannelToken: (channel: MessagingChannel) => boolean,
  { includeAllExisting = false }: { includeAllExisting?: boolean } = {},
): string[] {
  const seeded = new Set(channels.filter(hasChannelToken).map((channel) => channel.name));
  if (!Array.isArray(existingChannels)) return Array.from(seeded);

  const channelByName = new Map(channels.map((channel) => [channel.name, channel]));
  for (const name of existingChannels) {
    const channel = channelByName.get(name);
    if (!channel) continue;
    if (includeAllExisting || channelUsesInSandboxQrPairing(channel)) {
      seeded.add(name);
    }
  }
  return Array.from(seeded);
}

export function filterEnabledChannelsByAgent<T extends string[] | null | undefined>(
  enabledChannels: T,
  agent: AgentDefinition | null,
): T {
  if (!Array.isArray(enabledChannels)) return enabledChannels;
  const supported = agent?.messagingPlatforms ?? [];
  if (supported.length === 0) return enabledChannels;
  return enabledChannels.filter((n) => supported.includes(n)) as T;
}
