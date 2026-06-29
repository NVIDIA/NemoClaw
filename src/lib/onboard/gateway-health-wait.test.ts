// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import { type GatewayHealthWaitOptions, waitForGatewayHealth } from "./gateway-health-wait";

function buildOptions(overrides: Partial<GatewayHealthWaitOptions> = {}): GatewayHealthWaitOptions {
  return {
    attachGatewayMetadataIfNeeded: vi.fn(),
    gatewayClusterHealthcheckPassed: vi.fn(() => false),
    gatewayName: "nemoclaw",
    healthPollCount: 1,
    healthPollIntervalSeconds: 2,
    isGatewayHealthy: vi.fn(() => true),
    isGatewayHttpReady: vi.fn(async () => true),
    repairGatewayBootstrapSecrets: vi.fn(() => ({ repaired: false })),
    runCaptureOpenshell: vi.fn((args: string[]) => {
      if (args[0] === "status") return "status";
      if (args[0] === "gateway" && args[1] === "info" && args[2] === "-g") return "named";
      if (args[0] === "gateway" && args[1] === "info") return "current";
      return "";
    }),
    sleepSeconds: vi.fn(),
    ...overrides,
  };
}

describe("waitForGatewayHealth", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns true only after OpenShell metadata and HTTP readiness are healthy", async () => {
    const isGatewayHealthy = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const isGatewayHttpReady = vi.fn(async () => true);
    const options = buildOptions({
      healthPollCount: 2,
      isGatewayHealthy,
      isGatewayHttpReady,
    });

    await expect(waitForGatewayHealth(options)).resolves.toBe(true);

    expect(isGatewayHealthy).toHaveBeenCalledTimes(2);
    expect(isGatewayHttpReady).toHaveBeenCalledTimes(1);
    expect(options.sleepSeconds).toHaveBeenCalledTimes(1);
    expect(options.sleepSeconds).toHaveBeenCalledWith(2);
  });

  it("returns false when HTTP readiness never follows healthy metadata", async () => {
    const options = buildOptions({
      healthPollCount: 2,
      isGatewayHttpReady: vi.fn(async () => false),
    });

    await expect(waitForGatewayHealth(options)).resolves.toBe(false);

    expect(options.isGatewayHealthy).toHaveBeenCalledTimes(2);
    expect(options.isGatewayHttpReady).toHaveBeenCalledTimes(2);
    expect(options.sleepSeconds).toHaveBeenCalledTimes(1);
  });

  it("force-refreshes metadata after bootstrap secret repair", async () => {
    const options = buildOptions({
      gatewayClusterHealthcheckPassed: vi.fn(() => true),
      repairGatewayBootstrapSecrets: vi.fn(() => ({ repaired: true })),
    });

    await expect(waitForGatewayHealth(options)).resolves.toBe(true);

    expect(options.attachGatewayMetadataIfNeeded).toHaveBeenCalledOnce();
    expect(options.attachGatewayMetadataIfNeeded).toHaveBeenCalledWith({ forceRefresh: true });
    expect(options.gatewayClusterHealthcheckPassed).not.toHaveBeenCalled();
  });

  it("attaches metadata without force when cluster healthcheck passes without repair", async () => {
    const options = buildOptions({
      gatewayClusterHealthcheckPassed: vi.fn(() => true),
    });

    await expect(waitForGatewayHealth(options)).resolves.toBe(true);

    expect(options.attachGatewayMetadataIfNeeded).toHaveBeenCalledOnce();
    expect(options.attachGatewayMetadataIfNeeded).toHaveBeenCalledWith();
  });

  it("stops after healthPollCount attempts without sleeping after the final failed probe", async () => {
    const options = buildOptions({
      healthPollCount: 3,
      isGatewayHealthy: vi.fn(() => false),
    });

    await expect(waitForGatewayHealth(options)).resolves.toBe(false);

    expect(options.isGatewayHealthy).toHaveBeenCalledTimes(3);
    expect(options.isGatewayHttpReady).not.toHaveBeenCalled();
    expect(options.sleepSeconds).toHaveBeenCalledTimes(2);
    expect(options.sleepSeconds).toHaveBeenNthCalledWith(1, 2);
    expect(options.sleepSeconds).toHaveBeenNthCalledWith(2, 2);
  });

  it("returns false without probing when healthPollCount is zero", async () => {
    const options = buildOptions({ healthPollCount: 0 });

    await expect(waitForGatewayHealth(options)).resolves.toBe(false);

    expect(options.repairGatewayBootstrapSecrets).not.toHaveBeenCalled();
    expect(options.attachGatewayMetadataIfNeeded).not.toHaveBeenCalled();
    expect(options.runCaptureOpenshell).not.toHaveBeenCalled();
    expect(options.isGatewayHealthy).not.toHaveBeenCalled();
    expect(options.isGatewayHttpReady).not.toHaveBeenCalled();
    expect(options.sleepSeconds).not.toHaveBeenCalled();
  });

  it("reselects the gateway and probes status, named info, and active info in order", async () => {
    const runCaptureOpenshell = vi.fn((args: string[]) => {
      if (args[0] === "status") return "status";
      if (args[0] === "gateway" && args[1] === "info" && args[2] === "-g") return "named";
      if (args[0] === "gateway" && args[1] === "info") return "current";
      return "";
    });
    const isGatewayHealthy = vi.fn(() => true);
    const options = buildOptions({ isGatewayHealthy, runCaptureOpenshell });

    await expect(waitForGatewayHealth(options)).resolves.toBe(true);

    expect(runCaptureOpenshell).toHaveBeenNthCalledWith(1, ["gateway", "select", "nemoclaw"], {
      ignoreError: true,
    });
    expect(runCaptureOpenshell).toHaveBeenNthCalledWith(2, ["status"], { ignoreError: true });
    expect(runCaptureOpenshell).toHaveBeenNthCalledWith(3, ["gateway", "info", "-g", "nemoclaw"], {
      ignoreError: true,
    });
    expect(runCaptureOpenshell).toHaveBeenNthCalledWith(4, ["gateway", "info"], {
      ignoreError: true,
    });
    expect(isGatewayHealthy).toHaveBeenCalledWith("status", "named", "current");
  });
});
