// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";
import type { DashboardDeliveryChain } from "../../src/lib/dashboard/contract";
import type { OnboardMachineEvent } from "../../src/lib/onboard/machine/events";
import { createFinalOnboardFlowPhases } from "../../src/lib/onboard/machine/final-flow-phases";
import type { OnboardFlowContext } from "../../src/lib/onboard/machine/flow-context";
import type { PoliciesStateOptions } from "../../src/lib/onboard/machine/handlers/policies";
import { OnboardRuntime, type OnboardRuntimeDeps } from "../../src/lib/onboard/machine/runtime";
import type { OnboardMachineState } from "../../src/lib/onboard/machine/types";
import { OnboardRuntimeBoundary } from "../../src/lib/onboard/runtime-boundary";
import {
  createSession,
  filterSafeUpdates,
  MACHINE_SNAPSHOT_VERSION,
  normalizeSession,
  type Session,
  type SessionUpdates,
} from "../../src/lib/state/onboard-session";
import type { VerifyDeploymentResult } from "../../src/lib/verify-deployment";

export type Agent = { name: string };
type WebSearchConfig = NonNullable<OnboardFlowContext["webSearchConfig"]>;

export type RecorderOverrides = {
  loadSession?: () => Session | null;
  updateSession?: (mutator: (session: Session) => Session | void) => Session;
  recordStepSkipped?: (stepName: string) => Promise<Session>;
  recordStateSkipped?: (
    state: OnboardMachineState,
    metadata?: Record<string, unknown> | null,
  ) => Promise<Session>;
  startRecordedStep?: (
    stepName: string,
    updates?: {
      sandboxName?: string | null;
      provider?: string | null;
      model?: string | null;
      policyPresets?: string[] | null;
    },
  ) => Promise<void>;
  recordStepComplete?: (stepName: string, updates?: SessionUpdates) => Promise<Session>;
  recordPostVerifyStarted?: () => Promise<Session>;
  mergePolicyMessagingChannels?: PoliciesStateOptions<
    Agent | null,
    WebSearchConfig
  >["deps"]["mergePolicyMessagingChannels"];
  verifyDeployment?: (
    sandboxName: string,
    chain: DashboardDeliveryChain,
  ) => Promise<VerifyDeploymentResult>;
  printDashboard?: (
    sandboxName: string,
    model: string,
    provider: string,
    nimContainer: string | null,
    agent: Agent | null,
  ) => void;
};

function cloneSession(session: Session): Session {
  return normalizeSession(JSON.parse(JSON.stringify(session))) ?? session;
}

function sessionWithUpdates(updates: SessionUpdates = {}): Session {
  const session = createSession();
  Object.assign(session, updates);
  if (updates.metadata) session.metadata = { ...session.metadata, ...updates.metadata };
  return session;
}

export function sessionAt(state: OnboardMachineState): Session {
  return createSession({
    sandboxName: "my-sandbox",
    provider: "nim",
    model: "nvidia/test",
    machine: {
      version: MACHINE_SNAPSHOT_VERSION,
      state,
      stateEnteredAt: "2026-06-10T00:00:00.000Z",
      revision: 0,
    },
  });
}

export function createRuntimeHarness(initialSession: Session) {
  let session = cloneSession(initialSession);
  const events: OnboardMachineEvent[] = [];
  const updateSession = (mutator: (value: Session) => Session | void): Session => {
    const current = cloneSession(session);
    session = cloneSession(mutator(current) ?? current);
    return cloneSession(session);
  };
  const deps: OnboardRuntimeDeps = {
    loadSession: () => cloneSession(session),
    createSession,
    saveSession: (next) => {
      session = cloneSession(next);
      return cloneSession(session);
    },
    updateSession,
    markStepStarted: () => cloneSession(session),
    markStepComplete: (_stepName, updates: SessionUpdates = {}) =>
      updateSession((current) => Object.assign(current, filterSafeUpdates(updates))),
    markStepCompleteRecordOnly: (_stepName, updates: SessionUpdates = {}) =>
      updateSession((current) => Object.assign(current, filterSafeUpdates(updates))),
    markStepSkipped: () => cloneSession(session),
    markStepFailed: () => cloneSession(session),
    markStepFailedRecordOnly: () => cloneSession(session),
    completeSession: (updates: SessionUpdates = {}) =>
      updateSession((current) => {
        Object.assign(current, filterSafeUpdates(updates));
        current.status = "complete";
        current.resumable = false;
        return current;
      }),
    filterSafeUpdates,
    emitEvent: (event) => events.push(event),
    now: () => "2026-06-10T00:00:00.000Z",
  };
  const boundary = new OnboardRuntimeBoundary({
    toSessionUpdates: (updates: Record<string, unknown>) =>
      filterSafeUpdates(updates as SessionUpdates) as SessionUpdates,
    maybeForceE2eStepFailure: () => undefined,
    createRuntime: () => new OnboardRuntime(deps),
  });
  return {
    boundary,
    events,
    getSession: () => cloneSession(session),
  };
}

