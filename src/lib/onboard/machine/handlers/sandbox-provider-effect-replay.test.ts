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
import { createSession } from "../../../state/onboard-session";
import { handleSandboxState } from "./sandbox";
import { baseOptions, createDeps, makeMinimalPlan, withEnv } from "./sandbox-test-fixtures";

vi.mock("../../messaging-channel-setup", () => ({
  detectMessagingChannelsFromEnv: vi.fn(() => []),
}));

describe("handleSandboxState provider effect replay", () => {
  it("registers staged Slack providers when a Telegram receipt still matches the gateway (#7702)", async () => {
    const slackBotToken = "xoxb-current-token";
    const slackAppToken = "xapp-current-token";
    const slackProviderBindings = [
      {
        name: "my-assistant-slack-bridge",
        type: "generic",
        credentialEnv: "SLACK_BOT_TOKEN",
      },
      {
        name: "my-assistant-slack-app",
        type: "generic",
        credentialEnv: "SLACK_APP_TOKEN",
      },
    ];
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
    let slackRegistered = false;
    const stageSandboxCredentialProviders = vi.fn(async () => {
      slackRegistered = true;
      return slackProviderBindings;
    });
    const { deps, calls } = createDeps(
      {
        readMessagingPlanFromEnv: () => slackPlan,
        stageSandboxCredentialProviders,
        providerMatchesGatewayCredential: (name, type, credentialEnv) =>
          [telegramBinding, ...(slackRegistered ? slackProviderBindings : [])].some(
            (binding) =>
              binding.name === name &&
              binding.type === type &&
              binding.credentialEnv === credentialEnv,
          ),
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
    let tavilyRegistered = false;
    const stageSandboxCredentialProviders = vi.fn(async () => {
      tavilyRegistered = true;
      return [tavilyBinding];
    });
    const { deps } = createDeps(
      {
        stageSandboxCredentialProviders,
        providerMatchesGatewayCredential: (name, type, credentialEnv) =>
          [braveBinding, ...(tavilyRegistered ? [tavilyBinding] : [])].some(
            (binding) =>
              binding.name === name &&
              binding.type === type &&
              binding.credentialEnv === credentialEnv,
          ),
      },
      session,
    );

    await handleSandboxState({
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
  });
});
