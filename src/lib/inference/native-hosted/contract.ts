// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NATIVE_HOSTED_PROFILES } from "./profiles";

export type NativeHostedProviderAttachment = Readonly<{
  schemaVersion: 1;
  profileId: string;
  providerName: string;
  providerId: string;
}>;

export class NativeHostedProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeHostedProviderError";
  }
}

export function normalizeNativeHostedProviderAttachment(
  value: unknown,
  expectedProvider?: string,
): NativeHostedProviderAttachment | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const receipt = value as Record<string, unknown>;
  const profile = NATIVE_HOSTED_PROFILES.find(
    (entry) => entry.profileId === receipt.profileId && entry.providerName === receipt.providerName,
  );
  if (
    !profile ||
    (expectedProvider !== undefined && profile.logicalProvider !== expectedProvider.trim())
  )
    return undefined;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.profileId !== profile.profileId ||
    receipt.providerName !== profile.providerName ||
    typeof receipt.providerId !== "string" ||
    !receipt.providerId.trim()
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    profileId: profile.profileId,
    providerName: profile.providerName,
    providerId: receipt.providerId,
  };
}
