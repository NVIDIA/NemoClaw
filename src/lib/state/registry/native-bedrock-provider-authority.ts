// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { applyNativeBedrockProviderAuthority } from "./native-bedrock-provider-authority-state";

import type { NativeBedrockProviderAttachment } from "../../inference/native-bedrock/contract";
import { readNativeBedrockProviderAuthority } from "./native-bedrock-provider-authority-state";
import { withLock } from "./lock";
import { load, save } from "./persistence";

/** Forget only the confirmed removed identity, including sandbox-local receipts. */
export function clearNativeBedrockProviderAuthority(
  gatewayName: string,
  expected: NativeBedrockProviderAttachment,
): void {
  withLock(() => {
    const state = load();
    const current = readNativeBedrockProviderAuthority(state, gatewayName, expected.profileId);
    if (!current || current.providerId !== expected.providerId)
      throw new Error("Bedrock provider ownership changed during cleanup.");
    const profiles = { ...state.nativeBedrockProviderAuthorities?.[gatewayName] };
    delete profiles[expected.profileId];
    const authorities = { ...state.nativeBedrockProviderAuthorities };
    if (Object.keys(profiles).length) authorities[gatewayName] = profiles;
    else delete authorities[gatewayName];
    if (Object.keys(authorities).length) state.nativeBedrockProviderAuthorities = authorities;
    else delete state.nativeBedrockProviderAuthorities;
    for (const sandbox of Object.values(state.sandboxes)) {
      if (
        sandbox.gatewayName === gatewayName &&
        sandbox.nativeBedrockProviderAttachment?.providerId === expected.providerId &&
        sandbox.nativeBedrockProviderAttachment.profileId === expected.profileId
      )
        delete sandbox.nativeBedrockProviderAttachment;
    }
    save(state);
  });
}

export { getNativeBedrockProviderAuthority } from "./persistence";

export function setNativeBedrockProviderAuthority(
  gatewayName: string,
  receipt: import("../../inference/native-bedrock/contract").NativeBedrockProviderAttachment,
): void {
  withLock(() => {
    const state = load();
    if (applyNativeBedrockProviderAuthority(state, gatewayName, receipt)) save(state);
  });
}
