// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  applyNativeNvidiaProviderAuthority,
  normalizeNativeNvidiaProviderAuthorities,
  readNativeNvidiaProviderAuthority,
  removeNativeNvidiaProviderAuthority,
} from "./native-nvidia-provider-authority-state";

const receipt = {
  schemaVersion: 1 as const,
  profileId: "nemoclaw-nvidia-inference-v1" as const,
  providerName: "nemoclaw-nvidia-prod-v1" as const,
  providerId: "11111111-2222-4333-8444-555555555555",
};

describe("native NVIDIA gateway provider authority", () => {
  it("normalizes, reads, and removes gateway-scoped receipts", () => {
    const state: {
      nativeNvidiaProviderAuthorities?: Record<string, typeof receipt>;
    } = {};

    expect(applyNativeNvidiaProviderAuthority(state, "nemoclaw-19080", receipt)).toBe(true);
    expect(readNativeNvidiaProviderAuthority(state, "nemoclaw-19080")).toEqual(receipt);
    expect(removeNativeNvidiaProviderAuthority(state, "nemoclaw-19080")).toBe(true);
    expect(state.nativeNvidiaProviderAuthorities).toBeUndefined();
  });

  it("drops malformed receipts and sorts gateway keys", () => {
    expect(
      normalizeNativeNvidiaProviderAuthorities({
        zeta: receipt,
        broken: { ...receipt, providerId: "" },
        alpha: receipt,
      }),
    ).toEqual({ alpha: receipt, zeta: receipt });
  });
});
