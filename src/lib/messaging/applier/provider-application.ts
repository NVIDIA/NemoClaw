// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import YAML from "yaml";

import { providerProfileContractDigest } from "../../adapters/openshell/provider-profile-contract";
import type {
  MessagingCredentialProviderDefinition,
  MessagingCredentialProviderProfile,
  MessagingProviderRefreshDefinition,
} from "./types";
import {
  messagingCredentialProviderProfilePath,
  MESSAGING_CREDENTIAL_PROVIDER_TYPE,
} from "../provider-profile";
import {
  buildMessagingBridgeRefreshMaterial,
  listMessagingBridgeProfiles,
  messagingBridgeProfilesForAgent,
  resolveMessagingBridgeSecret,
  type MessagingBridgeProfile,
  type RefreshingMessagingBridgeProfile,
} from "../../onboard/messaging-bridge-provider";
import type { MessagingTokenDef } from "../../onboard/messaging-prep";

export interface BuildMessagingProviderApplicationInput {
  readonly tokenDefs: readonly MessagingTokenDef[];
  readonly root: string;
  readonly agent: string | null | undefined;
  readonly getCredential: (envKey: string) => string | null;
  readonly env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  readonly normalizeCredentialValue?: (value: unknown) => string;
  readonly channelIdForCredential?: (envKey: string, providerName: string) => string | null;
  readonly profiles?: readonly MessagingBridgeProfile[];
  readonly readFileSync?: (file: string) => string;
}

export interface MessagingProviderApplicationPlan {
  readonly messagingTokenDefs: readonly MessagingTokenDef[];
  readonly otherTokenDefs: readonly MessagingTokenDef[];
  readonly definitions: readonly MessagingCredentialProviderDefinition[];
  readonly refreshes: readonly MessagingProviderRefreshDefinition[];
}

export interface ResolveCheckedInMessagingProviderProfileInput {
  readonly root: string;
  readonly profileType: string;
  readonly profiles?: readonly MessagingBridgeProfile[];
  readonly readFileSync?: (file: string) => string;
}

/** Read the checked-in contract used to verify an existing static messaging provider. */
export function resolveCheckedInMessagingProviderProfile(
  input: ResolveCheckedInMessagingProviderProfileInput,
): Extract<MessagingCredentialProviderProfile, { kind: "checked-in" }> | null {
  const profile = (input.profiles ?? listMessagingBridgeProfiles({ root: input.root })).find(
    (candidate) => candidate.profileId === input.profileType && candidate.strategy === null,
  );
  if (!profile) return null;
  return checkedInProfile(
    profile,
    input.readFileSync ?? ((file: string) => fs.readFileSync(file, "utf8")),
  );
}

/** Convert onboarding token definitions into the typed messaging-provider boundary. */
export function buildMessagingProviderApplication(
  input: BuildMessagingProviderApplicationInput,
): MessagingProviderApplicationPlan {
  const profiles = messagingBridgeProfilesForAgent(
    input.agent,
    input.profiles ?? listMessagingBridgeProfiles({ root: input.root }),
  );
  const profilesByType = new Map(profiles.map((profile) => [profile.profileId, profile]));
  const messagingTokenDefs: MessagingTokenDef[] = [];
  const otherTokenDefs: MessagingTokenDef[] = [];
  const definitions: MessagingCredentialProviderDefinition[] = [];
  const refreshes: MessagingProviderRefreshDefinition[] = [];
  const readFileSync = input.readFileSync ?? ((file: string) => fs.readFileSync(file, "utf8"));

  for (const tokenDef of input.tokenDefs) {
    const profileType = tokenDef.providerType ?? "generic";
    const bridgeProfile = profilesByType.get(profileType);
    if (profileType !== MESSAGING_CREDENTIAL_PROVIDER_TYPE && !bridgeProfile) {
      otherTokenDefs.push(tokenDef);
      continue;
    }
    messagingTokenDefs.push(tokenDef);
    const channelId =
      bridgeProfile?.channelId ??
      input.channelIdForCredential?.(tokenDef.envKey, tokenDef.name) ??
      "messaging";
    const profile = bridgeProfile
      ? checkedInProfile(bridgeProfile, readFileSync)
      : endpointlessProfile(input.root);
    definitions.push({
      channelId,
      credentialId: tokenDef.envKey,
      providerName: tokenDef.name,
      providerType: profileType,
      credentials: [
        { name: tokenDef.envKey, value: normalizeToken(tokenDef.token) },
        ...(tokenDef.additionalCredentials ?? []).map(({ envKey, token }) => ({
          name: envKey,
          value: normalizeToken(token),
        })),
      ],
      profile,
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
  return { messagingTokenDefs, otherTokenDefs, definitions, refreshes };
}

function endpointlessProfile(root: string): MessagingCredentialProviderProfile {
  return {
    kind: "endpointless",
    profilePath: messagingCredentialProviderProfilePath(root),
    profileType: MESSAGING_CREDENTIAL_PROVIDER_TYPE,
    inferenceCapable: false,
  };
}

function checkedInProfile(
  profile: MessagingBridgeProfile,
  readFileSync: (file: string) => string,
): Extract<MessagingCredentialProviderProfile, { kind: "checked-in" }> {
  let parsed: unknown;
  try {
    parsed = YAML.parse(readFileSync(profile.profilePath));
  } catch (error) {
    throw new Error(
      `Could not read the checked-in '${profile.profileId}' messaging provider profile.`,
      { cause: error },
    );
  }
  const contractDigest = providerProfileContractDigest(parsed);
  if (!contractDigest) {
    throw new Error(
      `The checked-in '${profile.profileId}' messaging provider profile is malformed.`,
    );
  }
  return {
    kind: "checked-in",
    profilePath: profile.profilePath,
    profileType: profile.profileId,
    contractDigest,
  };
}

function buildRefreshDefinition(
  tokenDef: MessagingTokenDef,
  profile: RefreshingMessagingBridgeProfile,
  input: BuildMessagingProviderApplicationInput,
): MessagingProviderRefreshDefinition {
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
