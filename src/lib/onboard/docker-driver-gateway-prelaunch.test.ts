// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { reapHostGatewayBeforeLaunch } from "./docker-driver-gateway-prelaunch";
import type { StopHostGatewayOptions, StopHostGatewayResult } from "./host-gateway-process";

function emptyResult(overrides: Partial<StopHostGatewayResult> = {}): StopHostGatewayResult {
  return {
    failed: [],
    skippedDeadPids: [],
    skippedNonMatchingPids: [],
    stopped: [],
    sudoRemediationPids: [],
    ...overrides,
  };
}

// Capture the options the reaper hands to stopHostGatewayProcesses.
function stopSpy(result: StopHostGatewayResult): {
  fn: typeof import("./host-gateway-process").stopHostGatewayProcesses;
  lastOptions: () => StopHostGatewayOptions | undefined;
} {
  let captured: StopHostGatewayOptions | undefined;
  const fn = vi.fn((_deps?: unknown, options?: StopHostGatewayOptions) => {
    captured = options;
    return result;
  }) as unknown as typeof import("./host-gateway-process").stopHostGatewayProcesses;
  return { fn, lastOptions: () => captured };
}

describe("reapHostGatewayBeforeLaunch (#5968)", () => {
  it("reaps the recorded pid and the port listener, scoped to this port with no host-wide sweep", () => {
    const stop = stopSpy(emptyResult({ stopped: [4242] }));

    const result = reapHostGatewayBeforeLaunch(
      {
        pidFile: "/state/openshell-docker-gateway-8090/openshell-gateway.pid",
        stateDir: "/state/openshell-docker-gateway-8090",
        gatewayBin: "/usr/local/bin/openshell-gateway",
        extraPids: [4242],
      },
      {},
      stop.fn,
    );

    expect(result.stopped).toEqual([4242]);
    const options = stop.lastOptions();
    expect(options?.pids).toEqual([4242]);
    expect(options?.usePgrepFallback).toBe(false);
    expect(options?.pidFile).toBe("/state/openshell-docker-gateway-8090/openshell-gateway.pid");
    expect(options?.stateDir).toBe("/state/openshell-docker-gateway-8090");
    expect(options?.gatewayBin).toBe("/usr/local/bin/openshell-gateway");
  });

  it("drops null/invalid candidate pids so a missing pid-file/listener is a quiet no-op", () => {
    const stop = stopSpy(emptyResult());

    reapHostGatewayBeforeLaunch(
      {
        pidFile: "/state/openshell-docker-gateway/openshell-gateway.pid",
        stateDir: "/state/openshell-docker-gateway",
        gatewayBin: null,
        extraPids: [null, undefined, 0, -1, 7777],
      },
      {},
      stop.fn,
    );

    expect(stop.lastOptions()?.pids).toEqual([7777]);
  });
});
