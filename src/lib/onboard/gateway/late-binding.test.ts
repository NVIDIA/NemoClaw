// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { gatewayAdaptersForTest } from "../../../../test/helpers/openshell-gateway-adapters";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import {
  buildDockerDriverGatewayConfigToml,
  ensureDockerDriverGatewayJwtBundle,
  gatewayIdForStateDir,
} from "../docker-driver-gateway-config";
import * as dockerDriverGatewayCutover from "../docker-driver-gateway-cutover";
import * as dockerDriverGatewayLaunch from "../docker-driver-gateway-launch";
import { assertDockerDriverGatewayBindAddressSafe } from "../docker-driver-gateway-env";
import { buildSelectedOpenShellSubprocessEnv } from "../../adapters/openshell/command-argv";
import type { OpenShellRuntimeSelection } from "../../adapters/openshell/runtime-selection";
import * as gatewayBinding from "../gateway-binding";
import {
  createDockerDriverGatewayStart,
  resolveDockerDriverGatewayRuntimeMarkerEndpoint,
  resolveSelectedGatewayServiceStopCommand,
} from "./docker-driver-start";
import { createGatewayRecoveryOrchestration } from "./recovery";
import { createGatewayRegistration } from "./registration";
import * as gatewayStateLifecycleLock from "./state-lifecycle-lock";

const runResult = (status = 0) =>
  ({ status, stdout: "", stderr: "" }) as ReturnType<typeof import("../../runner").run>;

