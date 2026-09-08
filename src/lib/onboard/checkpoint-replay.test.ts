// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { SandboxMessagingPlan } from "../messaging/manifest";
import { decisionSelected, decisionUnset } from "../state/onboard-checkpoint-decision";
import {
  CHECKPOINT_SCHEMA_VERSION,
  type OnboardCheckpoint,
} from "../state/onboard-checkpoint-types";
import {
  checkpointSandboxIdentityMatches,
  collectRequiredMessagingProviderBindings,
  observeProviderEffectFingerprint,
  planEffectGroupReplay,
  planSandboxCreateReplay,
  requiredMessagingProviderBindings,
  requiredWebSearchProviderType,
} from "./checkpoint-replay";
import { bindingRevalidationGuidance, revalidateCheckpointBindings } from "./checkpoint-revalidate";

const ISO = "2026-01-01T00:00:00.000Z";

function checkpoint(overrides: Partial<OnboardCheckpoint> = {}): OnboardCheckpoint {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    profile: { kind: "selected", value: "default" },
    runtimeAuthority: { kind: "unset" },
    sessionId: "s1",
    machineState: "sandbox",
    updatedAt: ISO,
    sandboxIdentity: decisionSelected({ name: "my-sandbox", agent: "openclaw" }),
    webSearch: decisionUnset(),
    messaging: decisionUnset(),
    resourceProfile: decisionUnset(),
    gatewayAuthority: decisionUnset(),
    effectGroups: {},
    bindings: { credentialEnvs: [], registeredProviders: [] },
    sandboxRecreate: null,
    ...overrides,
  };
}

describe("checkpointSandboxIdentityMatches", () => {
  it("accepts a selected checkpoint identity that matches the requested sandbox", () => {
    expect(
      checkpointSandboxIdentityMatches(
        {
          checkpoint: checkpoint(),
          machine: { state: "sandbox" },
        },
        "my-sandbox",
      ),
    ).toBe(true);
  });

  it("rejects a selected checkpoint identity that names another sandbox", () => {
    expect(
      checkpointSandboxIdentityMatches(
        {
          checkpoint: checkpoint(),
          machine: { state: "sandbox" },
        },
        "other-sandbox",
      ),
    ).toBe(false);
  });

  it("uses the checkpoint identity when legacy name progress disagrees", () => {
    expect(
      checkpointSandboxIdentityMatches(
        {
          checkpoint: checkpoint({ sandboxIdentity: decisionUnset() }),
          machine: { state: "sandbox" },
          sandboxName: "my-sandbox",
          sandboxPromptProgress: { sandboxName: true },
        },
        "my-sandbox",
      ),
    ).toBe(false);
  });

  it("uses legacy name progress only when no checkpoint exists", () => {
    expect(
      checkpointSandboxIdentityMatches(
        {
          checkpoint: null,
          machine: { state: "sandbox" },
          sandboxName: "my-sandbox",
          sandboxPromptProgress: { sandboxName: true },
        },
        "my-sandbox",
      ),
    ).toBe(true);
  });
});

describe("planEffectGroupReplay", () => {
  it("runs an unrecorded effect group", () => {
    expect(planEffectGroupReplay(checkpoint(), "messaging_providers", "fp").action).toBe("run");
  });

  it("re-runs a recorded group whose postcondition no longer holds (never blind skip)", () => {
    const cp = checkpoint({
      effectGroups: { messaging_providers: { completedAt: ISO, fingerprint: "fp" } },
    });
    const decision = planEffectGroupReplay(cp, "messaging_providers", null);
    expect(decision).toEqual({
      group: "messaging_providers",
      action: "run",
      reason: "postcondition_failed",
    });
  });

  it("skips a recorded group only after its postcondition is revalidated", () => {
    const cp = checkpoint({
      effectGroups: { messaging_providers: { completedAt: ISO, fingerprint: "fp" } },
    });
    expect(planEffectGroupReplay(cp, "messaging_providers", "fp").action).toBe("skip");
  });

  it("reruns a recorded effect group when the observed fingerprint differs", () => {
    const cp = checkpoint({
      effectGroups: { messaging_providers: { completedAt: ISO, fingerprint: "recorded" } },
    });
    expect(planEffectGroupReplay(cp, "messaging_providers", "observed")).toEqual({
      group: "messaging_providers",
      action: "run",
      reason: "fingerprint_mismatch",
    });
  });
});

