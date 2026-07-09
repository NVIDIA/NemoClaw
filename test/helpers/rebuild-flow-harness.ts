// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import path from "node:path";

import { type MockInstance, vi } from "vitest";

type RebuildSandbox = typeof import("../../src/lib/actions/sandbox/rebuild")["rebuildSandbox"];

const requireDist = createRequire(
  path.join(process.cwd(), "src/lib/actions/sandbox/rebuild-flow-harness.ts"),
);
const rebuildModulePath = "./rebuild.js";

// Warm the CommonJS source graph outside the first test's timeout. Each harness
// still reloads the entry module after installing its dependency spies.
requireDist(rebuildModulePath);
delete require.cache[requireDist.resolve(rebuildModulePath)];

// Cache stable dependency modules outside each test's timeout. The rebuild
// entry itself is still reloaded after these modules receive fresh spies.
const gatewayDrift = requireDist("../../adapters/openshell/gateway-drift.js");
const openshellRuntime = requireDist("../../adapters/openshell/runtime.js");
const dockerImage = requireDist("../../adapters/docker/image.js");
const dockerInspect = requireDist("../../adapters/docker/inspect.js");
const sandboxList = requireDist("../../openshell-sandbox-list.js");
const resolve = requireDist("../../adapters/openshell/resolve.js");
const agentDefs = requireDist("../../agent/defs.js");
const agentOnboard = requireDist("../../agent/onboard.js");
const agentRuntime = requireDist("../../agent/runtime.js");
const gatewayRuntime = requireDist("../../gateway-runtime-action.js");
const gatewayState = requireDist("./gateway-state.js");
const { rebuildOnboardDependencies } = requireDist("./rebuild-onboard-dependencies.js");
const onboardCredentialEnv = requireDist("../../onboard/credential-env.js");
const onboardSession = requireDist("../../state/onboard-session.js");
const registry = requireDist("../../state/registry.js");
const sandboxState = requireDist("../../state/sandbox.js");
const sandboxSession = requireDist("../../state/sandbox-session.js");
const sandboxVersion = requireDist("../../sandbox/version.js");
const destroy = requireDist("./destroy.js");
const rebuildShields = requireDist("./rebuild-shields.js");
const nim = requireDist("../../inference/nim.js");
const policies = requireDist("../../policy/index.js");
const processRecovery = requireDist("./process-recovery.js");
const messagingHostForwardLifecycle = requireDist("./messaging-host-forward-lifecycle.js");
const messaging = requireDist("../../messaging/index.js");
const mcpBridge = requireDist("./mcp-bridge.js");
const rebuildCustomImagePreflight = requireDist("./rebuild-custom-image-preflight.js");
const rebuildInference = requireDist("./rebuild-inference-preflight.js");
const rebuildFlowHelpers = requireDist("./rebuild-flow-helpers.js");
const rebuildManagedImage = requireDist("./rebuild-managed-image-preflight.js");
const rebuildMessagingConflict = requireDist("./rebuild-messaging-conflict-preflight.js");
const shields = requireDist("../../shields/index.js");

type RebuildFlowStep = {
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
};

export type RebuildFlowSession = Record<string, unknown> & {
  lastStepStarted: string | null;
  status: string;
  failure: { step: string; message: string | null; recordedAt: string } | null;
  machine: {
    version: number;
    state: string;
    stateEnteredAt: string;
    revision: number;
  };
  steps: Record<string, RebuildFlowStep>;
};

