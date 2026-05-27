// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession, type Session, type SessionUpdates } from "../../../state/onboard-session";
import { handlePoliciesState, type PoliciesStateOptions } from "./policies";

type Agent = { name: string } | null;
type WebSearchConfig = { fetchEnabled: true };

function createDeps(overrides: Partial<PoliciesStateOptions<Agent, WebSearchConfig>["deps"]> = {}) {
  let session = createSession();
  const calls = {
    load: vi.fn(() => session),
    activeSandbox: vi.fn(() => ({ messagingChannels: ["telegram"], disabledChannels: null })),
    mergeChannels: vi.fn(
      (
        selected: string[],
        recorded: string[],
        active: string[] | null | undefined,
      ) => (selected.length > 0 ? selected : active ?? recorded),
    ),
    smoke: vi.fn(),
    prepareResume: vi.fn(
      (
        _sandboxName: string,
        options: Parameters<PoliciesStateOptions<Agent, WebSearchConfig>["deps"]["preparePolicyPresetResumeSelection"]>[1],
      ) => ({
        policyPresets: (options.recordedPolicyPresets ?? []).filter((name) => name !== "unsupported"),
        recordedPolicyPresetsNeedReconcile: (options.recordedPolicyPresets ?? []).includes("unsupported"),
        disabledMessagingPolicyPresetApplied: false,
      }),
    ),
    appliedCheck: vi.fn(() => false),
    skipped: vi.fn(),
    recordSkip: vi.fn(async () => session),
    startStep: vi.fn(async () => undefined),
    setupPolicies: vi.fn(async () => ["npm"]),
    updateSession: vi.fn((mutator: (value: Session) => Session | void) => {
      session = mutator(session) ?? session;
      return session;
    }),
    complete: vi.fn(async () => session),
  };
  return {
    calls,
    deps: {
      loadSession: calls.load,
      getActiveSandbox: calls.activeSandbox,
      mergePolicyMessagingChannels: calls.mergeChannels,
      verifyCompatibleEndpointSandboxSmoke: calls.smoke,
      preparePolicyPresetResumeSelection: calls.prepareResume,
      arePolicyPresetsApplied: calls.appliedCheck,
      skippedStepMessage: calls.skipped,
      recordStateSkipped: calls.recordSkip,
      startRecordedStep: calls.startStep,
      setupPoliciesWithSelection: calls.setupPolicies,
      updateSession: calls.updateSession,
      recordStepComplete: calls.complete,
      toSessionUpdates: (updates: Record<string, unknown>) => updates as SessionUpdates,
      ...overrides,
    },
    setSession(next: Session) {
      session = next;
    },
    getSession: () => session,
  };
}

function baseOptions(
  deps: PoliciesStateOptions<Agent, WebSearchConfig>["deps"],
): PoliciesStateOptions<Agent, WebSearchConfig> {
  return {
    resume: false,
    sandboxName: "my-assistant",
    provider: "provider",
    model: "model",
    endpointUrl: "https://example.com/v1",
    credentialEnv: "NVIDIA_API_KEY",
    selectedMessagingChannels: [],
    webSearchConfig: null,
    webSearchSupported: true,
    hermesToolGateways: [],
    agent: null,
    deps,
  };
}

describe("handlePoliciesState", () => {
  it("runs compatible endpoint smoke before policy selection", async () => {
    const { deps, calls } = createDeps();

    await handlePoliciesState(baseOptions(deps));

    expect(calls.smoke).toHaveBeenCalledWith({
      sandboxName: "my-assistant",
      provider: "provider",
      model: "model",
      endpointUrl: "https://example.com/v1",
      credentialEnv: "NVIDIA_API_KEY",
      messagingChannels: ["telegram"],
      agent: null,
    });
    expect(calls.startStep).toHaveBeenCalledWith("policies", {
      sandboxName: "my-assistant",
      provider: "provider",
      model: "model",
      policyPresets: [],
    });
    expect(calls.setupPolicies).toHaveBeenCalledWith(
      "my-assistant",
      expect.objectContaining({
        selectedPresets: null,
        enabledChannels: ["telegram"],
        provider: "provider",
        webSearchSupported: true,
      }),
    );
    expect(calls.complete).toHaveBeenCalledWith(
      "policies",
      expect.objectContaining({ policyPresets: ["npm"] }),
    );
  });

  it("uses recorded messaging channels when no active selection exists", async () => {
    const session = createSession({ messagingChannels: ["slack"] });
    const { deps, calls, setSession } = createDeps({
      getActiveSandbox: vi.fn(() => ({ messagingChannels: null, disabledChannels: null })),
    });
    setSession(session);

    await handlePoliciesState(baseOptions(deps));

    expect(calls.setupPolicies).toHaveBeenCalledWith(
      "my-assistant",
      expect.objectContaining({ enabledChannels: ["slack"] }),
    );
  });

  it("resumes policies when all recorded presets are already applied", async () => {
    const session = createSession({ policyPresets: ["npm"] });
    const { deps, calls, setSession } = createDeps({
      arePolicyPresetsApplied: vi.fn(() => true),
    });
    setSession(session);

    const result = await handlePoliciesState({ ...baseOptions(deps), resume: true });

    expect(calls.skipped).toHaveBeenCalledWith("policies", "npm");
    expect(calls.recordSkip).toHaveBeenCalledWith("policies", {
      reason: "resume",
      policyPresets: ["npm"],
    });
    expect(calls.setupPolicies).not.toHaveBeenCalled();
    expect(calls.complete).toHaveBeenCalledWith(
      "policies",
      expect.objectContaining({ policyPresets: ["npm"] }),
    );
    expect(result.appliedPolicyPresets).toEqual(["npm"]);
  });

  it("reconciles unsupported recorded presets before interactive setup", async () => {
    const session = createSession({ policyPresets: ["npm", "unsupported"] });
    const { deps, calls, setSession } = createDeps();
    setSession(session);

    await handlePoliciesState(baseOptions(deps));

    expect(calls.prepareResume).toHaveBeenCalledWith(
      "my-assistant",
      expect.objectContaining({ recordedPolicyPresets: ["npm", "unsupported"] }),
    );
    expect(calls.setupPolicies).toHaveBeenCalledWith(
      "my-assistant",
      expect.objectContaining({ selectedPresets: ["npm"] }),
    );
  });

  it("merges required Hermes tool gateway presets into recorded selections", async () => {
    const session = createSession({ policyPresets: ["npm"] });
    const prepareResume = vi.fn((_sandboxName, options) => ({
      policyPresets: [...(options.recordedPolicyPresets ?? []), ...options.hermesToolGateways],
      recordedPolicyPresetsNeedReconcile: false,
      disabledMessagingPolicyPresetApplied: false,
    }));
    const { deps, calls, setSession } = createDeps({
      preparePolicyPresetResumeSelection: prepareResume,
    });
    setSession(session);

    await handlePoliciesState({ ...baseOptions(deps), hermesToolGateways: ["github"] });

    expect(prepareResume).toHaveBeenCalledWith(
      "my-assistant",
      expect.objectContaining({ hermesToolGateways: ["github"] }),
    );
    expect(calls.setupPolicies).toHaveBeenCalledWith(
      "my-assistant",
      expect.objectContaining({ selectedPresets: ["npm", "github"] }),
    );
  });
});
