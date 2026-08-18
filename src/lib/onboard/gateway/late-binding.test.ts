// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { createDockerDriverGatewayStart } from "./docker-driver-start";
import { createGatewayRecoveryOrchestration } from "./recovery";
import { createGatewayRegistration } from "./registration";

const runResult = (status = 0) =>
  ({ status, stdout: "", stderr: "" }) as ReturnType<typeof import("../../runner").run>;

describe("gateway lifecycle late binding", () => {
  it("uses the current binding for select, add, and health commands", () => {
    let name = "initial";
    const runCaptureOpenshell = vi.fn((args: string[]) => args.join(" "));
    const runOpenshell = vi.fn(() => runResult());
    const registration = createGatewayRegistration({
      gatewayName: () => name,
      getDockerDriverGatewayEndpointArg: () => "https://127.0.0.1:9443",
      getGatewayLocalEndpoint: () => "https://127.0.0.1:9443",
      hasStaleGateway: () => false,
      isGatewayHealthy: () => false,
      isLinuxDockerDriverGatewayEnabled: () => true,
      removeDockerDriverGatewayRegistration: () => true,
      runCaptureOpenshell,
      runOpenshell,
      runQuietOpenshell: vi.fn(() => ({ status: 0 })),
    });

    name = "resumed";
    expect(registration.registerDockerDriverGatewayEndpoint()).toBe(true);

    expect(runCaptureOpenshell).toHaveBeenCalledWith(
      ["gateway", "info", "-g", "resumed"],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(runOpenshell).toHaveBeenCalledWith(
      ["gateway", "add", "https://127.0.0.1:9443", "--local", "--name", "resumed"],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(runOpenshell).toHaveBeenCalledWith(
      ["gateway", "select", "resumed"],
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("uses the current binding for recovery select and health commands", async () => {
    let name = "initial";
    const runOpenshell = vi.fn(() => runResult());
    const runCaptureOpenshell = vi
      .fn<(args: string[], options?: { ignoreError?: boolean }) => string>()
      .mockReturnValueOnce("Disconnected")
      .mockReturnValue("Connected");
    const recovery = createGatewayRecoveryOrchestration({
      SCRIPTS: "/tmp/scripts",
      assertGatewayStartAllowed: vi.fn(),
      attachGatewayMetadataIfNeeded: () => true,
      envInt: (_name, fallback) => fallback,
      gatewayClusterHealthcheckPassed: () => true,
      gatewayName: () => name,
      getContainerRuntime: () => "docker",
      getGatewayClusterContainerState: () => "missing",
      isGatewayHealthy: () => true,
      isGatewayHttpReady: async () => true,
      isLinuxDockerDriverGatewayEnabled: () => false,
      isSelectedGateway: () => false,
      repairGatewayBootstrapSecrets: () => ({ repaired: true, missingSecrets: [] }),
      run: vi.fn(() => runResult()),
      runCaptureOpenshell,
      runOpenshell,
      shouldPatchCoredns: () => false,
      sleepSeconds: vi.fn(),
      startDockerDriverGateway: vi.fn(),
      startGatewayWithOptions: vi.fn(),
    });

    name = "resumed";
    await expect(recovery.recoverGatewayRuntime()).resolves.toBe(true);

    expect(runOpenshell).toHaveBeenCalledWith(
      ["gateway", "select", "resumed"],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(runCaptureOpenshell).toHaveBeenCalledWith(
      ["gateway", "info", "-g", "resumed"],
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("uses the current binding for Docker-driver reachability", async () => {
    let name = "initial";
    let port = 9000;
    const verifyReachability = vi.fn(async () => undefined);
    const managedStart = vi.fn(
      async (
        options: Parameters<
          typeof import("../docker-driver-gateway-env").startPackageManagedDockerDriverGatewayWithEnvOverride
        >[0],
      ) => {
        await options.verifySandboxBridgeGatewayReachableOrExit(false, {});
        return true;
      },
    );
    const dockerDriverGatewayEnv = {
      startPackageManagedDockerDriverGatewayWithEnvOverride: managedStart,
    } as unknown as typeof import("../docker-driver-gateway-env");
    const start = createDockerDriverGatewayStart({
      SUPPORTED_OPENSHELL_FALLBACK_VERSION: "0.0.0",
      checkGatewayPortAvailable: async () => ({ ok: true }),
      clearDockerDriverGatewayRuntimeFiles: vi.fn(),
      createGatewayServicePortOwnership: () => ({
        portListenerScan: { complete: true, pids: [], unverifiedPids: [] },
        preparePort: vi.fn(),
        reportUntrustedGatewayPort: (message) => {
          throw new Error(message);
        },
        validatePortOwner: vi.fn(),
      }),
      dockerDriverGatewayEnv,
      envInt: (_name, fallback) => fallback,
      gatewayBinding: {
        resolveGatewayCompatContainerName: (value: number) => `gateway-${value}`,
      } as typeof import("../gateway-binding"),
      gatewayName: () => name,
      gatewayPort: () => port,
      getDockerDriverGatewayEndpoint: () => "https://127.0.0.1",
      getDockerDriverGatewayEnv: () => ({ OPENSHELL_SERVER_PORT: String(port) }),
      getDockerDriverGatewayPid: () => null,
      getDockerDriverGatewayPortListenerScan: () => ({
        complete: true,
        pids: [],
        unverifiedPids: [],
      }),
      getDockerDriverGatewayRuntimeDrift: () => null,
      getDockerDriverGatewayStateDir: () => "/tmp/gateway",
      getInstalledOpenshellVersion: () => "0.0.0",
      isDockerDriverGatewayHttpReady: async () => true,
      isDockerDriverGatewayProcessAlive: () => false,
      isDockerDriverGatewayStateInUse: () => false,
      isGatewayHealthy: () => true,
      isGatewayTcpReady: async () => true,
      isPidAlive: () => false,
      logDockerDriverGatewayRestart: vi.fn(),
      registerDockerDriverGatewayEndpoint: () => true,
      rememberDockerDriverGatewayPid: vi.fn(),
      resolveOpenShellGatewayBinary: () => null,
      resolveOpenShellSandboxBinary: () => null,
      runCaptureOpenshell: () => "",
      sleepSeconds: vi.fn(),
      verifySandboxBridgeGatewayReachableOrExit: verifyReachability,
    });

    name = "resumed";
    port = 9777;
    await start.startDockerDriverGateway();

    expect(managedStart).toHaveBeenCalledWith(expect.objectContaining({ gatewayName: "resumed" }));
    expect(verifyReachability).toHaveBeenCalledWith(false, expect.objectContaining({ port: 9777 }));
  });
});
