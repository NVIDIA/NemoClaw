// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  KNOWN_CHANNELS,
  getChannelDef,
  getChannelTokenKeys,
  knownChannelNames,
  listChannels,
} from "../../dist/lib/sandbox-channels";

describe("sandbox-channels KNOWN_CHANNELS", () => {
  it("covers telegram, discord, and slack", () => {
    expect(knownChannelNames()).toEqual(["telegram", "discord", "slack"]);
  });

  it("exposes the primary bot-token env var for each channel", () => {
    expect(getChannelDef("telegram")?.envKey).toBe("TELEGRAM_BOT_TOKEN");
    expect(getChannelDef("discord")?.envKey).toBe("DISCORD_BOT_TOKEN");
    expect(getChannelDef("slack")?.envKey).toBe("SLACK_BOT_TOKEN");
  });

  it("only slack declares a secondary app-token env var", () => {
    expect(getChannelDef("telegram")?.appTokenEnvKey).toBeUndefined();
    expect(getChannelDef("discord")?.appTokenEnvKey).toBeUndefined();
    expect(getChannelDef("slack")?.appTokenEnvKey).toBe("SLACK_APP_TOKEN");
  });

  it("normalises case and whitespace when resolving a channel name", () => {
    expect(getChannelDef("  Telegram  ")).toBe(KNOWN_CHANNELS.telegram);
    expect(getChannelDef("DISCORD")).toBe(KNOWN_CHANNELS.discord);
  });

  it("returns undefined for unknown channel names", () => {
    expect(getChannelDef("mattermost")).toBeUndefined();
    expect(getChannelDef("")).toBeUndefined();
  });
});

describe("sandbox-channels getChannelTokenKeys", () => {
  it("returns just the primary token key for single-token channels", () => {
    expect(getChannelTokenKeys(KNOWN_CHANNELS.telegram)).toEqual(["TELEGRAM_BOT_TOKEN"]);
    expect(getChannelTokenKeys(KNOWN_CHANNELS.discord)).toEqual(["DISCORD_BOT_TOKEN"]);
  });

  it("returns primary then app token for slack", () => {
    expect(getChannelTokenKeys(KNOWN_CHANNELS.slack)).toEqual([
      "SLACK_BOT_TOKEN",
      "SLACK_APP_TOKEN",
    ]);
  });
});

describe("sandbox-channels listChannels", () => {
  it("materialises an array with the name merged into each entry", () => {
    const list = listChannels();
    expect(list.map((c) => c.name)).toEqual(["telegram", "discord", "slack"]);
    const telegram = list.find((c) => c.name === "telegram");
    expect(telegram?.envKey).toBe("TELEGRAM_BOT_TOKEN");
    expect(telegram?.allowIdsMode).toBe("dm");
  });
});
