// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { makeMessagingPlan } from "../../../../../test/helpers/messaging-plan-fixtures";
import { createPolicyHandlerDeps, basePolicyHandlerOptions } from "./policies-test-fixture";
import { handlePoliciesState } from "./policies";

describe("policy state handler", () => {
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
    await handlePoliciesState({ ...basePolicyHandlerOptions(deps), resume: true });
    expect(calls.setupPolicies).toHaveBeenCalledWith(
      "my-assistant",
      expect.objectContaining({ selectedPresets: ["npm", "github"] }),
    );
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
    });

    expect(calls.smoke).toHaveBeenCalledOnce();
    expect(calls.prepareResume).not.toHaveBeenCalled();
    expect(calls.setupPolicies).not.toHaveBeenCalled();
    expect(calls.skipped).toHaveBeenCalledWith("policies", "live OpenShell rebuild policy");
    expect(result.appliedPolicyPresets).toEqual([]);
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
    const { deps, calls } = createPolicyHandlerDeps({
      getActiveSandbox: vi.fn(() => ({ messaging: { plan: discordPlan } })),
      providerMatchesGatewayCredential: vi.fn(() => true),
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
    expect(calls.mergeChannels).toHaveBeenCalledWith([], [], ["discord"], []);
    expect(calls.setupPolicies).toHaveBeenCalledWith(
      "my-assistant",
      expect.objectContaining({ enabledChannels: ["discord"], disabledChannels: [] }),
    );
  });

  it.each([
    {
      condition: "both bindings match",
      providerMatchesGatewayCredential: () => true,
      expectedEnabled: ["slack"],
      expectedDisabled: [] as string[],
    },
    {
      condition: "one binding is missing",
      providerMatchesGatewayCredential: (_name: string, _type: string, credentialEnv: string) =>
        credentialEnv === "SLACK_BOT_TOKEN",
      expectedEnabled: [] as string[],
      expectedDisabled: ["slack"],
    },
  ])(
    "requires every Slack binding before retaining its policy when $condition (#10667)",
    async ({ providerMatchesGatewayCredential, expectedEnabled, expectedDisabled }) => {
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
      const providerMatcher = vi.fn(providerMatchesGatewayCredential);
      const { deps, calls } = createPolicyHandlerDeps({
        getActiveSandbox: vi.fn(() => ({ messaging: { plan: slackPlan } })),
        providerMatchesGatewayCredential: providerMatcher,
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
      const googlechatPlan = makeMessagingPlan({ channels: ["googlechat"], agent });
      const providerMatcher = vi.fn(
        (name: string, type: string, credentialEnv: string) =>
          name === "my-assistant-googlechat-bridge" &&
          type === providerType &&
          credentialEnv === "GOOGLE_CHAT_ACCESS_TOKEN",
      );
      const { deps, calls } = createPolicyHandlerDeps({
        getActiveSandbox: vi.fn(() => ({ messaging: { plan: googlechatPlan } })),
        providerMatchesGatewayCredential: providerMatcher,
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
        expect.objectContaining({ enabledChannels: ["googlechat"], disabledChannels: [] }),
      );
    },
  );

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
