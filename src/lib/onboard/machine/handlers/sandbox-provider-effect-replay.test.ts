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
  it("registers staged Slack providers when a Telegram receipt still matches the gateway (#7702)", async () => {
    const slackBotToken = "xoxb-current-token";
    const slackAppToken = "xapp-current-token";
    const slackBotBinding = {
      name: "my-assistant-slack-bridge",
      type: "generic",
      credentialEnv: "SLACK_BOT_TOKEN",
    };
    const slackAppBinding = {
      name: "my-assistant-slack-app",
      type: "generic",
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
      type: "generic",
      credentialEnv: "TELEGRAM_BOT_TOKEN",
    };
    const session = createSession({
      sandboxName: "my-assistant",
      stagedCredentialProviders: [telegramBinding.name],
    });
    session.checkpoint = {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
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
      type: "generic",
      credentialEnv: "TELEGRAM_BOT_TOKEN",
    };
    const session = createSession({ sandboxName: "my-assistant" });
    session.checkpoint = {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
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

  it("removes an orphan binding left by an earlier append-only receipt update (#7702)", async () => {
    const orphanBinding = {
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
      webSearchConfig: { fetchEnabled: true, provider: "tavily" },
    });
    session.checkpoint = {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      sessionId: session.sessionId,
      machineState: "sandbox",
      updatedAt: "2026-01-01T00:00:00.000Z",
      sandboxIdentity: decisionSelected({ name: "my-assistant", agent: "openclaw" }),
      webSearch: decisionSelected({ fetchEnabled: true, provider: "tavily" }),
      messaging: decisionDeclined(),
      resourceProfile: decisionUnset(),
      gatewayAuthority: decisionUnset(),
      effectGroups: {
        web_search_provider: {
          completedAt: "2026-01-01T00:00:00.000Z",
          fingerprint: currentBinding.name,
        },
      },
      bindings: {
        credentialEnvs: [orphanBinding.credentialEnv, currentBinding.credentialEnv],
        registeredProviders: [orphanBinding, currentBinding],
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
        providerMatchesGatewayCredential: (name, type, credentialEnv) =>
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

    expect(stageSandboxCredentialProviders).not.toHaveBeenCalled();
    expect(calls.createSandbox).toHaveBeenCalledTimes(1);
    expect(result.session?.checkpoint?.bindings).toEqual({
      credentialEnvs: ["TAVILY_API_KEY"],
      registeredProviders: [currentBinding],
    });
  });

  it("records web registration before messaging reconciliation starts (#7702)", async () => {
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
    const { deps, calls } = createDeps(
      {
        updateSession: persistence.updateSession,
        recordStepComplete: persistence.recordStepComplete,
        stageSandboxCredentialProviders,
        readMessagingPlanFromEnv: () => {
          throw new Error("messaging reconciliation failed");
        },
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
    ).rejects.toThrow("messaging reconciliation failed");

    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(
      persistence.readSession().checkpoint?.effectGroups.web_search_provider?.fingerprint,
    ).toBe(currentBinding.name);
    expect(persistence.readSession().checkpoint?.bindings.registeredProviders).toContainEqual(
      currentBinding,
    );
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
    const withGatewayRouteMutationLock = async <T>(
      _gatewayName: string,
      operation: () => Promise<T> | T,
    ): Promise<T> => {
      lockCount += 1;
      if (lockCount === 2) liveBindings.delete(currentBinding.name);
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
});
