// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import {
  connectModulePath,
  createConnectHarness,
  requireDist,
} from "../../../../test/support/connect-flow-test-harness";

function captureInferenceRouteThenDrift(
  harness: ReturnType<typeof createConnectHarness>,
): (args: unknown) => { status: number; output: string; stderr?: string } {
  return (args: unknown) => {
    const argv = Array.isArray(args) ? args : [];
    switch (argv.slice(0, 2).join("\0")) {
      case "inference\0get":
        harness.registryEntries[0]!.model = "changed-model";
        return {
          status: 0,
          output: "Gateway inference:\n  Provider: ollama-local\n  Model: qwen3-vl:4b\n",
        };
      case "sandbox\0exec":
        return { status: 0, output: "OK 200", stderr: "" };
      default:
        return { status: 0, output: "alpha Ready" };
    }
  };
}

function captureInferenceRouteThenDriftLiveIdentity(
  harness: ReturnType<typeof createConnectHarness>,
): (args: unknown) => { status: number; output: string; stderr?: string } {
  return (args: unknown) => {
    const argv = Array.isArray(args) ? args : [];
    switch (argv.slice(0, 2).join("\0")) {
      case "inference\0get":
        harness.registryEntries[0]!.lifecycleLiveIdentityFingerprint = "0".repeat(64);
        return {
          status: 0,
          output: "Gateway inference:\n  Provider: ollama-local\n  Model: qwen3-vl:4b\n",
        };
      case "sandbox\0exec":
        return { status: 0, output: "OK 200", stderr: "" };
      default:
        return { status: 0, output: "alpha Ready" };
    }
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
    vi.unstubAllEnvs();
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
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const harness = createConnectHarness();

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(0)");

    expect(harness.captureOpenshellSpy).toHaveBeenCalledWith(
      ["sandbox", "list", "-g", "nemoclaw"],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(harness.checkAndRecoverSpy).toHaveBeenCalledWith("alpha");
    expect(harness.ensureOllamaAuthProxySpy).toHaveBeenCalledTimes(1);
    expect(harness.runAutoPairSpy).toHaveBeenCalledWith("alpha", "nemoclaw");
    expect(harness.runSandboxExecChildSpy).toHaveBeenCalledWith(
      "openshell",
      ["sandbox", "connect", "alpha"],
      expect.objectContaining({
        hostCwd: expect.any(String),
        stdin: true,
      }),
    );
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 1_000);
    const watcherTimer = setIntervalSpy.mock.results[setIntervalSpy.mock.results.length - 1]?.value;
    expect(clearIntervalSpy).toHaveBeenCalledWith(watcherTimer);
    expect(harness.runSandboxExecChildSpy.mock.invocationCallOrder[0]!).toBeLessThan(
      exitSpy.mock.invocationCallOrder[0]!,
    );
    const output = harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("existing SSH sessions");
    expect(output).toContain("Connecting to sandbox 'alpha'");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("uses the owning OpenShell gateway for auto-pair when an ambient gateway has the same sandbox name (#8942)", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY", "ambient-sibling");
    const harness = createConnectHarness({
      registryEntry: { gatewayName: "nemoclaw-8091", gatewayPort: 8091 },
    });

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(0)");

    expect(process.env.OPENSHELL_GATEWAY).toBe("ambient-sibling");
    expect(harness.runAutoPairSpy).toHaveBeenCalledWith("alpha", "nemoclaw-8091");
  });

  it("uses strict settlement and skips ordinary approval for a completed Portable sandbox (#9207)", async () => {
    const harness = createConnectHarness({
      portablePairingSettlementResult: { kind: "settled" },
    });

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(0)");

    expect(harness.settlePortablePairingSpy).toHaveBeenCalledWith("alpha");
    expect(harness.runAutoPairSpy).not.toHaveBeenCalled();
  });

  it("stops connect with an incomplete-onboarding diagnosis when Portable settlement fails (#9207)", async () => {
    const harness = createConnectHarness({
      portablePairingSettlementResult: {
        kind: "incomplete",
        reason: "portable-policy-incomplete",
      },
    });

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(1)");

    const output = harness.errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(output).toContain("Portable onboarding for 'alpha' is incomplete");
    expect(output).toContain("Resume or rerun onboarding");
    expect(harness.runAutoPairSpy).not.toHaveBeenCalled();
    expect(
      harness.spawnSyncSpy.mock.calls.some(
        ([, args]) => Array.isArray(args) && args[0] === "sandbox" && args[1] === "connect",
      ),
    ).toBe(false);
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
  ] as const)(
    "restores the terminal and preserves the exit code when SSH ends with %s",
    async (signal, exitCode) => {
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
      const errorOutput = harness.errorSpy.mock.calls
        .map((call) => String(call[0] ?? ""))
        .join("\n");
      expect(errorOutput).toContain(
        "Gateway connection lost. Reconnect with: nemoclaw alpha connect",
      );
      expect(exitSpy).toHaveBeenCalledWith(exitCode);
    },
  );

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

  it("runs the DCode route probe through its managed runtime boundary (#6191)", async () => {
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
        "--no-tty",
        "--env",
        "HOME=/usr/local/lib/nemoclaw",
        "--env",
        "BASH_ENV=",
        "--env",
        "ENV=",
        "--",
        "/usr/local/lib/nemoclaw/dcode-managed-exec",
        "/bin/sh",
        "-c",
        expect.stringContaining("/usr/bin/curl"),
      ],
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it.each([401, 403, 404])(
    "rejects HTTP %i from inference.local for an Ollama recovery path (#8502)",
    async (httpStatus) => {
      const response = `OK ${String(httpStatus)}`;
      const harness = createConnectHarness({
        inferenceGetOutput: "Provider: ollama-local\nModel: qwen3-vl:4b\n",
        inferenceProbeResponses: [response, response],
        registryEntry: { provider: "ollama-local", model: "qwen3-vl:4b" },
      });

      await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
        "process.exit(1)",
      );

      expect(harness.errorSpy.mock.calls.flat().join("\n")).toContain(
        "inference.local/v1/models must return HTTP 2xx",
      );
      expect(harness.probeLocalProviderHealthSpy).toHaveBeenCalledWith("ollama-local", {
        skipOllamaAuthProxySubprobe: true,
      });
      expect(harness.probeOllamaAuthProxyHealthSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(1);
    },
  );

  it("rechecks HTTP 2xx after repairing an Ollama inference route (#8502)", async () => {
    const harness = createConnectHarness({
      inferenceGetOutput: "Provider: ollama-local\nModel: qwen3-vl:4b\n",
      inferenceProbeResponses: ["BROKEN 503", "OK 401", "OK 401"],
      registryEntry: { provider: "ollama-local", model: "qwen3-vl:4b" },
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(harness.runSetupDnsProxySpy).toHaveBeenCalled();
    expect(harness.errorSpy.mock.calls.flat().join("\n")).toContain(
      "inference.local/v1/models must return HTTP 2xx",
    );
  });

  it("fails closed with actionable diagnostics when the initial route probe is inconclusive (#6192)", async () => {
    const longProbeDetail = `route probe unavailable NVIDIA_API_KEY=super-secret ${"x".repeat(400)}`;
    const harness = createConnectHarness({
      registryEntry: {
        provider: "nvidia-prod",
        model: "nvidia/nemotron-3-super-120b-a12b",
      },
      inferenceGetOutput: "Provider: nvidia-prod\nModel: nvidia/nemotron-3-super-120b-a12b\n",
      inferenceProbeResponses: [longProbeDetail],
    });

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(1)");

    expect(harness.applyVmDnsMonkeypatchSpy).not.toHaveBeenCalled();
    expect(harness.runSetupDnsProxySpy).not.toHaveBeenCalled();
    expect(harness.spawnSyncSpy).not.toHaveBeenCalledWith(
      "openshell",
      ["sandbox", "connect", "alpha"],
      expect.any(Object),
    );
    const errorOutput = harness.errorSpy.mock.calls.flat().join("\n");
    expect(errorOutput).toContain("did not return a trusted result");
    expect(errorOutput).toContain("Last probe: route probe unavailable");
    expect(errorOutput).toContain("Run:  nemoclaw alpha doctor");
    expect(errorOutput).not.toContain("super-secret");
    expect(errorOutput).not.toContain("x".repeat(241));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("fails closed without repair when the route probe transport throws (#6192)", async () => {
    const harness = createConnectHarness({
      registryEntry: {
        provider: "nvidia-prod",
        model: "nvidia/nemotron-3-super-120b-a12b",
      },
    });
    harness.captureOpenshellSpy
      .mockReturnValueOnce({ status: 0, output: "alpha Ready" })
      .mockReturnValueOnce({
        status: 0,
        output:
          "Gateway inference:\n  Provider: nvidia-prod\n  Model: nvidia/nemotron-3-super-120b-a12b\n",
      })
      .mockImplementationOnce(() => {
        throw new Error("sandbox exec transport failed");
      });

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(1)");

    expect(JSON.stringify(harness.captureOpenshellSpy.mock.calls[2]?.[0])).toContain(
      "inference.local/v1/models",
    );
    expect(harness.applyVmDnsMonkeypatchSpy).not.toHaveBeenCalled();
    expect(harness.runSetupDnsProxySpy).not.toHaveBeenCalled();
    expect(harness.runOpenshellSpy).not.toHaveBeenCalled();
    expect(harness.spawnSyncSpy).not.toHaveBeenCalledWith(
      "openshell",
      ["sandbox", "connect", "alpha"],
      expect.any(Object),
    );
    const errorOutput = harness.errorSpy.mock.calls.flat().join("\n");
    expect(errorOutput).toContain("did not return a trusted result");
    expect(errorOutput).toContain("Last probe: sandbox exec transport failed");
    expect(errorOutput).not.toContain("after DNS and route repair");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("fails closed without repair when the route probe transport times out (#6192)", async () => {
    const timeoutError = Object.assign(new Error("sandbox exec timed out"), {
      code: "ETIMEDOUT",
    });
    const harness = createConnectHarness({
      registryEntry: {
        provider: "nvidia-prod",
        model: "nvidia/nemotron-3-super-120b-a12b",
      },
    });
    harness.captureOpenshellSpy
      .mockReturnValueOnce({ status: 0, output: "alpha Ready" })
      .mockReturnValueOnce({
        status: 0,
        output:
          "Gateway inference:\n  Provider: nvidia-prod\n  Model: nvidia/nemotron-3-super-120b-a12b\n",
      })
      .mockReturnValueOnce({ status: null, output: "", error: timeoutError });

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(1)");

    expect(JSON.stringify(harness.captureOpenshellSpy.mock.calls[2]?.[0])).toContain(
      "inference.local/v1/models",
    );
    expect(harness.applyVmDnsMonkeypatchSpy).not.toHaveBeenCalled();
    expect(harness.runSetupDnsProxySpy).not.toHaveBeenCalled();
    expect(harness.runOpenshellSpy).not.toHaveBeenCalled();
    expect(harness.spawnSyncSpy).not.toHaveBeenCalledWith(
      "openshell",
      ["sandbox", "connect", "alpha"],
      expect.any(Object),
    );
    const errorOutput = harness.errorSpy.mock.calls.flat().join("\n");
    expect(errorOutput).toContain("did not return a trusted result");
    expect(errorOutput).toContain("openshell sandbox exec exited with status 1");
    expect(errorOutput).not.toContain("after DNS and route repair");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("fails closed without repair when the OpenShell CA boundary is unavailable (#6192)", async () => {
    const harness = createConnectHarness({
      registryEntry: {
        provider: "nvidia-prod",
        model: "nvidia/nemotron-3-super-120b-a12b",
      },
    });
    harness.captureOpenshellSpy
      .mockReturnValueOnce({ status: 0, output: "alpha Ready" })
      .mockReturnValueOnce({
        status: 0,
        output:
          "Gateway inference:\n  Provider: nvidia-prod\n  Model: nvidia/nemotron-3-super-120b-a12b\n",
      })
      .mockReturnValueOnce({
        status: 0,
        output: "UNAVAILABLE OpenShell CA bundle missing or unreadable",
      });

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(1)");

    expect(harness.applyVmDnsMonkeypatchSpy).not.toHaveBeenCalled();
    expect(harness.runSetupDnsProxySpy).not.toHaveBeenCalled();
    expect(harness.runOpenshellSpy).not.toHaveBeenCalled();
    expect(harness.spawnSyncSpy).not.toHaveBeenCalledWith(
      "openshell",
      ["sandbox", "connect", "alpha"],
      expect.any(Object),
    );
    const errorOutput = harness.errorSpy.mock.calls.flat().join("\n");
    expect(errorOutput).toContain("did not return a trusted result");
    expect(errorOutput).toContain("OpenShell CA bundle missing or unreadable");
    expect(errorOutput).not.toContain("after DNS and route repair");
    expect(exitSpy).toHaveBeenCalledWith(1);
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
      processCheck: {
        checked: true,
        wasRunning: false,
        recovered: true,
        managedControlCompletion: { disposition: "ok", oldPid: 0, newPid: 123 },
      },
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).resolves.toBeUndefined();

    expect(harness.checkAndRecoverSpy).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ quiet: true }),
    );
    expect(harness.runAutoPairSpy).toHaveBeenCalledWith("alpha");
    expect(harness.spawnSyncSpy).not.toHaveBeenCalledWith(
      "openshell",
      ["sandbox", "connect", "alpha"],
      expect.any(Object),
    );
    const output = harness.logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Probe complete: recovered OpenClaw gateway in 'alpha'.");
    expect(output).toMatch(/Probe timing: .*lifecycleAction=skipped .*result=ready/);
  });

  it("probe-only accepts healthy launch evidence without duplicate recovery or publication (#8942)", async () => {
    const sb = { name: "alpha", agent: "openclaw", provider: null, model: null, policies: [] };
    const harness = createConnectHarness({
      readinessDecision: {
        kind: "accepted",
        category: "accepted",
        agent: { name: "openclaw" },
        sb,
      },
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).resolves.toBeUndefined();

    expect(harness.requalifyPortableAgentAuthoritySpy).not.toHaveBeenCalled();
    expect(harness.checkAndRecoverSpy).not.toHaveBeenCalled();
    expect(harness.ensureLiveSandboxSpy).not.toHaveBeenCalled();
    expect(harness.publishLaunchReadinessSpy).not.toHaveBeenCalled();
    const output = harness.logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Probe complete: launch readiness is healthy for 'alpha'.");
    expect(output).toMatch(
      /Probe timing: .*lifecycleAction=reused forwardAction=skipped result=ready/,
    );
  });

  it("probe-only skips every mutation when a newer accepted lease replaces its epoch (#8942)", async () => {
    const sb = { name: "alpha", agent: "openclaw", provider: null, model: null, policies: [] };
    const harness = createConnectHarness();
    harness.inspectLaunchReadinessSpy
      .mockResolvedValueOnce({
        kind: "fallback",
        category: "config",
        fence: { epochId: "a".repeat(64) },
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        fenceFailed: false,
        recoveryBlocked: false,
      })
      .mockResolvedValueOnce({
        kind: "accepted",
        category: "accepted",
        agent: { name: "openclaw" },
        sb,
      });
    harness.launchReadinessMutationGateSpy.mockResolvedValueOnce({ kind: "changed" });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).resolves.toBeUndefined();

    expect(harness.inspectLaunchReadinessSpy).toHaveBeenCalledTimes(2);
    expect(harness.checkAndRecoverSpy).not.toHaveBeenCalled();
    expect(harness.ensureLiveSandboxSpy).not.toHaveBeenCalled();
    expect(harness.publishLaunchReadinessSpy).not.toHaveBeenCalled();
    expect(harness.logSpy.mock.calls.flat().join("\n")).toContain(
      "Probe complete: launch readiness is healthy for 'alpha'.",
    );
  });

  it("probe-only refuses runtime recovery when prior evidence cannot be fenced (#8942)", async () => {
    const harness = createConnectHarness({
      readinessDecision: {
        kind: "fallback",
        category: "unsafe",
        fence: null,
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        fenceFailed: true,
        recoveryBlocked: true,
      },
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(harness.checkAndRecoverSpy).not.toHaveBeenCalled();
    expect(harness.errorSpy.mock.calls.flat().join("\n")).toContain(
      "complete probe and recovery did not run because prior launch-readiness evidence could not be fenced",
    );
    expect(harness.logSpy.mock.calls.flat().join("\n")).toMatch(
      /Probe timing: .*result=failed failedStage=readiness/,
    );
  });

  it("probe-only completes recovery after secure absence is proven and reports unpublished evidence (#9280)", async () => {
    const harness = createConnectHarness({
      readinessDecision: {
        kind: "fallback",
        category: "unsafe",
        fence: null,
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        fenceFailed: true,
        recoveryBlocked: false,
      },
      readinessPublicationResult: { kind: "evidence-failed" },
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(harness.checkAndRecoverSpy).toHaveBeenCalledOnce();
    expect(harness.ensureLiveSandboxSpy).toHaveBeenCalled();
    expect(harness.publishLaunchReadinessSpy).toHaveBeenCalledOnce();
    expect(harness.errorSpy).toHaveBeenCalledWith(
      "  Probe failed: complete probe and recovery succeeded, but final launch-readiness evidence could not be verified or published.",
    );
    expect(harness.errorSpy.mock.calls.flat().join("\n")).not.toContain(
      "new launch-readiness authority could not be created",
    );
  });

  it("probe-only completes macOS recovery and exits zero when evidence is unavailable (#9278)", async () => {
    const harness = createConnectHarness({
      readinessDecision: {
        kind: "fallback",
        category: "unsafe",
        fence: null,
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        fenceFailed: true,
        recoveryBlocked: false,
        authorityUnsupported: true,
      },
      readinessPublicationResult: { kind: "evidence-failed" },
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).resolves.toBeUndefined();

    expect(harness.checkAndRecoverSpy).toHaveBeenCalledOnce();
    expect(harness.ensureLiveSandboxSpy).toHaveBeenCalled();
    expect(harness.publishLaunchReadinessSpy).toHaveBeenCalledOnce();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(harness.logSpy).toHaveBeenCalledWith(
      "  Note: launch-readiness evidence is unavailable on this platform; the next launch runs the complete preflight.",
    );
    expect(harness.errorSpy.mock.calls.flat().join("\n")).not.toContain("Probe failed");
  });

  it("lets a public lifecycle command continue after recovery when evidence publication is unavailable (#8942)", async () => {
    const harness = createConnectHarness({
      readinessDecision: {
        kind: "fallback",
        category: "unsafe",
        fence: null,
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        fenceFailed: true,
        recoveryBlocked: false,
        authorityUnsupported: true,
      },
      readinessPublicationResult: { kind: "evidence-failed" },
    });

    await expect(
      harness.connectSandbox("alpha", {
        probeOnly: true,
        requireLaunchReadinessPublication: false,
      }),
    ).resolves.toBeUndefined();

    expect(harness.checkAndRecoverSpy).toHaveBeenCalledOnce();
    expect(harness.ensureLiveSandboxSpy).toHaveBeenCalled();
    expect(harness.publishLaunchReadinessSpy).toHaveBeenCalledOnce();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(harness.errorSpy).not.toHaveBeenCalled();
  });

  it("keeps authoritative runtime validation failures blocking for public lifecycle commands (#8942)", async () => {
    const harness = createConnectHarness({
      readinessPublicationResult: { kind: "validation-failed", category: "health" },
    });

    await expect(
      harness.connectSandbox("alpha", {
        probeOnly: true,
        requireLaunchReadinessPublication: false,
      }),
    ).rejects.toThrow("process.exit(1)");

    expect(harness.checkAndRecoverSpy).toHaveBeenCalledOnce();
    expect(harness.errorSpy.mock.calls.flat().join("\n")).toContain(
      "final launch-readiness validation failed due to health",
    );
  });

  it("probe-only stops before mutation when the fenced epoch cannot be revalidated (#8942)", async () => {
    const harness = createConnectHarness();
    harness.launchReadinessMutationGateSpy.mockResolvedValueOnce({ kind: "unsafe" });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(harness.checkAndRecoverSpy).not.toHaveBeenCalled();
    expect(harness.ensureLiveSandboxSpy).not.toHaveBeenCalled();
    expect(harness.publishLaunchReadinessSpy).not.toHaveBeenCalled();
    expect(harness.errorSpy.mock.calls.flat().join("\n")).toContain(
      "current launch-readiness epoch could not be safely revalidated",
    );
  });

  it("probe-only distinguishes completed recovery from final evidence failure (#8942)", async () => {
    const harness = createConnectHarness({
      readinessPublicationResult: { kind: "evidence-failed" },
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(harness.checkAndRecoverSpy).toHaveBeenCalled();
    expect(harness.publishLaunchReadinessSpy).toHaveBeenCalled();
    expect(harness.errorSpy.mock.calls.flat().join("\n")).toContain(
      "complete probe and recovery succeeded, but final launch-readiness evidence could not be verified or published",
    );
  });

  it("probe-only names the failed final semantic check (#9834)", async () => {
    const harness = createConnectHarness({
      readinessPublicationResult: {
        kind: "validation-failed",
        category: "health",
        failedCheck: "inference request",
      },
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(harness.checkAndRecoverSpy).toHaveBeenCalled();
    expect(harness.errorSpy.mock.calls.flat().join("\n")).toContain(
      "final launch-readiness validation failed because the inference request failed",
    );
    expect(harness.errorSpy.mock.calls.flat().join("\n")).not.toContain(
      "complete probe and recovery succeeded",
    );
  });

  it("probe-only mode exits before reporting success when inference.local returns no trusted result (#8502)", async () => {
    const harness = createConnectHarness({
      registryEntry: {
        provider: "nvidia-prod",
        model: "nvidia/nemotron-3-super-120b-a12b",
      },
      inferenceGetOutput: "Provider: nvidia-prod\nModel: nvidia/nemotron-3-super-120b-a12b\n",
      inferenceProbeResponses: ["route probe unavailable"],
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(harness.logSpy.mock.calls.flat().join("\n")).not.toContain("Probe complete");
    expect(harness.errorSpy.mock.calls.flat().join("\n")).toContain(
      "inference route is not known healthy",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("probe-only mode reports an ordinary running gateway for an already-running completion (#7919)", async () => {
    const harness = createConnectHarness({
      processCheck: {
        checked: true,
        wasRunning: false,
        recovered: true,
        managedControlCompletion: {
          disposition: "already-running",
          oldPid: 123,
          newPid: 456,
        },
      },
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).resolves.toBeUndefined();

    const output = harness.logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Probe complete: OpenClaw gateway is running in 'alpha'.");
    expect(output).not.toContain("Probe complete: recovered OpenClaw gateway");
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
  it("probe-only mode reports the supported repair when relaunch is quarantined (#7801)", async () => {
    const harness = createConnectHarness({
      processCheck: { checked: true, wasRunning: false, recovered: false },
    });
    // Managed recovery runs quiet on this path, so the classified layer only
    // reaches the operator through the callback the probe passes in.
    harness.checkAndRecoverSpy.mockImplementation((_sandboxName: unknown, options: unknown) => {
      (
        options as { onRecoveryFailureLayer?: (layer: string) => void } | undefined
      )?.onRecoveryFailureLayer?.("relaunch quarantined");
      return { checked: true, wasRunning: false, recovered: false };
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    const errorOutput = harness.errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(errorOutput).toContain("quarantined gateway relaunch");
    expect(errorOutput).toContain("nemoclaw alpha rebuild --yes");
    expect(errorOutput).not.toContain("Check /tmp/gateway.log inside the sandbox for details.");
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

  it("keeps active Hermes probe on receipt-owned recovery with every Docker path poisoned (#9203)", async () => {
    const harness = createConnectHarness({
      agentName: "hermes",
      sessionAgent: { name: "hermes" },
      registryEntry: {
        openshellDriver: "docker",
        gatewayName: "nemoclaw",
        lifecycleGeneration: "generation-1",
      },
      portableReceiptDisposition: { kind: "hermes", phase: "active" },
      portableRecoveryResult: { kind: "already-running" },
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).resolves.toBeUndefined();

    expect(harness.checkAndRecoverSpy).not.toHaveBeenCalled();
    expect(harness.ensureLiveSandboxSpy).not.toHaveBeenCalled();
    expect(harness.captureOpenshellSpy).not.toHaveBeenCalled();
    expect(harness.captureResolvedOpenshellSpy).toHaveBeenCalledWith(
      ["sandbox", "list", "-g", "nemoclaw"],
      expect.objectContaining({
        env: expect.objectContaining({ HOME: "/home/test" }),
        openshellBinary: "/usr/bin/openshell",
        replaceEnv: true,
      }),
    );
    expect(harness.getSandboxDockerRuntimeSpy).not.toHaveBeenCalled();
    expect(harness.dockerStartSpy).not.toHaveBeenCalled();
    expect(harness.runAutoPairSpy).not.toHaveBeenCalled();
    expect(
      harness.runOpenshellSpy.mock.calls.some(([args]) =>
        Array.isArray(args) ? args[0] === "inference" && args[1] === "set" : false,
      ),
    ).toBe(false);
    expect(harness.recoverHermesPortableOllamaInferenceSpy).toHaveBeenCalledOnce();
    expect(harness.recoverPortableDemoLifecycleSpy).toHaveBeenCalled();
  });

  it.each([
    ["runtime driver", { openshellDriver: "podman" }],
    ["live identity", { lifecycleLiveIdentityFingerprint: "0".repeat(64) }],
  ] as const)(
    "rejects initial Hermes registry %s drift before probe mutation (#9203)",
    async (_label, registryEntry) => {
      const harness = createConnectHarness({
        agentName: "hermes",
        sessionAgent: { name: "hermes" },
        registryEntry,
        portableReceiptDisposition: { kind: "hermes", phase: "active" },
        portableRecoveryResult: { kind: "already-running" },
      });

      await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
        "process.exit(1)",
      );
      expect(harness.errorSpy.mock.calls.flat().join("\n")).toContain(
        "missing, incomplete, or changed during launch-readiness verification",
      );
      expect(harness.recoverPortableDemoLifecycleSpy).not.toHaveBeenCalled();
      expect(harness.captureResolvedOpenshellSpy).not.toHaveBeenCalled();
      expect(harness.getSandboxDockerRuntimeSpy).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["absent", { registryEntry: { provider: null, model: null } }],
    [
      "mismatched",
      {
        inferenceGetOutput:
          "Gateway inference:\n  Provider: nvidia-prod\n  Model: nvidia/other-model\n",
      },
    ],
    ["unreachable", { inferenceProbeResponses: ["BROKEN 503"] }],
  ] as const)(
    "rejects a %s schema-5 inference route without mutation (#9203)",
    async (_label, routeOptions) => {
      const harness = createConnectHarness({
        agentName: "hermes",
        sessionAgent: { name: "hermes" },
        registryEntry: {
          openshellDriver: "docker",
          gatewayName: "nemoclaw",
          lifecycleGeneration: "generation-1",
          ...("registryEntry" in routeOptions ? routeOptions.registryEntry : {}),
        },
        portableReceiptDisposition: { kind: "hermes", phase: "active" },
        portableRecoveryResult: { kind: "already-running" },
        ...("inferenceGetOutput" in routeOptions
          ? { inferenceGetOutput: routeOptions.inferenceGetOutput }
          : {}),
        ...("inferenceProbeResponses" in routeOptions
          ? { inferenceProbeResponses: [...routeOptions.inferenceProbeResponses] }
          : {}),
      });

      await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
        "process.exit(1)",
      );
      expect(harness.errorSpy.mock.calls.flat().join("\n")).toContain(
        "Hermes portable inference authority",
      );
      expect(harness.runOpenshellSpy).not.toHaveBeenCalled();
      expect(harness.getSandboxDockerRuntimeSpy).not.toHaveBeenCalled();
    },
  );

  it("rejects schema-5 inference authority that changes during read-only verification (#9203)", async () => {
    const harness = createConnectHarness({
      agentName: "hermes",
      sessionAgent: { name: "hermes" },
      registryEntry: {
        openshellDriver: "docker",
        gatewayName: "nemoclaw",
        lifecycleGeneration: "generation-1",
      },
      portableReceiptDisposition: { kind: "hermes", phase: "active" },
      portableRecoveryResult: { kind: "already-running" },
    });
    harness.captureResolvedOpenshellSpy.mockImplementation(captureInferenceRouteThenDrift(harness));

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );
    expect(harness.errorSpy.mock.calls.flat().join("\n")).toContain("changed during verification");
    expect(harness.runOpenshellSpy).not.toHaveBeenCalled();
  });

  it("rejects live-identity drift during schema-5 route verification (#9203)", async () => {
    const harness = createConnectHarness({
      agentName: "hermes",
      sessionAgent: { name: "hermes" },
      portableReceiptDisposition: { kind: "hermes", phase: "active" },
      portableRecoveryResult: { kind: "already-running" },
    });
    harness.captureResolvedOpenshellSpy.mockImplementation(
      captureInferenceRouteThenDriftLiveIdentity(harness),
    );

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );
    expect(harness.errorSpy.mock.calls.flat().join("\n")).toContain("changed during verification");
    expect(harness.runOpenshellSpy).not.toHaveBeenCalled();
    expect(harness.getSandboxDockerRuntimeSpy).not.toHaveBeenCalled();
  });

  it("keeps active Hermes interactive setup inside receipt-owned recovery (#9203)", async () => {
    vi.stubEnv("NVIDIA_INFERENCE_API_KEY", "do-not-forward");
    vi.stubEnv("GITHUB_TOKEN", "do-not-forward");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "do-not-forward");
    vi.stubEnv("DOCKER_HOST", "unix:///run/docker.sock");
    vi.stubEnv("KUBECONFIG", "/home/test/.kube/config");
    vi.stubEnv("SSH_AUTH_SOCK", "/run/user/1000/ssh-agent.sock");
    vi.stubEnv("HTTPS_PROXY", "https://user:token@proxy.example");
    vi.stubEnv("OPENSHELL_GATEWAY", "ambient");
    const sandboxVersion = requireDist("../../src/lib/sandbox/version.js");
    const broker = requireDist("../../src/lib/hermes-tool-gateway-broker.js");
    const brokerSpy = vi
      .spyOn(broker, "ensureHermesToolGatewayBrokerForSandboxEntry")
      .mockImplementation(() => undefined);
    const harness = createConnectHarness({
      agentName: "hermes",
      sessionAgent: { name: "hermes" },
      registryEntry: {
        openshellDriver: "docker",
        gatewayName: "nemoclaw",
        lifecycleGeneration: "generation-1",
        hermesToolGateways: ["tool-gateway"],
      },
      portableReceiptDisposition: { kind: "hermes", phase: "active" },
      portableRecoveryResult: { kind: "already-running" },
    });

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(0)");

    expect(harness.checkAndRecoverSpy).not.toHaveBeenCalled();
    expect(harness.getSandboxDockerRuntimeSpy).not.toHaveBeenCalled();
    expect(harness.dockerStartSpy).not.toHaveBeenCalled();
    expect(harness.runAutoPairSpy).not.toHaveBeenCalled();
    expect(harness.preflightVllmSpy).not.toHaveBeenCalled();
    expect(harness.readSandboxConfigSpy).not.toHaveBeenCalled();
    expect(harness.writeSandboxConfigSpy).not.toHaveBeenCalled();
    expect(harness.recoverHermesPortableOllamaInferenceSpy).not.toHaveBeenCalled();
    expect(sandboxVersion.checkAgentVersion).not.toHaveBeenCalled();
    expect(brokerSpy).not.toHaveBeenCalled();
    const connectCall = harness.runSandboxExecChildSpy.mock.calls.find(
      ([command, args]) =>
        command === "/usr/bin/openshell" &&
        Array.isArray(args) &&
        args.join("\0") === ["sandbox", "connect", "-g", "nemoclaw", "alpha"].join("\0"),
    );
    expect(connectCall?.[2]).toMatchObject({
      hostEnv: expect.not.objectContaining({
        NVIDIA_INFERENCE_API_KEY: expect.anything(),
        GITHUB_TOKEN: expect.anything(),
        AWS_SECRET_ACCESS_KEY: expect.anything(),
        DOCKER_HOST: expect.anything(),
        KUBECONFIG: expect.anything(),
        SSH_AUTH_SOCK: expect.anything(),
        HTTPS_PROXY: expect.anything(),
        OPENSHELL_GATEWAY: expect.anything(),
      }),
    });
    expect(harness.recoverPortableDemoLifecycleSpy).toHaveBeenCalledTimes(5);
  });

  it("rejects external Hermes authority drift at the final connect boundary (#9203)", async () => {
    const harness = createConnectHarness({
      agentName: "hermes",
      sessionAgent: { name: "hermes" },
      registryEntry: {
        openshellDriver: "docker",
        gatewayName: "nemoclaw",
        lifecycleGeneration: "generation-1",
      },
      portableReceiptDisposition: { kind: "hermes", phase: "active" },
      portableRecoveryResult: { kind: "already-running" },
    });
    harness.recoverPortableDemoLifecycleSpy.mockImplementation(() =>
      harness.recoverPortableDemoLifecycleSpy.mock.calls.length >= 5
        ? { kind: "not-installed" }
        : { kind: "already-running" },
    );

    await expect(harness.connectSandbox("alpha")).rejects.toThrow(
      "lifecycle authority disappeared before interactive connect",
    );
    expect(
      harness.runSandboxExecChildSpy.mock.calls.some(
        ([, args]) => Array.isArray(args) && args[0] === "sandbox" && args[1] === "connect",
      ),
    ).toBe(false);
  });

  it("fails before Docker when Hermes receipt authority disappears during probe (#9203)", async () => {
    const harness = createConnectHarness({
      agentName: "hermes",
      sessionAgent: { name: "hermes" },
      registryEntry: {
        openshellDriver: "docker",
        gatewayName: "nemoclaw",
        lifecycleGeneration: "generation-1",
      },
      portableReceiptDisposition: { kind: "hermes", phase: "active" },
      portableRecoveryResult: { kind: "already-running" },
    });
    harness.inspectPortableReceiptDispositionSpy
      .mockReturnValueOnce({
        kind: "hermes",
        phase: "active",
        gatewayName: "nemoclaw",
        lifecycleGeneration: "generation-1",
        liveIdentityFingerprint: "f".repeat(64),
      })
      .mockReturnValue({ kind: "absent" });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );
    expect(harness.errorSpy.mock.calls.flat().join("\n")).toContain(
      "missing, incomplete, or changed during launch-readiness verification",
    );
    expect(harness.getSandboxDockerRuntimeSpy).not.toHaveBeenCalled();
    expect(harness.dockerStartSpy).not.toHaveBeenCalled();
    expect(harness.checkAndRecoverSpy).not.toHaveBeenCalled();
  });

  it.each(["pending", "configuring"] as const)(
    "rejects incomplete Hermes %s receipt before connect mutation (#9203)",
    async (phase) => {
      const harness = createConnectHarness({
        agentName: "hermes",
        registryEntry: { openshellDriver: "docker" },
        portableReceiptDisposition: { kind: "hermes", phase },
      });
      harness.recoverPortableDemoLifecycleSpy.mockImplementation(() => {
        throw new Error(`phase '${phase}' is incomplete`);
      });

      await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
        "process.exit(1)",
      );
      expect(harness.getSandboxDockerRuntimeSpy).not.toHaveBeenCalled();
      expect(harness.dockerStartSpy).not.toHaveBeenCalled();
      expect(harness.checkAndRecoverSpy).not.toHaveBeenCalled();
    },
  );
  it("does not suggest a manual forward when gateway recovery fails before forward start", async () => {
    const harness = createConnectHarness({
      processCheck: {
        checked: true,
        wasRunning: false,
        recovered: false,
        forwardRecovered: false,
        recoveryFailureDetail:
          "the replacement container identity changed during the final managed supervisor health check",
      },
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    const errorOutput = harness.errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(errorOutput).toContain("NemoClaw could not recover the OpenClaw gateway in 'alpha'");
    expect(errorOutput).toContain(
      "the replacement container identity changed during the final managed supervisor health check",
    );
    expect(errorOutput).not.toContain("gateway is running");
    expect(errorOutput).not.toContain("openshell forward start");
    expect(harness.runAutoPairSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it.each([
    {
      condition: "a Docker final-handoff failure",
      expectedDetail:
        "Docker could not start the replacement container to complete the final recovery handoff",
      recoveryFailureDetail:
        "Docker could not start the replacement container to complete the final recovery handoff",
    },
    {
      condition: "a pinned replacement identity failure",
      expectedDetail:
        "the replacement container identity changed during the final managed supervisor health check",
      recoveryFailureDetail:
        "the replacement container identity changed during the final managed supervisor health check",
    },
    {
      condition: "an OpenShell readiness failure",
      expectedDetail: "the replacement container did not become ready in OpenShell",
      recoveryFailureDetail:
        "the replacement container did not become ready in OpenShell\nAuthorization: Bearer opaque-connect-recovery-token\u001b[31m",
    },
    {
      condition: "an unconfirmed rollback after a gateway wait failure",
      expectedDetail: "NemoClaw could not confirm rollback to the previous sandbox container",
      recoveryFailureDetail:
        "NemoClaw could not confirm rollback to the previous sandbox container. Inspect Docker state before retrying. Recovery failure before rollback: the recovered gateway did not become responsive before the recovery timeout",
    },
    {
      condition: "a detail-free recovery failure",
      expectedDetail: "the gateway recovery attempt did not complete",
      recoveryFailureDetail: undefined,
    },
  ])(
    "stops non-probe connect before route repair, pairing, or SSH after $condition (#9364)",
    async ({ expectedDetail, recoveryFailureDetail }) => {
      const harness = createConnectHarness({
        registryEntry: { model: "qwen3-vl:4b", provider: "ollama-local" },
        processCheck: {
          checked: true,
          wasRunning: false,
          recovered: false,
          forwardRecovered: false,
          recoveryFailureDetail,
        },
      });

      await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(1)");

      const errorOutput = harness.errorSpy.mock.calls
        .map((call) => String(call[0] ?? ""))
        .join("\n");
      expect(errorOutput).toContain(
        "Recovery failed: NemoClaw could not recover the OpenClaw gateway in 'alpha'",
      );
      expect(errorOutput).toContain(expectedDetail);
      expect(errorOutput).not.toContain("opaque-connect-recovery-token");
      expect(errorOutput).not.toContain("\u001b");
      expect(harness.ensureOllamaAuthProxySpy).not.toHaveBeenCalled();
      expect(harness.findReachableOllamaHostSpy).not.toHaveBeenCalled();
      expect(harness.withGatewayRouteMutationLockSpy).not.toHaveBeenCalled();
      expect(harness.settlePortablePairingSpy).not.toHaveBeenCalled();
      expect(harness.runAutoPairSpy).not.toHaveBeenCalled();
      expect(harness.spawnSyncSpy).not.toHaveBeenCalledWith(
        "openshell",
        ["sandbox", "connect", "alpha"],
        expect.any(Object),
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    },
  );

  it("redacts untrusted gateway recovery details before reporting them", async () => {
    const opaqueToken = "opaque-gateway-recovery-token";
    const harness = createConnectHarness({
      processCheck: {
        checked: true,
        wasRunning: false,
        recovered: false,
        forwardRecovered: false,
        recoveryFailureDetail: `OpenShell failed\nAuthorization: Bearer ${opaqueToken}\u001b[31m`,
      },
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    const errorOutput = harness.errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(errorOutput).toContain("Recovery detail:");
    expect(errorOutput).not.toContain(opaqueToken);
    expect(errorOutput).not.toContain("\u001b");
    expect(errorOutput).toMatch(/Recovery detail: .*\.$/mu);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("keeps a direct recovery failure detail separate from an earlier callback layer", () => {
    const harness = createConnectHarness();
    harness.checkAndRecoverSpy.mockImplementation(
      (
        _sandboxName: string,
        options?: {
          onRecoveryFailureLayer?: (layer: string, detail?: string) => void;
        },
      ) => {
        options?.onRecoveryFailureLayer?.("supervisor not running", "SUPERVISOR_NOT_RUNNING");
        return {
          checked: true,
          wasRunning: false,
          recovered: false,
          forwardRecovered: false,
          recoveryFailureDetail:
            "the managed supervisor health check for the recreated sandbox did not pass",
        };
      },
    );

    expect(harness.restoreSandboxStartupState("alpha")).toMatchObject({
      recoveryFailureDetail:
        "the managed supervisor health check for the recreated sandbox did not pass",
      recoveryFailureLayer: null,
    });
  });
});
