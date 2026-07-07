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
  agentName?: string | null;
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
  missingWebSearchCredentialEnv: string | null;
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

  const webSearchEnabled = braveProviderProfile.shouldEnableWebSearch(input.webSearchConfig);
  const webSearchProvider = webSearch.webSearchProviderForConfig(input.webSearchConfig);
  const webSearchCredentialEnv = webSearch.webSearchEnvFor(webSearchProvider);
  const webSearchApiKey = webSearchEnabled
    ? input.getCredential(webSearchCredentialEnv) ||
      input.normalizeCredentialValue(input.env[webSearchCredentialEnv])
    : null;
  const missingWebSearchCredentialEnv =
    webSearchEnabled && !webSearchApiKey ? webSearchCredentialEnv : null;
  if (missingWebSearchCredentialEnv) {
    return {
      disabledChannelNames,
      messagingTokenDefs,
      extraPlaceholderKeys: [],
      hasMessagingTokens: messagingTokenDefs.some(({ token }) => !!token),
      reusableMessagingProviders: [],
      reusableMessagingChannels: [],
      missingWebSearchCredentialEnv,
    };
  }

  if (webSearchEnabled) {
    const providerType =
      webSearchProvider === "tavily" && input.agentName?.trim().toLowerCase() === "hermes"
        ? braveProviderProfile.HERMES_TAVILY_PROVIDER_PROFILE_ID
        : webSearchProvider;
    messagingTokenDefs.push({
      name: `${input.sandboxName}-${webSearchProvider}-search`,
      envKey: webSearchCredentialEnv,
      token: webSearchApiKey,
      providerType,
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
    missingWebSearchCredentialEnv,
  };
}
