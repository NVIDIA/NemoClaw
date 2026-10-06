// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { hasOtherNativeProviderReference } from "./retirement-references";

const receipt = { providerName: "owned-provider", profileId: "owned-profile" };
describe("native provider retirement references", () => {
  it.each(["nativeCompatibleProviderAttachment", "nativeBedrockProviderAttachment"] as const)(
    "retains a provider referenced by a pending peer through %s",
    (key) => {
      const peer = {
        name: "peer",
        gatewayName: "gateway",
        pendingRouteReservation: true,
        [key]: receipt,
      };
      expect(
        hasOtherNativeProviderReference({
          sandboxes: [peer],
          gatewayName: "gateway",
          sandboxName: "selected",
          expected: receipt,
        }),
      ).toBe(true);
    },
  );
  it("excludes only the selected sandbox and unrelated gateways", () => {
    const sandboxes = [
      { name: "selected", gatewayName: "gateway", nativeBedrockProviderAttachment: receipt },
      { name: "peer", gatewayName: "other", nativeBedrockProviderAttachment: receipt },
    ];
    expect(
      hasOtherNativeProviderReference({
        sandboxes,
        gatewayName: "gateway",
        sandboxName: "selected",
        expected: receipt,
      }),
    ).toBe(false);
  });
  it("retains references with an unknown gateway rather than assuming isolation", () => {
    expect(
      hasOtherNativeProviderReference({
        sandboxes: [{ name: "peer", nativeBedrockProviderAttachment: receipt }],
        gatewayName: "gateway",
        expected: receipt,
      }),
    ).toBe(true);
  });
});
