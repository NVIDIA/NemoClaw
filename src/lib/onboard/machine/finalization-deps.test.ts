// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { VerifyDeploymentResult } from "../../verify-deployment";
import {
  OPENCLAW_PAIRING_OBSERVATION_TIMEOUT_MS,
  type OpenClawPairingSettlementObservation,
} from "../../actions/sandbox/launch-readiness/openclaw-pairing-qualification";
import { WARMUP_TIMEOUT_MS } from "../../actions/sandbox/auto-pair-warmup";
import { CONNECT_AUTO_PAIR_TIMEOUT_MS } from "../../actions/sandbox/connect-autopair-budget";
import { withGatewayRouteMutationLock } from "../../inference/gateway-route-mutation-lock";
import { withMcpLifecycleLock } from "../../state/mcp-lifecycle-lock";
import {
  finalizationHandlerDeps,
  finalizationHandlerRuntime,
  OPENCLAW_ONBOARDING_PAIRING_FINAL_OBSERVATION_TIMEOUT_MS,
  OPENCLAW_ONBOARDING_PAIRING_SETTLEMENT_TIMEOUT_MS,
  OPENCLAW_ONBOARDING_PAIRING_TIMEOUT_MS,
  ordinaryOpenClawPairingIncompleteMessage,
  settleOrdinaryOpenClawPairing,
} from "./finalization-deps";

const PAIRING_TARGET = {
  gatewayName: "nemoclaw",
  lifecycleGeneration: "generation-1",
  lifecycleLiveIdentityFingerprint: "fingerprint-1",
  stateDirectory: "/sandbox/.openclaw",
  version: "2026.7.1",
};

const PAIRING_ONLY: OpenClawPairingSettlementObservation = {
  state: "pairing-only",
  deviceIdentitySha256: "a".repeat(64),
};

const SCOPE_UPGRADE_PENDING: OpenClawPairingSettlementObservation = {
  state: "scope-upgrade-pending",
  deviceIdentitySha256: PAIRING_ONLY.deviceIdentitySha256,
};

const SETTLED: OpenClawPairingSettlementObservation = {
  state: "settled",
  deviceIdentitySha256: PAIRING_ONLY.deviceIdentitySha256,
};

function ordinaryPairingDeps(
  overrides: Partial<Parameters<typeof settleOrdinaryOpenClawPairing>[1]> = {},
) {
  let now = 0;
  const calls: string[] = [];
  const deps = {
    getTarget: vi.fn(() => PAIRING_TARGET),
    observePairing: vi.fn(() => SETTLED),
    runWarmup: vi.fn(() => {
      calls.push("warmup");
    }),
    runApproval: vi.fn(() => {
      calls.push("approval");
    }),
    withSandboxLock: vi.fn(async (_name, operation) => operation()),
    withGatewayLock: vi.fn(async (_gatewayName, operation) => operation()),
    now: vi.fn(() => now),
    sleep: vi.fn(async (milliseconds: number) => {
      calls.push("sleep");
      now += milliseconds;
    }),
    ...overrides,
  };
  return { calls, deps };
}

