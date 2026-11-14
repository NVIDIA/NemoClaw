// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { makeMessagingPlan } from "../../../../../test/helpers/messaging-plan-fixtures";
import { createSession } from "../../../state/onboard-session";
import { createPolicyHandlerDeps, basePolicyHandlerOptions } from "./policies-test-fixture";
import { handlePoliciesState } from "./policies";
import { nativeLocalTestReceipt } from "../../../../../test/helpers/inference-set";

const nativeNimReceipt = nativeLocalTestReceipt(
  "vllm-local",
  "http://host.openshell.internal:8000/v1",
  {
    sandboxName: "my-assistant",
    agent: "openclaw",
    authMode: "sentinel",
  },
);

describe("policy state handler", () => {
  it("verifies a resumed published Pi local route without a native attachment", async () => {
    const { deps, calls } = createPolicyHandlerDeps({
      getActiveSandbox: vi.fn(() => ({
        agent: "pi",
        provider: "ollama-local",
        model: "qwen3:8b",
        endpointUrl: "http://host.openshell.internal:11435/v1",
        createdAt: "2026-09-01T00:00:00Z",
      })),
    });
    await handlePoliciesState({
      ...basePolicyHandlerOptions(deps),
      agent: { name: "pi" },
      resume: true,
      provider: "ollama-local",
      model: "qwen3:8b",
      endpointUrl: "http://host.openshell.internal:11435/v1",
    });
    expect(calls.smoke).toHaveBeenCalledWith(
      expect.not.objectContaining({ nativeLocalProviderAttachment: expect.anything() }),
    );
  });

  it.each([
    ["Pi", "pi", "ollama-local", "http://host.openshell.internal:11435/v1", null],
    [
      "Local NIM",
      "openclaw",
      "vllm-local",
      "http://host.openshell.internal:8000/v1",
      "nemoclaw-nim-owned",
    ],
  ] as const)(
    "requires a native attachment for a fresh %s selection",
    async (_label, agent, provider, endpointUrl, nimContainer) => {
      const { deps, calls } = createPolicyHandlerDeps({
        getActiveSandbox: vi.fn(() => ({ nimContainer })),
      });
      await expect(
        handlePoliciesState({
          ...basePolicyHandlerOptions(deps),
          agent: { name: agent },
          provider,
          model: "qwen3:8b",
          endpointUrl,
        }),
      ).rejects.toThrow("requires its recorded provider attachment");
      expect(calls.smoke).not.toHaveBeenCalled();
      expect(calls.setupPolicies).not.toHaveBeenCalled();
    },
  );

  it("resumes from the live OpenShell preset selection", async () => {
    const prepare = vi.fn(() => ({
      policyPresets: ["npm"],
      livePolicyPresetsNeedUpdate: false,
      disabledMessagingPolicyPresetApplied: false,
      suppressedAgentRequiredPresetsLive: false,
    }));
    const { deps, calls } = createPolicyHandlerDeps({
      arePolicyPresetsApplied: vi.fn(() => true),
      preparePolicyPresetResumeSelection: prepare,
    });
    const result = await handlePoliciesState({
      ...basePolicyHandlerOptions(deps),
      resume: true,
    });
    expect(prepare).toHaveBeenCalledWith(
      "my-assistant",
      expect.not.objectContaining({ recordedPolicyPresets: expect.anything() }),
    );
    expect(calls.skipped).toHaveBeenCalledWith("policies", "npm");
    expect(calls.setupPolicies).not.toHaveBeenCalled();
    expect(result.appliedPolicyPresets).toEqual(["npm"]);
    expect(result.session).not.toHaveProperty("policyPresets");
  });

  it("passes the observed selection to reconciliation on resume", async () => {
    const { deps, calls } = createPolicyHandlerDeps({
      preparePolicyPresetResumeSelection: vi.fn(() => ({
        policyPresets: ["npm", "github"],
        livePolicyPresetsNeedUpdate: true,
        disabledMessagingPolicyPresetApplied: false,
        suppressedAgentRequiredPresetsLive: false,
      })),
    });
    await handlePoliciesState({
      ...basePolicyHandlerOptions(deps),
      resume: true,
    });
    expect(calls.setupPolicies).toHaveBeenCalledWith(
      "my-assistant",
      expect.objectContaining({ selectedPresets: ["npm", "github"] }),
    );
  });

  it("reconciles a pending selection on resume even when live presets are empty", async () => {
    const prepare = vi.fn(() => ({
      policyPresets: ["npm", "openclaw-pricing"],
      livePolicyPresetsNeedUpdate: false,
      disabledMessagingPolicyPresetApplied: false,
      suppressedAgentRequiredPresetsLive: false,
    }));
    const { deps, calls, setSession } = createPolicyHandlerDeps({
      getActiveSandbox: vi.fn(() => ({ createdAt: "2026-10-19T00:00:00Z" })),
      preparePolicyPresetResumeSelection: prepare,
    });
    setSession(
      createSession({
        sandboxName: "my-assistant",
        pendingPolicySelection: {
          sandboxName: "my-assistant",
          sandboxIdentity: "created:2026-10-19T00:00:00Z",
          tierName: "balanced",
          presetNames: ["npm", "openclaw-pricing"],
        },
      }),
    );

    await handlePoliciesState({ ...basePolicyHandlerOptions(deps), resume: true });

    expect(prepare).toHaveBeenCalledWith(
      "my-assistant",
      expect.objectContaining({
        tierName: "balanced",
        pendingPolicyPresets: ["npm", "openclaw-pricing"],
      }),
    );
    expect(calls.setupPolicies).toHaveBeenCalledWith(
      "my-assistant",
      expect.objectContaining({ selectedPresets: ["npm", "openclaw-pricing"] }),
    );
    expect(calls.skipped).not.toHaveBeenCalled();
  });

  it("rejects pending selection for a different sandbox identity before policy mutation", async () => {
    const { deps, calls, setSession } = createPolicyHandlerDeps({
      getActiveSandbox: vi.fn(() => ({ createdAt: "2026-10-19T00:00:00Z" })),
    });
    setSession(
      createSession({
        sandboxName: "my-assistant",
        pendingPolicySelection: {
          sandboxName: "my-assistant",
          sandboxIdentity: "created:2026-10-18T00:00:00Z",
          tierName: null,
          presetNames: ["npm"],
        },
      }),
    );

    await expect(
      handlePoliciesState({ ...basePolicyHandlerOptions(deps), resume: true }),
    ).rejects.toThrow("saved policy selection belongs to a different sandbox identity");
    expect(calls.prepareResume).not.toHaveBeenCalled();
    expect(calls.setupPolicies).not.toHaveBeenCalled();
  });

  it("starts a fresh selection without a shadow preset list", async () => {
    const { deps, calls } = createPolicyHandlerDeps();
    await handlePoliciesState(basePolicyHandlerOptions(deps));
    expect(calls.setupPolicies).toHaveBeenCalledWith(
      "my-assistant",
      expect.objectContaining({ selectedPresets: null }),
    );
    expect(calls.complete).toHaveBeenCalledWith(
      "policies",
      expect.not.objectContaining({ policyPresets: expect.anything() }),
    );
  });

  it("does not reconcile presets after a rebuild consumed OpenShell's live policy", async () => {
    const { deps, calls } = createPolicyHandlerDeps();

    const result = await handlePoliciesState({
      ...basePolicyHandlerOptions(deps),
      preserveRebuildLivePolicy: true,
      provider: "compatible-endpoint",
    });

    expect(calls.smoke).not.toHaveBeenCalled();
    expect(calls.prepareResume).not.toHaveBeenCalled();
    expect(calls.setupPolicies).not.toHaveBeenCalled();
    expect(calls.skipped).toHaveBeenCalledWith("policies", "live OpenShell rebuild policy");
    expect(result.appliedPolicyPresets).toEqual([]);
  });

  it("retains the pre-restore provider-neutral proof for host-local rebuilds", async () => {
    const { deps, calls } = createPolicyHandlerDeps();
    await handlePoliciesState({
      ...basePolicyHandlerOptions(deps),
      preserveRebuildLivePolicy: true,
      hostLocalInferenceRouteOnly: true,
    });
    expect(calls.smoke).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ forceCanonicalRoute: true }),
    );
  });

  it.each(["compatible-anthropic-endpoint", "nvidia-prod"])(
    "retains the earlier rebuild check for provider %s",
    async (provider) => {
      const { deps, calls } = createPolicyHandlerDeps();
      await handlePoliciesState({
        ...basePolicyHandlerOptions(deps),
        preserveRebuildLivePolicy: true,
        provider,
      });
      expect(calls.smoke).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ provider }));
    },
  );

  it("retains compatible endpoint verification during ordinary onboarding", async () => {
    const failure = new Error("compatible endpoint smoke failed");
    const { deps, calls } = createPolicyHandlerDeps({
      verifyCompatibleEndpointSandboxSmoke: vi.fn(() => {
        throw failure;
      }),
    });
    await expect(handlePoliciesState(basePolicyHandlerOptions(deps))).rejects.toBe(failure);
    expect(calls.setupPolicies).not.toHaveBeenCalled();
    expect(calls.complete).not.toHaveBeenCalled();
  });

  it("verifies an owned Local NIM after excluding the shared inference policy", async () => {
    const { deps, calls } = createPolicyHandlerDeps({
      getActiveSandbox: vi.fn(() => ({
        nimContainer: "nemoclaw-nim-owned",
        nativeLocalProviderAttachment: nativeNimReceipt,
      })),
    });

    await handlePoliciesState({
      ...basePolicyHandlerOptions(deps),
      provider: "vllm-local",
      endpointUrl: nativeNimReceipt.endpointUrl,
      agent: { name: "openclaw" },
    });

    expect(calls.smoke).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        provider: "vllm-local",
        agent: { name: "openclaw" },
      }),
    );
    const smokeOptions = calls.smoke.mock.calls[0]?.[0];
    expect(smokeOptions).toHaveProperty("nativeLocalProviderAttachment", nativeNimReceipt);
    expect(smokeOptions).not.toHaveProperty("forceCanonicalRoute");
    expect(smokeOptions).not.toHaveProperty("hostLocalInferenceProofAuthority");
    expect(calls.setupPolicies.mock.invocationCallOrder[0]).toBeLessThan(
      calls.smoke.mock.invocationCallOrder[0]!,
    );
    expect(calls.smoke.mock.invocationCallOrder[0]).toBeLessThan(
      calls.complete.mock.invocationCallOrder[0]!,
    );
    expect(calls.setupPolicies).toHaveBeenCalledWith(
      "my-assistant",
      expect.objectContaining({ provider: null, excludedPresets: ["local-inference"] }),
    );
    expect(calls.complete).toHaveBeenCalledOnce();
  });

  it("does not complete Local NIM policy setup when native route verification fails", async () => {
    const failure = new Error("Local NIM native route smoke failed");
    const { deps, calls } = createPolicyHandlerDeps({
      getActiveSandbox: vi.fn(() => ({
        nimContainer: "nemoclaw-nim-owned",
        nativeLocalProviderAttachment: nativeNimReceipt,
      })),
    });
    calls.smoke.mockImplementation(() => {
      throw failure;
    });

    await expect(
      handlePoliciesState({
        ...basePolicyHandlerOptions(deps),
        provider: "vllm-local",
        endpointUrl: nativeNimReceipt.endpointUrl,
        agent: { name: "openclaw" },
      }),
    ).rejects.toBe(failure);

    expect(calls.smoke).toHaveBeenCalledOnce();
    expect(calls.setupPolicies).toHaveBeenCalledExactlyOnceWith(
      "my-assistant",
      expect.objectContaining({ provider: null, excludedPresets: ["local-inference"] }),
    );
    expect(calls.complete).not.toHaveBeenCalled();
  });

  it("keeps a channel in policy requirements when every credential binding matches its gateway provider (#10667)", async () => {
    const discordPlan = makeMessagingPlan({
      channels: ["discord"],
      agent: "hermes",
      credentialBindings: [
        {
          channelId: "discord",
          credentialId: "discordBotToken",
          sourceInput: "botToken",
          providerName: "my-assistant-discord-bridge",
          providerEnvKey: "DISCORD_BOT_TOKEN",
          placeholder: "openshell:resolve:env:DISCORD_BOT_TOKEN",
          credentialAvailable: true,
          credentialHash: "discord-token-hash",
        },
      ],
    });
    const providerMatcher = vi.fn(async (name: string, type: string, credentialEnv: string) =>
      name === "my-assistant-discord-bridge" &&
      type === "discord-hermes-static-v1" &&
      credentialEnv === "DISCORD_BOT_TOKEN"
        ? { kind: "exact" as const }
        : { kind: "missing" as const },
    );
    const { deps, calls } = createPolicyHandlerDeps({
      getActiveSandbox: vi.fn(() => ({ messaging: { plan: discordPlan } })),
      inspectGatewayCredential: providerMatcher,
    });
    calls.unconfiguredChannels.mockImplementation((_planChannels, configuredChannels) =>
      configuredChannels.includes("discord") ? [] : ["discord"],
    );

    await handlePoliciesState({
      ...basePolicyHandlerOptions(deps),
      selectedMessagingChannels: [],
      agent: { name: "hermes" },
    });

    expect(calls.unconfiguredChannels).toHaveBeenCalledWith(["discord"], ["discord"], {
      name: "hermes",
    });
    expect(providerMatcher).toHaveBeenCalledExactlyOnceWith(
      "my-assistant-discord-bridge",
      "discord-hermes-static-v1",
      "DISCORD_BOT_TOKEN",
    );
    expect(calls.mergeChannels).toHaveBeenCalledWith([], [], ["discord"], []);
    expect(calls.setupPolicies).toHaveBeenCalledWith(
      "my-assistant",
      expect.objectContaining({
        enabledChannels: ["discord"],
        disabledChannels: [],
      }),
    );
  });

  it.each([
    {
      condition: "both bindings match",
      inspectGatewayCredential: async () => ({ kind: "exact" as const }),
      expectedEnabled: ["slack"],
      expectedDisabled: [] as string[],
    },
    {
      condition: "one binding is missing",
      inspectGatewayCredential: async (_name: string, _type: string, credentialEnv: string) =>
        credentialEnv === "SLACK_BOT_TOKEN"
          ? { kind: "exact" as const }
          : { kind: "missing" as const },
      expectedEnabled: [] as string[],
      expectedDisabled: ["slack"],
    },
  ])(
    "requires every Slack binding before retaining its policy when $condition (#10667)",
    async ({ inspectGatewayCredential, expectedEnabled, expectedDisabled }) => {
      const slackPlan = makeMessagingPlan({
        channels: ["slack"],
        agent: "hermes",
        credentialBindings: [
          {
            channelId: "slack",
            credentialId: "slackBotToken",
            sourceInput: "botToken",
            providerName: "my-assistant-slack-bridge",
            providerEnvKey: "SLACK_BOT_TOKEN",
            placeholder: "openshell:resolve:env:SLACK_BOT_TOKEN",
            credentialAvailable: true,
          },
          {
            channelId: "slack",
            credentialId: "slackAppToken",
            sourceInput: "appToken",
            providerName: "my-assistant-slack-app",
            providerEnvKey: "SLACK_APP_TOKEN",
            placeholder: "openshell:resolve:env:SLACK_APP_TOKEN",
            credentialAvailable: true,
          },
        ],
      });
      const providerMatcher = vi.fn(inspectGatewayCredential);
      const { deps, calls } = createPolicyHandlerDeps({
        getActiveSandbox: vi.fn(() => ({ messaging: { plan: slackPlan } })),
        inspectGatewayCredential: providerMatcher,
      });
      calls.unconfiguredChannels.mockImplementation((_planChannels, configuredChannels) =>
        configuredChannels.includes("slack") ? [] : ["slack"],
      );

      await handlePoliciesState({
        ...basePolicyHandlerOptions(deps),
        selectedMessagingChannels: [],
        agent: { name: "hermes" },
      });

      expect(providerMatcher).toHaveBeenCalledTimes(2);
      expect(calls.setupPolicies).toHaveBeenCalledWith(
        "my-assistant",
        expect.objectContaining({
          enabledChannels: expectedEnabled,
          disabledChannels: expectedDisabled,
        }),
      );
    },
  );

  it.each([
    ["openclaw", "google-chat-bridge"],
    ["hermes", "google-chat-hermes-bridge"],
  ] as const)(
    "keeps Google Chat in %s policy requirements when its gateway-minted bridge provider matches",
    async (agent, providerType) => {
      const googlechatPlan = makeMessagingPlan({
        channels: ["googlechat"],
        agent,
      });
      const providerMatcher = vi.fn(async (name: string, type: string, credentialEnv: string) =>
        name === "my-assistant-googlechat-bridge" &&
        type === providerType &&
        credentialEnv === "GOOGLE_CHAT_ACCESS_TOKEN"
          ? { kind: "exact" as const }
          : { kind: "missing" as const },
      );
      const { deps, calls } = createPolicyHandlerDeps({
        getActiveSandbox: vi.fn(() => ({
          messaging: { plan: googlechatPlan },
        })),
        inspectGatewayCredential: providerMatcher,
      });
      calls.unconfiguredChannels.mockImplementation((_planChannels, configuredChannels) =>
        configuredChannels.includes("googlechat") ? [] : ["googlechat"],
      );

      await handlePoliciesState({
        ...basePolicyHandlerOptions(deps),
        selectedMessagingChannels: [],
        agent: { name: agent },
      });

      expect(providerMatcher).toHaveBeenCalledExactlyOnceWith(
        "my-assistant-googlechat-bridge",
        providerType,
        "GOOGLE_CHAT_ACCESS_TOKEN",
      );
      expect(calls.setupPolicies).toHaveBeenCalledWith(
        "my-assistant",
        expect.objectContaining({
          enabledChannels: ["googlechat"],
          disabledChannels: [],
        }),
      );
    },
  );

  it("stops before policy reconciliation when gateway credential inspection fails", async () => {
    const plan = makeMessagingPlan({
      channels: ["googlechat"],
      agent: "hermes",
    });
    const { deps, calls } = createPolicyHandlerDeps({
      getActiveSandbox: vi.fn(() => ({ messaging: { plan } })),
      inspectGatewayCredential: vi.fn().mockResolvedValue({ kind: "indeterminate" }),
    });

    await expect(
      handlePoliciesState({
        ...basePolicyHandlerOptions(deps),
        selectedMessagingChannels: [],
        agent: { name: "hermes" },
      }),
    ).rejects.toThrow("Could not inspect gateway credentials for messaging channel 'googlechat'");

    expect(calls.unconfiguredChannels).not.toHaveBeenCalled();
    expect(calls.setupPolicies).not.toHaveBeenCalled();
    expect(calls.complete).not.toHaveBeenCalled();
  });

  it("merges live messaging channels into policy requirements", async () => {
    const { deps, calls } = createPolicyHandlerDeps();
    await handlePoliciesState({
      ...basePolicyHandlerOptions(deps),
      selectedMessagingChannels: [],
    });
    expect(calls.mergeChannels).toHaveBeenCalled();
    expect(calls.setupPolicies).toHaveBeenCalledWith(
      "my-assistant",
      expect.objectContaining({ enabledChannels: ["telegram"] }),
    );
  });
});
