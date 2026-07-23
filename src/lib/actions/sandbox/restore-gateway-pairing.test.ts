// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { establishRestoredSandboxGatewayPairing } from "./restore-gateway-pairing";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("establishRestoredSandboxGatewayPairing", () => {
  it("provokes the scope upgrade before approving it", () => {
    const order: string[] = [];
    const warmupScopeUpgrade = vi.fn(() => order.push("warmup"));
    const autoPairScopeApproval = vi.fn(() => order.push("approve"));

    establishRestoredSandboxGatewayPairing("beta", { warmupScopeUpgrade, autoPairScopeApproval });

    expect(warmupScopeUpgrade).toHaveBeenCalledWith("beta");
    expect(autoPairScopeApproval).toHaveBeenCalledWith("beta");
    expect(order).toEqual(["warmup", "approve"]);
  });

  it("swallows a warm-up failure and still hands off without throwing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const warmupScopeUpgrade = vi.fn(() => {
      throw new Error("gateway not up");
    });
    const autoPairScopeApproval = vi.fn();

    expect(() =>
      establishRestoredSandboxGatewayPairing("beta", {
        warmupScopeUpgrade,
        autoPairScopeApproval,
      }),
    ).not.toThrow();
    expect(autoPairScopeApproval).not.toHaveBeenCalled();
    expect(warn.mock.calls.flat().join("\n")).toContain("gateway not up");
  });
});
