// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import path from "node:path";

import { expect, type MockInstance, vi } from "vitest";

type RebuildSandbox = typeof import("./rebuild")["rebuildSandbox"];

export const requireDist = createRequire(
  path.join(process.cwd(), "src/lib/actions/sandbox/rebuild-flow.test-support.ts"),
);
export const rebuildModulePath = "./rebuild.js";

// Warm the CommonJS source graph outside the first test's timeout. Each harness
// still reloads the entry module after installing its dependency spies.
requireDist(rebuildModulePath);
delete require.cache[requireDist.resolve(rebuildModulePath)];

type RebuildFlowStep = {
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
};

type RebuildFlowSession = Record<string, unknown> & {
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

type RebuildFlowOverrides = {
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
  sessionSandboxName?: string;
  sandboxListOutput?: string;
  backupPolicyPresets?: string[];
  preDeleteSandboxEntry?: Record<string, unknown>;
  preDeleteDefaultSandbox?: string | null;
  preDeleteLatestManifest?: Record<string, unknown> | null;
  recoveryManifestValidation?: (
    manifest: Record<string, unknown>,
  ) => { ok: true; manifest: Record<string, unknown> } | { ok: false; reason: string };
  managedImageEvidence?: boolean;
  initialPolicyError?: Error;
  targetPreflightError?: Error;
  extraProviders?: string[];
  providerPreflightError?: Error;
  postBackupExtraProviders?: string[];
  hermesToolProvider?: string | null;
  onBackup?: () => void;
  staleRecovery?: boolean;
  sessionUpdateError?: Error;
};

type RebuildFlowHarness = {
  rebuildSandbox: RebuildSandbox;
  applyPresetSpy: MockInstance;
  backupSandboxStateSpy: MockInstance;
  braveCredentialSpy: MockInstance;
  braveRouteSpy: MockInstance;
  captureOpenshellSpy: MockInstance;
  errorSpy: MockInstance;
  executeSandboxCommandSpy: MockInstance;
  ensureMessagingHostForwardAfterRebuildSpy: MockInstance;
  imagePreflightSpy: MockInstance;
  initialPolicyPreflightSpy: MockInstance;
  logSpy: MockInstance;
  markStepFailedSpy: MockInstance;
  onboardSpy: MockInstance;
  preparedBuildContextCleanupSpy: MockInstance;
  registryUpdateSpy: MockInstance;
  releaseOnboardLockSpy: MockInstance;
  relockSpy: MockInstance;
  restoreSandboxEntrySpy: MockInstance;
  restoreSandboxStateSpy: MockInstance;
  runOpenshellSpy: MockInstance;
  messagingRebuildPlanSpy: MockInstance;
  session: RebuildFlowSession;
  stopNimContainerByNameSpy: MockInstance;
  stopNimContainerSpy: MockInstance;
};

export const originalSandboxName = process.env.NEMOCLAW_SANDBOX_NAME;

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
  onboardSession: { markStepFailed: (...args: unknown[]) => unknown },
  session: RebuildFlowSession,
): MockInstance {
  return vi
    .spyOn(onboardSession, "markStepFailed")
    .mockImplementation((stepName: unknown, message: unknown, options: unknown) => {
      const stepKey = String(stepName);
      const step = session.steps[stepKey] ?? createStep("pending");
      session.steps[stepKey] = step;
      step.status = "failed";
      step.error = typeof message === "string" ? message : null;
      session.status = "failed";
      session.failure = {
        step: stepKey,
        message: typeof message === "string" ? message : null,
        recordedAt: "2026-06-01T00:02:00.000Z",
      };
      const updateMachine =
        (options as { updateMachine?: boolean } | undefined)?.updateMachine === true;
      session.machine.state = updateMachine ? "failed" : session.machine.state;
      session.machine.revision += updateMachine ? 1 : 0;
      return session;
    });
}

