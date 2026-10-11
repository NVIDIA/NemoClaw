// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  normalizeNativeNvidiaProviderAttachment,
  type NativeNvidiaProviderAttachment,
} from "../../inference/native-nvidia";
import type { NativeProviderAttachment } from "../../inference/native-provider/contract";
import { hostedNativeProvider } from "../../inference/native-provider/hosted";
import {
  hostedNativeProviderForAttachment,
  requireHostedProviderAttachment,
} from "../../inference/native-provider/hosted-attachment";
import { isValidName } from "../../name-validation";

export interface NativeNvidiaProviderAuthorityState {
  nativeNvidiaProviderAuthorities?: Record<string, NativeNvidiaProviderAttachment>;
}

export function normalizeNativeNvidiaProviderAuthorities(
  value: unknown,
): Record<string, NativeNvidiaProviderAttachment> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const normalized: Record<string, NativeNvidiaProviderAttachment> = Object.create(null);
  for (const [gatewayName, candidate] of Object.entries(value)) {
    const receipt = normalizeNativeNvidiaProviderAttachment(candidate);
    if (!isValidName(gatewayName) || !receipt) continue;
    normalized[gatewayName] = receipt;
  }
  const sorted = Object.fromEntries(
    Object.entries(normalized).sort(([left], [right]) => left.localeCompare(right)),
  );
  return Object.keys(sorted).length > 0 ? sorted : undefined;
}

export function readNativeNvidiaProviderAuthority(
  state: NativeNvidiaProviderAuthorityState,
  gatewayName: string,
): NativeNvidiaProviderAttachment | undefined {
  if (!isValidName(gatewayName)) return undefined;
  return normalizeNativeNvidiaProviderAttachment(
    state.nativeNvidiaProviderAuthorities?.[gatewayName],
  );
}

export function applyNativeNvidiaProviderAuthority(
  state: NativeNvidiaProviderAuthorityState,
  gatewayName: string,
  receipt: NativeNvidiaProviderAttachment,
): boolean {
  const normalized = normalizeNativeNvidiaProviderAttachment(receipt);
  if (!isValidName(gatewayName) || !normalized) return false;
  const previous = readNativeNvidiaProviderAuthority(state, gatewayName);
  if (previous?.providerId === normalized.providerId) return false;
  state.nativeNvidiaProviderAuthorities = {
    ...(state.nativeNvidiaProviderAuthorities ?? {}),
    [gatewayName]: normalized,
  };
  return true;
}

export function removeNativeNvidiaProviderAuthority(
  state: NativeNvidiaProviderAuthorityState,
  gatewayName: string,
): boolean {
  if (!isValidName(gatewayName) || !state.nativeNvidiaProviderAuthorities?.[gatewayName]) {
    return false;
  }
  const next = { ...state.nativeNvidiaProviderAuthorities };
  delete next[gatewayName];
  if (Object.keys(next).length > 0) state.nativeNvidiaProviderAuthorities = next;
  else delete state.nativeNvidiaProviderAuthorities;
  return true;
}

export type NativeHostedProviderAuthorities = Record<
  string,
  Record<string, NativeProviderAttachment>
>;

/** Keep independent ownership proof for every selected provider on a gateway. */
export function normalizeNativeHostedProviderAuthorities(
  value: unknown,
): NativeHostedProviderAuthorities | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const normalized: NativeHostedProviderAuthorities = Object.create(null);
  for (const [gateway, candidates] of Object.entries(value)) {
    if (
      !isValidName(gateway) ||
      !candidates ||
      typeof candidates !== "object" ||
      Array.isArray(candidates)
    )
      continue;
    const receipts: Record<string, NativeProviderAttachment> = Object.create(null);
    for (const [provider, candidate] of Object.entries(candidates)) {
      const definition = hostedNativeProviderForAttachment(candidate);
      const logicalProvider =
        hostedNativeProvider(provider)?.logicalProvider ??
        (definition?.providerName === provider ? definition.logicalProvider : undefined);
      if (!logicalProvider) continue;
      const receipt = requireHostedProviderAttachment(candidate, logicalProvider);
      if (receipt) receipts[provider] = receipt;
    }
    if (Object.keys(receipts).length) normalized[gateway] = receipts;
  }
  return Object.keys(normalized).length ? normalized : undefined;
}

/** Validate the gateway key before reading its independent native ownership records. */
export function readNativeHostedGatewayAuthorities(
  state: { nativeHostedProviderAuthorities?: NativeHostedProviderAuthorities },
  gateway: string,
): Record<string, NativeProviderAttachment> | undefined {
  return isValidName(gateway)
    ? (state.nativeHostedProviderAuthorities?.[gateway] ?? {})
    : undefined;
}
