// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const moduleMocks = vi.hoisted(() => ({
  buildRuntimeIdentity: vi.fn(() => ({
    desiredEnv: { OPENSHELL_GATEWAY_PORT: "19080" },
    identityGatewayBin: "/opt/openshell-gateway",
    launch: {
      command: "/opt/openshell-gateway",
      args: [],
      env: {},
      mode: "host",
      processGatewayBin: "/opt/openshell-gateway",
    },
  })),
  resolveDriftGatewayBin: vi.fn(() => "/opt/openshell-gateway"),
  startPackageManaged: vi.fn(async () => false),
  verifySandboxBridge: vi.fn(async () => undefined),
}));

vi.mock("./docker-driver-gateway-env", () => ({
  startPackageManagedDockerDriverGatewayWithEnvOverride: moduleMocks.startPackageManaged,
}));
vi.mock("./docker-driver-gateway-launch", () => ({
  buildDockerDriverGatewayRuntimeIdentity: moduleMocks.buildRuntimeIdentity,
  resolveDriftGatewayBin: moduleMocks.resolveDriftGatewayBin,
  openDockerDriverGatewayLog: vi.fn(() => {
    throw new Error("unexpected gateway launch");
  }),
  prepareAndLogDockerDriverGatewayLaunch: vi.fn(),
  spawnDockerDriverGateway: vi.fn(() => {
    throw new Error("unexpected gateway launch");
  }),
}));
vi.mock("./gateway-sandbox-reachability", () => ({
  verifySandboxBridgeGatewayReachableOrExit: moduleMocks.verifySandboxBridge,
}));

import {
  createDockerDriverGatewayStarter,
  type DockerDriverGatewayStartDeps,
} from "./docker-driver-gateway-start";

type RuntimeDeps = DockerDriverGatewayStartDeps["runtime"];

function createHarness(
  options: {
    gatewayBin?: string | null;
    recordedPid?: number | null;
    listenerPid?: number | null;
    runtimeDrift?: { reason: string } | null;
  } = {},
) {
  const runtime: RuntimeDeps = {
    clearDockerDriverGatewayRuntimeFiles: vi.fn(),
    getDockerDriverGatewayEnv: vi.fn(() => ({ OPENSHELL_GATEWAY_PORT: "19080" })),
    getDockerDriverGatewayPid: vi.fn(() => options.recordedPid ?? null),
    getDockerDriverGatewayPortListenerPid: vi.fn(() => options.listenerPid ?? null),
    getDockerDriverGatewayRuntimeDrift: vi.fn(() => options.runtimeDrift ?? null),
    getDockerDriverGatewayStateDir: vi.fn(() => "/tmp/nemoclaw-gateway-test"),
    isDockerDriverGatewayProcess: vi.fn(() => true),
    isDockerDriverGatewayProcessAlive: vi.fn(() => options.recordedPid != null),
    isPidAlive: vi.fn(() => false),
    rememberDockerDriverGatewayPid: vi.fn(),
    resolveOpenShellGatewayBinary: vi.fn(() =>
      options.gatewayBin === undefined ? "/opt/openshell-gateway" : options.gatewayBin,
    ),
    resolveOpenShellSandboxBinary: vi.fn(() => "/opt/openshell-sandbox"),
  };
  const restartForDrift = vi.fn();
  const checkGatewayPortAvailable = vi.fn(async () => ({ available: false }) as never);
  const deps: DockerDriverGatewayStartDeps = {
    getBinding: () => ({ name: "nemoclaw-19080", port: 19080 }),
    runtime,
    runCaptureOpenshell: vi.fn(() => "healthy"),
    isDockerDriverGatewayHttpReady: vi.fn(async () => true),
    registerDockerDriverGatewayEndpoint: vi.fn(() => true),
    isGatewayHealthy: vi.fn(() => true),
    restartDockerDriverGatewayProcessForDrift: restartForDrift,
    checkGatewayPortAvailable,
    getDockerDriverGatewayEndpoint: vi.fn(() => "https://127.0.0.1:19080"),
    isGatewayTcpReady: vi.fn(async () => true),
  };
  return {
    checkGatewayPortAvailable,
    deps,
    restartForDrift,
    runtime,
    start: createDockerDriverGatewayStarter(deps),
  };
}

describe("Docker-driver gateway starter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reuses a healthy recorded PID when its exact runtime identity matches (#6195)", async () => {
    const harness = createHarness({ recordedPid: 42 });

    await expect(harness.start({ exitOnFailure: false })).resolves.toBeUndefined();

    expect(harness.runtime.getDockerDriverGatewayRuntimeDrift).toHaveBeenCalledWith(
      42,
      { OPENSHELL_GATEWAY_PORT: "19080" },
      "/opt/openshell-gateway",
    );
    expect(harness.checkGatewayPortAvailable).not.toHaveBeenCalled();
    expect(moduleMocks.verifySandboxBridge).toHaveBeenCalledWith(false, {
      skip: false,
      port: 19080,
    });
  });

  it("adopts a matching listener PID and verifies gateway health before reuse (#6195)", async () => {
    const harness = createHarness({ listenerPid: 77 });

    await expect(harness.start({ exitOnFailure: false })).resolves.toBeUndefined();

    expect(harness.runtime.rememberDockerDriverGatewayPid).toHaveBeenCalledWith(77);
    expect(harness.runtime.getDockerDriverGatewayRuntimeDrift).toHaveBeenCalledWith(
      77,
      { OPENSHELL_GATEWAY_PORT: "19080" },
      "/opt/openshell-gateway",
    );
    expect(moduleMocks.verifySandboxBridge).toHaveBeenCalled();
  });

  it("hands a drifted recorded PID to the exact restart path (#6195)", async () => {
    const harness = createHarness({
      recordedPid: 42,
      runtimeDrift: { reason: "gateway env changed" },
    });
    harness.restartForDrift.mockImplementation(() => {
      throw new Error("restart requested");
    });

    await expect(harness.start({ exitOnFailure: false })).rejects.toThrow("restart requested");
    expect(harness.restartForDrift).toHaveBeenCalledWith(42, "gateway env changed");
  });

  it("fails without launching when no gateway binary or adoptable PID exists (#6195)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const harness = createHarness({ gatewayBin: null });

    await expect(harness.start({ exitOnFailure: false })).rejects.toThrow(
      "OpenShell gateway binary not found",
    );
    expect(harness.checkGatewayPortAvailable).toHaveBeenCalledOnce();
    expect(harness.runtime.rememberDockerDriverGatewayPid).not.toHaveBeenCalled();
  });
});
