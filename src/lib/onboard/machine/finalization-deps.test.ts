// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import type { VerifyDeploymentResult } from "../../verify-deployment";
import { finalizationHandlerDeps, finalizationHandlerRuntime } from "./finalization-deps";

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
