// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { loadMessagingChannelPolicyPreset } from "../src/lib/messaging/channels";
import { prepareCreateSandboxMessaging } from "../src/lib/onboard/messaging-prep";
import { listMessagingBridgeProfiles } from "../src/lib/onboard/messaging-bridge-provider";
import { listChannels } from "../src/lib/sandbox/channels";

const SANDBOX_NAME = "hermes-discord-binding";
const PROVIDER_NAME = `${SANDBOX_NAME}-discord-bridge`;
const PROVIDER_TYPE = "discord-hermes-static-v1";

describe("Hermes Discord credential endpoint binding", () => {
  it("creates the Discord provider from an endpointless profile", () => {
    const discord = listChannels().filter((channel) => channel.name === "discord");
    const result = prepareCreateSandboxMessaging({
      sandboxName: SANDBOX_NAME,
      agentName: "hermes",
      channels: discord,
      enabledChannels: ["discord"],
      disabledChannels: [],
      webSearchConfig: null,
      env: { DISCORD_BOT_TOKEN: "test-discord-token" },
      getValidatedMessagingTokenByEnvKey: (_channels, envKey) =>
        envKey === "DISCORD_BOT_TOKEN" ? "test-discord-token" : null,
      getCredential: () => null,
      normalizeCredentialValue: (value) => (typeof value === "string" ? value : ""),
      registerExtraPlaceholderProviders: () => [],
      getMessagingChannelForEnvKey: () => "discord",
      providerExistsInGateway: () => false,
      providerMatchesGatewayCredential: () => false,
    });

    expect(result.messagingTokenDefs).toEqual([
      {
        name: PROVIDER_NAME,
        envKey: "DISCORD_BOT_TOKEN",
        token: "test-discord-token",
        providerType: PROVIDER_TYPE,
      },
    ]);
    expect(
      listMessagingBridgeProfiles().find(
        (profile) => profile.channelId === "discord" && profile.agent === "hermes",
      ),
    ).toMatchObject({
      profileId: PROVIDER_TYPE,
      credentialKey: "DISCORD_BOT_TOKEN",
    });
  });

  it("binds Discord REST and WebSocket rewrites to the sandbox provider", () => {
    const content = loadMessagingChannelPolicyPreset("discord", {
      agent: "hermes",
      sandboxName: SANDBOX_NAME,
    } as { agent: "hermes" });
    expect(content).not.toBeNull();

    const policy = YAML.parse(content!) as {
      network_policies: {
        discord: {
          endpoints: Array<{
            host: string;
            credential_binding?: { provider?: string };
          }>;
        };
      };
    };
    const endpoints = policy.network_policies.discord.endpoints;
    const credentialEndpoints = endpoints.filter((endpoint) =>
      ["discord.com", "gateway.discord.gg", "*.discord.gg"].includes(endpoint.host),
    );

    expect(credentialEndpoints).toHaveLength(3);
    expect(credentialEndpoints.map((endpoint) => endpoint.credential_binding?.provider)).toEqual([
      PROVIDER_NAME,
      PROVIDER_NAME,
      PROVIDER_NAME,
    ]);
    expect(
      endpoints.find((endpoint) => endpoint.host === "cdn.discordapp.com")?.credential_binding,
    ).toBeUndefined();
  });
});
