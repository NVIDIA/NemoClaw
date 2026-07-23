// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  establishRestoredSandboxGatewayPairing,
  RESTORE_GATEWAY_PAIRING_VERIFY_SCRIPT,
  RESTORE_GATEWAY_PAIRING_VERIFY_TIMEOUT_MS,
} from "./restore-gateway-pairing";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("establishRestoredSandboxGatewayPairing", () => {
  it("provokes the scope upgrade before approving it", () => {
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

  it("fails when the pairing warm-up does not complete", () => {
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

  it("fails when the authenticated verification run cannot use the restored gateway", () => {
    expect(() =>
      establishRestoredSandboxGatewayPairing("beta", {
        warmupScopeUpgrade: vi.fn(),
        autoPairScopeApproval: vi.fn(),
        verifyGatewayPairing: vi.fn(() => false),
      }),
    ).toThrow("authenticated gateway verification run did not succeed");
  });

  it("verifies the gateway without forcing a new pairing request", () => {
    expect(RESTORE_GATEWAY_PAIRING_VERIFY_TIMEOUT_MS).toBe(30_000);
    expect(RESTORE_GATEWAY_PAIRING_VERIFY_SCRIPT).toContain("openclaw agent --agent main --json");
    expect(RESTORE_GATEWAY_PAIRING_VERIFY_SCRIPT).toContain("scope upgrade pending approval");
    expect(RESTORE_GATEWAY_PAIRING_VERIFY_SCRIPT).toContain("transport");
    expect(RESTORE_GATEWAY_PAIRING_VERIFY_SCRIPT).not.toContain(
      "NEMOCLAW_OPENCLAW_FORCE_DEVICE_PAIRING",
    );
  });
});
