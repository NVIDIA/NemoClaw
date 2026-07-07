// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { expect, type MockInstance, vi } from "vitest";

type DestroySandbox = typeof import("../../src/lib/actions/sandbox/destroy")["destroySandbox"];

const requireDist = createRequire(
  new URL("../../src/lib/actions/sandbox/destroy-flow.test.ts", import.meta.url),
);
const destroyModulePath = "./destroy.js";

export type DestroyHarness = {
  cleanupGatewaySpy: MockInstance;
  destroySandbox: DestroySandbox;
  errorSpy: MockInstance;
  events: string[];
  finalizeMcpBridgesAfterSandboxDeleteSpy: MockInstance;
  gatewayPinsAtMcpPrepare: Array<string | undefined>;
  gatewayPinsAtSandboxList: Array<string | undefined>;
  killTimerSpy: MockInstance;
  killStaleProxySpy: MockInstance;
  logSpy: MockInstance;
  prepareMcpBridgesForAbsentSandboxDestroySpy: MockInstance;
  prepareMcpBridgesForDestroySpy: MockInstance;
  removeSandboxSpy: MockInstance;
  restoreMcpBridgesAfterDestroyAbortSpy: MockInstance;
  runOpenshellSpy: MockInstance;
  selectGatewaySpy: MockInstance;
  shieldsDownSpy: MockInstance;
  stopAllSpy: MockInstance;
  stopNimByNameSpy: MockInstance;
  unloadOllamaModelsSpy: MockInstance;
};

type DestroyHarnessOptions = {
  activeTimer?: boolean;
  agent?: "openclaw" | "hermes";
  deleteOutput?: string;
  deleteStatus?: number;
  finalizeMcpError?: string;
  mcpAddState?: "prepared";
  mcpServers?: string[];
  registeredSandboxCount?: number;
  restoreMcpError?: string;
  sandboxPresent?: boolean;
  shieldsDown?: boolean;
  shieldsUpError?: Error;
};

const sandboxEntry = {
  name: "alpha",
  agent: "openclaw",
  provider: "ollama-local",
  model: "nvidia/nemotron",
  imageTag: null,
  nimContainer: "alpha-nim",
  gatewayName: "nemoclaw-19080",
  gatewayPort: 19080,
};

export function sandboxListJson(names: string[]): string {
  return JSON.stringify(
    names.map((name) => ({
      id: `sandbox-${name}`,
      name,
      labels: {},
      resource_version: 1,
      created_at: "2026-06-27 00:00:00",
      phase: "Ready",
      current_policy_version: 1,
    })),
  );
}

export function resetDestroyModuleCache(): void {
  delete require.cache[requireDist.resolve(destroyModulePath)];
}

type DestroySandboxPresenceClassifier = (
  sandboxName: string,
  result: { status: number | null; stdout?: string; stderr?: string },
) => string;

export function loadDestroySandboxPresenceClassifier(): DestroySandboxPresenceClassifier {
  resetDestroyModuleCache();
  const destroyModule = requireDist(destroyModulePath) as {
    classifyDestroySandboxPresence: DestroySandboxPresenceClassifier;
  };
  return destroyModule.classifyDestroySandboxPresence;
}

