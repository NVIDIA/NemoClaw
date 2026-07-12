// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { listMessagingProviderNamesForChannel } from "../messaging/channels";

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

export function getNonInteractiveStoredMessagingChannels(
  resume: boolean,
  sessionChannels: string[] | null | undefined,
  sandboxName: string | null,
  messagingChannels: readonly MessagingChannel[],
  hasMessagingToken: (envKey: string) => boolean,
  getConfiguredChannels: (sandboxName: string) => string[],
  getDisabledChannels: (sandboxName: string) => string[],
  providerExists: (providerName: string) => boolean,
  nonInteractive: boolean,
): string[] | null {
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

  const configuredChannels = getKnownMessagingChannels(
    getConfiguredChannels(sandboxName),
    messagingChannels,
  );
  const disabledChannels = new Set(getDisabledChannels(sandboxName));
  const reusableChannels = configuredChannels.filter((channel) => {
    if (disabledChannels.has(channel)) return false;
    const providers = getMessagingProviderNamesForChannel(sandboxName, channel);
    return providers.length > 0 && providers.every((provider) => providerExists(provider));
  });
  return reusableChannels.length > 0 ? reusableChannels : null;
}
