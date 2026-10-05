// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  normalizeNativeNvidiaProviderAttachment,
  type NativeNvidiaProviderAttachment,
} from "../../inference/native-nvidia";
import { normalizeNativeHostedProviderAuthorities } from "../../inference/native-hosted/authority";
import type { NativeHostedProviderAttachment } from "../../inference/native-hosted/contract";
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

export function normalizeGatewayNativeHostedAuthorities(
  value: unknown,
): Record<string, NativeHostedProviderAttachment[]> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid gateway native provider authorities");
  const entries = Object.entries(value).map(([gatewayName, receipts]) => {
    if (!isValidName(gatewayName)) throw new Error("Invalid native provider authority gateway");
    return [gatewayName, normalizeNativeHostedProviderAuthorities(receipts) ?? []] as const;
  });
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

export { isValidName as isValidNativeProviderGateway };
