// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import type { VerifyDeploymentResult } from "../../verify-deployment";
import type { OpenClawPairingSettlementObservation } from "../../actions/sandbox/launch-readiness/openclaw-pairing-qualification";
import {
  finalizationHandlerDeps,
  finalizationHandlerRuntime,
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
    runWarmup: vi.fn(() => calls.push("warmup")),
    runApproval: vi.fn(() => calls.push("approval")),
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

  it("accepts one already-settled canonical CLI device without pairing writes (#9844)", async () => {
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

  it("waits for canonical pairing before one warm-up and approval pass (#9844)", async () => {
    const scope = ordinaryPairingDeps({
      observePairing: vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error("not published");
        })
        .mockReturnValueOnce(PAIRING_ONLY)
        .mockReturnValue(SETTLED),
    });

    await expect(settleOrdinaryOpenClawPairing("alpha", scope.deps)).resolves.toEqual({
      kind: "settled",
    });

    expect(scope.calls).toEqual(["sleep", "warmup", "approval"]);
    expect(scope.deps.runWarmup).toHaveBeenCalledExactlyOnceWith("alpha");
    expect(scope.deps.runApproval).toHaveBeenCalledExactlyOnceWith("alpha", "nemoclaw");
  });

  it("performs no writes when a canonical CLI pairing never appears (#9844)", async () => {
    const scope = ordinaryPairingDeps({
      observePairing: vi.fn(() => {
        throw new Error("not published");
      }),
    });

    await expect(settleOrdinaryOpenClawPairing("alpha", scope.deps)).resolves.toEqual({
      kind: "incomplete",
      reason: "pairing-unavailable",
    });

    expect(scope.deps.runWarmup).not.toHaveBeenCalled();
    expect(scope.deps.runApproval).not.toHaveBeenCalled();
  });

  it("does not repeat pairing writes when baseline scopes never settle (#9844)", async () => {
    const scope = ordinaryPairingDeps({ observePairing: vi.fn(() => PAIRING_ONLY) });

    await expect(settleOrdinaryOpenClawPairing("alpha", scope.deps)).resolves.toEqual({
      kind: "incomplete",
      reason: "scope-upgrade-incomplete",
    });

    expect(scope.deps.runWarmup).toHaveBeenCalledOnce();
    expect(scope.deps.runApproval).toHaveBeenCalledOnce();
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
  });

  it("explains the bounded failure without exposing runtime identifiers (#9844)", () => {
    expect(ordinaryOpenClawPairingIncompleteMessage("alpha", "pairing-unavailable")).toBe(
      "OpenClaw onboarding for 'alpha' is incomplete because its canonical CLI device pairing did not appear. Resume or rerun onboarding.",
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
