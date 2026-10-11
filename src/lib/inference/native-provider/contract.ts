// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

export type NativeProviderAttachment<
  ProfileId extends string = string,
  ProviderName extends string = string,
> = Readonly<{
  schemaVersion: 1;
  profileId: ProfileId;
  providerName: ProviderName;
  providerId: string;
  /** Present only for Hermes endpoints returned by authenticated login. */
  endpointUrl?: string;
  /** Exact public destination addresses for an authenticated Hermes endpoint. */
  allowedIps?: readonly string[];
}>;

export type NativeProviderDefinition<
  ProfileId extends string = string,
  ProviderName extends string = string,
> = Readonly<{
  logicalProvider: string;
  label: string;
  profileId: ProfileId;
  providerName: ProviderName;
  credentialEnv: string;
  endpointUrl?: string;
  /** Exact public destination addresses for an authenticated Hermes endpoint. */
  allowedIps?: readonly string[];
}>;

/** Keep only the exact profile/name binding and immutable provider identity. */
export function normalizeNativeProviderAttachment<P extends string, N extends string>(
  value: unknown,
  definition: Pick<
    NativeProviderDefinition<P, N>,
    "profileId" | "providerName" | "endpointUrl" | "allowedIps"
  >,
): NativeProviderAttachment<P, N> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const receipt = value as Record<string, unknown>;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.profileId !== definition.profileId ||
    receipt.providerName !== definition.providerName ||
    (definition.endpointUrl !== undefined && receipt.endpointUrl !== definition.endpointUrl) ||
    !isDeepStrictEqual(receipt.allowedIps, definition.allowedIps) ||
    typeof receipt.providerId !== "string" ||
    !receipt.providerId.trim()
  )
    return undefined;
  return {
    schemaVersion: 1,
    profileId: definition.profileId,
    providerName: definition.providerName,
    providerId: receipt.providerId,
    ...(definition.endpointUrl ? { endpointUrl: definition.endpointUrl } : {}),
    ...(definition.allowedIps ? { allowedIps: [...definition.allowedIps] } : {}),
  };
}
