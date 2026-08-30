// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { SandboxMessagingPlan } from "../../../messaging/manifest";
import { hashCredential } from "../../../security/credential-hash";
import {
  decisionDeclined,
  decisionSelected,
  decisionUnset,
} from "../../../state/onboard-checkpoint-decision";
import { CHECKPOINT_SCHEMA_VERSION } from "../../../state/onboard-checkpoint-types";
import { createSession, type Session, type SessionUpdates } from "../../../state/onboard-session";
import { handleSandboxState } from "./sandbox";
import { baseOptions, createDeps, makeMinimalPlan, withEnv } from "./sandbox-test-fixtures";

vi.mock("../../messaging-channel-setup", () => ({
  detectMessagingChannelsFromEnv: vi.fn(() => []),
}));

function createImmutableSessionPersistence(initial: Session) {
  let current = structuredClone(initial);
  return {
    updateSession: vi.fn((mutator: (session: Session) => Session | void) => {
      const draft = structuredClone(current);
      const updated = mutator(draft);
      current = updated === undefined ? draft : updated;
      return structuredClone(current);
    }),
    recordStepComplete: vi.fn(async (_stepName: string, updates: SessionUpdates) => {
      const next = structuredClone(current);
      Object.assign(next, structuredClone(updates));
      current = next;
      return structuredClone(current);
    }),
    readSession: () => structuredClone(current),
  };
}

