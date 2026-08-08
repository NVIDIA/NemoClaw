// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { OPENSHELL_PROBE_TIMEOUT_MS } from "../adapters/openshell/timeouts";
import {
  createDockerDriverGatewayReuseApplication,
  type DockerDriverGatewayReuseApplicationDeps,
  createGatewayReuseHelpers,
} from "./gateway-reuse";

describe("gateway reuse snapshot", () => {
  it("bounds OpenShell gateway inspection probes (#6752)", () => {
    const runCaptureOpenshell = vi.fn(() => "");
    const helpers = createGatewayReuseHelpers({
      gatewayName: "nemoclaw",
      runCaptureOpenshell,
      runOpenshell: vi.fn(() => ({ status: 0 })),
      cliDisplayName: () => "NemoClaw",
    });

    helpers.getGatewayReuseSnapshot();

    expect(runCaptureOpenshell).toHaveBeenCalledWith(["status"], {
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

  it("classifies status stderr connection refusals as stale when gateway info is unavailable (#7087)", () => {
    const statusOutput = [
      "Server Status",
      "",
      "  Gateway: nemoclaw",
      "Error: Connection refused",
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
      ["status", [statusStdout, statusStderr].join("\n")],
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
    getDockerDriverGatewayEnv: () => ({ OPENSHELL_DRIVERS: "docker" }),
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
      desiredEnv: { OPENSHELL_DRIVERS: "docker" },
      driftGatewayBin: "/opt/openshell-gateway",
      identityGatewayBin: "/opt/openshell-gateway",
    })),
    resolveDriftGatewayBin: vi.fn((runtimeIdentity, gatewayBin) =>
      runtimeIdentity ? runtimeIdentity.driftGatewayBin : gatewayBin,
    ),
    getTrustedActiveOpenShellGatewayUserServicePid: vi.fn(() => null),
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

  it("adopts a matching gateway port listener when the PID file is absent", async () => {
    const rememberDockerDriverGatewayPid = vi.fn();
    const getDockerDriverGatewayReuseDrift = vi.fn(() => null);
    const application = createDockerDriverReuseApplication({
      getDockerDriverGatewayPid: () => null,
      isDockerDriverGatewayProcessAlive: () => false,
      checkGatewayPortAvailable: vi.fn(async () => ({ ok: false, pid: 731 })),
      getDockerDriverGatewayPortListenerPid: vi.fn(() => 731),
      getDockerDriverGatewayReuseDrift,
      getTrustedActiveOpenShellGatewayUserServicePid: vi.fn(() => 900),
      rememberDockerDriverGatewayPid,
    });

    await expect(application.refreshDockerDriverGatewayReuseState("healthy")).resolves.toBe(
      "healthy",
    );
    expect(getDockerDriverGatewayReuseDrift).toHaveBeenCalledWith(
      731,
      { OPENSHELL_DRIVERS: "docker" },
      "/opt/openshell-gateway",
      900,
    );
    expect(rememberDockerDriverGatewayPid).toHaveBeenCalledWith(731);
  });

  it("preserves a reachable selected gateway when the port owner is ambiguous", async () => {
    const rememberDockerDriverGatewayPid = vi.fn();
    const application = createDockerDriverReuseApplication({
      getDockerDriverGatewayPid: () => null,
      isDockerDriverGatewayProcessAlive: () => false,
      checkGatewayPortAvailable: vi.fn(async () => ({ ok: false, pid: null })),
      getDockerDriverGatewayPortListenerPid: vi.fn(() => null),
      rememberDockerDriverGatewayPid,
    });

    await expect(application.refreshDockerDriverGatewayReuseState("healthy")).resolves.toBe(
      "healthy",
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
