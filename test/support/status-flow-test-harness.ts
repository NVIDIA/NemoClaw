// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { type MockInstance, vi } from "vitest";

import type { SandboxGatewayState } from "../../src/lib/actions/sandbox/gateway-state";
import type { SandboxStatusPreflightResult } from "../../src/lib/actions/sandbox/status-preflight";
import type {
  SandboxStatusRouteDrift,
  ServingProcessHealth,
} from "../../src/lib/actions/sandbox/status-snapshot";
import type { ProviderHealthStatus } from "../../src/lib/inference/health";
import type { SandboxHostMount } from "../../src/lib/state/registry";

type ShowSandboxStatus =
  (typeof import("../../src/lib/actions/sandbox/status"))["showSandboxStatus"];
type GetSandboxStatusReport =
  (typeof import("../../src/lib/actions/sandbox/status"))["getSandboxStatusReport"];
type PortableAgentReceiptDisposition = ReturnType<
  (typeof import("../../src/lib/onboard/experimental/portable-agent-lifecycle"))["inspectPortableAgentReceiptDisposition"]
>;
type WithMcpLifecycleLock =
  (typeof import("../../src/lib/state/mcp-lifecycle-lock-acquisition"))["withMcpLifecycleLock"];

const requireDist = createRequire(import.meta.url);
const statusModulePath = "../../src/lib/actions/sandbox/status.js";

// Warm the CommonJS source graph outside the first test's timeout. Each harness
// still reloads the entry module after installing its dependency spies.
requireDist(statusModulePath);
delete require.cache[requireDist.resolve(statusModulePath)];

export type StatusFlowHarness = {
  checkAgentVersionSpy: MockInstance;
  collectSandboxStatusSnapshotSpy: MockInstance;
  getActiveSandboxSessionsSpy: MockInstance;
  getSandboxDockerRuntimeSpy: MockInstance;
  getSandboxStatusReport: GetSandboxStatusReport;
  qualifyPortableAgentLifecycleAuthoritySpy: MockInstance;
  isSandboxGatewayRunningForStatusSpy: MockInstance;
  logSpy: MockInstance;
  removeSandboxSpy: MockInstance;
  showSandboxStatus: ShowSandboxStatus;
  withMcpLifecycleLockSpy: MockInstance;
};

const baseSandboxEntry = {
  name: "alpha",
  model: "nvidia/nemotron",
  provider: "ollama-local",
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
  gatewayName: "nemoclaw",
  lifecycleGeneration: "generation-1",
  lifecycleLiveIdentityFingerprint: "fingerprint-1",
  dashboardPort: 18789,
  agentVersion: "0.1.0",
};

