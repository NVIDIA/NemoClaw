// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildVersionedUninstallUrl: vi.fn((version: string) => `https://example.test/${version}/uninstall.sh`),
  fetchGatewayAuthTokenFromSandbox: vi.fn(() => "token"),
  getVersion: vi.fn(() => "1.2.3"),
  captureOpenshellCommand: vi.fn(() => ({ status: 0, output: "alpha\n" })),
  listSandboxes: vi.fn(() => ({ sandboxes: [] })),
  resolveOpenshell: vi.fn(() => "/usr/bin/openshell"),
  runDebugCommandWithOptions: vi.fn(),
  runDeployAction: vi.fn().mockResolvedValue(undefined),
  runGatewayTokenCommand: vi.fn(() => 0),
  runStartCommand: vi.fn().mockResolvedValue(undefined),
  runStopCommand: vi.fn(),
  runUninstallCommand: vi.fn(),
  showRootHelp: vi.fn(),
  showVersion: vi.fn(),
  spawnSync: vi.fn(),
  startAll: vi.fn(),
  stopAll: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawnSync: mocks.spawnSync }));
vi.mock("../debug", () => ({ runDebug: vi.fn() }));
vi.mock("../debug-command", () => ({
  runDebugCommandWithOptions: mocks.runDebugCommandWithOptions,
}));
vi.mock("../gateway-token-command", () => ({
  runGatewayTokenCommand: mocks.runGatewayTokenCommand,
}));
vi.mock("../global-cli-actions", () => ({
  runDeployAction: mocks.runDeployAction,
  showRootHelp: mocks.showRootHelp,
  showVersion: mocks.showVersion,
}));
vi.mock("../adapters/openshell/client", () => ({ captureOpenshellCommand: mocks.captureOpenshellCommand }));
vi.mock("../registry", () => ({ listSandboxes: mocks.listSandboxes }));
vi.mock("../adapters/openshell/resolve", () => ({ resolveOpenshell: mocks.resolveOpenshell }));
vi.mock("../services", () => ({ startAll: mocks.startAll, stopAll: mocks.stopAll }));
vi.mock("../services-command", () => ({
  runStartCommand: mocks.runStartCommand,
  runStopCommand: mocks.runStopCommand,
}));
vi.mock("../uninstall-command", () => ({
  buildVersionedUninstallUrl: mocks.buildVersionedUninstallUrl,
  runUninstallCommand: mocks.runUninstallCommand,
}));
vi.mock("../version", () => ({ getVersion: mocks.getVersion }));

import DebugCliCommand from "./debug";
import DeployCliCommand from "./deploy";
import GatewayTokenCliCommand, { setGatewayTokenRuntimeBridgeFactoryForTest } from "./gateway-token";
import DeprecatedStartCommand from "./deprecated/start";
import DeprecatedStopCommand from "./deprecated/stop";
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
    setGatewayTokenRuntimeBridgeFactoryForTest(() => ({
      fetchGatewayAuthTokenFromSandbox: mocks.fetchGatewayAuthTokenFromSandbox,
    }));

    await GatewayTokenCliCommand.run(["alpha", "--quiet"], rootDir);

    expect(mocks.runGatewayTokenCommand).toHaveBeenCalledWith(
      "alpha",
      { quiet: true },
      { fetchToken: mocks.fetchGatewayAuthTokenFromSandbox },
    );
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
