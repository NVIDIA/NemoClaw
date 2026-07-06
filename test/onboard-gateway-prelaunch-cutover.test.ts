// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  type DockerDriverGatewayCutoverDeps,
  type DockerDriverGatewayCutoverInput,
  runDockerDriverGatewayCutover,
} from "../src/lib/onboard/docker-driver-gateway-cutover";

type Event = {
  type: string;
  extraPids?: number[];
  keepPid?: number;
  pid?: number;
  message?: string;
};

interface HarnessOptions {
  listenerPids: number[];
  scanComplete?: boolean;
  postReapPortAvailable?: boolean;
  pidFileGatewayPid?: number | null;
  driftPids?: number[];
  prelaunchError?: string;
  duplicateError?: string;
}

function throwHarnessError(message: string): never {
  throw new Error(message);
}

function makeHarness(options: HarnessOptions) {
  const events: Event[] = [];
  const input: DockerDriverGatewayCutoverInput = {
    gatewayBin: "/test/bin/openshell-gateway",
    identityGatewayBin: "/test/bin/openshell-gateway",
    driftGatewayBin: "/test/bin/openshell-gateway",
    driftGatewayEnv: { OPENSHELL_DRIVERS: "docker" },
    exitOnFailure: false,
    skipSandboxBridgeReachability: false,
    stateDir: "/test/state",
    portListenerScan: {
      complete: options.scanComplete ?? true,
      pids: options.listenerPids,
    },
    pidFileGatewayPid: options.pidFileGatewayPid === undefined ? 4242 : options.pidFileGatewayPid,
    initialHealth: {
      status: "Gateway: nemoclaw\nConnected",
      namedInfo: "Gateway: nemoclaw",
      activeInfo: "Gateway: nemoclaw",
    },
  };
  const driftPids = new Set(options.driftPids ?? []);
  const deps: DockerDriverGatewayCutoverDeps = {
    isDockerDriverGatewayProcessAlive: () => true,
    isGatewayHealthy: () => true,
    getDockerDriverGatewayRuntimeDrift: (pid) =>
      driftPids.has(pid) ? { reason: "test runtime drift" } : null,
    logDockerDriverGatewayRestart: (message) => events.push({ type: "restart", message }),
    registerDockerDriverGatewayEndpoint: () => true,
    isDockerDriverGatewayHttpReady: async () => {
      events.push({ type: "http-ready" });
      return true;
    },
    verifySandboxBridgeGatewayReachableOrExit: async () => {
      events.push({ type: "verify-sandbox-bridge" });
    },
    readGatewayHealth: () => ({
      status: "Gateway: nemoclaw\nConnected",
      namedInfo: "Gateway: nemoclaw",
      activeInfo: "Gateway: nemoclaw",
    }),
    rememberDockerDriverGatewayPid: (pid) => events.push({ type: "remember-pid", pid }),
    reapDuplicateHostGatewaysExceptOrFail: (keepPid, _gatewayBin, extraPids) => {
      events.push({ type: "duplicate-reap", keepPid, extraPids });
      options.duplicateError && throwHarnessError(options.duplicateError);
    },
    reapHostGatewayBeforeLaunchOrFail: ({ extraPids }) => {
      events.push({ type: "prelaunch-reap", extraPids });
      options.prelaunchError && throwHarnessError(options.prelaunchError);
    },
    isGatewayPortAvailable: async () => options.postReapPortAvailable ?? true,
    reportUntrustedGatewayPort: (message) => {
      throw new Error(message);
    },
    reportMissingGatewayBinary: () => {
      throw new Error("missing gateway binary");
    },
    log: (message) => events.push({ type: "log", message }),
  };

  return {
    events,
    async run(): Promise<"reused" | "launch"> {
      const action = await runDockerDriverGatewayCutover(input, deps);
      action === "launch" && events.push({ type: "spawn-fresh" });
      return action;
    },
  };
}

