// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class GatewayTokenCommandError extends Error {
    lines: readonly string[];
    exitCode: number;

    constructor(lines: string | readonly string[], exitCode = 1) {
      const normalized = Array.isArray(lines) ? lines : [lines];
      super(normalized.join("\n"));
      this.lines = normalized;
      this.exitCode = exitCode;
    }
  }
  class DashboardUrlCommandError extends Error {
    lines: readonly string[];
    exitCode: number;

    constructor(lines: string | readonly string[], exitCode = 1) {
      const normalized = Array.isArray(lines) ? lines : [lines];
      super(normalized.join("\n"));
      this.lines = normalized;
      this.exitCode = exitCode;
    }
  }

  return {
    buildVersionedUninstallUrl: vi.fn((version: string) => `https://example.test/${version}/uninstall.sh`),
    fetchGatewayAuthTokenFromSandbox: vi.fn(() => "token"),
    getVersion: vi.fn(() => "1.2.3"),
    captureOpenshellCommand: vi.fn(() => ({ status: 0, output: "alpha\n" })),
    listSandboxes: vi.fn(() => ({ sandboxes: [] })),
    resolveOpenshell: vi.fn(() => "/usr/bin/openshell"),
    runDebugCommandWithOptions: vi.fn(),
    runDeployAction: vi.fn().mockResolvedValue(undefined),
    runDashboardUrlCommand: vi.fn(() => undefined),
    runGatewayTokenCommand: vi.fn(() => undefined),
    runStartCommand: vi.fn().mockResolvedValue(undefined),
    runStopCommand: vi.fn(),
    runUninstallCommand: vi.fn(),
    showRootHelp: vi.fn(),
    showVersion: vi.fn(),
    spawnSync: vi.fn(),
    startAll: vi.fn(),
    stopAll: vi.fn(),
    DashboardUrlCommandError,
    GatewayTokenCommandError,
  };
});

vi.mock("node:child_process", () => ({ spawnSync: mocks.spawnSync }));
vi.mock("../lib/diagnostics/debug", () => ({ runDebug: vi.fn() }));
vi.mock("../lib/diagnostics/debug-command", () => ({
  runDebugCommandWithOptions: mocks.runDebugCommandWithOptions,
}));
vi.mock("../lib/gateway-token-command", () => ({
  GatewayTokenCommandError: mocks.GatewayTokenCommandError,
  runGatewayTokenCommand: mocks.runGatewayTokenCommand,
}));
vi.mock("../lib/dashboard-url-command", () => ({
  DashboardUrlCommandError: mocks.DashboardUrlCommandError,
  runDashboardUrlCommand: mocks.runDashboardUrlCommand,
}));
vi.mock("../lib/actions/global", () => ({
  runDeployAction: mocks.runDeployAction,
  showRootHelp: mocks.showRootHelp,
  showVersion: mocks.showVersion,
}));
vi.mock("../lib/adapters/openshell/client", () => ({ captureOpenshellCommand: mocks.captureOpenshellCommand }));
vi.mock("../lib/state/registry", () => ({ listSandboxes: mocks.listSandboxes }));
vi.mock("../lib/adapters/openshell/resolve", () => ({ resolveOpenshell: mocks.resolveOpenshell }));
vi.mock("../lib/tunnel/services", () => ({ startAll: mocks.startAll, stopAll: mocks.stopAll }));
vi.mock("../lib/tunnel/service-command", () => ({
  runStartCommand: mocks.runStartCommand,
  runStopCommand: mocks.runStopCommand,
}));
vi.mock("../lib/uninstall-command", () => ({
  buildVersionedUninstallUrl: mocks.buildVersionedUninstallUrl,
  runUninstallCommand: mocks.runUninstallCommand,
}));
vi.mock("../lib/core/version", () => ({ getVersion: mocks.getVersion }));

import DebugCliCommand from "./debug";
import DeployCliCommand from "./deploy";
import DashboardUrlCliCommand, { setDashboardUrlRuntimeBridgeFactoryForTest } from "./sandbox/dashboard-url";
import GatewayTokenCliCommand, { setGatewayTokenRuntimeBridgeFactoryForTest } from "./sandbox/gateway/token";
import DeprecatedStartCommand from "./start";
import DeprecatedStopCommand from "./stop";
import RootHelpCommand from "./root/help";
import VersionCommand from "./root/version";
import TunnelStartCommand from "./tunnel/start";
import TunnelStopCommand from "./tunnel/stop";
import UninstallCliCommand from "./uninstall";

const rootDir = process.cwd();