export function context(
  patch: Partial<OnboardFlowContext<Agent | null>> = {},
): OnboardFlowContext<Agent | null> {
  return {
    resume: false,
    fresh: false,
    session: createSession(),
    agent: null,
    recordedSandboxName: null,
    requestedSandboxName: null,
    sandboxName: "my-sandbox",
    fromDockerfile: null,
    model: "nvidia/test",
    provider: "nim",
    endpointUrl: "https://example.test/v1",
    credentialEnv: "NVIDIA_API_KEY",
    hermesAuthMethod: null,
    hermesToolGateways: ["local"],
    preferredInferenceApi: "chat",
    nimContainer: "nim-test",
    webSearchConfig: null,
    webSearchSupported: true,
    selectedMessagingChannels: ["slack"],
    gpu: null,
    sandboxGpuConfig: null,
    gpuPassthrough: false,
    ...patch,
  };
}

export function createPhases(
  branchState: "agent_setup" | "openclaw",
  order: string[] = [],
  recorders: RecorderOverrides = {},
) {
  return createFinalOnboardFlowPhases<
    OnboardFlowContext<Agent | null>,
    DashboardDeliveryChain,
    VerifyDeploymentResult
  >({
    branchState,
    agentSetupDeps: {
      handleAgentSetup: vi.fn(async () => {
        order.push("agent-setup");
      }),
      agentSetupContext: () => ({}),
      ensureAgentDashboardForward: vi.fn(() => {
        order.push("agent-forward");
        return 45123;
      }),
      recordStepSkipped: recorders.recordStepSkipped ?? vi.fn(async () => createSession()),
      isOpenclawReady: () => false,
      skippedStepMessage: vi.fn(),
      recordStateSkipped: recorders.recordStateSkipped ?? vi.fn(async () => createSession()),
      startRecordedStep: recorders.startRecordedStep ?? vi.fn(async () => undefined),
      setupOpenclaw: vi.fn(async () => {
        order.push("openclaw");
      }),
      syncNemoClawConfigInSandbox: vi.fn(),
      recordStepComplete:
        recorders.recordStepComplete ??
        vi.fn(async (_stepName: string, updates: SessionUpdates = {}) =>
          sessionWithUpdates(updates),
        ),
      toSessionUpdates: (updates) => updates as SessionUpdates,
    },
    policiesDeps: {
      loadSession: recorders.loadSession ?? (() => createSession()),
      getActiveSandbox: () => null,
      mergePolicyMessagingChannels:
        recorders.mergePolicyMessagingChannels ?? ((selected) => selected),
      verifyCompatibleEndpointSandboxSmoke: vi.fn(),
      preparePolicyPresetResumeSelection: () => ({
        policyPresets: ["balanced"],
        recordedPolicyPresetsNeedReconcile: false,
        disabledMessagingPolicyPresetApplied: false,
      }),
      arePolicyPresetsApplied: () => false,
      skippedStepMessage: vi.fn(),
      recordStateSkipped: recorders.recordStateSkipped ?? vi.fn(async () => createSession()),
      startRecordedStep: recorders.startRecordedStep ?? vi.fn(async () => undefined),
      setupPoliciesWithSelection: vi.fn(async () => {
        order.push("policies");
        return ["balanced"];
      }),
      updateSession:
        recorders.updateSession ?? vi.fn((mutator) => mutator(createSession()) ?? createSession()),
      recordStepComplete:
        recorders.recordStepComplete ??
        vi.fn(async (_stepName: string, updates: SessionUpdates = {}) =>
          sessionWithUpdates(updates),
        ),
      toSessionUpdates: (updates) => updates as SessionUpdates,
      persistAppliedPolicyPresets: vi.fn(),
    },
    finalization: {
      stagedLegacyKeys: [],
      migratedLegacyKeys: new Set(),
      webSearchEnabled: () => false,
    },
    finalizationDeps: {
      ensureAgentDashboardForward: vi.fn(() => {
        order.push("agent-forward");
        return 45123;
      }),
      setDefaultSandbox: vi.fn(() => {
        order.push("set-default");
      }),
      recordPostVerifyStarted:
        recorders.recordPostVerifyStarted ?? vi.fn(async () => createSession()),
      toSessionUpdates: (updates) => updates as NonNullable<SessionUpdates>,
      removeLegacyCredentialsFile: vi.fn(),
      cleanupStaleHostFiles: vi.fn(),
      checkAndRecoverSandboxProcesses: vi.fn(),
      autoPairScopeApproval: vi.fn(),
      getChatUiUrl: () => "http://127.0.0.1:45123",
      buildVerifyChain: (): DashboardDeliveryChain => ({
        accessUrl: "http://127.0.0.1:45123",
        corsOrigins: ["http://127.0.0.1:45123"],
        forwardTarget: "45123",
        healthEndpoint: "/health",
        dashboardHealthEndpoint: "/health",
        gatewayPort: 45124,
        gatewayHealthEndpoint: "/health",
        port: 45123,
        bindAddress: "127.0.0.1",
        shouldDisableDeviceAuth: false,
      }),
      verifyDeployment:
        recorders.verifyDeployment ??
        vi.fn(async (): Promise<VerifyDeploymentResult> => {
          order.push("verify");
          return {
            healthy: true,
            verification: {
              gatewayReachable: true,
              gatewayVersion: "test",
              inferenceRouteWorking: true,
              dashboardReachable: true,
              messagingBridgesHealthy: true,
              messagingRuntimeChannelsMissing: null,
              messagingConfigChannelsMissing: null,
              accessMethod: "localhost" as const,
            },
            diagnostics: [],
          };
        }),
      formatVerificationDiagnostics: () => [],
      verifyWebSearchInsideSandbox: vi.fn(),
      printDashboard: recorders.printDashboard ?? vi.fn(),
      error: vi.fn(),
      log: vi.fn(),
    },
  });
}
