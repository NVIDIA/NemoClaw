// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import {
  buildDockerDriverGatewayConfigToml,
  ensureDockerDriverGatewayJwtBundle,
  gatewayIdForStateDir,
} from "../docker-driver-gateway-config";
import * as gatewayBinding from "../gateway-binding";
import { createDockerDriverGatewayStart } from "./docker-driver-start";
import { createGatewayRecoveryOrchestration } from "./recovery";
import { createGatewayRegistration } from "./registration";
import * as gatewayStateLifecycleLock from "./state-lifecycle-lock";

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

  it("admits proven pre-marker state and rejects unproven custom roots before startup", async () => {
    let name = "initial";
    let port = 9000;
    const root = fs.mkdtempSync(path.join(process.cwd(), "nemoclaw-gateway-start-boundary-"));
    const stateDir = path.join(root, "gateway");
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
    const getDockerDriverGatewayEnv = vi.fn(() => {
      expect(
        gatewayBinding.managedGatewayStateRootOwnershipFailure({
          gatewayName: name,
          gatewayPort: port,
          stateDir,
        }),
      ).toBeNull();
      expect(
        gatewayStateLifecycleLock.tryAcquireManagedGatewayStateLifecycleLock(stateDir),
      ).toBeNull();
      return { OPENSHELL_SERVER_PORT: String(port) };
    });
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
      gatewayBinding,
      gatewayName: () => name,
      gatewayPort: () => port,
      getDockerDriverGatewayEndpoint: () => "https://127.0.0.1",
      getDockerDriverGatewayEnv,
      getDockerDriverGatewayPid: () => null,
      getDockerDriverGatewayPortListenerScan: () => ({
        complete: true,
        pids: [],
        unverifiedPids: [],
      }),
      getDockerDriverGatewayRuntimeDrift: () => null,
      getDockerDriverGatewayStateDir: () => stateDir,
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
    const jwtBundle = ensureDockerDriverGatewayJwtBundle(stateDir);
    fs.writeFileSync(
      path.join(stateDir, "openshell-gateway.toml"),
      buildDockerDriverGatewayConfigToml(
        {
          OPENSHELL_GRPC_ENDPOINT: `https://127.0.0.1:${String(port)}`,
          OPENSHELL_LOCAL_TLS_DIR: path.join(stateDir, "tls"),
          OPENSHELL_DOCKER_NETWORK_NAME: "openshell-docker",
          OPENSHELL_DOCKER_SUPERVISOR_IMAGE: "supervisor:test",
        },
        "/usr/bin/openshell-sandbox",
        jwtBundle,
        gatewayIdForStateDir(stateDir),
      ),
      { mode: 0o600 },
    );
    expect(
      fs.existsSync(path.join(stateDir, gatewayBinding.MANAGED_GATEWAY_STATE_ROOT_MARKER)),
    ).toBe(false);
    vi.stubEnv("NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR", `  ${stateDir}  `);
    try {
      await start.startDockerDriverGateway();

      expect(managedStart).toHaveBeenCalledWith(
        expect.objectContaining({ gatewayName: "resumed" }),
      );
      expect(verifyReachability).toHaveBeenCalledWith(
        false,
        expect.objectContaining({ port: 9777 }),
      );
      expect(
        gatewayBinding.managedGatewayStateRootOwnershipFailure({
          gatewayName: "resumed",
          gatewayPort: 9777,
          stateDir,
        }),
      ).toBeNull();
      const releasedLifecycleLock =
        gatewayStateLifecycleLock.acquireManagedGatewayStateLifecycleLock(stateDir);
      gatewayStateLifecycleLock.releaseManagedGatewayStateLifecycleLock(releasedLifecycleLock);

      const unsafeStateDir = path.join(root, "operator-data");
      fs.mkdirSync(unsafeStateDir, { mode: 0o700 });
      fs.writeFileSync(path.join(unsafeStateDir, "keep.txt"), "keep\n", { mode: 0o600 });
      vi.stubEnv("NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR", unsafeStateDir);

      await expect(start.startDockerDriverGateway()).rejects.toThrow(/refusing to adopt/);
      expect(fs.readFileSync(path.join(unsafeStateDir, "keep.txt"), "utf8")).toBe("keep\n");
      expect(getDockerDriverGatewayEnv).toHaveBeenCalledTimes(1);
      expect(managedStart).toHaveBeenCalledTimes(1);

      const writableParent = path.join(root, "writable-parent");
      const writableStateDir = path.join(writableParent, "gateway");
      fs.mkdirSync(writableParent, { mode: 0o777 });
      fs.chmodSync(writableParent, 0o777);
      vi.stubEnv("NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR", writableStateDir);

      await expect(start.startDockerDriverGateway()).rejects.toThrow(
        /ancestor .* is not a trusted real directory/,
      );
      expect(
        fs.existsSync(
          path.join(writableStateDir, gatewayBinding.MANAGED_GATEWAY_STATE_ROOT_MARKER),
        ),
      ).toBe(false);
      expect(fs.existsSync(writableStateDir)).toBe(false);
      expect(getDockerDriverGatewayEnv).toHaveBeenCalledTimes(1);
      expect(managedStart).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(root, { force: true, recursive: true });
    }
  });
});
