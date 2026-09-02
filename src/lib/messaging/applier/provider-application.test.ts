// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { MESSAGING_BRIDGE_PENDING_VALUE } from "../../onboard/messaging-bridge-provider";
import { buildMessagingProviderApplication } from "./provider-application";

const STATIC_PROFILE = `
id: discord-hermes
credentials:
  - name: bot_token
    env_vars: [DISCORD_BOT_TOKEN]
    required: true
    auth_style: bearer
    header_name: Authorization
    query_param: ''
endpoints: []
binaries: [/usr/local/bin/hermes]
inference_capable: false
`;

const GOOGLE_CHAT_PROFILE = `
id: google-chat-bridge
credentials:
  - name: access_token
    env_vars: [GOOGLE_CHAT_ACCESS_TOKEN]
    required: true
    auth_style: bearer
    header_name: Authorization
    query_param: ''
    refresh:
      strategy: google-service-account-jwt
      scopes: [https://www.googleapis.com/auth/chat.bot]
      material:
        - name: client_email
          required: true
        - name: private_key
          required: true
          secret: true
        - name: scope
endpoints:
  - host: chat.googleapis.com
    port: 443
    protocol: rest
    access: read-write
    enforcement: enforce
binaries: [/usr/local/bin/node]
inference_capable: false
`;

describe("messaging provider application planning", () => {
  it("separates typed messaging definitions from unrelated providers (#9806)", () => {
    const plan = buildMessagingProviderApplication({
      tokenDefs: [
        {
          name: "demo-telegram-bridge",
          envKey: "TELEGRAM_BOT_TOKEN",
          token: "telegram-token",
          providerType: "nemoclaw-mcp-v1",
        },
        {
          name: "demo-tavily-search",
          envKey: "TAVILY_API_KEY",
          token: "search-token",
          providerType: "tavily",
        },
      ],
      root: "/repo",
      agent: "openclaw",
      getCredential: () => null,
      profiles: [],
    });

    expect(plan.definitions).toEqual([
      expect.objectContaining({
        providerName: "demo-telegram-bridge",
        providerType: "nemoclaw-mcp-v1",
        credentials: [{ name: "TELEGRAM_BOT_TOKEN", value: "telegram-token" }],
        profile: expect.objectContaining({ kind: "endpointless" }),
      }),
    ]);
    expect(plan.otherTokenDefs).toEqual([expect.objectContaining({ name: "demo-tavily-search" })]);
  });

  it("binds a static messaging provider to its checked-in profile digest (#9806)", () => {
    const profilePath = "/repo/discord-hermes.yaml";
    const plan = buildMessagingProviderApplication({
      tokenDefs: [
        {
          name: "demo-discord-bridge",
          envKey: "DISCORD_BOT_TOKEN",
          token: "discord-token",
          providerType: "discord-hermes",
        },
      ],
      root: "/repo",
      agent: "hermes",
      getCredential: () => null,
      profiles: [
        {
          channelId: "discord",
          agent: "hermes",
          profilePath,
          profileId: "discord-hermes",
          credentialKey: "DISCORD_BOT_TOKEN",
          strategy: null,
          scopes: [],
          secretMaterialKeys: [],
          sourceSecretEnv: "DISCORD_BOT_TOKEN",
        },
      ],
      readFileSync: (file) => {
        expect(file).toBe(profilePath);
        return STATIC_PROFILE;
      },
    });

    expect(plan.definitions[0]).toMatchObject({
      channelId: "discord",
      providerType: "discord-hermes",
      profile: {
        kind: "checked-in",
        profilePath,
        profileType: "discord-hermes",
        contractDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
    expect(plan.refreshes).toEqual([]);
  });

  it("keeps Google Chat private key material in the typed secret field (#9806)", () => {
    const privateKey = "host-only-private-key";
    const sourceSecret = JSON.stringify({
      client_email: "bot@example.com",
      private_key: privateKey,
    });
    const plan = buildMessagingProviderApplication({
      tokenDefs: [
        {
          name: "demo-google-chat-bridge",
          envKey: "GOOGLE_CHAT_ACCESS_TOKEN",
          token: MESSAGING_BRIDGE_PENDING_VALUE,
          providerType: "google-chat-bridge",
        },
      ],
      root: "/repo",
      agent: "openclaw",
      getCredential: (envKey) => (envKey === "GOOGLECHAT_SERVICE_ACCOUNT" ? sourceSecret : null),
      profiles: [
        {
          channelId: "googlechat",
          agent: "openclaw",
          profilePath: "/repo/google-chat.yaml",
          profileId: "google-chat-bridge",
          credentialKey: "GOOGLE_CHAT_ACCESS_TOKEN",
          strategy: "google-service-account-jwt",
          scopes: ["https://www.googleapis.com/auth/chat.bot"],
          secretMaterialKeys: ["private_key"],
          sourceSecretEnv: "GOOGLECHAT_SERVICE_ACCOUNT",
        },
      ],
      readFileSync: () => GOOGLE_CHAT_PROFILE,
    });

    expect(plan.definitions[0]).toMatchObject({
      providerName: "demo-google-chat-bridge",
      credentials: [
        {
          name: "GOOGLE_CHAT_ACCESS_TOKEN",
          value: MESSAGING_BRIDGE_PENDING_VALUE,
        },
      ],
    });
    expect(plan.refreshes).toEqual([
      expect.objectContaining({
        providerName: "demo-google-chat-bridge",
        credentialKey: "GOOGLE_CHAT_ACCESS_TOKEN",
        material: [
          { key: "client_email", value: "bot@example.com" },
          {
            key: "scope",
            value: "https://www.googleapis.com/auth/chat.bot",
          },
        ],
        secretMaterial: [{ key: "private_key", value: privateKey }],
      }),
    ]);
    expect(JSON.stringify(plan.refreshes[0]?.material)).not.toContain(privateKey);
  });

  it("fails closed when refresh secret material is unavailable (#9806)", () => {
    expect(() =>
      buildMessagingProviderApplication({
        tokenDefs: [
          {
            name: "demo-google-chat-bridge",
            envKey: "GOOGLE_CHAT_ACCESS_TOKEN",
            token: MESSAGING_BRIDGE_PENDING_VALUE,
            providerType: "google-chat-bridge",
          },
        ],
        root: "/repo",
        agent: "openclaw",
        getCredential: () => null,
        profiles: [
          {
            channelId: "googlechat",
            agent: "openclaw",
            profilePath: "/repo/google-chat.yaml",
            profileId: "google-chat-bridge",
            credentialKey: "GOOGLE_CHAT_ACCESS_TOKEN",
            strategy: "google-service-account-jwt",
            scopes: [],
            secretMaterialKeys: ["private_key"],
            sourceSecretEnv: "GOOGLECHAT_SERVICE_ACCOUNT",
          },
        ],
        readFileSync: () => GOOGLE_CHAT_PROFILE,
      }),
    ).toThrow("bridge secret material is unavailable");
  });
});
