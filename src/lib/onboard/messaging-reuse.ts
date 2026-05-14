// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

type MessagingChannel = { name: string; envKey: string };
type SandboxEntry = { messagingChannels?: string[] | null } | null | undefined;

export function getMessagingProviderNamesForChannel(sandboxName: string, channel: string): string[] {
  if (channel === "discord") return [`${sandboxName}-discord-bridge`];
  if (channel === "telegram") return [`${sandboxName}-telegram-bridge`];
  if (channel === "slack") return [`${sandboxName}-slack-bridge`, `${sandboxName}-slack-app`];
  return [];
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
  getSandbox: (sandboxName: string) => SandboxEntry,
  getDisabledChannels: (sandboxName: string) => string[],
  providerExists: (providerName: string) => boolean,
  nonInteractive: boolean,
): string[] | null {
  if (!nonInteractive) return null;
  if (resume && Array.isArray(sessionChannels)) {
    const knownSessionChannels = getKnownMessagingChannels(sessionChannels, messagingChannels);
    return knownSessionChannels.length > 0 ? knownSessionChannels : null;
  }
  if (resume || !sandboxName || messagingChannels.some((channel) => hasMessagingToken(channel.envKey))) {
    return null;
  }

  const configuredChannels = getKnownMessagingChannels(
    getSandbox(sandboxName)?.messagingChannels,
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
