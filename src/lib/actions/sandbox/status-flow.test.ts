// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

type ShowSandboxStatus =
  typeof import("../../../../dist/lib/actions/sandbox/status")["showSandboxStatus"];

const requireDist = createRequire(import.meta.url);
const statusModulePath = "../../../../dist/lib/actions/sandbox/status.js";

type StatusFlowHarness = {
  checkAgentVersionSpy: MockInstance;
  getActiveSandboxSessionsSpy: MockInstance;
  getSandboxDockerRuntimeSpy: MockInstance;
  logSpy: MockInstance;
  showSandboxStatus: ShowSandboxStatus;
};

const baseSandboxEntry = {
  name: "alpha",
  model: "nvidia/nemotron",
  provider: "ollama-local",
  policies: ["npm", "telegram"],
  hostGpuDetected: true,
  gpuEnabled: true,
  sandboxGpuEnabled: true,
  sandboxGpuMode: "auto",
  sandboxGpuDevice: "all",
  sandboxGpuProof: {
    status: "failed",
    label: "cuInit",
    detail: "CUDA initialization failed",
  },
  openshellDriver: "docker",
  openshellVersion: "0.1.2",
  dashboardPort: 18789,
  agentVersion: "0.1.0",
};

function createStatusFlowHarness(
  options: {
    lookupState?: "present" | "missing";
    sandboxEntry?: Partial<Omit<typeof baseSandboxEntry, "agentVersion">> & {
      agent?: string | null;
      agentVersion?: string | null;
    };
  } = {},
) {
  delete require.cache[requireDist.resolve(statusModulePath)];

  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);

  const statusPreflight = requireDist("../../../../dist/lib/actions/sandbox/status-preflight.js");
  const statusSnapshot = requireDist("../../../../dist/lib/actions/sandbox/status-snapshot.js");
  const dockerHealth = requireDist("../../../../dist/lib/actions/sandbox/docker-health.js");
  const processRecovery = requireDist("../../../../dist/lib/actions/sandbox/process-recovery.js");
  const resolve = requireDist("../../../../dist/lib/adapters/openshell/resolve.js");
  const agentRuntime = requireDist("../../../../dist/lib/agent/runtime.js");
  const nim = requireDist("../../../../dist/lib/inference/nim.js");
  const sandboxVersion = requireDist("../../../../dist/lib/sandbox/version.js");
  const shields = requireDist("../../../../dist/lib/shields/index.js");
  const registry = requireDist("../../../../dist/lib/state/registry.js");
  const sandboxSession = requireDist("../../../../dist/lib/state/sandbox-session.js");

  const lookup =
    options.lookupState === "missing"
      ? {
          state: "missing",
          output: "sandbox alpha not found",
          recoveredGateway: true,
          recoveryVia: "gateway reattach",
        }
      : {
          state: "present",
          output: "Name: alpha\nPhase: Ready\nEndpoint: http://127.0.0.1:18789\n",
          recoveredGateway: true,
          recoveryVia: "gateway reattach",
          recoveredSandbox: true,
          recoverySandboxVia: "docker unpause",
        };

  const sandboxEntry = { ...baseSandboxEntry, ...options.sandboxEntry };

  vi.spyOn(registry, "getSandbox").mockReturnValue(sandboxEntry);
  vi.spyOn(statusPreflight, "getSandboxStatusPreflight").mockResolvedValue({
    failure: null,
    failureLayer: null,
    suppressInferenceProbe: false,
    exitCode: 0,
  });
  vi.spyOn(statusSnapshot, "collectSandboxStatusSnapshot").mockResolvedValue({
    sb: sandboxEntry,
    lookup,
    rpcIssue: null,
    currentModel: "nvidia/nemotron-live",
    currentProvider: "ollama-local",
    inferenceHealth: {
      ok: true,
      probed: true,
      providerLabel: "Ollama",
      endpoint: "http://127.0.0.1:11434/v1/chat/completions",
      detail: "chat completions probe passed",
      subprobes: [
        {
          ok: false,
          probed: true,
          providerLabel: "Inference gateway chain",
          endpoint: "http://127.0.0.1:19000/v1/chat/completions",
          detail: "gateway refused connection",
          probeLabel: "gateway",
          failureLabel: "unreachable",
        },
      ],
    },
  });
  const getSandboxDockerRuntimeSpy = vi
    .spyOn(dockerHealth, "getSandboxDockerRuntime")
    .mockReturnValue({
      containerName: "openshell-alpha",
      health: "unhealthy",
      paused: false,
    });
  vi.spyOn(processRecovery, "isSandboxGatewayRunningForStatus").mockResolvedValue(false);
  vi.spyOn(resolve, "resolveOpenshell").mockReturnValue("/usr/bin/openshell");
  vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({ name: "openclaw" });
  vi.spyOn(agentRuntime, "getAgentDisplayName").mockReturnValue("OpenClaw");
  vi.spyOn(agentRuntime, "getGatewayCommand").mockReturnValue("openclaw daemon");
  vi.spyOn(nim, "nimStatus").mockReturnValue({
    running: true,
    healthy: false,
    container: "alpha-nim",
  });
  vi.spyOn(nim, "nimStatusByName").mockReturnValue({
    running: false,
    healthy: false,
    container: null,
  });
  vi.spyOn(nim, "shouldShowNimLine").mockReturnValue(true);
  const checkAgentVersionSpy = vi.spyOn(sandboxVersion, "checkAgentVersion").mockReturnValue({
    sandboxVersion: "0.1.0",
    expectedVersion: "0.2.0",
    isStale: true,
    detectionMethod: "runtime",
  });
  vi.spyOn(shields, "getShieldsPosture").mockReturnValue({
    mode: "mutable_default",
    detail: "mutable default",
  });
  const getActiveSandboxSessionsSpy = vi
    .spyOn(sandboxSession, "getActiveSandboxSessions")
    .mockReturnValue({
      detected: true,
      sessions: [{ pid: 1 }, { pid: 2 }],
    });

  logSpy.mockClear();

  return {
    checkAgentVersionSpy,
    getActiveSandboxSessionsSpy,
    getSandboxDockerRuntimeSpy,
    logSpy,
    showSandboxStatus: requireDist(statusModulePath).showSandboxStatus,
  } satisfies StatusFlowHarness;
}

