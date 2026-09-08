// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testTimeoutOptions } from "../../test/helpers/timeouts";

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
    buildVersionedUninstallUrl: vi.fn(
      (version: string) => `https://example.test/${version}/uninstall.sh`,
    ),
    fetchGatewayAuthTokenFromSandbox: vi.fn(() => "token"),
    getVersion: vi.fn(() => "1.2.3"),
    captureOpenshellCommand: vi.fn(() => ({ status: 0, output: "alpha\n" })),
    listSandboxes: vi.fn(() => ({ sandboxes: [] })),
    resolveOpenshell: vi.fn(() => "/usr/bin/openshell"),
    runDebugCommandWithOptions: vi.fn(),
    runDashboardUrlCommand: vi.fn(() => undefined),
    runGatewayTokenCommand: vi.fn(() => undefined),
    runStartCommand: vi.fn().mockResolvedValue(undefined),
    runStopCommand: vi.fn(),
    runUninstallCommand: vi.fn(),
    resolveDefaultSandboxName: vi.fn((listSandboxes: () => unknown) => {
      listSandboxes();
      return "resolved-sandbox";
    }),
    assertHermesPortableCommandUnavailable: vi.fn(),
    withMcpLifecycleLock: vi.fn(async (_sandboxName: string, operation: () => unknown) =>
      operation(),
    ),
    showRootHelp: vi.fn(),
    showStatus: vi.fn(),
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
  showRootHelp: mocks.showRootHelp,
  showVersion: mocks.showVersion,
}));
vi.mock("../lib/adapters/openshell/client", () => ({
  captureOpenshellCommand: mocks.captureOpenshellCommand,
}));
vi.mock("../lib/state/registry", () => ({ listSandboxes: mocks.listSandboxes }));
vi.mock("../lib/adapters/openshell/resolve", () => ({ resolveOpenshell: mocks.resolveOpenshell }));
vi.mock("../lib/tunnel/services", () => ({
  showStatus: mocks.showStatus,
  startAll: mocks.startAll,
  stopAll: mocks.stopAll,
}));
vi.mock("../lib/tunnel/service-command", () => ({
  resolveDefaultSandboxName: mocks.resolveDefaultSandboxName,
  runStartCommand: mocks.runStartCommand,
  runStopCommand: mocks.runStopCommand,
}));
vi.mock("../lib/uninstall-command", () => ({
  buildVersionedUninstallUrl: mocks.buildVersionedUninstallUrl,
  runUninstallCommand: mocks.runUninstallCommand,
}));
vi.mock("../lib/core/version", () => ({ getVersion: mocks.getVersion }));
vi.mock("../lib/onboard/experimental/portable-agent-lifecycle", async (importOriginal) => ({
  ...(await importOriginal()),
  assertHermesPortableCommandUnavailable: mocks.assertHermesPortableCommandUnavailable,
}));
vi.mock("../lib/state/mcp-lifecycle-lock-acquisition", async (importOriginal) => ({
  ...(await importOriginal()),
  withMcpLifecycleLock: mocks.withMcpLifecycleLock,
}));

import { log } from "../lib/cli/logger";
import DebugCliCommand from "./debug";
import RootHelpCommand from "./root/help";
import VersionCommand from "./root/version";
import DashboardUrlCliCommand, {
  setDashboardUrlRuntimeBridgeFactoryForTest,
} from "./sandbox/dashboard-url";
import GatewayTokenCliCommand, {
  setGatewayTokenRuntimeBridgeFactoryForTest,
} from "./sandbox/gateway/token";
import DeprecatedStartCommand from "./start";
import DeprecatedStopCommand from "./stop";
import TunnelStartCommand from "./tunnel/start";
import TunnelStatusCommand from "./tunnel/status";
import TunnelStopCommand from "./tunnel/stop";
import UninstallCliCommand from "./uninstall";

const rootDir = process.cwd();

