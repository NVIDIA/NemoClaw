// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { BRAVE_API_KEY_ENV, TAVILY_API_KEY_ENV } from "../inference/web-search";
import { listChannels } from "../sandbox/channels";
import {
  type CreateSandboxMessagingPrepInput,
  prepareCreateSandboxMessaging,
} from "./messaging-prep";

function normalizeCredentialValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function createInput(
  overrides: Partial<CreateSandboxMessagingPrepInput> = {},
): CreateSandboxMessagingPrepInput {
  return {
    sandboxName: "demo",
    channels: listChannels(),
    enabledChannels: null,
    disabledChannels: [],
    webSearchConfig: null,
    env: {},
    getValidatedMessagingTokenByEnvKey: () => null,
    getCredential: () => null,
    normalizeCredentialValue,
    registerExtraPlaceholderProviders: vi.fn(() => []),
    getMessagingChannelForEnvKey: (envKey) => {
      if (envKey === "DISCORD_BOT_TOKEN") return "discord";
      if (envKey === "SLACK_BOT_TOKEN") return "slack";
      if (envKey === "SLACK_APP_TOKEN") return "slack";
      if (envKey === "TELEGRAM_BOT_TOKEN") return "telegram";
      if (envKey === "WECHAT_BOT_TOKEN") return "wechat";
      return null;
    },
    providerExistsInGateway: () => false,
    providerMatchesGatewayCredential: () => false,
    ...overrides,
  };
}

