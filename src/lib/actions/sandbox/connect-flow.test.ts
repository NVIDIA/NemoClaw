// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import childProcess from "node:child_process";
import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

type ConnectSandbox =
  typeof import("../../../../dist/lib/actions/sandbox/connect")["connectSandbox"];

const requireDist = createRequire(import.meta.url);
const connectModulePath = "../../../../dist/lib/actions/sandbox/connect.js";

type ConnectHarness = {
  captureOpenshellSpy: MockInstance;
  checkAndRecoverSpy: MockInstance;
  connectSandbox: ConnectSandbox;
  ensureOllamaAuthProxySpy: MockInstance;
  errorSpy: MockInstance;
  logSpy: MockInstance;
  runAutoPairSpy: MockInstance;
  spawnSyncSpy: MockInstance;
};

type ConnectHarnessOptions = {
  agentName?: string;
  sessionAgent?: unknown;
  listOutput?: string;
  processCheck?: {
    checked: boolean;
    wasRunning?: boolean;
    recovered?: boolean;
    forwardRecovered?: boolean;
    secretBoundaryRefused?: boolean;
    secretBoundaryReason?: "raw-secret" | "inconclusive";
  };
  spawnSignal?: NodeJS.Signals | null;
  spawnStatus?: number | null;
  sttyThrows?: boolean;
};

function throwSttyFailure(): never {
  throw new Error("stty failed");
}

function spawnStatusFromOptions(options: ConnectHarnessOptions): number | null {
  return Object.hasOwn(options, "spawnStatus") ? (options.spawnStatus ?? null) : 0;
}

function createConnectHarness(options: ConnectHarnessOptions = {}): ConnectHarness {
  delete require.cache[requireDist.resolve(connectModulePath)];

  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const spawnSyncSpy = vi.spyOn(childProcess, "spawnSync").mockImplementation(((
    command: unknown,
  ) =>
    String(command) === "stty" && options.sttyThrows
      ? throwSttyFailure()
      : ({
          status: spawnStatusFromOptions(options),
          signal: options.spawnSignal ?? null,
        } as never)) as never);

  const runtime = requireDist("../../../../dist/lib/adapters/openshell/runtime.js");
  const resolve = requireDist("../../../../dist/lib/adapters/openshell/resolve.js");
  const agentRuntime = requireDist("../../../../dist/lib/agent/runtime.js");
  const gatewayState = requireDist("../../../../dist/lib/actions/sandbox/gateway-state.js");
  const processRecovery = requireDist("../../../../dist/lib/actions/sandbox/process-recovery.js");
  const autoPairApproval = requireDist(
    "../../../../dist/lib/actions/sandbox/auto-pair-approval.js",
  );
  const connectVllmPreflight = requireDist(
    "../../../../dist/lib/actions/sandbox/connect-vllm-preflight.js",
  );
  const gatewayFailureClassifier = requireDist(
    "../../../../dist/lib/actions/sandbox/gateway-failure-classifier.js",
  );
  const ollamaProxy = requireDist("../../../../dist/lib/inference/ollama/proxy.js");
  const sandboxVersion = requireDist("../../../../dist/lib/sandbox/version.js");
  const registry = requireDist("../../../../dist/lib/state/registry.js");
  const sandboxSession = requireDist("../../../../dist/lib/state/sandbox-session.js");

  vi.spyOn(connectVllmPreflight, "preflightVllmModelEnvOrExit").mockImplementation(() => undefined);
  vi.spyOn(gatewayState, "ensureLiveSandboxOrExit").mockResolvedValue({
    state: "present",
    output: "Name: alpha\nPhase: Ready\n",
  });
  vi.spyOn(gatewayFailureClassifier, "isDockerRuntimeDown").mockReturnValue(false);
  const captureOpenshellSpy = vi
    .spyOn(runtime, "captureOpenshell")
    .mockImplementation((args: unknown) => {
      const argv = Array.isArray(args) ? args : [];
      if (argv[0] === "sandbox" && argv[1] === "list") {
        return { status: 0, output: options.listOutput ?? "alpha Ready" };
      }
      if (argv[0] === "inference" && argv[1] === "get") {
        return { status: 0, output: "Provider: unknown\nModel: unknown\n" };
      }
      return { status: 0, output: "" };
    });
  vi.spyOn(runtime, "getOpenshellBinary").mockReturnValue("openshell");
  vi.spyOn(resolve, "resolveOpenshell").mockReturnValue("/usr/bin/openshell");
  vi.spyOn(sandboxSession, "getActiveSandboxSessions").mockReturnValue({
    detected: true,
    sessions: [{ pid: 1 }, { pid: 2 }],
  });
  vi.spyOn(sandboxVersion, "checkAgentVersion").mockReturnValue({ isStale: false });
  vi.spyOn(sandboxVersion, "formatStalenessWarning").mockReturnValue([]);
  const checkAndRecoverSpy = vi
    .spyOn(processRecovery, "checkAndRecoverSandboxProcesses")
    .mockReturnValue(options.processCheck ?? { checked: true, wasRunning: true, recovered: false });
  const ensureOllamaAuthProxySpy = vi
    .spyOn(ollamaProxy, "ensureOllamaAuthProxy")
    .mockImplementation(() => undefined);
  vi.spyOn(registry, "getSandbox").mockReturnValue({
    name: "alpha",
    agent: options.agentName ?? "openclaw",
    provider: null,
    model: null,
  });
  vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue(
    (options.sessionAgent ?? { name: "openclaw" }) as never,
  );
  vi.spyOn(agentRuntime, "getAgentDisplayName").mockReturnValue("OpenClaw");
  const runAutoPairSpy = vi
    .spyOn(autoPairApproval, "runSandboxAutoPairApprovalPass")
    .mockReturnValue({ reported: 0, approved: 0 });

  logSpy.mockClear();
  errorSpy.mockClear();
  spawnSyncSpy.mockClear();

  return {
    captureOpenshellSpy,
    checkAndRecoverSpy,
    connectSandbox: requireDist(connectModulePath).connectSandbox,
    ensureOllamaAuthProxySpy,
    errorSpy,
    logSpy,
    runAutoPairSpy,
    spawnSyncSpy,
  };
}

