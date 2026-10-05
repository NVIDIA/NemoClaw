// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  normalizeNativeCompatibleProviderAttachment,
  type NativeCompatibleProviderAttachment,
} from "../../inference/native-compatible/contract";
import { isValidNativeProviderAuthorityGateway as isValidName } from "./native-nvidia-provider-authority-state";

export type NativeCompatibleProviderAuthorities = Record<
  string,
  Record<string, NativeCompatibleProviderAttachment>
>;
export interface NativeCompatibleProviderAuthorityState {
  nativeCompatibleProviderAuthorities?: NativeCompatibleProviderAuthorities;
}

export function normalizeNativeCompatibleProviderAuthorities(
  value: unknown,
): NativeCompatibleProviderAuthorities | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: NativeCompatibleProviderAuthorities = Object.create(null);
  for (const [gateway, profiles] of Object.entries(value)) {
    if (
      !isValidName(gateway) ||
      !profiles ||
      typeof profiles !== "object" ||
      Array.isArray(profiles)
    )
      continue;
    const entries: Record<string, NativeCompatibleProviderAttachment> = Object.create(null);
    for (const [profileId, value] of Object.entries(profiles)) {
      const receipt = normalizeNativeCompatibleProviderAttachment(value);
      if (receipt?.profileId === profileId) entries[profileId] = receipt;
    }
    if (Object.keys(entries).length) result[gateway] = entries;
  }
  return Object.keys(result).length ? result : undefined;
}

export function readNativeCompatibleProviderAuthority(
  state: NativeCompatibleProviderAuthorityState,
  gatewayName: string,
  profileId: string,
): NativeCompatibleProviderAttachment | undefined {
  if (!isValidName(gatewayName)) return undefined;
  const receipt = normalizeNativeCompatibleProviderAttachment(
    state.nativeCompatibleProviderAuthorities?.[gatewayName]?.[profileId],
  );
  return receipt?.profileId === profileId ? receipt : undefined;
}

export function applyNativeCompatibleProviderAuthority(
  state: NativeCompatibleProviderAuthorityState,
  gatewayName: string,
  value: NativeCompatibleProviderAttachment,
): boolean {
  const receipt = normalizeNativeCompatibleProviderAttachment(value);
  if (!isValidName(gatewayName) || !receipt)
    throw new Error("Cannot record invalid compatible provider authority.");
  const previous = readNativeCompatibleProviderAuthority(state, gatewayName, receipt.profileId);
  if (previous && previous.providerId !== receipt.providerId)
    throw new Error("Compatible provider identity changed. Ownership was retained.");
  if (previous) return false;
  state.nativeCompatibleProviderAuthorities = {
    ...state.nativeCompatibleProviderAuthorities,
    [gatewayName]: {
      ...state.nativeCompatibleProviderAuthorities?.[gatewayName],
      [receipt.profileId]: receipt,
    },
  };
  return true;
}
