// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { OPENSHELL_PROBE_TIMEOUT_MS } from "../adapters/openshell/timeouts";
import {
  classifyDockerDriverNetworkInspection,
  createDockerDriverGatewayReuseApplication,
  type DockerDriverGatewayReuseApplicationDeps,
  createGatewayReuseHelpers,
  inspectDockerDriverNetwork,
} from "./gateway-reuse";

function dockerNetworkInspectResult(
  status: number | null,
  stdout = "",
  stderr = "",
  error?: Error,
) {
  return { error, status, stderr, stdout };
}

describe("Docker-driver network inspection", () => {
  it("inspects the exact configured Docker network with a bounded command", () => {
    const runDocker = vi.fn(() => dockerNetworkInspectResult(0, "openshell-docker"));

    expect(inspectDockerDriverNetwork("openshell-docker", runDocker)).toEqual({
      kind: "present",
    });
    expect(runDocker).toHaveBeenCalledWith(
      ["network", "inspect", "--format", "{{.Name}}", "openshell-docker"],
      {
        ignoreError: true,
        suppressOutput: true,
        timeout: OPENSHELL_PROBE_TIMEOUT_MS,
      },
    );
  });

  it("accepts the exact configured Docker network", () => {
    expect(
      classifyDockerDriverNetworkInspection(
        "openshell-docker",
        dockerNetworkInspectResult(0, "openshell-docker\n"),
      ),
    ).toEqual({ kind: "present" });
  });

  it.each([
    "Error response from daemon: No such network: openshell-docker",
    "network openshell-docker not found",
  ])("classifies an exact missing configured network as absent: %s (#9594)", (stderr) => {
    expect(
      classifyDockerDriverNetworkInspection(
        "openshell-docker",
        dockerNetworkInspectResult(1, "", stderr),
      ),
    ).toEqual({ kind: "absent" });
  });

  it.each([
    dockerNetworkInspectResult(1, "", "No such network: unrelated-network"),
    dockerNetworkInspectResult(1, "", "registry metadata not found"),
    dockerNetworkInspectResult(0, "another-network"),
    dockerNetworkInspectResult(
      1,
      "",
      "No such network: openshell-docker",
      new Error("Docker transport failed"),
    ),
  ])("keeps ambiguous Docker network inspection inconclusive [case %#] (#9594)", (result) => {
    expect(classifyDockerDriverNetworkInspection("openshell-docker", result)).toEqual({
      kind: "inconclusive",
    });
  });
});

