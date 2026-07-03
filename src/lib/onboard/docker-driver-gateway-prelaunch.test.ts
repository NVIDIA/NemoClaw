// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  prelaunchReapFailureMessage,
  reapDuplicateHostGatewaysExcept,
  reapDuplicateHostGatewaysExceptOrFail,
  reapHostGatewayBeforeLaunch,
  reapHostGatewayBeforeLaunchOrFail,
} from "./docker-driver-gateway-prelaunch";
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
  callCount: () => number;
} {
  let captured: StopHostGatewayOptions | undefined;
  let calls = 0;
  const fn = vi.fn((_deps?: unknown, options?: StopHostGatewayOptions) => {
    calls += 1;
    captured = options;
    return result;
  }) as unknown as typeof import("./host-gateway-process").stopHostGatewayProcesses;
  return { fn, lastOptions: () => captured, callCount: () => calls };
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
    expect(options?.usePidFile).toBe(false);
    expect(options?.usePgrepFallback).toBe(false);
    expect(options?.pidFile).toBe("/state/openshell-docker-gateway-8090/openshell-gateway.pid");
    expect(options?.stateDir).toBe("/state/openshell-docker-gateway-8090");
    expect(options?.gatewayBin).toBe("/usr/local/bin/openshell-gateway");
  });

  it("drops null/invalid/duplicate candidate pids so a missing pid-file/listener is a quiet no-op", () => {
    const stop = stopSpy(emptyResult());

    reapHostGatewayBeforeLaunch(
      {
        pidFile: "/state/openshell-docker-gateway/openshell-gateway.pid",
        stateDir: "/state/openshell-docker-gateway",
        gatewayBin: null,
        extraPids: [null, undefined, 0, -1, 7777, 7777],
      },
      {},
      stop.fn,
    );

    expect(stop.lastOptions()?.pids).toEqual([7777]);
  });
});

describe("prelaunchReapFailureMessage (#5968)", () => {
  it("returns null when no matched gateway resisted the reap", () => {
    expect(prelaunchReapFailureMessage(emptyResult({ stopped: [10] }))).toBeNull();
  });

  it("describes the unreaped gateway pids and a remediation scoped to those pids", () => {
    const message = prelaunchReapFailureMessage(emptyResult({ failed: [321, 654] }));
    expect(message).toContain("321, 654");
    // Scoped to the matched pids, never a host-wide `pkill -f openshell-gateway`.
    expect(message).toContain("sudo kill -9 321 654");
    expect(message).not.toContain("pkill");
  });
});

describe("reapHostGatewayBeforeLaunchOrFail (#5968)", () => {
  const options = {
    pidFile: "/state/openshell-docker-gateway-8090/openshell-gateway.pid",
    stateDir: "/state/openshell-docker-gateway-8090",
    gatewayBin: "/usr/local/bin/openshell-gateway",
    extraPids: [4242],
  };

  it("returns the cleared result and does not exit when the port is clear", () => {
    const stop = stopSpy(emptyResult({ stopped: [4242] }));
    const exit = vi.fn(() => undefined as never);

    const result = reapHostGatewayBeforeLaunchOrFail(options, {}, stop.fn, exit);

    expect(result.stopped).toEqual([4242]);
    expect(exit).not.toHaveBeenCalled();
  });

  it("throws and never spawns when a matched gateway could not be stopped (exitOnFailure off)", () => {
    const stop = stopSpy(emptyResult({ failed: [4242] }));
    const exit = vi.fn(() => undefined as never);

    expect(() =>
      reapHostGatewayBeforeLaunchOrFail({ ...options, exitOnFailure: false }, {}, stop.fn, exit),
    ).toThrow(/could not be stopped/);
    expect(exit).not.toHaveBeenCalled();
  });

  it("exits with code 1 when a matched gateway could not be stopped and exitOnFailure is set", () => {
    const stop = stopSpy(emptyResult({ failed: [4242] }));
    const exit = vi.fn((_code: number) => {
      throw new Error("exit-called");
    }) as unknown as (code: number) => never;

    expect(() =>
      reapHostGatewayBeforeLaunchOrFail({ ...options, exitOnFailure: true }, {}, stop.fn, exit),
    ).toThrow(/exit-called/);
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("reapDuplicateHostGatewaysExcept (#5968)", () => {
  it("reaps a known stale duplicate pid while excluding the gateway being reused", () => {
    const stop = stopSpy(emptyResult({ stopped: [111] }));

    const result = reapDuplicateHostGatewaysExcept(
      999,
      "/usr/local/bin/openshell-gateway",
      [111, 999, null, 999],
      {},
      stop.fn,
    );

    expect(result.stopped).toEqual([111]);
    const captured = stop.lastOptions();
    expect(captured?.pids).toEqual([111]);
    expect(captured?.usePgrepFallback).toBe(false);
    expect(captured?.gatewayBin).toBe("/usr/local/bin/openshell-gateway");
    // The duplicate reap must not read or clear the adopted gateway's live
    // pid-file/runtime marker.
    expect(captured?.usePidFile).toBe(false);
    expect(captured?.clearRuntimeFiles).toBe(false);
  });

  it("never calls the stopper when the only known candidate is the reused gateway", () => {
    const stop = stopSpy(emptyResult());

    const result = reapDuplicateHostGatewaysExcept(999, null, [999, null, 0, -3], {}, stop.fn);

    expect(result).toEqual(emptyResult());
    expect(stop.callCount()).toBe(0);
  });
});

describe("reapDuplicateHostGatewaysExceptOrFail (#5968)", () => {
  const gatewayBin = "/usr/local/bin/openshell-gateway";

  it("returns the result and does not exit when the stale duplicate was reaped", () => {
    const stop = stopSpy(emptyResult({ stopped: [111] }));
    const exit = vi.fn(() => undefined as never);

    const result = reapDuplicateHostGatewaysExceptOrFail(
      999,
      gatewayBin,
      [111],
      false,
      {},
      stop.fn,
      exit,
    );

    expect(result.stopped).toEqual([111]);
    expect(exit).not.toHaveBeenCalled();
  });

  it("throws and never reports reuse when a matched duplicate could not be stopped (exitOnFailure off)", () => {
    const stop = stopSpy(emptyResult({ failed: [111] }));
    const exit = vi.fn(() => undefined as never);

    expect(() =>
      reapDuplicateHostGatewaysExceptOrFail(999, gatewayBin, [111], false, {}, stop.fn, exit),
    ).toThrow(/could not be stopped/);
    expect(exit).not.toHaveBeenCalled();
  });

  it("exits with code 1 when a matched duplicate could not be stopped and exitOnFailure is set", () => {
    const stop = stopSpy(emptyResult({ failed: [111] }));
    const exit = vi.fn((_code: number) => {
      throw new Error("exit-called");
    }) as unknown as (code: number) => never;

    expect(() =>
      reapDuplicateHostGatewaysExceptOrFail(999, gatewayBin, [111], true, {}, stop.fn, exit),
    ).toThrow(/exit-called/);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
