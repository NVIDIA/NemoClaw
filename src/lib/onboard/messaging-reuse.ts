// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { listMessagingProviderNamesForChannel } from "../messaging/channels";
import type { RegistryMessagingAuthority } from "../messaging/plan-authority";
import { getChannelsFromPlan, getDisabledChannelsFromPlan } from "./messaging-plan-session";

type MessagingChannel = { name: string; envKey?: string };

export function getMessagingProviderNamesForChannel(
  sandboxName: string,
  channel: string,
): string[] {
  return listMessagingProviderNamesForChannel(sandboxName, channel);
}

function getKnownMessagingChannels(
  channels: string[] | null | undefined,
  messagingChannels: readonly MessagingChannel[],
): string[] {
  if (!Array.isArray(channels)) return [];
  const known = new Set(messagingChannels.map((channel) => channel.name));
  return [...new Set(channels.filter((channel) => known.has(channel)))];
}

export async function getNonInteractiveStoredMessagingChannels(
  resume: boolean,
  sessionChannels: string[] | null | undefined,
  sandboxName: string | null,
  messagingChannels: readonly MessagingChannel[],
  hasMessagingToken: (envKey: string) => boolean,
  getRegistryMessagingAuthority: (sandboxName: string) => RegistryMessagingAuthority,
  providerExists: (providerName: string) => boolean | Promise<boolean>,
  nonInteractive: boolean,
): Promise<string[] | null> {
  if (!nonInteractive) return null;
  if (resume && Array.isArray(sessionChannels)) {
    const knownSessionChannels = getKnownMessagingChannels(sessionChannels, messagingChannels);
    return knownSessionChannels;
  }
  if (
    resume ||
    !sandboxName ||
    messagingChannels.some((channel) => channel.envKey && hasMessagingToken(channel.envKey))
  ) {
    return null;
  }

  const registryAuthority = getRegistryMessagingAuthority(sandboxName);
  if (!registryAuthority.authoritative) return null;
  const configuredChannels = getKnownMessagingChannels(
    getChannelsFromPlan(registryAuthority.plan),
    messagingChannels,
  );
  const disabledChannels = new Set(getDisabledChannelsFromPlan(registryAuthority.plan));
  const reusableChannels = (
    await Promise.all(
      configuredChannels.map(async (channel) => {
        if (disabledChannels.has(channel)) return null;
        const providers = getMessagingProviderNamesForChannel(sandboxName, channel);
        const exists = await Promise.all(providers.map((provider) => providerExists(provider)));
        return providers.length > 0 && exists.every(Boolean) ? channel : null;
      }),
    )
  ).filter((channel): channel is string => channel !== null);
  return reusableChannels.length > 0 ? reusableChannels : null;
}
