// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { collectMessagingBuildConfig, parseMessagingConfigList } from "./messaging-config";

const DISCORD_SNOWFLAKE_RE = /^[0-9]{17,19}$/;

describe("onboard messaging config", () => {
  it("parses comma-separated config without preserving line breaks", () => {
    expect(parseMessagingConfigList(" U01\nBAD , C01\rBAD , , U02 ")).toEqual([
      "U01BAD",
      "C01BAD",
      "U02",
    ]);
  });

  it("collects active channel allowlists and Slack channel config", () => {
    expect(
      collectMessagingBuildConfig({
        channels: [
          { name: "telegram", userIdEnvKey: "TELEGRAM_ALLOWED_IDS" },
          { name: "slack", userIdEnvKey: "SLACK_ALLOWED_USERS" },
          { name: "wechat", userIdEnvKey: "WECHAT_ALLOWED_IDS" },
        ],
        activeChannelNames: new Set(["slack", "telegram"]),
        enabledTokenEnvKeys: new Set(),
        env: {
          TELEGRAM_ALLOWED_IDS: "123,456",
          SLACK_ALLOWED_USERS: "U01ABC2DEF3",
          SLACK_ALLOWED_CHANNELS: "C012AB3CD\n,C987ZY6XW",
          WECHAT_ALLOWED_IDS: "wxid-unused",
        },
        discordSnowflakeRe: DISCORD_SNOWFLAKE_RE,
      }),
    ).toEqual({
      messagingAllowedIds: {
        telegram: ["123", "456"],
        slack: ["U01ABC2DEF3"],
      },
      discordGuilds: {},
      slackConfig: {
        allowedChannels: ["C012AB3CD", "C987ZY6XW"],
      },
    });
  });

  it("collects Discord guild config and warns on malformed IDs", () => {
    const warn = vi.fn();

    expect(
      collectMessagingBuildConfig({
        channels: [],
        activeChannelNames: new Set(),
        enabledTokenEnvKeys: new Set(["DISCORD_BOT_TOKEN"]),
        env: {
          DISCORD_SERVER_IDS: "1491590992753590594,bad-server",
          DISCORD_ALLOWED_IDS: "1491590992753590595,bad-user",
          DISCORD_REQUIRE_MENTION: "0",
        },
        discordSnowflakeRe: DISCORD_SNOWFLAKE_RE,
        warn,
      }),
    ).toEqual({
      messagingAllowedIds: {},
      discordGuilds: {
        "1491590992753590594": {
          requireMention: false,
          users: ["1491590992753590595", "bad-user"],
        },
        "bad-server": {
          requireMention: false,
          users: ["1491590992753590595", "bad-user"],
        },
      },
      slackConfig: {},
    });
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
