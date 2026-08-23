// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type MockInstance, vi } from "vitest";
import type { GatewayRestartResult } from "../../src/lib/actions/sandbox/gateway-restart";
import { makePreparedRecoveryManifest } from "../../src/lib/actions/sandbox/rebuild-flow-test-fixtures";
import {
  agentDefs,
  agentOnboard,
  agentRuntime,
  createRebuildFlowSession,
  destroy,
  dockerImage,
  dockerInspect,
  gatewayDrift,
  gatewayRuntime,
  gatewayState,
  gatewayTeardownAuthority,
  installTerminalStepFailureMock,
  loadRebuildSandbox,
  mcpBridge,
  messaging,
  messagingHostForwardLifecycle,
  nim,
  onboardCredentialEnv,
  onboardSession,
  openshellRuntime,
  policies,
  processRecovery,
  purgeRebuildModule,
  type RebuildFlowSession,
  type RebuildSandbox,
  rebuildCustomImagePreflight,
  rebuildFlowHelpers,
  rebuildInference,
  rebuildManagedImage,
  rebuildMessagingConflict,
  rebuildOnboardDependencies,
  rebuildRoutePreflight,
  rebuildShields,
  registry,
  registryPersistence,
  resolve,
  sandboxList,
  sandboxSession,
  sandboxState,
  sandboxVersion,
  shields,
  snapshotEnv,
  sourceSandboxGateway,
} from "./rebuild-flow-harness";

export { installRebuildFlowTestHooks } from "./rebuild-flow-harness";
export { makePreparedRecoveryManifest, snapshotEnv };

export type RebuildFlowOverrides = {
  agentName?: string;
  sessionAgentName?: string | null;
  applyPreset?: (presetName: string) => boolean;
  captureOpenshell?: (
    args: string[],
    options?: Record<string, unknown>,
  ) => {
    status: number | null;
    output?: string;
    stdout?: string;
    stderr?: string;
    error?: Error;
  };
  executeSandboxCommand?: () => { status: number; stdout: string; stderr: string } | null;
  executeSandboxExecCommand?: () => { status: number; stdout: string; stderr: string } | null;
  checkAndRecoverSandboxProcesses?: () => {
    checked: boolean;
    wasRunning: boolean | null;
    recovered: boolean;
    forwardRecovered: boolean;
    forwardRecoveryFailed?: boolean;
    secretBoundaryRefused?: boolean;
    mcpReconciliationRefused?: boolean;
  };
  restartSandboxGateway?: () => GatewayRestartResult;
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
  revalidateRebuildRouteBeforeDelete?: (
    receipt: Record<string, unknown>,
  ) => { ok: true; receipt: Record<string, unknown> } | { ok: false; message: string };
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
  dockerRmiSpy: MockInstance;
  errorSpy: MockInstance;
  ensureAgentBaseImageSpy: MockInstance;
  pinTrustedAgentBaseImageOverrideForOperationSpy: MockInstance;
  pinTrustedAgentRemoteBaseImageOverrideForOperationSpy: MockInstance;
  restoreTrustedAgentBaseImageOverrideSpy: MockInstance;
  restoreTrustedAgentRemoteBaseImageOverrideSpy: MockInstance;
  executeSandboxCommandSpy: MockInstance;
  executeSandboxExecCommandSpy: MockInstance;
  checkAndRecoverSandboxProcessesSpy: MockInstance;
  restartSandboxGatewaySpy: MockInstance;
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
  captureOpenshellSpy: MockInstance;
  runOpenshellSpy: MockInstance;
  messagingRebuildPlanSpy: MockInstance;
  prepareMcpBridgesForRebuildSpy: MockInstance;
  reattachMcpProvidersAfterRebuildAbortSpy: MockInstance;
  restoreMcpBridgesAfterRebuildSpy: MockInstance;
  warnUnpreservedUserManagedFilesSpy: MockInstance;
  preparedDcodeBuildContext: Record<string, unknown> & { cleanupBuildCtx: MockInstance };
  session: RebuildFlowSession;
};