describe("simple global oclif adapters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps debug and deploy parser output to actions", async () => {
    await DebugCliCommand.run(["--quick", "--output", "/tmp/debug.tar.gz", "--sandbox", "alpha"], rootDir);
    await DeployCliCommand.run(["gpu-alpha"], rootDir);

    expect(mocks.runDebugCommandWithOptions).toHaveBeenCalledWith(
      { quick: true, output: "/tmp/debug.tar.gz", sandboxName: "alpha" },
      expect.objectContaining({ getDefaultSandbox: expect.any(Function), runDebug: expect.any(Function) }),
    );
    expect(mocks.runDeployAction).toHaveBeenCalledWith("gpu-alpha");
  });

  it("builds debug defaults from the sandbox registry and OpenShell liveness", async () => {
    mocks.listSandboxes.mockReturnValue({
      defaultSandbox: "alpha",
      sandboxes: [{ name: "alpha" }],
    } as never);
    await DebugCliCommand.run(["--quick"], rootDir);

    const deps = mocks.runDebugCommandWithOptions.mock.calls[0][1];
    expect(deps.getDefaultSandbox()).toBe("alpha");
    expect(mocks.captureOpenshellCommand).toHaveBeenCalledWith(
      "/usr/bin/openshell",
      ["sandbox", "list"],
      expect.objectContaining({ cwd: rootDir, ignoreError: true }),
    );
  });

  it("maps gateway-token flags to the gateway token action", async () => {
    const getSandboxAgent = vi.fn(() => "openclaw");
    setGatewayTokenRuntimeBridgeFactoryForTest(() => ({
      fetchGatewayAuthTokenFromSandbox: mocks.fetchGatewayAuthTokenFromSandbox,
      getSandboxAgent,
    }));

    await GatewayTokenCliCommand.run(["alpha", "--quiet"], rootDir);

    expect(mocks.runGatewayTokenCommand).toHaveBeenCalledWith(
      "alpha",
      { quiet: true },
      { fetchToken: mocks.fetchGatewayAuthTokenFromSandbox, getSandboxAgent },
    );
  });

  it("maps dashboard-url flags to the dashboard URL action", async () => {
    const getSandbox = vi.fn(() => ({ agent: "openclaw", dashboardPort: 18789 }));
    const getAccessUrl = vi.fn(() => "http://127.0.0.1:18789");
    setDashboardUrlRuntimeBridgeFactoryForTest(() => ({
      fetchGatewayAuthTokenFromSandbox: mocks.fetchGatewayAuthTokenFromSandbox,
      getSandbox,
      getAccessUrl,
    }));

    await DashboardUrlCliCommand.run(["alpha", "--quiet"], rootDir);

    expect(mocks.runDashboardUrlCommand).toHaveBeenCalledWith(
      "alpha",
      { quiet: true },
      expect.objectContaining({
        fetchToken: mocks.fetchGatewayAuthTokenFromSandbox,
        getSandbox,
        getAccessUrl,
      }),
    );
  });

  it("uses process.exitCode (no @oclif/core ExitError) when the gateway-token action fails", async () => {
    // NCQ #3180: legacy dispatch did not catch the @oclif/core ExitError
    // thrown by this.exit(1), surfacing a raw JS stack trace to the user.
    // The adapter must signal failure via process.exitCode instead.
    mocks.runGatewayTokenCommand.mockImplementationOnce(() => {
      throw new mocks.GatewayTokenCommandError("not applicable");
    });
    setGatewayTokenRuntimeBridgeFactoryForTest(() => ({
      fetchGatewayAuthTokenFromSandbox: mocks.fetchGatewayAuthTokenFromSandbox,
      getSandboxAgent: () => "hermes",
    }));
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await expect(GatewayTokenCliCommand.run(["hermes"], rootDir)).resolves.toBeUndefined();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("clears a stale non-zero process.exitCode on a successful gateway-token run", async () => {
    // CodeRabbit #3182: if a prior run() left process.exitCode = 1, a later
    // successful invocation must still report success. Always overwrite.
    mocks.runGatewayTokenCommand.mockReturnValueOnce(undefined);
    setGatewayTokenRuntimeBridgeFactoryForTest(() => ({
      fetchGatewayAuthTokenFromSandbox: mocks.fetchGatewayAuthTokenFromSandbox,
      getSandboxAgent: () => "openclaw",
    }));
    const previousExitCode = process.exitCode;
    process.exitCode = 1;
    try {
      await GatewayTokenCliCommand.run(["alpha", "--quiet"], rootDir);
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it("runs hidden root help and version adapters", async () => {
    await RootHelpCommand.run([], rootDir);
    await VersionCommand.run([], rootDir);

    expect(mocks.showRootHelp).toHaveBeenCalledWith();
    expect(mocks.showVersion).toHaveBeenCalledWith();
  });

  it("maps tunnel and deprecated service commands to service actions", async () => {
    await TunnelStartCommand.run([], rootDir);
    await TunnelStopCommand.run([], rootDir);
    await DeprecatedStartCommand.run([], rootDir);
    await DeprecatedStopCommand.run([], rootDir);

    expect(mocks.runStartCommand).toHaveBeenCalledTimes(2);
    expect(mocks.runStopCommand).toHaveBeenCalledTimes(2);
    expect(mocks.runStartCommand).toHaveBeenCalledWith(
      expect.objectContaining({ listSandboxes: expect.any(Function), startAll: mocks.startAll }),
    );
    expect(mocks.runStopCommand).toHaveBeenCalledWith(
      expect.objectContaining({ listSandboxes: expect.any(Function), stopAll: mocks.stopAll }),
    );
  });

  it("passes uninstall runtime dependencies to the uninstall action", async () => {
    const originalEnv = process.env;
    await UninstallCliCommand.run(["--yes"], rootDir);

    expect(mocks.buildVersionedUninstallUrl).toHaveBeenCalledWith("1.2.3");
    expect(mocks.runUninstallCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["--yes"],
        rootDir,
        remoteScriptUrl: "https://example.test/1.2.3/uninstall.sh",
        env: originalEnv,
        spawnSyncImpl: mocks.spawnSync,
        log: console.log,
        error: console.error,
        exit: expect.any(Function),
      }),
    );
  });
});
