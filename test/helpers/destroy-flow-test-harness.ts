// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { expect, type MockInstance, vi } from "vitest";
import type { SandboxDestroyExecutionResult } from "../../src/lib/actions/sandbox/destroy-execution";
import type { PreparedManagedLlamaCppRuntimeCleanup } from "../../src/lib/inference/local-model-profile/cleanup";
import type { ManagedHermesStateVolumeCleanupResult } from "../../src/lib/onboard/managed-workload/hermes-state-volume";
import type { Session } from "../../src/lib/state/onboard-session";
import type { SandboxEntry, SandboxWorkloadReceipt } from "../../src/lib/state/registry";

type DestroySandbox = (typeof import("../../src/lib/actions/sandbox/destroy"))["destroySandbox"];

const requireDist = createRequire(
  new URL("../../src/lib/actions/sandbox/destroy-flow.test.ts", import.meta.url),
);
const destroyModulePath = "./destroy.js";

export type DestroyHarness = {
  assertHermesPortableCommandUnavailableSpy: MockInstance;
  cleanupGatewaySpy: MockInstance;
  captureOpenshellSpy: MockInstance;
  compareAndSwapSessionSpy: MockInstance;
  destroySandbox: DestroySandbox;
  dockerCaptureSpy: MockInstance;
  dockerRunSpy: MockInstance;
  errorSpy: MockInstance;
  events: string[];
  executeSandboxDestroySpy: MockInstance;
  finalizeMcpBridgesAfterSandboxDeleteSpy: MockInstance;
  gatewayPinsAtMcpPrepare: Array<string | undefined>;
  gatewayPinsAtSandboxList: Array<string | undefined>;
  killTimerSpy: MockInstance;
  killStaleProxySpy: MockInstance;
  logSpy: MockInstance;
  prepareMcpBridgesForAbsentSandboxDestroySpy: MockInstance;
  prepareMcpBridgesForDestroySpy: MockInstance;
  prepareManagedLlamaCppRuntimeCleanupSpy: MockInstance;
  cleanupManagedLlamaCppRuntimeForSandboxSpy: MockInstance;
  preparePortableDestroyAuthoritySpy: MockInstance;
  promptSpy: MockInstance;
  removeManagedHermesStateVolumeSpy: MockInstance;
  removeSandboxSpy: MockInstance;
  retirePortableLifecycleReceiptSpy: MockInstance;
  portableDestroyRevalidateSpy: MockInstance;
  portableDestroyVerifyAbsentSpy: MockInstance;
  revokeHttpsPinRuntimeAdapterRouteSpy: MockInstance;
  restoreMcpBridgesAfterDestroyAbortSpy: MockInstance;
  runOpenshellSpy: MockInstance;
  selectGatewaySpy: MockInstance;
  sessionState: Session;
  setSandboxPresent: (present: boolean) => void;
  shieldsDownSpy: MockInstance;
  stopAllSpy: MockInstance;
  stopModelRouterForDestroyedSandboxSpy: MockInstance;
  stopNimByNameSpy: MockInstance;
  unloadOllamaModelsSpy: MockInstance;
  updateSessionSpy: MockInstance;
  warnSpy: MockInstance;
  withGatewayRouteMutationLockSpy: MockInstance;
  withModelRouterPortLifecycleLockSpy: MockInstance;
};

