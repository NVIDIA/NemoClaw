// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  establishRestoredSandboxGatewayPairing,
  type RestoreGatewayPairingDeps,
  restartRestoredSandboxGateway,
  waitForRestoredSandboxGatewaySupervisor,
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

  it("approves once when the first verifier publishes the clone scope upgrade (#7834)", async () => {
    const order: string[] = [];
    const restartRestoredSandboxGateway = vi.fn(() => order.push("restart"));
    const warmupScopeUpgrade = vi.fn(() => order.push("warmup"));
    const approveRestoredClonePairing = vi
      .fn<RestoreGatewayPairingDeps["approveRestoredClonePairing"]>(() => {
        order.push("approve");
        return "approved-one" as const;
      })
      .mockImplementationOnce(() => {
        order.push("approve");
        return "list-pending-unavailable" as const;
      });
    const verifyGatewayPairing = vi
      .fn<RestoreGatewayPairingDeps["verifyGatewayPairing"]>(() => {
        order.push("verify");
        return { ok: true as const };
      })
      .mockImplementationOnce(() => {
        order.push("verify");
        return {
          ok: false as const,
          failureLayer: "scope-upgrade-pending" as const,
        };
      });

    await establishRestoredSandboxGatewayPairing("beta", {
      restartRestoredSandboxGateway,
      warmupScopeUpgrade,
      approveRestoredClonePairing,
      verifyGatewayPairing,
    });

    expect(restartRestoredSandboxGateway).toHaveBeenCalledTimes(3);
    expect(approveRestoredClonePairing).toHaveBeenCalledTimes(2);
    expect(verifyGatewayPairing).toHaveBeenCalledTimes(2);
    expect(order).toEqual([
      "restart",
      "warmup",
      "approve",
      "restart",
      "verify",
      "approve",
      "restart",
      "verify",
    ]);
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
        restartRestoredSandboxGateway(sandboxName, {
          restartSandboxGateway,
          checkAndRecoverSandboxProcesses: vi.fn(),
        }),
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

  it("does not retry a different verification failure after an unreadable approval list (#7834)", async () => {
    const restartRestoredSandboxGateway = vi.fn();
    const warmupScopeUpgrade = vi.fn();
    const approveRestoredClonePairing = vi.fn(() => "list-failed" as const);
    const verifyGatewayPairing = vi.fn(() => ({
      ok: false as const,
      failureLayer: "device-pairing-required" as const,
    }));

    await expect(
      establishRestoredSandboxGatewayPairing("beta", {
        restartRestoredSandboxGateway,
        warmupScopeUpgrade,
        approveRestoredClonePairing,
        verifyGatewayPairing,
      }),
    ).rejects.toThrow(
      "authenticated gateway verification run failed (device-pairing-required; approval=list-failed)",
    );
    expect(restartRestoredSandboxGateway).toHaveBeenCalledTimes(2);
    expect(warmupScopeUpgrade).toHaveBeenCalledOnce();
    expect(approveRestoredClonePairing).toHaveBeenCalledOnce();
    expect(verifyGatewayPairing).toHaveBeenCalledOnce();
  });

  it("does not retry a scope upgrade after malformed clone pending state (#7834)", async () => {
    const restartRestoredSandboxGateway = vi.fn();
    const warmupScopeUpgrade = vi.fn();
    const approveRestoredClonePairing = vi.fn(() => "list-failed" as const);
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
      "authenticated gateway verification run failed (scope-upgrade-pending; approval=list-failed)",
    );
    expect(restartRestoredSandboxGateway).toHaveBeenCalledTimes(2);
    expect(approveRestoredClonePairing).toHaveBeenCalledOnce();
    expect(verifyGatewayPairing).toHaveBeenCalledOnce();
  });
});

