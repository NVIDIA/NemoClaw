// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { establishRestoredSandboxGatewayPairing } from "./restore-gateway-pairing";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("establishRestoredSandboxGatewayPairing", () => {
  it("provokes the scope upgrade before approving it (#7431)", () => {
    const order: string[] = [];
    const warmupScopeUpgrade = vi.fn(() => order.push("warmup"));
    const autoPairScopeApproval = vi.fn(() => order.push("approve"));
    const verifyGatewayPairing = vi.fn(() => {
      order.push("verify");
      return true;
    });

    establishRestoredSandboxGatewayPairing("beta", {
      warmupScopeUpgrade,
      autoPairScopeApproval,
      verifyGatewayPairing,
    });

    expect(warmupScopeUpgrade).toHaveBeenCalledWith("beta");
    expect(autoPairScopeApproval).toHaveBeenCalledWith("beta");
    expect(verifyGatewayPairing).toHaveBeenCalledWith("beta");
    expect(order).toEqual(["warmup", "approve", "verify"]);
  });

  it("fails when the pairing warm-up does not complete (#7431)", () => {
    const warmupScopeUpgrade = vi.fn(() => {
      throw new Error("gateway not up");
    });
    const autoPairScopeApproval = vi.fn();
    const verifyGatewayPairing = vi.fn(() => true);

    expect(() =>
      establishRestoredSandboxGatewayPairing("beta", {
        warmupScopeUpgrade,
        autoPairScopeApproval,
        verifyGatewayPairing,
      }),
    ).toThrow("gateway not up");
    expect(autoPairScopeApproval).not.toHaveBeenCalled();
    expect(verifyGatewayPairing).not.toHaveBeenCalled();
  });

  it("fails when the authenticated verification run cannot use the restored gateway (#7431)", () => {
    expect(() =>
      establishRestoredSandboxGatewayPairing("beta", {
        warmupScopeUpgrade: vi.fn(),
        autoPairScopeApproval: vi.fn(),
        verifyGatewayPairing: vi.fn(() => false),
      }),
    ).toThrow("authenticated gateway verification run did not succeed");
  });
});