describe("gateway reuse snapshot", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("bounds OpenShell gateway inspection probes (#6752)", () => {
    const runCaptureOpenshell = vi.fn(() => "");
    const helpers = createGatewayReuseHelpers({
      gatewayName: "nemoclaw",
      runCaptureOpenshell,
      runOpenshell: vi.fn(() => ({ status: 0 })),
      cliDisplayName: () => "NemoClaw",
    });

    helpers.getGatewayReuseSnapshot();

    expect(runCaptureOpenshell).toHaveBeenCalledWith(["status", "-g", "nemoclaw"], {
      ignoreError: true,
      includeStderr: true,
      timeout: OPENSHELL_PROBE_TIMEOUT_MS,
    });
    expect(runCaptureOpenshell).toHaveBeenCalledWith(["gateway", "info", "-g", "nemoclaw"], {
      ignoreError: true,
      timeout: OPENSHELL_PROBE_TIMEOUT_MS,
    });
    expect(runCaptureOpenshell).toHaveBeenCalledWith(["gateway", "info"], {
      ignoreError: true,
      timeout: OPENSHELL_PROBE_TIMEOUT_MS,
    });
  });

  it("replaces ambient OpenShell selectors for a frozen reuse target (#10514)", () => {
    vi.stubEnv("OPENSHELL_GATEWAY", "hostile-gateway");
    vi.stubEnv("OPENSHELL_WORKSPACE", "hostile-workspace");
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://hostile.invalid");
    vi.stubEnv("OPENSHELL_GATEWAY_INSECURE", "1");
    vi.stubEnv("OPENSHELL_TOKEN", "hostile-token");
    vi.stubEnv("OPENSHELL_LOCAL_TLS_DIR", "/hostile/tls");
    const runCaptureOpenshell = vi.fn(
      (_args: string[], _options?: Record<string, unknown>) => "",
    );
    const helpers = createGatewayReuseHelpers({
      gatewayName: "nemoclaw",
      runCaptureOpenshell,
      runOpenshell: vi.fn(() => ({ status: 0 })),
      cliDisplayName: () => "NemoClaw",
    });

    helpers.getGatewayReuseSnapshot({
      gatewayName: "nemoclaw",
      workspace: "default",
      localTlsDir: "/recorded/tls",
    });

    expect(runCaptureOpenshell).toHaveBeenCalledTimes(3);
    const statusOptions = runCaptureOpenshell.mock.calls[0]?.[1] as
      | { env?: Record<string, string>; replaceEnv?: boolean }
      | undefined;
    const namedInfoOptions = runCaptureOpenshell.mock.calls[1]?.[1] as typeof statusOptions;
    const activeInfoOptions = runCaptureOpenshell.mock.calls[2]?.[1] as typeof statusOptions;
    expect(statusOptions).toMatchObject({
      env: expect.objectContaining({
        OPENSHELL_GATEWAY: "nemoclaw",
        OPENSHELL_WORKSPACE: "default",
        OPENSHELL_LOCAL_TLS_DIR: "/recorded/tls",
      }),
      replaceEnv: true,
    });
    expect(namedInfoOptions?.env).toBe(statusOptions?.env);
    expect(activeInfoOptions?.env).toBe(statusOptions?.env);
    expect(statusOptions?.env).not.toHaveProperty("OPENSHELL_GATEWAY_ENDPOINT");
    expect(statusOptions?.env).not.toHaveProperty("OPENSHELL_GATEWAY_INSECURE");
    expect(statusOptions?.env).not.toHaveProperty("OPENSHELL_TOKEN");
  });

  it("classifies status stderr connection refusals as stale when gateway info is unavailable (#7087)", () => {
    const statusOutput = [
      "Error:   × client error (Connect)",
      "  ├─▶ tcp connect error",
      "  ╰─▶ Connection refused (os error 61)",
    ].join("\n");
    const runCaptureOpenshell = vi.fn((args: string[], opts?: Record<string, unknown>) =>
      args[0] === "status" && opts?.includeStderr === true ? statusOutput : "",
    );
    const helpers = createGatewayReuseHelpers({
      gatewayName: "nemoclaw",
      runCaptureOpenshell,
      runOpenshell: vi.fn(() => ({ status: 0 })),
      cliDisplayName: () => "NemoClaw",
    });

    expect(helpers.getGatewayReuseSnapshot().gatewayReuseState).toBe("stale");
  });

  it("preserves named active gateway metadata when mixed stdout and stderr report an auth error", () => {
    const statusStdout = [
      "Server Status",
      "",
      "  Gateway: nemoclaw",
      "  Server: https://127.0.0.1:8080/",
    ].join("\n");
    const statusStderr = "Error: authentication failed";
    const gatewayInfo = [
      "Gateway Info",
      "",
      "Gateway: nemoclaw",
      "Gateway endpoint: https://127.0.0.1:8080/",
    ].join("\n");
    const outputByCommand = new Map([
      ["status -g", [statusStdout, statusStderr].join("\n")],
      ["gateway info", gatewayInfo],
    ]);
    const runCaptureOpenshell = vi.fn(
      (args: string[]) => outputByCommand.get(args.slice(0, 2).join(" ")) ?? "",
    );
    const helpers = createGatewayReuseHelpers({
      gatewayName: "nemoclaw",
      runCaptureOpenshell,
      runOpenshell: vi.fn(() => ({ status: 0 })),
      cliDisplayName: () => "NemoClaw",
    });

    expect(helpers.getGatewayReuseSnapshot().gatewayReuseState).toBe("missing");
  });
});

