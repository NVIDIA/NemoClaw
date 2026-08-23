// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleSandboxState: vi.fn(),
  handleFinalizationState: vi.fn(),
  handlePostVerifyState: vi.fn(),
}));

vi.mock("./handlers/sandbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./handlers/sandbox")>()),
  handleSandboxState: mocks.handleSandboxState,
}));

vi.mock("./handlers/finalization", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./handlers/finalization")>()),
  handleFinalizationState: mocks.handleFinalizationState,
  handlePostVerifyState: mocks.handlePostVerifyState,
}));

import { createSandboxOnboardFlowPhase } from "./core-flow-phases";
import { createFinalOnboardFlowPhases } from "./final-flow-phases";
import type { OnboardFlowContext } from "./flow-context";
import { advanceTo, branchTo, completeOnboardMachine } from "./result";
import { createSession } from "../../state/onboard-session";

function context(
  recreateJournalHandoff?: boolean,
): OnboardFlowContext<null, null, Record<string, never>> {
  return {
    resume: true,
    fresh: false,
    recreateJournalHandoff,
    session: createSession(),
    agent: null,
    recordedSandboxName: "alpha",
    requestedSandboxName: "alpha",
    sandboxName: "alpha",
    fromDockerfile: null,
    model: "model-a",
    provider: "nvidia",
    endpointUrl: "https://integrate.api.nvidia.com/v1",
    credentialEnv: "NVIDIA_API_KEY",
    hermesAuthMethod: null,
    hermesToolGateways: [],
    preferredInferenceApi: "openai",
    compatibleEndpointReasoning: null,
    compatibleEndpointReasoningEffort: null,
    nimContainer: null,
    webSearchConfig: null,
    webSearchSupported: false,
    selectedMessagingChannels: [],
    gpu: null,
    sandboxGpuConfig: {},
    gpuPassthrough: false,
  };
}

describe("rebuild pairing handoff", () => {
  beforeEach(() => {
    mocks.handleSandboxState.mockReset().mockResolvedValue({
      sandboxName: "alpha",
      webSearchConfig: null,
      webSearchConfigChanged: false,
      hermesToolGateways: [],
      selectedMessagingChannels: [],
      webSearchSupported: false,
      session: createSession(),
      stateResult: branchTo("openclaw", { metadata: { state: "sandbox" } }),
    });
    mocks.handleFinalizationState.mockReset().mockResolvedValue({
      stateResult: advanceTo("post_verify", { metadata: { state: "finalizing" } }),
      unmigratedLegacyKeys: [],
    });
    mocks.handlePostVerifyState.mockReset().mockResolvedValue({
      stateResult: completeOnboardMachine({}, { metadata: { state: "post_verify" } }),
      verificationDiagnostics: [],
      deploymentHealthy: true,
    });
  });

  it.each([
    { fingerprint: "intent-1", expected: true },
    { fingerprint: null, expected: false },
  ])(
    "maps journal fingerprint $fingerprint to handoff=$expected (#9844)",
    async ({ fingerprint, expected }) => {
      const phase = createSandboxOnboardFlowPhase({
        gatewayName: "nemoclaw",
        recreateJournalTargetIntentFingerprint: fingerprint,
        resumeAgentChanged: false,
        endpointProvenance: { getSandboxRegistryEntry: () => null },
        recreateSandbox: () => true,
        controlUiPort: null,
        rootDir: "/repo",
        env: {},
        deps: {} as never,
      });

      const result = await phase.run(context());

      expect(result.context.recreateJournalHandoff).toBe(expected);
      expect(mocks.handleSandboxState).toHaveBeenCalledWith(
        expect.objectContaining({ recreateJournalTargetIntentFingerprint: fingerprint }),
      );
    },
  );

  it.each([true, false])(
    "passes handoff=%s from final-flow context to both final handlers (#9844)",
    async (recreateJournalHandoff) => {
      const phases = createFinalOnboardFlowPhases({
        branchState: "openclaw",
        agentSetupDeps: {} as never,
        policiesDeps: {} as never,
        finalization: {
          stagedLegacyKeys: [],
          migratedLegacyKeys: new Set(),
          webSearchEnabled: () => false,
          webSearchProvider: () => "brave",
        },
        finalizationDeps: {} as never,
      });
      const finalContext = context(recreateJournalHandoff);

      await phases[2].run(finalContext);
      await phases[3].run(finalContext);

      expect(mocks.handleFinalizationState).toHaveBeenCalledWith(
        expect.objectContaining({ recreateJournalHandoff }),
      );
      expect(mocks.handlePostVerifyState).toHaveBeenCalledWith(
        expect.objectContaining({ recreateJournalHandoff }),
      );
    },
  );
});