export type RebuildFlowOverrides = {
  agentName?: string;
  applyPreset?: (presetName: string) => boolean;
  executeSandboxCommand?: () => { status: number; stdout: string; stderr: string } | null;
  onboard?: (session: RebuildFlowSession) => Promise<void> | void;
  repairMutableConfigPerms?: () =>
    | { applied: false; skipReason: "agent" | "locked" | "unreadable"; reason: string }
    | { applied: true; verified: boolean; errors: string[] };
  restoreSandboxState?: () => {
    success: boolean;
    restoredDirs: string[];
    restoredFiles: string[];
    failedDirs: string[];
    failedFiles: string[];
  };
  buildMessagingRebuildPlan?: () => Promise<unknown> | unknown;
  sandboxEntry?: Record<string, unknown>;
  sandboxEntryReads?: Array<Record<string, unknown> | null>;
  sessionSandboxName?: string;
  sandboxListOutput?: string;
  backupPolicyPresets?: string[];
  gatewayPresets?: string[];
  verificationUnavailableAfterPresetRemoval?: boolean;
  preDeleteSandboxEntry?: Record<string, unknown>;
  preDeleteDefaultSandbox?: string | null;
  preDeleteLatestManifest?: Record<string, unknown> | null;
  recoveryManifestValidation?: (
    manifest: Record<string, unknown>,
  ) => { ok: true; manifest: Record<string, unknown> } | { ok: false; reason: string };
  managedImageEvidence?: boolean;
  updateSession?: () => void;
  dcodeRouteResults?: Array<{ ok: true } | { ok: false; detail: string }>;
  gatewayRecoveryResult?: Record<string, unknown>;
  reconciledSandboxGatewayState?: Record<string, unknown>;
  dcodeImageVerificationResults?: boolean[];
  dcodeBaseImageIds?: string[];
  sandboxBaseImageLabelsOutput?: string;
  dcodeImageResult?:
    | { ok: true; prepared: Record<string, unknown> & { cleanupBuildCtx: () => boolean } }
    | { ok: false; detail: string };
  openShieldsWindow?: () => { relocked: boolean; wasLocked: boolean } | null;
  preflightMessagingConflicts?: () => Promise<void> | void;
  preflightAuthoritativeRebuildTarget?: (options: Record<string, unknown>) => Promise<void> | void;
  mcpPreparation?: {
    entries: Array<Record<string, unknown>>;
    detachedProviderEntries: Array<Record<string, unknown>>;
    scrubbedAdapterEntries: Array<Record<string, unknown>>;
  };
};

export type RebuildFlowHarness = {
  rebuildSandbox: RebuildSandbox;
  applyPresetSpy: MockInstance;
  applyPresetContentSpy: MockInstance;
  backupSandboxStateSpy: MockInstance;
  disposePreparedDcodeRebuildImageSpy: MockInstance;
  errorSpy: MockInstance;
  ensureAgentBaseImageSpy: MockInstance;
  executeSandboxCommandSpy: MockInstance;
  ensureMessagingHostForwardAfterRebuildSpy: MockInstance;
  logSpy: MockInstance;
  finalizeIncompleteOnboardStepSpy: MockInstance;
  openShieldsSpy: MockInstance;
  onboardSpy: MockInstance;
  preflightAuthoritativeRebuildTargetSpy: MockInstance;
  preflightMessagingConflictsSpy: MockInstance;
  preflightDcodeRouteSpy: MockInstance;
  prepareManagedDcodeRebuildImageSpy: MockInstance;
  removePresetSpy: MockInstance;
  removeSandboxRegistryEntrySpy: MockInstance;
  registryUpdateSpy: MockInstance;
  releaseOnboardLockSpy: MockInstance;
  relockSpy: MockInstance;
  restoreSandboxEntrySpy: MockInstance;
  restoreRegistryEntryIfMissingSpy: MockInstance;
  restoreSandboxStateSpy: MockInstance;
  runOpenshellSpy: MockInstance;
  messagingRebuildPlanSpy: MockInstance;
  prepareMcpBridgesForRebuildSpy: MockInstance;
  reattachMcpProvidersAfterRebuildAbortSpy: MockInstance;
  restoreMcpBridgesAfterRebuildSpy: MockInstance;
  warnUnpreservedUserManagedFilesSpy: MockInstance;
  preparedDcodeBuildContext: Record<string, unknown> & { cleanupBuildCtx: MockInstance };
  session: RebuildFlowSession;
};