describe("restartRestoredSandboxGateway", () => {
  it("requires the managed supervisor proof before restored clone state can be applied (#7818)", () => {
    const waitForManagedGatewaySupervisor = vi.fn(() => true);

    expect(
      waitForRestoredSandboxGatewaySupervisor("beta", {
        restartSandboxGateway: vi.fn(),
        checkAndRecoverSandboxProcesses: vi.fn(),
        waitForManagedGatewaySupervisor,
      }),
    ).toBe(true);
    expect(waitForManagedGatewaySupervisor).toHaveBeenCalledWith("beta");
  });

  it("restarts through the existing supervisor-mediated gateway lifecycle (#7431)", () => {
    const restartSandboxGateway = vi.fn(() => ({
      ok: true as const,
      restarted: true as const,
      healthPassed: true as const,
      forwardRecovered: true,
    }));
    const checkAndRecoverSandboxProcesses = vi.fn();

    restartRestoredSandboxGateway("beta", {
      restartSandboxGateway,
      checkAndRecoverSandboxProcesses,
    });

    expect(restartSandboxGateway).toHaveBeenCalledWith("beta", { quiet: true });
    expect(checkAndRecoverSandboxProcesses).not.toHaveBeenCalled();
  });

  it("transactionally relaunches an exactly missing restored supervisor (#7818)", () => {
    const restartSandboxGateway = vi.fn(() => ({
      ok: false as const,
      failureLayer: "supervisor not running" as const,
      detail: "SUPERVISOR_NOT_RUNNING",
    }));
    const checkAndRecoverSandboxProcesses = vi.fn(
      (
        _sandboxName: string,
        _options?: {
          quiet?: boolean;
          isSandboxGatewayRunningImpl?: (sandboxName: string) => boolean | null;
        },
      ) => ({
        checked: true,
        recovered: true,
        forwardRecovered: true,
      }),
    );

    restartRestoredSandboxGateway("beta", {
      restartSandboxGateway,
      checkAndRecoverSandboxProcesses,
    });

    expect(checkAndRecoverSandboxProcesses).toHaveBeenCalledWith("beta", {
      quiet: true,
      isSandboxGatewayRunningImpl: expect.any(Function),
    });
    const recoveryOptions = checkAndRecoverSandboxProcesses.mock.calls[0]?.[1];
    expect(recoveryOptions?.isSandboxGatewayRunningImpl?.("beta")).toBe(false);
  });

  it("waits for a newly created clone supervisor before retrying restart (#7818)", () => {
    const restartSandboxGateway = vi
      .fn()
      .mockReturnValueOnce({
        ok: false as const,
        failureLayer: "supervisor not running" as const,
        detail: "SUPERVISOR_NOT_RUNNING",
      })
      .mockReturnValueOnce({
        ok: true as const,
        restarted: true as const,
        healthPassed: true as const,
        forwardRecovered: true,
      });
    const checkAndRecoverSandboxProcesses = vi.fn();
    const waitForManagedGatewaySupervisor = vi.fn(() => true);

    restartRestoredSandboxGateway("beta", {
      restartSandboxGateway,
      checkAndRecoverSandboxProcesses,
      waitForManagedGatewaySupervisor,
    });

    expect(waitForManagedGatewaySupervisor).toHaveBeenCalledWith("beta");
    expect(restartSandboxGateway).toHaveBeenCalledTimes(2);
    expect(checkAndRecoverSandboxProcesses).not.toHaveBeenCalled();
  });

  it("preserves the supervisor classification when relaunch is not fully proven (#7818)", () => {
    const restartSandboxGateway = vi.fn(() => ({
      ok: false as const,
      failureLayer: "supervisor not running" as const,
      detail: "SUPERVISOR_NOT_RUNNING",
    }));
    const checkAndRecoverSandboxProcesses = vi.fn(() => ({
      checked: true,
      recovered: true,
      forwardRecovered: false,
      forwardRecoveryFailed: true,
    }));

    expect(() =>
      restartRestoredSandboxGateway("beta", {
        restartSandboxGateway,
        checkAndRecoverSandboxProcesses,
      }),
    ).toThrow("supervisor not running");
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
        checkAndRecoverSandboxProcesses: vi.fn(),
      });
    } catch (err) {
      failure = err;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("health timeout");
    expect((failure as Error).message).not.toContain("raw gateway output");
  });
});
