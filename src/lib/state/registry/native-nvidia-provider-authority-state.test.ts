// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { normalizeGatewayNativeHostedAuthorities } from "./native-nvidia-provider-authority-state";

const receipt = {
  schemaVersion: 1 as const,
  profileId: "nemoclaw-nvidia-inference-v1",
  providerName: "nemoclaw-nvidia-prod-v1",
  providerId: "11111111-2222-4333-8444-555555555555",
};

describe("gateway native provider authority migration", () => {
  it("merges legacy NVIDIA ownership into sorted gateway records without duplicating identities", () => {
    expect(
      normalizeGatewayNativeHostedAuthorities(
        { zeta: [receipt] },
        { zeta: receipt, alpha: receipt },
      ),
    ).toEqual({ alpha: [receipt], zeta: [receipt] });
  });

  it("migrates a valid gateway name that matches an inherited object property", () => {
    expect(normalizeGatewayNativeHostedAuthorities(undefined, { constructor: receipt })).toEqual({
      constructor: [receipt],
    });
  });

  it("refuses conflicting legacy and hosted identities", () => {
    expect(() =>
      normalizeGatewayNativeHostedAuthorities(
        { alpha: [{ ...receipt, providerId: "replacement" }] },
        { alpha: receipt },
      ),
    ).toThrow("Conflicting native provider ownership receipts");
  });

  it.each([
    null,
    [],
    "invalid",
    { alpha: { ...receipt, providerId: "" } },
    { "../gateway": receipt },
  ])("refuses malformed legacy authority instead of dropping ownership: %j", (legacy) => {
    expect(() => normalizeGatewayNativeHostedAuthorities(undefined, legacy)).toThrow(
      "Invalid legacy native NVIDIA",
    );
  });
});
