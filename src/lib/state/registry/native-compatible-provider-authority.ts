// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { NativeCompatibleProviderAttachment } from "../../inference/native-compatible/contract";
import { readNativeCompatibleProviderAuthority } from "./native-compatible-provider-authority-state";
import { withLock } from "./lock";
import { load, save } from "./persistence";

/** Forget only the confirmed removed identity, including sandbox-local receipts. */
export function clearNativeCompatibleProviderAuthority(
  gatewayName: string,
  expected: NativeCompatibleProviderAttachment,
): void {
  withLock(() => {
    const state = load();
    const current = readNativeCompatibleProviderAuthority(state, gatewayName, expected.profileId);
    if (!current || current.providerId !== expected.providerId)
      throw new Error("Compatible provider ownership changed during cleanup.");
    const profiles = { ...state.nativeCompatibleProviderAuthorities?.[gatewayName] };
    delete profiles[expected.profileId];
    const authorities = { ...state.nativeCompatibleProviderAuthorities };
    if (Object.keys(profiles).length) authorities[gatewayName] = profiles;
    else delete authorities[gatewayName];
    if (Object.keys(authorities).length) state.nativeCompatibleProviderAuthorities = authorities;
    else delete state.nativeCompatibleProviderAuthorities;
    for (const sandbox of Object.values(state.sandboxes)) {
      if (
        sandbox.gatewayName === gatewayName &&
        sandbox.nativeCompatibleProviderAttachment?.providerId === expected.providerId &&
        sandbox.nativeCompatibleProviderAttachment.profileId === expected.profileId
      )
        delete sandbox.nativeCompatibleProviderAttachment;
    }
    save(state);
  });
}

export { getNativeCompatibleProviderAuthority } from "./persistence";