function createDockerDriverReuseApplication(
  overrides: Partial<DockerDriverGatewayReuseApplicationDeps> = {},
) {
  return createDockerDriverGatewayReuseApplication({
    gatewayName: () => "nemoclaw",
    getGatewayCompatContainerName: () => "openshell-gateway-nemoclaw",
    isDockerDriverGatewayEnabled: () => true,
    resolveOpenShellGatewayBinary: () => "/opt/openshell-gateway",
    getDockerDriverGatewayEnv: () => ({
      OPENSHELL_DRIVERS: "docker",
      OPENSHELL_DOCKER_NETWORK_NAME: "openshell-docker",
    }),
    runCaptureOpenshell: vi.fn(() => "openshell 0.0.99"),
    getDockerDriverGatewayStateDir: () => "/tmp/nemoclaw-gateway",
    resolveOpenShellSandboxBinary: () => "/opt/openshell-sandbox",
    getDockerDriverGatewayPid: () => 42,
    isDockerDriverGatewayProcessAlive: () => true,
    getDockerDriverGatewayReuseDrift: vi.fn(() => null),
    checkGatewayPortAvailable: vi.fn(async () => ({ ok: true })),
    getDockerDriverGatewayPortListenerPid: vi.fn(() => null),
    rememberDockerDriverGatewayPid: vi.fn(),
    buildDockerDriverGatewayRuntimeIdentity: vi.fn(() => ({
      launch: null,
      desiredEnv: {
        OPENSHELL_DRIVERS: "docker",
        OPENSHELL_DOCKER_NETWORK_NAME: "openshell-docker",
      },
      driftGatewayBin: "/opt/openshell-gateway",
      identityGatewayBin: "/opt/openshell-gateway",
    })),
    resolveDriftGatewayBin: vi.fn((runtimeIdentity, gatewayBin) =>
      runtimeIdentity ? runtimeIdentity.driftGatewayBin : gatewayBin,
    ),
    getTrustedActiveOpenShellGatewayUserServicePid: vi.fn(() => null),
    runDockerNetworkInspect: vi.fn(() => dockerNetworkInspectResult(0, "openshell-docker")),
    inspectDockerDriverNetwork: vi.fn(() => ({ kind: "present" as const })),
    log: vi.fn(),
    ...overrides,
  });
}

