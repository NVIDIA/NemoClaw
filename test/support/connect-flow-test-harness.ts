// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import childProcess from "node:child_process";
import { createRequire } from "node:module";

import { type MockInstance, vi } from "vitest";

import type { SecretBoundaryRefusalReason } from "../../src/lib/actions/sandbox/hermes-secret-boundary-recovery";
import type { SandboxEntry } from "../../src/lib/state/registry";

type ConnectSandbox = typeof import("../../src/lib/actions/sandbox/connect")["connectSandbox"];
type GatewayRouteMutationLock =
  typeof import("../../src/lib/inference/gateway-route-mutation-lock")["withGatewayRouteMutationLock"];

export const requireDist = createRequire(import.meta.url);
export const connectModulePath = "../../src/lib/actions/sandbox/connect.js";

// Warm the CommonJS source graph outside the first test's timeout. Each harness
// still reloads the entry module after installing its dependency spies.
requireDist(connectModulePath);
delete require.cache[requireDist.resolve(connectModulePath)];

export type ConnectHarness = {
  applyVmDnsMonkeypatchSpy: MockInstance;
  captureOpenshellSpy: MockInstance;
  checkAndRecoverSpy: MockInstance;
  connectSandbox: ConnectSandbox;
  ensureOllamaAuthProxySpy: MockInstance;
  ensureLiveSandboxSpy: MockInstance;
  errorSpy: MockInstance;
  logSpy: MockInstance;
  preflightVllmSpy: MockInstance;
  registryEntries: SandboxEntry[];
  runAutoPairSpy: MockInstance;
  runOpenshellSpy: MockInstance;
  runSetupDnsProxySpy: MockInstance;
  spawnSyncSpy: MockInstance;
  withGatewayRouteMutationLockSpy: MockInstance;
};

export type ConnectHarnessOptions = {
  agentName?: string;
  inferenceGetOutput?: string;
  inferenceProbeResponses?: string[];
  registryEntry?: Partial<SandboxEntry>;
  registryEntries?: Array<Partial<SandboxEntry> & Pick<SandboxEntry, "name">>;
  sessionAgent?: unknown;
  listOutput?: string;
  processCheck?: {
    checked: boolean;
    wasRunning?: boolean;
    recovered?: boolean;
    forwardRecovered?: boolean;
    forwardRecoveryFailed?: boolean;
    forwardRecoveryFailureDetail?: string;
    secretBoundaryRefused?: boolean;
    secretBoundaryReason?: SecretBoundaryRefusalReason;
    mcpReconciliationRefused?: boolean;
    mcpReconciliationReason?: string;
  };
  spawnSignal?: NodeJS.Signals | null;
  spawnStatus?: number | null;
  sttyThrows?: boolean;
  withGatewayRouteMutationLock?: GatewayRouteMutationLock;
};

function throwSttyFailure(): never {
  throw new Error("stty failed");
}

function spawnStatusFromOptions(options: ConnectHarnessOptions): number | null {
  return Object.hasOwn(options, "spawnStatus") ? (options.spawnStatus ?? null) : 0;
}

