// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { gatewayAdaptersForTest } from "../../../test/helpers/openshell-gateway-adapters";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createVirtualClock } from "./__test-helpers__/virtual-clock";
import {
  formatGatewayHealthWaitLimit,
  type GatewayHealthWaitOptions,
  getGatewayHealthWaitBudgetMs,
  waitForGatewayHealth,
} from "./gateway-health-wait";

type HealthWaitTestOptions = GatewayHealthWaitOptions & { healthProbe: () => boolean };

function buildOptions(overrides: Partial<HealthWaitTestOptions> = {}): HealthWaitTestOptions {
  const healthProbe = overrides.healthProbe ?? vi.fn(() => true);
  const adapters = gatewayAdaptersForTest();
  adapters.observer.observeGatewayReuse.mockImplementation(async () => ({
    gatewayReuseState: "healthy",
    healthy: healthProbe(),
    namedMetadata: true,
    shouldSelect: false,
    endpoints: [],
    endpointBinding: "unknown",
  }));
  return {
    ...adapters,
    attachGatewayMetadataIfNeeded: vi.fn(async () => true),
    gatewayClusterHealthcheckPassed: vi.fn(() => false),
    gatewayName: "nemoclaw",
    healthPollCount: 1,
    healthPollIntervalSeconds: 2,
    healthProbe,
    isGatewayHttpReady: vi.fn(async () => true),
    repairGatewayBootstrapSecrets: vi.fn(() => ({ repaired: false })),
    sleepSeconds: vi.fn(),
    ...overrides,
  };
}

describe("waitForGatewayHealth", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns true only after OpenShell metadata and HTTP readiness are healthy", async () => {
    const healthProbe = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const isGatewayHttpReady = vi.fn(async () => true);
    const options = buildOptions({
      healthPollCount: 2,
      healthProbe,
      isGatewayHttpReady,
    });

    await expect(waitForGatewayHealth(options)).resolves.toBe(true);

    expect(healthProbe).toHaveBeenCalledTimes(2);
    expect(isGatewayHttpReady).toHaveBeenCalledTimes(2);
    expect(options.sleepSeconds).toHaveBeenCalledTimes(1);
    expect(options.sleepSeconds).toHaveBeenCalledWith(0.25);
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

    expect(options.healthProbe).toHaveBeenCalledTimes(6);
    expect(options.isGatewayHttpReady).toHaveBeenCalledTimes(6);
    expect(options.sleepSeconds).toHaveBeenCalledTimes(6);
    expect(options.sleepSeconds).toHaveBeenNthCalledWith(1, 0.25);
    expect(
      Math.max(...vi.mocked(options.sleepSeconds).mock.calls.map(([seconds]) => seconds)),
    ).toBeLessThanOrEqual(2);
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
    expect(options.attachGatewayMetadataIfNeeded).toHaveBeenCalledWith({ forceRefresh: false });
  });

  it("polls until the configured health deadline instead of stopping at the count cap (#3768)", async () => {
    const clock = createVirtualClock();
    const healthProbe = vi.fn(() => {
      clock.advance(1);
      return false;
    });
    const options = buildOptions({
      healthPollCount: 10,
      healthPollIntervalSeconds: 1,
      healthProbe,
      now: clock.now,
      sleepSeconds: clock.sleeper,
    });

    await expect(waitForGatewayHealth(options)).resolves.toBe(false);

    expect(healthProbe).toHaveBeenCalled();
    expect(healthProbe.mock.calls.length).toBeLessThan(10);
    expect(options.isGatewayHttpReady).toHaveBeenCalledTimes(healthProbe.mock.calls.length);
    expect(clock.sleeper).toHaveBeenCalled();
    expect(clock.sleeper).toHaveBeenNthCalledWith(1, 0.25);
    expect(clock.sleeper.mock.calls.every(([seconds]) => seconds <= 1)).toBe(true);
  });

  it("preserves the configured immediate probes when the interval is zero (#3768)", async () => {
    const probeSignals: Array<AbortSignal | undefined> = [];
    const healthProbe = vi
      .fn<() => boolean>()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const sleepSeconds = vi.fn();
    const options = buildOptions({
      healthPollCount: 3,
      healthPollIntervalSeconds: 0,
      healthProbe,
      isGatewayHttpReady: vi.fn(async (signal?: AbortSignal) => {
        probeSignals.push(signal);
        return true;
      }),
      now: vi.fn(() => Number.MAX_SAFE_INTEGER),
      sleepSeconds,
    });

    await expect(waitForGatewayHealth(options)).resolves.toBe(true);

    expect(healthProbe).toHaveBeenCalledTimes(3);
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

    expect(options.healthProbe).not.toHaveBeenCalled();
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

    expect(options.healthProbe).toHaveBeenCalledOnce();
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
    expect(options.healthProbe).not.toHaveBeenCalled();
    expect(options.isGatewayHttpReady).not.toHaveBeenCalled();
    expect(options.sleepSeconds).not.toHaveBeenCalled();
  });

  it("selects once before polling the exact named gateway", async () => {
    const options = buildOptions();
    await expect(waitForGatewayHealth(options)).resolves.toBe(true);
    expect(options.lifecycle.selectGateway).toHaveBeenCalledExactlyOnceWith({
      target: { kind: "named", gatewayName: "nemoclaw" },
    });
    expect(options.observer.observeGatewayReuse).toHaveBeenCalledWith({
      target: { kind: "named", gatewayName: "nemoclaw" },
    });
  });

  it("starts HTTP readiness before the awaited metadata observation", async () => {
    const events: string[] = [];
    const adapters = gatewayAdaptersForTest();
    const observation = await adapters.observer.observeGatewayReuse({});
    adapters.observer.observeGatewayReuse.mockImplementation(async () => {
      events.push("metadata");
      return observation;
    });
    const options = buildOptions({
      ...adapters,
      isGatewayHttpReady: vi.fn(async () => {
        events.push("http");
        return true;
      }),
    });
    await expect(waitForGatewayHealth(options)).resolves.toBe(true);
    expect(events).toEqual(["http", "metadata"]);
  });

  it("aborts the HTTP readiness probe when OpenShell metadata is unhealthy", async () => {
    const clock = createVirtualClock();
    let observedSignal: AbortSignal | undefined;
    let aborted = false;
    const options = buildOptions({
      healthPollCount: 1,
      healthProbe: vi.fn(() => false),
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

    expect(options.isGatewayHttpReady).toHaveBeenCalledTimes(4);
    expect(observedSignal?.aborted).toBe(true);
    expect(aborted).toBe(true);
  });
});
