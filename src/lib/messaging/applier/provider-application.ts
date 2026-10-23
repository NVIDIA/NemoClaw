// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  WEB_SEARCH_PROVIDER_PROFILE_IDS,
  type WebSearchProviderProfileId,
} from "../../inference/web-search/provider-profile";
import { webSearchProviderProfilePath } from "./web-search-provider-profile";
import {
  buildMessagingBridgeRefreshMaterial,
  listMessagingBridgeProfiles,
  messagingBridgeProfilesForAgent,
  resolveMessagingBridgeSecret,
  type MessagingBridgeProfile,
  type RefreshingMessagingBridgeProfile,
} from "../../onboard/messaging-bridge-provider";
import type { MessagingTokenDef } from "../../onboard/messaging-prep";
import {
  messagingCredentialProviderProfilePath,
  MESSAGING_CREDENTIAL_PROVIDER_TYPE,
} from "../provider-profile";
import type {
  MessagingCredentialProviderEphemeralInput,
  MessagingProviderRefreshEphemeralInput,
} from "./types";

export interface BuildMessagingProviderApplicationInput {
  readonly tokenDefs: readonly MessagingTokenDef[];
  readonly root: string;
  readonly agent: string | null | undefined;
  readonly getCredential: (envKey: string) => string | null;
  readonly env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  readonly normalizeCredentialValue?: (value: unknown) => string;
  readonly channelIdForCredential?: (envKey: string, providerName: string) => string | null;
  readonly profiles?: readonly MessagingBridgeProfile[];
}

/** Process-memory-only inputs for one immediate provider application. */
export interface MessagingProviderEphemeralInputs {
  readonly definitions: readonly MessagingCredentialProviderEphemeralInput[];
  readonly refreshes: readonly MessagingProviderRefreshEphemeralInput[];
}

export function buildMessagingProviderApplication(
  input: BuildMessagingProviderApplicationInput,
): MessagingProviderEphemeralInputs {
  const profiles = messagingBridgeProfilesForAgent(
    input.agent,
    input.profiles ?? listMessagingBridgeProfiles({ root: input.root }),
  );
  const profilesByType = new Map(profiles.map((profile) => [profile.profileId, profile]));
  const definitions: MessagingCredentialProviderEphemeralInput[] = [];
  const refreshes: MessagingProviderRefreshEphemeralInput[] = [];

  for (const tokenDef of input.tokenDefs) {
    const providerType = tokenDef.providerType;
    if (!providerType) {
      throw new Error(
        `Messaging provider '${tokenDef.name}' has no explicit owned profile type. Re-run channel setup with a supported profile.`,
      );
    }
    const bridgeProfile = profilesByType.get(providerType);
    const profile = messagingProviderProfileForType(input.root, providerType, bridgeProfile);
    if (!profile) {
      throw new Error(
        `Messaging provider '${tokenDef.name}' has no NemoClaw-owned profile for type '${providerType}'. Re-run channel setup with a supported profile.`,
      );
    }
    const channelId =
      bridgeProfile?.channelId ??
      input.channelIdForCredential?.(tokenDef.envKey, tokenDef.name) ??
      "messaging";
    definitions.push({
      channelId,
      credentialId: tokenDef.envKey,
      providerName: tokenDef.name,
      providerType,
      credentials: [
        { name: tokenDef.envKey, value: normalizeToken(tokenDef.token) },
        ...(tokenDef.additionalCredentials ?? []).map(({ envKey, token }) => ({
          name: envKey,
          value: normalizeToken(token),
        })),
      ],
      ...(profile ? { profile } : {}),
    });
    if (bridgeProfile?.strategy) {
      refreshes.push(
        buildRefreshDefinition(
          tokenDef,
          { ...bridgeProfile, strategy: bridgeProfile.strategy },
          input,
        ),
      );
    }
  }

  return { definitions, refreshes };
}

export function messagingProviderProfileForType(
  root: string,
  providerType: string,
  bridgeProfile: MessagingBridgeProfile | undefined,
): MessagingCredentialProviderEphemeralInput["profile"] {
  if (bridgeProfile) {
    return { profilePath: bridgeProfile.profilePath, profileType: providerType };
  }
  if (providerType === MESSAGING_CREDENTIAL_PROVIDER_TYPE) {
    return {
      profilePath: messagingCredentialProviderProfilePath(root),
      profileType: providerType,
    };
  }
  if ((WEB_SEARCH_PROVIDER_PROFILE_IDS as readonly string[]).includes(providerType)) {
    return {
      profilePath: webSearchProviderProfilePath(root, providerType as WebSearchProviderProfileId),
      profileType: providerType,
    };
  }
  return undefined;
}

/** Check the same checked-in profile ownership boundary before external effects. */
export function hasNemoClawOwnedMessagingProviderProfile(
  root: string | undefined,
  agent: string | null | undefined,
  providerType: string,
): boolean {
  if (
    providerType === MESSAGING_CREDENTIAL_PROVIDER_TYPE ||
    (WEB_SEARCH_PROVIDER_PROFILE_IDS as readonly string[]).includes(providerType)
  ) {
    return true;
  }
  const bridgeProfile = messagingBridgeProfilesForAgent(
    agent,
    listMessagingBridgeProfiles({ root }),
  ).find((profile) => profile.profileId === providerType);
  return Boolean(bridgeProfile);
}

function buildRefreshDefinition(
  tokenDef: MessagingTokenDef,
  profile: RefreshingMessagingBridgeProfile,
  input: BuildMessagingProviderApplicationInput,
): MessagingProviderRefreshEphemeralInput {
  const secret = resolveMessagingBridgeSecret(profile.sourceSecretEnv, {
    getCredential: input.getCredential,
    env: input.env,
    normalizeCredentialValue: input.normalizeCredentialValue ?? normalizeUnknownCredential,
  });
  if (!secret) {
    throw new Error(
      `${profile.channelId} bridge secret material is unavailable for gateway token minting.`,
    );
  }
  const built = buildMessagingBridgeRefreshMaterial(profile, secret);
  if (!built.ok) {
    throw new Error(
      `${profile.channelId} bridge cannot configure gateway token minting: ${built.reason}.`,
    );
  }
  const secretKeys = new Set(built.secretKeys);
  return {
    channelId: profile.channelId,
    providerName: tokenDef.name,
    credentialKey: profile.credentialKey,
    strategy: profile.strategy,
    material: built.material.filter(({ key }) => !secretKeys.has(key)),
    secretMaterial: built.material.filter(({ key }) => secretKeys.has(key)),
  };
}

function normalizeToken(value: string | null): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\r/gu, "").trim();
  return normalized || null;
}

function normalizeUnknownCredential(value: unknown): string {
  return typeof value === "string" ? (normalizeToken(value) ?? "") : "";
}