export function createRebuildFlowHarness(overrides: RebuildFlowOverrides = {}): RebuildFlowHarness {
  purgeRebuildModule();

  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

  const session = createRebuildFlowSession(onboardSession.MACHINE_SNAPSHOT_VERSION);
  const rebuildShieldsWindow = { relocked: false, wasLocked: false };
  const agentName = overrides.agentName ?? "openclaw";
  const agentDisplayName =
    agentName === "langchain-deepagents-code"
      ? "Deep Agents Code"
      : agentName === "hermes"
        ? "Hermes Agent"
        : "OpenClaw";
  const agentBaseImageId = `sha256:${"a".repeat(64)}`;
  const agentBaseImageRef = `nemoclaw-${agentName}-sandbox-base-local:image-${agentBaseImageId.slice("sha256:".length)}`;
  const agentBaseImageResolutionMetadata = {
    schema: 1,
    key: `${agentName}-rebuild-base`,
    imageName: `ghcr.io/nvidia/nemoclaw/${agentName}-sandbox-base`,
    ref: agentBaseImageRef,
    digest: null,
    source: "local" as const,
    imageId: agentBaseImageId,
    os: "linux",
    architecture: "amd64",
    glibcVersion: "2.41",
    requireOpenshellSandboxAbi: true,
    minGlibcVersion: "2.39",
  };
  const agentDef = {
    name: agentName,
    displayName: agentDisplayName,
    expectedVersion: "0.2.0",
    dockerfileBasePath: "/tmp/Dockerfile.base",
    runtime: { kind: "terminal" },
  };

  const resolveGatewayAuthority = ({
    gatewayName,
    gatewayPort,
  }: {
    gatewayName: string;
    gatewayPort: number;
  }) => ({
    gatewayName,
    gatewayPort,
    mode: "nemoclaw-managed" as const,
    source: "standalone" as const,
    endpoint: null,
    stateDir: null,
    supervisor: null,
    requiredCapabilities: [],
  });

  vi.spyOn(gatewayDrift, "detectOpenShellStateRpcPreflightIssue").mockReturnValue(null);
  vi.spyOn(gatewayDrift, "detectOpenShellStateRpcResultIssue").mockReturnValue(null);
  vi.spyOn(gatewayTeardownAuthority, "resolveGatewayTeardownAuthority").mockImplementation(
    resolveGatewayAuthority,
  );
  vi.spyOn(gatewayTeardownAuthority, "resolveGatewayRebuildAuthority").mockImplementation(
    resolveGatewayAuthority,
  );
  vi.spyOn(sandboxList, "captureSandboxListWithGatewayRecovery").mockResolvedValue({
    result: { status: 0, output: overrides.sandboxListOutput ?? "alpha Ready" },
  });
  vi.spyOn(resolve, "resolveOpenshell").mockReturnValue(null);
  vi.spyOn(dockerImage, "dockerBuild").mockReturnValue({ status: 0 });
  vi.spyOn(rebuildCustomImagePreflight, "preflightRebuildImage").mockResolvedValue({
    ok: true,
    imageTag: null,
  });
  const imageIdsByRef = new Map([
    [agentBaseImageRef, agentBaseImageId],
    [agentBaseImageId, agentBaseImageId],
  ]);
  const dcodeBaseImageIds = [...(overrides.dcodeBaseImageIds ?? [])];
  vi.spyOn(dockerInspect, "dockerImageInspectFormat").mockImplementation((...args: unknown[]) => {
    if (
      args[0] === "{{json .Config.Labels}}" &&
      overrides.sandboxBaseImageLabelsOutput !== undefined
    ) {
      return overrides.sandboxBaseImageLabelsOutput;
    }
    if (args[0] === "{{.Id}}") {
      const imageRef = String(args[1]);
      if (imageRef === agentBaseImageRef && dcodeBaseImageIds.length > 0) {
        return dcodeBaseImageIds.shift()!;
      }
      const imageId = imageIdsByRef.get(imageRef);
      if (imageId) return imageId;
    }
    return dcodeBaseImageIds.shift() ?? "sha256:dcode-base";
  });
  const dockerRmiSpy = vi.spyOn(dockerImage, "dockerRmi").mockReturnValue({ status: 0 });
  vi.spyOn(dockerImage, "dockerTag").mockImplementation((source: unknown, target: unknown) => {
    const sourceRef = String(source);
    const sourceId =
      imageIdsByRef.get(sourceRef) ?? (sourceRef.startsWith("sha256:") ? sourceRef : null);
    if (sourceId) imageIdsByRef.set(String(target), sourceId);
    return { status: 0 };
  });
  vi.spyOn(agentDefs, "loadAgent").mockReturnValue(agentDef);
  const trustedLocalOverride = {
    ref: agentBaseImageRef,
    provenance: `${"b".repeat(64)}.${"c".repeat(64)}`,
  };
  const ensureAgentBaseImageSpy = vi.spyOn(agentOnboard, "ensureAgentBaseImage").mockReturnValue({
    imageTag: agentBaseImageRef,
    built: true,
    resolutionMetadata: agentBaseImageResolutionMetadata,
    trustedLocalOverride,
  });
  const restoreTrustedAgentBaseImageOverrideSpy = vi.fn();
  const pinTrustedAgentBaseImageOverrideForOperationSpy = vi
    .spyOn(agentOnboard, "pinTrustedAgentBaseImageOverrideForOperation")
    .mockReturnValue(restoreTrustedAgentBaseImageOverrideSpy);
  const restoreTrustedAgentRemoteBaseImageOverrideSpy = vi.fn();
  const pinTrustedAgentRemoteBaseImageOverrideForOperationSpy = vi
    .spyOn(agentOnboard, "pinTrustedAgentRemoteBaseImageOverrideForOperation")
    .mockReturnValue(restoreTrustedAgentRemoteBaseImageOverrideSpy);
  const sessionAgentName =
    overrides.sessionAgentName === undefined ? agentName : overrides.sessionAgentName;
  vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue(
    sessionAgentName === null || sessionAgentName === "openclaw"
      ? null
      : ({ name: sessionAgentName } as never),
  );
  vi.spyOn(agentRuntime, "getAgentDisplayName").mockReturnValue(agentDisplayName);
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
  vi.spyOn(registryPersistence, "load").mockImplementation(() => {
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
  vi.spyOn(rebuildRoutePreflight, "commitRebuildRoutePreflight").mockImplementation(
    (...args: unknown[]) => {
      const input = args[0] as {
        sandboxName: string;
        gatewayName: string;
        targetUpdate: Record<string, unknown>;
      };
      if (!registry.updateSandbox(input.sandboxName, input.targetUpdate)) {
        return {
          ok: false,
          message: "Sandbox registry entry disappeared during rebuild route preflight.",
        };
      }
      return {
        ok: true,
        receipt: {
          sandboxName: input.sandboxName,
          gatewayName: input.gatewayName,
          route: {
            provider: input.targetUpdate.provider ?? null,
            model: input.targetUpdate.model ?? null,
            endpointUrl: input.targetUpdate.endpointUrl ?? null,
            preferredInferenceApi: input.targetUpdate.preferredInferenceApi ?? null,
            credentialEnv: input.targetUpdate.credentialEnv ?? null,
          },
          migratedSandboxNames: [],
        },
      };
    },
  );
  vi.spyOn(rebuildRoutePreflight, "revalidateRebuildRouteBeforeDelete").mockImplementation(
    (...args: unknown[]) => {
      const receipt = args[0] as Record<string, unknown>;
      return overrides.revalidateRebuildRouteBeforeDelete?.(receipt) ?? { ok: true, receipt };
    },
  );
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
    .spyOn(rebuildInference, "probeSandboxInferenceInvocation")
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
  const captureOpenshellSpy = vi
    .spyOn(openshellRuntime, "captureOpenshell")
    .mockImplementation((args: unknown, options?: unknown) => {
      const argv = Array.isArray(args) ? args.map(String) : [];
      if (overrides.captureOpenshell) {
        return overrides.captureOpenshell(argv, options as Record<string, unknown> | undefined);
      }
      const probedGateway = sourceSandboxGateway(argv, "get");
      const liveSource = "Name: alpha\nId: sbx-alpha-source\nPhase: Ready\n";
      return probedGateway && !deletedSourceGateways.has(probedGateway)
        ? { status: 0, output: liveSource, stdout: liveSource, stderr: "" }
        : {
            status: 1,
            output: "",
            stdout: "",
            stderr: "Error: sandbox alpha not found",
          };
    });
  const deletedSourceGateways = new Set<string>();
  const runOpenshellSpy = vi.spyOn(openshellRuntime, "runOpenshell").mockImplementation((args) => {
    const argv = args as string[];
    const deleteGateway = sourceSandboxGateway(argv, "delete");
    if (deleteGateway) {
      deletedSourceGateways.add(deleteGateway);
      return { status: 0, output: "" };
    }
    if (
      argv.join(" ") === "sandbox get alpha" ||
      argv.join(" ") === "sandbox get -g nemoclaw alpha"
    ) {
      return {
        status: 1,
        output: "sandbox alpha not found",
        stdout: "",
        stderr: "sandbox alpha not found",
      };
    }
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
      const preflightOptions = (options ?? {}) as Record<string, unknown>;
      await overrides.preflightAuthoritativeRebuildTarget?.(preflightOptions);
      return {
        gatewayName: String(preflightOptions.targetGatewayName ?? "nemoclaw"),
        gatewayPort: Number(preflightOptions.targetGatewayPort ?? 8080),
        mode: "nemoclaw-managed",
        source: "standalone",
        endpoint: null,
        stateDir: null,
        supervisor: null,
        requiredCapabilities: [],
      };
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
  const executeSandboxExecCommandSpy = vi
    .spyOn(processRecovery, "executeSandboxExecCommand")
    .mockImplementation(
      overrides.executeSandboxExecCommand ??
        (() => ({ status: 0, stdout: "doctor ok", stderr: "" })),
    );
  const checkAndRecoverSandboxProcessesSpy = vi
    .spyOn(processRecovery, "checkAndRecoverSandboxProcesses")
    .mockImplementation(
      overrides.checkAndRecoverSandboxProcesses ??
        (() => ({
          checked: true,
          wasRunning: true,
          recovered: false,
          forwardRecovered: false,
        })),
    );
  const restartSandboxGatewaySpy = vi
    .spyOn(processRecovery, "restartSandboxGateway")
    .mockImplementation(
      overrides.restartSandboxGateway ??
        (() => ({
          ok: true,
          restarted: true,
          healthPassed: true,
          forwardRecovered: false,
        })),
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
    rebuildSandbox: loadRebuildSandbox(),
    applyPresetSpy,
    applyPresetContentSpy,
    backupSandboxStateSpy,
    disposePreparedDcodeRebuildImageSpy,
    dockerRmiSpy,
    errorSpy,
    ensureAgentBaseImageSpy,
    pinTrustedAgentBaseImageOverrideForOperationSpy,
    pinTrustedAgentRemoteBaseImageOverrideForOperationSpy,
    restoreTrustedAgentBaseImageOverrideSpy,
    restoreTrustedAgentRemoteBaseImageOverrideSpy,
    executeSandboxCommandSpy,
    executeSandboxExecCommandSpy,
    checkAndRecoverSandboxProcessesSpy,
    restartSandboxGatewaySpy,
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
    captureOpenshellSpy,
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