describe("Docker-driver gateway prelaunch cutover (#5968)", () => {
  it("reaps stale port listeners before allowing a fresh launch", async () => {
    const harness = makeHarness({
      listenerPids: [4242, 4343],
      driftPids: [4242],
    });

    await expect(harness.run()).resolves.toBe("launch");
    const reapIndex = harness.events.findIndex((event) => event.type === "prelaunch-reap");
    const launchIndex = harness.events.findIndex((event) => event.type === "spawn-fresh");
    expect(harness.events[reapIndex]?.extraPids).toEqual([4242, 4343]);
    expect(reapIndex).toBeGreaterThanOrEqual(0);
    expect(launchIndex).toBeGreaterThan(reapIndex);
  });

  it("bypasses sole-binder reuse and reaps the duplicate when an extra listener exists", async () => {
    const harness = makeHarness({ listenerPids: [4242, 4343] });

    await expect(harness.run()).resolves.toBe("reused");
    expect(harness.events).toContainEqual({
      type: "duplicate-reap",
      keepPid: 4242,
      extraPids: [4242, 4343],
    });
    expect(harness.events.some((event) => event.type === "spawn-fresh")).toBe(false);
  });

  it("does not reuse a healthy pid-file gateway when listener enumeration is incomplete", async () => {
    const harness = makeHarness({ listenerPids: [4242], scanComplete: false });

    await expect(harness.run()).resolves.toBe("launch");
    expect(harness.events).toContainEqual({ type: "prelaunch-reap", extraPids: [4242] });
    expect(harness.events.some((event) => event.type === "http-ready")).toBe(false);
  });

  it("fails closed when no listener is attributable and the port remains occupied", async () => {
    const harness = makeHarness({
      listenerPids: [],
      scanComplete: true,
      pidFileGatewayPid: null,
      postReapPortAvailable: false,
    });

    await expect(harness.run()).rejects.toThrow("gateway port remains occupied");
    expect(harness.events).toContainEqual({ type: "prelaunch-reap", extraPids: [] });
    expect(harness.events.some((event) => event.type === "http-ready")).toBe(false);
    expect(harness.events.some((event) => event.type === "spawn-fresh")).toBe(false);
  });

  it("never includes an unobserved pid-file process in port-scoped cleanup", async () => {
    const harness = makeHarness({ listenerPids: [4343], pidFileGatewayPid: 4242 });

    await expect(harness.run()).resolves.toBe("reused");
    expect(harness.events).toContainEqual({
      type: "duplicate-reap",
      keepPid: 4343,
      extraPids: [4343],
    });
  });

  it("also excludes a drifted pid-file process from port-scoped cleanup", async () => {
    const harness = makeHarness({
      listenerPids: [4343],
      pidFileGatewayPid: 4242,
      driftPids: [4242],
    });

    await expect(harness.run()).resolves.toBe("reused");
    expect(harness.events).toContainEqual({
      type: "duplicate-reap",
      keepPid: 4343,
      extraPids: [4343],
    });
  });

  it("does not launch when the scoped prelaunch reaper fails", async () => {
    const harness = makeHarness({
      listenerPids: [4242],
      driftPids: [4242],
      prelaunchError: "__prelaunch_reap_failed__",
    });

    await expect(harness.run()).rejects.toThrow("__prelaunch_reap_failed__");
    expect(harness.events.some((event) => event.type === "spawn-fresh")).toBe(false);
  });

  it("does not report adopted reuse when duplicate cleanup fails", async () => {
    const harness = makeHarness({
      listenerPids: [4343, 4242],
      pidFileGatewayPid: null,
      duplicateError: "__duplicate_reap_failed__",
    });

    await expect(harness.run()).rejects.toThrow("__duplicate_reap_failed__");
    expect(harness.events.some((event) => event.type === "verify-sandbox-bridge")).toBe(false);
    expect(harness.events.some((event) => event.type === "spawn-fresh")).toBe(false);
  });
});
