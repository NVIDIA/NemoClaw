// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { Session } from "../state/onboard-session";
import { prepareSandboxBuildPatchConfig } from "./sandbox-build-patch-config";

describe("prepareSandboxBuildPatchConfig", () => {
  it("reads build-time messaging config and persists session snapshots", () => {
    const updateSession = vi.fn((mutator: (session: Session) => Session | void) => {
      const current = {} as Session;
      return mutator(current) ?? current;
    });
    const readMessagingChannelConfigFromEnv = vi.fn();

    const result = prepareSandboxBuildPatchConfig({
      configuredMessagingChannels: ["telegram", "slack"],
      env: {
        TELEGRAM_ALLOWED_IDS: "123,456",
        SLACK_ALLOWED_USERS: "U01ABC2DEF3",
        SLACK_ALLOWED_CHANNELS: "C012AB3CD,C987ZY6XW",
        WECHAT_ALLOWED_IDS: "wxid-unused",
      },
      deps: {
        readMessagingChannelConfigFromEnv,
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

    expect(readMessagingChannelConfigFromEnv).toHaveBeenCalledWith({
      TELEGRAM_ALLOWED_IDS: "123,456",
      SLACK_ALLOWED_USERS: "U01ABC2DEF3",
      SLACK_ALLOWED_CHANNELS: "C012AB3CD,C987ZY6XW",
      WECHAT_ALLOWED_IDS: "wxid-unused",
    });
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
      configuredMessagingChannels: [],
      deps: {
        readMessagingChannelConfigFromEnv: vi.fn(() => null),
        computeTelegramRequireMention,
        loadSession: vi.fn(() => null),
        gatherWechatConfig: vi.fn(() => ({})),
        updateSession,
      },
    });

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
      configuredMessagingChannels: ["telegram"],
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

  it("keeps messaging authorization parsing delegated to the central env reader", () => {
    expect(() =>
      prepareSandboxBuildPatchConfig({
        configuredMessagingChannels: ["telegram"],
        env: {
          TELEGRAM_ALLOWED_IDS: "123\n456",
        } as NodeJS.ProcessEnv,
        deps: {
          computeTelegramRequireMention: vi.fn(() => null),
          loadSession: vi.fn(() => null),
          gatherWechatConfig: vi.fn(() => ({})),
          updateSession: vi.fn((mutator: (session: Session) => Session | void) => {
            const current = {} as Session;
            return mutator(current) ?? current;
          }),
        },
      }),
    ).toThrow("Messaging channel config values must not contain line breaks.");
  });
});
