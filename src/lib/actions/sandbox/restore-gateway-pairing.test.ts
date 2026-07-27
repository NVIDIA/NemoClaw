// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  establishRestoredSandboxGatewayPairing,
  restartRestoredSandboxGateway,
} from "./restore-gateway-pairing";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("establishRestoredSandboxGatewayPairing", () => {
  it("restarts the restored gateway before warm-up and after approval (#7431)", async () => {
    const order: string[] = [];
    const restartRestoredSandboxGateway = vi.fn(() => {
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

    await establishRestoredSandboxGatewayPairing("beta", {
      restartRestoredSandboxGateway,
      warmupScopeUpgrade,
      approveRestoredClonePairing,
      verifyGatewayPairing,
    });

    expect(restartRestoredSandboxGateway).toHaveBeenCalledWith("beta");
    expect(warmupScopeUpgrade).toHaveBeenCalledWith("beta");
    expect(approveRestoredClonePairing).toHaveBeenCalledWith("beta");
    expect(verifyGatewayPairing).toHaveBeenCalledWith("beta");
    expect(restartRestoredSandboxGateway).toHaveBeenCalledTimes(2);
    expect(approveRestoredClonePairing).toHaveBeenCalledOnce();
    expect(verifyGatewayPairing).toHaveBeenCalledOnce();
    expect(order).toEqual(["restart", "warmup", "approve", "restart", "verify"]);
  });

  it("keeps the ordinary verifier as the sole success condition (#7431)", async () => {
    const restartRestoredSandboxGateway = vi.fn();
    const warmupScopeUpgrade = vi.fn();
    const approveRestoredClonePairing = vi.fn(() => "approve-failed" as const);
    const verifyGatewayPairing = vi.fn(() => ({ ok: true as const }));

    await establishRestoredSandboxGatewayPairing("beta", {
      restartRestoredSandboxGateway,
      warmupScopeUpgrade,
      approveRestoredClonePairing,
      verifyGatewayPairing,
    });

    expect(restartRestoredSandboxGateway).toHaveBeenCalledTimes(2);
    expect(warmupScopeUpgrade).toHaveBeenCalledOnce();
    expect(approveRestoredClonePairing).toHaveBeenCalledOnce();
    expect(verifyGatewayPairing).toHaveBeenCalledOnce();
  });

  it("fails before pairing when the restored gateway cannot restart (#7431)", async () => {
    const warmupScopeUpgrade = vi.fn();
    const approveRestoredClonePairing = vi.fn();
    const verifyGatewayPairing = vi.fn(() => ({ ok: true as const }));

    const failure = await establishRestoredSandboxGatewayPairing("beta", {
      restartRestoredSandboxGateway: vi.fn(() => {
        throw new Error("raw gateway output must stay private");
      }),
      warmupScopeUpgrade,
      approveRestoredClonePairing,
      verifyGatewayPairing,
    }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("unexpected-failure");
    expect((failure as Error).message).not.toContain("raw gateway output");
    expect(warmupScopeUpgrade).not.toHaveBeenCalled();
    expect(approveRestoredClonePairing).not.toHaveBeenCalled();
    expect(verifyGatewayPairing).not.toHaveBeenCalled();
  });

  it("classifies a transient-looking restart failure without retrying authorization (#7431)", async () => {
    const restartSandboxGateway = vi
      .fn()
      .mockReturnValueOnce({
        ok: false as const,
        failureLayer: "health timeout",
        detail: "raw transient output must stay private",
      })
      .mockReturnValueOnce({
        ok: true as const,
        restarted: true as const,
        healthPassed: true as const,
        forwardRecovered: true,
      });
    const warmupScopeUpgrade = vi.fn();
    const approveRestoredClonePairing = vi.fn();
    const verifyGatewayPairing = vi.fn(() => ({ ok: true as const }));

    const failure = await establishRestoredSandboxGatewayPairing("beta", {
      restartRestoredSandboxGateway: (sandboxName) =>
        restartRestoredSandboxGateway(sandboxName, { restartSandboxGateway }),
      warmupScopeUpgrade,
      approveRestoredClonePairing,
      verifyGatewayPairing,
    }).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("health timeout");
    expect((failure as Error).message).not.toContain("raw transient output");
    expect(restartSandboxGateway).toHaveBeenCalledOnce();
    expect(warmupScopeUpgrade).not.toHaveBeenCalled();
    expect(approveRestoredClonePairing).not.toHaveBeenCalled();
    expect(verifyGatewayPairing).not.toHaveBeenCalled();
  });

  it("fails without verification when the post-approval gateway restart fails (#7431)", async () => {
    const order: string[] = [];
    const restartRestoredSandboxGateway = vi
      .fn()
      .mockImplementationOnce(() => order.push("restart:initial"))
      .mockImplementationOnce(() => {
        order.push("restart:approved");
        throw new Error("gateway did not restart after approval");
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

    await expect(
      establishRestoredSandboxGatewayPairing("beta", {
        restartRestoredSandboxGateway,
        warmupScopeUpgrade,
        approveRestoredClonePairing,
        verifyGatewayPairing,
      }),
    ).rejects.toThrow("unexpected-failure");
    expect(order).toEqual(["restart:initial", "warmup", "approve", "restart:approved"]);
    expect(restartRestoredSandboxGateway).toHaveBeenCalledTimes(2);
    expect(verifyGatewayPairing).not.toHaveBeenCalled();
  });

  it("fails when the pairing warm-up does not complete (#7431)", async () => {
    const warmupScopeUpgrade = vi.fn(() => {
      throw new Error("gateway not up");
    });
    const approveRestoredClonePairing = vi.fn();
    const verifyGatewayPairing = vi.fn(() => ({ ok: true as const }));

    await expect(
      establishRestoredSandboxGatewayPairing("beta", {
        restartRestoredSandboxGateway: vi.fn(() => {}),
        warmupScopeUpgrade,
        approveRestoredClonePairing,
        verifyGatewayPairing,
      }),
    ).rejects.toThrow("unexpected-failure");
    expect(approveRestoredClonePairing).not.toHaveBeenCalled();
    expect(verifyGatewayPairing).not.toHaveBeenCalled();
  });

  it("fails after one ordinary verifier without retrying the handshake (#7431)", async () => {
    const restartRestoredSandboxGateway = vi.fn();
    const warmupScopeUpgrade = vi.fn();
    const approveRestoredClonePairing = vi.fn(() => "approve-failed" as const);
    const verifyGatewayPairing = vi.fn(() => ({
      ok: false as const,
      failureLayer: "scope-upgrade-pending" as const,
    }));

    await expect(
      establishRestoredSandboxGatewayPairing("beta", {
        restartRestoredSandboxGateway,
        warmupScopeUpgrade,
        approveRestoredClonePairing,
        verifyGatewayPairing,
      }),
    ).rejects.toThrow(
      "authenticated gateway verification run failed (scope-upgrade-pending; approval=approve-failed)",
    );
    expect(restartRestoredSandboxGateway).toHaveBeenCalledTimes(2);
    expect(warmupScopeUpgrade).toHaveBeenCalledOnce();
    expect(approveRestoredClonePairing).toHaveBeenCalledOnce();
    expect(verifyGatewayPairing).toHaveBeenCalledOnce();
  });
});

describe("restartRestoredSandboxGateway", () => {
  it("restarts through the existing supervisor-mediated gateway lifecycle (#7431)", () => {
    const restartSandboxGateway = vi.fn(() => ({
      ok: true as const,
      restarted: true as const,
      healthPassed: true as const,
      forwardRecovered: true,
    }));

    restartRestoredSandboxGateway("beta", { restartSandboxGateway });

    expect(restartSandboxGateway).toHaveBeenCalledWith("beta", { quiet: true });
  });

  it("propagates only the classified gateway restart failure (#7431)", () => {
    let failure: unknown;
    try {
      restartRestoredSandboxGateway("beta", {
        restartSandboxGateway: () => ({
          ok: false,
          failureLayer: "health timeout",
          detail: "raw gateway output must stay private",
        }),
      });
    } catch (err) {
      failure = err;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("health timeout");
    expect((failure as Error).message).not.toContain("raw gateway output");
  });
});
