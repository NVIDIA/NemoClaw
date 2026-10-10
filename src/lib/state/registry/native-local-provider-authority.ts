// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  normalizeNativeLocalProviderAttachment,
  type NativeLocalProviderAttachment,
} from "../../inference/native-local/contract";
import { withLock } from "./lock";
import { load, save } from "./persistence";

export function getNativeLocalProviderAuthority(
  providerName: string,
): NativeLocalProviderAttachment | undefined {
  return normalizeNativeLocalProviderAttachment(
    load().nativeLocalProviderAuthorities?.[providerName],
  );
}

export function setNativeLocalProviderAuthority(receipt: NativeLocalProviderAttachment): void {
  const normalized = normalizeNativeLocalProviderAttachment(receipt);
  if (!normalized) throw new Error("Cannot record invalid native local provider authority.");
  withLock(() => {
    const data = load();
    const previous = data.nativeLocalProviderAuthorities?.[normalized.providerName];
    if (previous?.providerId === normalized.providerId) return;
    if (previous) throw new Error("Native local provider ownership changed before publication.");
    data.nativeLocalProviderAuthorities = {
      ...data.nativeLocalProviderAuthorities,
      [normalized.providerName]: normalized,
    };
    save(data);
  });
}

export function clearNativeLocalProviderAuthority(expected: NativeLocalProviderAttachment): void {
  withLock(() => {
    const data = load();
    const previous = data.nativeLocalProviderAuthorities?.[expected.providerName];
    if (!previous) return;
    if (previous.providerId !== expected.providerId)
      throw new Error("Native local provider ownership changed before cleanup.");
    delete data.nativeLocalProviderAuthorities![expected.providerName];
    save(data);
  });
}

/** Return only validated cleanup authority belonging to one sandbox and gateway. */
export function listNativeLocalProviderAuthorities(
  sandboxName: string,
  gatewayName: string,
): NativeLocalProviderAttachment[] {
  return Object.values(load().nativeLocalProviderAuthorities ?? {}).filter(
    (receipt) => receipt.sandboxName === sandboxName && receipt.gatewayName === gatewayName,
  );
}