describe("Docker-driver gateway reuse application", () => {
  it("keeps reuse state unchanged when Docker-driver inspection does not apply (#7695)", async () => {
    const isDockerDriverGatewayEnabled = vi.fn(() => false);
    const checkGatewayPortAvailable = vi.fn(async () => ({ ok: true }));
    const application = createDockerDriverReuseApplication({
      isDockerDriverGatewayEnabled,
      checkGatewayPortAvailable,
    });

    await expect(application.refreshDockerDriverGatewayReuseState("healthy")).resolves.toBe(
      "healthy",
    );
    isDockerDriverGatewayEnabled.mockReturnValue(true);
    await expect(application.refreshDockerDriverGatewayReuseState("stale")).resolves.toBe("stale");
    expect(checkGatewayPortAvailable).not.toHaveBeenCalled();
  });

  it("marks a running Docker-driver gateway stale when runtime identity drifts", async () => {
    const log = vi.fn();
    const checkGatewayPortAvailable = vi.fn(async () => ({ ok: true }));
    const application = createDockerDriverReuseApplication({
      getDockerDriverGatewayReuseDrift: vi.fn(() => ({
        reason: "runtime environment changed",
      })),
      checkGatewayPortAvailable,
      log,
    });

    await expect(application.refreshDockerDriverGatewayReuseState("healthy")).resolves.toBe(
      "stale",
    );
    expect(checkGatewayPortAvailable).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "  Existing OpenShell Docker-driver gateway is stale (runtime environment changed); it will be recreated.",
    );
  });

  it("marks a reused NemoClaw-managed gateway stale when its Docker network is absent (#9594)", async () => {
    const log = vi.fn();
    const application = createDockerDriverReuseApplication({
      inspectDockerDriverNetwork: vi.fn(() => ({ kind: "absent" as const })),
      log,
    });

    await expect(application.refreshDockerDriverGatewayReuseState("healthy")).resolves.toBe(
      "stale",
    );
    expect(log).toHaveBeenCalledWith(
      '  Existing NemoClaw-managed OpenShell gateway network "openshell-docker" is absent; the gateway will be recreated.',
    );
  });

  it("stops before reuse when Docker network inspection is inconclusive (#9594)", async () => {
    const application = createDockerDriverReuseApplication({
      inspectDockerDriverNetwork: vi.fn(() => ({ kind: "inconclusive" as const })),
    });

    await expect(application.refreshDockerDriverGatewayReuseState("healthy")).rejects.toThrow(
      'NemoClaw could not verify Docker network "openshell-docker" before reusing the NemoClaw-managed OpenShell gateway. Check Docker daemon access and the configured network, then rerun `nemoclaw onboard`.',
    );
  });

  it("reuses the trusted gateway port listener when the PID file is absent (#9594)", async () => {
    const rememberDockerDriverGatewayPid = vi.fn();
    const getDockerDriverGatewayReuseDrift = vi.fn(() => null);
    const application = createDockerDriverReuseApplication({
      getDockerDriverGatewayPid: () => null,
      isDockerDriverGatewayProcessAlive: () => false,
      checkGatewayPortAvailable: vi.fn(async () => ({ ok: false, pid: 731 })),
      getDockerDriverGatewayPortListenerPid: vi.fn(() => 731),
      getDockerDriverGatewayReuseDrift,
      getTrustedActiveOpenShellGatewayUserServicePid: vi.fn(() => 731),
      rememberDockerDriverGatewayPid,
    });

    await expect(application.refreshDockerDriverGatewayReuseState("healthy")).resolves.toBe(
      "healthy",
    );
    expect(getDockerDriverGatewayReuseDrift).toHaveBeenCalledWith(
      731,
      {
        OPENSHELL_DRIVERS: "docker",
        OPENSHELL_DOCKER_NETWORK_NAME: "openshell-docker",
      },
      "/opt/openshell-gateway",
      731,
    );
    expect(rememberDockerDriverGatewayPid).not.toHaveBeenCalled();
  });

  it("stops before recording a mismatched gateway port listener when the Docker network is absent (#9594)", async () => {
    const rememberDockerDriverGatewayPid = vi.fn();
    const getDockerDriverGatewayReuseDrift = vi.fn(() => null);
    const application = createDockerDriverReuseApplication({
      getDockerDriverGatewayPid: () => null,
      isDockerDriverGatewayProcessAlive: () => false,
      checkGatewayPortAvailable: vi.fn(async () => ({ ok: false, pid: 731 })),
      getDockerDriverGatewayPortListenerPid: vi.fn(() => 731),
      getDockerDriverGatewayReuseDrift,
      getTrustedActiveOpenShellGatewayUserServicePid: vi.fn(() => 900),
      inspectDockerDriverNetwork: vi.fn(() => ({ kind: "absent" as const })),
      rememberDockerDriverGatewayPid,
    });

    await expect(application.refreshDockerDriverGatewayReuseState("healthy")).rejects.toThrow(
      'Docker network "openshell-docker" is absent, but NemoClaw could not verify the running gateway\'s lifecycle authority. Restart the gateway through its lifecycle authority, then rerun `nemoclaw onboard`.',
    );
    expect(getDockerDriverGatewayReuseDrift).not.toHaveBeenCalled();
    expect(rememberDockerDriverGatewayPid).not.toHaveBeenCalled();
  });

  it("preserves a reachable selected gateway when the port owner is ambiguous", async () => {
    const rememberDockerDriverGatewayPid = vi.fn();
    const inspectDockerDriverNetwork = vi.fn(() => ({ kind: "present" as const }));
    const application = createDockerDriverReuseApplication({
      getDockerDriverGatewayPid: () => null,
      isDockerDriverGatewayProcessAlive: () => false,
      checkGatewayPortAvailable: vi.fn(async () => ({ ok: false, pid: null })),
      getDockerDriverGatewayPortListenerPid: vi.fn(() => null),
      inspectDockerDriverNetwork,
      rememberDockerDriverGatewayPid,
    });

    await expect(application.refreshDockerDriverGatewayReuseState("healthy")).resolves.toBe(
      "healthy",
    );
    expect(inspectDockerDriverNetwork).toHaveBeenCalledWith("openshell-docker");
    expect(rememberDockerDriverGatewayPid).not.toHaveBeenCalled();
  });

  it("does not recreate a gateway with unproven lifecycle authority when its network is absent (#9594)", async () => {
    const rememberDockerDriverGatewayPid = vi.fn();
    const application = createDockerDriverReuseApplication({
      getDockerDriverGatewayPid: () => null,
      isDockerDriverGatewayProcessAlive: () => false,
      checkGatewayPortAvailable: vi.fn(async () => ({ ok: false, pid: null })),
      getDockerDriverGatewayPortListenerPid: vi.fn(() => null),
      inspectDockerDriverNetwork: vi.fn(() => ({ kind: "absent" as const })),
      rememberDockerDriverGatewayPid,
    });

    await expect(application.refreshDockerDriverGatewayReuseState("healthy")).rejects.toThrow(
      'Docker network "openshell-docker" is absent, but NemoClaw could not verify the running gateway\'s lifecycle authority. Restart the gateway through its lifecycle authority, then rerun `nemoclaw onboard`.',
    );
    expect(rememberDockerDriverGatewayPid).not.toHaveBeenCalled();
  });

  it("marks a gateway stale when no Docker-driver process owns the available port", async () => {
    const application = createDockerDriverReuseApplication({
      getDockerDriverGatewayPid: () => null,
      isDockerDriverGatewayProcessAlive: () => false,
      checkGatewayPortAvailable: vi.fn(async () => ({ ok: true })),
      getDockerDriverGatewayPortListenerPid: vi.fn(() => null),
    });

    await expect(application.refreshDockerDriverGatewayReuseState("healthy")).resolves.toBe(
      "stale",
    );
  });
});
