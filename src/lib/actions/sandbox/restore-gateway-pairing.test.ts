// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  establishRestoredSandboxGatewayPairing,
  restartRestoredSandboxRuntime,
} from "./restore-gateway-pairing";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("establishRestoredSandboxGatewayPairing", () => {
  it("restarts restored runtime before provoking and approving the scope upgrade (#7431)", async () => {
    const order: string[] = [];
    const restartRestoredSandboxRuntime = vi.fn(async () => {
      order.push("restart");
    });
    const warmupScopeUpgrade = vi.fn(() => order.push("warmup"));
    const autoPairScopeApproval = vi.fn(() => order.push("approve"));
    const verifyGatewayPairing = vi.fn(() => {
      order.push("verify");
      return true;
    });

    await establishRestoredSandboxGatewayPairing("beta", {
      restartRestoredSandboxRuntime,
      warmupScopeUpgrade,
      autoPairScopeApproval,
      verifyGatewayPairing,
    });

    expect(restartRestoredSandboxRuntime).toHaveBeenCalledWith("beta");
    expect(warmupScopeUpgrade).toHaveBeenCalledWith("beta");
    expect(autoPairScopeApproval).toHaveBeenCalledWith("beta");
    expect(verifyGatewayPairing).toHaveBeenCalledWith("beta");
    expect(order).toEqual(["restart", "warmup", "approve", "verify"]);
  });

  it("repeats the handshake when first verification creates a remaining scope upgrade (#7431)", async () => {
    const order: string[] = [];
    const restartRestoredSandboxRuntime = vi.fn(async () => {
      order.push("restart");
    });
    const warmupScopeUpgrade = vi.fn(() => order.push("warmup"));
    const autoPairScopeApproval = vi.fn(() => order.push("approve"));
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
      restartRestoredSandboxRuntime,
      warmupScopeUpgrade,
      autoPairScopeApproval,
      verifyGatewayPairing,
    });

    expect(order).toEqual([
      "restart",
      "warmup",
      "approve",
      "verify",
      "warmup",
      "approve",
      "verify",
    ]);
  });

  it("fails when the restored runtime cannot restart (#7431)", async () => {
    const restartRestoredSandboxRuntime = vi.fn(async () => {
      throw new Error("container did not restart");
    });
    const warmupScopeUpgrade = vi.fn();
    const autoPairScopeApproval = vi.fn();
    const verifyGatewayPairing = vi.fn(() => true);

    await expect(
      establishRestoredSandboxGatewayPairing("beta", {
        restartRestoredSandboxRuntime,
        warmupScopeUpgrade,
        autoPairScopeApproval,
        verifyGatewayPairing,
      }),
    ).rejects.toThrow("container did not restart");
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
        restartRestoredSandboxRuntime: vi.fn(async () => {}),
        warmupScopeUpgrade,
        autoPairScopeApproval,
        verifyGatewayPairing,
      }),
    ).rejects.toThrow("gateway not up");
    expect(autoPairScopeApproval).not.toHaveBeenCalled();
    expect(verifyGatewayPairing).not.toHaveBeenCalled();
  });

  it("fails when the authenticated verification run cannot use the restored gateway (#7431)", async () => {
    const warmupScopeUpgrade = vi.fn();
    const autoPairScopeApproval = vi.fn();
    const verifyGatewayPairing = vi.fn(() => false);

    await expect(
      establishRestoredSandboxGatewayPairing("beta", {
        restartRestoredSandboxRuntime: vi.fn(async () => {}),
        warmupScopeUpgrade,
        autoPairScopeApproval,
        verifyGatewayPairing,
      }),
    ).rejects.toThrow("authenticated gateway verification run did not succeed");
    expect(warmupScopeUpgrade).toHaveBeenCalledTimes(2);
    expect(autoPairScopeApproval).toHaveBeenCalledTimes(2);
    expect(verifyGatewayPairing).toHaveBeenCalledTimes(2);
  });
});

describe("restartRestoredSandboxRuntime", () => {
  it("stops and starts the restored clone through its normal lifecycle (#7431)", async () => {
    const order: string[] = [];

    await restartRestoredSandboxRuntime("beta", {
      stopSandbox: (sandboxName) => {
        order.push(`stop:${sandboxName}`);
        return { exitCode: 0 };
      },
      startSandbox: async (sandboxName) => {
        order.push(`start:${sandboxName}`);
        return { exitCode: 0 };
      },
    });

    expect(order).toEqual(["stop:beta", "start:beta"]);
  });

  it("does not start when the restored clone cannot stop (#7431)", async () => {
    const startSandbox = vi.fn(async () => ({ exitCode: 0 }));

    await expect(
      restartRestoredSandboxRuntime("beta", {
        stopSandbox: () => ({ exitCode: 1, message: "stop failed" }),
        startSandbox,
      }),
    ).rejects.toThrow("stop failed");
    expect(startSandbox).not.toHaveBeenCalled();
  });

  it("fails when the restored clone cannot start (#7431)", async () => {
    await expect(
      restartRestoredSandboxRuntime("beta", {
        stopSandbox: () => ({ exitCode: 0 }),
        startSandbox: async () => ({ exitCode: 1, message: "start failed" }),
      }),
    ).rejects.toThrow("start failed");
  });
});