type DestroyHarnessOptions = {
  activeTimer?: boolean;
  agent?: "openclaw" | "hermes";
  deleteOutput?: string;
  deleteStatus?: number;
  dockerPsOutput?: string;
  dockerOrphanIds?: string[];
  dockerOrphanQueryStatus?: number | null;
  dockerRemoveStatus?: number | null;
  dockerRunResult?: { status: number | null; stdout?: string; stderr?: string };
  dockerRunResultSequence?: Array<{
    status: number | null;
    stdout?: string;
    stderr?: string;
  }>;
  onDockerRun?: (call: number) => void;
  detachedProviders?: string[];
  endpointUrl?: string;
  executeSandboxDestroyResult?: SandboxDestroyExecutionResult;
  finalizeMcpBridgeError?: string;
  finalizeMcpError?: string;
  imageTag?: string | null;
  hostLocalInferenceReceipt?: string | null;
  hostLocalInferenceProvenance?: SandboxEntry["hostLocalInferenceProvenance"];
  liveListOutput?: string;
  managedHermesStateVolumeCleanupResult?: ManagedHermesStateVolumeCleanupResult;
  onPrepareManagedLlamaCppRuntimeCleanup?: () => void;
  preparedManagedLlamaCppRuntimeCleanup?: PreparedManagedLlamaCppRuntimeCleanup | null;
  mcpAddState?: "prepared";
  mcpServers?: string[];
  openshellDriver?: string;
  portableCommandError?: string;
  portableDestroyAuthority?: boolean;
  portableDestroyPrepareError?: string;
  portableDestroyVerifyAbsentError?: string;
  prepareMcpBridgeError?: string;
  promptResponses?: string[];
  provider?: string;
  registryEntryPresent?: boolean;
  registeredSandboxCount?: number;
  replaceSessionAfterRegistryRemoval?: boolean;
  removeSandboxResult?: boolean;
  restoreMcpError?: string;
  sandboxPresent?: boolean;
  sessionRouterPid?: number;
  shieldsDown?: boolean;
  shieldsUpError?: Error;
  stopInferenceError?: string;
  workload?: SandboxWorkloadReceipt;
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

export function traceDestroyBoundaryCalls(
  harness: Pick<DestroyHarness, "runOpenshellSpy">,
  trace: string[],
): void {
  harness.runOpenshellSpy.mockImplementation((args: unknown) => {
    const argv = Array.isArray(args) ? args : [];
    switch (`${String(argv[0])}:${String(argv[1])}`) {
      case "sandbox:delete":
        trace.push("delete");
        return { status: 0, stdout: "", stderr: "" };
      case "sandbox:list":
        return { status: 0, stdout: "[]", stderr: "" };
      default:
        return { status: 0, stdout: "", stderr: "" };
    }
  });
}

export function createDestroyHarness(options: DestroyHarnessOptions = {}): DestroyHarness {
  resetDestroyModuleCache();
  const events: string[] = [];
  let sandboxPresent = options.sandboxPresent !== false;
  let sessionLockBusy = false;
  const sessionState = {
    sessionId: "session-alpha",
    updatedAt: "2026-08-14T00:00:00.000Z",
    sandboxName: "alpha",
    endpointUrl: options.endpointUrl ?? null,
    routerPid: options.sessionRouterPid ?? null,
    routerCredentialHash: options.sessionRouterPid ? "router-hash" : null,
  } as Session;

  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

  const resolve = requireDist("../../adapters/openshell/resolve.js");
  const runtime = requireDist("../../adapters/openshell/runtime.js");
  const destroyGateway = requireDist("./destroy-gateway.js");
  const credentialStore = requireDist("../../credentials/store.js");
  const sandboxProviderCleanup = requireDist("../../onboard/sandbox-provider-cleanup.js");
  const nim = requireDist("../../inference/nim.js");
  const ollamaProxy = requireDist("../../inference/ollama/proxy.js");
  const gatewayRouteMutationLock = requireDist("../../inference/gateway-route-mutation-lock.js");
  const modelRouterProcess = requireDist("../../onboard/model-router-process.js");
  const httpsPinRuntimeAdapter = requireDist("../../inference/https-pin-runtime-adapter.js");
  const tunnelServices = requireDist("../../tunnel/services.js");
  const onboardSession = requireDist("../../state/onboard-session.js");
  const gatewayRegistry = requireDist("../../state/gateway-registry.js");
  const registry = requireDist("../../state/registry.js");
  const destroyExecution = requireDist("./destroy-execution.js");
  const destroyPreflight = requireDist("./destroy-preflight.js");
  const sandboxSession = requireDist("../../state/sandbox-session.js");
  const shields = requireDist("../../shields/index.js");
  const timerControl = requireDist("../../shields/timer-control.js");
  const mcpBridge = requireDist("./mcp-bridge.js");
  const dockerRun = requireDist("../../adapters/docker/run.js");
  const portableAgentLifecycle = requireDist(
    "../../onboard/experimental/portable-agent-lifecycle.js",
  );
  const localModelProfileCleanup = requireDist("../../inference/local-model-profile/cleanup.js");
  const portableDemoLifecycle = requireDist(
    "../../onboard/experimental/portable-demo-lifecycle.js",
  );

  const executeSandboxDestroySpy = vi.spyOn(destroyExecution, "executeSandboxDestroy");
  if (options.executeSandboxDestroyResult) {
    executeSandboxDestroySpy.mockResolvedValue(options.executeSandboxDestroyResult);
  }

  const prepareManagedLlamaCppRuntimeCleanupSpy = vi
    .spyOn(localModelProfileCleanup, "prepareManagedLlamaCppRuntimeCleanupForSandbox")
    .mockImplementation(() => {
      options.onPrepareManagedLlamaCppRuntimeCleanup?.();
      return options.preparedManagedLlamaCppRuntimeCleanup ?? null;
    });
  const cleanupManagedLlamaCppRuntimeForSandboxSpy = vi
    .spyOn(localModelProfileCleanup, "cleanupManagedLlamaCppRuntimeForSandbox")
    .mockReturnValue({ ok: true, removed: [], preserved: [] });

  const assertHermesPortableCommandUnavailableSpy = vi
    .spyOn(portableAgentLifecycle, "assertHermesPortableCommandUnavailable")
    .mockImplementation(() => {
      if (options.portableCommandError) throw new Error(options.portableCommandError);
    });
  const portableDestroyRevalidateSpy = vi.fn(() => {
    events.push("portable-revalidate");
  });
  const portableDestroyVerifyAbsentSpy = vi.fn(() => {
    events.push("portable-absent");
    if (options.portableDestroyVerifyAbsentError) {
      throw new Error(options.portableDestroyVerifyAbsentError);
    }
  });
  const preparePortableDestroyAuthoritySpy = vi
    .spyOn(portableDemoLifecycle, "preparePortableDemoSandboxDestroyAuthority")
    .mockImplementation(() => {
      if (options.portableDestroyPrepareError) {
        throw new Error(options.portableDestroyPrepareError);
      }
      return options.portableDestroyAuthority
        ? {
            revalidate: portableDestroyRevalidateSpy,
            verifyAbsent: portableDestroyVerifyAbsentSpy,
          }
        : null;
    });

  vi.spyOn(resolve, "resolveOpenshell").mockReturnValue("/usr/bin/openshell");
  const promptSpy = vi.spyOn(credentialStore, "prompt").mockResolvedValue("yes");
  for (const response of options.promptResponses ?? []) {
    promptSpy.mockResolvedValueOnce(response);
  }
  vi.spyOn(sandboxSession, "getActiveSandboxSessions").mockReturnValue({
    detected: true,
    sessions: [{ pid: 1 }],
  });
  vi.spyOn(registry, "getSandbox").mockReturnValue(
    options.registryEntryPresent === false
      ? null
      : {
          ...sandboxEntry,
          imageTag: options.imageTag === undefined ? sandboxEntry.imageTag : options.imageTag,
          agent: options.agent ?? sandboxEntry.agent,
          ...(options.provider ? { provider: options.provider } : {}),
          ...(options.openshellDriver ? { openshellDriver: options.openshellDriver } : {}),
          ...(options.endpointUrl ? { endpointUrl: options.endpointUrl } : {}),
          ...(options.hostLocalInferenceReceipt !== undefined
            ? { hostLocalInferenceReceipt: options.hostLocalInferenceReceipt }
            : {}),
          ...(options.hostLocalInferenceProvenance
            ? { hostLocalInferenceProvenance: options.hostLocalInferenceProvenance }
            : {}),
          ...(options.workload ? { workload: options.workload } : {}),
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
        },
  );
  let registeredSandboxCount = options.registeredSandboxCount ?? 0;
  vi.spyOn(registry, "listSandboxes").mockImplementation(() => ({
    sandboxes: Array.from({ length: registeredSandboxCount }, (_, index) => ({
      name: `sb-${index}`,
    })),
  }));
  const removeSandboxSpy = vi.spyOn(registry, "removeSandbox").mockImplementation(() => {
    if (options.removeSandboxResult === false) return false;
    registeredSandboxCount = Math.max(0, registeredSandboxCount - 1);
    if (options.replaceSessionAfterRegistryRemoval) {
      sessionState.sessionId = "replacement-session";
      sessionState.updatedAt = "2026-08-14T00:01:00.000Z";
      sessionState.sandboxName = "alpha";
      sessionState.endpointUrl = "http://host.openshell.internal:4000/v1";
      sessionState.routerPid = 6262;
      sessionState.routerCredentialHash = "replacement-hash";
      sessionLockBusy = true;
    }
    return true;
  });
  const stopModelRouterForDestroyedSandboxSpy = vi.spyOn(
    destroyPreflight,
    "stopModelRouterForDestroyedSandbox",
  );
  const retirePortableLifecycleReceiptSpy = vi
    .spyOn(destroyExecution, "retirePortableLifecycleAuthority")
    .mockImplementation(() => undefined);
  const revokeHttpsPinRuntimeAdapterRouteSpy = vi
    .spyOn(httpsPinRuntimeAdapter, "revokeHttpsPinRuntimeAdapterRoute")
    .mockResolvedValue(true);
  // Pass-through: run the critical section without the cross-process lease so
  // flow tests stay hermetic while asserting lock scope.
  const withGatewayRouteMutationLockSpy = vi
    .spyOn(gatewayRouteMutationLock, "withGatewayRouteMutationLock")
    .mockImplementation(async (_gatewayName: unknown, operation: unknown) =>
      (operation as () => Promise<unknown>)(),
    );
  const withModelRouterPortLifecycleLockSpy = vi
    .spyOn(gatewayRouteMutationLock, "withModelRouterPortLifecycleLock")
    .mockImplementation(async (_port: unknown, operation: unknown) =>
      (operation as () => Promise<unknown>)(),
    );
  vi.spyOn(gatewayRegistry, "listHostGatewayRegistryEntries").mockReturnValue([]);
  vi.spyOn(modelRouterProcess, "doesModelRouterProcessOwnPort").mockReturnValue(false);
  vi.spyOn(modelRouterProcess, "inspectModelRouterProcessForPort").mockReturnValue({
    status: "absent",
  });
  vi.spyOn(modelRouterProcess, "isRouterHealthy").mockResolvedValue(false);
  vi.spyOn(onboardSession, "loadSession").mockImplementation(() => ({ ...sessionState }));
  vi.spyOn(onboardSession, "acquireOnboardLock").mockImplementation(() =>
    sessionLockBusy
      ? {
          acquired: false,
          lockFile: "/tmp/onboard.lock",
          stale: false,
          holderPid: 6262,
          holderStartedAt: "2026-08-14T00:01:00.000Z",
          holderCommand: "replacement nemoclaw onboard process",
        }
      : { acquired: true, lockFile: "/tmp/onboard.lock", stale: false },
  );
  vi.spyOn(onboardSession, "releaseOnboardLock").mockImplementation(() => undefined);
  const compareAndSwapSessionSpy = vi
    .spyOn(onboardSession, "compareAndSwapSession")
    .mockImplementation((matches: unknown, mutator: unknown) => {
      expect(typeof matches).toBe("function");
      expect(typeof mutator).toBe("function");
      if (sessionLockBusy) return "busy";
      if (!(matches as (value: Session) => boolean)(sessionState)) return "mismatch";
      (mutator as (value: Session) => void)(sessionState);
      return "updated";
    });
  const updateSessionSpy = vi
    .spyOn(onboardSession, "updateSession")
    .mockImplementation((mutator: unknown) => {
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
          stdout: sandboxListJson(sandboxPresent ? ["alpha"] : []),
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
  const captureOpenshellSpy = vi.spyOn(runtime, "captureOpenshell").mockReturnValue({
    status: 0,
    output: options.liveListOutput ?? "",
  });
  const dockerCaptureSpy = vi
    .spyOn(dockerRun, "dockerCapture")
    .mockImplementation((args: unknown) => {
      const argv = Array.isArray(args) ? args.map(String) : [];
      if (argv[0] !== "ps") return "";
      const filterIndex = argv.indexOf("--filter");
      const filterValue = filterIndex >= 0 ? argv[filterIndex + 1] : undefined;
      const nameFilter = filterValue?.startsWith("name=") ? filterValue.slice(5) : undefined;
      const names = (options.dockerPsOutput ?? "").split("\n").filter(Boolean);
      const matchedNames = nameFilter
        ? names.filter((name) => `/${name}`.includes(nameFilter))
        : names;
      return matchedNames.length > 0 ? `${matchedNames.join("\n")}\n` : "";
    });
  let identityProbeCall = 0;
  let dockerOrphanIds = [...(options.dockerOrphanIds ?? [])];
  const dockerRunSpy = vi.spyOn(dockerRun, "dockerRun").mockImplementation((args: unknown) => {
    const argv = Array.isArray(args) ? args.map(String) : [];
    const isDockerOrphanQuery =
      argv[0] === "ps" &&
      argv.includes("label=openshell.ai/managed-by=openshell") &&
      argv.includes("label=openshell.ai/sandbox-name=alpha") &&
      argv.at(-1) === "{{.ID}}";
    if (isDockerOrphanQuery) {
      return {
        status: options.dockerOrphanQueryStatus ?? 0,
        stdout: dockerOrphanIds.join("\n"),
        stderr: "",
      } as ReturnType<typeof dockerRun.dockerRun>;
    }
    if (argv[0] === "rm" && argv[1] === "-f") {
      const status = options.dockerRemoveStatus ?? 0;
      if (status === 0) {
        dockerOrphanIds = dockerOrphanIds.filter((id) => id !== argv[2]);
      }
      return { status, stdout: "", stderr: "" } as ReturnType<typeof dockerRun.dockerRun>;
    }
    const filterIndex = argv.indexOf("--filter");
    const isIdentityProbe =
      argv[0] === "ps" &&
      argv.includes("-a") &&
      argv.includes("--no-trunc") &&
      filterIndex >= 0 &&
      argv[filterIndex + 1]?.startsWith("label=openshell.ai/sandbox-name=") === true;
    if (!isIdentityProbe) {
      return (options.dockerRunResult ?? { status: 0 }) as ReturnType<typeof dockerRun.dockerRun>;
    }
    identityProbeCall += 1;
    options.onDockerRun?.(identityProbeCall);
    const result = options.dockerRunResultSequence?.[identityProbeCall - 1] ??
      options.dockerRunResult ?? { status: 0 };
    return result as ReturnType<typeof dockerRun.dockerRun>;
  });
  const selectGatewaySpy = vi
    .spyOn(destroyGateway, "selectGatewayForSandboxDestroy")
    .mockImplementation(() => undefined);
  const cleanupGatewaySpy = vi
    .spyOn(destroyGateway, "cleanupGatewayAfterLastSandbox")
    .mockImplementation(() => undefined);
  vi.spyOn(sandboxProviderCleanup, "runSandboxProviderPreDeleteCleanup").mockImplementation(() => {
    events.push("detach");
    return { detached: options.detachedProviders ?? [], failures: [] };
  });
  vi.spyOn(sandboxProviderCleanup, "emitProviderDetachResidualHint").mockImplementation(
    () => undefined,
  );
  const removeManagedHermesStateVolumeSpy = vi
    .spyOn(sandboxProviderCleanup, "removeManagedHermesStateVolume")
    .mockReturnValue(options.managedHermesStateVolumeCleanupResult ?? { status: "not-applicable" });
  const stopNimByNameSpy = vi.spyOn(nim, "stopNimContainerByName").mockImplementation(() => {
    if (options.stopInferenceError !== undefined) {
      throw new Error(options.stopInferenceError);
    }
  });
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { McpBridgeError } = mcpBridge as any;
  const prepareMcpBridgesForDestroySpy = vi
    .spyOn(mcpBridge, "prepareMcpBridgesForDestroy")
    .mockImplementation(async () => {
      events.push("mcp-prepare");
      if (options.prepareMcpBridgeError !== undefined) {
        throw new McpBridgeError(options.prepareMcpBridgeError);
      }
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
    .mockImplementation(() => {
      if (options.finalizeMcpBridgeError !== undefined) {
        return Promise.reject(new McpBridgeError(options.finalizeMcpBridgeError));
      }
      return options.finalizeMcpError
        ? Promise.reject(new Error(options.finalizeMcpError))
        : Promise.resolve();
    });

  logSpy.mockClear();

  return {
    assertHermesPortableCommandUnavailableSpy,
    cleanupGatewaySpy,
    captureOpenshellSpy,
    compareAndSwapSessionSpy,
    dockerCaptureSpy,
    dockerRunSpy,
    destroySandbox: requireDist(destroyModulePath).destroySandbox,
    errorSpy,
    events,
    executeSandboxDestroySpy,
    finalizeMcpBridgesAfterSandboxDeleteSpy,
    gatewayPinsAtMcpPrepare,
    gatewayPinsAtSandboxList,
    killTimerSpy,
    killStaleProxySpy,
    logSpy,
    prepareMcpBridgesForAbsentSandboxDestroySpy,
    prepareMcpBridgesForDestroySpy,
    prepareManagedLlamaCppRuntimeCleanupSpy,
    cleanupManagedLlamaCppRuntimeForSandboxSpy,
    preparePortableDestroyAuthoritySpy,
    portableDestroyRevalidateSpy,
    portableDestroyVerifyAbsentSpy,
    promptSpy,
    removeManagedHermesStateVolumeSpy,
    removeSandboxSpy,
    retirePortableLifecycleReceiptSpy,
    revokeHttpsPinRuntimeAdapterRouteSpy,
    restoreMcpBridgesAfterDestroyAbortSpy,
    runOpenshellSpy,
    selectGatewaySpy,
    sessionState,
    setSandboxPresent: (present: boolean) => {
      sandboxPresent = present;
    },
    shieldsDownSpy,
    stopAllSpy,
    stopModelRouterForDestroyedSandboxSpy,
    stopNimByNameSpy,
    unloadOllamaModelsSpy,
    updateSessionSpy,
    warnSpy,
    withGatewayRouteMutationLockSpy,
    withModelRouterPortLifecycleLockSpy,
  };
}