describe("ordinary OpenClaw pairing settlement", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts one already-settled canonical CLI device without running a producer (#10014)", async () => {
    const scope = ordinaryPairingDeps();

    await expect(settleOrdinaryOpenClawPairing("alpha", scope.deps)).resolves.toEqual({
      kind: "settled",
    });

    expect(scope.deps.observePairing).toHaveBeenCalledExactlyOnceWith(
      "alpha",
      "nemoclaw",
      "2026.7.1",
      "/sandbox/.openclaw",
    );
    expect(scope.deps.runWarmup).not.toHaveBeenCalled();
    expect(scope.deps.runApproval).not.toHaveBeenCalled();
  });

  it("reuses an exact pending upgrade without running another producer (#10014)", async () => {
    const scope = ordinaryPairingDeps({
      observePairing: vi
        .fn()
        .mockReturnValueOnce(SCOPE_UPGRADE_PENDING)
        .mockReturnValueOnce(SETTLED),
    });

    await expect(settleOrdinaryOpenClawPairing("alpha", scope.deps)).resolves.toEqual({
      kind: "settled",
    });

    expect(scope.deps.runWarmup).not.toHaveBeenCalled();
    expect(scope.deps.runApproval).toHaveBeenCalledExactlyOnceWith("alpha", "nemoclaw");
  });

  it("runs the canonical request probe before waiting for fresh pairing (#10014)", async () => {
    const observePairing = vi
      .fn(() => SCOPE_UPGRADE_PENDING)
      .mockImplementationOnce(() => {
        throw new Error("not published");
      })
      .mockReturnValueOnce(PAIRING_ONLY);
    const scope = ordinaryPairingDeps({
      observePairing,
      runWarmup: vi.fn(() => {
        scope.calls.push("warmup");
      }),
      runApproval: vi.fn(() => {
        scope.calls.push("approval");
        vi.mocked(scope.deps.observePairing).mockReturnValue(SETTLED);
      }),
    });

    await expect(settleOrdinaryOpenClawPairing("alpha", scope.deps)).resolves.toEqual({
      kind: "settled",
    });

    expect(scope.calls).toEqual(["warmup", "sleep", "approval"]);
    expect(scope.deps.runWarmup).toHaveBeenCalledExactlyOnceWith("alpha", "nemoclaw");
    expect(scope.deps.runApproval).toHaveBeenCalledExactlyOnceWith("alpha", "nemoclaw");
  });

  it("holds lifecycle then gateway-route ownership across the full settlement (#9844)", async () => {
    const events: string[] = [];
    const scope = ordinaryPairingDeps({
      observePairing: vi
        .fn()
        .mockImplementationOnce(() => {
          events.push("observe:precheck");
          return PAIRING_ONLY;
        })
        .mockImplementationOnce(() => {
          events.push("observe:pending");
          return SCOPE_UPGRADE_PENDING;
        })
        .mockImplementation(() => {
          events.push("observe:final");
          return SETTLED;
        }),
      runWarmup: vi.fn(() => {
        events.push("warmup");
      }),
      runApproval: vi.fn(() => {
        events.push("approval");
      }),
      withSandboxLock: vi.fn(async (_name, operation) => {
        events.push("sandbox-lock:start");
        const result = await operation();
        events.push("sandbox-lock:end");
        return result;
      }),
      withGatewayLock: vi.fn(async (_gatewayName, operation) => {
        events.push("gateway-lock:start");
        const result = await operation();
        events.push("gateway-lock:end");
        return result;
      }),
    });

    await expect(settleOrdinaryOpenClawPairing("alpha", scope.deps)).resolves.toEqual({
      kind: "settled",
    });

    expect(events).toEqual([
      "sandbox-lock:start",
      "gateway-lock:start",
      "observe:precheck",
      "warmup",
      "observe:pending",
      "approval",
      "observe:final",
      "gateway-lock:end",
      "sandbox-lock:end",
    ]);
  });

  it("blocks real lifecycle and route mutations until pairing settlement exits (#9844)", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-pairing-locks-"));
    let currentTarget = PAIRING_TARGET;
    let releaseApproval = () => {};
    let reportApprovalStarted = () => {};
    const approvalPending = new Promise<void>((resolve) => {
      releaseApproval = resolve;
    });
    const approvalStarted = new Promise<void>((resolve) => {
      reportApprovalStarted = resolve;
    });
    const mutationEvents: string[] = [];
    const approvalTargets: string[] = [];
    const lockOptions = { pollIntervalMs: 1, stateDir, timeoutMs: 5_000 };
    let replacement: Promise<void> | undefined;
    let routeReuse: Promise<void> | undefined;
    try {
      const scope = ordinaryPairingDeps({
        getTarget: vi.fn(() => currentTarget),
        observePairing: vi
          .fn()
          .mockReturnValueOnce(PAIRING_ONLY)
          .mockReturnValueOnce(SCOPE_UPGRADE_PENDING)
          .mockReturnValue(SETTLED),
        runApproval: vi.fn(async (_name, gatewayName) => {
          approvalTargets.push(`${currentTarget.lifecycleGeneration}:${gatewayName}`);
          reportApprovalStarted();
          await approvalPending;
        }),
        withSandboxLock: (name, operation) => withMcpLifecycleLock(name, operation, lockOptions),
        withGatewayLock: (gatewayName, operation) =>
          withGatewayRouteMutationLock(gatewayName, operation, lockOptions),
      });

      const settlement = settleOrdinaryOpenClawPairing("alpha", scope.deps);
      await approvalStarted;
      replacement = withMcpLifecycleLock(
        "alpha",
        () => {
          mutationEvents.push("replacement-entered");
          currentTarget = { ...PAIRING_TARGET, lifecycleGeneration: "generation-2" };
        },
        lockOptions,
      );
      routeReuse = withGatewayRouteMutationLock(
        "nemoclaw",
        () => {
          mutationEvents.push("route-reuse-entered");
        },
        lockOptions,
      );

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(mutationEvents).toEqual([]);
      expect(approvalTargets).toEqual(["generation-1:nemoclaw"]);

      releaseApproval();
      await expect(settlement).resolves.toEqual({ kind: "settled" });
      await Promise.all([replacement, routeReuse]);
      expect(mutationEvents).toEqual(
        expect.arrayContaining(["replacement-entered", "route-reuse-entered"]),
      );
      expect(currentTarget.lifecycleGeneration).toBe("generation-2");
    } finally {
      releaseApproval();
      const pendingMutations = [replacement, routeReuse].filter(
        (mutation): mutation is Promise<void> => mutation !== undefined,
      );
      await Promise.allSettled(pendingMutations);
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("reports unavailable when pairing lock acquisition fails (#9844)", async () => {
    const scope = ordinaryPairingDeps({
      withGatewayLock: vi.fn(async () => {
        throw new Error("lock timeout");
      }),
    });

    await expect(settleOrdinaryOpenClawPairing("alpha", scope.deps)).resolves.toEqual({
      kind: "incomplete",
      reason: "pairing-lock-unavailable",
    });
    expect(scope.deps.observePairing).not.toHaveBeenCalled();
    expect(scope.deps.runWarmup).not.toHaveBeenCalled();
    expect(scope.deps.runApproval).not.toHaveBeenCalled();
  });

  it("does not enter settlement when lifecycle lock acquisition fails (#9844)", async () => {
    const scope = ordinaryPairingDeps({
      withSandboxLock: vi.fn(async () => {
        throw new Error("lock timeout");
      }),
    });

    await expect(settleOrdinaryOpenClawPairing("alpha", scope.deps)).resolves.toEqual({
      kind: "incomplete",
      reason: "pairing-lock-unavailable",
    });
    expect(scope.deps.getTarget).not.toHaveBeenCalled();
    expect(scope.deps.withGatewayLock).not.toHaveBeenCalled();
  });

  it("does not relabel a settlement-body failure as lock acquisition (#9844)", async () => {
    const failure = new Error("registry read failed");
    const scope = ordinaryPairingDeps({
      getTarget: vi.fn(() => {
        throw failure;
      }),
    });

    await expect(settleOrdinaryOpenClawPairing("alpha", scope.deps)).rejects.toBe(failure);
  });

  it("stops before approval when the runtime changes during warm-up (#9844)", async () => {
    let currentTarget = PAIRING_TARGET;
    let reportWarmupStarted: () => void = () => {};
    let releaseWarmup: () => void = () => {};
    const warmupStarted = new Promise<void>((resolve) => {
      reportWarmupStarted = resolve;
    });
    const warmupPending = new Promise<void>((resolve) => {
      releaseWarmup = resolve;
    });
    const scope = ordinaryPairingDeps({
      getTarget: vi.fn(() => currentTarget),
      observePairing: vi
        .fn()
        .mockReturnValueOnce(PAIRING_ONLY)
        .mockReturnValue(SCOPE_UPGRADE_PENDING),
      runWarmup: vi.fn(async () => {
        reportWarmupStarted();
        await warmupPending;
      }),
    });

    const settlement = settleOrdinaryOpenClawPairing("alpha", scope.deps);
    await warmupStarted;
    currentTarget = { ...PAIRING_TARGET, lifecycleGeneration: "generation-2" };
    releaseWarmup();

    await expect(settlement).resolves.toEqual({
      kind: "incomplete",
      reason: "runtime-identity-invalid",
    });
    expect(scope.deps.runWarmup).toHaveBeenCalledOnce();
    expect(scope.deps.runApproval).not.toHaveBeenCalled();
    expect(scope.deps.observePairing).toHaveBeenCalledOnce();
  });

  it("does not observe replacement state when the runtime changes during approval (#9844)", async () => {
    let currentTarget = PAIRING_TARGET;
    let reportApprovalStarted: () => void = () => {};
    let releaseApproval: () => void = () => {};
    const approvalStarted = new Promise<void>((resolve) => {
      reportApprovalStarted = resolve;
    });
    const approvalPending = new Promise<void>((resolve) => {
      releaseApproval = resolve;
    });
    const scope = ordinaryPairingDeps({
      getTarget: vi.fn(() => currentTarget),
      observePairing: vi
        .fn()
        .mockReturnValueOnce(PAIRING_ONLY)
        .mockReturnValue(SCOPE_UPGRADE_PENDING),
      runApproval: vi.fn(async () => {
        reportApprovalStarted();
        await approvalPending;
      }),
    });

    const settlement = settleOrdinaryOpenClawPairing("alpha", scope.deps);
    await approvalStarted;
    currentTarget = { ...PAIRING_TARGET, lifecycleGeneration: "generation-2" };
    releaseApproval();

    await expect(settlement).resolves.toEqual({
      kind: "incomplete",
      reason: "runtime-identity-invalid",
    });
    expect(scope.deps.runApproval).toHaveBeenCalledOnce();
    expect(scope.deps.observePairing).toHaveBeenCalledTimes(2);
  });

  it("rejects device identity drift between precheck and pending upgrade (#10014)", async () => {
    const scope = ordinaryPairingDeps({
      observePairing: vi
        .fn()
        .mockReturnValueOnce(PAIRING_ONLY)
        .mockReturnValueOnce({
          ...SCOPE_UPGRADE_PENDING,
          deviceIdentitySha256: "b".repeat(64),
        }),
    });

    await expect(settleOrdinaryOpenClawPairing("alpha", scope.deps)).resolves.toEqual({
      kind: "incomplete",
      reason: "runtime-identity-invalid",
    });

    expect(scope.deps.runWarmup).toHaveBeenCalledExactlyOnceWith("alpha", "nemoclaw");
    expect(scope.deps.runApproval).not.toHaveBeenCalled();
  });

  it("keeps pairing appearance and final observation independently bounded (#9844)", async () => {
    let attempts = 0;
    const unavailable = () => {
      throw new Error("not published");
    };
    const scope = ordinaryPairingDeps({
      observePairing: vi.fn(() =>
        attempts++ < 10 ? unavailable() : SCOPE_UPGRADE_PENDING,
      ),
    });

    await expect(settleOrdinaryOpenClawPairing("alpha", scope.deps)).resolves.toEqual({
      kind: "incomplete",
      reason: "scope-upgrade-incomplete",
    });
    expect(scope.deps.sleep).toHaveBeenCalledTimes(39);
    expect(scope.deps.runWarmup).toHaveBeenCalledOnce();
    expect(scope.deps.runApproval).toHaveBeenCalledOnce();
  });

  it("reserves approval and final observation after bounded child caps (#9844)", async () => {
    let now = 0;
    const scope = ordinaryPairingDeps({
      now: vi.fn(() => now),
      sleep: vi.fn(async () => {
        now += OPENCLAW_ONBOARDING_PAIRING_TIMEOUT_MS - 1_000;
      }),
      observePairing: vi
        .fn()
        .mockImplementationOnce(() => {
          now += OPENCLAW_PAIRING_OBSERVATION_TIMEOUT_MS;
          throw new Error("not published");
        })
        .mockImplementationOnce(() => {
          throw new Error("not pending");
        })
        .mockReturnValueOnce(SCOPE_UPGRADE_PENDING)
        .mockReturnValue(SETTLED),
      runWarmup: vi.fn(() => {
        now += WARMUP_TIMEOUT_MS;
      }),
      runApproval: vi.fn(() => {
        now += CONNECT_AUTO_PAIR_TIMEOUT_MS;
      }),
    });

    await expect(settleOrdinaryOpenClawPairing("alpha", scope.deps)).resolves.toEqual({
      kind: "settled",
    });

    expect(scope.deps.runWarmup).toHaveBeenCalledExactlyOnceWith("alpha", "nemoclaw");
    expect(scope.deps.runApproval).toHaveBeenCalledExactlyOnceWith("alpha", "nemoclaw");
    expect(scope.deps.observePairing).toHaveBeenCalledTimes(4);
    expect(now).toBe(
      OPENCLAW_PAIRING_OBSERVATION_TIMEOUT_MS +
        OPENCLAW_ONBOARDING_PAIRING_TIMEOUT_MS -
        1_000 +
        WARMUP_TIMEOUT_MS +
        CONNECT_AUTO_PAIR_TIMEOUT_MS,
    );
    expect(OPENCLAW_ONBOARDING_PAIRING_SETTLEMENT_TIMEOUT_MS).toBe(
      OPENCLAW_PAIRING_OBSERVATION_TIMEOUT_MS +
        OPENCLAW_ONBOARDING_PAIRING_TIMEOUT_MS +
        WARMUP_TIMEOUT_MS +
        CONNECT_AUTO_PAIR_TIMEOUT_MS +
        OPENCLAW_ONBOARDING_PAIRING_FINAL_OBSERVATION_TIMEOUT_MS,
    );
  });

  it("rejects an observation that finishes after the pairing-appearance deadline (#9844)", async () => {
    let now = 0;
    const scope = ordinaryPairingDeps({
      now: vi.fn(() => now),
      observePairing: vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error("not published");
        })
        .mockImplementation(() => {
          now = OPENCLAW_ONBOARDING_PAIRING_TIMEOUT_MS + 1;
          return SCOPE_UPGRADE_PENDING;
        }),
    });

    await expect(settleOrdinaryOpenClawPairing("alpha", scope.deps)).resolves.toEqual({
      kind: "incomplete",
      reason: "pairing-unavailable",
    });
    expect(scope.deps.sleep).not.toHaveBeenCalled();
    expect(scope.deps.runWarmup).toHaveBeenCalledExactlyOnceWith("alpha", "nemoclaw");
    expect(scope.deps.runApproval).not.toHaveBeenCalled();
  });

  it("performs one request-producer write when a canonical CLI pairing never appears (#9844)", async () => {
    const scope = ordinaryPairingDeps({
      observePairing: vi.fn(() => {
        throw new Error("not published");
      }),
    });

    await expect(settleOrdinaryOpenClawPairing("alpha", scope.deps)).resolves.toEqual({
      kind: "incomplete",
      reason: "pairing-unavailable",
    });

    expect(scope.deps.runWarmup).toHaveBeenCalledExactlyOnceWith("alpha", "nemoclaw");
    expect(scope.deps.runApproval).not.toHaveBeenCalled();
  });

  it("does not approve before the exact pending upgrade appears (#10014)", async () => {
    const scope = ordinaryPairingDeps({ observePairing: vi.fn(() => PAIRING_ONLY) });

    await expect(settleOrdinaryOpenClawPairing("alpha", scope.deps)).resolves.toEqual({
      kind: "incomplete",
      reason: "scope-upgrade-incomplete",
    });

    expect(scope.deps.runWarmup).toHaveBeenCalledOnce();
    expect(scope.deps.runApproval).not.toHaveBeenCalled();
  });

  it("fails closed without writes when the recorded runtime target changes (#9844)", async () => {
    const getTarget = vi
      .fn()
      .mockReturnValueOnce(PAIRING_TARGET)
      .mockReturnValueOnce(PAIRING_TARGET)
      .mockReturnValueOnce({ ...PAIRING_TARGET, lifecycleGeneration: "generation-2" });
    const scope = ordinaryPairingDeps({ getTarget });

    await expect(settleOrdinaryOpenClawPairing("alpha", scope.deps)).resolves.toEqual({
      kind: "incomplete",
      reason: "runtime-identity-invalid",
    });

    expect(scope.deps.observePairing).toHaveBeenCalledOnce();
    expect(scope.deps.runWarmup).not.toHaveBeenCalled();
    expect(scope.deps.runApproval).not.toHaveBeenCalled();
  });

  it("resolves the finalized default OpenClaw runtime before observation (#9844)", async () => {
    const observePairing = vi.fn(() => SETTLED);
    const resolveTarget = vi.fn(() => PAIRING_TARGET);
    vi.spyOn(finalizationHandlerRuntime, "loadLaunchReadiness").mockReturnValue({
      resolveOrdinaryOpenClawPairingTarget: resolveTarget,
    } as never);
    vi.spyOn(finalizationHandlerRuntime, "loadPairingQualification").mockReturnValue({
      observeOrdinaryOpenClawPairingSettlement: observePairing,
    } as never);
    const runSandboxScopeWarmupRun = vi.fn();
    vi.spyOn(finalizationHandlerRuntime, "loadAutoPairWarmup").mockReturnValue({
      runSandboxScopeWarmupRun,
    } as never);
    vi.spyOn(finalizationHandlerRuntime, "loadSandboxLifecycleLock").mockReturnValue({
      withMcpLifecycleLock: async (_name: string, operation: () => unknown) => operation(),
    } as never);
    vi.spyOn(finalizationHandlerRuntime, "loadGatewayRouteLock").mockReturnValue({
      withGatewayRouteMutationLock: async (_name: string, operation: () => unknown) => operation(),
    } as never);

    await expect(finalizationHandlerDeps.settleOrdinaryOpenClawPairing("alpha")).resolves.toEqual({
      kind: "settled",
    });
    expect(resolveTarget).toHaveBeenCalledWith("alpha");
    expect(observePairing).toHaveBeenCalledWith(
      "alpha",
      "nemoclaw",
      "2026.7.1",
      "/sandbox/.openclaw",
    );
    expect(runSandboxScopeWarmupRun).not.toHaveBeenCalled();
  });

  it("wires the device-authenticated request producer and approval (#10014)", async () => {
    const observePairing = vi
      .fn()
      .mockReturnValueOnce(PAIRING_ONLY)
      .mockReturnValueOnce(SCOPE_UPGRADE_PENDING)
      .mockReturnValueOnce(SETTLED);
    const runSandboxScopeWarmupRun = vi.fn();
    const runSandboxAutoPairApprovalPass = vi.fn();
    vi.spyOn(finalizationHandlerRuntime, "loadLaunchReadiness").mockReturnValue({
      resolveOrdinaryOpenClawPairingTarget: vi.fn(() => PAIRING_TARGET),
    } as never);
    vi.spyOn(finalizationHandlerRuntime, "loadPairingQualification").mockReturnValue({
      observeOrdinaryOpenClawPairingSettlement: observePairing,
    } as never);
    vi.spyOn(finalizationHandlerRuntime, "loadAutoPairWarmup").mockReturnValue({
      runSandboxScopeWarmupRun,
    } as never);
    vi.spyOn(finalizationHandlerRuntime, "loadAutoPairApproval").mockReturnValue({
      runSandboxAutoPairApprovalPass,
    } as never);
    vi.spyOn(finalizationHandlerRuntime, "loadSandboxLifecycleLock").mockReturnValue({
      withMcpLifecycleLock: async (_name: string, operation: () => unknown) => operation(),
    } as never);
    vi.spyOn(finalizationHandlerRuntime, "loadGatewayRouteLock").mockReturnValue({
      withGatewayRouteMutationLock: async (_name: string, operation: () => unknown) => operation(),
    } as never);

    await expect(finalizationHandlerDeps.settleOrdinaryOpenClawPairing("alpha")).resolves.toEqual({
      kind: "settled",
    });
    expect(runSandboxScopeWarmupRun).toHaveBeenCalledExactlyOnceWith("alpha", "nemoclaw");
    expect(runSandboxAutoPairApprovalPass).toHaveBeenCalledExactlyOnceWith("alpha", {
      budget: {
        timeoutMs: CONNECT_AUTO_PAIR_TIMEOUT_MS,
        listTimeoutS: 5,
        approveTimeoutS: 8,
        maxApprovals: 1,
      },
      gatewayName: "nemoclaw",
      localDeviceOnly: true,
    });
  });

  it("explains the bounded failure without exposing runtime identifiers (#9844)", () => {
    expect(ordinaryOpenClawPairingIncompleteMessage("alpha", "pairing-unavailable")).toBe(
      "OpenClaw onboarding for 'alpha' is incomplete because its canonical CLI device pairing did not appear. Resume or rerun onboarding.",
    );
    expect(ordinaryOpenClawPairingIncompleteMessage("alpha", "pairing-lock-unavailable")).toBe(
      "OpenClaw onboarding for 'alpha' is incomplete because NemoClaw could not acquire the pairing settlement locks. Resume or rerun onboarding.",
    );
  });
});

