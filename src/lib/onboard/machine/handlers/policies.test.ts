// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { makeMessagingPlan } from "../../../../../test/helpers/messaging-plan-fixtures";
import { createSession } from "../../../state/onboard-session";
import { mergePolicyMessagingChannels } from "../../messaging-policy-presets";
import { handlePoliciesState } from "./policies";
import {
  basePolicyHandlerOptions as baseOptions,
  createPolicyHandlerDeps,
} from "./policies-test-fixture";

function createDeps(overrides: Parameters<typeof createPolicyHandlerDeps>[0] = {}) {
  return createPolicyHandlerDeps({
    mergePolicyMessagingChannels: vi.fn(mergePolicyMessagingChannels),
    ...overrides,
  });
}

describe("handlePoliciesState", () => {
  it("runs compatible endpoint smoke before policy selection", async () => {
    const { deps, calls } = createDeps();

    const result = await handlePoliciesState(baseOptions(deps));

    expect(calls.smoke).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxName: "my-assistant",
        provider: "provider",
        model: "model",
        endpointUrl: "https://example.com/v1",
        credentialEnv: "NVIDIA_INFERENCE_API_KEY",
        messagingChannels: ["telegram"],
        agent: null,
        beforeSuccess: expect.any(Function),
      }),
    );
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

  it("passes an empty messaging selection to the compatible endpoint smoke (#10405)", async () => {
    const { deps, calls } = createDeps({
      getActiveSandbox: vi.fn(() => ({
        messaging: null,
        policyAuthority: "nemoclaw-managed" as const,
      })),
    });

    await handlePoliciesState({
      ...baseOptions(deps),
      provider: "compatible-endpoint",
      selectedMessagingChannels: [],
    });

    expect(calls.smoke).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "compatible-endpoint",
        messagingChannels: [],
        agent: null,
      }),
    );
    expect(calls.complete).toHaveBeenCalledOnce();
  });

  it("uses recorded messaging channels when no active selection exists", async () => {
    const session = createSession({ messagingPlan: makeMessagingPlan({ channels: ["slack"] }) });
    const { deps, calls, setSession } = createDeps({
      getActiveSandbox: vi.fn(() => ({ messaging: null })),
    });
    setSession(session);

    await handlePoliciesState(baseOptions(deps));

    expect(calls.setupPolicies).toHaveBeenCalledWith(
      "my-assistant",
      expect.objectContaining({ enabledChannels: ["slack"] }),
    );
  });

  it("drops a no-longer-configured channel from the enabled set so its preset is not re-applied", async () => {
    const session = createSession({ messagingPlan: makeMessagingPlan({ channels: ["discord"] }) });
    const { deps, calls, setSession } = createDeps({
      getActiveSandbox: vi.fn(() => ({
        messaging: { plan: makeMessagingPlan({ channels: ["discord"] }) },
      })),
      detectUnconfiguredMessagingChannels: vi.fn(() => ["discord"]),
    });
    setSession(session);

    await handlePoliciesState({ ...baseOptions(deps), selectedMessagingChannels: [] });

    expect(deps.detectUnconfiguredMessagingChannels).toHaveBeenCalledWith(
      ["discord", "discord"],
      [],
      null,
    );
    expect(calls.setupPolicies).toHaveBeenCalledWith(
      "my-assistant",
      expect.objectContaining({ enabledChannels: [], disabledChannels: ["discord"] }),
    );
  });

  it("disables a channel whose preset is applied but which no plan still names (#9283)", async () => {
    const { deps, calls } = createDeps({
      getActiveSandbox: vi.fn(() => ({
        messaging: null,
        policies: ["npm", "pypi", "discord"],
      })),
      detectUnconfiguredMessagingChannels: vi.fn((planChannels: readonly string[]) => [
        ...planChannels,
      ]),
    });

    await handlePoliciesState({ ...baseOptions(deps), selectedMessagingChannels: [] });

    expect(deps.detectUnconfiguredMessagingChannels).toHaveBeenCalledWith(["discord"], [], null);
    expect(calls.setupPolicies).toHaveBeenCalledWith(
      "my-assistant",
      expect.objectContaining({ enabledChannels: [], disabledChannels: ["discord"] }),
    );
  });

  it("leaves a still-configured channel enabled when its preset is applied (#9283)", async () => {
    const { deps, calls } = createDeps({
      getActiveSandbox: vi.fn(() => ({
        messaging: null,
        policies: ["npm", "discord"],
      })),
    });

    await handlePoliciesState({ ...baseOptions(deps), selectedMessagingChannels: ["discord"] });

    expect(deps.detectUnconfiguredMessagingChannels).toHaveBeenCalledWith(
      ["discord"],
      ["discord"],
      null,
    );
    expect(calls.setupPolicies).toHaveBeenCalledWith(
      "my-assistant",
      expect.objectContaining({ enabledChannels: ["discord"], disabledChannels: [] }),
    );
  });

  it("keeps a still-configured channel enabled", async () => {
    const { deps, calls } = createDeps({
      getActiveSandbox: vi.fn(() => ({
        messaging: { plan: makeMessagingPlan({ channels: ["discord"] }) },
      })),
    });

    await handlePoliciesState({ ...baseOptions(deps), selectedMessagingChannels: ["discord"] });

    expect(calls.setupPolicies).toHaveBeenCalledWith(
      "my-assistant",
      expect.objectContaining({ enabledChannels: ["discord"], disabledChannels: [] }),
    );
  });

  it("reports a no-longer-configured channel to the resume check so resume reconciles instead of skipping", async () => {
    const { deps, calls } = createDeps({
      getActiveSandbox: vi.fn(() => ({
        messaging: { plan: makeMessagingPlan({ channels: ["discord"] }) },
      })),
      detectUnconfiguredMessagingChannels: vi.fn(() => ["discord"]),
    });

    await handlePoliciesState({ ...baseOptions(deps), selectedMessagingChannels: [] });

    expect(calls.prepareResume).toHaveBeenCalledWith(
      "my-assistant",
      expect.objectContaining({ disabledChannels: ["discord"], enabledChannels: [] }),
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
      suppressedAgentRequiredPresetsLive: false,
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

  it.each([
    [null, "openclaw"],
    [{ name: "hermes" }, "hermes"],
    [{ name: "langchain-deepagents-code" }, "langchain-deepagents-code"],
  ] as const)(
    "reconciles stale local-inference policy for %s while retaining the real provider attachment",
    async (agent, expectedAgent) => {
      const session = createSession({ policyPresets: ["local-inference", "npm"] });
      const { deps, calls, setSession } = createDeps({
        arePolicyPresetsApplied: vi.fn(() => true),
      });
      setSession(session);

      await handlePoliciesState({
        ...baseOptions(deps),
        resume: true,
        provider: "vllm-local",
        model: "qwen3.5-9b",
        endpointUrl: "https://inference.local/v1",
        credentialEnv: null,
        hostLocalInferenceRouteOnly: true,
        hostLocalInferenceSandboxProofAuthority: {
          service: "vllm",
          directHostPort: 8000,
          directHealthPath: "/health",
          toolCallingRequired: true,
        },
        agent,
      });

      expect(calls.smoke).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "vllm-local",
          endpointUrl: "https://inference.local/v1",
          agent,
          forceCanonicalRoute: true,
          hostLocalInferenceProofAuthority: {
            service: "vllm",
            directHostPort: 8000,
            directHealthPath: "/health",
            toolCallingRequired: true,
          },
        }),
      );
      expect(calls.prepareResume).toHaveBeenCalledWith(
        "my-assistant",
        expect.objectContaining({ recordedPolicyPresets: ["npm"], agent: expectedAgent }),
      );
      expect(calls.setupPolicies).toHaveBeenCalledWith(
        "my-assistant",
        expect.objectContaining({
          selectedPresets: ["npm"],
          provider: null,
          excludedPresets: ["local-inference"],
          agent: expectedAgent,
        }),
      );
      expect(calls.setupPolicies.mock.invocationCallOrder[0]).toBeLessThan(
        calls.smoke.mock.invocationCallOrder[0],
      );
      expect(calls.skipped).not.toHaveBeenCalled();
    },
  );

  it("forces route-only reconciliation when only the live sandbox has stale local-inference", async () => {
    const { deps, calls } = createDeps({
      arePolicyPresetsApplied: vi.fn((_sandboxName: string, selectedPresets: string[]) =>
        selectedPresets.includes("local-inference"),
      ),
    });

    await handlePoliciesState({
      ...baseOptions(deps),
      resume: true,
      provider: "ollama-local",
      model: "qwen3.5-9b",
      endpointUrl: "https://inference.local/v1",
      credentialEnv: null,
      hostLocalInferenceRouteOnly: true,
      hostLocalInferenceSandboxProofAuthority: {
        service: "ollama",
        directHostPort: 11434,
        directHealthPath: "/api/tags",
        toolCallingRequired: true,
      },
    });

    expect(calls.setupPolicies).toHaveBeenCalledWith(
      "my-assistant",
      expect.objectContaining({
        selectedPresets: null,
        provider: null,
        excludedPresets: ["local-inference"],
      }),
    );
    expect(calls.skipped).not.toHaveBeenCalled();
  });

  it.each([null, { name: "hermes" }, { name: "langchain-deepagents-code" }] as const)(
    "keeps the inference step recoverable when the post-policy route proof fails for %s",
    async (agent) => {
      const smokeFailure = new Error("exact model route proof failed");
      const { deps, calls } = createDeps({
        verifyCompatibleEndpointSandboxSmoke: vi.fn(() => {
          throw smokeFailure;
        }),
      });

      await expect(
        handlePoliciesState({
          ...baseOptions(deps),
          provider: "vllm-local",
          model: "qwen3.5-9b",
          endpointUrl: "https://inference.local/v1",
          credentialEnv: null,
          hostLocalInferenceRouteOnly: true,
          hostLocalInferenceSandboxProofAuthority: {
            service: "vllm",
            directHostPort: 8000,
            directHealthPath: "/health",
            toolCallingRequired: true,
          },
          agent,
        }),
      ).rejects.toBe(smokeFailure);

      expect(calls.setupPolicies).toHaveBeenCalledOnce();
      expect(calls.complete).not.toHaveBeenCalled();
      expect(calls.recordSkip).not.toHaveBeenCalled();
    },
  );

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

  it("keeps the policy step resumable when finalized registry persistence fails (#4621)", async () => {
    const setupPolicies = vi.fn(async (_name: string, options: SetupOptions) => {
      options.onSelection(["npm"]);
      return ["npm"];
    });
    const persistPolicies = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { deps, calls } = createDeps({
      setupPoliciesWithSelection: setupPolicies,
      persistAppliedPolicyPresets: persistPolicies,
    });

    await expect(handlePoliciesState(baseOptions(deps))).rejects.toThrow(
      "Failed to persist finalized policy presets for sandbox 'my-assistant'.",
    );
    expect(calls.complete).not.toHaveBeenCalled();

    await expect(
      handlePoliciesState({ ...baseOptions(deps), resume: true }),
    ).resolves.toMatchObject({ appliedPolicyPresets: ["npm"] });
    expect(setupPolicies).toHaveBeenCalledTimes(2);
    expect(persistPolicies).toHaveBeenCalledTimes(2);
    expect(calls.complete).toHaveBeenCalledOnce();
  });

  it("verifies external selections without recording NemoClaw preset ownership (#9833)", async () => {
    const setupPolicies = vi.fn(async () => ["dns", "github"]);
    const revalidatePolicyRequirements = vi.fn();
    const verifySandboxSmoke = vi.fn((options: { beforeSuccess?: () => void }) =>
      options.beforeSuccess?.(),
    );
    const { deps, calls, setSession } = createDeps({
      getActiveSandbox: vi.fn(() => ({
        messaging: null,
        policyAuthority: "externally-managed" as const,
      })),
      setupPoliciesWithSelection: setupPolicies,
      verifyCompatibleEndpointSandboxSmoke: verifySandboxSmoke,
    });
    setSession(createSession({ policyAuthority: "externally-managed" }));

    const result = await handlePoliciesState({
      ...baseOptions(deps),
      resume: true,
      revalidatePolicyRequirements,
    });

    expect(setupPolicies).not.toHaveBeenCalled();
    expect(calls.prepareResume).not.toHaveBeenCalled();
    expect(calls.persistPolicies).not.toHaveBeenCalled();
    expect(calls.updateSession).not.toHaveBeenCalled();
    expect(calls.recordSkip).toHaveBeenCalledWith("policies", {
      reason: "externally_managed",
    });
    expect(verifySandboxSmoke).toHaveBeenCalledWith(
      expect.objectContaining({ beforeSuccess: expect.any(Function) }),
    );
    expect(revalidatePolicyRequirements).toHaveBeenCalledTimes(4);
    expect(calls.complete).toHaveBeenCalledWith(
      "policies",
      expect.objectContaining({ policyPresets: null }),
    );
    expect(result.appliedPolicyPresets).toEqual([]);
    expect(result.stateResult).toEqual(
      expect.objectContaining({ metadata: { state: "policies" } }),
    );
  });

  it("refuses managed policy setup before policy mutation when authority drifts (#9833)", async () => {
    const refusePolicyMutation = () => {
      throw new Error("policy authority changed");
    };
    const policyChecks = new Map([
      ["apply policy presets to sandbox 'my-assistant'", refusePolicyMutation],
    ]);
    const revalidatePolicyRequirements = vi.fn((operation: string) =>
      policyChecks.get(operation)?.(),
    );
    const { deps, calls } = createDeps();

    await expect(
      handlePoliciesState({
        ...baseOptions(deps),
        revalidatePolicyRequirements,
      }),
    ).rejects.toThrow("policy authority changed");

    expect(calls.setupPolicies).not.toHaveBeenCalled();
    expect(calls.persistPolicies).not.toHaveBeenCalled();
    expect(calls.complete).not.toHaveBeenCalled();
  });

  it("uses external session authority when the registry row is missing (#9833)", async () => {
    const { deps, calls, setSession } = createDeps({
      getActiveSandbox: vi.fn(() => null),
    });
    setSession(createSession({ policyAuthority: "externally-managed" }));

    await handlePoliciesState(baseOptions(deps));

    expect(calls.setupPolicies).not.toHaveBeenCalled();
    expect(calls.persistPolicies).not.toHaveBeenCalled();
    expect(calls.complete).toHaveBeenCalledWith(
      "policies",
      expect.objectContaining({ policyPresets: null }),
    );
  });

  it("refuses legacy policy state when no authority is recorded (#9833)", async () => {
    const { deps, calls } = createDeps({
      loadSession: () => createSession(),
      getActiveSandbox: vi.fn(() => null),
    });

    await expect(handlePoliciesState(baseOptions(deps))).rejects.toThrow(
      /policy authority is not recorded/u,
    );

    expect(calls.setupPolicies).not.toHaveBeenCalled();
    expect(calls.persistPolicies).not.toHaveBeenCalled();
  });

  it("verifies the canonical host-local route under external authority (#9833)", async () => {
    const agent = { name: "openclaw" };
    const { deps, calls, setSession } = createDeps({
      getActiveSandbox: vi.fn(() => ({
        messaging: null,
        policyAuthority: "externally-managed" as const,
      })),
    });
    setSession(createSession({ policyAuthority: "externally-managed" }));

    await handlePoliciesState({
      ...baseOptions(deps),
      provider: "vllm-local",
      model: "qwen3.5-9b",
      endpointUrl: "https://inference.local/v1",
      credentialEnv: null,
      hostLocalInferenceRouteOnly: true,
      hostLocalInferenceSandboxProofAuthority: {
        service: "vllm",
        directHostPort: 8000,
        directHealthPath: "/health",
        toolCallingRequired: true,
      },
      agent,
    });

    expect(calls.smoke).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "vllm-local",
        endpointUrl: "https://inference.local/v1",
        agent,
        forceCanonicalRoute: true,
        hostLocalInferenceProofAuthority: {
          service: "vllm",
          directHostPort: 8000,
          directHealthPath: "/health",
          toolCallingRequired: true,
        },
      }),
    );
    expect(calls.setupPolicies).not.toHaveBeenCalled();
    expect(calls.persistPolicies).not.toHaveBeenCalled();
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

  it("retries inactive Hermes preset removal after synchronization fails", async () => {
    const removalFailure = new Error("policy removal failed");
    const session = createSession({ policyPresets: ["npm", "slack"] });
    const setupPolicies = vi
      .fn<(_name: string, options: SetupOptions) => Promise<string[]>>()
      .mockRejectedValueOnce(removalFailure)
      .mockImplementationOnce(async (_name, options) => {
        options.onSelection(["npm"]);
        return ["npm"];
      });
    const { deps, calls, getSession, setSession } = createDeps({
      getActiveSandbox: vi.fn(() => ({ messaging: null, policies: ["npm", "slack"] })),
      detectUnconfiguredMessagingChannels: vi.fn(() => ["slack"]),
      preparePolicyPresetResumeSelection: vi.fn((_sandboxName, options) => ({
        policyPresets: ["npm"],
        recordedPolicyPresetsNeedReconcile: (options.recordedPolicyPresets ?? []).includes("slack"),
        disabledMessagingPolicyPresetApplied: false,
        suppressedAgentRequiredPresetsLive: false,
      })),
      arePolicyPresetsApplied: vi.fn(() => true),
      setupPoliciesWithSelection: setupPolicies,
    });
    setSession(session);
    const options = {
      ...baseOptions(deps),
      resume: true,
      selectedMessagingChannels: [],
      agent: { name: "hermes" },
    };

    await expect(handlePoliciesState(options)).rejects.toBe(removalFailure);
    expect(getSession().policyPresets).toEqual(["npm", "slack"]);
    expect(calls.persistPolicies).not.toHaveBeenCalled();

    await expect(handlePoliciesState(options)).resolves.toMatchObject({
      appliedPolicyPresets: ["npm"],
    });
    expect(setupPolicies).toHaveBeenCalledTimes(2);
    expect(getSession().policyPresets).toEqual(["npm"]);
    expect(calls.persistPolicies).toHaveBeenCalledWith("my-assistant", ["npm"]);
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
