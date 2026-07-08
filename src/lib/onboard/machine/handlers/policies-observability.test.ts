// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession, type SessionUpdates } from "../../../state/onboard-session";
import { handlePoliciesState, type PoliciesStateOptions } from "./policies";

type Agent = { name: string };

describe("handlePoliciesState observability", () => {
  it("threads durable observability intent into policy reconciliation", async () => {
    const session = createSession({ observabilityEnabled: true });
    const prepareResume = vi.fn(() => ({
      policyPresets: [],
      recordedPolicyPresetsNeedReconcile: false,
      disabledMessagingPolicyPresetApplied: false,
      suppressedAgentRequiredPresetsLive: false,
    }));
    const setupPolicies = vi.fn(async () => []);
    const deps = {
      loadSession: () => session,
      getActiveSandbox: () => null,
      mergePolicyMessagingChannels: () => [],
      verifyCompatibleEndpointSandboxSmoke: vi.fn(),
      preparePolicyPresetResumeSelection: prepareResume,
      arePolicyPresetsApplied: () => false,
      skippedStepMessage: vi.fn(),
      recordStateSkipped: vi.fn(async () => session),
      startRecordedStep: vi.fn(async () => undefined),
      setupPoliciesWithSelection: setupPolicies,
      updateSession: () => session,
      recordStepComplete: vi.fn(async () => session),
      toSessionUpdates: (updates: Record<string, unknown>) => updates as SessionUpdates,
      persistAppliedPolicyPresets: vi.fn(),
    } satisfies PoliciesStateOptions<Agent, never>["deps"];

    await handlePoliciesState({
      resume: false,
      sandboxName: "my-assistant",
      provider: "provider",
      model: "model",
      endpointUrl: "https://example.com/v1",
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      selectedMessagingChannels: [],
      webSearchConfig: null,
      webSearchSupported: true,
      hermesToolGateways: [],
      agent: { name: "langchain-deepagents-code" },
      deps,
    });

    expect(prepareResume).toHaveBeenCalledWith(
      "my-assistant",
      expect.objectContaining({ observabilityEnabled: true }),
    );
    expect(setupPolicies).toHaveBeenCalledWith(
      "my-assistant",
      expect.objectContaining({ observabilityEnabled: true }),
    );
  });

  it("keeps an authoritative rebuild tier through resume preparation and policy setup", async () => {
    const session = createSession({
      observabilityEnabled: true,
      policyPresets: ["observability-otlp-local"],
    });
    const prepareResume = vi.fn(() => ({
      policyPresets: [],
      recordedPolicyPresetsNeedReconcile: true,
      disabledMessagingPolicyPresetApplied: false,
      suppressedAgentRequiredPresetsLive: false,
    }));
    const setupPolicies = vi.fn(async () => []);
    const deps = {
      loadSession: () => session,
      getActiveSandbox: () => ({ policyTier: null }),
      mergePolicyMessagingChannels: () => [],
      verifyCompatibleEndpointSandboxSmoke: vi.fn(),
      preparePolicyPresetResumeSelection: prepareResume,
      arePolicyPresetsApplied: () => false,
      skippedStepMessage: vi.fn(),
      recordStateSkipped: vi.fn(async () => session),
      startRecordedStep: vi.fn(async () => undefined),
      setupPoliciesWithSelection: setupPolicies,
      updateSession: () => session,
      recordStepComplete: vi.fn(async () => session),
      toSessionUpdates: (updates: Record<string, unknown>) => updates as SessionUpdates,
      persistAppliedPolicyPresets: vi.fn(),
    } satisfies PoliciesStateOptions<Agent, never>["deps"];

    await handlePoliciesState({
      resume: true,
      authoritativePolicyTier: "restricted",
      sandboxName: "my-assistant",
      provider: "provider",
      model: "model",
      endpointUrl: "https://example.com/v1",
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      selectedMessagingChannels: [],
      webSearchConfig: null,
      webSearchSupported: true,
      hermesToolGateways: [],
      agent: { name: "langchain-deepagents-code" },
      deps,
    });

    expect(prepareResume).toHaveBeenCalledWith(
      "my-assistant",
      expect.objectContaining({ tierName: "restricted" }),
    );
    expect(setupPolicies).toHaveBeenCalledWith(
      "my-assistant",
      expect.objectContaining({ tierName: "restricted", selectedPresets: [] }),
    );
  });
});
