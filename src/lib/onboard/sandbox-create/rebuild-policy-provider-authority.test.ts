// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type {
  MessagingChannelId,
  SandboxMessagingChannelPlan,
  SandboxMessagingCredentialBindingPlan,
  SandboxMessagingPlan,
} from "../../messaging/manifest";
import {
  bindRebuildPolicyProvidersToCreateArgs,
  resolveRebuildMessagingPolicyDeltas,
  resolveRebuildObservabilityPolicyDelta,
  resolveRebuildPolicyProviderAuthority,
} from "./orchestration";

function channelPlan(
  channelId: MessagingChannelId,
  active: boolean,
  disabled = false,
): SandboxMessagingChannelPlan {
  return {
    channelId,
    displayName: channelId,
    authMode: "token-paste",
    active,
    selected: true,
    configured: true,
    disabled,
    inputs: [],
    hooks: [],
  };
}

function credentialBinding(
  channelId: MessagingChannelId,
  providerName: string,
): SandboxMessagingCredentialBindingPlan {
  return {
    channelId,
    credentialId: "bot-token",
    sourceInput: "token",
    providerName,
    providerEnvKey: `${channelId.toUpperCase()}_BOT_TOKEN`,
    placeholder: `\${${channelId.toUpperCase()}_BOT_TOKEN}`,
    credentialAvailable: true,
  };
}

