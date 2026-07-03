// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type MockInstance, vi } from "vitest";

export type RebuildSandbox =
  typeof import("../../src/lib/actions/sandbox/rebuild")["rebuildSandbox"];
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
  applyPreset?: (presetName: string) => boolean;
  baseImagePreflight?: {
    ok: boolean;
    imageRef: string | null;
    overrideEnvVar: string | null;
  };
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
  restoreMcpBridgesAfterRebuild?: () => Promise<void>;
  buildMessagingRebuildPlan?: () => Promise<unknown> | unknown;
  sandboxEntry?: Record<string, unknown>;
  sessionSandboxName?: string;
  sandboxListOutput?: string;
  defaultSandbox?: string | null;
  preDeleteSandboxEntry?: Record<string, unknown>;
  preDeleteDefaultSandbox?: string | null;
  preDeleteLatestManifest?: Record<string, unknown> | null;
  recoveryManifestValidation?: (
    manifest: Record<string, unknown>,
  ) => { ok: true; manifest: Record<string, unknown> } | { ok: false; reason: string };
  managedImageEvidence?: boolean;
  staleRecovery?: boolean;
  mcpPreparation?: {
    entries: Array<Record<string, unknown>>;
    detachedProviderEntries: Array<Record<string, unknown>>;
    scrubbedAdapterEntries?: Array<Record<string, unknown>>;
  };
  runOpenshell?: (args: string[]) => {
    status: number;
    output: string;
    stdout?: string;
    stderr?: string;
  };
  backupPolicyPresets?: string[];
  ensureValidatedBraveSearchCredential?: () => Promise<unknown>;
  ensureValidatedWebSearchCredential?: () => Promise<unknown>;
  hermesCredentialKeys?: string[] | null;
  hermesProviderExists?: boolean;
  customImagePreflight?: { ok: true; imageTag: string | null } | { ok: false; detail: string };
  removeSandboxRegistryEntry?: () => void;
  clearShieldsState?: () => void;
};
export type RebuildFlowHarness = {
  rebuildSandbox: RebuildSandbox;
  applyPresetSpy: MockInstance;
  backupSandboxStateSpy: MockInstance;
  errorSpy: MockInstance;
  executeSandboxCommandSpy: MockInstance;
  ensureMessagingHostForwardAfterRebuildSpy: MockInstance;
  ensureTargetGatewaySpy: MockInstance;
  ensureValidatedBraveSearchCredentialSpy: MockInstance;
  logSpy: MockInstance;
  markStepFailedSpy: MockInstance;
  onboardSpy: MockInstance;
  registryUpdateSpy: MockInstance;
  releaseOnboardLockSpy: MockInstance;
  relockSpy: MockInstance;
  restoreSandboxStateSpy: MockInstance;
  runOpenshellSpy: MockInstance;
  messagingRebuildPlanSpy: MockInstance;
  prepareMcpBridgesForAbsentSandboxRebuildSpy: MockInstance;
  prepareMcpBridgesForRebuildSpy: MockInstance;
  reattachMcpProvidersAfterRebuildAbortSpy: MockInstance;
  removeSandboxRegistryEntrySpy: MockInstance;
  restoreSandboxEntrySpy: MockInstance;
  restoreMcpBridgesAfterRebuildSpy: MockInstance;
  warnUnpreservedUserManagedFilesSpy: MockInstance;
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
export function installTerminalStepFailureMock(
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
