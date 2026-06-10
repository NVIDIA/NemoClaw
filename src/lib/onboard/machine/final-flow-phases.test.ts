// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { DashboardDeliveryChain } from "../../dashboard/contract";
import {
  createSession,
  filterSafeUpdates,
  MACHINE_SNAPSHOT_VERSION,
  normalizeSession,
  type Session,
  type SessionUpdates,
} from "../../state/onboard-session";
import type { VerifyDeploymentResult } from "../../verify-deployment";
import { OnboardRuntimeBoundary } from "../runtime-boundary";
import type { OnboardMachineEvent } from "./events";
import { createFinalOnboardFlowPhases, runFinalOnboardFlowSlice } from "./final-flow-phases";
import type { OnboardFlowContext } from "./flow-context";
import { OnboardRuntime, type OnboardRuntimeDeps } from "./runtime";
import type { OnboardMachineState } from "./types";

type Agent = { name: string };
type RecorderOverrides = {
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

function sessionAt(state: OnboardMachineState): Session {
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

function createRuntimeHarness(initialSession: Session) {
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
    toSessionUpdates: (updates) => filterSafeUpdates(updates as SessionUpdates) as SessionUpdates,
    maybeForceE2eStepFailure: () => undefined,
    createRuntime: () => new OnboardRuntime(deps),
  });
  return {
    boundary,
    events,
    getSession: () => cloneSession(session),
  };
}

function context(
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

function createPhases(
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
      ensureAgentDashboardForward: vi.fn(() => 45123),
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
      mergePolicyMessagingChannels: (selected) => selected,
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
    afterPolicies: () => {
      order.push("disarm");
    },
    finalization: {
      stagedLegacyKeys: [],
      migratedLegacyKeys: new Set(),
      webSearchEnabled: () => false,
    },
    finalizationDeps: {
      ensureAgentDashboardForward: vi.fn(() => 45123),
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
      verifyDeployment: vi.fn(async (): Promise<VerifyDeploymentResult> => {
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
      printDashboard: vi.fn(),
      error: vi.fn(),
      log: vi.fn(),
    },
  });
}

describe("final onboard flow phases", () => {
  it("selects the requested branch setup state", () => {
    expect(createPhases("openclaw")[0].state).toBe("openclaw");
    expect(createPhases("agent_setup")[0].state).toBe("agent_setup");
  });

  it("runs policy disarm before final verification", async () => {
    const order: string[] = [];
    const [branchPhase, policiesPhase, finalizationPhase] = createPhases("openclaw", order);

    const branchResult = await branchPhase.run(context());
    const policiesResult = await policiesPhase.run(branchResult.context);
    await finalizationPhase.run(policiesResult.context);

    expect(order).toEqual(["openclaw", "policies", "disarm", "set-default", "verify"]);
  });

  it("rejects final phases when required context is missing", async () => {
    const [branchPhase, policiesPhase, finalizationPhase] = createPhases("openclaw");
    const incomplete = context({ sandboxName: null });

    await expect(branchPhase.run(incomplete)).rejects.toThrow(
      "Onboarding state is incomplete before agent setup.",
    );
    await expect(policiesPhase.run(incomplete)).rejects.toThrow(
      "Onboarding state is incomplete before policies.",
    );
    await expect(finalizationPhase.run(incomplete)).rejects.toThrow(
      "Onboarding state is incomplete before finalization.",
    );
  });

  it("records each phase result on the resume compatibility path", async () => {
    const order: string[] = [];
    const recorded: string[] = [];
    const phases = createPhases("openclaw", order);

    await runFinalOnboardFlowSlice({
      context: context({ resume: true }),
      runtime: {
        session: async () => createSession(),
        applyResult: async () => createSession(),
      },
      phases,
      resume: true,
      recordStateResult: async (result) => {
        if (result.type === "complete" || result.type === "failed") {
          recorded.push(result.type);
        } else {
          recorded.push(result.next);
        }
      },
    });

    expect(order).toEqual(["openclaw", "policies", "disarm", "set-default", "verify"]);
    expect(recorded).toEqual(["policies", "finalizing", "complete"]);
  });

  it("uses the strict final runner for fresh OpenClaw sessions with a real runtime boundary", async () => {
    const order: string[] = [];
    const harness = createRuntimeHarness(sessionAt("openclaw"));
    const recorders = harness.boundary.recorders();
    const phases = createPhases("openclaw", order, {
      loadSession: harness.getSession,
      recordStepSkipped: recorders.recordStepSkipped,
      recordStateSkipped: recorders.recordStateSkipped,
      startRecordedStep: recorders.startRecordedStep,
      recordStepComplete: recorders.recordStepComplete,
      recordPostVerifyStarted: recorders.recordPostVerifyStarted,
    });
    const compatibilityRecorder = vi.fn(recorders.recordStateResultWithStepCompatibility);

    await runFinalOnboardFlowSlice({
      context: context({ session: harness.getSession() }),
      runtime: harness.boundary.getRuntime(),
      phases,
      resume: false,
      recordStateResult: compatibilityRecorder,
    });

    expect(compatibilityRecorder).not.toHaveBeenCalled();
    expect(order).toEqual(["openclaw", "policies", "disarm", "set-default", "verify"]);
    expect(harness.getSession()).toMatchObject({
      status: "complete",
      sandboxName: "my-sandbox",
      provider: "nim",
      model: "nvidia/test",
      machine: { state: "complete" },
    });
  });

  it.each([
    "policies",
    "finalizing",
    "post_verify",
  ] as const)("keeps persisted %s sessions on the compatibility path with the real runtime boundary", async (initialState) => {
    const order: string[] = [];
    const harness = createRuntimeHarness(sessionAt(initialState));
    const recorders = harness.boundary.recorders();
    const phases = createPhases("openclaw", order, {
      loadSession: harness.getSession,
      recordStepSkipped: recorders.recordStepSkipped,
      recordStateSkipped: recorders.recordStateSkipped,
      startRecordedStep: recorders.startRecordedStep,
      recordStepComplete: recorders.recordStepComplete,
      recordPostVerifyStarted: recorders.recordPostVerifyStarted,
    });
    const compatibilityRecorder = vi.fn(recorders.recordStateResultWithStepCompatibility);

    await runFinalOnboardFlowSlice({
      context: context({ session: harness.getSession() }),
      runtime: harness.boundary.getRuntime(),
      phases,
      resume: false,
      recordStateResult: compatibilityRecorder,
    });

    expect(compatibilityRecorder).toHaveBeenCalled();
    expect(order).toEqual(["openclaw", "policies", "disarm", "set-default", "verify"]);
    expect(harness.getSession()).toMatchObject({
      status: "complete",
      sandboxName: "my-sandbox",
      provider: "nim",
      model: "nvidia/test",
      machine: { state: "complete" },
    });

    const skippedTargets = harness.events
      .filter((event) => event.type === "state.result.skipped")
      .map((event) => event.metadata.targetState);
    expect(skippedTargets).toContain("policies");
    if (initialState !== "policies") {
      expect(skippedTargets).toContain("finalizing");
    }
  });
});