describe("showSandboxStatus flow", () => {
  let exitSpy: MockInstance;

  beforeEach(() => {
    process.exitCode = undefined;
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    delete require.cache[requireDist.resolve(statusModulePath)];
  });

  it("prints the live sandbox, inference, runtime, session, version, and recovery signals", async () => {
    const harness = createStatusFlowHarness();

    await expect(harness.showSandboxStatus("alpha")).resolves.toBeUndefined();

    const output = harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("Sandbox: alpha");
    expect(output).toContain("Model:    nvidia/nemotron-live");
    expect(output).toContain("Inference: healthy");
    expect(output).toContain("Inference (gateway):");
    expect(output).toContain("Host GPU: yes");
    expect(output).toContain("last CUDA proof failed: cuInit");
    expect(output).toContain("CUDA initialization failed");
    expect(output).toContain("Connected:");
    expect(output).toContain("2 sessions");
    expect(output).toContain("Permissions: mutable default");
    expect(output).toContain("Update:");
    expect(output).toContain("Recovered NemoClaw gateway runtime via gateway reattach.");
    expect(output).toContain("Recovered sandbox 'alpha' from Docker via docker unpause");
    expect(output).toContain("OpenClaw: ");
    expect(output).toContain("not running");
    expect(output).toContain("Docker health:");
    expect(output).toContain("unhealthy");
    expect(output).toContain("NIM:      running (alpha-nim)");
    expect(harness.getActiveSandboxSessionsSpy).toHaveBeenCalledWith("alpha", expect.any(Object));
    expect(harness.getSandboxDockerRuntimeSpy).toHaveBeenCalledWith("alpha");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("probes terminal runtime agent version when cached metadata is missing", async () => {
    const harness = createStatusFlowHarness({
      sandboxEntry: {
        agent: "langchain-deepagents-code",
        agentVersion: null,
      },
    });

    await expect(harness.showSandboxStatus("alpha")).resolves.toBeUndefined();

    const output = harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("Harness:  LangChain Deep Agents Code (terminal)");
    expect(output).toContain("Agent:    LangChain Deep Agents Code v0.1.0");
    expect(output).toContain("Update:");
    expect(output).toContain("Run `nemoclaw alpha rebuild` to upgrade");
    expect(harness.checkAgentVersionSpy).toHaveBeenCalledWith("alpha", {
      forceProbe: true,
      skipProbe: false,
    });
  });

  it("preserves the registry entry and exits when the live gateway is missing the sandbox", async () => {
    const harness = createStatusFlowHarness({ lookupState: "missing" });

    await expect(harness.showSandboxStatus("alpha")).rejects.toThrow("process.exit(1)");

    const output = harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain(
      "registered locally, but is not present in the live OpenShell gateway",
    );
    expect(output).toContain("gateway was just recovered via gateway reattach");
    expect(output).toContain("No local registry entry was removed by this status check");
    expect(output).toContain("nemoclaw alpha status");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(harness.getSandboxDockerRuntimeSpy).not.toHaveBeenCalled();
  });
});