describe("handleSandboxState provider effect replay", () => {
  it("stages credential-bound messaging providers before sandbox creation", async () => {
    const discordToken = "discord-current-token";
    const binding = {
      name: "my-assistant-discord-bridge",
      type: "discord-hermes-static-v1",
      credentialEnv: "DISCORD_BOT_TOKEN",
    };
    const messagingPlan: SandboxMessagingPlan = {
      ...makeMinimalPlan("my-assistant", "hermes", ["discord"]),
      credentialBindings: [
        {
          channelId: "discord",
          credentialId: "bot-token",
          sourceInput: "botToken",
          providerName: binding.name,
          providerEnvKey: binding.credentialEnv,
          placeholder: "openshell:resolve:env:DISCORD_BOT_TOKEN",
          credentialAvailable: true,
          credentialHash: hashCredential(discordToken) ?? undefined,
        },
      ],
    };
    let providerIsLive = false;
    const events: string[] = [];
    const stageSandboxCredentialProviders = vi.fn(async () => {
      events.push("provider-staged");
      providerIsLive = true;
      return [binding];
    });
    const createSandbox = vi.fn(async (...args: unknown[]) => {
      events.push("sandbox-create");
      const createIntent = args.at(-1) as {
        deferSandboxEffectsUntilIdentityVerification?: boolean;
      };
      expect(createIntent.deferSandboxEffectsUntilIdentityVerification).toBeUndefined();
      return "my-assistant";
    });
    const session = createSession({ sandboxName: "my-assistant", agent: "hermes" });
    const { deps } = createDeps(
      {
        createSandbox,
        readMessagingPlanFromEnv: () => messagingPlan,
        stageSandboxCredentialProviders,
        providerMatchesGatewayCredential: (name, type, credentialEnv) =>
          providerIsLive &&
          name === binding.name &&
          type === binding.type &&
          credentialEnv === binding.credentialEnv,
      },
      session,
    );

    await withEnv("DISCORD_BOT_TOKEN", discordToken, () =>
      handleSandboxState({ ...baseOptions(deps, session), resume: false }),
    );

    expect(events).toEqual(["provider-staged", "sandbox-create"]);
    expect(stageSandboxCredentialProviders).toHaveBeenCalledOnce();
    expect(createSandbox).toHaveBeenCalledOnce();
  });

  it("registers staged Slack providers when a Telegram receipt still matches the gateway (#7702)", async () => {
    const slackBotToken = "xoxb-current-token";
    const slackAppToken = "xapp-current-token";
    const slackBotBinding = {
      name: "my-assistant-slack-bridge",
      type: "nemoclaw-mcp-v1",
      credentialEnv: "SLACK_BOT_TOKEN",
    };
    const slackAppBinding = {
      name: "my-assistant-slack-app",
      type: "nemoclaw-mcp-v1",
      credentialEnv: "SLACK_APP_TOKEN",
    };
    const slackProviderBindings = [slackBotBinding, slackAppBinding];
    const slackPlan: SandboxMessagingPlan = {
      ...makeMinimalPlan("my-assistant", "openclaw", ["slack"]),
      credentialBindings: [
        {
          channelId: "slack",
          credentialId: "slackBotToken",
          sourceInput: "botToken",
          providerName: "my-assistant-slack-bridge",
          providerEnvKey: "SLACK_BOT_TOKEN",
          placeholder: "openshell:resolve:env:SLACK_BOT_TOKEN",
          credentialAvailable: true,
          credentialHash: hashCredential(slackBotToken) ?? undefined,
        },
        {
          channelId: "slack",
          credentialId: "slackAppToken",
          sourceInput: "appToken",
          providerName: "my-assistant-slack-app",
          providerEnvKey: "SLACK_APP_TOKEN",
          placeholder: "openshell:resolve:env:SLACK_APP_TOKEN",
          credentialAvailable: true,
          credentialHash: hashCredential(slackAppToken) ?? undefined,
        },
      ],
    };
    const telegramBinding = {
      name: "my-assistant-telegram-bridge",
      type: "nemoclaw-mcp-v1",
      credentialEnv: "TELEGRAM_BOT_TOKEN",
    };
    const session = createSession({
      sandboxName: "my-assistant",
      stagedCredentialProviders: [telegramBinding.name],
    });
    session.checkpoint = {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      profile: { kind: "selected", value: "default" },
      runtimeAuthority: { kind: "unset" },
      sessionId: session.sessionId,
      machineState: "sandbox",
      updatedAt: "2026-01-01T00:00:00.000Z",
      sandboxIdentity: decisionSelected({ name: "my-assistant", agent: "openclaw" }),
      webSearch: decisionDeclined(),
      messaging: decisionSelected({ selectedChannels: ["telegram"], disabledChannels: [] }),
      resourceProfile: decisionUnset(),
      gatewayAuthority: decisionUnset(),
      effectGroups: {
        messaging_providers: {
          completedAt: "2026-01-01T00:00:00.000Z",
          fingerprint: telegramBinding.name,
        },
      },
      bindings: {
        credentialEnvs: [telegramBinding.credentialEnv],
        registeredProviders: [telegramBinding],
      },
      sandboxRecreate: null,
    };
    const liveBindings = new Map(
      [telegramBinding, slackBotBinding].map((binding) => [binding.name, binding]),
    );
    const stageSandboxCredentialProviders = vi.fn(async () => {
      liveBindings.delete(telegramBinding.name);
      liveBindings.set(slackAppBinding.name, slackAppBinding);
      return [slackAppBinding];
    });
    const persistence = createImmutableSessionPersistence(session);
    const { deps, calls } = createDeps(
      {
        updateSession: persistence.updateSession,
        recordStepComplete: persistence.recordStepComplete,
        readMessagingPlanFromEnv: () => slackPlan,
        stageSandboxCredentialProviders,
        providerMatchesGatewayCredential: (name, type, credentialEnv) =>
          liveBindings.get(name)?.type === type &&
          liveBindings.get(name)?.credentialEnv === credentialEnv,
      },
      session,
    );

    const result = await withEnv("SLACK_BOT_TOKEN", slackBotToken, () =>
      withEnv("SLACK_APP_TOKEN", slackAppToken, () =>
        handleSandboxState({
          ...baseOptions(deps, session),
          resume: true,
          sandboxName: "my-assistant",
        }),
      ),
    );

    expect(calls.setupMessaging).not.toHaveBeenCalled();
    expect(result.selectedMessagingChannels).toEqual(["slack"]);
    expect(stageSandboxCredentialProviders).toHaveBeenCalledWith({
      sandboxName: "my-assistant",
      enabledChannels: ["slack"],
      webSearchConfig: null,
      agent: null,
      requiredBindings: slackProviderBindings,
    });
    expect(calls.createSandbox).toHaveBeenCalledTimes(1);
    expect(result.session?.checkpoint?.bindings).toEqual({
      credentialEnvs: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
      registeredProviders: slackProviderBindings,
    });
    expect(result.session?.checkpoint?.effectGroups.messaging_providers?.fingerprint).toBe(
      "my-assistant-slack-bridge,my-assistant-slack-app",
    );
    expect(JSON.stringify(result.session)).not.toContain(slackBotToken);
    expect(JSON.stringify(result.session)).not.toContain(slackAppToken);
    expect(JSON.stringify(persistence.readSession())).not.toContain(slackBotToken);
    expect(JSON.stringify(persistence.readSession())).not.toContain(slackAppToken);
  });

  it("registers selected Tavily provider when a Brave receipt still matches the gateway (#7702)", async () => {
    const braveBinding = {
      name: "my-assistant-brave-search",
      type: "brave",
      credentialEnv: "BRAVE_API_KEY",
    };
    const tavilyBinding = {
      name: "my-assistant-tavily-search",
      type: "tavily",
      credentialEnv: "TAVILY_API_KEY",
    };
    const session = createSession({
      sandboxName: "my-assistant",
      webSearchConfig: { fetchEnabled: true, provider: "brave" },
      stagedCredentialProviders: [braveBinding.name],
    });
    session.checkpoint = {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      profile: { kind: "selected", value: "default" },
      runtimeAuthority: { kind: "unset" },
      sessionId: session.sessionId,
      machineState: "sandbox",
      updatedAt: "2026-01-01T00:00:00.000Z",
      sandboxIdentity: decisionSelected({ name: "my-assistant", agent: "openclaw" }),
      webSearch: decisionSelected({ fetchEnabled: true, provider: "brave" }),
      messaging: decisionDeclined(),
      resourceProfile: decisionUnset(),
      gatewayAuthority: decisionUnset(),
      effectGroups: {
        web_search_provider: {
          completedAt: "2026-01-01T00:00:00.000Z",
          fingerprint: braveBinding.name,
        },
      },
      bindings: {
        credentialEnvs: [braveBinding.credentialEnv],
        registeredProviders: [braveBinding],
      },
      sandboxRecreate: null,
    };
    const liveBindings = new Map([[braveBinding.name, braveBinding]]);
    const stageSandboxCredentialProviders = vi.fn(async () => {
      liveBindings.delete(braveBinding.name);
      liveBindings.set(tavilyBinding.name, tavilyBinding);
      return [tavilyBinding];
    });
    const persistence = createImmutableSessionPersistence(session);
    const { deps, calls } = createDeps(
      {
        updateSession: persistence.updateSession,
        recordStepComplete: persistence.recordStepComplete,
        stageSandboxCredentialProviders,
        providerMatchesGatewayCredential: (name, type, credentialEnv) =>
          liveBindings.get(name)?.type === type &&
          liveBindings.get(name)?.credentialEnv === credentialEnv,
      },
      session,
    );

    const result = await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "my-assistant",
      webSearchConfig: { fetchEnabled: true, provider: "tavily" },
    });

    expect(stageSandboxCredentialProviders).toHaveBeenCalledWith({
      sandboxName: "my-assistant",
      enabledChannels: [],
      webSearchConfig: { fetchEnabled: true, provider: "tavily" },
      agent: null,
      requiredBindings: [tavilyBinding],
    });
    expect(calls.createSandbox).toHaveBeenCalledTimes(1);
    expect(result.session?.checkpoint?.bindings).toEqual({
      credentialEnvs: ["TAVILY_API_KEY"],
      registeredProviders: [tavilyBinding],
    });
    expect(result.session?.checkpoint?.effectGroups.web_search_provider?.fingerprint).toBe(
      tavilyBinding.name,
    );
  });

  it("clears obsolete provider receipts when both current groups are disabled (#7702)", async () => {
    const oldWebBinding = {
      name: "my-assistant-brave-search",
      type: "brave",
      credentialEnv: "BRAVE_API_KEY",
    };
    const oldMessagingBinding = {
      name: "my-assistant-telegram-bridge",
      type: "nemoclaw-mcp-v1",
      credentialEnv: "TELEGRAM_BOT_TOKEN",
    };
    const session = createSession({ sandboxName: "my-assistant" });
    session.checkpoint = {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      profile: { kind: "selected", value: "default" },
      runtimeAuthority: { kind: "unset" },
      sessionId: session.sessionId,
      machineState: "sandbox",
      updatedAt: "2026-01-01T00:00:00.000Z",
      sandboxIdentity: decisionSelected({ name: "my-assistant", agent: "openclaw" }),
      webSearch: decisionDeclined(),
      messaging: decisionDeclined(),
      resourceProfile: decisionUnset(),
      gatewayAuthority: decisionUnset(),
      effectGroups: {
        web_search_provider: {
          completedAt: "2026-01-01T00:00:00.000Z",
          fingerprint: oldWebBinding.name,
        },
        messaging_providers: {
          completedAt: "2026-01-01T00:00:00.000Z",
          fingerprint: oldMessagingBinding.name,
        },
      },
      bindings: {
        credentialEnvs: [oldWebBinding.credentialEnv, oldMessagingBinding.credentialEnv],
        registeredProviders: [oldWebBinding, oldMessagingBinding],
      },
      sandboxRecreate: null,
    };
    const persistence = createImmutableSessionPersistence(session);
    const stageSandboxCredentialProviders = vi.fn(async () => []);
    const { deps, calls } = createDeps(
      {
        updateSession: persistence.updateSession,
        recordStepComplete: persistence.recordStepComplete,
        stageSandboxCredentialProviders,
        providerMatchesGatewayCredential: () => false,
      },
      session,
    );

    const result = await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "my-assistant",
    });

    expect(stageSandboxCredentialProviders).not.toHaveBeenCalled();
    expect(calls.createSandbox).toHaveBeenCalledTimes(1);
    expect(result.session?.checkpoint?.bindings).toEqual({
      credentialEnvs: [],
      registeredProviders: [],
    });
    expect(result.session?.checkpoint?.effectGroups.web_search_provider).toBeUndefined();
    expect(result.session?.checkpoint?.effectGroups.messaging_providers).toBeUndefined();
  });

  it("adopts a same-name orphan when replacing the recorded web provider (#7702)", async () => {
    const oldBinding = {
      name: "my-assistant-brave-search",
      type: "brave",
      credentialEnv: "BRAVE_API_KEY",
    };
    const currentBinding = {
      name: "my-assistant-tavily-search",
      type: "tavily",
      credentialEnv: "TAVILY_API_KEY",
    };
    const session = createSession({
      sandboxName: "my-assistant",
      webSearchConfig: { fetchEnabled: true, provider: "brave" },
    });
    session.checkpoint = {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      profile: { kind: "selected", value: "default" },
      runtimeAuthority: { kind: "unset" },
      sessionId: session.sessionId,
      machineState: "sandbox",
      updatedAt: "2026-01-01T00:00:00.000Z",
      sandboxIdentity: decisionSelected({ name: "my-assistant", agent: "openclaw" }),
      webSearch: decisionSelected({ fetchEnabled: true, provider: "brave" }),
      messaging: decisionDeclined(),
      resourceProfile: decisionUnset(),
      gatewayAuthority: decisionUnset(),
      effectGroups: {
        web_search_provider: {
          completedAt: "2026-01-01T00:00:00.000Z",
          fingerprint: oldBinding.name,
        },
      },
      bindings: {
        credentialEnvs: [oldBinding.credentialEnv, currentBinding.credentialEnv],
        registeredProviders: [oldBinding, currentBinding],
      },
      sandboxRecreate: null,
    };
    const persistence = createImmutableSessionPersistence(session);
    let currentBindingLive = true;
    const stageSandboxCredentialProviders = vi.fn(async () => {
      currentBindingLive = true;
      return [currentBinding];
    });
    const { deps, calls } = createDeps(
      {
        updateSession: persistence.updateSession,
        recordStepComplete: persistence.recordStepComplete,
        stageSandboxCredentialProviders,
        providerMatchesGatewayCredential: (name, type, credentialEnv) =>
          currentBindingLive &&
          name === currentBinding.name &&
          type === currentBinding.type &&
          credentialEnv === currentBinding.credentialEnv,
      },
      session,
    );

    const result = await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "my-assistant",
      webSearchConfig: { fetchEnabled: true, provider: "tavily" },
    });

    expect(stageSandboxCredentialProviders).toHaveBeenCalledTimes(1);
    expect(calls.createSandbox).toHaveBeenCalledTimes(1);
    expect(result.session?.checkpoint?.bindings).toEqual({
      credentialEnvs: ["TAVILY_API_KEY"],
      registeredProviders: [currentBinding],
    });
  });

  it("reuses a completed web provider group after messaging registration fails (#7702)", async () => {
    const oldBinding = {
      name: "my-assistant-brave-search",
      type: "brave",
      credentialEnv: "BRAVE_API_KEY",
    };
    const currentBinding = {
      name: "my-assistant-tavily-search",
      type: "tavily",
      credentialEnv: "TAVILY_API_KEY",
    };
    const messagingBinding = {
      name: "my-assistant-telegram-bridge",
      type: "nemoclaw-mcp-v1",
      credentialEnv: "TELEGRAM_BOT_TOKEN",
    };
    const telegramToken = "telegram-current-token";
    const messagingPlan: SandboxMessagingPlan = {
      ...makeMinimalPlan("my-assistant", "openclaw", ["telegram"]),
      credentialBindings: [
        {
          channelId: "telegram",
          credentialId: "bot-token",
          sourceInput: "botToken",
          providerName: messagingBinding.name,
          providerEnvKey: messagingBinding.credentialEnv,
          placeholder: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
          credentialAvailable: true,
          credentialHash: hashCredential(telegramToken) ?? undefined,
        },
      ],
    };
    const session = createSession({
      sandboxName: "my-assistant",
      webSearchConfig: { fetchEnabled: true, provider: "brave" },
      messagingPlan,
    });
    session.checkpoint = {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      profile: { kind: "selected", value: "default" },
      runtimeAuthority: { kind: "unset" },
      sessionId: session.sessionId,
      machineState: "sandbox",
      updatedAt: "2026-01-01T00:00:00.000Z",
      sandboxIdentity: decisionSelected({ name: "my-assistant", agent: "openclaw" }),
      webSearch: decisionSelected({ fetchEnabled: true, provider: "brave" }),
      messaging: decisionSelected({ selectedChannels: ["telegram"], disabledChannels: [] }),
      resourceProfile: decisionUnset(),
      gatewayAuthority: decisionUnset(),
      effectGroups: {
        web_search_provider: {
          completedAt: "2026-01-01T00:00:00.000Z",
          fingerprint: oldBinding.name,
        },
      },
      bindings: {
        credentialEnvs: [oldBinding.credentialEnv],
        registeredProviders: [oldBinding],
      },
      sandboxRecreate: null,
    };
    const liveBindings = new Map([[oldBinding.name, oldBinding]]);
    const persistence = createImmutableSessionPersistence(session);
    let messagingAttempts = 0;
    const stageWebSearchBinding = async () => {
      liveBindings.delete(oldBinding.name);
      liveBindings.set(currentBinding.name, currentBinding);
      return [currentBinding];
    };
    const messagingStages = [
      async () => Promise.reject(new Error("messaging registration failed")),
      async () => {
        liveBindings.set(messagingBinding.name, messagingBinding);
        return [messagingBinding];
      },
    ];
    const stageMessagingBinding = async () => {
      const stage = messagingStages[Math.min(messagingAttempts, messagingStages.length - 1)]!;
      messagingAttempts += 1;
      return stage();
    };
    const stagesByBindingName = new Map([
      [currentBinding.name, stageWebSearchBinding],
      [messagingBinding.name, stageMessagingBinding],
    ]);
    const stageSandboxCredentialProviders = vi.fn(
      async (input: {
        requiredBindings: readonly {
          name: string;
          type: string;
          credentialEnv: string;
        }[];
      }) => {
        const stageName = input.requiredBindings.some(
          (binding) => binding.name === currentBinding.name,
        )
          ? currentBinding.name
          : messagingBinding.name;
        return (await stagesByBindingName.get(stageName)?.()) ?? [];
      },
    );
    const { deps, calls } = createDeps(
      {
        updateSession: persistence.updateSession,
        recordStepComplete: persistence.recordStepComplete,
        stageSandboxCredentialProviders,
        readMessagingPlanFromEnv: () => messagingPlan,
        providerMatchesGatewayCredential: (name, type, credentialEnv) =>
          liveBindings.get(name)?.type === type &&
          liveBindings.get(name)?.credentialEnv === credentialEnv,
      },
      session,
    );

    await withEnv("TELEGRAM_BOT_TOKEN", telegramToken, () =>
      expect(
        handleSandboxState({
          ...baseOptions(deps, session),
          resume: true,
          sandboxName: "my-assistant",
          webSearchConfig: { fetchEnabled: true, provider: "tavily" },
        }),
      ).rejects.toThrow("messaging registration failed"),
    );

    expect(stageSandboxCredentialProviders).toHaveBeenCalledTimes(2);
    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(
      persistence.readSession().checkpoint?.effectGroups.web_search_provider?.fingerprint,
    ).toBe(currentBinding.name);
    expect(persistence.readSession().checkpoint?.effectGroups.messaging_providers).toBeUndefined();
    expect(persistence.readSession().checkpoint?.bindings).toEqual({
      credentialEnvs: [currentBinding.credentialEnv],
      registeredProviders: [currentBinding],
    });

    const interruptedSession = persistence.readSession();
    const resumed = createDeps(
      {
        updateSession: persistence.updateSession,
        recordStepComplete: persistence.recordStepComplete,
        stageSandboxCredentialProviders,
        readMessagingPlanFromEnv: () => messagingPlan,
        providerMatchesGatewayCredential: (name, type, credentialEnv) =>
          liveBindings.get(name)?.type === type &&
          liveBindings.get(name)?.credentialEnv === credentialEnv,
      },
      interruptedSession,
    );

    const result = await withEnv("TELEGRAM_BOT_TOKEN", telegramToken, () =>
      handleSandboxState({
        ...baseOptions(resumed.deps, interruptedSession),
        resume: true,
        sandboxName: "my-assistant",
        webSearchConfig: { fetchEnabled: true, provider: "tavily" },
      }),
    );

    expect(stageSandboxCredentialProviders).toHaveBeenCalledTimes(3);
    expect(
      stageSandboxCredentialProviders.mock.calls.filter(([input]) =>
        input.requiredBindings.some((binding) => binding.name === currentBinding.name),
      ),
    ).toHaveLength(1);
    expect(resumed.calls.createSandbox).toHaveBeenCalledTimes(1);
    expect(result.session?.checkpoint?.bindings).toEqual({
      credentialEnvs: [currentBinding.credentialEnv, messagingBinding.credentialEnv],
      registeredProviders: [currentBinding, messagingBinding],
    });
    expect(result.session?.checkpoint?.effectGroups).toMatchObject({
      web_search_provider: { fingerprint: currentBinding.name },
      messaging_providers: { fingerprint: messagingBinding.name },
    });
  });

  it("does not record a provider receipt when registration lacks the live binding (#7702)", async () => {
    const oldBinding = {
      name: "my-assistant-brave-search",
      type: "brave",
      credentialEnv: "BRAVE_API_KEY",
    };
    const currentBinding = {
      name: "my-assistant-tavily-search",
      type: "tavily",
      credentialEnv: "TAVILY_API_KEY",
    };
    const session = createSession({
      sandboxName: "my-assistant",
      webSearchConfig: { fetchEnabled: true, provider: "brave" },
    });
    session.checkpoint = {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      profile: { kind: "selected", value: "default" },
      runtimeAuthority: { kind: "unset" },
      sessionId: session.sessionId,
      machineState: "sandbox",
      updatedAt: "2026-01-01T00:00:00.000Z",
      sandboxIdentity: decisionSelected({ name: "my-assistant", agent: "openclaw" }),
      webSearch: decisionSelected({ fetchEnabled: true, provider: "brave" }),
      messaging: decisionDeclined(),
      resourceProfile: decisionUnset(),
      gatewayAuthority: decisionUnset(),
      effectGroups: {
        web_search_provider: {
          completedAt: "2026-01-01T00:00:00.000Z",
          fingerprint: oldBinding.name,
        },
      },
      bindings: {
        credentialEnvs: [oldBinding.credentialEnv],
        registeredProviders: [oldBinding],
      },
      sandboxRecreate: null,
    };
    const persistence = createImmutableSessionPersistence(session);
    const stageSandboxCredentialProviders = vi.fn(async () => [currentBinding]);
    const { deps, calls } = createDeps(
      {
        updateSession: persistence.updateSession,
        recordStepComplete: persistence.recordStepComplete,
        stageSandboxCredentialProviders,
        providerMatchesGatewayCredential: () => false,
      },
      session,
    );

    await expect(
      handleSandboxState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "my-assistant",
        webSearchConfig: { fetchEnabled: true, provider: "tavily" },
      }),
    ).rejects.toThrow("exit 1");

    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(persistence.readSession().checkpoint?.bindings).toEqual({
      credentialEnvs: ["BRAVE_API_KEY"],
      registeredProviders: [oldBinding],
    });
    expect(
      persistence.readSession().checkpoint?.effectGroups.web_search_provider?.fingerprint,
    ).toBe(oldBinding.name);
  });

  it("rejects current provider removal between registration and sandbox creation (#7702)", async () => {
    const oldBinding = {
      name: "my-assistant-brave-search",
      type: "brave",
      credentialEnv: "BRAVE_API_KEY",
    };
    const currentBinding = {
      name: "my-assistant-tavily-search",
      type: "tavily",
      credentialEnv: "TAVILY_API_KEY",
    };
    const session = createSession({
      sandboxName: "my-assistant",
      webSearchConfig: { fetchEnabled: true, provider: "brave" },
    });
    session.checkpoint = {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      profile: { kind: "selected", value: "default" },
      runtimeAuthority: { kind: "unset" },
      sessionId: session.sessionId,
      machineState: "sandbox",
      updatedAt: "2026-01-01T00:00:00.000Z",
      sandboxIdentity: decisionSelected({ name: "my-assistant", agent: "openclaw" }),
      webSearch: decisionSelected({ fetchEnabled: true, provider: "brave" }),
      messaging: decisionDeclined(),
      resourceProfile: decisionUnset(),
      gatewayAuthority: decisionUnset(),
      effectGroups: {
        web_search_provider: {
          completedAt: "2026-01-01T00:00:00.000Z",
          fingerprint: oldBinding.name,
        },
      },
      bindings: {
        credentialEnvs: [oldBinding.credentialEnv],
        registeredProviders: [oldBinding],
      },
      sandboxRecreate: null,
    };
    const liveBindings = new Map([[oldBinding.name, oldBinding]]);
    const persistence = createImmutableSessionPersistence(session);
    const stageSandboxCredentialProviders = vi.fn(async () => {
      liveBindings.delete(oldBinding.name);
      liveBindings.set(currentBinding.name, currentBinding);
      return [currentBinding];
    });
    let lockCount = 0;
    const beforeLock = [() => undefined, () => liveBindings.delete(currentBinding.name)];
    const withGatewayRouteMutationLock = async <T>(
      _gatewayName: string,
      operation: () => Promise<T> | T,
    ): Promise<T> => {
      beforeLock[lockCount]?.();
      lockCount += 1;
      return await operation();
    };
    const { deps, calls } = createDeps(
      {
        updateSession: persistence.updateSession,
        recordStepComplete: persistence.recordStepComplete,
        stageSandboxCredentialProviders,
        withGatewayRouteMutationLock,
        providerMatchesGatewayCredential: (name, type, credentialEnv) =>
          liveBindings.get(name)?.type === type &&
          liveBindings.get(name)?.credentialEnv === credentialEnv,
      },
      session,
    );

    await expect(
      handleSandboxState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "my-assistant",
        webSearchConfig: { fetchEnabled: true, provider: "tavily" },
      }),
    ).rejects.toThrow("exit 1");

    expect(lockCount).toBe(2);
    expect(calls.createSandbox).not.toHaveBeenCalled();
  });

  it("rejects a messaging binding that collides with the web provider before provider setup (#7701)", async () => {
    const collidingPlan: SandboxMessagingPlan = {
      ...makeMinimalPlan("my-assistant", "openclaw", ["telegram"]),
      credentialBindings: [
        {
          channelId: "telegram",
          credentialId: "bot-token",
          sourceInput: "botToken",
          providerName: "my-assistant-brave-search",
          providerEnvKey: "TELEGRAM_BOT_TOKEN",
          placeholder: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
          credentialAvailable: true,
        },
      ],
    };
    const session = createSession({
      sandboxName: "my-assistant",
      webSearchConfig: { fetchEnabled: true, provider: "brave" },
    });
    const stageSandboxCredentialProviders = vi.fn(async () => []);
    const { deps, calls, getSession } = createDeps(
      {
        readMessagingPlanFromEnv: () => collidingPlan,
        stageSandboxCredentialProviders,
      },
      session,
    );

    await expect(
      handleSandboxState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "my-assistant",
        webSearchConfig: { fetchEnabled: true, provider: "brave" },
      }),
    ).rejects.toThrow("exit 1");

    expect(stageSandboxCredentialProviders).not.toHaveBeenCalled();
    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(getSession().checkpoint?.bindings.registeredProviders).toEqual([]);
    expect(getSession().checkpoint?.effectGroups.web_search_provider).toBeUndefined();
    expect(getSession().checkpoint?.effectGroups.messaging_providers).toBeUndefined();
  });

  it("rejects a web binding owned by the recorded messaging group before provider setup (#7701)", async () => {
    const crossOwnedBinding = {
      name: "my-assistant-tavily-search",
      type: "generic",
      credentialEnv: "TELEGRAM_BOT_TOKEN",
    };
    const session = createSession({
      sandboxName: "my-assistant",
      webSearchConfig: { fetchEnabled: true, provider: "brave" },
    });
    session.checkpoint = {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      profile: { kind: "selected", value: "default" },
      runtimeAuthority: { kind: "unset" },
      sessionId: session.sessionId,
      machineState: "sandbox",
      updatedAt: "2026-01-01T00:00:00.000Z",
      sandboxIdentity: decisionSelected({ name: "my-assistant", agent: "openclaw" }),
      webSearch: decisionSelected({ fetchEnabled: true, provider: "brave" }),
      messaging: decisionDeclined(),
      resourceProfile: decisionUnset(),
      gatewayAuthority: decisionUnset(),
      effectGroups: {
        messaging_providers: {
          completedAt: "2026-01-01T00:00:00.000Z",
          fingerprint: crossOwnedBinding.name,
        },
      },
      bindings: {
        credentialEnvs: [crossOwnedBinding.credentialEnv],
        registeredProviders: [crossOwnedBinding],
      },
      sandboxRecreate: null,
    };
    const stageSandboxCredentialProviders = vi.fn(async () => []);
    const { deps, calls } = createDeps(
      {
        stageSandboxCredentialProviders,
      },
      session,
    );

    await expect(
      handleSandboxState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "my-assistant",
        webSearchConfig: { fetchEnabled: true, provider: "tavily" },
      }),
    ).rejects.toThrow("exit 1");

    expect(stageSandboxCredentialProviders).not.toHaveBeenCalled();
    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(calls.error.mock.calls.flat().join("\n")).toContain("nemoclaw onboard --fresh");
  });

  it("rejects a staged messaging plan for another sandbox before provider setup (#7701)", async () => {
    const session = createSession({ sandboxName: "my-assistant" });
    const mismatchedPlan = makeMinimalPlan("other-assistant", "openclaw", ["telegram"]);
    const stageSandboxCredentialProviders = vi.fn(async () => [
      {
        name: "my-assistant-telegram-bridge",
        type: "generic",
        credentialEnv: "TELEGRAM_BOT_TOKEN",
      },
    ]);
    const { deps, calls } = createDeps(
      {
        getRecordedMessagingChannelsForResume: () => ["telegram"],
        readMessagingPlanFromEnv: () => mismatchedPlan,
        stageSandboxCredentialProviders,
      },
      session,
    );

    await expect(
      handleSandboxState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "my-assistant",
        webSearchConfig: { fetchEnabled: true, provider: "brave" },
      }),
    ).rejects.toThrow("Staged messaging plan targets 'other-assistant', not 'my-assistant'.");

    expect(stageSandboxCredentialProviders).not.toHaveBeenCalled();
    expect(calls.createSandbox).not.toHaveBeenCalled();
  });

  it("rejects a session messaging plan for another sandbox before provider setup (#7701)", async () => {
    const mismatchedPlan = makeMinimalPlan("other-assistant", "openclaw", ["telegram"]);
    const session = createSession({
      sandboxName: "my-assistant",
      messagingPlan: mismatchedPlan,
      webSearchConfig: { fetchEnabled: true, provider: "brave" },
    });
    const stageSandboxCredentialProviders = vi.fn(async () => [
      {
        name: "my-assistant-brave-search",
        type: "brave",
        credentialEnv: "BRAVE_API_KEY",
      },
    ]);
    const { deps, calls } = createDeps(
      {
        stageSandboxCredentialProviders,
      },
      session,
    );

    await expect(
      handleSandboxState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "my-assistant",
        webSearchConfig: { fetchEnabled: true, provider: "brave" },
      }),
    ).rejects.toThrow("Session messaging plan targets 'other-assistant', not 'my-assistant'.");

    expect(stageSandboxCredentialProviders).not.toHaveBeenCalled();
    expect(calls.createSandbox).not.toHaveBeenCalled();
  });
});
