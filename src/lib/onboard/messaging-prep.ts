// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WebSearchConfig } from "../inference/web-search";
import * as webSearch from "../inference/web-search";
import { listMessagingCredentialMetadata } from "../messaging/channels";
import { type ChannelDef, getChannelTokenKeys } from "../sandbox/channels";
import * as braveProviderProfile from "./brave-provider-profile";

export type NamedMessagingChannel = { name: string } & ChannelDef;

export interface MessagingTokenDef {
  name: string;
  envKey: string;
  token: string | null;
  providerType?: string;
}

export interface CreateSandboxMessagingPrepInput {
  sandboxName: string;
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
}

export interface CreateSandboxMessagingPrepResult {
  disabledChannelNames: Set<string>;
  messagingTokenDefs: MessagingTokenDef[];
  extraPlaceholderKeys: string[];
  hasMessagingTokens: boolean;
  reusableMessagingProviders: string[];
  reusableMessagingChannels: string[];
  missingBraveApiKey: boolean;
}

export function prepareCreateSandboxMessaging(
  input: CreateSandboxMessagingPrepInput,
): CreateSandboxMessagingPrepResult {
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

  const messagingTokenDefs: MessagingTokenDef[] = listMessagingCredentialMetadata()
    .map((credential) => ({
      name: credential.providerNameTemplate.replaceAll("{sandboxName}", input.sandboxName),
      envKey: credential.providerEnvKey,
      token: input.getValidatedMessagingTokenByEnvKey(input.channels, credential.providerEnvKey),
    }))
    .filter(({ envKey }) => !enabledEnvKeys || enabledEnvKeys.has(envKey))
    .filter(({ envKey }) => !disabledEnvKeys.has(envKey));

  const braveWebSearchEnabled = braveProviderProfile.shouldEnableBraveWebSearch(
    input.webSearchConfig,
  );
  const braveApiKey = braveWebSearchEnabled
    ? input.getCredential(webSearch.BRAVE_API_KEY_ENV) ||
      input.normalizeCredentialValue(input.env[webSearch.BRAVE_API_KEY_ENV])
    : null;
  const missingBraveApiKey = braveWebSearchEnabled && !braveApiKey;
  if (missingBraveApiKey) {
    return {
      disabledChannelNames,
      messagingTokenDefs,
      extraPlaceholderKeys: [],
      hasMessagingTokens: messagingTokenDefs.some(({ token }) => !!token),
      reusableMessagingProviders: [],
      reusableMessagingChannels: [],
      missingBraveApiKey,
    };
  }

  if (braveWebSearchEnabled) {
    messagingTokenDefs.push({
      name: `${input.sandboxName}-brave-search`,
      envKey: webSearch.BRAVE_API_KEY_ENV,
      token: braveApiKey,
      providerType: braveProviderProfile.BRAVE_PROVIDER_PROFILE_ID,
    });
  }

  const extraPlaceholderKeys = input.registerExtraPlaceholderProviders(
    input.sandboxName,
    messagingTokenDefs,
  );
  const hasMessagingTokens = messagingTokenDefs.some(({ token }) => !!token);
  const reusableMessagingProviders: string[] = [];
  const reusableMessagingChannels: string[] = [];

  if (input.enabledChannels != null) {
    for (const { name, envKey, token } of messagingTokenDefs) {
      if (token) continue;
      const channel = input.getMessagingChannelForEnvKey(envKey);
      if (!channel || !input.enabledChannels.includes(channel)) continue;
      if (!input.providerExistsInGateway(name)) continue;
      reusableMessagingProviders.push(name);
      if (!reusableMessagingChannels.includes(channel)) {
        reusableMessagingChannels.push(channel);
      }
    }
  }

  return {
    disabledChannelNames,
    messagingTokenDefs,
    extraPlaceholderKeys,
    hasMessagingTokens,
    reusableMessagingProviders,
    reusableMessagingChannels,
    missingBraveApiKey,
  };
}
