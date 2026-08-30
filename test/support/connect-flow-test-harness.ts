// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import childProcess from "node:child_process";
import { createRequire } from "node:module";

import { type MockInstance, vi } from "vitest";
import type { ManagedGatewayControlCompletion } from "../../src/lib/actions/sandbox/gateway-restart";
import type { SecretBoundaryRefusalReason } from "../../src/lib/actions/sandbox/hermes-secret-boundary-recovery";
import type { WslDetectionOptions } from "../../src/lib/platform";
import type { ConfigObject } from "../../src/lib/security/credential-filter";
import type { SandboxEntry } from "../../src/lib/state/registry";

type ConnectSandbox = (typeof import("../../src/lib/actions/sandbox/connect"))["connectSandbox"];
type WaitForSandboxReadyOrExit =
  (typeof import("../../src/lib/actions/sandbox/connect"))["waitForSandboxReadyOrExit"];
type RestoreSandboxStartupState =
  (typeof import("../../src/lib/actions/sandbox/connect"))["restoreSandboxStartupState"];
type GatewayRouteMutationLock =
  (typeof import("../../src/lib/inference/gateway-route-mutation-lock"))["withGatewayRouteMutationLock"];
type LaunchReadinessPublicationResult =
  import("../../src/lib/actions/sandbox/launch-readiness").LaunchReadinessPublicationResult;
type PortablePairingSettlementResult =
  import("../../src/lib/actions/sandbox/launch-readiness").PortableOpenClawPairingSettlementResult;

export const requireDist = createRequire(import.meta.url);
export const connectModulePath = "../../src/lib/actions/sandbox/connect.js";

// Warm the CommonJS source graph outside the first test's timeout. Each harness
// still reloads the entry module after installing its dependency spies.
requireDist(connectModulePath);
delete require.cache[requireDist.resolve(connectModulePath)];

export type ConnectHarness = {
  assertHermesPortableOperatingCommandCurrentSpy: MockInstance;
  applyVmDnsMonkeypatchSpy: MockInstance;
  captureOpenshellSpy: MockInstance;
  captureResolvedOpenshellSpy: MockInstance;
  checkAndRecoverSpy: MockInstance;
  connectSandbox: ConnectSandbox;
  ensureOllamaAuthProxySpy: MockInstance;
  findReachableOllamaHostSpy: MockInstance;
  ensureLiveSandboxSpy: MockInstance;
  getSandboxDockerRuntimeSpy: MockInstance;
  dockerStartSpy: MockInstance;
  errorSpy: MockInstance;
  logSpy: MockInstance;
  inspectLaunchReadinessSpy: MockInstance;
  launchReadinessMutationGateSpy: MockInstance;
  publishLaunchReadinessSpy: MockInstance;
  recoverHermesPortableOllamaInferenceSpy: MockInstance;
  settlePortablePairingSpy: MockInstance;
  preflightVllmSpy: MockInstance;
  probeLocalProviderHealthSpy: MockInstance;
  probeOllamaAuthProxyHealthSpy: MockInstance;
  readSandboxConfigSpy: MockInstance;
  recoverPortableDemoLifecycleSpy: MockInstance;
  requalifyPortableAgentAuthoritySpy: MockInstance;
  inspectPortableReceiptDispositionSpy: MockInstance;
  registryEntries: SandboxEntry[];
  resolveAgentConfigSpy: MockInstance;
  restoreSandboxStartupState: RestoreSandboxStartupState;
  runAutoPairSpy: MockInstance;
  runSandboxExecChildSpy: MockInstance;
  runOpenshellSpy: MockInstance;
  runSetupDnsProxySpy: MockInstance;
  spawnSyncSpy: MockInstance;
  withGatewayRouteMutationLockSpy: MockInstance;
  waitForSandboxReadyOrExit: WaitForSandboxReadyOrExit;
  writeSandboxConfigSpy: MockInstance;
};

