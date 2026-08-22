// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WebSearchConfig } from "../inference/web-search";
import * as webSearch from "../inference/web-search";
import { listMessagingCredentialMetadata } from "../messaging/channels";
import { MESSAGING_CREDENTIAL_PROVIDER_TYPE } from "../messaging/provider-profile";
import { type ChannelDef, getChannelTokenKeys } from "../sandbox/channels";
import * as braveProviderProfile from "./brave-provider-profile";
import {
  bridgeProviderNamesForChannel,
  collectMessagingBridgeTokenDefs,
  messagingBridgeProfilesForAgent,
  staticMessagingProviderTypeForChannel,
} from "./messaging-bridge-provider";

export type NamedMessagingChannel = { name: string } & ChannelDef;

export interface MessagingTokenDef {
  name: string;
  envKey: string;
  token: string | null;
  providerType?: string;
}

export interface CreateSandboxMessagingPrepInput {
  sandboxName: string;
  agentName?: string | null;
  requireExactProviderBinding?: boolean;
  channels: readonly NamedMessagingChannel[];
  enabledChannels: readonly string[] | null;
  disabledChannels: readonly string[];
  webSearchConfig: WebSearchConfig | null;
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  getValidatedMessagingTokenByEnvKey(
    channels: readonly NamedMessagingChannel[],
    envKey: string,
  ): string | null;
  getCredential(envKey: string): string | null;
  normalizeCredentialValue(value: unknown): string;
  registerExtraPlaceholderProviders(
    sandboxName: string,
    messagingTokenDefs: MessagingTokenDef[],
  ): string[];
  getMessagingChannelForEnvKey(envKey: string): string | null;
  providerExistsInGateway(name: string): boolean;
  providerMatchesGatewayCredential(name: string, type: string, credentialEnv: string): boolean;
}

export interface CreateSandboxMessagingPrepResult {
  disabledChannelNames: Set<string>;
  messagingTokenDefs: MessagingTokenDef[];
  extraPlaceholderKeys: string[];
  hasMessagingTokens: boolean;
  reusableMessagingProviders: string[];
  reusableMessagingChannels: string[];
  /** Selected bridge channels with no usable provider and no source secret. */
  missingBridgeChannels: string[];
  missingWebSearchCredentialEnv: string | null;
}

