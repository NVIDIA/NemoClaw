// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "vitest";

import type { VerifyDeploymentResult } from "../verify-deployment";
import { finalizationHandlerDeps } from "./finalization-deps";

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