export function createDestroyHarness(options: DestroyHarnessOptions = {}): DestroyHarness {
  resetDestroyModuleCache();
  const events: string[] = [];

  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);

  const resolve = requireDist("../../adapters/openshell/resolve.js");
  const runtime = requireDist("../../adapters/openshell/runtime.js");
  const destroyGateway = requireDist("./destroy-gateway.js");
  const sandboxProviderCleanup = requireDist("../../onboard/sandbox-provider-cleanup.js");
  const nim = requireDist("../../inference/nim.js");
  const ollamaProxy = requireDist("../../inference/ollama/proxy.js");
  const tunnelServices = requireDist("../../tunnel/services.js");
  const onboardSession = requireDist("../../state/onboard-session.js");
  const registry = requireDist("../../state/registry.js");
  const sandboxSession = requireDist("../../state/sandbox-session.js");
  const shields = requireDist("../../shields/index.js");
  const timerControl = requireDist("../../shields/timer-control.js");
  const mcpBridge = requireDist("./mcp-bridge.js");

  vi.spyOn(resolve, "resolveOpenshell").mockReturnValue("/usr/bin/openshell");
  vi.spyOn(sandboxSession, "getActiveSandboxSessions").mockReturnValue({
    detected: true,
    sessions: [{ pid: 1 }],
  });
  vi.spyOn(registry, "getSandbox").mockReturnValue({
    ...sandboxEntry,
    agent: options.agent ?? sandboxEntry.agent,
    ...(options.mcpServers?.length
      ? {
          mcp: {
            bridges: Object.fromEntries(
              options.mcpServers.map((server) => [
                server,
                {
                  server,
                  ...(options.mcpAddState ? { addState: options.mcpAddState } : {}),
                },
              ]),
            ),
          },
        }
      : {}),
  });
  let registeredSandboxCount = options.registeredSandboxCount ?? 0;
  vi.spyOn(registry, "listSandboxes").mockImplementation(() => ({
    sandboxes: Array.from({ length: registeredSandboxCount }, (_, index) => ({
      name: `sb-${index}`,
    })),
  }));
  const removeSandboxSpy = vi.spyOn(registry, "removeSandbox").mockImplementation(() => {
    registeredSandboxCount = Math.max(0, registeredSandboxCount - 1);
    return true;
  });
  vi.spyOn(onboardSession, "loadSession").mockReturnValue({
    sandboxName: "alpha",
  });
  vi.spyOn(onboardSession, "updateSession").mockImplementation((mutator: unknown) => {
    const session = { sandboxName: "alpha" };
    expect(typeof mutator).toBe("function");
    (mutator as (value: typeof session) => void)(session);
    return session;
  });
  const gatewayPinsAtSandboxList: Array<string | undefined> = [];
  const runOpenshellSpy = vi.spyOn(runtime, "runOpenshell").mockImplementation((args: unknown) => {
    const argv = Array.isArray(args) ? args : [];
    switch (`${String(argv[0])}:${String(argv[1])}`) {
      case "sandbox:exec":
        events.push("wipe");
        return { status: 0, stdout: "", stderr: "" };
      case "sandbox:list":
        gatewayPinsAtSandboxList.push(process.env.OPENSHELL_GATEWAY);
        return {
          status: 0,
          stdout: sandboxListJson(options.sandboxPresent === false ? [] : ["alpha"]),
          stderr: "",
        };
      case "sandbox:delete":
        events.push("delete");
        return {
          status: options.deleteStatus ?? 0,
          stdout: options.deleteOutput ?? "",
          stderr: "",
        };
      default:
        return { status: 0, stdout: "", stderr: "" };
    }
  });
  vi.spyOn(runtime, "captureOpenshell").mockReturnValue({
    status: 0,
    output: "",
  });
  const selectGatewaySpy = vi
    .spyOn(destroyGateway, "selectGatewayForSandboxDestroy")
    .mockImplementation(() => undefined);
  const cleanupGatewaySpy = vi
    .spyOn(destroyGateway, "cleanupGatewayAfterLastSandbox")
    .mockImplementation(() => undefined);
  vi.spyOn(sandboxProviderCleanup, "runSandboxProviderPreDeleteCleanup").mockImplementation(() => {
    events.push("detach");
    return { failures: [] };
  });
  vi.spyOn(sandboxProviderCleanup, "emitProviderDetachResidualHint").mockImplementation(
    () => undefined,
  );
  const stopNimByNameSpy = vi
    .spyOn(nim, "stopNimContainerByName")
    .mockImplementation(() => undefined);
  vi.spyOn(nim, "stopNimContainer").mockImplementation(() => undefined);
  const killStaleProxySpy = vi
    .spyOn(ollamaProxy, "killStaleProxy")
    .mockImplementation(() => undefined);
  const unloadOllamaModelsSpy = vi
    .spyOn(ollamaProxy, "unloadOllamaModels")
    .mockImplementation(() => undefined);
  const stopAllSpy = vi.spyOn(tunnelServices, "stopAll").mockImplementation(() => undefined);
  vi.spyOn(timerControl, "readTimerMarker").mockReturnValue(
    options.activeTimer
      ? {
          pid: 4242,
          sandboxName: "alpha",
          snapshotPath: "/tmp/policy.yaml",
          restoreAt: "2026-06-27T06:00:00.000Z",
          processToken: "a".repeat(32),
        }
      : null,
  );
  vi.spyOn(shields, "shieldsUp").mockImplementation(() => {
    events.push("harden");
    options.shieldsUpError === undefined
      ? undefined
      : (() => {
          throw options.shieldsUpError;
        })();
  });
  vi.spyOn(shields, "isShieldsDown").mockReturnValue(options.shieldsDown ?? true);
  const shieldsDownSpy = vi.spyOn(shields, "shieldsDown").mockImplementation(() => {
    events.push("unlock");
  });
  const killTimerSpy = vi.spyOn(timerControl, "killTimer").mockImplementation(() => {
    events.push("timer-cleanup");
    return { warnings: [] };
  });
  const preparedServers = options.mcpAddState === "prepared" ? [] : (options.mcpServers ?? []);
  const mcpPreparation = {
    entries: preparedServers.map((server) => ({ server })),
    detachedProviderEntries: preparedServers.map((server) => ({ server })),
    scrubbedAdapterEntries: preparedServers.map((server) => ({ server })),
    destroyAlreadyPrepared: false,
    destroyAlreadyPending: false,
  };
  const gatewayPinsAtMcpPrepare: Array<string | undefined> = [];
  const prepareMcpBridgesForDestroySpy = vi
    .spyOn(mcpBridge, "prepareMcpBridgesForDestroy")
    .mockImplementation(async () => {
      gatewayPinsAtMcpPrepare.push(process.env.OPENSHELL_GATEWAY);
      return mcpPreparation;
    });
  const prepareMcpBridgesForAbsentSandboxDestroySpy = vi
    .spyOn(mcpBridge, "prepareMcpBridgesForAbsentSandboxDestroy")
    .mockImplementation(async () => {
      gatewayPinsAtMcpPrepare.push(process.env.OPENSHELL_GATEWAY);
      return mcpPreparation;
    });
  const restoreMcpBridgesAfterDestroyAbortSpy = vi
    .spyOn(mcpBridge, "restoreMcpBridgesAfterDestroyAbort")
    .mockImplementation(async () => {
      events.push("mcp-restore");
      return options.restoreMcpError === undefined
        ? undefined
        : Promise.reject(new Error(options.restoreMcpError));
    });
  const finalizeMcpBridgesAfterSandboxDeleteSpy = vi
    .spyOn(mcpBridge, "finalizeMcpBridgesAfterSandboxDelete")
    .mockImplementation(() =>
      options.finalizeMcpError
        ? Promise.reject(new Error(options.finalizeMcpError))
        : Promise.resolve(),
    );

  logSpy.mockClear();

  return {
    cleanupGatewaySpy,
    destroySandbox: requireDist(destroyModulePath).destroySandbox,
    errorSpy,
    events,
    finalizeMcpBridgesAfterSandboxDeleteSpy,
    gatewayPinsAtMcpPrepare,
    gatewayPinsAtSandboxList,
    killTimerSpy,
    killStaleProxySpy,
    logSpy,
    prepareMcpBridgesForAbsentSandboxDestroySpy,
    prepareMcpBridgesForDestroySpy,
    removeSandboxSpy,
    restoreMcpBridgesAfterDestroyAbortSpy,
    runOpenshellSpy,
    selectGatewaySpy,
    shieldsDownSpy,
    stopAllSpy,
    stopNimByNameSpy,
    unloadOllamaModelsSpy,
  };
}
