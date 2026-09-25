// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { classifyManagedGatewayPortConflict } from "../../readiness/gateway-production";
import {
  buildDockerDriverGatewayRuntimeMarker,
  getDockerDriverGatewayRuntimeMarkerPath,
  resolveDockerDriverGatewayStateDir,
} from "../docker-driver-gateway-runtime-marker";
import {
  observeNativePodmanGatewayReadiness,
  type PodmanGatewayReadinessDeps,
} from "./podman-gateway-readiness";

const PID = 4242;
const UID = 1000;
const GATEWAY_NAME = "nemoclaw";
const GATEWAY_PORT = 8080;
const GATEWAY_BIN = "/usr/local/bin/openshell-gateway";
const ENVIRONMENT = { HOME: "/home/nemoclaw", PATH: "/usr/bin:/bin" };
const STATE_DIR = resolveDockerDriverGatewayStateDir(ENVIRONMENT, ENVIRONMENT.HOME, GATEWAY_PORT);
const PID_FILE = path.join(STATE_DIR, "openshell-gateway.pid");
const MARKER_FILE = getDockerDriverGatewayRuntimeMarkerPath(STATE_DIR);
const PODMAN_SOCKET = "/run/user/1000/podman/podman.sock";

function input() {
  return {
    environment: ENVIRONMENT,
    platform: "linux" as const,
    architecture: "x64" as const,
    gatewayName: GATEWAY_NAME,
    gatewayPort: GATEWAY_PORT,
    expectedEndpoint: `https://169.254.2.2:${String(GATEWAY_PORT)}`,
    managedGatewayEndpoints: [
      `https://127.0.0.1:${String(GATEWAY_PORT)}`,
      `https://127.0.0.1:${String(GATEWAY_PORT)}`,
    ],
    portAvailable: false,
    installedOpenShellVersion: "0.0.116",
    trustedGatewayBin: GATEWAY_BIN,
    runtimeSocketPath: PODMAN_SOCKET,
  };
}

function readinessDeps(
  markerOverrides: Partial<ReturnType<typeof buildDockerDriverGatewayRuntimeMarker>> = {},
  processState = "S",
): PodmanGatewayReadinessDeps {
  const marker = {
    ...buildDockerDriverGatewayRuntimeMarker({
      pid: PID,
      desiredEnv: {},
      endpoint: input().expectedEndpoint,
      gatewayBin: GATEWAY_BIN,
      openshellVersion: "0.0.116",
      platform: "linux",
      arch: "x64",
      runtimeProviderId: "podman",
    }),
    ...markerOverrides,
  };
  const files = new Map([
    [PID_FILE, `${String(PID)}\n`],
    [MARKER_FILE, `${JSON.stringify(marker)}\n`],
  ]);
  const commands = new Map([
    [
      ["lsof", "-ti", `:${String(GATEWAY_PORT)}`, "-sTCP:LISTEN"].join("\0"),
      { status: 0, stdout: `${String(PID)}\n`, stderr: "" },
    ],
    [
      ["ps", "-p", String(PID), "-o", "uid="].join("\0"),
      { status: 0, stdout: `${String(UID)}\n`, stderr: "" },
    ],
    [
      ["ps", "-p", String(PID), "-o", "stat="].join("\0"),
      { status: 0, stdout: `${processState}\n`, stderr: "" },
    ],
  ]);
  return {
    currentUid: () => UID,
    readOwnedFile: vi.fn((filePath) => files.get(filePath) ?? null),
    readProcessArguments: vi.fn(
      () => `${GATEWAY_BIN} --name ${GATEWAY_NAME} --port ${String(GATEWAY_PORT)}`,
    ),
    readProcessExecutable: vi.fn(() => GATEWAY_BIN),
    readProcessEnvironment: vi.fn(() => null),
    readManagedService: vi.fn(() => null),
    runtimeFileMissing: vi.fn(() => false),
    runHost: vi.fn(
      (command, args) =>
        commands.get([command, ...args].join("\0")) ?? {
          status: 1,
          stdout: "",
          stderr: "unexpected command",
        },
    ),
  };
}

