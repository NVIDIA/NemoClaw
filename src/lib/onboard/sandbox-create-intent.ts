// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  assertSwitchyardInferenceAuthority,
  validateSwitchyardBindingState,
} from "../hermes-switchyard-routing";

import {
  listMessagingCredentialMetadata,
  type MessagingCredentialMetadata,
} from "../messaging/channels";
import { hasNemoClawOwnedMessagingProviderProfile } from "../messaging/applier/provider-application";
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
  registeredInferenceProviderAttachment,
  nativeLocalProviderAttachment,
  nativeNvidiaProviderAttachment,
  nativeHostedProviderAttachment,
  hermesSwitchyard: requestedSwitchyard,
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
  policyTier = null,
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
  const hermesSwitchyard = requestedSwitchyard
    ? validateSwitchyardBindingState(requestedSwitchyard)
    : undefined;
  assertSwitchyardInferenceAuthority({
    hermesSwitchyard,
    registeredInferenceProviderAttachment,
    nativeLocalProviderAttachment,
    nativeNvidiaProviderAttachment,
    nativeHostedProviderAttachment,
  });

  return {
    sandboxName,
    inferenceProvider: hermesSwitchyard ? null : normalizedInferenceProvider,
    ...(hermesSwitchyard ? { hermesSwitchyard } : {}),
    ...(registeredInferenceProviderAttachment ? { registeredInferenceProviderAttachment } : {}),
    ...(nativeLocalProviderAttachment ? { nativeLocalProviderAttachment } : {}),
    ...(nativeNvidiaProviderAttachment ? { nativeNvidiaProviderAttachment } : {}),
    ...(nativeHostedProviderAttachment ? { nativeHostedProviderAttachment } : {}),
    activeMessagingChannels,
    messagingProviderRequests: messagingProviderRequests.map((request) => ({ ...request })),
    reusableMessagingProviders: enabledReusableMessagingProviders,
    extraProviders: [
      ...new Set([
        ...(extraProviders ?? []),
        ...(hermesSwitchyard?.bindings.providers.map((p) => p.providerName) ?? []),
      ]),
    ].filter(Boolean),
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
        ...(hostLocalInferenceRouteOnly || nativeLocalProviderAttachment
          ? { hostLocalInferenceRouteOnly: true as const }
          : {}),
        ...(agentName !== undefined ? { agentName } : {}),
        policyTier,
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

function messagingProviderRequestKey(
  request: Pick<SandboxCreateMessagingProviderRequest, "name" | "envKey">,
): string {
  // Tuple encoding stays collision-free even if either value contains a separator.
  return JSON.stringify([request.name, request.envKey]);
}

export function validateSandboxCreateIntentBindings(
  intent: SandboxCreateIntent,
  messagingTokenDefs: readonly MessagingTokenDef[],
): MessagingTokenDef[] {
  assertSwitchyardInferenceAuthority(intent);
  const disabledChannelNames = new Set(intent.disabledChannelNames);
  const activeChannelNames = new Set(intent.policy.activeMessagingChannels);
  const enabledRequests = intent.messagingProviderRequests.filter(
    ({ channel }) =>
      !channel || (activeChannelNames.has(channel) && !disabledChannelNames.has(channel)),
  );
  const intentRequestKeys = new Set(
    intent.messagingProviderRequests.map(messagingProviderRequestKey),
  );
  const tokenDefsByRequest = new Map(
    messagingTokenDefs.map((tokenDef) => [messagingProviderRequestKey(tokenDef), tokenDef]),
  );

  if (tokenDefsByRequest.size !== messagingTokenDefs.length) {
    throw new Error(
      "Cannot materialize sandbox create intent; duplicate credential bindings found.",
    );
  }
  if (
    messagingTokenDefs.some(
      (tokenDef) => !intentRequestKeys.has(messagingProviderRequestKey(tokenDef)),
    )
  ) {
    throw new Error("Cannot materialize sandbox create intent; credential binding set changed.");
  }

  return enabledRequests.map((request) => {
    const tokenDef = tokenDefsByRequest.get(messagingProviderRequestKey(request));
    if (!tokenDef) {
      throw new Error(
        `Cannot materialize sandbox create intent; missing credential binding '${request.envKey}' for provider '${request.name}'.`,
      );
    }
    if (hasConfiguredMessagingCredential(tokenDef) !== request.credentialConfigured) {
      throw new Error(
        `Cannot materialize sandbox create intent; credential availability changed for provider '${request.name}'.`,
      );
    }
    if (!request.providerType || !tokenDef.providerType) {
      throw new Error(
        `Cannot materialize sandbox create intent; provider '${request.name}' has no explicit owned profile type. Re-run channel setup with a supported profile.`,
      );
    }
    if (tokenDef.providerType !== request.providerType) {
      throw new Error(
        `Cannot materialize sandbox create intent; provider type changed for '${request.name}'.`,
      );
    }
    if (
      !hasNemoClawOwnedMessagingProviderProfile(
        undefined,
        intent.policy.options.agentName,
        request.providerType,
      )
    ) {
      throw new Error(
        `Cannot materialize sandbox create intent; provider '${request.name}' has no NemoClaw-owned profile for type '${request.providerType}'. Re-run channel setup with a supported profile.`,
      );
    }
    return tokenDef;
  });
}