export function prepareCreateSandboxMessaging(
  input: CreateSandboxMessagingPrepInput,
): CreateSandboxMessagingPrepResult {
  const requiresExactOpenClawProviderBinding =
    input.requireExactProviderBinding === true &&
    (!input.agentName || input.agentName.trim().toLowerCase() === "openclaw");
  const enabledEnvKeys =
    input.enabledChannels != null
      ? new Set(
          input.channels
            .filter((c) => input.enabledChannels?.includes(c.name))
            .flatMap((c) => getChannelTokenKeys(c)),
        )
      : null;

  const disabledChannelNames = new Set(input.disabledChannels);
  const disabledEnvKeys = new Set(
    input.channels
      .filter((c) => disabledChannelNames.has(c.name))
      .flatMap((c) => getChannelTokenKeys(c)),
  );
  const messagingProviderProfiles = messagingBridgeProfilesForAgent(input.agentName);

  const messagingTokenDefs: MessagingTokenDef[] = listMessagingCredentialMetadata()
    .map((credential) => ({
      name: credential.providerNameTemplate.replaceAll("{sandboxName}", input.sandboxName),
      envKey: credential.providerEnvKey,
      token: input.getValidatedMessagingTokenByEnvKey(input.channels, credential.providerEnvKey),
      providerType:
        staticMessagingProviderTypeForChannel(
          credential.channelId,
          input.agentName,
          messagingProviderProfiles,
        ) ?? MESSAGING_CREDENTIAL_PROVIDER_TYPE,
    }))
    .filter(({ envKey }) => !enabledEnvKeys || enabledEnvKeys.has(envKey))
    .filter(({ envKey }) => !disabledEnvKeys.has(envKey));

  const webSearchEnabled = braveProviderProfile.shouldEnableWebSearch(input.webSearchConfig);
  const webSearchProvider = webSearch.webSearchProviderForConfig(input.webSearchConfig);
  const webSearchCredentialEnv = webSearch.webSearchEnvFor(webSearchProvider);
  const webSearchProviderType =
    webSearchProvider === "tavily" && input.agentName?.trim().toLowerCase() === "hermes"
      ? braveProviderProfile.HERMES_TAVILY_PROVIDER_PROFILE_ID
      : webSearchProvider;
  const webSearchProviderName = `${input.sandboxName}-${webSearchProvider}-search`;
  const webSearchApiKey = webSearchEnabled
    ? input.getCredential(webSearchCredentialEnv) ||
      input.normalizeCredentialValue(input.env[webSearchCredentialEnv]) ||
      null
    : null;
  const reusableWebSearchProvider =
    requiresExactOpenClawProviderBinding &&
    webSearchEnabled &&
    !webSearchApiKey &&
    input.providerMatchesGatewayCredential(
      webSearchProviderName,
      webSearchProviderType,
      webSearchCredentialEnv,
    );
  const missingWebSearchCredentialEnv =
    webSearchEnabled && !webSearchApiKey && !reusableWebSearchProvider
      ? webSearchCredentialEnv
      : null;
  if (missingWebSearchCredentialEnv) {
    return {
      disabledChannelNames,
      messagingTokenDefs,
      extraPlaceholderKeys: [],
      hasMessagingTokens: messagingTokenDefs.some(({ token }) => !!token),
      reusableMessagingProviders: [],
      reusableMessagingChannels: [],
      missingBridgeChannels: [],
      missingWebSearchCredentialEnv,
    };
  }

  if (webSearchEnabled) {
    messagingTokenDefs.push({
      name: webSearchProviderName,
      envKey: webSearchCredentialEnv,
      token: webSearchApiKey,
      providerType: webSearchProviderType,
    });
  }

  // Messaging bridge providers: any channel that mints its outbound token
  // gateway-side (declared by a co-located provider-profile YAML) registers a
  // refresh-minted provider so the gateway mints the token (secret stays
  // gateway-side) and the L7 proxy injects it. The credential value is a sentinel
  // (minted by refresh, configured post-create in onboard's
  // upsertMessagingProviders wrapper). Today only Google Chat uses this.
  // Resolve the agent instead of defaulting it: an agent no manifest supports
  // must configure no bridge, not the OpenClaw one.
  const bridgeProfiles = messagingProviderProfiles.filter((profile) => profile.strategy !== null);
  messagingTokenDefs.push(
    ...collectMessagingBridgeTokenDefs({
      sandboxName: input.sandboxName,
      agent: input.agentName,
      getCredential: input.getCredential,
      env: input.env,
      normalizeCredentialValue: input.normalizeCredentialValue,
      enabledChannels: input.enabledChannels,
      disabledChannelNames,
      profiles: messagingProviderProfiles,
    }),
  );

  const extraPlaceholderKeys = input.registerExtraPlaceholderProviders(
    input.sandboxName,
    messagingTokenDefs,
  );
  const hasMessagingTokens = messagingTokenDefs.some(({ token }) => !!token);
  const reusableMessagingProviders: string[] = reusableWebSearchProvider
    ? [webSearchProviderName]
    : [];
  const reusableMessagingChannels: string[] = [];

  if (input.enabledChannels != null) {
    for (const { name, envKey, token, providerType } of messagingTokenDefs) {
      if (token) continue;
      const channel = input.getMessagingChannelForEnvKey(envKey);
      if (!channel || !input.enabledChannels.includes(channel)) continue;
      const providerReusable = providerType
        ? input.providerMatchesGatewayCredential(name, providerType, envKey)
        : requiresExactOpenClawProviderBinding
          ? input.providerMatchesGatewayCredential(name, "generic", envKey)
          : input.providerExistsInGateway(name);
      if (!providerReusable) continue;
      reusableMessagingProviders.push(name);
      if (!reusableMessagingChannels.includes(channel)) {
        reusableMessagingChannels.push(channel);
      }
    }
  }

  // Bridge channels have no token def at all when their env-only secret is
  // gone (fresh process), so the envKey loop above misses them. The gateway
  // still holds the refresh material — reuse the provider by name instead.
  // The name carries the channel but not the agent, and onboard can recreate a
  // sandbox name under a different agent, so match the gateway binding against
  // the selected profile rather than accepting any provider with that name.
  if (input.enabledChannels != null) {
    for (const profile of bridgeProfiles) {
      const channel = profile.channelId;
      if (!input.enabledChannels.includes(channel)) continue;
      if (disabledChannelNames.has(channel)) continue;
      for (const name of bridgeProviderNamesForChannel(input.sandboxName, channel, [profile])) {
        if (messagingTokenDefs.some((def) => def.name === name && def.token)) continue;
        if (reusableMessagingProviders.includes(name)) continue;
        if (!input.providerMatchesGatewayCredential(name, profile.profileId, profile.credentialKey))
          continue;
        reusableMessagingProviders.push(name);
        if (!reusableMessagingChannels.includes(channel)) {
          reusableMessagingChannels.push(channel);
        }
      }
    }
  }

  // A selected bridge channel that ends with neither a token def nor a matching
  // gateway provider would otherwise vanish from the create intent, and onboard
  // can act on that intent by deleting and recreating the sandbox. Report it so
  // the caller can stop and ask for the source secret again.
  const selectedChannels = input.enabledChannels;
  const missingBridgeChannels =
    selectedChannels == null
      ? []
      : [...new Set(bridgeProfiles.map((profile) => profile.channelId))].filter(
          (channel) =>
            selectedChannels.includes(channel) &&
            !disabledChannelNames.has(channel) &&
            !reusableMessagingChannels.includes(channel) &&
            !bridgeProviderNamesForChannel(input.sandboxName, channel, bridgeProfiles).some(
              (name) => messagingTokenDefs.some((def) => def.name === name && def.token),
            ),
        );

  return {
    disabledChannelNames,
    missingBridgeChannels,
    messagingTokenDefs,
    extraPlaceholderKeys,
    hasMessagingTokens,
    reusableMessagingProviders,
    reusableMessagingChannels,
    missingWebSearchCredentialEnv,
  };
}