describe("finalizationHandlerDeps.waitForSandboxControlPlaneReady", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("delegates timeout selection to the recovery readiness helper", () => {
    vi.stubEnv("NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS", "75");
    vi.stubEnv("NEMOCLAW_SANDBOX_READY_TIMEOUT", "180");
    let effectiveTimeoutSeconds: number | undefined;
    const waitForRecreatedSandboxOpenShellReady = vi.fn(
      (_name: string, options: { timeoutSeconds?: number } = {}) => {
        const requestedTimeoutSeconds = options.timeoutSeconds ?? 120;
        effectiveTimeoutSeconds = Number(
          process.env.NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS ?? requestedTimeoutSeconds,
        );
        return true;
      },
    );
    vi.spyOn(finalizationHandlerRuntime, "loadProcessRecovery").mockReturnValue({
      checkAndRecoverSandboxProcesses: vi.fn(),
      waitForRecreatedSandboxOpenShellReady,
    });

    expect(finalizationHandlerDeps.waitForSandboxControlPlaneReady("policy-box")).toBe(true);
    expect(waitForRecreatedSandboxOpenShellReady).toHaveBeenCalledWith("policy-box");
    expect(effectiveTimeoutSeconds).toBe(75);
  });
});

describe("finalizationHandlerDeps.reportDeploymentReadiness", () => {
  const originalExitCode = process.exitCode;
  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  it("sets a non-zero exit code when the deployment is not ready", () => {
    process.exitCode = 0;
    finalizationHandlerDeps.reportDeploymentReadiness(false);
    expect(process.exitCode).toBe(1);
  });

  it("leaves the exit code unchanged when the deployment is ready", () => {
    process.exitCode = 0;
    finalizationHandlerDeps.reportDeploymentReadiness(true);
    expect(process.exitCode).toBe(0);
  });
});