// Snapshot the given env vars and return a restore fn that reinstates their
// prior values exactly — vars that were unset stay unset, set ones are put back.
// Branchless on purpose (filter, not conditional restore) so it both restores
// worker state correctly and keeps the changed-test-file guardrail green.
export function snapshotEnv(names: readonly string[]): () => void {
  const saved = names.map((name) => [name, process.env[name]] as const);
  return () => {
    for (const [name] of saved) {
      delete process.env[name];
    }
    Object.assign(
      process.env,
      Object.fromEntries(
        saved.filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
    );
  };
}

const restoreRebuildFlowEnv = snapshotEnv([
  "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
  "NEMOCLAW_SANDBOX_NAME",
]);

export function resetRebuildFlowTestEnvironment(): void {
  delete process.env.NEMOCLAW_SANDBOX_NAME;
  process.env.NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE = "1";
}

export function restoreRebuildFlowTestEnvironment(): void {
  vi.restoreAllMocks();
  delete require.cache[requireDist.resolve(rebuildModulePath)];
  restoreRebuildFlowEnv();
}

function createStep(status: string): RebuildFlowStep {
  return { status, startedAt: null, completedAt: null, error: null };
}

function createRebuildFlowSession(machineSnapshotVersion: number): RebuildFlowSession {
  return {
    sandboxName: "alpha",
    provider: "ollama-local",
    model: "nvidia/nemotron",
    credentialEnv: null,
    metadata: {},
    hermesToolGateways: [],
    lastStepStarted: null,
    status: "in_progress",
    failure: null,
    machine: {
      version: machineSnapshotVersion,
      state: "gateway",
      stateEnteredAt: "2026-06-01T00:00:00.000Z",
      revision: 2,
    },
    steps: {
      preflight: createStep("complete"),
      gateway: createStep("complete"),
      provider_selection: createStep("pending"),
      inference: createStep("pending"),
      sandbox: createStep("pending"),
      openclaw: createStep("pending"),
      agent_setup: createStep("pending"),
      policies: createStep("pending"),
    },
  };
}

function installTerminalStepFailureMock(
  onboardSession: { finalizeIncompleteOnboardStep: (...args: unknown[]) => unknown },
  session: RebuildFlowSession,
): MockInstance {
  return vi
    .spyOn(onboardSession, "finalizeIncompleteOnboardStep")
    .mockImplementation((stepName: unknown, message: unknown) => {
      if (session.machine.state === "failed" || session.machine.state === "complete") {
        return session;
      }
      const stepKey = String(stepName);
      const step = session.steps[stepKey];
      if (!step) return session;
      step.status = "failed";
      step.error = typeof message === "string" ? message : null;
      session.status = "failed";
      session.failure = {
        step: stepKey,
        message: typeof message === "string" ? message : null,
        recordedAt: "2026-06-01T00:02:00.000Z",
      };
      session.machine.state = "failed";
      session.machine.revision += 1;
      return session;
    });
}

export function createRebuildFlowHarness(overrides: RebuildFlowOverrides = {}): RebuildFlowHarness {
  delete require.cache[requireDist.resolve(rebuildModulePath)];

  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

  const session = createRebuildFlowSession(onboardSession.MACHINE_SNAPSHOT_VERSION);
  const rebuildShieldsWindow = { relocked: false, wasLocked: false };
  const agentName = overrides.agentName ?? "openclaw";
  const agentDef = {
    name: agentName,
    expectedVersion: "0.2.0",
    dockerfileBasePath: "/tmp/Dockerfile.base",
    runtime: { kind: "terminal" },
  };

  vi.spyOn(gatewayDrift, "detectOpenShellStateRpcPreflightIssue").mockReturnValue(null);
  vi.spyOn(gatewayDrift, "detectOpenShellStateRpcResultIssue").mockReturnValue(null);
  vi.spyOn(sandboxList, "captureSandboxListWithGatewayRecovery").mockResolvedValue({
    result: { status: 0, output: overrides.sandboxListOutput ?? "alpha Ready" },
  });
  vi.spyOn(resolve, "resolveOpenshell").mockReturnValue(null);
  vi.spyOn(dockerImage, "dockerBuild").mockReturnValue({ status: 0 });
  vi.spyOn(rebuildCustomImagePreflight, "preflightRebuildImage").mockResolvedValue({
    ok: true,
    imageTag: null,
  });
  const dcodeBaseImageIds = [...(overrides.dcodeBaseImageIds ?? [])];
  vi.spyOn(dockerInspect, "dockerImageInspectFormat").mockImplementation((...args: unknown[]) =>
    args[0] === "{{json .Config.Labels}}" && overrides.sandboxBaseImageLabelsOutput !== undefined
      ? overrides.sandboxBaseImageLabelsOutput
      : (dcodeBaseImageIds.shift() ?? "sha256:dcode-base"),
  );
  vi.spyOn(dockerImage, "dockerRmi").mockReturnValue({ status: 0 });
  vi.spyOn(agentDefs, "loadAgent").mockReturnValue(agentDef);
  const ensureAgentBaseImageSpy = vi.spyOn(agentOnboard, "ensureAgentBaseImage").mockReturnValue({
    imageTag: `nemoclaw-${agentName}-base:test`,
    built: true,
  });
  vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({ name: agentName });
  vi.spyOn(agentRuntime, "getAgentDisplayName").mockReturnValue(
    agentName === "langchain-deepagents-code" ? "Deep Agents Code" : "OpenClaw",
  );
  vi.spyOn(gatewayRuntime, "recoverNamedGatewayRuntime").mockImplementation(
    async (...args: unknown[]) => {
      const gatewayName =
        (args[0] as { gatewayName?: string } | undefined)?.gatewayName ?? "nemoclaw";
      const state = { state: "healthy_named", activeGateway: gatewayName };
      return (
        overrides.gatewayRecoveryResult ?? {
          recovered: true,
          attempted: false,
          before: state,
          after: state,
        }
      );
    },
  );
  vi.spyOn(gatewayState, "getReconciledSandboxGatewayState").mockResolvedValue(
    overrides.reconciledSandboxGatewayState ?? { state: "present", output: "alpha Ready" },
  );
  vi.spyOn(onboardSession, "loadSession").mockReturnValue(session);
  vi.spyOn(onboardSession, "acquireOnboardLock").mockReturnValue({ acquired: true });
  vi.spyOn(onboardSession, "updateSession").mockImplementation((mutator: unknown) => {
    overrides.updateSession?.();
    if (typeof mutator !== "function") {
      throw new TypeError("updateSession expected a mutator function");
    }
    (mutator as (value: typeof session) => typeof session | void)(session);
    return session;
  });
  const releaseOnboardLockSpy = vi
    .spyOn(onboardSession, "releaseOnboardLock")
    .mockImplementation(() => undefined);
  const finalizeIncompleteOnboardStepSpy = installTerminalStepFailureMock(onboardSession, session);
  session.sandboxName = overrides.sessionSandboxName ?? session.sandboxName;
  const sandboxEntry = {
    name: "alpha",
    provider: "ollama-local",
    model: "nvidia/nemotron",
    policies: ["npm"],
    agent: null,
    agentVersion: "0.1.0",
    // A current managed-image registry row carries positive NemoClaw provenance.
    // Tests that exercise the legacy ambiguous-image path override this explicitly.
    nemoclawVersion: "0.0.71",
    nimContainer: null,
    ...(overrides.sandboxEntry ?? {}),
  };
  const preDeleteDefaultSandbox =
    overrides.preDeleteDefaultSandbox === undefined ? "alpha" : overrides.preDeleteDefaultSandbox;
  let sandboxEntryReadCount = 0;
  vi.spyOn(registry, "getSandbox").mockImplementation(() => {
    const configuredReads = overrides.sandboxEntryReads ?? [];
    return (
      sandboxEntryReadCount < configuredReads.length
        ? configuredReads[sandboxEntryReadCount++]
        : sandboxEntry
    ) as never;
  });
  let registryLoadCount = 0;
  vi.spyOn(registry, "load").mockImplementation(() => {
    const isPreDeleteRead = registryLoadCount > 0;
    registryLoadCount++;
    return {
      defaultSandbox: isPreDeleteRead ? preDeleteDefaultSandbox : "alpha",
      sandboxes: {
        alpha:
          isPreDeleteRead && overrides.preDeleteSandboxEntry
            ? overrides.preDeleteSandboxEntry
            : sandboxEntry,
      },
    };
  });
  vi.spyOn(registry, "listSandboxes").mockReturnValue({ sandboxes: [] });
  const registryUpdateSpy = vi.spyOn(registry, "updateSandbox").mockReturnValue(true);
  const restoreSandboxEntrySpy = vi
    .spyOn(registry, "restoreSandboxEntry")
    .mockImplementation(() => undefined);
  const restoreRegistryEntryIfMissingSpy = vi
    .spyOn(registry, "restoreSandboxEntryIfMissing")
    .mockReturnValue(true);
  vi.spyOn(sandboxSession, "getActiveSandboxSessions").mockReturnValue({
    detected: false,
    sessions: [],
  });
  vi.spyOn(sandboxVersion, "checkAgentVersion").mockReturnValue({
    expectedVersion: "0.2.0",
    sandboxVersion: "0.1.0",
  });
  vi.spyOn(nim, "detectGpu").mockReturnValue(null);
  const routeResults = [...(overrides.dcodeRouteResults ?? [{ ok: true }])];
  const preflightDcodeRouteSpy = vi
    .spyOn(rebuildInference, "preflightRebuildInferenceRoute")
    .mockImplementation(() => routeResults.shift() ?? { ok: true });
  const preparedDcodeBuildContext = {
    buildCtx: "/tmp/dcode-rebuild-context",
    stagedDockerfile: "/tmp/dcode-rebuild-context/Dockerfile",
    buildId: "dcode-build",
    contextFingerprint: "dcode-context",
    dockerGpuPatchNetwork: null,
    cleanupBuildCtx: vi.fn(() => true),
  };
  const prepareManagedDcodeRebuildImageSpy = vi
    .spyOn(rebuildManagedImage, "prepareManagedDcodeRebuildImage")
    .mockImplementation(
      async () =>
        (overrides.dcodeImageResult ?? {
          ok: true,
          prepared: preparedDcodeBuildContext,
        }) as never,
    );
  const disposePreparedDcodeRebuildImageSpy = vi
    .spyOn(rebuildManagedImage, "disposePreparedDcodeRebuildImage")
    .mockImplementation((prepared: unknown) =>
      (prepared as { cleanupBuildCtx: () => boolean }).cleanupBuildCtx(),
    );
  const imageVerificationResults = [...(overrides.dcodeImageVerificationResults ?? [true])];
  vi.spyOn(rebuildManagedImage, "verifyPreparedDcodeRebuildImage").mockImplementation(
    () => imageVerificationResults.shift() ?? true,
  );
  const openShieldsSpy = vi
    .spyOn(rebuildShields, "openRebuildShieldsWindow")
    .mockImplementation(overrides.openShieldsWindow ?? (() => rebuildShieldsWindow));
  const relockSpy = vi
    .spyOn(rebuildShields, "relockRebuildShieldsWindow")
    .mockImplementation((...args: unknown[]) => {
      const window = args[1] as typeof rebuildShieldsWindow;
      window.relocked = true;
      return true;
    });
  const backupSandboxStateSpy = vi.spyOn(sandboxState, "backupSandboxState").mockReturnValue({
    success: true,
    backedUpDirs: ["workspace"],
    backedUpFiles: ["user.md"],
    failedDirs: [],
    failedFiles: [],
    manifest: {
      agentType: overrides.agentName ?? "openclaw",
      backupPath: "/tmp/nemoclaw-rebuild-backup",
      timestamp: "2026-06-01T00:00:00.000Z",
      policyPresets: overrides.backupPolicyPresets ?? ["npm", "bad", "throw"],
    },
  });
  vi.spyOn(sandboxState, "validateRebuildRecoveryManifest").mockImplementation(
    (...args: unknown[]) => {
      const manifest = args[2] as Record<string, unknown>;
      return overrides.recoveryManifestValidation?.(manifest) ?? { ok: true as const, manifest };
    },
  );
  vi.spyOn(sandboxState, "getLatestBackup").mockImplementation(
    () =>
      (overrides.preDeleteLatestManifest === undefined
        ? makePreparedRecoveryManifest()
        : overrides.preDeleteLatestManifest) as ReturnType<typeof sandboxState.getLatestBackup>,
  );
  vi.spyOn(sandboxState, "hasPositiveManagedImageEvidence").mockReturnValue(
    overrides.managedImageEvidence ?? true,
  );
  const restoreSandboxStateSpy = vi
    .spyOn(sandboxState, "restoreRecreatedSandboxState")
    .mockImplementation(
      overrides.restoreSandboxState ??
        (() => ({
          success: true,
          restoredDirs: ["workspace"],
          restoredFiles: ["user.md"],
          failedDirs: [],
          failedFiles: [],
        })),
    );
  const runOpenshellSpy = vi.spyOn(openshellRuntime, "runOpenshell").mockImplementation((args) => {
    const argv = args as string[];
    return argv[0] === "provider" && argv[1] === "get"
      ? {
          status: 0,
          stdout:
            "Name: compatible-endpoint\nType: openai\nCredential keys: COMPATIBLE_API_KEY\nConfig keys: OPENAI_BASE_URL\n",
          stderr: "",
        }
      : { status: 0, output: "" };
  });
  const removeSandboxRegistryEntrySpy = vi
    .spyOn(destroy, "removeSandboxRegistryEntryWithReceipt")
    .mockReturnValue({
      entry: { name: "alpha", imageTag: "old-image" },
      wasDefault: preDeleteDefaultSandbox === "alpha",
      fallbackDefault: null,
      postRemovalDefaultSelectionRevision: 1,
    });
  vi.spyOn(nim, "stopNimContainer").mockImplementation(() => undefined);
  vi.spyOn(nim, "stopNimContainerByName").mockImplementation(() => undefined);
  const onboardSpy = vi
    .spyOn(rebuildOnboardDependencies, "onboard")
    .mockImplementation(async () => {
      await overrides.onboard?.(session);
    });
  vi.spyOn(rebuildOnboardDependencies, "hydrateCredentialEnv").mockImplementation(
    (...args: unknown[]) => onboardCredentialEnv.hydrateCredentialEnv(String(args[0] ?? "")),
  );
  const preflightAuthoritativeRebuildTargetSpy = vi
    .spyOn(rebuildOnboardDependencies, "preflightAuthoritativeRebuildTarget")
    .mockImplementation(async (options: unknown) => {
      await overrides.preflightAuthoritativeRebuildTarget?.(
        (options ?? {}) as Record<string, unknown>,
      );
    });
  const livePolicyPresets = new Set(overrides.gatewayPresets ?? []);
  const managedObservabilityPreset = "observability-otlp-local";
  const managedObservabilityContent =
    "network_policies:\n  observability-otlp-local:\n    name: observability-otlp-local\n";
  let liveManagedObservabilityContent = livePolicyPresets.has(managedObservabilityPreset)
    ? managedObservabilityContent
    : null;
  let policyRemovalObserved = false;
  const applyPresetSpy = vi
    .spyOn(policies, "applyPreset")
    .mockImplementation((_sandboxName: unknown, presetName: unknown) => {
      const normalizedPresetName = String(presetName);
      let applied: boolean;
      if (overrides.applyPreset) {
        applied = overrides.applyPreset(normalizedPresetName);
      } else if (normalizedPresetName === "throw") {
        throw new Error("preset boom");
      } else {
        applied = normalizedPresetName === "npm";
      }
      if (applied) {
        livePolicyPresets.add(normalizedPresetName);
        if (normalizedPresetName === managedObservabilityPreset) {
          liveManagedObservabilityContent = managedObservabilityContent;
        }
      }
      return applied;
    });
  const applyPresetContentSpy = vi
    .spyOn(policies, "applyPresetContent")
    .mockImplementation((_sandboxName: unknown, presetName: unknown, presetContent: unknown) => {
      livePolicyPresets.add(String(presetName));
      const content = String(presetContent);
      if (policies.parsePresetPolicyKeys(content).includes(managedObservabilityPreset)) {
        liveManagedObservabilityContent = content;
      }
      return true;
    });
  vi.spyOn(policies, "loadPresetForSandbox").mockImplementation(
    (_sandboxName: unknown, presetName: unknown) =>
      String(presetName) === managedObservabilityPreset ? managedObservabilityContent : null,
  );
  vi.spyOn(policies, "getPresetContentGatewayState").mockImplementation(
    (_sandboxName: unknown, presetContent: unknown) => {
      if (overrides.verificationUnavailableAfterPresetRemoval && policyRemovalObserved) return null;
      const content = String(presetContent);
      if (!policies.parsePresetPolicyKeys(content).includes(managedObservabilityPreset)) {
        return "absent";
      }
      if (liveManagedObservabilityContent === null) return "absent";
      return liveManagedObservabilityContent === content ? "match" : "drift";
    },
  );
  vi.spyOn(policies, "getGatewayPresets").mockImplementation(() =>
    overrides.verificationUnavailableAfterPresetRemoval && policyRemovalObserved
      ? null
      : [...livePolicyPresets],
  );
  const removePresetSpy = vi
    .spyOn(policies, "removePreset")
    .mockImplementation((_sandboxName: unknown, presetName: unknown) => {
      const removed = livePolicyPresets.delete(String(presetName));
      if (
        String(presetName) === managedObservabilityPreset &&
        liveManagedObservabilityContent === managedObservabilityContent
      ) {
        liveManagedObservabilityContent = null;
      }
      if (removed) policyRemovalObserved = true;
      return removed;
    });
  const executeSandboxCommandSpy = vi
    .spyOn(processRecovery, "executeSandboxCommand")
    .mockImplementation(
      overrides.executeSandboxCommand ?? (() => ({ status: 0, stdout: "doctor ok", stderr: "" })),
    );
  vi.spyOn(shields, "repairMutableConfigPerms").mockImplementation(
    overrides.repairMutableConfigPerms ?? (() => ({ applied: true, verified: true, errors: [] })),
  );
  vi.spyOn(shields, "isShieldsDown").mockReturnValue(true);
  vi.spyOn(shields, "clearShieldsState").mockImplementation(() => undefined);
  const messagingRebuildPlanSpy = vi
    .spyOn(messaging.MessagingWorkflowPlanner.prototype, "buildRebuildPlanFromSandboxEntry")
    .mockImplementation(overrides.buildMessagingRebuildPlan ?? (() => null));
  const preflightMessagingConflictsSpy = vi
    .spyOn(rebuildMessagingConflict, "preflightRebuildMessagingConflicts")
    .mockImplementation(async () => {
      await overrides.preflightMessagingConflicts?.();
    });
  const ensureMessagingHostForwardAfterRebuildSpy = vi
    .spyOn(messagingHostForwardLifecycle, "ensureMessagingHostForwardAfterRebuild")
    .mockReturnValue(true);
  const emptyMcpPreparation = {
    entries: [],
    detachedProviderEntries: [],
    scrubbedAdapterEntries: [],
  };
  const prepareMcpBridgesForRebuildSpy = vi
    .spyOn(mcpBridge, "prepareMcpBridgesForRebuild")
    .mockResolvedValue(overrides.mcpPreparation ?? emptyMcpPreparation);
  vi.spyOn(mcpBridge, "prepareMcpBridgesForAbsentSandboxRebuild").mockResolvedValue(
    overrides.mcpPreparation ?? emptyMcpPreparation,
  );
  const reattachMcpProvidersAfterRebuildAbortSpy = vi
    .spyOn(mcpBridge, "reattachMcpProvidersAfterRebuildAbort")
    .mockResolvedValue(undefined);
  const restoreMcpBridgesAfterRebuildSpy = vi
    .spyOn(mcpBridge, "restoreMcpBridgesAfterRebuild")
    .mockResolvedValue(undefined);
  const warnUnpreservedUserManagedFilesSpy = vi
    .spyOn(rebuildFlowHelpers, "warnUnpreservedUserManagedFiles")
    .mockImplementation(() => undefined);

  errorSpy.mockClear();
  logSpy.mockClear();
  warnSpy.mockClear();

  return {
    rebuildSandbox: requireDist(rebuildModulePath).rebuildSandbox,
    applyPresetSpy,
    applyPresetContentSpy,
    backupSandboxStateSpy,
    disposePreparedDcodeRebuildImageSpy,
    errorSpy,
    ensureAgentBaseImageSpy,
    executeSandboxCommandSpy,
    ensureMessagingHostForwardAfterRebuildSpy,
    logSpy,
    finalizeIncompleteOnboardStepSpy,
    openShieldsSpy,
    onboardSpy,
    preflightAuthoritativeRebuildTargetSpy,
    preflightMessagingConflictsSpy,
    preflightDcodeRouteSpy,
    prepareManagedDcodeRebuildImageSpy,
    removePresetSpy,
    removeSandboxRegistryEntrySpy,
    registryUpdateSpy,
    releaseOnboardLockSpy,
    relockSpy,
    restoreSandboxEntrySpy,
    restoreRegistryEntryIfMissingSpy,
    restoreSandboxStateSpy,
    runOpenshellSpy,
    messagingRebuildPlanSpy,
    prepareMcpBridgesForRebuildSpy,
    reattachMcpProvidersAfterRebuildAbortSpy,
    restoreMcpBridgesAfterRebuildSpy,
    warnUnpreservedUserManagedFilesSpy,
    preparedDcodeBuildContext,
    session,
  };
}

export function makePreparedRecoveryManifest() {
  return {
    version: 1,
    sandboxName: "alpha",
    timestamp: "2026-07-01T06-50-42-044Z",
    agentType: "openclaw",
    agentVersion: "0.1.0",
    expectedVersion: "0.2.0",
    stateDirs: ["workspace"],
    backedUpDirs: ["workspace"],
    stateFiles: [],
    dir: "/sandbox/.openclaw",
    backupPath: "/tmp/rebuild-backups/alpha/2026-07-01T06-50-42-044Z",
    blueprintDigest: null,
    policyPresets: ["npm"],
    customPolicies: [],
  };
}