describe("simple global oclif adapters", testTimeoutOptions(30_000), () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps debug parser output to its action", async () => {
    await DebugCliCommand.run(
      ["--quick", "--output", "/tmp/debug.tar.gz", "--sandbox", "alpha"],
      rootDir,
    );

    expect(mocks.runDebugCommandWithOptions).toHaveBeenCalledWith(
      { quick: true, output: "/tmp/debug.tar.gz", sandboxName: "alpha" },
      expect.objectContaining({
        getDefaultSandbox: expect.any(Function),
        runDebug: expect.any(Function),
      }),
    );
  });

  it("keeps debug -q scoped to quick diagnostics instead of global quiet mode", async () => {
    const configure = vi.spyOn(log, "configure").mockImplementation(() => undefined);

    await DebugCliCommand.run(["-q"], rootDir);

    expect(mocks.runDebugCommandWithOptions).toHaveBeenCalledWith(
      { quick: true },
      expect.objectContaining({ runDebug: expect.any(Function) }),
    );
    expect(configure).toHaveBeenCalledWith({ debug: false, quiet: false });
    expect(configure).not.toHaveBeenCalledWith({ debug: false, quiet: true });
  });

  it("builds debug defaults from the sandbox registry and OpenShell liveness", async () => {
    mocks.listSandboxes.mockReturnValue({
      defaultSandbox: "alpha",
      sandboxes: [{ name: "alpha", gatewayPort: 18080 }],
    } as never);
    await DebugCliCommand.run(["--quick"], rootDir);

    const deps = mocks.runDebugCommandWithOptions.mock.calls[0][1];
    await expect(deps.getDefaultSandbox()).resolves.toEqual({
      name: "alpha",
      gatewayName: "nemoclaw-18080",
    });
    expect(mocks.captureOpenshellCommand).toHaveBeenCalledWith(
      "/usr/bin/openshell",
      ["sandbox", "list", "-g", "nemoclaw-18080"],
      expect.objectContaining({
        cwd: rootDir,
        ignoreError: true,
        includeStderr: true,
        includeStreams: true,
      }),
    );
  });

  it("rejects a registered debug sandbox missing from a successful OpenShell observation", async () => {
    mocks.listSandboxes.mockReturnValue({
      defaultSandbox: "alpha",
      sandboxes: [{ name: "alpha" }],
    } as never);
    mocks.captureOpenshellCommand.mockReturnValue({ status: 0, output: "beta\n" });

    await DebugCliCommand.run(["--quick"], rootDir);

    const deps = mocks.runDebugCommandWithOptions.mock.calls[0][1];
    await expect(deps.getDefaultSandbox()).resolves.toBeNull();
    await expect(deps.getSandboxAvailability("alpha")).resolves.toEqual({ state: "missing" });
  });

  it("rejects a fallback registered sandbox missing from OpenShell", async () => {
    mocks.listSandboxes.mockReturnValue({
      defaultSandbox: null,
      sandboxes: [{ name: "alpha" }],
    } as never);
    mocks.captureOpenshellCommand.mockReturnValue({ status: 0, output: "beta\n" });

    await DebugCliCommand.run(["--quick"], rootDir);

    const deps = mocks.runDebugCommandWithOptions.mock.calls[0][1];
    await expect(deps.getDefaultSandbox()).resolves.toBeNull();
  });

  it("keeps a fallback registered sandbox when OpenShell observation fails", async () => {
    mocks.listSandboxes.mockReturnValue({
      defaultSandbox: null,
      sandboxes: [{ name: "alpha" }],
    } as never);
    mocks.captureOpenshellCommand.mockReturnValue({ status: 1, output: "unavailable" });

    await DebugCliCommand.run(["--quick"], rootDir);

    const deps = mocks.runDebugCommandWithOptions.mock.calls[0][1];
    await expect(deps.getDefaultSandbox()).resolves.toEqual({ name: "alpha", gatewayName: "nemoclaw" });
  });

  it("rejects an explicit sandbox when OpenShell authentication fails", async () => {
    mocks.listSandboxes.mockReturnValue({
      defaultSandbox: "alpha",
      sandboxes: [{ name: "alpha" }],
    } as never);
    mocks.captureOpenshellCommand.mockReturnValue({
      status: 1,
      output: "authentication failed",
    });

    await DebugCliCommand.run(["--quick"], rootDir);

    const deps = mocks.runDebugCommandWithOptions.mock.calls[0][1];
    await expect(deps.getSandboxAvailability("alpha")).resolves.toEqual({
      state: "observation_denied",
    });
  });

  it("rejects an explicit sandbox with an invalid gateway binding", async () => {
    mocks.listSandboxes.mockReturnValue({
      defaultSandbox: "alpha",
      sandboxes: [{ name: "alpha", gatewayName: "untrusted" }],
    } as never);

    await DebugCliCommand.run(["--quick"], rootDir);

    const deps = mocks.runDebugCommandWithOptions.mock.calls[0][1];
    await expect(deps.getSandboxAvailability("alpha")).resolves.toEqual({
      state: "invalid_gateway",
    });
    expect(mocks.captureOpenshellCommand).not.toHaveBeenCalled();
  });

  it("keeps registered debug sandboxes when OpenShell observation fails", async () => {
    mocks.listSandboxes.mockReturnValue({
      defaultSandbox: "alpha",
      sandboxes: [{ name: "alpha" }],
    } as never);
    mocks.captureOpenshellCommand.mockReturnValue({ status: 1, output: "unavailable" });

    await DebugCliCommand.run(["--quick"], rootDir);

    const deps = mocks.runDebugCommandWithOptions.mock.calls[0][1];
    await expect(deps.getDefaultSandbox()).resolves.toEqual({ name: "alpha", gatewayName: "nemoclaw" });
    await expect(deps.getSandboxAvailability("alpha")).resolves.toEqual({ state: "available", gatewayName: "nemoclaw" });
  });

  it("maps gateway-token flags to the gateway token action", async () => {
    const getSandboxAgent = vi.fn(() => "openclaw");
    const fetchToken = mocks.fetchGatewayAuthTokenFromSandbox;
    const agentExposesToken = vi.fn(() => true);
    setGatewayTokenRuntimeBridgeFactoryForTest(() => ({
      fetchToken,
      getSandboxAgent,
      agentExposesToken,
    }));

    await GatewayTokenCliCommand.run(["alpha", "--quiet"], rootDir);

    expect(mocks.runGatewayTokenCommand).toHaveBeenCalledWith(
      "alpha",
      { quiet: true },
      { fetchToken, getSandboxAgent, agentExposesToken },
    );
    expect(mocks.withMcpLifecycleLock).toHaveBeenCalledWith("alpha", expect.any(Function));
  });

  it("rejects schema-5 gateway-token before fetching or printing credentials (#9203)", async () => {
    const fetchToken = vi.fn(() => "must-not-print");
    setGatewayTokenRuntimeBridgeFactoryForTest(() => ({
      fetchToken,
      getSandboxAgent: () => "hermes",
      agentExposesToken: () => true,
    }));
    mocks.assertHermesPortableCommandUnavailable.mockImplementationOnce(() => {
      throw new Error("schema-5 token rejected");
    });

    await expect(GatewayTokenCliCommand.run(["alpha", "--quiet"], rootDir)).rejects.toThrow(
      "schema-5 token rejected",
    );

    expect(fetchToken).not.toHaveBeenCalled();
    expect(mocks.runGatewayTokenCommand).not.toHaveBeenCalled();
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
      fetchToken: mocks.fetchGatewayAuthTokenFromSandbox,
      getSandboxAgent: () => "hermes",
      agentExposesToken: () => false,
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

  it("renders every line of a multi-line Hermes diagnostic to stderr without leaking an oclif stack trace", async () => {
    // PRA-T3 on #5252: when the helper throws a multi-line
    // GatewayTokenCommandError for a Hermes sandbox, the wrapper must
    // (a) write every line via console.error, (b) signal failure via
    // process.exitCode, and (c) leak no @oclif/core ExitError stack trace.
    const hermesLines = [
      "  gateway-token is not applicable for sandbox 'hermes': it uses the 'hermes' agent, which does not expose a gateway auth token. This command only supports the OpenClaw agent.",
      "  For Hermes dashboard access, run: nemohermes hermes dashboard-url",
      "  Hermes dashboard auth is read from the in-sandbox config (~/.hermes/config.yaml), not a gateway token.",
    ];
    mocks.runGatewayTokenCommand.mockImplementationOnce(() => {
      throw new mocks.GatewayTokenCommandError(hermesLines, 1);
    });
    setGatewayTokenRuntimeBridgeFactoryForTest(() => ({
      fetchToken: mocks.fetchGatewayAuthTokenFromSandbox,
      getSandboxAgent: () => "hermes",
      agentExposesToken: () => false,
    }));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await expect(GatewayTokenCliCommand.run(["hermes"], rootDir)).resolves.toBeUndefined();
      expect(process.exitCode).toBe(1);
      hermesLines.forEach((line) => {
        expect(errorSpy).toHaveBeenCalledWith(line);
      });
      const combined = errorSpy.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(combined).not.toMatch(/ExitError|@oclif\/core|at Object\.exit/);
    } finally {
      process.exitCode = previousExitCode;
      errorSpy.mockRestore();
    }
  });

  it("clears a stale non-zero process.exitCode on a successful gateway-token run", async () => {
    // CodeRabbit #3182: if a prior run() left process.exitCode = 1, a later
    // successful invocation must still report success. Always overwrite.
    mocks.runGatewayTokenCommand.mockReturnValueOnce(undefined);
    setGatewayTokenRuntimeBridgeFactoryForTest(() => ({
      fetchToken: mocks.fetchGatewayAuthTokenFromSandbox,
      getSandboxAgent: () => "openclaw",
      agentExposesToken: () => true,
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
    expect(mocks.runStartCommand).toHaveBeenCalledTimes(1);
    await TunnelStopCommand.run([], rootDir);
    await TunnelStatusCommand.run([], rootDir);
    await DeprecatedStartCommand.run([], rootDir);
    expect(mocks.runStartCommand).toHaveBeenCalledTimes(1);
    await DeprecatedStopCommand.run([], rootDir);

    expect(mocks.runStopCommand).toHaveBeenCalledTimes(2);
    expect(mocks.runStartCommand).toHaveBeenCalledWith(
      expect.objectContaining({ listSandboxes: expect.any(Function), startAll: mocks.startAll }),
    );
    expect(mocks.resolveDefaultSandboxName).toHaveBeenCalledTimes(1);
    expect(mocks.listSandboxes).toHaveBeenCalledTimes(1);
    expect(mocks.showStatus).toHaveBeenCalledWith({ sandboxName: "resolved-sandbox" });
    expect(mocks.runStopCommand).toHaveBeenCalledWith(
      expect.objectContaining({ listSandboxes: expect.any(Function), stopAll: mocks.stopAll }),
    );
    expect(mocks.runStopCommand.mock.calls).toEqual(
      expect.arrayContaining([
        [expect.not.objectContaining({ releaseGatewayPort: true })],
        [expect.objectContaining({ releaseGatewayPort: true })],
      ]),
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

  it("forwards uninstall flags without assigning host logging semantics", async () => {
    const configure = vi.spyOn(log, "configure").mockImplementation(() => undefined);

    await UninstallCliCommand.run(["--yes", "--debug"], rootDir);

    expect(mocks.runUninstallCommand).toHaveBeenCalledWith(
      expect.objectContaining({ args: ["--yes", "--debug"] }),
    );
    expect(configure).toHaveBeenCalledWith({ debug: false, quiet: false });
    expect(configure).not.toHaveBeenCalledWith({ debug: true, quiet: false });
  });
});
