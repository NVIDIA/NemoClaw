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

function context(): OnboardFlowContext<null, null, Record<string, never>> {
  return {
    resume: true,
    fresh: false,
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

  it.each([{ fingerprint: "intent-1" }, { fingerprint: null }])(
    "keeps routing journal fingerprint $fingerprint to the sandbox resume decision (#9844)",
    async ({ fingerprint }) => {
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

      await phase.run(context());

      expect(mocks.handleSandboxState).toHaveBeenCalledWith(
        expect.objectContaining({ recreateJournalTargetIntentFingerprint: fingerprint }),
      );
    },
  );

  it("does not suppress ordinary OpenClaw pairing settlement on a rebuild handoff (#10479)", async () => {
    // Container recreation wipes the machine-local pairing state
    // (identity/devices are `backup: false` and removed on destroy), so a
    // rebuild handoff must reach finalization exactly like fresh onboarding:
    // the final handlers settle ordinary OpenClaw pairing before readiness.
    const sandboxPhase = createSandboxOnboardFlowPhase({
      gatewayName: "nemoclaw",
      recreateJournalTargetIntentFingerprint: "intent-1",
      resumeAgentChanged: false,
      endpointProvenance: { getSandboxRegistryEntry: () => null },
      recreateSandbox: () => true,
      controlUiPort: null,
      rootDir: "/repo",
      env: {},
      deps: {} as never,
    });
    const sandboxResult = await sandboxPhase.run(context());

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

    await phases[2].run(sandboxResult.context);
    await phases[3].run(sandboxResult.context);

    expect(mocks.handleFinalizationState).toHaveBeenCalledWith(
      expect.not.objectContaining({ recreateJournalHandoff: expect.anything() }),
    );
    expect(mocks.handlePostVerifyState).toHaveBeenCalledWith(
      expect.not.objectContaining({ recreateJournalHandoff: expect.anything() }),
    );
  });
});
