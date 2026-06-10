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
      (selected: string[], recorded: string[], active: string[] | null | undefined) =>
        selected.length > 0 ? selected : (active ?? recorded),
    ),
    smoke: vi.fn(),
    prepareResume: vi.fn(
      (
        _sandboxName: string,
        options: Parameters<
          PoliciesStateOptions<Agent, WebSearchConfig>["deps"]["preparePolicyPresetResumeSelection"]
        >[1],
      ) => ({
        policyPresets: (options.recordedPolicyPresets ?? []).filter(
          (name) => name !== "unsupported",
        ),
        recordedPolicyPresetsNeedReconcile: (options.recordedPolicyPresets ?? []).includes(
          "unsupported",
        ),
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
    persistPolicies: vi.fn((_sandboxName: string, _appliedPolicyPresets: string[]) => undefined),
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
      persistAppliedPolicyPresets: calls.persistPolicies,
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

    const result = await handlePoliciesState(baseOptions(deps));

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
    expect(result.stateResult).toEqual({
      type: "transition",
      next: "finalizing",
      transitionKind: "advance",
      updates: undefined,
      metadata: { state: "policies", policyPresets: ["npm"] },
    });
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
    expect(result.stateResult).toMatchObject({
      next: "finalizing",
      transitionKind: "advance",
      metadata: { policyPresets: ["npm"] },
    });
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

  it("forwards 'openclaw' to setupPoliciesWithSelection when agent is null (default OpenClaw)", async () => {
    const { deps, calls } = createDeps();

    await handlePoliciesState({ ...baseOptions(deps), agent: null });

    expect(calls.setupPolicies).toHaveBeenCalledWith(
      "my-assistant",
      expect.objectContaining({ agent: "openclaw" }),
    );
  });

  it("forwards 'hermes' to setupPoliciesWithSelection when agent.name is hermes", async () => {
    const { deps, calls } = createDeps();

    await handlePoliciesState({ ...baseOptions(deps), agent: { name: "hermes" } });

    expect(calls.setupPolicies).toHaveBeenCalledWith(
      "my-assistant",
      expect.objectContaining({ agent: "hermes" }),
    );
  });

  it("treats whitespace-only agent.name as default OpenClaw", async () => {
    const { deps, calls } = createDeps();

    await handlePoliciesState({ ...baseOptions(deps), agent: { name: "   " } });

    expect(calls.setupPolicies).toHaveBeenCalledWith(
      "my-assistant",
      expect.objectContaining({ agent: "openclaw" }),
    );
  });

  // Regression for #4621: the sandbox is registered with only create-time/boot
  // presets, so the effective interactive selection must be written back to the
  // registry. Otherwise recreate/re-onboard reads a stale list and reapplies
  // removed tier defaults.
  // The mocks below mirror the real setupPoliciesWithSelection contract: every
  // path that reconciles the live gateway calls onSelection with the effective
  // set; the skip path returns [] without calling it.
  type SetupOptions = {
    selectedPresets: string[] | null;
    onSelection: (presets: string[]) => void;
  };

  it("persists the effective interactive selection to the registry (#4621)", async () => {
    // Operator picked Balanced, removed the `npm` tier default, and added `github`.
    const { deps, calls } = createDeps({
      setupPoliciesWithSelection: vi.fn(async (_name: string, options: SetupOptions) => {
        options.onSelection(["dns", "github"]);
        return ["dns", "github"];
      }),
    });

    const result = await handlePoliciesState(baseOptions(deps));

    expect(calls.persistPolicies).toHaveBeenCalledWith("my-assistant", ["dns", "github"]);
    // The removed Balanced default must not survive into what we persist...
    const [, persisted] = calls.persistPolicies.mock.calls[0] as [string, string[]];
    expect(persisted).not.toContain("npm");
    // ...and the unrelated added preset must be preserved.
    expect(persisted).toContain("github");
    expect(result.appliedPolicyPresets).toEqual(["dns", "github"]);
  });

  it("re-onboard carries the persisted set forward without re-adding removed defaults (#4621)", async () => {
    // A prior onboard recorded the custom "Balanced minus npm plus github" set.
    // On re-onboard the recorded set is re-applied verbatim and persisted back —
    // npm is never reintroduced.
    const session = createSession({ policyPresets: ["dns", "github"] });
    const setupPolicies = vi.fn(async (_name: string, options: SetupOptions) => {
      const presets = options.selectedPresets ?? [];
      options.onSelection(presets);
      return presets;
    });
    const { deps, calls, setSession } = createDeps({
      setupPoliciesWithSelection: setupPolicies,
    });
    setSession(session);

    const result = await handlePoliciesState(baseOptions(deps));

    expect(setupPolicies).toHaveBeenCalledWith(
      "my-assistant",
      expect.objectContaining({ selectedPresets: ["dns", "github"] }),
    );
    expect(calls.persistPolicies).toHaveBeenCalledWith("my-assistant", ["dns", "github"]);
    const [, persisted] = calls.persistPolicies.mock.calls[0] as [string, string[]];
    expect(persisted).not.toContain("npm");
    expect(result.appliedPolicyPresets).toEqual(["dns", "github"]);
  });

  it("does not finalize the registry on the resume (already-applied) branch (#4621)", async () => {
    // The resume branch only confirms recorded presets are a *subset* of what is
    // applied (arePolicyPresetsApplied), not that the live set matches. An
    // interrupted prior run may still have an extra applied preset whose removal
    // never completed, so persisting/finalizing the narrowed recorded set here
    // would wrongly claim that preset is gone. Leave the registry untouched.
    const session = createSession({ policyPresets: ["dns", "github"] });
    const { deps, calls, setSession } = createDeps({
      arePolicyPresetsApplied: vi.fn(() => true),
    });
    setSession(session);

    const result = await handlePoliciesState({ ...baseOptions(deps), resume: true });

    expect(calls.setupPolicies).not.toHaveBeenCalled();
    expect(calls.persistPolicies).not.toHaveBeenCalled();
    expect(result.appliedPolicyPresets).toEqual(["dns", "github"]);
  });

  it("does not clobber the registry when policy presets are skipped (#4621)", async () => {
    // NEMOCLAW_POLICY_MODE=skip/none/no returns [] without touching the live
    // applied set (onSelection never fires). Persisting [] here would wipe the
    // sandbox's real policies, so the write-back must be suppressed.
    const { deps, calls } = createDeps({
      setupPoliciesWithSelection: vi.fn(async () => []),
    });

    const result = await handlePoliciesState(baseOptions(deps));

    expect(calls.persistPolicies).not.toHaveBeenCalled();
    expect(result.appliedPolicyPresets).toEqual([]);
  });
});
