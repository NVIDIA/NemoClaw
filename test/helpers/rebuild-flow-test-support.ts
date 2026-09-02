// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type MockInstance, vi } from "vitest";
import type { GatewayRestartResult } from "../../src/lib/actions/sandbox/gateway-restart";
import type { SandboxGatewayState } from "../../src/lib/actions/sandbox/gateway-state";
import type { OpenShellSandboxInventory } from "../../src/lib/adapters/openshell/sandbox-observer";
import type {
  finalizePreparedRebuildImageMessagingPlan,
  RebuildImagePreflightResult,
} from "../../src/lib/actions/sandbox/rebuild-custom-image-preflight";
import type { RebuildRecreateOnboardOpts } from "../../src/lib/actions/sandbox/rebuild-gpu-opt-out";
import type { VersionCheckResult } from "../../src/lib/sandbox/version";
import type { PreservedEnvFile } from "../../src/lib/state/preserved-env";
import type { SandboxRemovalReceipt } from "../../src/lib/state/registry";

export type RebuildSandbox =
  (typeof import("../../src/lib/actions/sandbox/rebuild"))["rebuildSandbox"];
export type RebuildFlowStep = {
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
  sessionAgentName?: string | null;
  entryUpdatesAfterVersionCheck?: Record<string, unknown>;
  applyPreset?: (presetName: string) => boolean;
  baseImagePreflight?: {
    ok: boolean;
    imageRef: string | null;
    overrideEnvVar: string | null;
    disposeImageRef?: () => boolean;
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
  onboard?: (
    session: RebuildFlowSession,
    options: RebuildRecreateOnboardOpts,
  ) => Promise<void> | void;
  beforeBackup?: () => void;
  repairMutableConfigPerms?: () =>
    | { applied: false; skipReason: "agent"; reason: string }
    | { applied: true; verified: boolean; errors: string[] };
  restoreSandboxState?: () => {
    success: boolean;
    restoredDirs: string[];
    restoredFiles: string[];
    failedDirs: string[];
    failedFiles: string[];
  };
  restoreMcpBridgesAfterRebuild?: () => Promise<void>;
  buildMessagingRebuildPlan?: () => Promise<unknown> | unknown;
  agentPolicyAdditionsContent?: string;
  preflightWithProductionBaselineResolver?: boolean;
  preflightAuthoritativeRebuildTarget?: (options: Record<string, unknown>) => Promise<void> | void;
  revalidateRebuildRouteBeforeDelete?: (
    receipt: Record<string, unknown>,
  ) => { ok: true; receipt: Record<string, unknown> } | { ok: false; message: string };
  sandboxEntry?: Record<string, unknown>;
  sandboxEntryReads?: Array<Record<string, unknown> | null>;
  sandboxBaseImageLabelsOutput?: string;
  sessionSandboxName?: string;
  sandboxInventory?: OpenShellSandboxInventory;
  defaultSandbox?: string | null;
  preDeleteSandboxEntry?: Record<string, unknown>;
  preDeleteDefaultSandbox?: string | null;
  preDeleteLatestManifest?: Record<string, unknown> | null;
  recoveryManifestValidation?: (
    manifest: Record<string, unknown>,
  ) => { ok: true; manifest: Record<string, unknown> } | { ok: false; reason: string };
  managedImageEvidence?: boolean;
  gatewayPresets?: string[];
  verificationUnavailableAfterPresetRemoval?: boolean;
  updateSession?: () => void;
  dcodeRouteResults?: Array<{ ok: true } | { ok: false; detail: string }>;
  gatewayRecoveryResult?: Record<string, unknown>;
  dcodeImageVerificationResults?: boolean[];
  dcodeBaseImageIds?: string[];
  dcodeImageResult?:
    | { ok: true; prepared: Record<string, unknown> & { cleanupBuildCtx: () => boolean } }
    | { ok: false; detail: string };
  openShieldsWindow?: () => { relocked: boolean; wasLocked: boolean } | null;
  preflightMessagingConflicts?: () => Promise<void> | void;
  staleRecovery?: boolean;
  reconciledSandboxGatewayState?: SandboxGatewayState;
  mcpPreparation?: {
    entries: Array<Record<string, unknown>>;
    detachedProviderEntries: Array<Record<string, unknown>>;
    scrubbedAdapterEntries?: Array<Record<string, unknown>>;
    policyHandoff?: string;
    revalidateBeforeDelete?: () => Promise<void>;
    assertDeleteEdgeUnchanged?: () => void;
  };
  runOpenshell?: (args: string[]) =>
    | {
        status: number;
        output: string;
        stdout?: string;
        stderr?: string;
      }
    | undefined;
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
  captureResolvedOpenshell?: (
    args: string[],
    options?: Record<string, unknown>,
  ) => {
    status: number | null;
    output?: string;
    stdout?: string;
    stderr?: string;
    error?: Error;
  };
  backupPreservedEnv?: PreservedEnvFile[];
  ensureValidatedBraveSearchCredential?: () => Promise<unknown>;
  ensureValidatedWebSearchCredential?: () => Promise<unknown>;
  hermesCredentialKeys?: string[] | null;
  hermesProviderExists?: boolean;
  versionCheck?: VersionCheckResult;
  hydrateCredentialEnv?: (credentialEnv: string) => string | null;
  customImagePreflight?: RebuildImagePreflightResult;
  finalizePreparedImage?: typeof finalizePreparedRebuildImageMessagingPlan;
  defaultSelectionRevision?: number;
  preDeleteDefaultSelectionRevision?: number;
  removalReceipt?: SandboxRemovalReceipt | null;
  removeSandboxRegistryEntryWithReceipt?: () => SandboxRemovalReceipt | null | void;
};
export type RebuildFlowHarness = {
  backupPath: string;
  rebuildSandbox: RebuildSandbox;
  applyPresetSpy: MockInstance;
  applyPresetContentSpy: MockInstance;
  backupSandboxStateSpy: MockInstance;
  checkAndRecoverSandboxProcessesSpy: MockInstance;
  restartSandboxGatewaySpy: MockInstance;
  errorSpy: MockInstance;
  executeSandboxCommandSpy: MockInstance;
  executeSandboxExecCommandSpy: MockInstance;
  ensureMessagingHostForwardAfterRebuildSpy: MockInstance;
  ensureRebuildAgentBaseImageSpy: MockInstance;
  ensureAgentBaseImageSpy: MockInstance;
  pinTrustedAgentBaseImageOverrideForOperationSpy: MockInstance;
  pinTrustedAgentRemoteBaseImageOverrideForOperationSpy: MockInstance;
  restoreTrustedAgentBaseImageOverrideSpy: MockInstance;
  restoreTrustedAgentRemoteBaseImageOverrideSpy: MockInstance;
  disposePreparedDcodeRebuildImageSpy: MockInstance;
  dockerRmiSpy: MockInstance;
  ensureTargetGatewaySpy: MockInstance;
  ensureValidatedBraveSearchCredentialSpy: MockInstance;
  hydrateCredentialEnvSpy: MockInstance;
  logSpy: MockInstance;
  finalizeIncompleteOnboardStepSpy: MockInstance;
  onboardSpy: MockInstance;
  preflightAuthoritativeRebuildTargetSpy: MockInstance;
  preflightMessagingConflictsSpy: MockInstance;
  preflightDcodeRouteSpy: MockInstance;
  prepareManagedDcodeRebuildImageSpy: MockInstance;
  preparedDcodeBuildContext: Record<string, unknown> & { cleanupBuildCtx: MockInstance };
  registryUpdateSpy: MockInstance;
  setDefaultSpy: MockInstance;
  setDefault: (name: string) => boolean;
  registerSandboxEntry: (name: string) => void;
  getDefaultSelectionState: () => {
    defaultSandbox: string | null;
    defaultSelectionRevision: number;
  };
  registerHermesInferenceProviderSpy: MockInstance;
  releaseOnboardLockSpy: MockInstance;
  enforceRemovedImmutabilityMigrationBoundarySpy: MockInstance;
  retireRemovedImmutabilityStateRecordSpy: MockInstance;
  restoreSandboxStateSpy: MockInstance;
  captureOpenshellSpy: MockInstance;
  captureResolvedOpenshellSpy: MockInstance;
  runOpenshellSpy: MockInstance;
  messagingRebuildPlanSpy: MockInstance;
  prepareMcpBridgesForAbsentSandboxRebuildSpy: MockInstance;
  prepareMcpBridgesForRebuildSpy: MockInstance;
  reattachMcpProvidersAfterRebuildAbortSpy: MockInstance;
  removeSandboxRegistryEntryWithReceiptSpy: MockInstance;
  removeSandboxRegistryEntrySpy: MockInstance;
  removePresetSpy: MockInstance;
  restoreSandboxEntrySpy: MockInstance;
  restoreSandboxEntryIfMissingSpy: MockInstance;
  restoreMcpBridgesAfterRebuildSpy: MockInstance;
  warnUnpreservedUserManagedFilesSpy: MockInstance;
  finalizePreparedImageSpy: MockInstance;
  session: RebuildFlowSession;
};
export const originalSandboxName = process.env.NEMOCLAW_SANDBOX_NAME;
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
export function createRebuildFlowSession(machineSnapshotVersion: number): RebuildFlowSession {
  return {
    sessionId: "rebuild-flow-session",
    updatedAt: "2026-06-01T00:00:00.000Z",
    sandboxName: "alpha",
    agent: null,
    provider: "ollama-local",
    model: "nvidia/nemotron",
    credentialEnv: null,
    checkpoint: null,
    webSearchConfig: null,
    resourceProfile: null,
    messagingPlan: null,
    sandboxPromptProgress: {
      sandboxName: true,
      webSearch: false,
      messaging: false,
      resourceProfile: false,
    },
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
export function installTerminalStepFailureMock(
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