export function createRebuildFlowHarness(overrides: RebuildFlowOverrides = {}): RebuildFlowHarness {
  delete require.cache[requireDist.resolve(rebuildModulePath)];

  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

  const gatewayDrift = requireDist("../../adapters/openshell/gateway-drift.js");
  const gatewayRuntime = requireDist("../../gateway-runtime-action.js");
  const openshellRuntime = requireDist("../../adapters/openshell/runtime.js");
  const sandboxList = requireDist("../../openshell-sandbox-list.js");
  const resolve = requireDist("../../adapters/openshell/resolve.js");
  const agentDefs = requireDist("../../agent/defs.js");
  const agentRuntime = requireDist("../../agent/runtime.js");
  const onboardMod = requireDist("../../onboard.js");
  const onboardSession = requireDist("../../state/onboard-session.js");
  const registry = requireDist("../../state/registry.js");
  const sandboxState = requireDist("../../state/sandbox.js");
  const sandboxSession = requireDist("../../state/sandbox-session.js");
  const sandboxVersion = requireDist("../../sandbox/version.js");
  const destroy = requireDist("./destroy.js");
  const rebuildShields = requireDist("./rebuild-shields.js");
  const rebuildFlowHelpers = requireDist("./rebuild-flow-helpers.js");
  const rebuildImagePreflight = requireDist("./rebuild-custom-image-preflight.js");
  const rebuildInferencePreflight = requireDist("./rebuild-inference-preflight.js");
  const rebuildWebSearchPreflight = requireDist("./rebuild-web-search-preflight.js");
  const nim = requireDist("../../inference/nim.js");
  const policies = requireDist("../../policy/index.js");
  const processRecovery = requireDist("./process-recovery.js");
  const messagingHostForwardLifecycle = requireDist("./messaging-host-forward-lifecycle.js");
  const messaging = requireDist("../../messaging/index.js");
  const shields = requireDist("../../shields/index.js");

  const session = createRebuildFlowSession(onboardSession.MACHINE_SNAPSHOT_VERSION);
  const rebuildShieldsWindow = { relocked: false, wasLocked: false };
  const agentDef = {
    name: "openclaw",
    expectedVersion: "0.2.0",
  };

  vi.spyOn(gatewayDrift, "detectOpenShellStateRpcPreflightIssue").mockReturnValue(null);
  vi.spyOn(gatewayDrift, "detectOpenShellStateRpcResultIssue").mockReturnValue(null);
  vi.spyOn(gatewayRuntime, "recoverNamedGatewayRuntime").mockResolvedValue({
    recovered: true,
    before: { state: "healthy_named" },
    after: { state: "healthy_named" },
    attempted: false,
  });
  vi.spyOn(sandboxList, "captureSandboxListWithGatewayRecovery").mockResolvedValue({
    result: { status: 0, output: overrides.sandboxListOutput ?? "alpha Ready" },
  });
  vi.spyOn(resolve, "resolveOpenshell").mockReturnValue(null);
  vi.spyOn(agentDefs, "loadAgent").mockReturnValue(agentDef);
  vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({ name: "openclaw" });
  vi.spyOn(agentRuntime, "getAgentDisplayName").mockReturnValue("OpenClaw");
  vi.spyOn(onboardSession, "loadSession").mockReturnValue(session);
  vi.spyOn(onboardSession, "acquireOnboardLock").mockReturnValue({ acquired: true });
  vi.spyOn(onboardSession, "updateSession").mockImplementation((mutator: unknown) => {
    if (overrides.sessionUpdateError) throw overrides.sessionUpdateError;
    if (typeof mutator !== "function") {
      throw new TypeError("updateSession expected a mutator function");
    }
    (mutator as (value: typeof session) => typeof session | void)(session);
    return session;
  });
  const releaseOnboardLockSpy = vi
    .spyOn(onboardSession, "releaseOnboardLock")
    .mockImplementation(() => undefined);
  const markStepFailedSpy = installTerminalStepFailureMock(onboardSession, session);
  session.sandboxName = overrides.sessionSandboxName ?? session.sandboxName;
  const sandboxEntry = {
    name: "alpha",
    provider: "ollama-local",
    model: "nvidia/nemotron",
    policies: ["npm"],
    agent: null,
    agentVersion: "0.1.0",
    nimContainer: null,
    dashboardPort: 18789,
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    ...(overrides.sandboxEntry ?? {}),
  };
  vi.spyOn(registry, "getSandbox").mockReturnValue(sandboxEntry);
  let registryLoadCount = 0;
  vi.spyOn(registry, "load").mockImplementation(() => {
    const isPreDeleteRead = registryLoadCount > 0;
    registryLoadCount++;
    return {
      defaultSandbox: isPreDeleteRead ? (overrides.preDeleteDefaultSandbox ?? "alpha") : "alpha",
      sandboxes: {
        alpha:
          isPreDeleteRead && overrides.preDeleteSandboxEntry
            ? overrides.preDeleteSandboxEntry
            : sandboxEntry,
      },
    };
  });
  vi.spyOn(registry, "listSandboxes").mockReturnValue({ sandboxes: [] });
  vi.spyOn(registry, "listExtraProviders").mockReturnValue(overrides.extraProviders ?? []);
  const registryUpdateSpy = vi.spyOn(registry, "updateSandbox").mockImplementation(() => undefined);
  const restoreSandboxEntrySpy = vi
    .spyOn(registry, "restoreSandboxEntry")
    .mockImplementation(() => undefined);
  vi.spyOn(sandboxSession, "getActiveSandboxSessions").mockReturnValue({
    detected: false,
    sessions: [],
  });
  vi.spyOn(sandboxVersion, "checkAgentVersion").mockReturnValue({
    expectedVersion: "0.2.0",
    sandboxVersion: "0.1.0",
  });
  vi.spyOn(rebuildShields, "openRebuildShieldsWindow").mockReturnValue(rebuildShieldsWindow);
  if (overrides.staleRecovery === true) {
    vi.spyOn(rebuildFlowHelpers, "resolveRebuildLiveState").mockResolvedValue({
      staleRecovery: true,
      staleRegistrySnapshot: {
        defaultSandbox: "alpha",
        sandboxes: { alpha: sandboxEntry },
      },
    });
  }
  const relockSpy = vi
    .spyOn(rebuildShields, "relockRebuildShieldsWindow")
    .mockImplementation((...args: unknown[]) => {
      const window = args[1] as typeof rebuildShieldsWindow;
      window.relocked = true;
      return true;
    });
  const backupSandboxStateSpy = vi
    .spyOn(sandboxState, "backupSandboxState")
    .mockImplementation(() => {
      overrides.onBackup?.();
      return {
        success: true,
        backedUpDirs: ["workspace"],
        backedUpFiles: ["user.md"],
        failedDirs: [],
        failedFiles: [],
        manifest: {
          backupPath: "/tmp/nemoclaw-rebuild-backup",
          timestamp: "2026-06-01T00:00:00.000Z",
          policyPresets: overrides.backupPolicyPresets ?? ["npm", "bad", "throw"],
        },
      };
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
  const restoreSandboxStateSpy = vi.spyOn(sandboxState, "restoreSandboxState").mockImplementation(
    overrides.restoreSandboxState ??
      (() => ({
        success: true,
        restoredDirs: ["workspace"],
        restoredFiles: ["user.md"],
        failedDirs: [],
        failedFiles: [],
      })),
  );
  const runOpenshellSpy = vi
    .spyOn(openshellRuntime, "runOpenshell")
    .mockReturnValue({ status: 0, output: "" });
  const captureOpenshellSpy = vi
    .spyOn(openshellRuntime, "captureOpenshell")
    .mockReturnValue({ status: 0, output: "" });
  vi.spyOn(destroy, "removeSandboxRegistryEntry").mockImplementation(() => undefined);
  const stopNimContainerSpy = vi.spyOn(nim, "stopNimContainer").mockImplementation(() => undefined);
  const stopNimContainerByNameSpy = vi
    .spyOn(nim, "stopNimContainerByName")
    .mockImplementation(() => undefined);
  const onboardSpy = vi.spyOn(onboardMod, "onboard").mockImplementation(async () => {
    await overrides.onboard?.(session);
  });
  const braveCredentialSpy = vi
    .spyOn(onboardMod, "ensureValidatedBraveSearchCredential")
    .mockResolvedValue("host-credential-that-must-not-be-used");
  vi.spyOn(onboardMod, "isInferenceRouteReady").mockReturnValue(true);
  const initialMessagingReuse = {
    providers: [],
    channels: [],
    disabledChannels: [],
    detachProviders: [...(overrides.extraProviders ?? [])],
    extraProviders: [...(overrides.extraProviders ?? [])],
    extraPlaceholderKeys: [],
  };
  vi.spyOn(onboardMod, "preflightAuthoritativeRebuildMessagingConflicts").mockImplementation(
    async () => {
      if (overrides.providerPreflightError) throw overrides.providerPreflightError;
      return initialMessagingReuse;
    },
  );
  let messagingSnapshotCount = 0;
  vi.spyOn(onboardMod, "snapshotAuthoritativeRebuildMessagingState").mockImplementation(() => {
    messagingSnapshotCount++;
    if (messagingSnapshotCount > 1 && overrides.postBackupExtraProviders) {
      return {
        ...initialMessagingReuse,
        detachProviders: [...overrides.postBackupExtraProviders],
        extraProviders: [...overrides.postBackupExtraProviders],
      };
    }
    return initialMessagingReuse;
  });
  vi.spyOn(onboardMod, "preflightAuthoritativeProviderAttachments").mockResolvedValue(undefined);
  vi.spyOn(onboardMod, "preflightAuthoritativeHermesToolGateways").mockResolvedValue(
    overrides.hermesToolProvider ?? null,
  );
  vi.spyOn(onboardMod, "preflightAuthoritativeRebuildTarget").mockImplementation(async () => {
    if (overrides.targetPreflightError) throw overrides.targetPreflightError;
    return {
      gpu: null,
      host: { dockerReachable: true, runtime: "docker", notes: [] },
      sandboxGpuConfig: {
        mode: "0",
        hostGpuDetected: false,
        hostGpuPlatform: null,
        sandboxGpuEnabled: false,
        sandboxGpuDevice: null,
        errors: [],
      },
    };
  });
  const initialPolicyPreflightSpy = vi
    .spyOn(onboardMod, "preflightAuthoritativeRebuildCreatePolicy")
    .mockImplementation(() => {
      if (overrides.initialPolicyError) throw overrides.initialPolicyError;
      return { policyPath: "/tmp/rebuild-prevalidated-policy.yaml", appliedPresets: [] };
    });
  vi.spyOn(rebuildInferencePreflight, "preflightRebuildInferenceRoute").mockReturnValue({
    ok: true,
  });
  const braveRouteSpy = vi
    .spyOn(rebuildWebSearchPreflight, "preflightRebuildBraveSearchRoute")
    .mockReturnValue({ ok: true });
  const preparedBuildContextCleanupSpy = vi.fn(() => true);
  const imagePreflightSpy = vi
    .spyOn(rebuildImagePreflight, "preflightRebuildImage")
    .mockResolvedValue({
      ok: true,
      preparedBuildContext: {
        buildCtx: "/tmp/rebuild-flow-preflight",
        stagedDockerfile: "/tmp/rebuild-flow-preflight/Dockerfile",
        buildId: "flow-build",
        dockerGpuPatchNetwork: null,
        cleanupBuildCtx: preparedBuildContextCleanupSpy,
      },
    });
  const applyPresetSpy = vi
    .spyOn(policies, "applyPreset")
    .mockImplementation((_sandboxName: unknown, presetName: unknown) => {
      const normalizedPresetName = String(presetName);
      if (overrides.applyPreset) return overrides.applyPreset(normalizedPresetName);
      if (normalizedPresetName === "throw") throw new Error("preset boom");
      return normalizedPresetName === "npm";
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
  const ensureMessagingHostForwardAfterRebuildSpy = vi
    .spyOn(messagingHostForwardLifecycle, "ensureMessagingHostForwardAfterRebuild")
    .mockReturnValue(true);

  errorSpy.mockClear();
  logSpy.mockClear();
  warnSpy.mockClear();

  return {
    rebuildSandbox: requireDist(rebuildModulePath).rebuildSandbox,
    applyPresetSpy,
    backupSandboxStateSpy,
    braveCredentialSpy,
    braveRouteSpy,
    captureOpenshellSpy,
    errorSpy,
    executeSandboxCommandSpy,
    ensureMessagingHostForwardAfterRebuildSpy,
    imagePreflightSpy,
    initialPolicyPreflightSpy,
    logSpy,
    markStepFailedSpy,
    onboardSpy,
    preparedBuildContextCleanupSpy,
    registryUpdateSpy,
    releaseOnboardLockSpy,
    relockSpy,
    restoreSandboxEntrySpy,
    restoreSandboxStateSpy,
    runOpenshellSpy,
    messagingRebuildPlanSpy,
    session,
    stopNimContainerByNameSpy,
    stopNimContainerSpy,
  };
}

export function makeActiveTeamsMessagingPlan() {
  return {
    schemaVersion: 1,
    sandboxName: "alpha",
    agent: "openclaw",
    workflow: "rebuild",
    channels: [
      {
        channelId: "teams",
        displayName: "Microsoft Teams",
        authMode: "token-paste",
        active: true,
        selected: true,
        configured: true,
        disabled: false,
        inputs: [
          {
            channelId: "teams",
            inputId: "appId",
            kind: "config",
            required: true,
            sourceEnv: "MSTEAMS_APP_ID",
            statePath: "teamsConfig.appId",
            value: "teams-app-id",
          },
          {
            channelId: "teams",
            inputId: "clientSecret",
            kind: "secret",
            required: true,
            sourceEnv: "MSTEAMS_APP_PASSWORD",
            credentialAvailable: true,
          },
          {
            channelId: "teams",
            inputId: "tenantId",
            kind: "config",
            required: true,
            sourceEnv: "MSTEAMS_TENANT_ID",
            statePath: "teamsConfig.tenantId",
            value: "teams-tenant-id",
          },
          {
            channelId: "teams",
            inputId: "webhookPort",
            kind: "config",
            required: false,
            sourceEnv: "MSTEAMS_PORT",
            statePath: "teamsConfig.webhookPort",
            value: "3978",
          },
        ],
        hostForward: {
          channelId: "teams",
          port: 3978,
          label: "Microsoft Teams webhook",
        },
        hooks: [],
      },
    ],
    disabledChannels: [],
    credentialBindings: [],
    networkPolicy: { presets: ["teams"], entries: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
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
