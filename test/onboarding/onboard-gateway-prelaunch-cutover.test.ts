// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  type DockerDriverGatewayCutoverDeps,
  type DockerDriverGatewayCutoverInput,
  readDockerDriverGatewayHealth,
  runDockerDriverGatewayCutover,
  runDockerDriverGatewayManagedFallback,
} from "../../src/lib/onboard/docker-driver-gateway-cutover";

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
      unverifiedPids: [],
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
  it("captures the named and active gateway health views", () => {
    const calls: string[][] = [];
    const health = readDockerDriverGatewayHealth((args) => {
      calls.push(args);
      return args.join(" ");
    }, "nemoclaw");

    expect(health).toEqual({
      status: "status",
      namedInfo: "gateway info -g nemoclaw",
      activeInfo: "gateway info",
    });
    expect(calls).toEqual([["status"], ["gateway", "info", "-g", "nemoclaw"], ["gateway", "info"]]);
  });

  it("skips standalone cutover when managed startup succeeds (#8104)", async () => {
    let standaloneCalls = 0;

    await expect(
      runDockerDriverGatewayManagedFallback(
        async () => true,
        async () => {
          standaloneCalls += 1;
          return "launch";
        },
      ),
    ).resolves.toBe("managed");
    expect(standaloneCalls).toBe(0);
  });

  it("refreshes listener evidence through the onboard gateway caller (#8104)", () => {
    const onboardPath = JSON.stringify(path.join(import.meta.dirname, "../../src/lib/onboard.ts"));
    const script = `
const Module = require("node:module");
const originalLoad = Module._load;
let managedResult = true;
let probe = 0;
let standaloneCalls = 0;
const observedListenerPids = [];

Module._load = function(request, parent, isMain) {
  const actual = () => originalLoad.call(this, request, parent, isMain);
  if (request.endsWith("/preflight")) {
    return { ...actual(), checkPortAvailable: async () => ({ ok: true, pid: ++probe }) };
  }
  if (request.endsWith("/docker-driver-gateway-runtime")) {
    const runtime = actual();
    return {
      ...runtime,
      createDockerDriverGatewayRuntimeHelpers: (deps) => ({
        ...runtime.createDockerDriverGatewayRuntimeHelpers(deps),
        createGatewayServicePortOwnership: () => ({
          preparePort: () => {},
          reportUntrustedGatewayPort: () => {},
          validatePortOwner: () => {},
        }),
        getDockerDriverGatewayEnv: () => ({}),
        getDockerDriverGatewayPid: () => null,
        getDockerDriverGatewayPortListenerScan: (portCheck) => ({
          complete: true,
          pids: [portCheck.pid],
          unverifiedPids: [],
        }),
        getDockerDriverGatewayStateDir: () => "/test/state",
        resolveOpenShellGatewayBinary: () => null,
        resolveOpenShellSandboxBinary: () => null,
      }),
    };
  }
  if (request.endsWith("/docker-driver-gateway-env")) {
    return {
      ...actual(),
      getGatewayPortCheckOptions: () => ({}),
      startPackageManagedDockerDriverGatewayWithEnvOverride: async () => managedResult,
    };
  }
  if (request.endsWith("/docker-driver-gateway-cutover")) {
    const cutover = actual();
    return {
      ...cutover,
      readDockerDriverGatewayHealth: () => ({ activeInfo: "", namedInfo: "", status: "" }),
      runDockerDriverGatewayCutover: async (input) => {
        standaloneCalls += 1;
        observedListenerPids.push(input.portListenerScan.pids);
        return "reused";
      },
    };
  }
  if (request.endsWith("/openshell-cli")) {
    return {
      createOpenshellCliHelpers: () => ({
        getDockerDriverGatewayEndpointArg: () => "https://127.0.0.1:8080",
        getGatewayPortArg: () => "8080",
        getOpenshellBinary: () => "/test/bin/openshell",
        openshellArgv: (args) => args,
        openshellShellCommand: (args) => args.join(" "),
        runCaptureOpenshell: () => "openshell 0.0.85",
        runOpenshell: () => ({ status: 0 }),
      }),
    };
  }
  return actual();
};

const { startDockerDriverGateway } = require(${onboardPath});
(async () => {
  await startDockerDriverGateway({ exitOnFailure: false });
  const managedSuccessStandaloneCalls = standaloneCalls;
  managedResult = false;
  probe = 0;
  await startDockerDriverGateway({ exitOnFailure: false });
  console.log(JSON.stringify({ managedSuccessStandaloneCalls, observedListenerPids }));
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
`;
    const result = spawnSync(process.execPath, ["-e", script], {
      cwd: path.join(import.meta.dirname, "../.."),
      encoding: "utf8",
      timeout: 30_000,
    });

    expect(result.status, result.stderr).toBe(0);
    const payload = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}");
    expect(payload).toEqual({ managedSuccessStandaloneCalls: 0, observedListenerPids: [[2]] });
  });

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

  it("preserves the occupied-port gate after managed startup falls back (#8104)", async () => {
    let listenerPids = [4242];
    let harness: ReturnType<typeof makeHarness> | undefined;

    await expect(
      runDockerDriverGatewayManagedFallback(
        async () => {
          listenerPids = [];
          return false;
        },
        () => {
          harness = makeHarness({
            listenerPids,
            scanComplete: true,
            pidFileGatewayPid: null,
            postReapPortAvailable: false,
          });
          return harness.run();
        },
      ),
    ).rejects.toThrow("gateway port remains occupied");
    expect(harness?.events).toContainEqual({ type: "prelaunch-reap", extraPids: [] });
    expect(harness?.events.some((event) => event.type === "spawn-fresh")).toBe(false);
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
