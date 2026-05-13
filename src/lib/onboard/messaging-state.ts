// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AgentDefinition } from "../agent/defs";
import { channelUsesQrPairing, isChannelExperimental, type ChannelDef } from "../sandbox/channels";

export type MessagingChannel = { name: string } & ChannelDef;

export function isExperimentalChannelGateEnabled(): boolean {
  return process.env.NEMOCLAW_EXPERIMENTAL === "1";
}

export function getAvailableMessagingChannelsForAgent<T extends { name: string } & ChannelDef>(
  channels: T[],
  agent: AgentDefinition | null = null,
  experimentalEnabled: boolean = isExperimentalChannelGateEnabled(),
): T[] {
  const supportedPlatforms = agent?.messagingPlatforms;
  const platformFiltered =
    supportedPlatforms && supportedPlatforms.length > 0
      ? channels.filter((c) => supportedPlatforms.includes(c.name))
      : channels;
  if (experimentalEnabled) return platformFiltered;
  return platformFiltered.filter((c) => !isChannelExperimental(c));
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
    return !!ch && channelUsesQrPairing(ch);
  });
}
