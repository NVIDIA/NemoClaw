// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createVirtualClock } from "./__test-helpers__/virtual-clock";
import {
  formatGatewayHealthWaitLimit,
  type GatewayHealthWaitOptions,
  getGatewayHealthWaitBudgetMs,
  waitForGatewayHealth,
} from "./gateway-health-wait";

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
    expect(isGatewayHttpReady).toHaveBeenCalledTimes(2);
    expect(options.sleepSeconds).toHaveBeenCalledTimes(1);
    expect(options.sleepSeconds).toHaveBeenCalledWith(2);
  });

  it("returns false when HTTP readiness never follows healthy metadata", async () => {
    const clock = createVirtualClock();
    const options = buildOptions({
      healthPollCount: 2,
      isGatewayHttpReady: vi.fn(async () => false),
      now: clock.now,
      sleepSeconds: clock.sleeper,
    });

    await expect(waitForGatewayHealth(options)).resolves.toBe(false);

    expect(options.isGatewayHealthy).toHaveBeenCalledTimes(2);
    expect(options.isGatewayHttpReady).toHaveBeenCalledTimes(2);
    expect(options.sleepSeconds).toHaveBeenCalledTimes(2);
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

  it("polls until the configured health deadline instead of stopping at the count cap (#3768)", async () => {
    const clock = createVirtualClock();
    const isGatewayHealthy = vi.fn(() => {
      clock.advance(1);
      return false;
    });
    const options = buildOptions({
      healthPollCount: 10,
      healthPollIntervalSeconds: 1,
      isGatewayHealthy,
      now: clock.now,
      sleepSeconds: clock.sleeper,
    });

    await expect(waitForGatewayHealth(options)).resolves.toBe(false);

    expect(isGatewayHealthy).toHaveBeenCalled();
    expect(isGatewayHealthy.mock.calls.length).toBeLessThan(10);
    expect(options.isGatewayHttpReady).toHaveBeenCalledTimes(isGatewayHealthy.mock.calls.length);
    expect(clock.sleeper).toHaveBeenCalled();
    expect(clock.sleeper.mock.calls.every(([seconds]) => seconds === 1)).toBe(true);
  });

  it("preserves the configured immediate probes when the interval is zero (#3768)", async () => {
    const probeSignals: Array<AbortSignal | undefined> = [];
    const isGatewayHealthy = vi
      .fn<() => boolean>()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const sleepSeconds = vi.fn();
    const options = buildOptions({
      healthPollCount: 3,
      healthPollIntervalSeconds: 0,
      isGatewayHealthy,
      isGatewayHttpReady: vi.fn(async (signal?: AbortSignal) => {
        probeSignals.push(signal);
        return true;
      }),
      now: vi.fn(() => Number.MAX_SAFE_INTEGER),
      sleepSeconds,
    });

    await expect(waitForGatewayHealth(options)).resolves.toBe(true);

    expect(isGatewayHealthy).toHaveBeenCalledTimes(3);
    expect(options.isGatewayHttpReady).toHaveBeenCalledTimes(3);
    expect(sleepSeconds).toHaveBeenCalledTimes(2);
    expect(sleepSeconds).toHaveBeenNthCalledWith(1, 0);
    expect(sleepSeconds).toHaveBeenNthCalledWith(2, 0);
    expect(probeSignals.map((signal) => signal?.aborted)).toEqual([true, true, false]);
    expect(formatGatewayHealthWaitLimit(3, 0)).toBe("3 immediate health probes");
  });

  it("does not probe after a positive health deadline expires before the first attempt", async () => {
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValue(1000);
    const options = buildOptions({
      healthPollCount: 1,
      healthPollIntervalSeconds: 1,
      now,
    });

    await expect(waitForGatewayHealth(options)).resolves.toBe(false);

    expect(options.runCaptureOpenshell).not.toHaveBeenCalled();
    expect(options.isGatewayHealthy).not.toHaveBeenCalled();
    expect(options.isGatewayHttpReady).not.toHaveBeenCalled();
  });

  it("preserves a rejected HTTP readiness probe error", async () => {
    const probeError = new Error("readiness transport failed");
    const options = buildOptions({
      healthPollCount: 3,
      healthPollIntervalSeconds: 0,
      isGatewayHttpReady: vi.fn(async () => Promise.reject(probeError)),
    });

    await expect(waitForGatewayHealth(options)).rejects.toBe(probeError);

    expect(options.isGatewayHealthy).toHaveBeenCalledOnce();
    expect(options.isGatewayHttpReady).toHaveBeenCalledOnce();
    expect(options.sleepSeconds).not.toHaveBeenCalled();
  });

  it("clamps an overflowing health deadline budget to a finite value", () => {
    expect(getGatewayHealthWaitBudgetMs(Number.MAX_VALUE, Number.MAX_VALUE)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
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

  it("starts the HTTP readiness probe before collecting OpenShell metadata", async () => {
    const events: string[] = [];
    const openshellOutputByCommand = new Map([
      ["status", "status"],
      ["gateway info -g nemoclaw", "named"],
      ["gateway info", "current"],
    ]);
    const options = buildOptions({
      isGatewayHttpReady: vi.fn(async () => {
        events.push("http");
        return true;
      }),
      runCaptureOpenshell: vi.fn((args: string[]) => {
        const command = args.join(" ");
        events.push(command);
        return openshellOutputByCommand.get(command) ?? "";
      }),
    });

    await expect(waitForGatewayHealth(options)).resolves.toBe(true);

    expect(events).toEqual([
      "http",
      "gateway select nemoclaw",
      "status",
      "gateway info -g nemoclaw",
      "gateway info",
    ]);
  });

  it("aborts the HTTP readiness probe when OpenShell metadata is unhealthy", async () => {
    const clock = createVirtualClock();
    let observedSignal: AbortSignal | undefined;
    let aborted = false;
    const options = buildOptions({
      healthPollCount: 1,
      isGatewayHealthy: vi.fn(() => false),
      isGatewayHttpReady: vi.fn(
        (signal?: AbortSignal) =>
          new Promise<boolean>((resolve) => {
            observedSignal = signal;
            signal?.addEventListener(
              "abort",
              () => {
                aborted = true;
                resolve(false);
              },
              { once: true },
            );
          }),
      ),
      now: clock.now,
      sleepSeconds: clock.sleeper,
    });

    await expect(waitForGatewayHealth(options)).resolves.toBe(false);

    expect(options.isGatewayHttpReady).toHaveBeenCalledOnce();
    expect(observedSignal?.aborted).toBe(true);
    expect(aborted).toBe(true);
  });
});