export function createConnectHarness(options: ConnectHarnessOptions = {}): ConnectHarness {
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

  const runtime = requireDist("../../src/lib/adapters/openshell/runtime.js");
  const resolve = requireDist("../../src/lib/adapters/openshell/resolve.js");
  const agentRuntime = requireDist("../../src/lib/agent/runtime.js");
  const dns = requireDist("../../src/lib/actions/dns/index.js");
  const gatewayState = requireDist("../../src/lib/actions/sandbox/gateway-state.js");
  const processRecovery = requireDist("../../src/lib/actions/sandbox/process-recovery.js");
  const autoPairApproval = requireDist("../../src/lib/actions/sandbox/auto-pair-approval.js");
  const connectVllmPreflight = requireDist(
    "../../src/lib/actions/sandbox/connect-vllm-preflight.js",
  );
  const gatewayFailureClassifier = requireDist(
    "../../src/lib/actions/sandbox/gateway-failure-classifier.js",
  );
  const ollamaProxy = requireDist("../../src/lib/inference/ollama/proxy.js");
  const gatewayRouteMutationLock = requireDist(
    "../../src/lib/inference/gateway-route-mutation-lock.js",
  );
  const sandboxVersion = requireDist("../../src/lib/sandbox/version.js");
  const registry = requireDist("../../src/lib/state/registry.js");
  const sandboxSession = requireDist("../../src/lib/state/sandbox-session.js");
  const vmDnsMonkeypatch = requireDist("../../src/lib/actions/sandbox/vm-dns-monkeypatch.js");

  const preflightVllmSpy = vi
    .spyOn(connectVllmPreflight, "preflightVllmModelEnvOrExit")
    .mockImplementation(() => undefined);
  const ensureLiveSandboxSpy = vi.spyOn(gatewayState, "ensureLiveSandboxOrExit").mockResolvedValue({
    state: "present",
    output: "Name: alpha\nPhase: Ready\n",
  });
  vi.spyOn(gatewayFailureClassifier, "isDockerRuntimeDown").mockReturnValue(false);
  const inferenceProbeResponses = [...(options.inferenceProbeResponses ?? [])];
  const captureOpenshellSpy = vi
    .spyOn(runtime, "captureOpenshell")
    .mockImplementation((args: unknown) => {
      const argv = Array.isArray(args) ? args : [];
      if (argv[0] === "sandbox" && argv[1] === "list") {
        return { status: 0, output: options.listOutput ?? "alpha Ready" };
      }
      if (argv[0] === "inference" && argv[1] === "get") {
        return {
          status: 0,
          output: options.inferenceGetOutput ?? "Provider: unknown\nModel: unknown\n",
        };
      }
      if (
        argv[0] === "sandbox" &&
        argv[1] === "exec" &&
        argv.join(" ").includes("inference.local/v1/models")
      ) {
        return { status: 0, output: inferenceProbeResponses.shift() ?? "OK 200" };
      }
      return { status: 0, output: "" };
    });
  const runOpenshellSpy = vi.spyOn(runtime, "runOpenshell").mockReturnValue({ status: 0 });
  const withGatewayRouteMutationLockSpy = vi
    .spyOn(gatewayRouteMutationLock, "withGatewayRouteMutationLock")
    .mockImplementation(
      (options.withGatewayRouteMutationLock ??
        (async (_gatewayName: string, operation: () => Promise<unknown> | unknown) =>
          await operation())) as never,
    );
  const runSetupDnsProxySpy = vi.spyOn(dns, "runSetupDnsProxy").mockReturnValue({ exitCode: 0 });
  const applyVmDnsMonkeypatchSpy = vi
    .spyOn(vmDnsMonkeypatch, "applyOpenShellVmDnsMonkeypatch")
    .mockReturnValue({ attempted: true, changed: true, ok: true, status: "applied" });
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
  const primaryRegistryEntry: SandboxEntry = {
    name: "alpha",
    agent: options.agentName ?? "openclaw",
    provider: null,
    model: null,
    gpuEnabled: false,
    policies: [],
    ...options.registryEntry,
  };
  const registryEntries: SandboxEntry[] = options.registryEntries
    ? options.registryEntries.map((candidate) =>
        candidate.name === primaryRegistryEntry.name
          ? { ...primaryRegistryEntry, ...candidate }
          : {
              agent: "openclaw",
              provider: null,
              model: null,
              gpuEnabled: false,
              policies: [],
              ...candidate,
            },
      )
    : [primaryRegistryEntry];
  vi.spyOn(registry, "getSandbox").mockImplementation(
    (name: unknown) => registryEntries.find((candidate) => candidate.name === String(name)) ?? null,
  );
  vi.spyOn(registry, "listSandboxes").mockReturnValue({
    sandboxes: registryEntries,
    defaultSandbox: primaryRegistryEntry.name,
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
    applyVmDnsMonkeypatchSpy,
    captureOpenshellSpy,
    checkAndRecoverSpy,
    connectSandbox: requireDist(connectModulePath).connectSandbox,
    ensureOllamaAuthProxySpy,
    ensureLiveSandboxSpy,
    errorSpy,
    logSpy,
    preflightVllmSpy,
    registryEntries,
    runAutoPairSpy,
    runOpenshellSpy,
    runSetupDnsProxySpy,
    spawnSyncSpy,
    withGatewayRouteMutationLockSpy,
  };
}
