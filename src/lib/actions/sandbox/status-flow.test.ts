// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import type { ProviderHealthStatus } from "../../inference/health";
import type { SandboxGatewayState } from "./gateway-state";
import type { SandboxStatusPreflightResult } from "./status-preflight";

type ShowSandboxStatus = typeof import("./status")["showSandboxStatus"];

const requireDist = createRequire(import.meta.url);
const statusModulePath = "./status.js";

// Warm the CommonJS source graph outside the first test's timeout. Each harness
// still reloads the entry module after installing its dependency spies.
requireDist(statusModulePath);
delete require.cache[requireDist.resolve(statusModulePath)];

type StatusFlowHarness = {
  checkAgentVersionSpy: MockInstance;
  collectSandboxStatusSnapshotSpy: MockInstance;
  getActiveSandboxSessionsSpy: MockInstance;
  getSandboxDockerRuntimeSpy: MockInstance;
  logSpy: MockInstance;
  removeSandboxSpy: MockInstance;
  showSandboxStatus: ShowSandboxStatus;
};

type StatusFlowHarnessOptions = {
  currentModel?: string;
  currentProvider?: string;
  inferenceHealth?: ProviderHealthStatus | null;
  lookup?: SandboxGatewayState;
  lookupState?: "present" | "missing";
  preflight?: SandboxStatusPreflightResult;
  processRunning?: boolean | null;
  sandboxEntry?: Partial<Omit<typeof baseSandboxEntry, "agentVersion">> & {
    agent?: string | null;
    agentVersion?: string | null;
  };
  shieldsPosture?: {
    mode: "locked" | "mutable_default" | "mutable";
    detail: string;
  };
  versionCheck?: {
    sandboxVersion?: string | null;
    expectedVersion?: string | null;
    isStale: boolean;
    detectionMethod?: string;
    schemeMismatch?: boolean;
    verificationFailed?: boolean;
  };
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

function createStatusFlowHarness(options: StatusFlowHarnessOptions = {}) {
  delete require.cache[requireDist.resolve(statusModulePath)];

  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);

  const statusPreflight = requireDist("./status-preflight.js");
  const statusSnapshot = requireDist("./status-snapshot.js");
  const dockerHealth = requireDist("./docker-health.js");
  const processRecovery = requireDist("./process-recovery.js");
  const resolve = requireDist("../../adapters/openshell/resolve.js");
  const agentRuntime = requireDist("../../agent/runtime.js");
  const nim = requireDist("../../inference/nim.js");
  const sandboxVersion = requireDist("../../sandbox/version.js");
  const shields = requireDist("../../shields/index.js");
  const registry = requireDist("../../state/registry.js");
  const sandboxSession = requireDist("../../state/sandbox-session.js");

  const lookup: SandboxGatewayState =
    options.lookup ??
    (options.lookupState === "missing"
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
        });

  const sandboxEntry = { ...baseSandboxEntry, ...options.sandboxEntry };

  vi.spyOn(registry, "getSandbox").mockReturnValue(sandboxEntry);
  const removeSandboxSpy = vi.spyOn(registry, "removeSandbox").mockImplementation(() => undefined);
  vi.spyOn(statusPreflight, "getSandboxStatusPreflight").mockResolvedValue(
    options.preflight ?? {
      failure: null,
      failureLayer: null,
      suppressInferenceProbe: false,
      exitCode: 0,
    },
  );
  const collectSandboxStatusSnapshotSpy = vi
    .spyOn(statusSnapshot, "collectSandboxStatusSnapshot")
    .mockResolvedValue({
      sb: sandboxEntry,
      lookup,
      rpcIssue: null,
      currentModel: options.currentModel ?? "nvidia/nemotron-live",
      currentProvider: options.currentProvider ?? "ollama-local",
      inferenceHealth:
        options.inferenceHealth === undefined
          ? {
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
            }
          : options.inferenceHealth,
    });
  const getSandboxDockerRuntimeSpy = vi
    .spyOn(dockerHealth, "getSandboxDockerRuntime")
    .mockReturnValue({
      containerName: "openshell-alpha",
      health: "unhealthy",
      paused: false,
    });
  vi.spyOn(processRecovery, "isSandboxGatewayRunningForStatus").mockResolvedValue(
    options.processRunning ?? false,
  );
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
  const checkAgentVersionSpy = vi.spyOn(sandboxVersion, "checkAgentVersion").mockReturnValue(
    options.versionCheck ?? {
      sandboxVersion: "0.1.0",
      expectedVersion: "0.2.0",
      isStale: true,
      detectionMethod: "runtime",
    },
  );
  vi.spyOn(shields, "getShieldsPosture").mockReturnValue(
    options.shieldsPosture ?? {
      mode: "mutable_default",
      detail: "mutable default",
    },
  );
  const getActiveSandboxSessionsSpy = vi
    .spyOn(sandboxSession, "getActiveSandboxSessions")
    .mockReturnValue({
      detected: true,
      sessions: [{ pid: 1 }, { pid: 2 }],
    });

  logSpy.mockClear();

  return {
    checkAgentVersionSpy,
    collectSandboxStatusSnapshotSpy,
    getActiveSandboxSessionsSpy,
    getSandboxDockerRuntimeSpy,
    logSpy,
    removeSandboxSpy,
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
    expect(output).toContain("Sandbox-scoped status for 'alpha'");
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
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
    expect(harness.getSandboxDockerRuntimeSpy).not.toHaveBeenCalled();
  });

  it("prints switch guidance without removing registry state for a wrong active gateway (#2276)", async () => {
    const harness = createStatusFlowHarness({
      inferenceHealth: null,
      lookup: {
        state: "wrong_gateway_active",
        activeGateway: "openshell",
        output: "Gateway: openshell\nStatus: Connected",
      },
    });

    await expect(harness.showSandboxStatus("alpha")).rejects.toThrow("process.exit(1)");

    const output = harness.logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Your sandbox has NOT been removed");
    expect(output).toContain("openshell gateway select nemoclaw");
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
  });

  it("renders a local Ollama outage with the backend endpoint and recovery hint", async () => {
    const harness = createStatusFlowHarness({
      currentModel: "llama3.2:1b",
      currentProvider: "ollama-local",
      inferenceHealth: {
        ok: false,
        probed: true,
        providerLabel: "Ollama",
        endpoint: "http://127.0.0.1:11434/api/tags",
        detail: "Start Ollama and retry",
        probeLabel: "ollama backend",
        failureLabel: "unreachable",
      },
      sandboxEntry: {
        model: "llama3.2:1b",
        provider: "ollama-local",
      },
    });

    await expect(harness.showSandboxStatus("alpha")).resolves.toBeUndefined();

    const output = harness.logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Inference (ollama backend):");
    expect(output).toContain("unreachable");
    expect(output).toContain("Start Ollama and retry");
    expect(output).toContain("http://127.0.0.1:11434/api/tags");
  });

  it("renders fresh shields posture as not configured rather than down", async () => {
    const harness = createStatusFlowHarness({
      shieldsPosture: {
        mode: "mutable_default",
        detail: "not configured (default mutable state)",
      },
    });

    await expect(harness.showSandboxStatus("alpha")).resolves.toBeUndefined();

    const output = harness.logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Permissions: not configured (default mutable state)");
    expect(output).not.toContain("Permissions: shields down");
  });

  it("renders the live agent version instead of stale registry metadata", async () => {
    const harness = createStatusFlowHarness({
      sandboxEntry: { agentVersion: "2026.5.18" },
      versionCheck: {
        sandboxVersion: "2026.3.11",
        expectedVersion: "2026.6.1",
        isStale: true,
        detectionMethod: "runtime",
      },
    });

    await expect(harness.showSandboxStatus("alpha")).resolves.toBeUndefined();

    const output = harness.logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Agent:    OpenClaw v2026.3.11");
    expect(output).toContain("Update:");
    expect(output).toContain("v2026.6.1 available");
    expect(output).toContain("Run `nemoclaw alpha rebuild` to upgrade");
    expect(output).not.toContain("Agent:    OpenClaw v2026.5.18");
    expect(harness.checkAgentVersionSpy).toHaveBeenCalledWith("alpha", {
      forceProbe: true,
      skipProbe: false,
    });
  });

  it("does not report inference healthy when gateway verification fails", async () => {
    const harness = createStatusFlowHarness({
      inferenceHealth: null,
      lookup: {
        state: "gateway_unreachable_after_restart",
        output: "Gateway: nemoclaw\nclient error (Connect): Connection refused (os error 111)",
      },
      preflight: {
        failure: null,
        failureLayer: "docker_unreachable",
        suppressInferenceProbe: true,
        exitCode: 1,
      },
    });

    await expect(harness.showSandboxStatus("alpha")).rejects.toThrow("process.exit(1)");

    const output = harness.logSpy.mock.calls.flat().join("\n");
    expect(output).not.toContain("Inference: healthy");
    expect(output).toContain("Inference: not verified (gateway/sandbox state not verified)");
    expect(output).toContain("gateway is still refusing connections after restart");
    expect(output).toContain("Retry `openshell gateway start --name nemoclaw`");
    expect(output).toContain("If the gateway never becomes healthy");
    expect(harness.collectSandboxStatusSnapshotSpy).toHaveBeenCalledWith("alpha", {
      suppressInferenceProbe: true,
    });
  });

  it("renders missing gateway metadata after restart without claiming recovery", async () => {
    const harness = createStatusFlowHarness({
      inferenceHealth: null,
      lookup: {
        state: "gateway_missing_after_restart",
        output: "Status: No gateway configured.",
      },
      preflight: {
        failure: null,
        failureLayer: "docker_unreachable",
        suppressInferenceProbe: true,
        exitCode: 1,
      },
    });

    await expect(harness.showSandboxStatus("alpha")).rejects.toThrow("process.exit(1)");

    const output = harness.logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("gateway is no longer configured after restart/rebuild");
    expect(output).toContain("Start the gateway again");
    expect(output).not.toContain("Recovered NemoClaw gateway runtime");
  });

  it("renders gateway identity drift as an unsafe reattachment", async () => {
    const harness = createStatusFlowHarness({
      inferenceHealth: null,
      lookup: {
        state: "identity_drift",
        output: "Error: transport error: handshake verification failed",
      },
    });

    await expect(harness.showSandboxStatus("alpha")).rejects.toThrow("process.exit(1)");

    const output = harness.logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("gateway trust material rotated after restart");
    expect(output).toContain("cannot be reattached safely");
    expect(output).not.toContain("Inference: healthy");
  });

  it("keeps a failed foreign-gateway lookup distinct from recovered status", async () => {
    const harness = createStatusFlowHarness({
      inferenceHealth: null,
      lookup: {
        state: "gateway_error",
        output: "Error: transport error: Connection refused",
      },
      preflight: {
        failure: null,
        failureLayer: "docker_unreachable",
        suppressInferenceProbe: true,
        exitCode: 1,
      },
    });

    await expect(harness.showSandboxStatus("alpha")).rejects.toThrow("process.exit(1)");

    const output = harness.logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Could not verify sandbox 'alpha'");
    expect(output).toContain("verify the active gateway");
    expect(output).not.toContain("Recovered NemoClaw gateway runtime");
  });

  it("renders gateway-level handshake failures without removing registry state", async () => {
    const harness = createStatusFlowHarness({
      inferenceHealth: null,
      lookup: {
        state: "gateway_error",
        output: "Error: transport error: handshake verification failed",
      },
      preflight: {
        failure: null,
        failureLayer: "docker_unreachable",
        suppressInferenceProbe: true,
        exitCode: 1,
      },
    });

    await expect(harness.showSandboxStatus("alpha")).rejects.toThrow("process.exit(1)");

    const output = harness.logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("Could not verify sandbox 'alpha'");
    expect(output).toContain("gateway identity drift after restart");
    expect(harness.removeSandboxSpy).not.toHaveBeenCalled();
  });
});
