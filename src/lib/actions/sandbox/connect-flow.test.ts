// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import {
  connectModulePath,
  createConnectHarness,
  requireDist,
} from "../../../../test/support/connect-flow-test-harness";

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

  it("runs the dcode inference route probe through its login-shell proxy contract (#6191)", async () => {
    const harness = createConnectHarness({
      agentName: "langchain-deepagents-code",
      sessionAgent: {
        name: "langchain-deepagents-code",
        runtime: { kind: "terminal", interactive_command: "dcode", headless_command: "dcode -n" },
      },
    });
    const registry = requireDist("../../src/lib/state/registry.js");
    registry.getSandbox.mockReturnValue({
      name: "alpha",
      agent: "langchain-deepagents-code",
      provider: "nvidia-prod",
      model: "nvidia/nemotron-3-super-120b-a12b",
      gpuEnabled: false,
      policies: [],
    });
    const responses = new Map([
      ["sandbox list", { status: 0, output: "alpha Ready" }],
      [
        "inference get",
        {
          status: 0,
          output:
            "Gateway inference:\n  Provider: nvidia-prod\n  Model: nvidia/nemotron-3-super-120b-a12b\n",
        },
      ],
      ["sandbox exec", { status: 0, output: "OK 200" }],
    ]);
    harness.captureOpenshellSpy.mockImplementation((args: unknown) => {
      const argv = Array.isArray(args) ? args : [];
      return responses.get(`${String(argv[0])} ${String(argv[1])}`) ?? { status: 0, output: "" };
    });

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(0)");

    expect(harness.captureOpenshellSpy).toHaveBeenCalledWith(
      [
        "sandbox",
        "exec",
        "--name",
        "alpha",
        "--",
        "env",
        "-u",
        "HTTP_PROXY",
        "-u",
        "HTTPS_PROXY",
        "-u",
        "http_proxy",
        "-u",
        "https_proxy",
        "-u",
        "NO_PROXY",
        "-u",
        "no_proxy",
        "-u",
        "ALL_PROXY",
        "-u",
        "all_proxy",
        "HOME=/sandbox",
        "bash",
        "-lc",
        expect.stringContaining("https://inference.local/v1/models"),
      ],
      expect.objectContaining({ ignoreError: true }),
    );
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
  it("probe-only mode exits when primary dashboard/API forward recovery fails", async () => {
    const harness = createConnectHarness({
      processCheck: {
        checked: true,
        wasRunning: true,
        recovered: false,
        forwardRecovered: false,
        forwardRecoveryFailed: true,
      },
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
    const errorOutput = harness.errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(errorOutput).toContain(
      "Probe failed: OpenClaw gateway is running in 'alpha', but the dashboard/API host forward could not be restored.",
    );
    expect(errorOutput).toContain("openshell forward start --background 18789 alpha");
    const logOutput = harness.logSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(logOutput).not.toContain("Probe complete");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
