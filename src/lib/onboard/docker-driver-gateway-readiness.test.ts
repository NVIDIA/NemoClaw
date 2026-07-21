// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createVirtualClock } from "./__test-helpers__/virtual-clock";
import { waitForStandaloneDockerDriverGateway } from "./docker-driver-gateway-readiness";

function buildOptions() {
  const clock = createVirtualClock();
  return {
    childExited: vi.fn(() => false),
    childPid: 42,
    gatewayName: "nemoclaw",
    healthPollCount: 2,
    healthPollIntervalSeconds: 1,
    isGatewayHealthy: vi.fn(() => true),
    isGatewayTcpReady: vi.fn(async () => true),
    isPidAlive: vi.fn(() => true),
    now: clock.now,
    onHealthy: vi.fn(async () => undefined),
    registerGatewayEndpoint: vi.fn(() => true),
    runCaptureOpenshell: vi.fn((args: string[]) => args.join(" ")),
    sleepSeconds: clock.sleeper,
  };
}

describe("waitForStandaloneDockerDriverGateway", () => {
  it("retries quickly and runs the healthy boundary after all probes pass", async () => {
    const options = buildOptions();
    options.isGatewayHealthy.mockReturnValueOnce(false).mockReturnValueOnce(true);

    await expect(waitForStandaloneDockerDriverGateway(options)).resolves.toBe("healthy");

    expect(options.sleepSeconds).toHaveBeenCalledWith(0.25);
    expect(options.onHealthy).toHaveBeenCalledOnce();
  });

  it("stops immediately when the child process exits", async () => {
    const options = buildOptions();
    options.childExited.mockReturnValue(true);

    await expect(waitForStandaloneDockerDriverGateway(options)).resolves.toBe("exited");

    expect(options.registerGatewayEndpoint).not.toHaveBeenCalled();
    expect(options.sleepSeconds).not.toHaveBeenCalled();
  });

  it("uses the full deadline when readiness never succeeds", async () => {
    const options = buildOptions();
    options.isGatewayHealthy.mockReturnValue(false);

    await expect(waitForStandaloneDockerDriverGateway(options)).resolves.toBe("timeout");

    expect(options.isGatewayHealthy.mock.calls.length).toBeGreaterThan(2);
    expect(options.onHealthy).not.toHaveBeenCalled();
  });
});
