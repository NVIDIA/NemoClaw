// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  hydrateMessagingChannelConfig,
  MESSAGING_CHANNEL_CONFIG_ENV_KEYS,
  readMessagingChannelConfigFromEnv,
  sanitizeMessagingChannelConfig,
} from "./messaging-channel-config";

describe("messaging channel config", () => {
  it("allowlists the non-secret channel config keys used by onboard", () => {
    expect(MESSAGING_CHANNEL_CONFIG_ENV_KEYS).toEqual([
      "TELEGRAM_ALLOWED_IDS",
      "TELEGRAM_REQUIRE_MENTION",
      "DISCORD_SERVER_ID",
      "DISCORD_USER_ID",
      "DISCORD_REQUIRE_MENTION",
      "SLACK_ALLOWED_USERS",
    ]);
  });

  it("sanitizes persisted config and rejects malformed reply-mode values", () => {
    expect(
      sanitizeMessagingChannelConfig({
        TELEGRAM_ALLOWED_IDS: "  123,456  ",
        TELEGRAM_REQUIRE_MENTION: "yes",
        DISCORD_SERVER_ID: "1491590992753590594",
        DISCORD_REQUIRE_MENTION: "0",
        SLACK_ALLOWED_USERS: "  U01ABC2DEF3, U04GHI5JKL6  ",
        NVIDIA_API_KEY: "not-channel-config",
      }),
    ).toEqual({
      TELEGRAM_ALLOWED_IDS: "123,456",
      DISCORD_SERVER_ID: "1491590992753590594",
      DISCORD_REQUIRE_MENTION: "0",
      SLACK_ALLOWED_USERS: "U01ABC2DEF3, U04GHI5JKL6",
    });
  });

  it("hydrates missing env values but preserves explicit env overrides", () => {
    const env: NodeJS.ProcessEnv = {
      TELEGRAM_ALLOWED_IDS: "env-user",
    };

    expect(
      hydrateMessagingChannelConfig(
        {
          TELEGRAM_ALLOWED_IDS: "stored-user",
          TELEGRAM_REQUIRE_MENTION: "1",
          DISCORD_REQUIRE_MENTION: "maybe",
        },
        env,
      ),
    ).toEqual({
      TELEGRAM_ALLOWED_IDS: "env-user",
      TELEGRAM_REQUIRE_MENTION: "1",
    });
    expect(env.TELEGRAM_ALLOWED_IDS).toBe("env-user");
    expect(env.TELEGRAM_REQUIRE_MENTION).toBe("1");
    expect(env.DISCORD_REQUIRE_MENTION).toBeUndefined();
  });

  it("reads effective config from env", () => {
    expect(
      readMessagingChannelConfigFromEnv({
        DISCORD_SERVER_ID: "1491590992753590594",
        DISCORD_REQUIRE_MENTION: "2",
        TELEGRAM_REQUIRE_MENTION: "0",
      }),
    ).toEqual({
      DISCORD_SERVER_ID: "1491590992753590594",
      TELEGRAM_REQUIRE_MENTION: "0",
    });
  });
});
