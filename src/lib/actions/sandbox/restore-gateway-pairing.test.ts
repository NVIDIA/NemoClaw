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
    const autoPairScopeApproval = vi.fn(() => order.push("approve"));
    const verifyGatewayPairing = vi.fn(() => {
      order.push("verify");
      return true;
    });

    await establishRestoredSandboxGatewayPairing("beta", {
      restartRestoredSandboxGateway,
      warmupScopeUpgrade,
      autoPairScopeApproval,
      verifyGatewayPairing,
    });

    expect(restartRestoredSandboxGateway).toHaveBeenCalledWith("beta");
    expect(warmupScopeUpgrade).toHaveBeenCalledWith("beta");
    expect(autoPairScopeApproval).toHaveBeenCalledWith("beta");
    expect(verifyGatewayPairing).toHaveBeenCalledWith("beta");
    expect(restartRestoredSandboxGateway).toHaveBeenCalledTimes(2);
    expect(order).toEqual(["restart", "warmup", "approve", "restart", "verify"]);
  });

  it("repeats the handshake once when verification creates a remaining scope upgrade (#7431)", async () => {
    const order: string[] = [];
    const verifyGatewayPairing = vi
      .fn()
      .mockImplementationOnce(() => {
        order.push("verify");
        return false;
      })
      .mockImplementationOnce(() => {
        order.push("verify");
        return true;
      });

    await establishRestoredSandboxGatewayPairing("beta", {
      restartRestoredSandboxGateway: vi.fn(() => {
        order.push("restart");
      }),
      warmupScopeUpgrade: vi.fn(() => order.push("warmup")),
      autoPairScopeApproval: vi.fn(() => order.push("approve")),
      verifyGatewayPairing,
    });

    expect(order).toEqual([
      "restart",
      "warmup",
      "approve",
      "restart",
      "verify",
      "warmup",
      "approve",
      "restart",
      "verify",
    ]);
  });

  it("restarts after each of two successive approved transitions before verification (#7431)", async () => {
    const transitions = ["pairing", "operator.write"];
    const order: string[] = [];
    let approvedTransitions = 0;
    let runningTransitions = 0;
    let pendingTransition: string | null = null;
    const restartRestoredSandboxGateway = vi.fn(() => {
      runningTransitions = approvedTransitions;
      order.push(`restart:${runningTransitions}`);
    });
    const warmupScopeUpgrade = vi.fn(() => {
      pendingTransition = transitions[approvedTransitions] ?? null;
      order.push(`warmup:${pendingTransition ?? "none"}`);
    });
    const autoPairScopeApproval = vi.fn(() => {
      order.push(`approve:${pendingTransition ?? "none"}`);
      expect(pendingTransition).toBe(transitions[approvedTransitions]);
      approvedTransitions += 1;
      pendingTransition = null;
    });
    const verifyGatewayPairing = vi.fn(() => {
      order.push(`verify:${runningTransitions}`);
      return runningTransitions === transitions.length;
    });

    await establishRestoredSandboxGatewayPairing("beta", {
      restartRestoredSandboxGateway,
      warmupScopeUpgrade,
      autoPairScopeApproval,
      verifyGatewayPairing,
    });

    expect(order).toEqual([
      "restart:0",
      "warmup:pairing",
      "approve:pairing",
      "restart:1",
      "verify:1",
      "warmup:operator.write",
      "approve:operator.write",
      "restart:2",
      "verify:2",
    ]);
    expect(restartRestoredSandboxGateway).toHaveBeenCalledTimes(3);
    expect(warmupScopeUpgrade).toHaveBeenCalledTimes(2);
    expect(autoPairScopeApproval).toHaveBeenCalledTimes(2);
    expect(verifyGatewayPairing).toHaveBeenCalledTimes(2);
  });

  it("fails before pairing when the restored gateway cannot restart (#7431)", async () => {
    const warmupScopeUpgrade = vi.fn();
    const autoPairScopeApproval = vi.fn();
    const verifyGatewayPairing = vi.fn(() => true);

    await expect(
      establishRestoredSandboxGatewayPairing("beta", {
        restartRestoredSandboxGateway: vi.fn(() => {
          throw new Error("gateway did not restart");
        }),
        warmupScopeUpgrade,
        autoPairScopeApproval,
        verifyGatewayPairing,
      }),
    ).rejects.toThrow("gateway did not restart");
    expect(warmupScopeUpgrade).not.toHaveBeenCalled();
    expect(autoPairScopeApproval).not.toHaveBeenCalled();
    expect(verifyGatewayPairing).not.toHaveBeenCalled();
  });

  it("fails when the pairing warm-up does not complete (#7431)", async () => {
    const warmupScopeUpgrade = vi.fn(() => {
      throw new Error("gateway not up");
    });
    const autoPairScopeApproval = vi.fn();
    const verifyGatewayPairing = vi.fn(() => true);

    await expect(
      establishRestoredSandboxGatewayPairing("beta", {
        restartRestoredSandboxGateway: vi.fn(() => {}),
        warmupScopeUpgrade,
        autoPairScopeApproval,
        verifyGatewayPairing,
      }),
    ).rejects.toThrow("gateway not up");
    expect(autoPairScopeApproval).not.toHaveBeenCalled();
    expect(verifyGatewayPairing).not.toHaveBeenCalled();
  });

  it("fails when two authenticated verification runs cannot use the restored gateway (#7431)", async () => {
    const restartRestoredSandboxGateway = vi.fn();
    const warmupScopeUpgrade = vi.fn();
    const autoPairScopeApproval = vi.fn();
    const verifyGatewayPairing = vi.fn(() => false);

    await expect(
      establishRestoredSandboxGatewayPairing("beta", {
        restartRestoredSandboxGateway,
        warmupScopeUpgrade,
        autoPairScopeApproval,
        verifyGatewayPairing,
      }),
    ).rejects.toThrow("authenticated gateway verification run did not succeed");
    expect(restartRestoredSandboxGateway).toHaveBeenCalledTimes(3);
    expect(warmupScopeUpgrade).toHaveBeenCalledTimes(2);
    expect(autoPairScopeApproval).toHaveBeenCalledTimes(2);
    expect(verifyGatewayPairing).toHaveBeenCalledTimes(2);
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

  it("propagates the classified gateway restart failure (#7431)", () => {
    expect(() =>
      restartRestoredSandboxGateway("beta", {
        restartSandboxGateway: () => ({
          ok: false,
          failureLayer: "health timeout",
          detail: "gateway process did not become healthy",
        }),
      }),
    ).toThrow("health timeout: gateway process did not become healthy");
  });
});
