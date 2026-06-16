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
  logSpy: MockInstance;
  runAutoPairSpy: MockInstance;
  spawnSyncSpy: MockInstance;
};

type ConnectHarnessOptions = {
  listOutput?: string;
  processCheck?: {
    checked: boolean;
    wasRunning?: boolean;
    recovered?: boolean;
    forwardRecovered?: boolean;
  };
  spawnStatus?: number | null;
};

function createConnectHarness(options: ConnectHarnessOptions = {}): ConnectHarness {
  delete require.cache[requireDist.resolve(connectModulePath)];

  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const spawnSyncSpy = vi.spyOn(childProcess, "spawnSync").mockReturnValue({
    status: options.spawnStatus ?? 0,
    signal: null,
  } as never);

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
    agent: "openclaw",
    provider: null,
    model: null,
  });
  vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({ name: "openclaw" });
  vi.spyOn(agentRuntime, "getAgentDisplayName").mockReturnValue("OpenClaw");
  const runAutoPairSpy = vi
    .spyOn(autoPairApproval, "runSandboxAutoPairApprovalPass")
    .mockReturnValue({ reported: 0, approved: 0 });

  logSpy.mockClear();
  spawnSyncSpy.mockClear();

  return {
    captureOpenshellSpy,
    checkAndRecoverSpy,
    connectSandbox: requireDist(connectModulePath).connectSandbox,
    ensureOllamaAuthProxySpy,
    logSpy,
    runAutoPairSpy,
    spawnSyncSpy,
  };
}

describe("connectSandbox flow", () => {
  let exitSpy: MockInstance;
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
});