describe("observeProviderEffectFingerprint", () => {
  it("revalidates only the providers named by the selected group receipt", () => {
    const cp = checkpoint({
      effectGroups: {
        web_search_provider: { completedAt: ISO, fingerprint: "web" },
        messaging_providers: { completedAt: ISO, fingerprint: "chat" },
      },
      bindings: {
        credentialEnvs: ["WEB_KEY", "CHAT_KEY"],
        registeredProviders: [
          { name: "web", type: "brave", credentialEnv: "WEB_KEY" },
          { name: "chat", type: "generic", credentialEnv: "CHAT_KEY" },
        ],
      },
    });

    expect(
      observeProviderEffectFingerprint(
        cp,
        "web_search_provider",
        [{ name: "web", type: "brave", credentialEnv: "WEB_KEY" }],
        (binding) => binding.name === "web",
      ),
    ).toBe("web");
  });

  it("fails revalidation when a recorded provider binding is missing or does not match", () => {
    const cp = checkpoint({
      effectGroups: {
        messaging_providers: { completedAt: ISO, fingerprint: "chat,missing" },
      },
      bindings: {
        credentialEnvs: ["CHAT_KEY"],
        registeredProviders: [{ name: "chat", type: "generic", credentialEnv: "CHAT_KEY" }],
      },
    });

    expect(
      observeProviderEffectFingerprint(
        cp,
        "messaging_providers",
        [
          { name: "chat", type: "generic", credentialEnv: "CHAT_KEY" },
          { name: "missing", type: "generic", credentialEnv: "MISSING_KEY" },
        ],
        () => true,
      ),
    ).toBeNull();
    expect(
      observeProviderEffectFingerprint(
        checkpoint({
          effectGroups: { messaging_providers: { completedAt: ISO, fingerprint: "chat" } },
          bindings: cp.bindings,
        }),
        "messaging_providers",
        [{ name: "chat", type: "generic", credentialEnv: "CHAT_KEY" }],
        () => false,
      ),
    ).toBeNull();
  });

  it("rejects a live receipt when the current provider set has changed", () => {
    const cp = checkpoint({
      effectGroups: {
        messaging_providers: { completedAt: ISO, fingerprint: "telegram" },
      },
      bindings: {
        credentialEnvs: ["TELEGRAM_BOT_TOKEN"],
        registeredProviders: [
          { name: "telegram", type: "generic", credentialEnv: "TELEGRAM_BOT_TOKEN" },
        ],
      },
    });

    expect(
      observeProviderEffectFingerprint(
        cp,
        "messaging_providers",
        [
          { name: "slack-bot", type: "generic", credentialEnv: "SLACK_BOT_TOKEN" },
          { name: "slack-app", type: "generic", credentialEnv: "SLACK_APP_TOKEN" },
        ],
        () => true,
      ),
    ).toBeNull();
  });

  it("rejects a same-name provider when its type or credential key changes", () => {
    const cp = checkpoint({
      effectGroups: {
        web_search_provider: { completedAt: ISO, fingerprint: "search" },
      },
      bindings: {
        credentialEnvs: ["BRAVE_API_KEY"],
        registeredProviders: [{ name: "search", type: "brave", credentialEnv: "BRAVE_API_KEY" }],
      },
    });

    expect(
      observeProviderEffectFingerprint(
        cp,
        "web_search_provider",
        [{ name: "search", type: "tavily", credentialEnv: "BRAVE_API_KEY" }],
        () => true,
      ),
    ).toBeNull();
    expect(
      observeProviderEffectFingerprint(
        cp,
        "web_search_provider",
        [{ name: "search", type: "brave", credentialEnv: "TAVILY_API_KEY" }],
        () => true,
      ),
    ).toBeNull();
  });

  it("accepts current provider bindings in a different order", () => {
    const cp = checkpoint({
      effectGroups: {
        messaging_providers: { completedAt: ISO, fingerprint: "slack-bot,slack-app" },
      },
      bindings: {
        credentialEnvs: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
        registeredProviders: [
          { name: "slack-bot", type: "generic", credentialEnv: "SLACK_BOT_TOKEN" },
          { name: "slack-app", type: "generic", credentialEnv: "SLACK_APP_TOKEN" },
        ],
      },
    });

    expect(
      observeProviderEffectFingerprint(
        cp,
        "messaging_providers",
        [
          { name: "slack-app", type: "generic", credentialEnv: "SLACK_APP_TOKEN" },
          { name: "slack-bot", type: "generic", credentialEnv: "SLACK_BOT_TOKEN" },
        ],
        () => true,
      ),
    ).toBe("slack-bot,slack-app");
  });
});

