// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  normalizeNativeBedrockProviderAttachment,
  type NativeBedrockProviderAttachment,
} from "../../inference/native-bedrock/contract";
import { isValidNativeProviderAuthorityGateway as isValidName } from "./native-nvidia-provider-authority-state";

export type NativeBedrockProviderAuthorities = Record<
  string,
  Record<string, NativeBedrockProviderAttachment>
>;
export interface NativeBedrockProviderAuthorityState {
  nativeBedrockProviderAuthorities?: NativeBedrockProviderAuthorities;
}

export function normalizeNativeBedrockProviderAuthorities(
  value: unknown,
): NativeBedrockProviderAuthorities | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: NativeBedrockProviderAuthorities = Object.create(null);
  for (const [gateway, profiles] of Object.entries(value)) {
    if (
      !isValidName(gateway) ||
      !profiles ||
      typeof profiles !== "object" ||
      Array.isArray(profiles)
    )
      continue;
    const entries: Record<string, NativeBedrockProviderAttachment> = Object.create(null);
    for (const [profileId, value] of Object.entries(profiles)) {
      const receipt = normalizeNativeBedrockProviderAttachment(value);
      if (receipt?.profileId === profileId && receipt.gatewayName === gateway)
        entries[profileId] = receipt;
    }
    if (Object.keys(entries).length) result[gateway] = entries;
  }
  return Object.keys(result).length ? result : undefined;
}

export function readNativeBedrockProviderAuthority(
  state: NativeBedrockProviderAuthorityState,
  gatewayName: string,
  profileId: string,
): NativeBedrockProviderAttachment | undefined {
  if (!isValidName(gatewayName)) return undefined;
  const receipt = normalizeNativeBedrockProviderAttachment(
    state.nativeBedrockProviderAuthorities?.[gatewayName]?.[profileId],
  );
  return receipt?.profileId === profileId && receipt.gatewayName === gatewayName
    ? receipt
    : undefined;
}

export function applyNativeBedrockProviderAuthority(
  state: NativeBedrockProviderAuthorityState,
  gatewayName: string,
  value: NativeBedrockProviderAttachment,
): boolean {
  const receipt = normalizeNativeBedrockProviderAttachment(value);
  if (!isValidName(gatewayName) || !receipt || receipt.gatewayName !== gatewayName)
    throw new Error("Cannot record invalid Bedrock provider authority.");
  const previous = readNativeBedrockProviderAuthority(state, gatewayName, receipt.profileId);
  if (previous && previous.providerId !== receipt.providerId)
    throw new Error("Compatible provider identity changed. Ownership was retained.");
  if (previous) return false;
  state.nativeBedrockProviderAuthorities = {
    ...state.nativeBedrockProviderAuthorities,
    [gatewayName]: {
      ...state.nativeBedrockProviderAuthorities?.[gatewayName],
      [receipt.profileId]: receipt,
    },
  };
  return true;
}
