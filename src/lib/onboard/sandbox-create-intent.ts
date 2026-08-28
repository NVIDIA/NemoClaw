// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  listMessagingCredentialMetadata,
  type MessagingCredentialMetadata,
} from "../messaging/channels";
import { hasConfiguredMessagingCredential, type MessagingTokenDef } from "./messaging-prep";
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
  selectedChannelNames: ReadonlySet<string> | null,
  disabledChannelNames: ReadonlySet<string>,
): SandboxCreateMessagingProviderRequest[] {
  return requests.filter(
    ({ channel }) =>
      !channel ||
      ((!selectedChannelNames || selectedChannelNames.has(channel)) &&
        !disabledChannelNames.has(channel)),
  );
}

export function filterMessagingProvidersForSandboxCreate(
  providerNames: readonly string[],
  requests: readonly SandboxCreateMessagingProviderRequest[],
  activeChannelNames: Iterable<string>,
  disabledChannelNames: Iterable<string>,
): string[] {
  const providerChannels = new Map<string, string>();
  for (const { channel, name } of requests) {
    if (channel) providerChannels.set(name, channel);
  }
  const eligibleChannels = new Set([...activeChannelNames, ...disabledChannelNames]);
  return [...new Set(providerNames)].filter((providerName) => {
    const channel = providerChannels.get(providerName);
    return !channel || eligibleChannels.has(channel);
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
  const selectedChannelNames = enabledChannels == null ? null : new Set(enabledChannels);
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
            return channel &&
              (!selectedChannelNames || selectedChannelNames.has(channel)) &&
              primaryCredentialEnvKeys.has(envKey)
              ? [channel]
              : [];
          }),
        ...reusableMessagingChannels.filter(
          (channel) => !selectedChannelNames || selectedChannelNames.has(channel),
        ),
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
  return messagingTokenDefs.map((tokenDef) => ({
    name: tokenDef.name,
    envKey: tokenDef.envKey,
    ...(tokenDef.providerType ? { providerType: tokenDef.providerType } : {}),
    credentialConfigured: hasConfiguredMessagingCredential(tokenDef),
    channel: getMessagingChannelForEnvKey(tokenDef.envKey),
  }));
}

export function resolveSandboxCreateIntent({
  basePolicyPath,
  sandboxName,
  inferenceProvider,
  hostLocalInferenceRouteOnly = false,
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
  hostMounts = [],
  gpuRoutePlan,
  sandboxGpuLogMessage,
  extraPlaceholderKeys = [],
  agentName,
  policyTier,
  baselineExclusions = [],
}: ResolveSandboxCreateIntentInput): SandboxCreateIntent {
  const selectedChannelNames = enabledChannels == null ? null : new Set(enabledChannels);
  const enabledMessagingProviderRequests = filterMessagingProviderRequestsByEnabledChannel(
    messagingProviderRequests,
    selectedChannelNames,
    disabledChannelNames,
  );
  const activeMessagingChannels = resolveActiveMessagingChannels({
    channels,
    disabledChannelNames,
    enabledChannels,
    messagingProviderRequests: enabledMessagingProviderRequests,
    primaryMessagingCredentialEnvKeys,
    reusableMessagingChannels,
  });
  const enabledReusableMessagingProviders = filterMessagingProvidersForSandboxCreate(
    reusableMessagingProviders,
    messagingProviderRequests,
    activeMessagingChannels,
    disabledChannelNames,
  );

  const normalizedInferenceProvider = inferenceProvider?.trim() || null;

  return {
    sandboxName,
    inferenceProvider: normalizedInferenceProvider,
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
        ...(sandboxGpuConfig.hostGpuDetected !== undefined
          ? { hostGpuAvailable: sandboxGpuConfig.hostGpuDetected }
          : {}),
        additionalPresets: [...hermesToolGateways],
        ...(hostLocalInferenceRouteOnly ? { hostLocalInferenceRouteOnly: true as const } : {}),
        ...(agentName !== undefined ? { agentName } : {}),
        policyTier,
        baselineExclusions: [...baselineExclusions].map((exclusion) => ({ ...exclusion })),
      },
    },
    sandboxGpuDevice: sandboxGpuConfig.sandboxGpuDevice?.trim() || null,
    gpuCreateArgs: [...gpuCreateArgs],
    resourceCreateArgs: [...resourceCreateArgs],
    ...(hostMounts.length > 0
      ? {
          hostMounts: hostMounts.map(({ source, target, sourceIdentity }) => ({
            source,
            target,
            readOnly: true,
            ...(sourceIdentity ? { sourceIdentity: { ...sourceIdentity } } : {}),
          })),
        }
      : {}),
    gpuRoutePlan,
    sandboxGpuLogMessage,
    disabledChannelNames: [...disabledChannelNames],
    extraPlaceholderKeys: [...extraPlaceholderKeys],
  };
}