function managedServiceDeps() {
  const deps = readinessDeps();
  return {
    ...deps,
    readOwnedFile: vi.fn(() => null),
    runtimeFileMissing: vi.fn(() => true),
    readProcessArguments: vi.fn(() => GATEWAY_BIN),
    readManagedService: vi.fn(() => ({ pid: PID, executablePath: GATEWAY_BIN })),
    readProcessEnvironment: vi.fn(() => ({
      OPENSHELL_DB_URL: `sqlite:${path.join(STATE_DIR, "openshell.db")}`,
      OPENSHELL_DRIVERS: "podman",
      OPENSHELL_PODMAN_SOCKET: PODMAN_SOCKET,
      OPENSHELL_GRPC_ENDPOINT: input().expectedEndpoint,
      OPENSHELL_SERVER_PORT: String(GATEWAY_PORT),
    })),
    runHost: vi.fn((command: string, args: readonly string[], env: NodeJS.ProcessEnv) =>
      command === GATEWAY_BIN && args.join(" ") === "--version"
        ? { status: 0, stdout: "openshell-gateway 0.0.116\n", stderr: "" }
        : deps.runHost(command, args, env),
    ),
  };
}

describe("native Podman gateway readiness", () => {
  it("reuses the managed service after startup clears standalone ownership files", () => {
    const deps = managedServiceDeps();
    const observed = observeNativePodmanGatewayReadiness(input(), deps);
    expect(observed.listenerScan).toEqual({ pids: [PID], unverifiedPids: [], complete: true });
    expect(observed.targetBoundListenerPids).toEqual([PID]);
    expect(observed.versionCompatibility).toBe("compatible");
    expect(
      classifyManagedGatewayPortConflict(
        false,
        observed.listenerScan,
        "healthy",
        false,
        observed.endpointBinding,
        observed.targetBoundListenerPids.includes(PID),
      ),
    ).toBe("none");
    expect(
      deps.runHost.mock.calls.every(([command]) => ["lsof", "ps", GATEWAY_BIN].includes(command)),
    ).toBe(true);
  });

  it.each([
    ["OPENSHELL_DRIVERS", "docker"],
    ["OPENSHELL_PODMAN_SOCKET", "/run/foreign/podman.sock"],
    ["OPENSHELL_SERVER_PORT", "8990"],
    ["OPENSHELL_GRPC_ENDPOINT", "https://127.0.0.1:8080"],
    ["OPENSHELL_DB_URL", "sqlite:/foreign/openshell.db"],
    ["NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE", "foreign"],
  ])("rejects a managed service with mismatched %s", (key, value) => {
    const deps = managedServiceDeps();
    const env = { ...deps.readProcessEnvironment(), [key]: value };
    deps.readProcessEnvironment.mockReturnValue(env);
    expect(observeNativePodmanGatewayReadiness(input(), deps).listenerScan.unverifiedPids).toEqual([
      PID,
    ]);
    expect(deps.runHost.mock.calls.some(([command]) => command === GATEWAY_BIN)).toBe(false);
  });

  const invalidServices: Record<string, Partial<PodmanGatewayReadinessDeps>> = {
    "no trusted service": { readManagedService: () => null },
    "another service PID": {
      readManagedService: () => ({ pid: 5252, executablePath: GATEWAY_BIN }),
    },
    "another service executable": {
      readManagedService: () => ({ pid: PID, executablePath: "/foreign" }),
    },
    "another process executable": { readProcessExecutable: () => "/foreign" },
    "CLI overrides": { readProcessArguments: () => `${GATEWAY_BIN} --port 8990` },
    "unreadable process environment": { readProcessEnvironment: () => null },
    "an unreadable standalone record": { runtimeFileMissing: () => false },
    "a partial standalone record": {
      readOwnedFile: (file) => (file === PID_FILE ? String(PID) : null),
    },
    "a service restart during observation": {
      readManagedService: vi
        .fn()
        .mockReturnValueOnce({ pid: PID, executablePath: GATEWAY_BIN })
        .mockReturnValue(null),
    },
    "an executable change during observation": {
      readProcessExecutable: vi.fn().mockReturnValueOnce(GATEWAY_BIN).mockReturnValue("/foreign"),
    },
  };
  it.each(Object.entries(invalidServices))(
    "rejects managed ownership with %s",
    (_label, overrides) => {
      const observed = observeNativePodmanGatewayReadiness(input(), {
        ...managedServiceDeps(),
        ...overrides,
      });
      expect(observed.listenerScan.unverifiedPids).toEqual([PID]);
      expect(observed.versionCompatibility).toBe("unknown");
    },
  );

  it.each([
    [0, "openshell-gateway 0.0.115", "drift"],
    [null, "", "unknown"],
  ] as const)(
    "keeps the managed gateway version independent of the CLI (%s, %s)",
    (status, stdout, expected) => {
      const deps = managedServiceDeps();
      const run = deps.runHost;
      const observation = observeNativePodmanGatewayReadiness(input(), {
        ...deps,
        runHost: (command, args, env) =>
          command === GATEWAY_BIN ? { status, stdout, stderr: "" } : run(command, args, env),
      });
      expect(observation.listenerScan.pids).toEqual([PID]);
      expect(observation.versionCompatibility).toBe(expected);
    },
  );

  it("recognizes one target-bound listener and its recorded OpenShell version (#10984)", () => {
    expect(observeNativePodmanGatewayReadiness(input(), readinessDeps())).toEqual({
      endpointBinding: "match",
      listenerScan: { pids: [PID], unverifiedPids: [], complete: true },
      targetBoundListenerPids: [PID],
      versionCompatibility: "compatible",
    });
  });

  it("admits the host registration while retaining sandbox-facing marker authority", () => {
    const observed = observeNativePodmanGatewayReadiness(input(), readinessDeps());
    expect(
      classifyManagedGatewayPortConflict(
        false,
        observed.listenerScan,
        "healthy",
        false,
        observed.endpointBinding,
        observed.targetBoundListenerPids.includes(PID),
      ),
    ).toBe("none");
    const wrongMarker = observeNativePodmanGatewayReadiness(
      input(),
      readinessDeps({ endpoint: "https://127.0.0.1:8080" }),
    );
    expect(wrongMarker.endpointBinding).toBe("match");
    expect(
      classifyManagedGatewayPortConflict(
        false,
        wrongMarker.listenerScan,
        "healthy",
        false,
        wrongMarker.endpointBinding,
        wrongMarker.targetBoundListenerPids.includes(PID),
      ),
    ).toBe("owner-mismatch");
  });

  it.each([
    ["another provider", { driver: "docker" }],
    ["another endpoint", { endpoint: "https://169.254.2.2:8990" }],
    ["another process", { pid: 5252 }],
    ["another binary", { gatewayBin: "/usr/bin/foreign-gateway" }],
  ] as const)("rejects a listener bound to %s (#10984)", (_label, markerOverrides) => {
    expect(observeNativePodmanGatewayReadiness(input(), readinessDeps(markerOverrides))).toEqual({
      endpointBinding: "match",
      listenerScan: { pids: [], unverifiedPids: [PID], complete: true },
      targetBoundListenerPids: [],
      versionCompatibility: "unknown",
    });
  });

  it("reports version drift only after listener ownership is proven (#10984)", () => {
    expect(
      observeNativePodmanGatewayReadiness(input(), readinessDeps({ openshellVersion: "0.0.115" }))
        .versionCompatibility,
    ).toBe("drift");
  });

  it.each(["T", "t"])("rejects a stopped process in state %s (#10984)", (processState) => {
    expect(observeNativePodmanGatewayReadiness(input(), readinessDeps({}, processState))).toEqual({
      endpointBinding: "match",
      listenerScan: { pids: [], unverifiedPids: [PID], complete: true },
      targetBoundListenerPids: [],
      versionCompatibility: "unknown",
    });
  });

  it.each([
    ["sandbox-facing address", ["https://169.254.2.2:8080"]],
    ["wrong port", ["https://127.0.0.1:8990"]],
    ["wrong scheme", ["http://127.0.0.1:8080"]],
    ["foreign host", ["https://foreign.example:8080"]],
    ["unverified endpoint", [null]],
    ["mixed origins", ["https://127.0.0.1:8080", "https://foreign.example:8080"]],
  ] as const)("rejects host registration with %s", (_label, endpoints) => {
    const observation = observeNativePodmanGatewayReadiness(
      { ...input(), managedGatewayEndpoints: endpoints },
      readinessDeps(),
    );
    expect(observation.endpointBinding).toBe("mismatch");
    expect(observation.listenerScan.pids).toEqual([PID]);
  });

  it("keeps missing host registration unknown even with a verified listener", () => {
    const observation = observeNativePodmanGatewayReadiness(
      { ...input(), managedGatewayEndpoints: [] },
      readinessDeps(),
    );
    expect(observation.endpointBinding).toBe("unknown");
    expect(observation.listenerScan.pids).toEqual([PID]);
  });

  it("fails closed when listener enumeration is inconclusive (#10984)", () => {
    const deps = {
      ...readinessDeps(),
      runHost: vi.fn(() => ({ status: null, stdout: "", stderr: "timed out" })),
    };

    expect(observeNativePodmanGatewayReadiness(input(), deps)).toEqual({
      endpointBinding: "match",
      listenerScan: { pids: [], unverifiedPids: [], complete: false },
      targetBoundListenerPids: [],
      versionCompatibility: "unknown",
    });
  });
});
