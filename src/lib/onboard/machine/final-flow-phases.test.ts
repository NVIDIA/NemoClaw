// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession, type Session, type SessionUpdates } from "../../state/onboard-session";
import type { DashboardDeliveryChain } from "../../dashboard/contract";
import type { VerifyDeploymentResult } from "../../verify-deployment";
import type { OnboardFlowContext } from "./flow-context";
import { createFinalOnboardFlowPhases, runFinalOnboardFlowSlice } from "./final-flow-phases";

type Agent = { name: string };

function sessionWithUpdates(updates: SessionUpdates = {}): Session {
  const session = createSession();
  Object.assign(session, updates);
  if (updates.metadata) session.metadata = { ...session.metadata, ...updates.metadata };
  return session;
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

function createPhases(branchState: "agent_setup" | "openclaw", order: string[] = []) {
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
      recordStepSkipped: vi.fn(async () => createSession()),
      isOpenclawReady: () => false,
      skippedStepMessage: vi.fn(),
      recordStateSkipped: vi.fn(async () => createSession()),
      startRecordedStep: vi.fn(async () => undefined),
      setupOpenclaw: vi.fn(async () => {
        order.push("openclaw");
      }),
      syncNemoClawConfigInSandbox: vi.fn(),
      recordStepComplete: vi.fn(async (_stepName: string, updates: SessionUpdates = {}) =>
        sessionWithUpdates(updates),
      ),
      toSessionUpdates: (updates) => updates as SessionUpdates,
    },
    policiesDeps: {
      loadSession: () => createSession(),
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
      recordStateSkipped: vi.fn(async () => createSession()),
      startRecordedStep: vi.fn(async () => undefined),
      setupPoliciesWithSelection: vi.fn(async () => {
        order.push("policies");
        return ["balanced"];
      }),
      updateSession: vi.fn((mutator) => mutator(createSession()) ?? createSession()),
      recordStepComplete: vi.fn(async (_stepName: string, updates: SessionUpdates = {}) =>
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
      recordPostVerifyStarted: vi.fn(async () => createSession()),
      toSessionUpdates: (updates) => updates as NonNullable<SessionUpdates>,
      removeLegacyCredentialsFile: vi.fn(),
      cleanupStaleHostFiles: vi.fn(),
      checkAndRecoverSandboxProcesses: vi.fn(),
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
});
