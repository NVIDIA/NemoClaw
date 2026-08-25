// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";

import { loadMessagingChannelPolicyPreset } from "../../../src/lib/messaging/channels";
import { prepareCreateSandboxMessaging } from "../../../src/lib/onboard/messaging-prep";
import { listMessagingBridgeProfiles } from "../../../src/lib/onboard/messaging-bridge-provider";
import { listChannels } from "../../../src/lib/sandbox/channels";

const SANDBOX_NAME = "hermes-discord";
const PROVIDER_NAME = `${SANDBOX_NAME}-discord-bridge`;
const PROVIDER_TYPE = "discord-hermes-static-v1";

function prepareDiscord(
  token: string | null,
  providerMatchesGatewayCredential: () => boolean = () => false,
  disabled = false,
) {
  const discord = listChannels().filter((channel) => channel.name === "discord");
  return prepareCreateSandboxMessaging({
    sandboxName: SANDBOX_NAME,
    agentName: "hermes",
    channels: discord,
    enabledChannels: disabled ? [] : ["discord"],
    disabledChannels: disabled ? ["discord"] : [],
    webSearchConfig: null,
    env: token ? { DISCORD_BOT_TOKEN: token } : {},
    getValidatedMessagingTokenByEnvKey: (_channels, envKey) =>
      envKey === "DISCORD_BOT_TOKEN" ? token : null,
    getCredential: () => null,
    normalizeCredentialValue: (value) => (typeof value === "string" ? value : ""),
    registerExtraPlaceholderProviders: () => [],
    getMessagingChannelForEnvKey: () => "discord",
    providerExistsInGateway: () => true,
    providerMatchesGatewayCredential,
  });
}

describe("Hermes Discord credential endpoint binding", () => {
  it("creates the Discord provider from an endpointless profile", () => {
    const result = prepareDiscord("test-discord-token");

    expect(result.messagingTokenDefs).toEqual([
      {
        name: PROVIDER_NAME,
        envKey: "DISCORD_BOT_TOKEN",
        token: "test-discord-token",
        providerType: PROVIDER_TYPE,
      },
    ]);
    expect(result.missingBridgeChannels).toEqual([]);
    const profile = listMessagingBridgeProfiles().find(
      (candidate) => candidate.channelId === "discord" && candidate.agent === "hermes",
    );
    expect(profile).toMatchObject({
      profileId: PROVIDER_TYPE,
      credentialKey: "DISCORD_BOT_TOKEN",
    });
    const profileYaml = YAML.parse(fs.readFileSync(profile!.profilePath, "utf8")) as {
      endpoints?: unknown[];
    };
    expect(profileYaml.endpoints).toEqual([]);
  });

  it.each([
    { state: "active", disabled: false },
    { state: "stopped", disabled: true },
  ])("does not reuse an untyped provider for a $state channel", ({ disabled }) => {
    const providerMatches = vi.fn(() => false);
    const result = prepareDiscord(null, providerMatches, disabled);

    expect(result.reusableMessagingProviders).toEqual([]);
    expect(result.reusableMessagingChannels).toEqual([]);
    expect(providerMatches).toHaveBeenCalledWith(PROVIDER_NAME, PROVIDER_TYPE, "DISCORD_BOT_TOKEN");
  });

  it.each([null, "test-discord-token"])(
    "retains the exact Discord provider for a stopped channel with source token %s (#9773)",
    (token) => {
      const providerMatches = vi.fn(() => true);
      const result = prepareDiscord(token, providerMatches, true);

      expect(result.messagingTokenDefs).toEqual([]);
      expect(result.reusableMessagingProviders).toEqual([PROVIDER_NAME]);
      expect(result.reusableMessagingChannels).toEqual([]);
      expect(providerMatches).toHaveBeenCalledWith(
        PROVIDER_NAME,
        PROVIDER_TYPE,
        "DISCORD_BOT_TOKEN",
      );
    },
  );

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

  it("rejects an unsafe sandbox name before materializing a provider binding", () => {
    expect(
      loadMessagingChannelPolicyPreset("discord", {
        agent: "hermes",
        sandboxName: "bad:provider",
      } as { agent: "hermes" }),
    ).toBeNull();
  });
});
