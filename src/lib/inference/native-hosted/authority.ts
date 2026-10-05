// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  NativeHostedProviderError,
  normalizeNativeHostedProviderAttachment,
  type NativeHostedProviderAttachment,
} from "./contract";
import type { NativeHostedProfile } from "./profiles";

/** Retained receipts prove ownership even while another provider is selected. */
export function normalizeNativeHostedProviderAuthorities(
  value: unknown,
): NativeHostedProviderAttachment[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value))
    throw new NativeHostedProviderError("Invalid native provider ownership receipts.");
  const receipts = new Map<string, NativeHostedProviderAttachment>();
  for (const raw of value) {
    const receipt = normalizeNativeHostedProviderAttachment(raw);
    if (!receipt) throw new NativeHostedProviderError("Invalid native provider ownership receipt.");
    const previous = receipts.get(receipt.profileId);
    if (previous && previous.providerId !== receipt.providerId) {
      throw new NativeHostedProviderError(
        "Conflicting native provider ownership receipts. No provider was changed.",
      );
    }
    receipts.set(receipt.profileId, receipt);
  }
  return [...receipts.values()];
}

export function retainNativeHostedProviderAuthority(
  previous: unknown,
  receipt?: NativeHostedProviderAttachment,
): NativeHostedProviderAttachment[] {
  return normalizeNativeHostedProviderAuthorities([
    ...(normalizeNativeHostedProviderAuthorities(previous) ?? []),
    ...(receipt ? [receipt] : []),
  ])!;
}

export function resolveGatewayNativeHostedProviderAuthority(input: {
  profile: NativeHostedProfile;
  gatewayName: string;
  recordedGatewayName?: string | null;
  recordedAttachment?: NativeHostedProviderAttachment;
  recordedAuthorities?: unknown;
  sandboxes: ReadonlyArray<{
    gatewayName?: string | null;
    nativeHostedProviderAttachment?: unknown;
    nativeHostedProviderAuthorities?: unknown;
    nativeNvidiaProviderAttachment?: unknown;
    nativeNvidiaProviderAuthority?: unknown;
  }>;
}): NativeHostedProviderAttachment | undefined {
  const receipts: NativeHostedProviderAttachment[] = [];
  const collect = (raw: unknown) => {
    const receipt = normalizeNativeHostedProviderAttachment(raw);
    if (receipt?.profileId === input.profile.profileId) receipts.push(receipt);
  };
  if (input.recordedGatewayName === input.gatewayName) {
    collect(input.recordedAttachment);
    for (const receipt of normalizeNativeHostedProviderAuthorities(input.recordedAuthorities) ?? [])
      collect(receipt);
  }
  for (const sandbox of input.sandboxes) {
    if (sandbox.gatewayName !== input.gatewayName) continue;
    collect(sandbox.nativeHostedProviderAttachment);
    collect(sandbox.nativeNvidiaProviderAttachment);
    collect(sandbox.nativeNvidiaProviderAuthority);
    for (const receipt of normalizeNativeHostedProviderAuthorities(
      sandbox.nativeHostedProviderAuthorities,
    ) ?? [])
      collect(receipt);
  }
  return normalizeNativeHostedProviderAuthorities(receipts)?.[0];
}