describe("requiredWebSearchProviderType", () => {
  it("uses the Hermes Tavily profile only for Hermes Tavily selection", () => {
    expect(requiredWebSearchProviderType("tavily", { name: "hermes" })).toBe("tavily-hermes-v1");
    expect(requiredWebSearchProviderType("tavily", { name: "openclaw" })).toBe("tavily");
    expect(requiredWebSearchProviderType("brave", { name: "hermes" })).toBe("brave");
  });
});

describe("requiredMessagingProviderBindings", () => {
  it("includes the Google Chat bridge profile binding", () => {
    const plan: SandboxMessagingPlan = {
      schemaVersion: 1,
      sandboxName: "my-assistant",
      agent: "openclaw",
      workflow: "onboard",
      channels: [
        {
          channelId: "googlechat",
          displayName: "Google Chat",
          authMode: "token-paste",
          active: true,
          selected: true,
          configured: true,
          disabled: false,
          inputs: [],
          hooks: [],
        },
      ],
      disabledChannels: [],
      credentialBindings: [],
      networkPolicy: { presets: [], entries: [] },
      agentRender: [],
      buildSteps: [],
      stateUpdates: [],
      healthChecks: [],
    };

    expect(requiredMessagingProviderBindings("my-assistant", plan)).toContainEqual({
      name: "my-assistant-googlechat-bridge",
      type: "google-chat-bridge",
      credentialEnv: "GOOGLE_CHAT_ACCESS_TOKEN",
    });

    const disabledPlan: SandboxMessagingPlan = {
      ...plan,
      channels: plan.channels.map((channel) => ({
        ...channel,
        active: false,
        disabled: true,
      })),
      disabledChannels: ["googlechat"],
    };

    expect(requiredMessagingProviderBindings("my-assistant", disabledPlan)).toEqual([]);
  });

  it("replaces the generic Hermes Discord binding with the active static profile", () => {
    const plan: SandboxMessagingPlan = {
      schemaVersion: 1,
      sandboxName: "hermes-discord",
      agent: "hermes",
      workflow: "onboard",
      channels: [
        {
          channelId: "discord",
          displayName: "Discord",
          authMode: "token-paste",
          active: true,
          selected: true,
          configured: true,
          disabled: false,
          inputs: [],
          hooks: [],
        },
      ],
      disabledChannels: [],
      credentialBindings: [
        {
          channelId: "discord",
          credentialId: "discordBotToken",
          sourceInput: "botToken",
          providerName: "hermes-discord-discord-bridge",
          providerEnvKey: "DISCORD_BOT_TOKEN",
          placeholder: "openshell:resolve:env:DISCORD_BOT_TOKEN",
          credentialAvailable: true,
        },
      ],
      networkPolicy: { presets: [], entries: [] },
      agentRender: [],
      buildSteps: [],
      stateUpdates: [],
      healthChecks: [],
    };

    expect(requiredMessagingProviderBindings("hermes-discord", plan)).toEqual([
      {
        name: "hermes-discord-discord-bridge",
        type: "discord-hermes-static-v1",
        credentialEnv: "DISCORD_BOT_TOKEN",
      },
    ]);
  });

  it("uses every credential and current provider identity for one active channel (#10660)", () => {
    const plan: SandboxMessagingPlan = {
      schemaVersion: 1,
      sandboxName: "alpha",
      agent: "openclaw",
      workflow: "onboard",
      channels: [
        {
          channelId: "telegram",
          displayName: "Telegram",
          authMode: "token-paste",
          active: true,
          selected: true,
          configured: true,
          disabled: false,
          inputs: [],
          hooks: [],
        },
        {
          channelId: "slack",
          displayName: "Slack",
          authMode: "token-paste",
          active: true,
          selected: true,
          configured: true,
          disabled: false,
          inputs: [],
          hooks: [],
        },
      ],
      disabledChannels: [],
      credentialBindings: [
        {
          channelId: "telegram",
          credentialId: "telegramBotToken",
          sourceInput: "botToken",
          providerName: "alpha-telegram-bridge",
          providerEnvKey: "TELEGRAM_BOT_TOKEN",
          placeholder: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
          credentialAvailable: true,
        },
        {
          channelId: "slack",
          credentialId: "slackBotToken",
          sourceInput: "botToken",
          providerName: "alpha-slack-bridge",
          providerEnvKey: "SLACK_BOT_TOKEN",
          placeholder: "openshell:resolve:env:SLACK_BOT_TOKEN",
          credentialAvailable: true,
        },
        {
          channelId: "slack",
          credentialId: "slackAppToken",
          sourceInput: "appToken",
          providerName: "alpha-slack-bridge",
          providerEnvKey: "SLACK_APP_TOKEN",
          placeholder: "openshell:resolve:env:SLACK_APP_TOKEN",
          credentialAvailable: true,
        },
      ],
      networkPolicy: { presets: [], entries: [] },
      agentRender: [],
      buildSteps: [],
      stateUpdates: [],
      healthChecks: [],
    };

    expect(collectRequiredMessagingProviderBindings("alpha", plan, new Set(["slack"]))).toEqual([
      {
        name: "alpha-slack-bridge",
        type: "nemoclaw-mcp-v1",
        credentialEnv: "SLACK_BOT_TOKEN",
      },
      {
        name: "alpha-slack-bridge",
        type: "nemoclaw-mcp-v1",
        credentialEnv: "SLACK_APP_TOKEN",
      },
    ]);
    expect(requiredMessagingProviderBindings("alpha", plan)).toEqual([
      {
        name: "alpha-telegram-bridge",
        type: "nemoclaw-mcp-v1",
        credentialEnv: "TELEGRAM_BOT_TOKEN",
      },
      {
        name: "alpha-slack-bridge",
        type: "nemoclaw-mcp-v1",
        credentialEnv: "SLACK_BOT_TOKEN",
      },
      {
        name: "alpha-slack-app",
        type: "nemoclaw-mcp-v1",
        credentialEnv: "SLACK_APP_TOKEN",
      },
    ]);
  });
});