export type ConnectHarnessOptions = {
  agentName?: string;
  inferenceGetOutput?: string;
  isWsl?: boolean;
  inferenceProbeResponses?: Array<
    string | { status?: number | null; output?: string | null; stderr?: string | null }
  >;
  hermesConfig?: ConfigObject;
  hermesInferenceRecoveryFailure?:
    | "authority-drift"
    | "runtime-restoration-unproved"
    | "registry-restoration-unproved"
    | "recovery-failed";
  hermesInferenceRecoveryPhase?:
    | "REGISTRY_PREPARATION_AUTHORITY"
    | "REGISTRY_PREPARATION_START_DISPATCH"
    | "REGISTRY_PREPARATION_SETTLEMENT_CURRENTNESS"
    | "REGISTRY_PREPARATION_NETWORK_INSPECTION"
    | "REGISTRY_PREPARATION_PINNED_REGISTRY_INSPECTION"
    | "REGISTRY_PREPARATION_PENDING_DEADLINE"
    | "REGISTRY_PREPARATION_POSTCONDITION"
    | "RUNTIME_AUTHORITY"
    | "LIFECYCLE_AUTHORITY"
    | "PRIVATE_PUBLICATION_AUTHORITY"
    | "EXACT_RUNTIME_INSPECTION";
  registryEntry?: Partial<SandboxEntry>;
  registryEntries?: Array<Partial<SandboxEntry> & Pick<SandboxEntry, "name">>;
  sessionAgent?: unknown;
  listOutput?: string;
  listOutputs?: string[];
  processCheck?: {
    checked: boolean;
    wasRunning?: boolean;
    recovered?: boolean;
    managedControlCompletion?: ManagedGatewayControlCompletion;
    forwardRecovered?: boolean;
    forwardRecoveryFailed?: boolean;
    forwardRecoveryFailureDetail?: string;
    recoveryFailureDetail?: string;
    secretBoundaryRefused?: boolean;
    secretBoundaryReason?: SecretBoundaryRefusalReason;
    mcpReconciliationRefused?: boolean;
    mcpReconciliationReason?: string;
  };
  portableRecoveryResult?: { kind: "not-installed" | "already-running" | "recovered" };
  portableReceiptDisposition?:
    | { kind: "absent" }
    | { kind: "openclaw" }
    | {
        kind: "hermes";
        phase: "pending" | "configuring" | "active";
        gatewayName?: string;
        lifecycleGeneration?: string;
      };
  dockerRuntime?: {
    health?: string;
    paused?: boolean;
    running?: boolean;
    containerName?: string | null;
  };
  dockerStartStatus?: number | null;
  spawnSignal?: NodeJS.Signals | null;
  spawnStatus?: number | null;
  sttyThrows?: boolean;
  withGatewayRouteMutationLock?: GatewayRouteMutationLock;
  readinessDecision?:
    | { kind: "accepted"; category: "accepted"; agent: unknown; sb: SandboxEntry }
    | {
        kind: "fallback";
        category: string;
        fence: { epochId: string } | null;
        gatewayName: string | null;
        gatewayPort: number | null;
        fenceFailed: boolean;
        recoveryBlocked: boolean;
        authorityUnsupported?: true;
      };
  readinessPublicationResult?: LaunchReadinessPublicationResult;
  portablePairingSettlementResult?: PortablePairingSettlementResult;
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
  const hermesInferenceRecovery = requireDist(
    "../../src/lib/actions/sandbox/probe/hermes-portable-inference-recovery.js",
  );
  const hermesOllamaInference = requireDist(
    "../../src/lib/onboard/experimental/hermes-portable-ollama-inference.js",
  );
  const processRecovery = requireDist("../../src/lib/actions/sandbox/process-recovery.js");
  const autoPairApproval = requireDist("../../src/lib/actions/sandbox/auto-pair-approval.js");
  const connectVllmPreflight = requireDist(
    "../../src/lib/actions/sandbox/connect-vllm-preflight.js",
  );
  const gatewayFailureClassifier = requireDist(
    "../../src/lib/actions/sandbox/gateway-failure-classifier.js",
  );
  const dockerHealth = requireDist("../../src/lib/actions/sandbox/docker-health.js");
  const dockerAdapter = requireDist("../../src/lib/adapters/docker/container.js");
  const localInference = requireDist("../../src/lib/inference/local.js");
  const ollamaProxy = requireDist("../../src/lib/inference/ollama/proxy.js");
  const platform = requireDist("../../src/lib/platform.js");
  const gatewayRouteMutationLock = requireDist(
    "../../src/lib/inference/gateway-route-mutation-lock.js",
  );
  const sandboxVersion = requireDist("../../src/lib/sandbox/version.js");
  const sandboxConfig = requireDist("../../src/lib/sandbox/config.js");
  const registry = requireDist("../../src/lib/state/registry.js");
  const sandboxSession = requireDist("../../src/lib/state/sandbox-session.js");
  const vmDnsMonkeypatch = requireDist("../../src/lib/actions/sandbox/vm-dns-monkeypatch.js");
  const launchReadiness = requireDist("../../src/lib/actions/sandbox/launch-readiness.js");
  const portableAgentLifecycle = requireDist(
    "../../src/lib/onboard/experimental/portable-agent-lifecycle.js",
  );
  const lifecycleLock = requireDist("../../src/lib/state/mcp-lifecycle-lock.js");
  const lifecycleLockAcquisition = requireDist(
    "../../src/lib/state/mcp-lifecycle-lock-acquisition.js",
  );

  vi.spyOn(lifecycleLock, "withMcpLifecycleLock").mockImplementation((async (
    _sandboxName: string,
    operation: () => Promise<unknown>,
  ) => operation()) as never);
  vi.spyOn(lifecycleLockAcquisition, "withMcpLifecycleLock").mockImplementation((async (
    _sandboxName: string,
    operation: () => Promise<unknown>,
  ) => operation()) as never);
  vi.spyOn(gatewayState, "withConnectSandboxLifecycleLock").mockImplementation((async (
    _sandboxName: string,
    operation: () => Promise<unknown>,
  ) => operation()) as never);
  vi.spyOn(gatewayState, "buildHermesPortableCommandEnvironment").mockReturnValue({
    HOME: "/home/test",
    XDG_CONFIG_HOME: "/home/test/.config",
    XDG_RUNTIME_DIR: "/run/user/1000",
  });
  vi.spyOn(gatewayState, "buildHermesPortableCommandAuthority").mockReturnValue({
    env: {
      HOME: "/home/test",
      XDG_CONFIG_HOME: "/home/test/.config",
      XDG_RUNTIME_DIR: "/run/user/1000",
    },
    executablePath: "/usr/bin/openshell",
  });
  const assertHermesPortableOperatingCommandCurrentSpy = vi.fn();
  vi.spyOn(gatewayState, "qualifyHermesPortableOperatingCommandAuthority").mockReturnValue({
    assertCurrent: assertHermesPortableOperatingCommandCurrentSpy,
    env: {
      HOME: "/home/test",
      XDG_CONFIG_HOME: "/home/test/.config",
      XDG_RUNTIME_DIR: "/run/user/1000",
    },
    executablePath: "/usr/bin/openshell",
  });
  vi.spyOn(gatewayState, "assertHermesPortableLifecycleForConnect").mockImplementation(
    () => undefined,
  );
  const requestedPortableDisposition = options.portableReceiptDisposition ?? { kind: "absent" };
  const portableDisposition =
    requestedPortableDisposition.kind === "hermes"
      ? {
          ...requestedPortableDisposition,
          gatewayName:
            requestedPortableDisposition.gatewayName ??
            options.registryEntry?.gatewayName ??
            "nemoclaw",
          lifecycleGeneration:
            requestedPortableDisposition.lifecycleGeneration ??
            options.registryEntry?.lifecycleGeneration ??
            "generation-1",
          liveIdentityFingerprint: "f".repeat(64),
        }
      : requestedPortableDisposition;
  const inspectPortableReceiptDispositionSpy = vi
    .spyOn(portableAgentLifecycle, "inspectPortableAgentReceiptDisposition")
    .mockReturnValue(portableDisposition);
  let registryEntries: SandboxEntry[] = [];
  const qualifyPortableAgentLifecycleAuthority =
    portableAgentLifecycle.qualifyPortableAgentLifecycleAuthority;
  const requireHermesPortableActiveLifecycleAuthority =
    portableAgentLifecycle.requireHermesPortableActiveLifecycleAuthority;
  const portableAuthorityDeps = () => ({
    inspectReceiptDisposition: (sandboxName: string) =>
      portableAgentLifecycle.inspectPortableAgentReceiptDisposition(sandboxName),
    readRegistry: (sandboxName: string) =>
      registryEntries.find((candidate) => candidate.name === sandboxName) ?? null,
  });
  vi.spyOn(gatewayState, "qualifyPortableAgentLifecycleAuthority").mockImplementation(((
    sandboxName: string,
  ) => qualifyPortableAgentLifecycleAuthority(sandboxName, portableAuthorityDeps())) as never);
  vi.spyOn(gatewayState, "requireHermesPortableActiveLifecycleAuthority").mockImplementation(((
    sandboxName: string,
    expected: unknown,
  ) =>
    requireHermesPortableActiveLifecycleAuthority(
      sandboxName,
      expected,
      portableAuthorityDeps(),
    )) as never);
  const recoverHermesPortableOllamaInferenceSpy = vi
    .spyOn(hermesInferenceRecovery, "recoverHermesPortableInferenceForConnectProbe")
    .mockImplementation(((input: {
      verifyRoute: () => unknown;
      prepareProbeDependency?: () => { release: () => void };
    }) => {
      if (options.hermesInferenceRecoveryPhase) {
        throw new hermesOllamaInference.HermesPortableOllamaRecoveryPhaseError(
          options.hermesInferenceRecoveryPhase,
        );
      }
      if (options.hermesInferenceRecoveryFailure === "recovery-failed") {
        throw new Error("nested recovery diagnostic canary");
      }
      if (options.hermesInferenceRecoveryFailure) {
        throw new hermesOllamaInference.HermesPortableOllamaRecoveryError(
          options.hermesInferenceRecoveryFailure,
          "nested recovery diagnostic canary",
        );
      }
      input.verifyRoute();
      input.prepareProbeDependency?.().release();
      return "reused";
    }) as never);
  const requalifyPortableAgentAuthoritySpy = vi
    .spyOn(gatewayState, "requalifyPortableAgentSandboxAuthority")
    .mockReturnValue({ kind: "not-hermes" });
  const sandboxExec = requireDist("../../src/lib/actions/sandbox/exec.js");
  const runSandboxExecChildSpy = vi.spyOn(sandboxExec, "runSandboxExecChild").mockResolvedValue({
    status: spawnStatusFromOptions(options),
    signal: options.spawnSignal ?? null,
  });

  const inspectLaunchReadinessSpy = vi
    .spyOn(launchReadiness, "inspectLaunchReadiness")
    .mockResolvedValue(
      options.readinessDecision ?? {
        kind: "fallback",
        category: "missing",
        fence: { epochId: "a".repeat(64) },
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        fenceFailed: false,
        recoveryBlocked: false,
      },
    );
  const publishLaunchReadinessSpy = vi
    .spyOn(launchReadiness, "publishLaunchReadiness")
    .mockResolvedValue(options.readinessPublicationResult ?? { kind: "published" });
  const launchReadinessMutationGateSpy = vi
    .spyOn(launchReadiness, "withLaunchReadinessMutationGate")
    .mockImplementation((async (...args: unknown[]) => {
      const operation = args[1] as () => unknown;
      return { kind: "entered", value: await operation() };
    }) as never);
  const preflightVllmSpy = vi
    .spyOn(connectVllmPreflight, "preflightVllmModelEnvOrExit")
    .mockImplementation(() => undefined);
  const ensureLiveSandboxSpy = vi.spyOn(gatewayState, "ensureLiveSandboxOrExit").mockResolvedValue({
    state: "present",
    output: "Name: alpha\nPhase: Ready\n",
  });
  vi.spyOn(gatewayFailureClassifier, "isDockerRuntimeDown").mockReturnValue(false);
  const getSandboxDockerRuntimeSpy = vi
    .spyOn(dockerHealth, "getSandboxDockerRuntime")
    .mockReturnValue({
      health: options.dockerRuntime?.health ?? "healthy",
      paused: options.dockerRuntime?.paused ?? false,
      running: options.dockerRuntime?.running ?? true,
      containerName: options.dockerRuntime?.containerName ?? null,
    });
  const dockerStartSpy = vi.spyOn(dockerAdapter, "dockerStart").mockReturnValue({
    status: options.dockerStartStatus === undefined ? 0 : options.dockerStartStatus,
  });
  const inferenceProbeResponses = [...(options.inferenceProbeResponses ?? [])];
  const listOutputs = [...(options.listOutputs ?? [])];
  const captureOpenshellImplementation = (args: unknown) => {
    const argv = Array.isArray(args) ? args : [];
    if (argv[0] === "sandbox" && argv[1] === "list") {
      return {
        status: 0,
        output:
          listOutputs.shift() ??
          options.listOutput ??
          `${options.registryEntry?.name ?? "alpha"} Ready`,
      };
    }
    if (argv[0] === "inference" && argv[1] === "get") {
      return {
        status: 0,
        output:
          options.inferenceGetOutput ??
          (options.agentName === "hermes"
            ? "Gateway inference:\n  Provider: ollama-local\n  Model: qwen3-vl:4b\n"
            : "Provider: unknown\nModel: unknown\n"),
      };
    }
    if (argv[0] === "forward" && argv[1] === "list") {
      const sandboxName = String(registryEntries[0]?.name ?? "alpha");
      const port = String(registryEntries[0]?.dashboardPort ?? 18_789);
      return {
        status: 0,
        output: `SANDBOX BIND PORT PID STATUS\n${sandboxName} 127.0.0.1 ${port} 12345 running`,
      };
    }
    if (
      argv[0] === "sandbox" &&
      argv[1] === "exec" &&
      argv.join(" ").includes("inference.local/v1/models")
    ) {
      const response = inferenceProbeResponses.shift() ?? "OK 200";
      return typeof response === "string" ? { status: 0, output: response } : response;
    }
    return { status: 0, output: "" };
  };
  const captureOpenshellSpy = vi
    .spyOn(runtime, "captureOpenshell")
    .mockImplementation(captureOpenshellImplementation);
  const captureResolvedOpenshellSpy = vi
    .spyOn(runtime, "captureResolvedOpenshell")
    .mockImplementation(captureOpenshellImplementation);
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
  const recoverPortableDemoLifecycleSpy = vi
    .spyOn(gatewayState, "recoverPortableDemoSandboxLifecycleForConnect")
    .mockReturnValue(options.portableRecoveryResult ?? { kind: "not-installed" });
  const ensureOllamaAuthProxySpy = vi
    .spyOn(ollamaProxy, "ensureOllamaAuthProxy")
    .mockImplementation(() => undefined);
  const findReachableOllamaHostSpy = vi
    .spyOn(localInference, "findReachableOllamaHost")
    .mockReturnValue("127.0.0.1");
  const probeLocalProviderHealthSpy = vi
    .spyOn(localInference, "probeLocalProviderHealth")
    .mockReturnValue({ ok: true });
  const probeOllamaAuthProxyHealthSpy = vi
    .spyOn(ollamaProxy, "probeOllamaAuthProxyHealth")
    .mockReturnValue({ ok: true });
  const realIsWsl = platform.isWsl as (opts?: WslDetectionOptions) => boolean;
  // Pin the platform gate for every isWsl consumer the harness loads: isWsl
  // answers false off Linux before it reads WSL_DISTRO_NAME, so a case that
  // stubs that variable cannot reach the WSL route on a macOS contributor
  // machine. With the gate pinned, the stubbed environment decides, on every
  // host, and a caller's own options still win over the pin (#8868).
  vi.spyOn(platform, "isWsl").mockImplementation((...args: unknown[]) =>
    typeof options.isWsl === "boolean"
      ? options.isWsl
      : realIsWsl({ platform: "linux", ...((args[0] as WslDetectionOptions | undefined) ?? {}) }),
  );
  const primaryRegistryEntry: SandboxEntry = {
    name: "alpha",
    agent: options.agentName ?? "openclaw",
    provider: options.agentName === "hermes" ? "ollama-local" : null,
    model: options.agentName === "hermes" ? "qwen3-vl:4b" : null,
    lifecycleLiveIdentityFingerprint:
      portableDisposition.kind === "hermes"
        ? portableDisposition.liveIdentityFingerprint
        : undefined,
    gpuEnabled: false,
    policies: [],
    ...(portableDisposition.kind === "hermes"
      ? {
          openshellDriver: "docker",
          gatewayName: portableDisposition.gatewayName,
          lifecycleGeneration: portableDisposition.lifecycleGeneration,
          lifecycleLiveIdentityFingerprint: portableDisposition.liveIdentityFingerprint,
        }
      : {}),
    ...options.registryEntry,
  };
  registryEntries = options.registryEntries
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
  const hermesConfigTarget = {
    agentName: "hermes",
    configPath: "/sandbox/.hermes/config.yaml",
    configDir: "/sandbox/.hermes",
    format: "yaml",
    configFile: "config.yaml",
    sensitiveFiles: ["/sandbox/.hermes/.config-hash", "/sandbox/.hermes/.env"],
    stateLockPlanInImage: true,
  };
  const resolveAgentConfigSpy = vi
    .spyOn(sandboxConfig, "resolveAgentConfig")
    .mockImplementation((name: unknown) => {
      const entry = registryEntries.find((candidate) => candidate.name === String(name));
      return entry?.agent === "hermes" ? hermesConfigTarget : sandboxConfig.DEFAULT_AGENT_CONFIG;
    });
  const readSandboxConfigSpy = vi
    .spyOn(sandboxConfig, "readSandboxConfig")
    .mockReturnValue(options.hermesConfig ?? {});
  const writeSandboxConfigSpy = vi
    .spyOn(sandboxConfig, "writeSandboxConfig")
    .mockImplementation(() => undefined);
  // - `getSessionAgent` returns null for OpenClaw, which `??` alone turned into `{ name: "openclaw" }`.
  // - Distinguish "not supplied" from an explicit null so a test can model that production shape.
  vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue(
    (Object.hasOwn(options, "sessionAgent") ? options.sessionAgent : { name: "openclaw" }) as never,
  );
  vi.spyOn(agentRuntime, "getAgentDisplayName").mockReturnValue("OpenClaw");
  const runAutoPairSpy = vi
    .spyOn(autoPairApproval, "runConnectAutoPairApprovalPass")
    .mockImplementation(() => undefined);
  const settlePortablePairingSpy = vi
    .spyOn(launchReadiness, "settlePortableOpenClawPairing")
    .mockResolvedValue(options.portablePairingSettlementResult ?? { kind: "not-portable" });

  logSpy.mockClear();
  errorSpy.mockClear();
  spawnSyncSpy.mockClear();

  return {
    assertHermesPortableOperatingCommandCurrentSpy,
    applyVmDnsMonkeypatchSpy,
    captureOpenshellSpy,
    captureResolvedOpenshellSpy,
    checkAndRecoverSpy,
    connectSandbox: requireDist(connectModulePath).connectSandbox,
    ensureOllamaAuthProxySpy,
    findReachableOllamaHostSpy,
    ensureLiveSandboxSpy,
    getSandboxDockerRuntimeSpy,
    dockerStartSpy,
    errorSpy,
    logSpy,
    inspectLaunchReadinessSpy,
    launchReadinessMutationGateSpy,
    publishLaunchReadinessSpy,
    recoverHermesPortableOllamaInferenceSpy,
    preflightVllmSpy,
    probeLocalProviderHealthSpy,
    probeOllamaAuthProxyHealthSpy,
    readSandboxConfigSpy,
    recoverPortableDemoLifecycleSpy,
    requalifyPortableAgentAuthoritySpy,
    inspectPortableReceiptDispositionSpy,
    registryEntries,
    resolveAgentConfigSpy,
    restoreSandboxStartupState: requireDist(connectModulePath).restoreSandboxStartupState,
    runAutoPairSpy,
    runSandboxExecChildSpy,
    settlePortablePairingSpy,
    runOpenshellSpy,
    runSetupDnsProxySpy,
    spawnSyncSpy,
    withGatewayRouteMutationLockSpy,
    waitForSandboxReadyOrExit: requireDist(connectModulePath).waitForSandboxReadyOrExit,
    writeSandboxConfigSpy,
  };
}
