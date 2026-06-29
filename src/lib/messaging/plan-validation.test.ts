// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { SandboxMessagingPlan } from "./manifest";
import { compactSandboxMessagingPlanForPersistence } from "./persistence";
import {
  getActiveChannelIdsFromPlan,
  getConfiguredChannelIdsFromPlan,
  getDisabledChannelIdsFromPlan,
  getMessagingChannelConfigFromPlan,
  getMessagingPlanStateValues,
  parseSandboxMessagingPlan,
} from "./plan-validation";

function makePlan(overrides: Partial<SandboxMessagingPlan> = {}): SandboxMessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName: "sb",
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
        inputs: [
          {
            channelId: "telegram",
            inputId: "allowedIds",
            kind: "config",
            required: false,
            sourceEnv: "TELEGRAM_ALLOWED_IDS",
            value: "123",
          },
        ],
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
    ...overrides,
  };
}

describe("parseSandboxMessagingPlan", () => {
  it("returns a cloned plan when the schema and optional selectors match", () => {
    const source = makePlan();
    const parsed = parseSandboxMessagingPlan(source, {
      sandboxName: "sb",
      agent: "openclaw",
      supportedChannelIds: ["telegram"],
    });

    expect(parsed).toEqual(source);
    expect(parsed).not.toBe(source);
  });

  it("accepts compact persisted plans without manifest-derived sections", () => {
    const source = makePlan({
      channels: [
        {
          ...makePlan().channels[0],
          inputs: [
            {
              channelId: "telegram",
              inputId: "botToken",
              kind: "secret",
              required: true,
              sourceEnv: "TELEGRAM_BOT_TOKEN",
              credentialAvailable: true,
            },
            makePlan().channels[0].inputs[0],
          ],
        },
      ],
      credentialBindings: [
        {
          channelId: "telegram",
          credentialId: "telegramBotToken",
          sourceInput: "botToken",
          providerName: "sb-telegram-bridge",
          providerEnvKey: "TELEGRAM_BOT_TOKEN",
          placeholder: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
          credentialAvailable: true,
          credentialHash: "hash",
        },
      ],
    });
    const compact = compactSandboxMessagingPlanForPersistence(source);
    const parsed = parseSandboxMessagingPlan(compact);

    expect(compact.networkPolicy).toEqual(source.networkPolicy);
    expect(compact).not.toHaveProperty("agentRender");
    expect(compact).not.toHaveProperty("buildSteps");
    expect(compact).not.toHaveProperty("runtimeSetup");
    expect(compact).not.toHaveProperty("stateUpdates");
    expect(compact).not.toHaveProperty("healthChecks");
    expect(compact.channels[0]).toEqual({
      channelId: "telegram",
      active: true,
      configured: true,
      disabled: false,
      inputs: [
        { inputId: "allowedIds", value: "123" },
        { inputId: "botToken", credentialAvailable: true },
      ],
    });
    expect(parsed).toMatchObject({
      ...source,
      channels: [
        expect.objectContaining({
          channelId: "telegram",
          active: true,
          hooks: [],
          inputs: expect.arrayContaining([
            expect.objectContaining({
              inputId: "botToken",
              credentialAvailable: true,
              sourceEnv: "TELEGRAM_BOT_TOKEN",
            }),
            expect.objectContaining({
              inputId: "allowedIds",
              statePath: "allowedIds.telegram",
              value: "123",
            }),
          ]),
        }),
      ],
      credentialBindings: [
        expect.objectContaining({
          providerEnvKey: "TELEGRAM_BOT_TOKEN",
          credentialAvailable: true,
          credentialHash: "hash",
        }),
      ],
    });
  });

  it("keeps compact persisted plans free of derived workflow sections", () => {
    const source = makePlan({
      networkPolicy: {
        presets: ["telegram"],
        entries: [
          {
            channelId: "telegram",
            presetName: "telegram",
            policyKeys: ["telegram"],
            source: "manifest",
          },
        ],
      },
      agentRender: [
        {
          channelId: "telegram",
          agent: "openclaw",
          target: "openclaw.json",
          kind: "json-fragment",
          path: "channels.telegram",
          value: { enabled: true },
          templateRefs: [],
        },
      ],
      buildSteps: [
        {
          channelId: "telegram",
          kind: "package-install",
          outputId: "telegram-openclaw-plugin",
          required: true,
          value: "npm:@openclaw/telegram",
        },
      ],
      runtimeSetup: {
        nodePreloads: [],
        envAliases: [],
        secretScans: [
          {
            channelId: "telegram",
            path: "/sandbox/.openclaw/openclaw.json",
            pattern: "TELEGRAM_BOT_TOKEN",
          },
        ],
      },
      stateUpdates: [
        {
          channelId: "telegram",
          kind: "persist-inputs",
          stateKey: "allowedIds.telegram",
          inputIds: ["allowedIds"],
        },
      ],
      healthChecks: [
        {
          channelId: "telegram",
          phase: "health-check",
          requiredBefore: "lifecycle-success",
          hookIds: ["telegram-openclaw-bridge-health"],
        },
      ],
    });

    const compact = compactSandboxMessagingPlanForPersistence(source);

    expect(compact.networkPolicy).toEqual(source.networkPolicy);
    expect(compact).not.toHaveProperty("agentRender");
    expect(compact).not.toHaveProperty("buildSteps");
    expect(compact).not.toHaveProperty("runtimeSetup");
    expect(compact).not.toHaveProperty("stateUpdates");
    expect(compact).not.toHaveProperty("healthChecks");
    expect(compact.channels).toEqual([
      {
        channelId: "telegram",
        active: true,
        configured: true,
        disabled: false,
        inputs: [{ inputId: "allowedIds", value: "123" }],
      },
    ]);
  });

  it("rejects mismatched selectors, duplicate channels, and unsupported channels", () => {
    expect(parseSandboxMessagingPlan(makePlan(), { sandboxName: "other" })).toBeNull();
    expect(parseSandboxMessagingPlan(makePlan(), { agent: "hermes" })).toBeNull();
    expect(parseSandboxMessagingPlan(makePlan(), { supportedChannelIds: ["discord"] })).toBeNull();
    expect(
      parseSandboxMessagingPlan(
        makePlan({ channels: [makePlan().channels[0], makePlan().channels[0]] }),
      ),
    ).toBeNull();
  });

  it("rejects any persisted channel when supportedChannelIds: [] is passed (deny-all)", () => {
    expect(parseSandboxMessagingPlan(makePlan(), { supportedChannelIds: [] })).toBeNull();
  });

  it("rejects malformed channel arrays without throwing", () => {
    const plan = makePlan() as unknown as { channels: unknown[] };
    plan.channels = [null];

    expect(parseSandboxMessagingPlan(plan)).toBeNull();
  });

  it("accepts and rejects channel host forward plans", () => {
    const source = makePlan({
      channels: [
        {
          ...makePlan().channels[0],
          channelId: "teams",
          displayName: "Microsoft Teams",
          inputs: [
            {
              channelId: "teams",
              inputId: "webhookPort",
              kind: "config",
              required: false,
              sourceEnv: "MSTEAMS_PORT",
              statePath: "teamsConfig.webhookPort",
              value: "3978",
            },
          ],
          hostForward: {
            channelId: "teams",
            port: 3978,
            label: "Microsoft Teams webhook",
          },
        },
      ],
    });

    expect(parseSandboxMessagingPlan(source)?.channels[0]?.hostForward).toEqual({
      channelId: "teams",
      port: 3978,
      label: "Microsoft Teams webhook",
    });

    for (const hostForward of [
      { channelId: "telegram", port: 0, label: "Telegram webhook" },
      { channelId: "telegram", port: 70000, label: "Telegram webhook" },
      { channelId: "telegram", port: 3978.5, label: "Telegram webhook" },
      { channelId: "telegram", port: "3978", label: "Telegram webhook" },
      { channelId: "telegram", port: 3978 },
    ]) {
      const plan = makePlan() as unknown as { channels: Array<Record<string, unknown>> };
      plan.channels[0] = {
        ...plan.channels[0],
        hostForward,
      };

      expect(parseSandboxMessagingPlan(plan), JSON.stringify(hostForward)).toBeNull();
    }
  });

  it("rejects malformed object arrays without throwing", () => {
    for (const field of [
      "credentialBindings",
      "agentRender",
      "buildSteps",
      "stateUpdates",
      "healthChecks",
    ]) {
      const plan = makePlan() as unknown as Record<string, unknown>;
      plan[field] = [null];

      expect(parseSandboxMessagingPlan(plan), field).toBeNull();
    }

    const channelHooksPlan = makePlan() as unknown as { channels: { hooks: unknown[] }[] };
    channelHooksPlan.channels[0].hooks = [null];
    expect(parseSandboxMessagingPlan(channelHooksPlan), "channel hooks").toBeNull();

    const runtimeSetupPlan = makePlan() as unknown as Record<string, unknown>;
    runtimeSetupPlan.runtimeSetup = {
      nodePreloads: [null],
      envAliases: [],
      secretScans: [],
    };
    expect(parseSandboxMessagingPlan(runtimeSetupPlan), "runtimeSetup.nodePreloads").toBeNull();
  });
});