describe("planSandboxCreateReplay never opens a second sandbox (#5961)", () => {
  it("requires identity capture before any create when identity is not durable", () => {
    const cp = checkpoint({ sandboxIdentity: decisionUnset() });
    expect(planSandboxCreateReplay(cp, { liveSandboxExists: false })).toEqual({
      action: "capture_identity_first",
    });
  });

  it("reuses the live sandbox when create is recorded and it still exists", () => {
    const cp = checkpoint({
      effectGroups: { sandbox_create: { completedAt: ISO, fingerprint: "fp" } },
    });
    expect(planSandboxCreateReplay(cp, { liveSandboxExists: true })).toEqual({
      action: "reuse",
      identity: { name: "my-sandbox", agent: "openclaw" },
    });
  });

  it("recreates under the SAME durable identity when the sandbox is gone, never a new name", () => {
    const cp = checkpoint({
      effectGroups: { sandbox_create: { completedAt: ISO, fingerprint: "fp" } },
    });
    expect(planSandboxCreateReplay(cp, { liveSandboxExists: false })).toEqual({
      action: "create",
      identity: { name: "my-sandbox", agent: "openclaw" },
    });
  });

  it("creates under the durable identity when create was never recorded", () => {
    expect(planSandboxCreateReplay(checkpoint(), { liveSandboxExists: false })).toEqual({
      action: "create",
      identity: { name: "my-sandbox", agent: "openclaw" },
    });
  });

  it("reuses a live sandbox even when the create receipt was lost to a mid-create crash (#7022)", () => {
    expect(planSandboxCreateReplay(checkpoint(), { liveSandboxExists: true })).toEqual({
      action: "reuse",
      identity: { name: "my-sandbox", agent: "openclaw" },
    });
  });
});

describe("revalidateCheckpointBindings fails closed without leaking values (#6228)", () => {
  it("passes when every binding is currently available", () => {
    const cp = checkpoint({
      bindings: {
        credentialEnvs: ["OPENAI_API_KEY"],
        registeredProviders: [{ name: "p1", type: "generic", credentialEnv: "P1_API_KEY" }],
      },
    });
    const result = revalidateCheckpointBindings(cp, {
      availableCredentialEnvs: new Set(["OPENAI_API_KEY"]),
      liveRegisteredProviders: new Set(["p1"]),
    });
    expect(result).toEqual({ status: "ok" });
    expect(bindingRevalidationGuidance(result)).toBeNull();
  });

  it("fails closed on a stale binding and reports only names, never values", () => {
    const cp = checkpoint({
      bindings: {
        credentialEnvs: ["OPENAI_API_KEY"],
        registeredProviders: [{ name: "p1", type: "generic", credentialEnv: "P1_API_KEY" }],
      },
    });
    const result = revalidateCheckpointBindings(cp, {
      availableCredentialEnvs: new Set(),
      liveRegisteredProviders: new Set(),
    });
    expect(result).toEqual({
      status: "stale",
      missingCredentialEnvs: ["OPENAI_API_KEY"],
      missingProviders: ["p1"],
    });
    const guidance = bindingRevalidationGuidance(result);
    expect(guidance).toContain("OPENAI_API_KEY");
    expect(guidance).toContain("p1");
  });
});
