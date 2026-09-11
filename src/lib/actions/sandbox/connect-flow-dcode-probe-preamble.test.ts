// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import {
  connectModulePath,
  createConnectHarness,
  requireDist,
} from "../../../../test/support/connect-flow-test-harness";
import {
  DCODE_MANAGED_EXEC_LAUNCHER,
  DCODE_MANAGED_EXEC_MISSING_DETAIL,
} from "./connect-inference-route-probe";

describe("connectSandbox DCode probe preamble boundary", () => {
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
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: originalStdoutIsTty,
    });
    delete process.env.NEMOCLAW_TEST_NO_SLEEP;
    delete require.cache[requireDist.resolve(connectModulePath)];
  });

  it("does not run an uncached version command before refusing a broken DeepAgents route (#11520)", async () => {
    const harness = createConnectHarness({
      agentName: "langchain-deepagents-code",
      sessionAgent: { name: "langchain-deepagents-code" },
      inferenceProbeResponses: ["probe unavailable"],
    });
    const version = requireDist(
      "../../src/lib/sandbox/version.js",
    ) as typeof import("../../sandbox/version");
    const ssh = requireDist(
      "../../src/lib/adapters/openshell/sandbox-ssh-cli.js",
    ) as typeof import("../../adapters/openshell/sandbox-ssh-cli");
    vi.mocked(version.checkAgentVersion).mockRestore();
    const run = vi.fn(async () => ({
      kind: "completed" as const,
      exitCode: 0,
      stdout: "0.1.12",
      stderr: "",
    }));
    vi.spyOn(ssh, "createCliOpenShellSandboxSshExecutor").mockReturnValue({ run });

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(1)");

    expect(run).not.toHaveBeenCalled();
    expect(harness.startSandboxSessionSpy).not.toHaveBeenCalled();
    expect(harness.registryUpdateSpy).not.toHaveBeenCalled();
    await version.checkAgentVersion("alpha");
    expect(run).toHaveBeenCalledOnce();
  });

  it.each([
    ["rejected inference", { status: 1, output: "503\n", stderr: "" }],
    ["forged success", { status: 0, output: "OK 200", stderr: "" }],
    ["unavailable transport", { status: null, output: "", stderr: "" }],
  ])(
    "refuses a session after models discovery succeeds but %s follows (#11520)",
    async (_reason, response) => {
      const harness = createConnectHarness({
        agentName: "langchain-deepagents-code",
        registryEntry: {
          provider: "nvidia-prod",
          model: "nvidia/nemotron-3-super-120b-a12b",
        },
        inferenceGetOutput: "Provider: nvidia-prod\nModel: nvidia/nemotron-3-super-120b-a12b\n",
        sessionAgent: { name: "langchain-deepagents-code" },
      });
      const runBuffered = harness.sandboxRunBufferedSpy.getMockImplementation()!;
      harness.sandboxRunBufferedSpy.mockImplementation(async (request) =>
        request.command.join(" ").includes("/v1/chat/completions")
          ? {
              outcome:
                response.status === null
                  ? { kind: "failed", error: { kind: "capture", message: "unavailable" } }
                  : { kind: "completed", exitCode: response.status },
              stdout: response.output,
              stderr: response.stderr,
            }
          : runBuffered(request),
      );

      await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(1)");

      expect(harness.startSandboxSessionSpy).not.toHaveBeenCalled();
      expect(harness.runAutoPairSpy).not.toHaveBeenCalled();
      expect(harness.errorSpy.mock.calls.flat().join("\n")).toContain("inference request");
    },
  );

  it.each([{ provider: null }, { model: null }])(
    "refuses a DeepAgents session with incomplete route metadata %j (#11520)",
    async (missing) => {
      const harness = createConnectHarness({
        agentName: "langchain-deepagents-code",
        sessionAgent: { name: "langchain-deepagents-code" },
        registryEntry: { provider: "nvidia-prod", model: "nvidia/nemotron", ...missing },
      });

      await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(1)");

      expect(harness.startSandboxSessionSpy).not.toHaveBeenCalled();
      expect(harness.sandboxRunBufferedSpy).not.toHaveBeenCalled();
    },
  );

  it.each(["OK 200\nBROKEN 000", "BROKEN 503\nOK 200"])(
    "rejects login-shell preamble evidence without repair or SSH (%s) (#6192)",
    async (output) => {
      const harness = createConnectHarness({
        agentName: "langchain-deepagents-code",
        registryEntry: {
          provider: "nvidia-prod",
          model: "nvidia/nemotron-3-super-120b-a12b",
        },
        inferenceGetOutput:
          "Gateway inference:\n  Provider: nvidia-prod\n  Model: nvidia/nemotron-3-super-120b-a12b\n",
        inferenceProbeResponses: [output],
        sessionAgent: { name: "langchain-deepagents-code" },
      });

      await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(1)");

      expect(harness.applyVmDnsMonkeypatchSpy).not.toHaveBeenCalled();
      expect(harness.runSetupDnsProxySpy).not.toHaveBeenCalled();
      expect(harness.runOpenshellSpy).not.toHaveBeenCalled();
      expect(harness.spawnSyncSpy).not.toHaveBeenCalled();
      expect(harness.errorSpy.mock.calls.flat().join("\n")).toContain(
        "did not return a trusted result",
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    },
  );

  it("rejects spoofed stdout when a DCode startup file emits stderr (#6192)", async () => {
    const harness = createConnectHarness({
      agentName: "langchain-deepagents-code",
      registryEntry: {
        provider: "nvidia-prod",
        model: "nvidia/nemotron-3-super-120b-a12b",
      },
      inferenceGetOutput:
        "Gateway inference:\n  Provider: nvidia-prod\n  Model: nvidia/nemotron-3-super-120b-a12b\n",
      inferenceProbeResponses: [
        {
          status: 0,
          output: "OK 200",
          stderr: "/sandbox/.bash_profile: line 1: 3: Bad file descriptor\n",
        },
      ],
      sessionAgent: { name: "langchain-deepagents-code" },
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
    expect(errorOutput).toContain("/sandbox/.bash_profile");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("fails closed with rebuild guidance when a DCode sandbox lacks the trusted helper (#6192)", async () => {
    const harness = createConnectHarness({
      agentName: "langchain-deepagents-code",
      registryEntry: {
        provider: "nvidia-prod",
        model: "nvidia/nemotron-3-super-120b-a12b",
      },
      inferenceGetOutput:
        "Gateway inference:\n  Provider: nvidia-prod\n  Model: nvidia/nemotron-3-super-120b-a12b\n",
      inferenceProbeResponses: [`exec: ${DCODE_MANAGED_EXEC_LAUNCHER}: not found`],
      sessionAgent: { name: "langchain-deepagents-code" },
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
    expect(errorOutput).toContain(DCODE_MANAGED_EXEC_MISSING_DETAIL);
    expect(errorOutput).toContain("sandbox inference route is not known healthy");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
