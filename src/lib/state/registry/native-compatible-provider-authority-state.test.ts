// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { nativeCompatibleEndpointIdentity } from "../../inference/native-compatible/endpoint";
import {
  applyNativeCompatibleProviderAuthority,
  normalizeNativeCompatibleProviderAuthorities,
  readNativeCompatibleProviderAuthority,
  type NativeCompatibleProviderAuthorityState,
} from "./native-compatible-provider-authority-state";

function receipt(endpointUrl: string) {
  const identity = nativeCompatibleEndpointIdentity({
    addresses: ["93.184.216.34"],
    endpointUrl,
    api: "openai-completions",
  });
  return {
    schemaVersion: 1 as const,
    profileId: identity.profileId,
    providerName: identity.providerName,
    providerId: identity.profileId,
    addresses: ["93.184.216.34"],
    endpointUrl: identity.endpoint,
    api: identity.api,
  };
}

describe("compatible provider authority", () => {
  it("retains independent endpoint ownership on one gateway", () => {
    const state: NativeCompatibleProviderAuthorityState = {};
    const first = receipt("https://one.example.com/v1");
    const second = receipt("https://two.example.com/v1");
    expect(applyNativeCompatibleProviderAuthority(state, "gateway", first)).toBe(true);
    expect(applyNativeCompatibleProviderAuthority(state, "gateway", second)).toBe(true);
    expect(readNativeCompatibleProviderAuthority(state, "gateway", first.profileId)).toEqual(first);
    expect(readNativeCompatibleProviderAuthority(state, "gateway", second.profileId)).toEqual(
      second,
    );
    expect(
      readNativeCompatibleProviderAuthority(state, "other-gateway", first.profileId),
    ).toBeUndefined();
  });
  it("refuses replacement of a recorded provider identity", () => {
    const state: NativeCompatibleProviderAuthorityState = {};
    const original = receipt("https://one.example.com/v1");
    applyNativeCompatibleProviderAuthority(state, "gateway", original);
    expect(() =>
      applyNativeCompatibleProviderAuthority(state, "gateway", {
        ...original,
        providerId: "replacement",
      }),
    ).toThrow("identity changed");
    expect(readNativeCompatibleProviderAuthority(state, "gateway", original.profileId)).toEqual(
      original,
    );
  });
  it("drops a receipt filed under another endpoint identity", () => {
    const original = receipt("https://one.example.com/v1");
    expect(
      normalizeNativeCompatibleProviderAuthorities({ gateway: { wrong: original } }),
    ).toBeUndefined();
  });
});
