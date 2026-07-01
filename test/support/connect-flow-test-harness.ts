// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import childProcess from "node:child_process";
import { createRequire } from "node:module";

import { type MockInstance, vi } from "vitest";

import type { SecretBoundaryRefusalReason } from "../../src/lib/actions/sandbox/hermes-secret-boundary-recovery";

type ConnectSandbox = typeof import("../../src/lib/actions/sandbox/connect")["connectSandbox"];

export const requireDist = createRequire(import.meta.url);
export const connectModulePath = "../../src/lib/actions/sandbox/connect.js";

// Warm the CommonJS source graph outside the first test's timeout. Each harness
// still reloads the entry module after installing its dependency spies.
requireDist(connectModulePath);
delete require.cache[requireDist.resolve(connectModulePath)];

export type ConnectHarness = {
  captureOpenshellSpy: MockInstance;
  checkAndRecoverSpy: MockInstance;
  connectSandbox: ConnectSandbox;
  ensureOllamaAuthProxySpy: MockInstance;
  errorSpy: MockInstance;
  logSpy: MockInstance;
  runAutoPairSpy: MockInstance;
  spawnSyncSpy: MockInstance;
};

export type ConnectHarnessOptions = {
  agentName?: string;
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
  const sandboxVersion = requireDist("../../src/lib/sandbox/version.js");
  const registry = requireDist("../../src/lib/state/registry.js");
  const sandboxSession = requireDist("../../src/lib/state/sandbox-session.js");

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
