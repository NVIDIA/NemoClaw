// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CONNECT_AUTO_PAIR_APPROVE_TIMEOUT_S,
  CONNECT_AUTO_PAIR_LIST_TIMEOUT_S,
} from "./connect-autopair-budget";
import {
  establishRestoredSandboxGatewayPairing,
  RESTORED_CLONE_PAIRING_TIMEOUT_MS,
  restartRestoredSandboxGateway,
} from "./restore-gateway-pairing";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("restored clone pairing budget", () => {
  it("covers credential convergence, stored-auth list, and one approval with startup slack", () => {
    const innerWorstCaseMs =
      (CONNECT_AUTO_PAIR_LIST_TIMEOUT_S * 2 + CONNECT_AUTO_PAIR_APPROVE_TIMEOUT_S) * 1000;

    expect(RESTORED_CLONE_PAIRING_TIMEOUT_MS).toBeGreaterThan(innerWorstCaseMs);
    expect(RESTORED_CLONE_PAIRING_TIMEOUT_MS - innerWorstCaseMs).toBeGreaterThanOrEqual(5000);
  });
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

  it("retries one failed clone approval when verification reports a pending scope upgrade (#7431)", async () => {
    const order: string[] = [];
    const restartRestoredSandboxGateway = vi.fn(() => order.push("restart"));
    const warmupScopeUpgrade = vi.fn(() => order.push("warmup"));
    const approveRestoredClonePairing = vi
      .fn()
      .mockImplementationOnce(() => {
        order.push("approve:failed");
        return "approve-failed" as const;
      })
      .mockImplementationOnce(() => {
        order.push("approve:succeeded");
        return "approved-one" as const;
      });
    const verifyGatewayPairing = vi
      .fn()
      .mockImplementationOnce(() => {
        order.push("verify:pending");
        return {
          ok: false as const,
          failureLayer: "scope-upgrade-pending" as const,
        };
      })
      .mockImplementationOnce(() => {
        order.push("verify:authenticated");
        return { ok: true as const };
      });

    await establishRestoredSandboxGatewayPairing("beta", {
      restartRestoredSandboxGateway,
      warmupScopeUpgrade,
      approveRestoredClonePairing,
      verifyGatewayPairing,
    });

    expect(order).toEqual([
      "restart",
      "warmup",
      "approve:failed",
      "restart",
      "verify:pending",
      "restart",
      "warmup",
      "approve:succeeded",
      "restart",
      "verify:authenticated",
    ]);
    expect(restartRestoredSandboxGateway).toHaveBeenCalledTimes(4);
    expect(warmupScopeUpgrade).toHaveBeenCalledTimes(2);
    expect(approveRestoredClonePairing).toHaveBeenCalledTimes(2);
    expect(verifyGatewayPairing).toHaveBeenCalledTimes(2);
  });

  it("fails after the bounded clone approval retry cannot authenticate pairing (#7431)", async () => {
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
    expect(restartRestoredSandboxGateway).toHaveBeenCalledTimes(4);
    expect(warmupScopeUpgrade).toHaveBeenCalledTimes(2);
    expect(approveRestoredClonePairing).toHaveBeenCalledTimes(2);
    expect(verifyGatewayPairing).toHaveBeenCalledTimes(2);
  });

  it("retries one failed credential-convergence list when verification reports a pending scope upgrade (#7431)", async () => {
    const order: string[] = [];
    const restartRestoredSandboxGateway = vi.fn(() => order.push("restart"));
    const warmupScopeUpgrade = vi.fn(() => order.push("warmup"));
    const approveRestoredClonePairing = vi
      .fn()
      .mockImplementationOnce(() => {
        order.push("approve:credential-list-failed");
        return "credential-list-failed" as const;
      })
      .mockImplementationOnce(() => {
        order.push("approve:succeeded");
        return "approved-one" as const;
      });
    const verifyGatewayPairing = vi
      .fn()
      .mockImplementationOnce(() => {
        order.push("verify:pending");
        return {
          ok: false as const,
          failureLayer: "scope-upgrade-pending" as const,
        };
      })
      .mockImplementationOnce(() => {
        order.push("verify:authenticated");
        return { ok: true as const };
      });

    await establishRestoredSandboxGatewayPairing("beta", {
      restartRestoredSandboxGateway,
      warmupScopeUpgrade,
      approveRestoredClonePairing,
      verifyGatewayPairing,
    });

    expect(order).toEqual([
      "restart",
      "warmup",
      "approve:credential-list-failed",
      "restart",
      "verify:pending",
      "restart",
      "warmup",
      "approve:succeeded",
      "restart",
      "verify:authenticated",
    ]);
    expect(restartRestoredSandboxGateway).toHaveBeenCalledTimes(4);
    expect(warmupScopeUpgrade).toHaveBeenCalledTimes(2);
    expect(approveRestoredClonePairing).toHaveBeenCalledTimes(2);
    expect(verifyGatewayPairing).toHaveBeenCalledTimes(2);
  });

  it("retries one timed-out stored-auth list for a pending scope upgrade, then fails closed (#7431)", async () => {
    const order: string[] = [];
    const restartRestoredSandboxGateway = vi.fn(() => order.push("restart"));
    const warmupScopeUpgrade = vi.fn(() => order.push("warmup"));
    const approveRestoredClonePairing = vi.fn(() => {
      order.push("approve:list-timeout");
      return "list-timeout" as const;
    });
    const verifyGatewayPairing = vi.fn(() => {
      order.push("verify:pending");
      return {
        ok: false as const,
        failureLayer: "scope-upgrade-pending" as const,
      };
    });

    await expect(
      establishRestoredSandboxGatewayPairing("beta", {
        restartRestoredSandboxGateway,
        warmupScopeUpgrade,
        approveRestoredClonePairing,
        verifyGatewayPairing,
      }),
    ).rejects.toThrow(
      "authenticated gateway verification run failed (scope-upgrade-pending; approval=list-timeout)",
    );
    expect(order).toEqual([
      "restart",
      "warmup",
      "approve:list-timeout",
      "restart",
      "verify:pending",
      "restart",
      "warmup",
      "approve:list-timeout",
      "restart",
      "verify:pending",
    ]);
    expect(restartRestoredSandboxGateway).toHaveBeenCalledTimes(4);
    expect(warmupScopeUpgrade).toHaveBeenCalledTimes(2);
    expect(approveRestoredClonePairing).toHaveBeenCalledTimes(2);
    expect(verifyGatewayPairing).toHaveBeenCalledTimes(2);
  });

  it("does not retry a failed clone list for an unrelated verifier failure (#7431)", async () => {
    const restartRestoredSandboxGateway = vi.fn();
    const warmupScopeUpgrade = vi.fn();
    const approveRestoredClonePairing = vi.fn(() => "list-failed" as const);
    const verifyGatewayPairing = vi.fn(() => ({
      ok: false as const,
      failureLayer: "gateway-connect-failure" as const,
    }));

    await expect(
      establishRestoredSandboxGatewayPairing("beta", {
        restartRestoredSandboxGateway,
        warmupScopeUpgrade,
        approveRestoredClonePairing,
        verifyGatewayPairing,
      }),
    ).rejects.toThrow(
      "authenticated gateway verification run failed (gateway-connect-failure; approval=list-failed)",
    );
    expect(restartRestoredSandboxGateway).toHaveBeenCalledTimes(2);
    expect(warmupScopeUpgrade).toHaveBeenCalledOnce();
    expect(approveRestoredClonePairing).toHaveBeenCalledOnce();
    expect(verifyGatewayPairing).toHaveBeenCalledOnce();
  });

  it("does not retry a failed clone approval for an unrelated verifier failure (#7431)", async () => {
    const restartRestoredSandboxGateway = vi.fn();
    const warmupScopeUpgrade = vi.fn();
    const approveRestoredClonePairing = vi.fn(() => "approve-failed" as const);
    const verifyGatewayPairing = vi.fn(() => ({
      ok: false as const,
      failureLayer: "gateway-connect-failure" as const,
    }));

    await expect(
      establishRestoredSandboxGatewayPairing("beta", {
        restartRestoredSandboxGateway,
        warmupScopeUpgrade,
        approveRestoredClonePairing,
        verifyGatewayPairing,
      }),
    ).rejects.toThrow(
      "authenticated gateway verification run failed (gateway-connect-failure; approval=approve-failed)",
    );
    expect(restartRestoredSandboxGateway).toHaveBeenCalledTimes(2);
    expect(warmupScopeUpgrade).toHaveBeenCalledOnce();
    expect(approveRestoredClonePairing).toHaveBeenCalledOnce();
    expect(verifyGatewayPairing).toHaveBeenCalledOnce();
  });

  it("does not retry a completed clone approval when verification remains pending (#7431)", async () => {
    const restartRestoredSandboxGateway = vi.fn();
    const warmupScopeUpgrade = vi.fn();
    const approveRestoredClonePairing = vi.fn(() => "approved-one" as const);
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
      "authenticated gateway verification run failed (scope-upgrade-pending; approval=approved-one)",
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