describe("rebuild policy provider handoff", () => {
  const preservedMcpState = {
    bridges: {
      github: {
        server: "github",
        agent: "openclaw",
        url: "https://mcp.example.com/",
        env: ["MCP_TOKEN"],
        providerName: "alpha-mcp-github",
        providerId: "provider-id",
        policyName: "mcp_github",
        addedAt: "2026-08-30T00:00:00.000Z",
      },
    },
  };

  it("derives active additions and disabled removals from current channel manifests", () => {
    expect(
      resolveRebuildMessagingPolicyDeltas({
        agent: "hermes",
        channels: [
          channelPlan("telegram", false, true),
          channelPlan("googlechat", false, true),
          channelPlan("wechat", true),
        ],
        disabledChannels: ["telegram", "googlechat"],
        networkPolicy: {
          presets: ["wechat"],
          entries: [
            {
              channelId: "telegram",
              presetName: "telegram",
              policyKeys: ["telegram"],
              source: "agent-alias",
            },
            {
              channelId: "wechat",
              presetName: "wechat",
              policyKeys: ["wechat_bridge"],
              source: "manifest",
            },
          ],
        },
      }),
    ).toEqual({
      requiredNetworkPolicyKeys: ["wechat_bridge"],
      requiredNetworkPolicyPresetNames: ["wechat"],
      removedNetworkPolicyKeys: ["telegram", "googlechat_hermes"],
    });
  });

  it.each([
    ["langchain-deepagents-code", true, true, "balanced", ["observability-otlp-local"], []],
    ["langchain-deepagents-code", false, true, "balanced", [], ["observability-otlp-local"]],
    ["langchain-deepagents-code", true, true, "restricted", [], ["observability-otlp-local"]],
    ["langchain-deepagents-code", true, false, null, [], []],
    ["openclaw", true, true, "balanced", [], []],
  ] as const)(
    "derives the rebuild observability delta for %s enabled=%s explicit=%s tier=%s",
    (
      agent,
      enabled,
      explicitlyRequested,
      tierName,
      requiredNetworkPolicyKeys,
      removedNetworkPolicyKeys,
    ) => {
      expect(
        resolveRebuildObservabilityPolicyDelta({
          agent,
          enabled,
          explicitlyRequested,
          tierName,
        }),
      ).toEqual({ requiredNetworkPolicyKeys, removedNetworkPolicyKeys });
    },
  );

  it("adds missing live-policy providers to the final create arguments", () => {
    expect(
      bindRebuildPolicyProvidersToCreateArgs(
        ["--from", "image", "--provider", "operator-provider"],
        {
          credentialBindingProviders: ["operator-provider", "wechat-provider"],
        },
      ),
    ).toEqual([
      "--from",
      "image",
      "--provider",
      "operator-provider",
      "--provider",
      "wechat-provider",
    ]);
  });

  it("inserts rebuild providers before the sandbox startup command separator", () => {
    expect(
      bindRebuildPolicyProvidersToCreateArgs(
        [
          "openshell",
          "sandbox",
          "create",
          "--provider",
          "inference-provider",
          "--",
          "env",
          "nemoclaw-start",
        ],
        {
          credentialBindingProviders: ["inference-provider", "mcp-provider"],
        },
      ),
    ).toEqual([
      "openshell",
      "sandbox",
      "create",
      "--provider",
      "inference-provider",
      "--provider",
      "mcp-provider",
      "--",
      "env",
      "nemoclaw-start",
    ]);
  });

  it("authorizes enabled messaging and managed MCP providers but rejects disabled channels", () => {
    expect(
      resolveRebuildPolicyProviderAuthority({
        createArgs: ["--from", "image", "--provider", "inference-provider"],
        messagingPlan: {
          channels: [channelPlan("telegram", true), channelPlan("discord", false, true)],
          disabledChannels: ["discord"],
          credentialBindings: [
            credentialBinding("telegram", "alpha-telegram-bridge"),
            credentialBinding("discord", "alpha-discord-bridge"),
          ],
        },
        preservedMcpState,
        managedMcpRebuildHandoff: true,
      }),
    ).toEqual(["inference-provider", "alpha-telegram-bridge", "alpha-mcp-github"]);
  });

  it.each(["openclaw", "hermes"] as const)(
    "excludes inactive %s channel policy and provider effects during rebuild",
    (agent) => {
      const plan = {
        agent,
        channels: [channelPlan("slack", true), channelPlan("discord", false)],
        disabledChannels: [],
        credentialBindings: [
          credentialBinding("slack", "alpha-slack-bridge"),
          credentialBinding("discord", "alpha-discord-bridge"),
        ],
        networkPolicy: {
          presets: ["slack", "discord"],
          entries: [
            {
              channelId: "slack",
              presetName: "slack",
              policyKeys: ["slack"],
              source: "manifest",
            },
            {
              channelId: "discord",
              presetName: "discord",
              policyKeys: ["discord"],
              source: "manifest",
            },
          ],
        },
      } satisfies Pick<
        SandboxMessagingPlan,
        "agent" | "channels" | "credentialBindings" | "disabledChannels" | "networkPolicy"
      >;

      expect(resolveRebuildMessagingPolicyDeltas(plan)).toEqual({
        requiredNetworkPolicyKeys: ["slack"],
        requiredNetworkPolicyPresetNames: ["slack"],
        removedNetworkPolicyKeys: ["discord"],
      });
      expect(
        resolveRebuildPolicyProviderAuthority({
          createArgs: [],
          messagingPlan: plan,
          preservedMcpState: undefined,
          managedMcpRebuildHandoff: false,
        }),
      ).toEqual(["alpha-slack-bridge"]);
    },
  );

  it("does not infer messaging policy authority when the rebuild has no messaging plan", () => {
    expect(resolveRebuildMessagingPolicyDeltas(null)).toEqual({
      requiredNetworkPolicyKeys: [],
      requiredNetworkPolicyPresetNames: [],
      removedNetworkPolicyKeys: [],
    });
  });

  it("does not authorize MCP registry names without the managed rebuild handoff", () => {
    expect(
      resolveRebuildPolicyProviderAuthority({
        createArgs: [],
        messagingPlan: null,
        preservedMcpState,
        managedMcpRebuildHandoff: false,
      }),
    ).toEqual([]);
  });

  it("ignores incomplete MCP add records even with a managed rebuild handoff", () => {
    expect(
      resolveRebuildPolicyProviderAuthority({
        createArgs: [],
        messagingPlan: null,
        preservedMcpState: {
          bridges: {
            github: {
              ...preservedMcpState.bridges.github,
              addState: "prepared",
            },
          },
        },
        managedMcpRebuildHandoff: true,
      }),
    ).toEqual([]);
  });
});
