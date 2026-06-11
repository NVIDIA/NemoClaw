// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { Session } from "../state/onboard-session";
import { prepareSandboxBuildPatchConfig } from "./sandbox-build-patch-config";

const DISCORD_SNOWFLAKE_RE = /^[0-9]{17,19}$/;

describe("prepareSandboxBuildPatchConfig", () => {
  it("collects build-time messaging config and persists the session snapshot", () => {
    const updateSession = vi.fn((mutator: (session: Session) => Session | void) => {
      const current = {} as Session;
      return mutator(current) ?? current;
    });
    const messagingChannelConfig = { TELEGRAM_ALLOWED_IDS: "123,456" };

    const result = prepareSandboxBuildPatchConfig({
      channels: [
        { name: "telegram", userIdEnvKey: "TELEGRAM_ALLOWED_IDS" },
        { name: "slack", userIdEnvKey: "SLACK_ALLOWED_USERS" },
        { name: "wechat", userIdEnvKey: "WECHAT_ALLOWED_IDS" },
      ],
      activeMessagingChannels: ["telegram", "slack"],
      configuredMessagingChannels: ["telegram", "slack"],
      messagingTokenDefs: [{ envKey: "TELEGRAM_BOT_TOKEN" }, { envKey: "SLACK_BOT_TOKEN" }],
      discordSnowflakeRe: DISCORD_SNOWFLAKE_RE,
      env: {
        TELEGRAM_ALLOWED_IDS: "123,456",
        SLACK_ALLOWED_USERS: "U01ABC2DEF3",
        SLACK_ALLOWED_CHANNELS: "C012AB3CD,C987ZY6XW",
        WECHAT_ALLOWED_IDS: "wxid-unused",
      },
      deps: {
        readMessagingChannelConfigFromEnv: vi.fn(() => messagingChannelConfig),
        computeTelegramRequireMention: vi.fn(() => true),
        loadSession: vi.fn(() => ({ wechatConfig: { accountId: "old" } }) as Session),
        gatherWechatConfig: vi.fn(() => ({
          accountId: "acct",
          baseUrl: "https://wechat.example",
          userId: "wxid-user",
        })),
        updateSession,
      },
    });

    expect(result.messagingChannelConfig).toBe(messagingChannelConfig);
    expect(result.enabledTokenEnvKeys).toEqual(new Set(["TELEGRAM_BOT_TOKEN", "SLACK_BOT_TOKEN"]));
    expect(result.activeChannelNames).toEqual(new Set(["telegram", "slack"]));
    expect(result.messagingAllowedIds).toEqual({
      slack: ["U01ABC2DEF3"],
      telegram: ["123", "456"],
    });
    expect(result.slackConfig).toEqual({ allowedChannels: ["C012AB3CD", "C987ZY6XW"] });
    expect(result.telegramConfig).toEqual({ requireMention: true });
    expect(result.wechatConfig).toEqual({
      accountId: "acct",
      baseUrl: "https://wechat.example",
      userId: "wxid-user",
    });
    expect(updateSession).toHaveReturnedWith({
      telegramConfig: { requireMention: true },
      wechatConfig: {
        accountId: "acct",
        baseUrl: "https://wechat.example",
        userId: "wxid-user",
      },
    });
  });

  it("clears optional persisted config when no active token config is present", () => {
    const computeTelegramRequireMention = vi.fn(() => true);
    const updateSession = vi.fn((mutator: (session: Session) => Session | void) => {
      const current = {
        telegramConfig: { requireMention: true },
        wechatConfig: { accountId: "stale" },
      } as unknown as Session;
      return mutator(current) ?? current;
    });

    const result = prepareSandboxBuildPatchConfig({
      channels: [],
      activeMessagingChannels: [],
      messagingTokenDefs: [],
      discordSnowflakeRe: DISCORD_SNOWFLAKE_RE,
      deps: {
        readMessagingChannelConfigFromEnv: vi.fn(() => null),
        computeTelegramRequireMention,
        loadSession: vi.fn(() => null),
        gatherWechatConfig: vi.fn(() => ({})),
        updateSession,
      },
    });

    expect(result.messagingChannelConfig).toBeNull();
    expect(result.telegramConfig).toEqual({});
    expect(result.wechatConfig).toEqual({});
    expect(computeTelegramRequireMention).not.toHaveBeenCalled();
    expect(updateSession).toHaveReturnedWith({
      telegramConfig: null,
      wechatConfig: null,
    });
  });

  it("uses configured channel membership for Telegram mention config", () => {
    const computeTelegramRequireMention = vi.fn(() => true);

    const result = prepareSandboxBuildPatchConfig({
      channels: [{ name: "telegram", userIdEnvKey: "TELEGRAM_ALLOWED_IDS" }],
      activeMessagingChannels: [],
      configuredMessagingChannels: ["telegram"],
      messagingTokenDefs: [],
      discordSnowflakeRe: DISCORD_SNOWFLAKE_RE,
      deps: {
        readMessagingChannelConfigFromEnv: vi.fn(() => null),
        computeTelegramRequireMention,
        loadSession: vi.fn(() => null),
        gatherWechatConfig: vi.fn(() => ({})),
        updateSession: vi.fn((mutator: (session: Session) => Session | void) => {
          const current = {} as Session;
          return mutator(current) ?? current;
        }),
      },
    });

    expect(result.telegramConfig).toEqual({ requireMention: true });
    expect(computeTelegramRequireMention).toHaveBeenCalledOnce();
  });
});
