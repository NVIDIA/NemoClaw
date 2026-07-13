// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  listMessagingCredentialMetadata,
  type MessagingCredentialMetadata,
} from "../messaging/channels";
import type { MessagingTokenDef } from "./messaging-prep";
import { resolveQrSelectedChannels } from "./messaging-state";
import type {
  ResolveSandboxCreateIntentInput,
  SandboxCreateIntent,
  SandboxCreateMessagingProviderRequest,
} from "./sandbox-create-intent-types";

function filterEnabledChannelNames(
  channelNames: readonly string[],
  disabledChannelNames: ReadonlySet<string>,
): string[] {
  return channelNames.filter((channelName) => !disabledChannelNames.has(channelName));
}

function filterMessagingProviderRequestsByEnabledChannel(
  requests: readonly SandboxCreateMessagingProviderRequest[],
  disabledChannelNames: ReadonlySet<string>,
): SandboxCreateMessagingProviderRequest[] {
  return requests.filter(({ channel }) => !channel || !disabledChannelNames.has(channel));
}

function resolveTokenProviderChannelMap(
  requests: readonly SandboxCreateMessagingProviderRequest[],
): Map<string, string> {
  const providerChannels = new Map<string, string>();
  for (const { channel, name } of requests) {
    if (channel) providerChannels.set(name, channel);
  }
  return providerChannels;
}

function filterMessagingProvidersByEnabledChannel(
  providerNames: string[],
  providerChannels: ReadonlyMap<string, string>,
  disabledChannelNames: ReadonlySet<string>,
): string[] {
  return providerNames.filter((providerName) => {
    const channel = providerChannels.get(providerName);
    return !channel || !disabledChannelNames.has(channel);
  });
}

function resolveActiveMessagingChannels({
  channels,
  disabledChannelNames,
  enabledChannels,
  messagingProviderRequests,
  primaryMessagingCredentialEnvKeys,
  reusableMessagingChannels,
}: Pick<
  ResolveSandboxCreateIntentInput,
  | "channels"
  | "disabledChannelNames"
  | "enabledChannels"
  | "messagingProviderRequests"
  | "primaryMessagingCredentialEnvKeys"
  | "reusableMessagingChannels"
>): string[] {
  const primaryCredentialEnvKeys = new Set(primaryMessagingCredentialEnvKeys);
  const qrSelectedChannels = resolveQrSelectedChannels(
    [...channels],
    enabledChannels,
    disabledChannelNames,
  );
  return filterEnabledChannelNames(
    [
      ...new Set([
        ...messagingProviderRequests
          .filter(({ credentialConfigured }) => credentialConfigured)
          .flatMap(({ channel, envKey }) => {
            return channel && primaryCredentialEnvKeys.has(envKey) ? [channel] : [];
          }),
        ...reusableMessagingChannels,
        ...qrSelectedChannels,
      ]),
    ],
    disabledChannelNames,
  );
}

function compareCredentialsForPrimarySelection(
  left: MessagingCredentialMetadata,
  right: MessagingCredentialMetadata,
): number {
  return (
    left.credentialId.localeCompare(right.credentialId) ||
    left.providerEnvKey.localeCompare(right.providerEnvKey)
  );
}

export function resolvePrimaryMessagingCredentialEnvKeys(): string[] {
  const credentialsByChannel = new Map<string, MessagingCredentialMetadata[]>();
  for (const credential of listMessagingCredentialMetadata()) {
    const credentials = credentialsByChannel.get(credential.channelId) ?? [];
    credentials.push(credential);
    credentialsByChannel.set(credential.channelId, credentials);
  }

  const envKeys = new Set<string>();
  for (const credentials of credentialsByChannel.values()) {
    const primary =
      credentials.find((credential) => credential.primary) ??
      [...credentials].sort(compareCredentialsForPrimarySelection)[0];
    if (primary) envKeys.add(primary.providerEnvKey);
  }
  return [...envKeys];
}

export function resolveSandboxCreateMessagingProviderRequests(
  messagingTokenDefs: readonly MessagingTokenDef[],
  getMessagingChannelForEnvKey: (envKey: string) => string | null,
): SandboxCreateMessagingProviderRequest[] {
  return messagingTokenDefs.map(({ name, envKey, providerType, token }) => ({
    name,
    envKey,
    ...(providerType ? { providerType } : {}),
    credentialConfigured: Boolean(token),
    channel: getMessagingChannelForEnvKey(envKey),
  }));
}

export function resolveSandboxCreateIntent({
  basePolicyPath,
  sandboxName,
  channels,
  enabledChannels,
  disabledChannelNames,
  messagingProviderRequests,
  primaryMessagingCredentialEnvKeys,
  reusableMessagingChannels,
  reusableMessagingProviders,
  extraProviders,
  staleExtraProviders,
  hermesToolGateways,
  sandboxGpuConfig,
  gpuCreateArgs,
  resourceCreateArgs = [],
  gpuRoutePlan,
  sandboxGpuLogMessage,
  extraPlaceholderKeys = [],
  agentName,
  policyTier,
}: ResolveSandboxCreateIntentInput): SandboxCreateIntent {
  const enabledMessagingProviderRequests = filterMessagingProviderRequestsByEnabledChannel(
    messagingProviderRequests,
    disabledChannelNames,
  );
  const providerChannels = resolveTokenProviderChannelMap(messagingProviderRequests);
  const activeMessagingChannels = resolveActiveMessagingChannels({
    channels,
    disabledChannelNames,
    enabledChannels,
    messagingProviderRequests: enabledMessagingProviderRequests,
    primaryMessagingCredentialEnvKeys,
    reusableMessagingChannels,
  });
  const enabledReusableMessagingProviders = filterMessagingProvidersByEnabledChannel(
    [...new Set(reusableMessagingProviders)],
    providerChannels,
    disabledChannelNames,
  );

  return {
    sandboxName,
    activeMessagingChannels,
    messagingProviderRequests: messagingProviderRequests.map((request) => ({ ...request })),
    reusableMessagingProviders: enabledReusableMessagingProviders,
    extraProviders: [...new Set(extraProviders ?? [])].filter(Boolean),
    staleExtraProviders: [...new Set(staleExtraProviders ?? [])].filter(Boolean),
    hermesToolGateways: [...hermesToolGateways],
    policy: {
      basePolicyPath,
      activeMessagingChannels: [...activeMessagingChannels],
      options: {
        directGpu: sandboxGpuConfig.sandboxGpuEnabled,
        additionalPresets: [...hermesToolGateways],
        ...(agentName !== undefined ? { agentName } : {}),
        policyTier,
      },
    },
    gpuCreateArgs: [...gpuCreateArgs],
    resourceCreateArgs: [...resourceCreateArgs],
    gpuRoutePlan,
    sandboxGpuLogMessage,
    disabledChannelNames: [...disabledChannelNames],
    extraPlaceholderKeys: [...extraPlaceholderKeys],
  };
}