describe("finalizationHandlerDeps.isDeploymentHealthy", () => {
  it("reports the verification healthy flag", () => {
    const healthy = { healthy: true } as unknown as VerifyDeploymentResult;
    const unhealthy = { healthy: false } as unknown as VerifyDeploymentResult;
    expect(finalizationHandlerDeps.isDeploymentHealthy(healthy)).toBe(true);
    expect(finalizationHandlerDeps.isDeploymentHealthy(unhealthy)).toBe(false);
  });
});

describe("finalizationHandlerDeps.readRegistryAgent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["OpenClaw", { name: "alpha", agent: "openclaw" }, "openclaw"],
    ["Hermes", { name: "alpha", agent: "hermes" }, "hermes"],
    ["missing agent", { name: "alpha" }, null],
    ["missing row", null, null],
  ])(
    "reads exact %s registry identity without default inference (#9207)",
    (_label, entry, expected) => {
      const load = vi.fn(() => ({ sandboxes: entry ? { alpha: entry } : {} }));
      vi.spyOn(finalizationHandlerRuntime, "loadRegistryPersistence").mockReturnValue({
        load,
      } as never);

      expect(finalizationHandlerDeps.readRegistryAgent("alpha")).toBe(expected);
      expect(load).toHaveBeenCalledOnce();
    },
  );

  it("returns no agent when registry reading fails (#9207)", () => {
    vi.spyOn(finalizationHandlerRuntime, "loadRegistryPersistence").mockImplementation(() => {
      throw new Error("unavailable");
    });

    expect(finalizationHandlerDeps.readRegistryAgent("alpha")).toBeNull();
  });
});