export type StatusFlowHarnessOptions = {
  currentModel?: string;
  currentProvider?: string;
  gatewayPresets?: string[] | null;
  routeDrift?: SandboxStatusRouteDrift | null;
  inferenceHealth?: ProviderHealthStatus | null;
  servingProcessHealth?: ServingProcessHealth | null;
  portableDisposition?:
    | PortableAgentReceiptDisposition
    | Error
    | (() => PortableAgentReceiptDisposition | Error);
  registryEntry?: "present" | "missing";
  withMcpLifecycleLock?: WithMcpLifecycleLock;
  lookup?: SandboxGatewayState;
  lookupState?: "present" | "missing";
  gatewayRunning?: boolean;
  preflight?: SandboxStatusPreflightResult;
  postRecoveryPreflight?: SandboxStatusPreflightResult;
  /** `null` models a sandbox name that the local registry does not hold. */
  sandboxEntry?:
    | (Partial<Omit<typeof baseSandboxEntry, "agentVersion">> & {
        agent?: string | null;
        agentVersion?: string | null;
        dcodeAutoApprovalMode?: "disabled" | "thread-opt-in";
        preferredInferenceApi?: string | null;
        compatibleEndpointReasoningEffort?: "low" | "medium" | "high" | null;
        hostMounts?: SandboxHostMount[];
        dashboardRemoteBindPrepared?: boolean;
      })
    | null;
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

export function resetStatusFlowModuleCache(): void {
  delete require.cache[requireDist.resolve(statusModulePath)];
}

export function createStatusFlowHarness(options: StatusFlowHarnessOptions = {}): StatusFlowHarness {
  resetStatusFlowModuleCache();

  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);

  const statusPreflight = requireDist("../../src/lib/actions/sandbox/status-preflight.js");
  const statusSnapshot = requireDist("../../src/lib/actions/sandbox/status-snapshot.js");
  const dockerHealth = requireDist("../../src/lib/actions/sandbox/docker-health.js");
  const statusProcessRecovery = requireDist(
    "../../src/lib/actions/sandbox/status/process-recovery.js",
  );
  const portableAgentLifecycle = requireDist(
    "../../src/lib/onboard/experimental/portable-agent-lifecycle.js",
  );
  const lifecycleLock = requireDist("../../src/lib/state/mcp-lifecycle-lock-acquisition.js");
  const resolve = requireDist("../../src/lib/adapters/openshell/resolve.js");
  const agentRuntime = requireDist("../../src/lib/agent/runtime.js");
  const nim = requireDist("../../src/lib/inference/nim.js");
  const policy = requireDist("../../src/lib/policy/index.js");
  const sandboxVersion = requireDist("../../src/lib/sandbox/version.js");
  const shields = requireDist("../../src/lib/shields/index.js");
  const registry = requireDist("../../src/lib/state/registry.js");
  const sandboxSession = requireDist("../../src/lib/state/sandbox-session.js");

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

  const sandboxEntry =
    options.sandboxEntry === null ? null : { ...baseSandboxEntry, ...options.sandboxEntry };
  const qualifyPortableAgentLifecycleAuthority =
    portableAgentLifecycle.qualifyPortableAgentLifecycleAuthority;
  const qualifyPortableAgentLifecycleAuthoritySpy = vi
    .spyOn(portableAgentLifecycle, "qualifyPortableAgentLifecycleAuthority")
    .mockImplementation(((sandboxName: string) => {
      const disposition =
        typeof options.portableDisposition === "function"
          ? options.portableDisposition()
          : options.portableDisposition;
      if (disposition instanceof Error) throw disposition;
      return qualifyPortableAgentLifecycleAuthority(sandboxName, {
        inspectReceiptDisposition: () => disposition ?? { kind: "absent" },
        readRegistry: () => (options.registryEntry === "missing" ? null : sandboxEntry),
      });
    }) as never);

  const withMcpLifecycleLockSpy = vi
    .spyOn(lifecycleLock, "withMcpLifecycleLock")
    .mockImplementation(
      (options.withMcpLifecycleLock ??
        (async (_sandboxName: string, operation: () => unknown) => await operation())) as never,
    );

  vi.spyOn(registry, "getSandbox").mockReturnValue(
    options.registryEntry === "missing" ? null : sandboxEntry,
  );
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
      currentModel: options.currentModel ?? sandboxEntry?.model,
      currentProvider: options.currentProvider ?? "ollama-local",
      recordedRoute: {
        provider: sandboxEntry?.provider,
        model: sandboxEntry?.model,
      },
      liveRoute: {
        provider: options.currentProvider ?? "ollama-local",
        model: options.currentModel ?? sandboxEntry?.model,
      },
      routeDrift: options.routeDrift ?? null,
      inferenceHealth:
        options.inferenceHealth === undefined
          ? {
              ok: true,
              probed: true,
              providerLabel: "Inference route",
              endpoint: "https://inference.local/v1/models",
              detail: "inference route reachable",
              okLabel: "reachable",
              subprobes: [
                {
                  ok: true,
                  probed: true,
                  providerLabel: "Ollama",
                  endpoint: "http://127.0.0.1:11434/v1/chat/completions",
                  detail: "chat completions probe passed",
                  probeLabel: "ollama backend",
                },
              ],
            }
          : options.inferenceHealth,
      terminalRuntimeHealth: null,
      servingProcessHealth:
        options.servingProcessHealth === undefined
          ? sandboxEntry?.agent === "langchain-deepagents-code"
            ? null
            : { checked: false }
          : options.servingProcessHealth,
      ...(options.postRecoveryPreflight
        ? { postRecoveryPreflight: options.postRecoveryPreflight }
        : {}),
    });
  const getSandboxDockerRuntimeSpy = vi
    .spyOn(dockerHealth, "getSandboxDockerRuntime")
    .mockReturnValue({
      containerName: "openshell-alpha",
      health: "unhealthy",
      paused: false,
    });
  const isSandboxGatewayRunningForStatusSpy = vi
    .spyOn(statusProcessRecovery, "isSandboxGatewayRunningForStatus")
    .mockResolvedValue(options.gatewayRunning ?? false);
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
  vi.spyOn(policy, "getGatewayPresets").mockReturnValue(
    options.gatewayPresets === undefined ? ["npm", "telegram"] : options.gatewayPresets,
  );
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

  const statusModule = requireDist(statusModulePath);

  return {
    checkAgentVersionSpy,
    collectSandboxStatusSnapshotSpy,
    getActiveSandboxSessionsSpy,
    getSandboxDockerRuntimeSpy,
    getSandboxStatusReport: statusModule.getSandboxStatusReport,
    qualifyPortableAgentLifecycleAuthoritySpy,
    isSandboxGatewayRunningForStatusSpy,
    logSpy,
    removeSandboxSpy,
    showSandboxStatus: statusModule.showSandboxStatus,
    withMcpLifecycleLockSpy,
  } satisfies StatusFlowHarness;
}
