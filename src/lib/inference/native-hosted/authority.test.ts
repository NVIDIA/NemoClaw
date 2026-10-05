// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { NATIVE_HOSTED_PROFILES } from "./profiles";
import {
  normalizeNativeHostedProviderAuthorities,
  resolveGatewayNativeHostedProviderAuthority,
  retainNativeHostedProviderAuthority,
} from "./authority";

const [nvidia, openai] = NATIVE_HOSTED_PROFILES;
const nvidiaReceipt = {
  schemaVersion: 1 as const,
  profileId: nvidia.profileId,
  providerName: nvidia.providerName,
  providerId: "nvidia-id",
};
const openaiReceipt = {
  schemaVersion: 1 as const,
  profileId: openai.profileId,
  providerName: openai.providerName,
  providerId: "openai-id",
};

describe("native hosted provider ownership", () => {
  it("retains each vendor identity across a provider round trip", () => {
    const receipts = retainNativeHostedProviderAuthority(
      retainNativeHostedProviderAuthority([nvidiaReceipt], openaiReceipt),
      nvidiaReceipt,
    );
    expect(receipts).toEqual([nvidiaReceipt, openaiReceipt]);
    expect(
      resolveGatewayNativeHostedProviderAuthority({
        profile: nvidia,
        gatewayName: "alpha",
        recordedGatewayName: "alpha",
        recordedAuthorities: receipts,
        gatewayAuthority: nvidiaReceipt,
        sandboxes: [],
      }),
    ).toEqual(nvidiaReceipt);
  });
  it("does not borrow proof from another gateway", () => {
    expect(
      resolveGatewayNativeHostedProviderAuthority({
        profile: nvidia,
        gatewayName: "alpha",
        sandboxes: [{ gatewayName: "beta", nativeHostedProviderAuthorities: [nvidiaReceipt] }],
      }),
    ).toBeUndefined();
  });
  it.each(["beta", undefined])(
    "does not use explicit proof from gateway %s",
    (recordedGatewayName) => {
      expect(
        resolveGatewayNativeHostedProviderAuthority({
          profile: nvidia,
          gatewayName: "alpha",
          recordedGatewayName,
          recordedAttachment: nvidiaReceipt,
          recordedAuthorities: [nvidiaReceipt],
          sandboxes: [],
        }),
      ).toBeUndefined();
    },
  );
  it("rejects legacy peer Slice 1 proof without gateway authority", () => {
    expect(
      resolveGatewayNativeHostedProviderAuthority({
        profile: nvidia,
        gatewayName: "alpha",
        sandboxes: [{ gatewayName: "alpha", nativeNvidiaProviderAuthority: nvidiaReceipt }],
      }),
    ).toBeUndefined();
  });
  it("refuses conflicting identities even when the current sandbox has a receipt", () => {
    expect(() =>
      resolveGatewayNativeHostedProviderAuthority({
        profile: nvidia,
        gatewayName: "alpha",
        recordedGatewayName: "alpha",
        recordedAttachment: nvidiaReceipt,
        gatewayAuthority: { ...nvidiaReceipt, providerId: "replacement" },
        sandboxes: [],
      }),
    ).toThrow("Conflicting");
  });
  it.each([null, {}, [null], [{ ...openaiReceipt, profileId: "user-owned" }]])(
    "rejects malformed ownership state %j",
    (value) => {
      expect(() => normalizeNativeHostedProviderAuthorities(value)).toThrow("Invalid");
    },
  );
});