describe("plan channel derivation", () => {
  it("derives configured, active, disabled, and config values from a plan", () => {
    const plan = makePlan({
      disabledChannels: ["telegram"],
      channels: [{ ...makePlan().channels[0], disabled: true, active: false }],
    });

    expect(getConfiguredChannelIdsFromPlan(plan)).toEqual(["telegram"]);
    expect(getActiveChannelIdsFromPlan(plan)).toEqual([]);
    expect(getDisabledChannelIdsFromPlan(plan)).toEqual(["telegram"]);
    expect(getMessagingChannelConfigFromPlan(plan)).toEqual({ TELEGRAM_ALLOWED_IDS: "123" });
  });

  it("replays manifest-declared state hydration env values from plan inputs", () => {
    const plan = makePlan({
      channels: [
        {
          ...makePlan().channels[0],
          inputs: [
            {
              channelId: "telegram",
              inputId: "requireMention",
              kind: "config",
              required: false,
              sourceEnv: "TELEGRAM_REQUIRE_MENTION",
              statePath: "telegramConfig.requireMention",
              value: "1",
            },
            {
              channelId: "telegram",
              inputId: "groupPolicy",
              kind: "config",
              required: false,
              sourceEnv: "TELEGRAM_GROUP_POLICY",
              statePath: "telegramConfig.groupPolicy",
              value: "allowlist",
            },
          ],
        },
        {
          channelId: "wechat",
          displayName: "WeChat",
          authMode: "host-qr",
          active: true,
          selected: true,
          configured: true,
          disabled: false,
          inputs: [
            {
              channelId: "wechat",
              inputId: "accountId",
              kind: "config",
              required: true,
              sourceEnv: "WECHAT_ACCOUNT_ID",
              statePath: "wechatConfig.accountId",
              value: "wechat-account",
            },
            {
              channelId: "wechat",
              inputId: "baseUrl",
              kind: "config",
              required: false,
              sourceEnv: "WECHAT_BASE_URL",
              statePath: "wechatConfig.baseUrl",
              value: "https://wechat.example",
            },
          ],
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
          inputs: [
            {
              channelId: "slack",
              inputId: "allowedUsers",
              kind: "config",
              required: false,
              sourceEnv: "SLACK_ALLOWED_USERS",
              statePath: "allowedIds.slack",
              value: "U01ABC2DEF3",
            },
            {
              channelId: "slack",
              inputId: "allowedChannels",
              kind: "config",
              required: false,
              sourceEnv: "SLACK_ALLOWED_CHANNELS",
              statePath: "slackConfig.allowedChannels",
              value: "C012AB3CD",
            },
          ],
          hooks: [],
        },
        {
          channelId: "discord",
          displayName: "Discord",
          authMode: "token-paste",
          active: true,
          selected: true,
          configured: true,
          disabled: false,
          inputs: [
            {
              channelId: "discord",
              inputId: "serverId",
              kind: "config",
              required: false,
              sourceEnv: "DISCORD_SERVER_ID",
              statePath: "discordGuilds.serverId",
              value: "guild-1",
            },
            {
              channelId: "discord",
              inputId: "userId",
              kind: "config",
              required: false,
              sourceEnv: "DISCORD_USER_ID",
              statePath: "discordGuilds.userIds",
              value: "user-1",
            },
          ],
          hooks: [],
        },
      ],
      stateUpdates: [
        {
          channelId: "telegram",
          kind: "rebuild-hydration",
          statePath: "telegramConfig.requireMention",
          env: "TELEGRAM_REQUIRE_MENTION",
        },
        {
          channelId: "telegram",
          kind: "rebuild-hydration",
          statePath: "telegramConfig.groupPolicy",
          env: "TELEGRAM_GROUP_POLICY",
        },
        {
          channelId: "wechat",
          kind: "rebuild-hydration",
          statePath: "wechatConfig.accountId",
          env: "WECHAT_ACCOUNT_ID",
        },
        {
          channelId: "wechat",
          kind: "rebuild-hydration",
          statePath: "wechatConfig.baseUrl",
          env: "WECHAT_BASE_URL",
        },
        {
          channelId: "slack",
          kind: "rebuild-hydration",
          statePath: "allowedIds.slack",
          env: "SLACK_ALLOWED_USERS",
        },
        {
          channelId: "slack",
          kind: "rebuild-hydration",
          statePath: "slackConfig.allowedChannels",
          env: "SLACK_ALLOWED_CHANNELS",
        },
        {
          channelId: "discord",
          kind: "rebuild-hydration",
          statePath: "discordGuilds.serverId",
          env: "DISCORD_SERVER_ID",
        },
        {
          channelId: "discord",
          kind: "rebuild-hydration",
          statePath: "discordGuilds.userIds",
          env: "DISCORD_USER_ID",
        },
      ],
    });

    expect(getMessagingPlanStateValues(plan)).toMatchObject({
      "telegramConfig.requireMention": "1",
      "telegramConfig.groupPolicy": "allowlist",
      "wechatConfig.accountId": "wechat-account",
      "wechatConfig.baseUrl": "https://wechat.example",
      "allowedIds.slack": "U01ABC2DEF3",
      "slackConfig.allowedChannels": "C012AB3CD",
      "discordGuilds.serverId": "guild-1",
      "discordGuilds.userIds": "user-1",
    });
    expect(getMessagingChannelConfigFromPlan(plan)).toEqual({
      TELEGRAM_REQUIRE_MENTION: "1",
      TELEGRAM_GROUP_POLICY: "allowlist",
      WECHAT_ACCOUNT_ID: "wechat-account",
      WECHAT_BASE_URL: "https://wechat.example",
      SLACK_ALLOWED_USERS: "U01ABC2DEF3",
      SLACK_ALLOWED_CHANNELS: "C012AB3CD",
      DISCORD_SERVER_ID: "guild-1",
      DISCORD_USER_ID: "user-1",
    });
  });
});
