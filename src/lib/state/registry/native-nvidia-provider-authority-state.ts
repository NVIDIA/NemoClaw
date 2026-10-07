// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { normalizeNativeNvidiaProviderAttachment } from "../../inference/native-nvidia/contract";
import {
  normalizeNativeHostedProviderAuthorities,
  retainNativeHostedProviderAuthority,
} from "../../inference/native-hosted/authority";
import type { NativeHostedProviderAttachment } from "../../inference/native-hosted/contract";
import { isValidName } from "../../name-validation";

// Slice 1 receipts remain readable, but only the hosted map is runtime authority.
export function normalizeGatewayNativeHostedAuthorities(
  value: unknown,
  legacy: unknown = undefined,
): Record<string, NativeHostedProviderAttachment[]> | undefined {
  if (value === undefined && legacy === undefined) return undefined;
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value)))
    throw new Error("Invalid gateway native provider authorities");
  const entries = Object.entries(value ?? {}).map(([gatewayName, receipts]) => {
    if (!isValidName(gatewayName)) throw new Error("Invalid native provider authority gateway");
    return [gatewayName, normalizeNativeHostedProviderAuthorities(receipts) ?? []] as const;
  });
  const merged: Record<string, NativeHostedProviderAttachment[]> = Object.assign(
    Object.create(null),
    Object.fromEntries(entries),
  );
  if (legacy !== undefined) {
    if (!legacy || typeof legacy !== "object" || Array.isArray(legacy))
      throw new Error("Invalid legacy native NVIDIA provider authorities");
    for (const [gatewayName, candidate] of Object.entries(legacy)) {
      const receipt = normalizeNativeNvidiaProviderAttachment(candidate);
      if (!isValidName(gatewayName) || !receipt)
        throw new Error("Invalid legacy native NVIDIA provider authority");
      merged[gatewayName] = retainNativeHostedProviderAuthority(merged[gatewayName], receipt);
    }
  }
  return Object.fromEntries(
    Object.entries(merged).sort(([left], [right]) => left.localeCompare(right)),
  );
}

export { isValidName as isValidNativeProviderGateway };
