// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { MessagingBridgeProfile } from "../../onboard/messaging-bridge-provider";
import { buildMessagingProviderApplication } from "./provider-application";

const googlechatProfile: MessagingBridgeProfile = {
  channelId: "googlechat",
  agent: "openclaw",
  profilePath: "/repo/googlechat/openclaw.yaml",
  profileId: "google-chat-bridge",
  credentialKey: "GOOGLE_CHAT_ACCESS_TOKEN",
  strategy: "google-service-account-jwt",
  scopes: ["https://www.googleapis.com/auth/chat.bot"],
  secretMaterialKeys: ["private_key"],
  sourceSecretEnv: "GOOGLECHAT_SERVICE_ACCOUNT",
};

describe("messaging provider application planning", () => {
  it("separates gateway refresh secrets from command-safe material (#9806)", () => {
    const privateKey = "test-private-key-material";
    const serviceAccount = JSON.stringify({
      client_email: "bot@example.test",
      private_key: privateKey,
    });

    const result = buildMessagingProviderApplication({
      tokenDefs: [
        {
          name: "alpha-googlechat-bridge",
          envKey: "GOOGLE_CHAT_ACCESS_TOKEN",
          token: "openshell-managed-pending-mint",
          providerType: "google-chat-bridge",
        },
      ],
      root: "/repo",
      agent: "openclaw",
      getCredential: (envKey) => (envKey === "GOOGLECHAT_SERVICE_ACCOUNT" ? serviceAccount : null),
      profiles: [googlechatProfile],
    });

    expect(result.definitions).toEqual([
      {
        channelId: "googlechat",
        credentialId: "GOOGLE_CHAT_ACCESS_TOKEN",
        providerName: "alpha-googlechat-bridge",
        providerType: "google-chat-bridge",
        credentials: [
          { name: "GOOGLE_CHAT_ACCESS_TOKEN", value: "openshell-managed-pending-mint" },
        ],
        profile: {
          profilePath: "/repo/googlechat/openclaw.yaml",
          profileType: "google-chat-bridge",
        },
      },
    ]);
    expect(result.refreshes).toEqual([
      {
        channelId: "googlechat",
        providerName: "alpha-googlechat-bridge",
        credentialKey: "GOOGLE_CHAT_ACCESS_TOKEN",
        strategy: "google-service-account-jwt",
        material: [
          { key: "client_email", value: "bot@example.test" },
          { key: "scope", value: "https://www.googleapis.com/auth/chat.bot" },
        ],
        secretMaterial: [{ key: "private_key", value: privateKey }],
      },
    ]);
  });

  it("routes a checked-in web-search profile through the typed application (#9806)", () => {
    const result = buildMessagingProviderApplication({
      tokenDefs: [
        {
          name: "alpha-brave-search",
          envKey: "BRAVE_API_KEY",
          token: "brave-secret",
          providerType: "brave",
        },
      ],
      root: "/repo",
      agent: "openclaw",
      getCredential: () => null,
      profiles: [googlechatProfile],
    });

    expect(result.definitions).toEqual([
      {
        channelId: "messaging",
        credentialId: "BRAVE_API_KEY",
        providerName: "alpha-brave-search",
        providerType: "brave",
        credentials: [{ name: "BRAVE_API_KEY", value: "brave-secret" }],
        profile: {
          profilePath: "/repo/nemoclaw-blueprint/provider-profiles/brave.yaml",
          profileType: "brave",
        },
      },
    ]);
    expect(result.refreshes).toEqual([]);
  });

  it("routes an OpenShell built-in type without importing a custom profile (#9806)", () => {
    const result = buildMessagingProviderApplication({
      tokenDefs: [
        {
          name: "legacy-openai",
          envKey: "OPENAI_API_KEY",
          token: "openai-secret",
        },
      ],
      root: "/repo",
      agent: "openclaw",
      getCredential: () => null,
      profiles: [googlechatProfile],
    });

    expect(result.definitions).toEqual([
      {
        channelId: "messaging",
        credentialId: "OPENAI_API_KEY",
        providerName: "legacy-openai",
        providerType: "generic",
        credentials: [{ name: "OPENAI_API_KEY", value: "openai-secret" }],
      },
    ]);
  });
});