describe("prepareCreateSandboxMessaging", () => {
  it("does not read messaging credentials when no channel is enabled (#9833)", () => {
    const getValidatedMessagingTokenByEnvKey = vi.fn(() => "secret-value");

    const result = prepareCreateSandboxMessaging(
      createInput({
        enabledChannels: [],
        getValidatedMessagingTokenByEnvKey,
      }),
    );

    expect(getValidatedMessagingTokenByEnvKey).not.toHaveBeenCalled();
    expect(result.messagingTokenDefs).toEqual([]);
  });

  it("filters token definitions and reuses missing-token providers with matching bindings", () => {
    const registerExtraPlaceholderProviders = vi.fn(() => ["SLACK_BOT_TOKEN_AGENT_A"]);
    const providerMatchesGatewayCredential = vi.fn(
      (name: string, type: string, credentialKey: string) =>
        name === "demo-slack-bridge" &&
        type === "nemoclaw-mcp-v1" &&
        credentialKey === "SLACK_BOT_TOKEN",
    );

    const result = prepareCreateSandboxMessaging(
      createInput({
        enabledChannels: ["slack", "telegram"],
        disabledChannels: ["telegram"],
        getValidatedMessagingTokenByEnvKey: (_channels, envKey) =>
          envKey === "SLACK_APP_TOKEN" ? "xapp-valid" : null,
        registerExtraPlaceholderProviders,
        providerMatchesGatewayCredential,
      }),
    );

    expect(result.messagingTokenDefs).toMatchObject([
      { name: "demo-slack-bridge", envKey: "SLACK_BOT_TOKEN", token: null },
      { name: "demo-slack-app", envKey: "SLACK_APP_TOKEN", token: "xapp-valid" },
    ]);
    expect([...result.disabledChannelNames]).toEqual(["telegram"]);
    expect(result.extraPlaceholderKeys).toEqual(["SLACK_BOT_TOKEN_AGENT_A"]);
    expect(result.hasMessagingTokens).toBe(true);
    expect(result.reusableMessagingProviders).toEqual(["demo-slack-bridge"]);
    expect(result.reusableMessagingChannels).toEqual(["slack"]);
    expect(providerMatchesGatewayCredential).toHaveBeenCalledWith(
      "demo-slack-bridge",
      "nemoclaw-mcp-v1",
      "SLACK_BOT_TOKEN",
    );
  });

  it("reattaches an exact durable provider when rebuild resumes without channel prompts", () => {
    const providerMatchesGatewayCredential = vi.fn(
      (name: string, type: string, credentialKey: string) =>
        name === "demo-discord-bridge" &&
        type === "nemoclaw-mcp-v1" &&
        credentialKey === "DISCORD_BOT_TOKEN",
    );

    const result = prepareCreateSandboxMessaging(
      createInput({
        enabledChannels: null,
        requireExactProviderBinding: true,
        providerMatchesGatewayCredential,
      }),
    );

    expect(result.reusableMessagingProviders).toContain("demo-discord-bridge");
    expect(result.reusableMessagingChannels).toContain("discord");
    expect(providerMatchesGatewayCredential).toHaveBeenCalledWith(
      "demo-discord-bridge",
      "nemoclaw-mcp-v1",
      "DISCORD_BOT_TOKEN",
    );
  });

  it("reuses an existing gateway bridge provider when the bridge secret is not resolvable", () => {
    // Deferred rebuild in a fresh process: the pasted secret is env-only and
    // gone, so no bridge token def exists — but the gateway still durably
    // holds the refresh material, so the provider only needs re-attaching.
    // The gateway holds the OpenClaw binding, which is the agent being onboarded.
    const providerMatchesGatewayCredential = vi.fn(
      (name: string, type: string, credentialKey: string) =>
        name === "demo-googlechat-bridge" &&
        type === "google-chat-bridge" &&
        credentialKey === "GOOGLE_CHAT_ACCESS_TOKEN",
    );

    const result = prepareCreateSandboxMessaging(
      createInput({
        enabledChannels: ["googlechat"],
        providerMatchesGatewayCredential,
      }),
    );

    expect(result.messagingTokenDefs.some((def) => def.name === "demo-googlechat-bridge")).toBe(
      false,
    );
    expect(result.reusableMessagingProviders).toContain("demo-googlechat-bridge");
    expect(result.reusableMessagingChannels).toContain("googlechat");
    expect(providerMatchesGatewayCredential).toHaveBeenCalledWith(
      "demo-googlechat-bridge",
      "google-chat-bridge",
      "GOOGLE_CHAT_ACCESS_TOKEN",
    );
  });

  it("refuses and reports a bridge the gateway holds for a different agent", () => {
    // onboard recreates a sandbox name under a new agent (`Delete and recreate
    // '<name>' as <agent>?`), and the provider name carries no agent. Reusing the
    // stale binding would mint the previous agent's token — for Hermes that means
    // an OpenClaw profile whose scopes omit pubsub, so `:pull` fails with 403.
    // Refusing it also has to surface, or the channel silently leaves the intent.
    const result = prepareCreateSandboxMessaging(
      createInput({
        agentName: "hermes",
        enabledChannels: ["googlechat"],
        providerMatchesGatewayCredential: (_name: string, type: string) =>
          type === "google-chat-bridge",
      }),
    );

    expect(result.reusableMessagingProviders).not.toContain("demo-googlechat-bridge");
    expect(result.reusableMessagingChannels).not.toContain("googlechat");
    expect(result.missingBridgeChannels).toEqual(["googlechat"]);
  });

  it("reuses a bridge the gateway holds for the agent being onboarded", () => {
    const result = prepareCreateSandboxMessaging(
      createInput({
        agentName: "hermes",
        enabledChannels: ["googlechat"],
        providerMatchesGatewayCredential: (_name: string, type: string) =>
          type === "google-chat-hermes-bridge",
      }),
    );

    expect(result.reusableMessagingProviders).toContain("demo-googlechat-bridge");
    expect(result.reusableMessagingChannels).toContain("googlechat");
    expect(result.missingBridgeChannels).toEqual([]);
  });

  it("does not reuse a Hermes bridge when onboarding OpenClaw", () => {
    const gatewayHoldsHermesBinding = vi.fn(
      (_name: string, type: string) => type === "google-chat-hermes-bridge",
    );

    const result = prepareCreateSandboxMessaging(
      createInput({
        enabledChannels: ["googlechat"],
        providerMatchesGatewayCredential: gatewayHoldsHermesBinding,
      }),
    );

    expect(result.reusableMessagingProviders).not.toContain("demo-googlechat-bridge");
    expect(result.reusableMessagingChannels).not.toContain("googlechat");
  });

  it("routes the bridge through upsert instead of reuse when the secret is resolvable", () => {
    const providerMatchesGatewayCredential = vi.fn(() => true);

    const result = prepareCreateSandboxMessaging(
      createInput({
        enabledChannels: ["googlechat"],
        env: {
          GOOGLECHAT_SERVICE_ACCOUNT: JSON.stringify({
            client_email: "bot@p.iam.gserviceaccount.com",
            private_key: "fake-test-private-key-material",
          }),
        },
        providerMatchesGatewayCredential,
      }),
    );

    const def = result.messagingTokenDefs.find((d) => d.name === "demo-googlechat-bridge");
    expect(def?.token).toBeTruthy();
    expect(result.reusableMessagingProviders).not.toContain("demo-googlechat-bridge");
    expect(result.missingBridgeChannels).toEqual([]);
    // The token definition already owns the provider, so reuse never asks the
    // gateway — a matcher that would have said yes is never consulted.
    expect(providerMatchesGatewayCredential).not.toHaveBeenCalled();
  });

  it("configures no bridge for an agent no channel manifest supports", () => {
    // Defaulting an unknown agent to OpenClaw would hand a sandbox with no
    // messaging support the OpenClaw Google Chat bridge and its credential.
    const result = prepareCreateSandboxMessaging(
      createInput({
        agentName: "deepagents",
        enabledChannels: ["googlechat"],
        env: {
          GOOGLECHAT_SERVICE_ACCOUNT: JSON.stringify({
            client_email: "bot@p.iam.gserviceaccount.com",
            private_key: "fake-test-private-key-material",
          }),
        },
      }),
    );

    expect(result.messagingTokenDefs.map((def) => def.name)).not.toContain(
      "demo-googlechat-bridge",
    );
    // The provider name derives from the channel alone, so reuse has to be gated
    // as well; otherwise the sandbox adopts whichever bridge already exists.
    expect(result.reusableMessagingProviders).not.toContain("demo-googlechat-bridge");
    expect(result.reusableMessagingChannels).not.toContain("googlechat");
  });

  it("does not reuse a bridge provider without an exact gateway binding", () => {
    const result = prepareCreateSandboxMessaging(
      createInput({
        enabledChannels: ["googlechat"],
        providerMatchesGatewayCredential: () => false,
      }),
    );

    expect(result.reusableMessagingProviders).toEqual([]);
    expect(result.reusableMessagingChannels).toEqual([]);
    expect(result.missingBridgeChannels).toEqual(["googlechat"]);
  });

  it("does not reuse the bridge provider of a disabled channel", () => {
    // The matcher would accept this provider, so only the disabled guard can
    // keep it out — and a disabled channel is not a missing one either.
    const providerMatchesGatewayCredential = vi.fn(() => true);

    const result = prepareCreateSandboxMessaging(
      createInput({
        enabledChannels: ["googlechat"],
        disabledChannels: ["googlechat"],
        providerMatchesGatewayCredential,
      }),
    );

    expect(result.reusableMessagingProviders).toEqual([]);
    expect(result.missingBridgeChannels).toEqual([]);
    expect(providerMatchesGatewayCredential).not.toHaveBeenCalled();
  });

  it("reports missing Brave API keys before registering extra placeholder providers", () => {
    const registerExtraPlaceholderProviders = vi.fn(() => ["BRAVE_API_KEY_AGENT_A"]);

    const result = prepareCreateSandboxMessaging(
      createInput({
        webSearchConfig: { fetchEnabled: true },
        env: { [BRAVE_API_KEY_ENV]: "   " },
        registerExtraPlaceholderProviders,
      }),
    );

    expect(result.missingWebSearchCredentialEnv).toBe(BRAVE_API_KEY_ENV);
    expect(result.extraPlaceholderKeys).toEqual([]);
    expect(result.messagingTokenDefs.some(({ envKey }) => envKey === BRAVE_API_KEY_ENV)).toBe(
      false,
    );
    expect(registerExtraPlaceholderProviders).not.toHaveBeenCalled();
  });

  it("reuses an exact Brave gateway provider when the raw key is unavailable (#6743)", () => {
    const providerMatchesGatewayCredential = vi.fn(
      (name: string, type: string, credentialEnv: string) =>
        name === "demo-brave-search" && type === "brave" && credentialEnv === BRAVE_API_KEY_ENV,
    );

    const result = prepareCreateSandboxMessaging(
      createInput({
        webSearchConfig: { fetchEnabled: true },
        requireExactProviderBinding: true,
        providerMatchesGatewayCredential,
      }),
    );

    expect(result.missingWebSearchCredentialEnv).toBeNull();
    expect(result.messagingTokenDefs).toContainEqual({
      name: "demo-brave-search",
      envKey: BRAVE_API_KEY_ENV,
      token: null,
      providerType: "brave",
    });
    expect(result.reusableMessagingProviders).toEqual(["demo-brave-search"]);
  });

  it("reports a missing Tavily key using the selected provider credential", () => {
    const result = prepareCreateSandboxMessaging(
      createInput({
        webSearchConfig: { fetchEnabled: true, provider: "tavily" },
        env: { [BRAVE_API_KEY_ENV]: "brv-does-not-satisfy-tavily" },
      }),
    );

    expect(result.missingWebSearchCredentialEnv).toBe(TAVILY_API_KEY_ENV);
    expect(result.messagingTokenDefs.some(({ envKey }) => envKey === TAVILY_API_KEY_ENV)).toBe(
      false,
    );
  });

  it("adds the Brave provider token from the credential store before host env fallback", () => {
    const registerExtraPlaceholderProviders = vi.fn(() => []);

    const result = prepareCreateSandboxMessaging(
      createInput({
        webSearchConfig: { fetchEnabled: true },
        env: { [BRAVE_API_KEY_ENV]: "brv-host" },
        getCredential: (envKey) => (envKey === BRAVE_API_KEY_ENV ? "brv-store" : null),
        registerExtraPlaceholderProviders,
      }),
    );

    expect(result.missingWebSearchCredentialEnv).toBeNull();
    expect(result.hasMessagingTokens).toBe(true);
    expect(result.messagingTokenDefs).toContainEqual({
      name: "demo-brave-search",
      envKey: BRAVE_API_KEY_ENV,
      token: "brv-store",
      providerType: "brave",
    });
  });

  it("adds a per-sandbox Tavily provider with credential-store precedence", () => {
    const result = prepareCreateSandboxMessaging(
      createInput({
        webSearchConfig: { fetchEnabled: true, provider: "tavily" },
        env: { [TAVILY_API_KEY_ENV]: "tvly-host" },
        getCredential: (envKey) => (envKey === TAVILY_API_KEY_ENV ? "tvly-store" : null),
      }),
    );

    expect(result.missingWebSearchCredentialEnv).toBeNull();
    expect(result.messagingTokenDefs).toContainEqual({
      name: "demo-tavily-search",
      envKey: TAVILY_API_KEY_ENV,
      token: "tvly-store",
      providerType: "tavily",
    });
  });

  it("uses the versioned Hermes Tavily profile for Hermes sandboxes", () => {
    const result = prepareCreateSandboxMessaging(
      createInput({
        agentName: "hermes",
        webSearchConfig: { fetchEnabled: true, provider: "tavily" },
        env: { [TAVILY_API_KEY_ENV]: "tvly-host" },
      }),
    );

    expect(result.messagingTokenDefs).toContainEqual({
      name: "demo-tavily-search",
      envKey: TAVILY_API_KEY_ENV,
      token: "tvly-host",
      providerType: "tavily-hermes-v1",
    });
  });

  it("removes both Slack bot and app token definitions when Slack is disabled", () => {
    const result = prepareCreateSandboxMessaging(
      createInput({
        disabledChannels: ["slack"],
        getValidatedMessagingTokenByEnvKey: (_channels, envKey) =>
          envKey === "SLACK_BOT_TOKEN" || envKey === "SLACK_APP_TOKEN" ? `${envKey}-value` : null,
      }),
    );

    expect(result.disabledChannelNames.has("slack")).toBe(true);
    expect(result.messagingTokenDefs.map(({ envKey }) => envKey)).not.toContain("SLACK_BOT_TOKEN");
    expect(result.messagingTokenDefs.map(({ envKey }) => envKey)).not.toContain("SLACK_APP_TOKEN");
  });

  it("includes all static token-backed channels by default without probing reusable providers", () => {
    const providerMatchesGatewayCredential = vi.fn(() => true);

    const result = prepareCreateSandboxMessaging(
      createInput({
        enabledChannels: null,
        providerMatchesGatewayCredential,
      }),
    );

    expect([...result.messagingTokenDefs.map(({ envKey }) => envKey)].sort()).toEqual([
      "DISCORD_BOT_TOKEN",
      "MSTEAMS_APP_PASSWORD",
      "SLACK_APP_TOKEN",
      "SLACK_BOT_TOKEN",
      "TELEGRAM_BOT_TOKEN",
      "WECHAT_BOT_TOKEN",
    ]);
    expect(result.reusableMessagingProviders).toEqual([]);
    expect(result.reusableMessagingChannels).toEqual([]);
    expect(providerMatchesGatewayCredential).not.toHaveBeenCalled();
  });

  it("binds static messaging credentials to the endpointless provider profile (#9875)", () => {
    const result = prepareCreateSandboxMessaging(
      createInput({
        enabledChannels: ["discord", "slack"],
        getValidatedMessagingTokenByEnvKey: (_channels, envKey) => `${envKey}-value`,
      }),
    );

    expect(result.messagingTokenDefs).toMatchObject([
      {
        name: "demo-discord-bridge",
        envKey: "DISCORD_BOT_TOKEN",
        providerType: "nemoclaw-mcp-v1",
      },
      {
        name: "demo-slack-bridge",
        envKey: "SLACK_BOT_TOKEN",
        providerType: "nemoclaw-mcp-v1",
      },
      {
        name: "demo-slack-app",
        envKey: "SLACK_APP_TOKEN",
        providerType: "nemoclaw-mcp-v1",
      },
    ]);
  });

  it("uses BRAVE_API_KEY from host env when the credential store has no value", () => {
    const result = prepareCreateSandboxMessaging(
      createInput({
        webSearchConfig: { fetchEnabled: true },
        env: { [BRAVE_API_KEY_ENV]: "  brv-host  " },
      }),
    );

    expect(result.messagingTokenDefs).toContainEqual({
      name: "demo-brave-search",
      envKey: BRAVE_API_KEY_ENV,
      token: "brv-host",
      providerType: "brave",
    });
  });

  it("does not create static token definitions for tokenless QR channels", () => {
    const result = prepareCreateSandboxMessaging(
      createInput({
        enabledChannels: ["whatsapp"],
      }),
    );

    expect(result.messagingTokenDefs).toEqual([]);
    expect(result.hasMessagingTokens).toBe(false);
  });
});
