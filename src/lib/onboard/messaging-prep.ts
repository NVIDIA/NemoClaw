// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WebSearchConfig } from "../inference/web-search";
import * as webSearch from "../inference/web-search";
import { listMessagingCredentialMetadata } from "../messaging/channels";
import { type ChannelDef, getChannelTokenKeys } from "../sandbox/channels";
import * as braveProviderProfile from "./brave-provider-profile";
import { extraPlaceholderProviderSlug } from "./extra-placeholder-keys";

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
  /** Rebuild-only provider/channel set validated before the old sandbox was removed. */
  authoritativeReuse?: {
    providers: readonly string[];
    channels: readonly string[];
    extraPlaceholderKeys: readonly string[];
  } | null;
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
  const authoritativeReuse = input.authoritativeReuse ?? null;
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
      token: authoritativeReuse
        ? null
        : input.getValidatedMessagingTokenByEnvKey(input.channels, credential.providerEnvKey),
    }))
    .filter(({ envKey }) => !enabledEnvKeys || enabledEnvKeys.has(envKey))
    .filter(({ envKey }) => !disabledEnvKeys.has(envKey));

  const braveWebSearchEnabled = braveProviderProfile.shouldEnableBraveWebSearch(
    input.webSearchConfig,
  );
  const braveProviderName = `${input.sandboxName}-brave-search`;
  const reusingBraveProvider = Boolean(authoritativeReuse?.providers.includes(braveProviderName));
  const braveApiKey =
    braveWebSearchEnabled && !authoritativeReuse
      ? input.getCredential(webSearch.BRAVE_API_KEY_ENV) ||
        input.normalizeCredentialValue(input.env[webSearch.BRAVE_API_KEY_ENV])
      : null;
  const missingBraveApiKey = braveWebSearchEnabled && !braveApiKey && !reusingBraveProvider;
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
      name: braveProviderName,
      envKey: webSearch.BRAVE_API_KEY_ENV,
      token: authoritativeReuse ? null : braveApiKey,
      providerType: braveProviderProfile.BRAVE_PROVIDER_PROFILE_ID,
    });
  }

  const extraPlaceholderKeys = authoritativeReuse
    ? [...new Set(authoritativeReuse.extraPlaceholderKeys)]
    : input.registerExtraPlaceholderProviders(input.sandboxName, messagingTokenDefs);
  if (authoritativeReuse) {
    for (const envKey of extraPlaceholderKeys) {
      messagingTokenDefs.push({
        name: `${input.sandboxName}-extra-${extraPlaceholderProviderSlug(envKey)}`,
        envKey,
        token: null,
        providerType: "generic",
      });
    }
  }
  const hasMessagingTokens = messagingTokenDefs.some(({ token }) => !!token);
  const reusableMessagingProviders: string[] = authoritativeReuse
    ? [...new Set(authoritativeReuse.providers)]
    : [];
  const reusableMessagingChannels: string[] = authoritativeReuse
    ? [...new Set(authoritativeReuse.channels)]
    : [];

  if (!authoritativeReuse && input.enabledChannels != null) {
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