describe("gateway lifecycle late binding", () => {
  it("records the selected runtime's advertised gateway endpoint", () => {
    const fallback = vi.fn(() => "https://127.0.0.1:8080");

    expect(
      resolveDockerDriverGatewayRuntimeMarkerEndpoint(
        { OPENSHELL_GRPC_ENDPOINT: "https://169.254.2.2:8080" },
        fallback,
      ),
    ).toBe("https://169.254.2.2:8080");
    expect(fallback).not.toHaveBeenCalled();
  });

  it("retains the Docker gateway endpoint fallback for legacy launch environments", () => {
    expect(
      resolveDockerDriverGatewayRuntimeMarkerEndpoint({}, () => "https://127.0.0.1:8080"),
    ).toBe("https://127.0.0.1:8080");
  });

  async function captureFailedStartRecovery(
    ownsSelectedState: boolean,
    runtimeSelection?: OpenShellRuntimeSelection,
  ) {
    const root = fs.mkdtempSync(path.join(process.cwd(), "nemoclaw-gateway-port-recovery-"));
    const stateDir = path.join(root, "gateway");
    const adapters = gatewayAdaptersForTest();
    const lines: string[] = [];
    const serviceTarget = vi.fn(() => ({
      executablePath: "/opt/openshell/openshell-gateway",
      pid: 5444,
      stopCommand: "systemctl --user stop openshell-gateway",
    }));
    const readProcessEnvironment = vi.fn(
      () =>
        `NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE=${ownsSelectedState ? gatewayIdForStateDir(stateDir) : "another-gateway"}`,
    );
    const checkGatewayPortAvailable = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValue({ ok: false, pid: 5444, process: "openshell-gateway" });
    const managedFallbackSpy = vi
      .spyOn(dockerDriverGatewayCutover, "runDockerDriverGatewayManagedFallback")
      .mockResolvedValue("launch");
    const runtimeIdentitySpy = vi
      .spyOn(dockerDriverGatewayLaunch, "buildDockerDriverGatewayRuntimeIdentity")
      .mockReturnValue({
        launch: {
          command: "/opt/openshell/openshell-gateway",
          args: [],
          argv0: "openshell-gateway[nemoclaw=nemoclaw-9777;port=9777]",
          env: {},
          mode: "host",
          processGatewayBin: "/opt/openshell/openshell-gateway",
        },
        desiredEnv: {},
        driftGatewayBin: "/opt/openshell/openshell-gateway",
        identityGatewayBin: "/opt/openshell/openshell-gateway",
      });
    const prepareSpy = vi
      .spyOn(dockerDriverGatewayLaunch, "prepareAndLogDockerDriverGatewayLaunch")
      .mockImplementation(() => undefined);
    const spawnSpy = vi
      .spyOn(dockerDriverGatewayLaunch, "spawnDockerDriverGateway")
      .mockImplementation((_launch, logFd) => {
        fs.writeSync(
          logFd,
          "migration 6 was previously applied and is missing in the resolved migrations\n",
        );
        fs.closeSync(logFd);
        return {
          pid: 4321,
          once: vi.fn(),
          unref: vi.fn(),
        } as unknown as ReturnType<typeof dockerDriverGatewayLaunch.spawnDockerDriverGateway>;
      });
    vi.stubEnv("HOME", root);
    vi.stubEnv("NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR", "");

    try {
      const start = createDockerDriverGatewayStart({
        observer: adapters.observer,
        SUPPORTED_OPENSHELL_FALLBACK_VERSION: "0.0.0",
        checkGatewayPortAvailable,
        clearDockerDriverGatewayRuntimeFiles: vi.fn(),
        createGatewayServicePortOwnership: () => ({
          portListenerScan: { complete: true, pids: [], unverifiedPids: [] },
          preparePort: vi.fn(),
          reportUntrustedGatewayPort: (message) => {
            throw new Error(message);
          },
          validatePortOwner: vi.fn(),
        }),
        dockerDriverGatewayEnv: {} as typeof import("../docker-driver-gateway-env"),
        envInt: () => 0,
        gatewayBinding: {
          resolveGatewayCompatContainerName: () => "openshell-gateway-test",
          resolveGatewayStateDirForPort: () => stateDir,
        } as unknown as typeof gatewayBinding,
        gatewayName: () => "nemoclaw-9777",
        gatewayPort: () => 9777,
        getDockerDriverGatewayEndpoint: () => "https://127.0.0.1:9777",
        getDockerDriverGatewayEnv: () => ({}),
        getDockerDriverGatewayPid: () => null,
        getDockerDriverGatewayPortListenerScan: () => ({
          complete: true,
          pids: [],
          unverifiedPids: [],
        }),
        getDockerDriverGatewayRuntimeDrift: () => null,
        getDockerDriverGatewayStateDir: () => stateDir,
        getGatewayPortListenerRawScan: () => ({ complete: true, pids: [5444] }),
        getTrustedActiveOpenShellGatewayUserServiceStopTarget: serviceTarget,
        getInstalledOpenshellVersion: () => "0.0.0",
        isDockerDriverGatewayHttpReady: async () => false,
        isDockerDriverGatewayProcess: () => true,
        isDockerDriverGatewayProcessAlive: () => false,
        isGatewayTcpReady: async () => false,
        isPidAlive: () => true,
        logDockerDriverGatewayRestart: vi.fn(),
        registerDockerDriverGatewayEndpoint: async () => false,
        rememberDockerDriverGatewayPid: vi.fn(),
        resolveOpenShellGatewayBinary: () => "/opt/openshell/openshell-gateway",
        resolveOpenShellSandboxBinary: () => null,
        runner: {
          runCapture: readProcessEnvironment,
          runCaptureEx: () => ({ stdout: "", exitCode: null, timedOut: true }),
        },
        runCaptureOpenshell: () => "",
        sleepSeconds: vi.fn(),
      });

      await expect(
        start.startDockerDriverGateway({
          runtimeSelection,
          exitOnFailure: false,
          output: {
            error: (message) => lines.push(message),
            log: vi.fn(),
            step: vi.fn(),
            warn: vi.fn(),
          },
        }),
      ).rejects.toThrow(/failed to start within/);

      return {
        runtimeEnvironment: runtimeIdentitySpy.mock.calls[0]?.[0].env,
        output: lines.join("\n"),
        processEnvironmentCalls: readProcessEnvironment.mock.calls,
        serviceTargetCalls: serviceTarget.mock.calls.length,
      };
    } finally {
      spawnSpy.mockRestore();
      prepareSpy.mockRestore();
      runtimeIdentitySpy.mockRestore();
      managedFallbackSpy.mockRestore();
      vi.unstubAllEnvs();
      fs.rmSync(root, { force: true, recursive: true });
    }
  }

  it("preserves native Podman context through selected-target gateway startup", async () => {
    vi.stubEnv("NEMOCLAW_GATEWAY_RUNTIME", "podman");
    vi.stubEnv("OPENSHELL_PODMAN_SOCKET", "/run/user/1000/podman/podman.sock");
    vi.stubEnv("CONTAINERS_CONF", "/tmp/containers.conf");
    vi.stubEnv("CONTAINERS_STORAGE_CONF", "/tmp/storage.conf");
    vi.stubEnv("XDG_RUNTIME_DIR", "/run/user/1000");
    vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus");
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://hostile.invalid");
    vi.stubEnv("OPENSHELL_TOKEN", "hostile-token");
    vi.stubEnv("NVIDIA_INFERENCE_API_KEY", "provider-secret");
    const clientOnlyEnvironment = buildSelectedOpenShellSubprocessEnv({
      gatewayName: "nemoclaw-9777",
      workspace: "default",
    });
    const result = await captureFailedStartRecovery(true, {
      gatewayName: "nemoclaw-9777",
      workspace: "default",
    });
    expect(result.runtimeEnvironment).toMatchObject({
      NEMOCLAW_GATEWAY_RUNTIME: "podman",
      OPENSHELL_PODMAN_SOCKET: "/run/user/1000/podman/podman.sock",
      CONTAINERS_CONF: "/tmp/containers.conf",
      CONTAINERS_STORAGE_CONF: "/tmp/storage.conf",
      XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      OPENSHELL_GATEWAY: "nemoclaw-9777",
      OPENSHELL_WORKSPACE: "default",
    });
    expect(result.runtimeEnvironment).not.toHaveProperty("OPENSHELL_GATEWAY_ENDPOINT");
    expect(result.runtimeEnvironment).not.toHaveProperty("OPENSHELL_TOKEN");
    expect(result.runtimeEnvironment).not.toHaveProperty("NVIDIA_INFERENCE_API_KEY");
    expect(() =>
      assertDockerDriverGatewayBindAddressSafe(
        {
          OPENSHELL_BIND_ADDRESS: "0.0.0.0",
          OPENSHELL_GRPC_ENDPOINT: "https://169.254.2.2:8080",
          OPENSHELL_SSH_GATEWAY_HOST: "127.0.0.1",
          OPENSHELL_SERVER_PORT: "8080",
        },
        clientOnlyEnvironment,
        "linux",
      ),
    ).toThrow(/not supported for the OpenShell Docker-driver gateway/u);
    expect(() =>
      assertDockerDriverGatewayBindAddressSafe(
        {
          OPENSHELL_BIND_ADDRESS: "0.0.0.0",
          OPENSHELL_GRPC_ENDPOINT: "https://169.254.2.2:8080",
          OPENSHELL_SSH_GATEWAY_HOST: "127.0.0.1",
          OPENSHELL_SERVER_PORT: "8080",
        },
        result.runtimeEnvironment,
        "linux",
      ),
    ).not.toThrow();
  });

  it("withholds a stop command when the active service uses another state (#11720)", async () => {
    const result = await captureFailedStartRecovery(false);

    expect(result.output).toContain("sudo lsof -i :9777 -sTCP:LISTEN -P -n");
    expect(result.output).not.toContain("sudo lsof -iTCP -sTCP:LISTEN -P -n");
    expect(result.output).not.toContain("systemctl --user stop openshell-gateway");
    expect(result.serviceTargetCalls).toBe(1);
    expect(result.processEnvironmentCalls).toContainEqual([
      ["ps", "eww", "-p", "5444", "-o", "command="],
      { ignoreError: true },
    ]);
  });

  it("passes the verified service stop command through failed-start recovery (#11720)", async () => {
    const result = await captureFailedStartRecovery(true);

    expect(result.output).toContain(
      "systemctl --user stop openshell-gateway && nemoclaw onboard --resume",
    );
    expect(result.output).not.toContain("sudo lsof -i :9777 -sTCP:LISTEN -P -n");
    expect(result.serviceTargetCalls).toBe(2);
    expect(result.processEnvironmentCalls).toContainEqual([
      ["ps", "eww", "-p", "5444", "-o", "command="],
      { ignoreError: true },
    ]);
  });

  it("returns a stop command when one stable service owns the selected port and state", async () => {
    const serviceTarget = {
      executablePath: "/opt/openshell/openshell-gateway",
      pid: 5444,
      stopCommand: "systemctl --user stop openshell-gateway",
    };

    await expect(
      resolveSelectedGatewayServiceStopCommand({
        checkGatewayPortAvailable: async () => ({
          ok: false,
          pid: serviceTarget.pid,
          process: "openshell-gateway",
        }),
        getGatewayPortListenerRawScan: () => ({ complete: true, pids: [serviceTarget.pid] }),
        getTrustedActiveOpenShellGatewayUserServiceStopTarget: () => serviceTarget,
        isDockerDriverGatewayPidUsingSelectedState: () => true,
      }),
    ).resolves.toBe(serviceTarget.stopCommand);
  });

  it("withholds a stop command when the service identity changes during ownership proof", async () => {
    const serviceTarget = {
      executablePath: "/opt/openshell/openshell-gateway",
      pid: 5444,
      stopCommand: "systemctl --user stop openshell-gateway",
    };
    const resolveServiceTarget = vi
      .fn()
      .mockReturnValueOnce(serviceTarget)
      .mockReturnValueOnce({ ...serviceTarget, pid: 5445 });

    await expect(
      resolveSelectedGatewayServiceStopCommand({
        checkGatewayPortAvailable: async () => ({
          ok: false,
          pid: serviceTarget.pid,
          process: "openshell-gateway",
        }),
        getGatewayPortListenerRawScan: () => ({ complete: true, pids: [serviceTarget.pid] }),
        getTrustedActiveOpenShellGatewayUserServiceStopTarget: resolveServiceTarget,
        isDockerDriverGatewayPidUsingSelectedState: () => true,
      }),
    ).resolves.toBeNull();
    expect(resolveServiceTarget).toHaveBeenCalledTimes(2);
  });

  it("uses the current binding for registration and selection", async () => {
    let name = "initial";
    const adapters = gatewayAdaptersForTest({
      healthy: false,
      namedMetadata: false,
      gatewayReuseState: "missing",
    });
    const revalidateAuthority = vi.fn();
    const registration = createGatewayRegistration({
      revalidateAuthority,
      ...adapters,
      gatewayName: () => name,
      gatewayPort: () => 9443,
      getDockerDriverGatewayEndpointArg: () => "https://127.0.0.1:9443",
      getGatewayLocalEndpoint: () => "https://127.0.0.1:9443",
      isLinuxDockerDriverGatewayEnabled: () => true,
    });
    name = "resumed";
    await expect(registration.registerDockerDriverGatewayEndpoint()).resolves.toBe(true);
    expect(adapters.observer.observeGatewayReuse).toHaveBeenCalledWith({
      target: { kind: "named", gatewayName: "resumed" },
      expectedGatewayPort: 9443,
    });
    expect(adapters.lifecycle.registerGateway).toHaveBeenCalledWith({
      target: { kind: "named", gatewayName: "resumed" },
      endpoint: "https://127.0.0.1:9443",
    });
    expect(adapters.lifecycle.selectGateway).toHaveBeenCalledWith({
      target: { kind: "named", gatewayName: "resumed" },
    });
  });

  it("passes the frozen target to observation and selection (#10514)", async () => {
    const adapters = gatewayAdaptersForTest({ endpointBinding: "match" });
    const revalidateAuthority = vi.fn();
    const registration = createGatewayRegistration({
      revalidateAuthority,
      ...adapters,
      gatewayName: () => "nemoclaw-8090",
      gatewayPort: () => 8090,
      getDockerDriverGatewayEndpointArg: () => "https://127.0.0.1:8090",
      getGatewayLocalEndpoint: () => "https://127.0.0.1:8090",
      isLinuxDockerDriverGatewayEnabled: () => true,
    });
    const runtimeSelection = {
      gatewayName: "nemoclaw-8090",
      workspace: "default",
      localTlsDir: "/recorded/tls",
    };
    await expect(registration.registerDockerDriverGatewayEndpoint(runtimeSelection)).resolves.toBe(
      true,
    );
    const request = { target: { kind: "named", gatewayName: "nemoclaw-8090" }, runtimeSelection };
    expect(adapters.observer.observeGatewayReuse).toHaveBeenCalledWith({
      ...request,
      expectedGatewayPort: 8090,
    });
    expect(adapters.lifecycle.selectGateway).toHaveBeenCalledWith(request);
    expect(adapters.lifecycle.registerGateway).not.toHaveBeenCalled();
  });

  it("reuses matching offline metadata while the managed gateway restarts (#11741)", async () => {
    const adapters = gatewayAdaptersForTest({
      healthy: false,
      namedMetadata: true,
      gatewayReuseState: "stale",
      endpointBinding: "match",
    });
    const registration = createGatewayRegistration({
      revalidateAuthority: vi.fn(),
      ...adapters,
      gatewayName: () => "nemoclaw",
      gatewayPort: () => 8080,
      getDockerDriverGatewayEndpointArg: () => "https://127.0.0.1:8080",
      getGatewayLocalEndpoint: () => "https://127.0.0.1:8080",
      isLinuxDockerDriverGatewayEnabled: () => true,
    });

    await expect(registration.registerDockerDriverGatewayEndpoint()).resolves.toBe(true);

    expect(adapters.lifecycle.selectGateway).toHaveBeenCalledOnce();
    expect(adapters.lifecycle.registerGateway).not.toHaveBeenCalled();
  });

  it("does not reuse offline metadata bound to another managed gateway port (#11741)", async () => {
    const adapters = gatewayAdaptersForTest({
      healthy: false,
      namedMetadata: true,
      gatewayReuseState: "stale",
      endpointBinding: "mismatch",
    });
    const registration = createGatewayRegistration({
      revalidateAuthority: vi.fn(),
      ...adapters,
      gatewayName: () => "nemoclaw",
      gatewayPort: () => 8080,
      getDockerDriverGatewayEndpointArg: () => "https://127.0.0.1:8080",
      getGatewayLocalEndpoint: () => "https://127.0.0.1:8080",
      isLinuxDockerDriverGatewayEnabled: () => true,
    });

    await expect(registration.registerDockerDriverGatewayEndpoint()).resolves.toBe(true);

    expect(adapters.lifecycle.registerGateway).toHaveBeenCalledWith({
      target: { kind: "named", gatewayName: "nemoclaw" },
      endpoint: "https://127.0.0.1:8080",
    });
  });

  it("repairs healthy metadata bound to another managed gateway port (#11741)", async () => {
    const adapters = gatewayAdaptersForTest({
      healthy: true,
      namedMetadata: true,
      gatewayReuseState: "healthy",
      endpointBinding: "mismatch",
    });
    const registration = createGatewayRegistration({
      revalidateAuthority: vi.fn(),
      ...adapters,
      gatewayName: () => "nemoclaw",
      gatewayPort: () => 8080,
      getDockerDriverGatewayEndpointArg: () => "https://127.0.0.1:8080",
      getGatewayLocalEndpoint: () => "https://127.0.0.1:8080",
      isLinuxDockerDriverGatewayEnabled: () => true,
    });

    await expect(registration.registerDockerDriverGatewayEndpoint()).resolves.toBe(true);

    expect(adapters.lifecycle.registerGateway).toHaveBeenCalledWith({
      target: { kind: "named", gatewayName: "nemoclaw" },
      endpoint: "https://127.0.0.1:8080",
    });
    expect(adapters.lifecycle.selectGateway).toHaveBeenCalledOnce();
  });

  it.each(["registration", "metadata"] as const)(
    "reobserves failed %s add without remove, destroy, or another add (#11326)",
    async (operation) => {
      const adapters = gatewayAdaptersForTest({
        healthy: false,
        namedMetadata: false,
        gatewayReuseState: "missing",
      });
      adapters.lifecycle.registerGateway.mockResolvedValue({
        ok: false,
        ambiguous: true,
        unsupported: false,
        error: { kind: "timeout", message: "Timed out." },
      });
      const revalidateAuthority = vi.fn();
      const registration = createGatewayRegistration({
        revalidateAuthority,
        ...adapters,
        gatewayName: () => "nemoclaw",
        gatewayPort: () => 8080,
        getDockerDriverGatewayEndpointArg: () => "https://127.0.0.1:8080",
        getGatewayLocalEndpoint: () => "https://127.0.0.1:8080",
        isLinuxDockerDriverGatewayEnabled: () => operation === "registration",
      });
      await expect(
        operation === "registration"
          ? registration.registerDockerDriverGatewayEndpoint()
          : registration.attachGatewayMetadataIfNeeded({ forceRefresh: true }),
      ).resolves.toBe(false);
      expect(adapters.observer.observeGatewayReuse).toHaveBeenCalledTimes(2);
      expect(revalidateAuthority).toHaveBeenCalledOnce();
      expect(adapters.lifecycle.registerGateway).toHaveBeenCalledOnce();
      expect(adapters.lifecycle.removeGateway).not.toHaveBeenCalled();
      expect(adapters.lifecycle.destroyGateway).not.toHaveBeenCalled();
      expect(adapters.lifecycle.selectGateway).not.toHaveBeenCalled();
    },
  );

  it("uses the current binding for recovery select and health commands", async () => {
    let name = "initial";
    const adapters = gatewayAdaptersForTest();
    const recovery = createGatewayRecoveryOrchestration({
      ...adapters,
      SCRIPTS: "/tmp/scripts",
      assertGatewayStartAllowed: vi.fn(),
      attachGatewayMetadataIfNeeded: async () => true,
      envInt: (_name, fallback) => fallback,
      gatewayClusterHealthcheckPassed: () => true,
      gatewayName: () => name,
      getContainerRuntime: () => "docker",
      getGatewayClusterContainerState: () => "missing",
      isGatewayHttpReady: async () => true,
      isLinuxDockerDriverGatewayEnabled: () => false,
      repairGatewayBootstrapSecrets: () => ({ repaired: true, missingSecrets: [] }),
      run: vi.fn(() => runResult()),
      shouldPatchCoredns: () => false,
      sleepSeconds: vi.fn(),
      startDockerDriverGateway: vi.fn(),
      startGatewayWithOptions: vi.fn(),
    });

    name = "resumed";
    await expect(recovery.recoverGatewayRuntime()).resolves.toBe(true);

    expect(adapters.lifecycle.selectGateway).toHaveBeenCalledWith({
      target: { kind: "named", gatewayName: "resumed" },
    });
    expect(adapters.observer.observeGatewayReuse).toHaveBeenCalledWith({
      target: { kind: "named", gatewayName: "resumed" },
    });
  });

  it("admits proven pre-marker state and rejects unproven custom roots before startup", async () => {
    let name = "initial";
    let port = 9000;
    const root = fs.mkdtempSync(path.join(process.cwd(), "nemoclaw-gateway-start-boundary-"));
    const stateDir = path.join(root, "gateway");
    const verifyReachability = vi.fn(async () => undefined);
    const adapters = gatewayAdaptersForTest();
    const managedStart = vi.fn(
      async (
        options: Parameters<
          typeof import("../docker-driver-gateway-env").startPackageManagedDockerDriverGatewayWithEnvOverride
        >[0],
      ) => {
        await options.observer.observeGatewayReuse({
          target: { kind: "named", gatewayName: options.gatewayName },
        });
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
    const runCaptureOpenshell = vi.fn((_args: string[], _options?: Record<string, unknown>) => "");
    const runtimeIdentitySpy = vi
      .spyOn(dockerDriverGatewayLaunch, "buildDockerDriverGatewayRuntimeIdentity")
      .mockImplementation((options) => ({
        launch: null,
        desiredEnv: {},
        driftGatewayBin: null,
        identityGatewayBin: options.gatewayBin,
      }));
    const start = createDockerDriverGatewayStart({
      observer: adapters.observer,
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
      getGatewayPortListenerRawScan: () => ({ complete: true, pids: [] }),
      getInstalledOpenshellVersion: () => "0.0.0",
      isDockerDriverGatewayHttpReady: async () => true,
      isDockerDriverGatewayProcess: () => true,
      isDockerDriverGatewayProcessAlive: () => false,
      isGatewayTcpReady: async () => true,
      isPidAlive: () => false,
      logDockerDriverGatewayRestart: vi.fn(),
      registerDockerDriverGatewayEndpoint: async () => true,
      rememberDockerDriverGatewayPid: vi.fn(),
      resolveOpenShellGatewayBinary: () => "/opt/openshell/openshell-gateway",
      resolveOpenShellSandboxBinary: () => null,
      runner: {
        runCapture: () => "",
        runCaptureEx: () => ({ stdout: "", exitCode: 1, timedOut: false }),
      },
      runCaptureOpenshell,
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
    vi.stubEnv("OPENSHELL_GATEWAY", "hostile-gateway");
    vi.stubEnv("OPENSHELL_WORKSPACE", "hostile-workspace");
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://hostile.invalid");
    vi.stubEnv("OPENSHELL_TOKEN", "hostile-token");
    vi.stubEnv("OPENSHELL_LOCAL_TLS_DIR", "/hostile/tls");
    vi.stubEnv("OPENSHELL_DISABLE_TLS", "1");
    vi.stubEnv("OPENSHELL_DISABLE_GATEWAY_AUTH", "1");
    try {
      await start.startDockerDriverGateway({
        runtimeSelection: {
          gatewayName: "resumed",
          workspace: "default",
          localTlsDir: path.join(stateDir, "tls"),
        },
      });

      expect(managedStart).toHaveBeenCalledWith(
        expect.objectContaining({ gatewayName: "resumed" }),
      );
      const runtimeIdentityOptions = runtimeIdentitySpy.mock.calls[0]?.[0];
      const managedOptions = managedStart.mock.calls[0]?.[0];
      expect(runtimeIdentityOptions?.env).toEqual(managedOptions?.env);
      expect(runtimeIdentityOptions?.env).toEqual(
        expect.objectContaining({
          OPENSHELL_GATEWAY: "resumed",
          OPENSHELL_LOCAL_TLS_DIR: path.join(stateDir, "tls"),
          OPENSHELL_WORKSPACE: "default",
        }),
      );
      expect(runtimeIdentityOptions?.env?.OPENSHELL_GATEWAY_ENDPOINT).toBeUndefined();
      expect(runtimeIdentityOptions?.env?.OPENSHELL_TOKEN).toBeUndefined();
      expect(runtimeIdentityOptions?.env?.OPENSHELL_DISABLE_TLS).toBeUndefined();
      expect(runtimeIdentityOptions?.env?.OPENSHELL_DISABLE_GATEWAY_AUTH).toBeUndefined();
      expect(runCaptureOpenshell).toHaveBeenCalledTimes(1);
      const versionOptions = runCaptureOpenshell.mock.calls[0]?.[1] as
        | { env?: Record<string, string>; replaceEnv?: boolean }
        | undefined;
      expect(versionOptions).toMatchObject({
        env: expect.objectContaining({
          OPENSHELL_GATEWAY: "resumed",
          OPENSHELL_WORKSPACE: "default",
          OPENSHELL_LOCAL_TLS_DIR: path.join(stateDir, "tls"),
        }),
        replaceEnv: true,
      });
      expect(adapters.observer.observeGatewayReuse).toHaveBeenCalledWith({
        target: { kind: "named", gatewayName: "resumed" },
        runtimeSelection: {
          gatewayName: "resumed",
          workspace: "default",
          localTlsDir: path.join(stateDir, "tls"),
        },
      });
      expect(versionOptions?.env).not.toHaveProperty("OPENSHELL_GATEWAY_ENDPOINT");
      expect(versionOptions?.env).not.toHaveProperty("OPENSHELL_TOKEN");
      expect(versionOptions?.env).not.toHaveProperty("OPENSHELL_DISABLE_TLS");
      expect(versionOptions?.env).not.toHaveProperty("OPENSHELL_DISABLE_GATEWAY_AUTH");
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
      runtimeIdentitySpy.mockRestore();
      vi.unstubAllEnvs();
      fs.rmSync(root, { force: true, recursive: true });
    }
  });
});