describe("connectSandbox flow", () => {
  let exitSpy: MockInstance;
  const originalStdinIsTty = process.stdin.isTTY;
  const originalStdinSetRawMode = (
    process.stdin as typeof process.stdin & { setRawMode?: (mode: boolean) => unknown }
  ).setRawMode;
  const originalStdoutIsTty = process.stdout.isTTY;

  beforeEach(() => {
    process.env.NEMOCLAW_TEST_NO_SLEEP = "1";
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalStdoutIsTty === undefined) {
      Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: undefined });
    } else {
      Object.defineProperty(process.stdout, "isTTY", {
        configurable: true,
        value: originalStdoutIsTty,
      });
    }
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: originalStdinIsTty,
    });
    Object.defineProperty(process.stdin, "setRawMode", {
      configurable: true,
      value: originalStdinSetRawMode,
    });
    delete process.env.NEMOCLAW_TEST_NO_SLEEP;
    delete require.cache[requireDist.resolve(connectModulePath)];
  });

  it("runs readiness checks, recovery probes, auto-pair approval, and opens the OpenShell shell", async () => {
    const harness = createConnectHarness();

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(0)");

    expect(harness.captureOpenshellSpy).toHaveBeenCalledWith(
      ["sandbox", "list"],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(harness.checkAndRecoverSpy).toHaveBeenCalledWith("alpha");
    expect(harness.ensureOllamaAuthProxySpy).toHaveBeenCalledTimes(1);
    expect(harness.runAutoPairSpy).toHaveBeenCalledWith("alpha", expect.any(Object));
    expect(harness.spawnSyncSpy).toHaveBeenCalledWith(
      "openshell",
      ["sandbox", "connect", "alpha"],
      expect.objectContaining({ stdio: "inherit" }),
    );
    const output = harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("existing SSH sessions");
    expect(output).toContain("Connecting to sandbox 'alpha'");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("restores the terminal and prints reconnect guidance when SSH disconnects", async () => {
    const setRawModeSpy = vi.fn();
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdin, "setRawMode", {
      configurable: true,
      value: setRawModeSpy,
    });
    const harness = createConnectHarness({
      agentName: "langchain-deepagents-code",
      sessionAgent: {
        name: "langchain-deepagents-code",
        runtime: { kind: "terminal", interactive_command: "dcode", headless_command: "dcode -n" },
      },
      spawnStatus: 255,
    });

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(255)");

    expect(setRawModeSpy).toHaveBeenCalledWith(false);
    expect(harness.spawnSyncSpy).toHaveBeenCalledWith(
      "stty",
      ["sane"],
      expect.objectContaining({ stdio: ["inherit", "ignore", "ignore"] }),
    );
    const errorOutput = harness.errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(errorOutput).toContain(
      "Gateway connection lost. Reconnect with: nemoclaw alpha connect",
    );
    expect(exitSpy).toHaveBeenCalledWith(255);
  });

  it.each([
    ["SIGHUP", 129],
    ["SIGPIPE", 141],
  ] as const)("restores the terminal and preserves the exit code when SSH ends with %s", async (signal, exitCode) => {
    const setRawModeSpy = vi.fn();
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdin, "setRawMode", {
      configurable: true,
      value: setRawModeSpy,
    });
    const harness = createConnectHarness({
      agentName: "langchain-deepagents-code",
      sessionAgent: {
        name: "langchain-deepagents-code",
        runtime: { kind: "terminal", interactive_command: "dcode", headless_command: "dcode -n" },
      },
      spawnSignal: signal,
      spawnStatus: null,
    });

    await expect(harness.connectSandbox("alpha")).rejects.toThrow(`process.exit(${exitCode})`);

    expect(setRawModeSpy).toHaveBeenCalledWith(false);
    expect(harness.spawnSyncSpy).toHaveBeenCalledWith(
      "stty",
      ["sane"],
      expect.objectContaining({ stdio: ["inherit", "ignore", "ignore"] }),
    );
    const errorOutput = harness.errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(errorOutput).toContain(
      "Gateway connection lost. Reconnect with: nemoclaw alpha connect",
    );
    expect(exitSpy).toHaveBeenCalledWith(exitCode);
  });

  it("prints reconnect guidance without terminal cleanup when stdin is not a TTY", async () => {
    const setRawModeSpy = vi.fn();
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
    Object.defineProperty(process.stdin, "setRawMode", {
      configurable: true,
      value: setRawModeSpy,
    });
    const harness = createConnectHarness({
      agentName: "langchain-deepagents-code",
      sessionAgent: {
        name: "langchain-deepagents-code",
        runtime: { kind: "terminal", interactive_command: "dcode", headless_command: "dcode -n" },
      },
      spawnStatus: 255,
    });

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(255)");

    expect(setRawModeSpy).not.toHaveBeenCalled();
    expect(harness.spawnSyncSpy).not.toHaveBeenCalledWith("stty", ["sane"], expect.any(Object));
    const errorOutput = harness.errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(errorOutput).toContain(
      "Gateway connection lost. Reconnect with: nemoclaw alpha connect",
    );
    expect(exitSpy).toHaveBeenCalledWith(255);
  });

  it("still runs stty cleanup when disabling raw mode throws", async () => {
    const setRawModeSpy = vi.fn(() => {
      throw new Error("raw mode failed");
    });
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdin, "setRawMode", {
      configurable: true,
      value: setRawModeSpy,
    });
    const harness = createConnectHarness({
      agentName: "langchain-deepagents-code",
      sessionAgent: {
        name: "langchain-deepagents-code",
        runtime: { kind: "terminal", interactive_command: "dcode", headless_command: "dcode -n" },
      },
      spawnStatus: 255,
    });

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(255)");

    expect(setRawModeSpy).toHaveBeenCalledWith(false);
    expect(harness.spawnSyncSpy).toHaveBeenCalledWith(
      "stty",
      ["sane"],
      expect.objectContaining({ stdio: ["inherit", "ignore", "ignore"] }),
    );
    expect(exitSpy).toHaveBeenCalledWith(255);
  });

  it("preserves the disconnect exit code when stty cleanup throws", async () => {
    const setRawModeSpy = vi.fn();
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdin, "setRawMode", {
      configurable: true,
      value: setRawModeSpy,
    });
    const harness = createConnectHarness({
      agentName: "langchain-deepagents-code",
      sessionAgent: {
        name: "langchain-deepagents-code",
        runtime: { kind: "terminal", interactive_command: "dcode", headless_command: "dcode -n" },
      },
      spawnStatus: 255,
      sttyThrows: true,
    });

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(255)");

    expect(setRawModeSpy).toHaveBeenCalledWith(false);
    const errorOutput = harness.errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(errorOutput).toContain(
      "Gateway connection lost. Reconnect with: nemoclaw alpha connect",
    );
    expect(exitSpy).toHaveBeenCalledWith(255);
  });

  it("prints the terminal launch command in the connect hint for terminal agents", async () => {
    const harness = createConnectHarness({
      agentName: "langchain-deepagents-code",
      sessionAgent: {
        name: "langchain-deepagents-code",
        runtime: { kind: "terminal", interactive_command: "dcode", headless_command: "dcode -n" },
      },
    });

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(0)");

    const output = harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("Inside the sandbox, run `dcode`");
    expect(output).not.toContain("Inside the sandbox, run `langchain-deepagents-code`");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("stops before opening SSH when the sandbox list reports a terminal failure phase", async () => {
    const harness = createConnectHarness({ listOutput: "alpha Error" });

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(1)");

    expect(harness.checkAndRecoverSpy).toHaveBeenCalledWith("alpha");
    expect(harness.ensureOllamaAuthProxySpy).toHaveBeenCalledTimes(1);
    expect(harness.spawnSyncSpy).not.toHaveBeenCalledWith(
      "openshell",
      ["sandbox", "connect", "alpha"],
      expect.any(Object),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("probe-only mode reports recovered gateways without opening an interactive shell", async () => {
    const harness = createConnectHarness({
      processCheck: { checked: true, wasRunning: false, recovered: true },
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).resolves.toBeUndefined();

    expect(harness.checkAndRecoverSpy).toHaveBeenCalledWith("alpha", { quiet: true });
    expect(harness.runAutoPairSpy).toHaveBeenCalledWith("alpha", expect.any(Object));
    expect(harness.spawnSyncSpy).not.toHaveBeenCalledWith(
      "openshell",
      ["sandbox", "connect", "alpha"],
      expect.any(Object),
    );
    expect(harness.logSpy.mock.calls.flat().join("\n")).toContain(
      "Probe complete: recovered OpenClaw gateway in 'alpha'.",
    );
  });

  it("probe-only mode exits when process inspection cannot run", async () => {
    const harness = createConnectHarness({
      processCheck: { checked: false, wasRunning: false, recovered: false },
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(harness.runAutoPairSpy).not.toHaveBeenCalled();
    expect(harness.spawnSyncSpy).not.toHaveBeenCalledWith(
      "openshell",
      ["sandbox", "connect", "alpha"],
      expect.any(Object),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("probe-only mode exits with raw-secret remediation when the Hermes boundary refuses recovery", async () => {
    const harness = createConnectHarness({
      processCheck: {
        checked: true,
        wasRunning: true,
        recovered: false,
        forwardRecovered: false,
        secretBoundaryRefused: true,
        secretBoundaryReason: "raw-secret",
      },
    });
    const agentRuntime = requireDist("../../../../dist/lib/agent/runtime.js");
    vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({ name: "hermes" });
    vi.spyOn(agentRuntime, "getAgentDisplayName").mockReturnValue("Hermes");
    const errorSpy = vi.spyOn(console, "error");

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(harness.runAutoPairSpy).not.toHaveBeenCalled();
    expect(harness.spawnSyncSpy).not.toHaveBeenCalledWith(
      "openshell",
      ["sandbox", "connect", "alpha"],
      expect.any(Object),
    );
    const errorOutput = errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(errorOutput).toContain(
      "Probe failed: refused to confirm Hermes gateway in 'alpha' — /sandbox/.hermes/.env contains raw secret-shaped values.",
    );
    expect(errorOutput).toContain(
      "Replace raw secret values with openshell:resolve:env:<name> placeholders and re-run.",
    );
    const logOutput = harness.logSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(logOutput).not.toContain("Probe complete");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("non-probe connect exits before Ollama/inference-route/auto-pair when the Hermes boundary refuses", async () => {
    const harness = createConnectHarness({
      processCheck: {
        checked: true,
        wasRunning: true,
        recovered: false,
        forwardRecovered: false,
        secretBoundaryRefused: true,
        secretBoundaryReason: "raw-secret",
      },
    });
    const agentRuntime = requireDist("../../../../dist/lib/agent/runtime.js");
    vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({ name: "hermes" });
    vi.spyOn(agentRuntime, "getAgentDisplayName").mockReturnValue("Hermes");
    const errorSpy = vi.spyOn(console, "error");

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(1)");

    expect(harness.ensureOllamaAuthProxySpy).not.toHaveBeenCalled();
    expect(harness.runAutoPairSpy).not.toHaveBeenCalled();
    expect(harness.spawnSyncSpy).not.toHaveBeenCalledWith(
      "openshell",
      ["sandbox", "connect", "alpha"],
      expect.any(Object),
    );
    const errorOutput = errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(errorOutput).toContain(
      "Connect failed: refused to confirm Hermes gateway in 'alpha' — /sandbox/.hermes/.env contains raw secret-shaped values.",
    );
    expect(errorOutput).toContain(
      "Replace raw secret values with openshell:resolve:env:<name> placeholders and re-run.",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("probe-only mode exits with inconclusive guidance when the Hermes boundary check could not run", async () => {
    const harness = createConnectHarness({
      processCheck: {
        checked: true,
        wasRunning: true,
        recovered: false,
        forwardRecovered: false,
        secretBoundaryRefused: true,
        secretBoundaryReason: "inconclusive",
      },
    });
    const agentRuntime = requireDist("../../../../dist/lib/agent/runtime.js");
    vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({ name: "hermes" });
    vi.spyOn(agentRuntime, "getAgentDisplayName").mockReturnValue("Hermes");
    const errorSpy = vi.spyOn(console, "error");

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(harness.runAutoPairSpy).not.toHaveBeenCalled();
    const errorOutput = errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(errorOutput).toContain(
      "Probe failed: secret-boundary check did not complete for Hermes gateway in 'alpha'.",
    );
    expect(errorOutput).toContain(
      "Inspect the validator output above and re-run `nemoclaw <sandbox> recover`.",
    );
    const logOutput = harness.logSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(logOutput).not.toContain("Probe complete");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
