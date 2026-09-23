// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  establishRestoredSandboxGatewayPairing,
  type RestoreGatewayPairingDeps,
  restartRestoredSandboxGateway,
} from "./restore-gateway-pairing";

function pairingHarness(overrides: Partial<RestoreGatewayPairingDeps> = {}) {
  const order: string[] = [];
  const restartRestoredSandboxGateway = vi.fn(async () => {
    order.push("restart");
  });
  const warmupScopeUpgrade = vi.fn(() => order.push("warmup"));
  const approveRestoredClonePairing = vi.fn(() => {
    order.push("approve");
    return "approved-one" as const;
  });
  const verifyGatewayPairing = vi.fn(() => {
    order.push("verify");
    return { ok: true as const };
  });
  const deps: RestoreGatewayPairingDeps = {
    restartRestoredSandboxGateway,
    warmupScopeUpgrade,
    approveRestoredClonePairing,
    verifyGatewayPairing,
    ...overrides,
  };
  return {
    approveRestoredClonePairing,
    deps,
    order,
    restartRestoredSandboxGateway,
    verifyGatewayPairing,
    warmupScopeUpgrade,
  };
}

describe("establishRestoredSandboxGatewayPairing native lifecycle", () => {
  it("restarts before warm-up and after native pairing approval", async () => {
    const h = pairingHarness();

    await establishRestoredSandboxGatewayPairing("beta", h.deps);

    expect(h.order).toEqual(["restart", "warmup", "approve", "restart", "verify"]);
  });

  it("uses the native verifier as the success condition", async () => {
    const h = pairingHarness({
      approveRestoredClonePairing: vi
        .fn()
        .mockReturnValueOnce("list-pending-unavailable" as const)
        .mockReturnValueOnce("approved-one" as const),
      verifyGatewayPairing: vi
        .fn()
        .mockReturnValueOnce({
          ok: false as const,
          failureLayer: "scope-upgrade-pending" as const,
        })
        .mockReturnValueOnce({ ok: true as const }),
    });

    await establishRestoredSandboxGatewayPairing("beta", h.deps);

    expect(h.restartRestoredSandboxGateway).toHaveBeenCalledTimes(3);
    expect(h.deps.approveRestoredClonePairing).toHaveBeenCalledTimes(2);
    expect(h.deps.verifyGatewayPairing).toHaveBeenCalledTimes(2);
  });

  it("stops before pairing when native restart fails", async () => {
    const h = pairingHarness({
      restartRestoredSandboxGateway: vi.fn(async () => {
        throw new Error("native restart failed");
      }),
    });

    await expect(establishRestoredSandboxGatewayPairing("beta", h.deps)).rejects.toThrow(
      "unexpected-failure",
    );
    expect(h.warmupScopeUpgrade).not.toHaveBeenCalled();
    expect(h.approveRestoredClonePairing).not.toHaveBeenCalled();
  });
});

describe("restartRestoredSandboxGateway", () => {
  it("uses the native restart path exactly once", async () => {
    const restartSandboxGateway = vi.fn(async () => ({
      ok: true as const,
      restarted: true as const,
      healthPassed: true as const,
      forwardRecovered: true,
    }));

    await restartRestoredSandboxGateway("beta", { restartSandboxGateway });

    expect(restartSandboxGateway).toHaveBeenCalledExactlyOnceWith("beta", {
      quiet: true,
    });
  });

  it("propagates only the native failure classification", async () => {
    await expect(
      restartRestoredSandboxGateway("beta", {
        restartSandboxGateway: async () => ({
          ok: false,
          failureLayer: "native agent command",
          detail: "raw native output must stay private",
        }),
      }),
    ).rejects.toThrow("native agent command");
  });
});
