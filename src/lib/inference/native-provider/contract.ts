// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import type { CustomNativeBinding } from "./custom";

export type NativeProviderAttachment<
  ProfileId extends string = string,
  ProviderName extends string = string,
> = Readonly<{
  schemaVersion: 1;
  profileId: ProfileId;
  providerName: ProviderName;
  providerId: string;
  /** Exact sandbox-facing endpoint for a dynamically bound provider. */
  endpointUrl?: string;
  /** Exact admitted destination addresses for a dynamically bound provider. */
  allowedIps?: readonly string[];
  custom?: CustomNativeBinding;
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
  /** Exact admitted destination addresses for a dynamically bound provider. */
  allowedIps?: readonly string[];
  custom?: CustomNativeBinding;
}>;

/** Keep only the exact profile/name binding and immutable provider identity. */
export function normalizeNativeProviderAttachment<P extends string, N extends string>(
  value: unknown,
  definition: Pick<
    NativeProviderDefinition<P, N>,
    "profileId" | "providerName" | "endpointUrl" | "allowedIps" | "custom"
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
    !isDeepStrictEqual(receipt.custom, definition.custom) ||
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
    ...(definition.custom ? { custom: definition.custom } : {}),
  };
}
