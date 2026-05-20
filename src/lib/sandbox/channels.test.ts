// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  KNOWN_CHANNELS,
  channelHasStaticToken,
  channelUsesInSandboxQrPairing,
  getChannelDef,
  getChannelTokenKeys,
  knownChannelNames,
  listChannels,
  type ChannelDef,
} from "./channels";

describe("sandbox-channels KNOWN_CHANNELS", () => {
  it("covers telegram, discord, wechat, slack, and whatsapp", () => {
    expect(knownChannelNames()).toEqual(["telegram", "discord", "wechat", "slack", "whatsapp"]);
  });

  it("exposes the primary bot-token env var for token-based channels", () => {
    expect(getChannelDef("telegram")?.envKey).toBe("TELEGRAM_BOT_TOKEN");
    expect(getChannelDef("discord")?.envKey).toBe("DISCORD_BOT_TOKEN");
    expect(getChannelDef("slack")?.envKey).toBe("SLACK_BOT_TOKEN");
    expect(getChannelDef("wechat")?.envKey).toBe("WECHAT_BOT_TOKEN");
  });

  it("classifies channels by login method", () => {
    // Token-paste is the default and stays implicit (undefined). WeChat
    // captures a static token via a host-side QR handshake
    // (src/ext/wechat/login.ts). WhatsApp pairs entirely inside the sandbox
    // because the bot library owns the live Signal-style session — a
    // host-side capture would yield a stale blob the moment the bot mutates
    // its on-disk state. Onboarding branches on this flag, so flipping any
    // of these silently misroutes the channel.
    expect(getChannelDef("wechat")?.loginMethod).toBe("host-qr");
    expect(getChannelDef("whatsapp")?.loginMethod).toBe("in-sandbox-qr");
    expect(getChannelDef("telegram")?.loginMethod).toBeUndefined();
    expect(getChannelDef("discord")?.loginMethod).toBeUndefined();
    expect(getChannelDef("slack")?.loginMethod).toBeUndefined();
  });

  it("declares wechat as DM-only with the WECHAT_ALLOWED_IDS env key", () => {
    const wechat = getChannelDef("wechat");
    expect(wechat?.allowIdsMode).toBe("dm");
    expect(wechat?.userIdEnvKey).toBe("WECHAT_ALLOWED_IDS");
  });

  it("omits envKey for in-sandbox QR-paired channels (whatsapp)", () => {
    expect(getChannelDef("whatsapp")?.envKey).toBeUndefined();
    expect(channelUsesInSandboxQrPairing(KNOWN_CHANNELS.whatsapp)).toBe(true);
    expect(channelUsesInSandboxQrPairing(KNOWN_CHANNELS.wechat)).toBe(false);
    expect(channelUsesInSandboxQrPairing(KNOWN_CHANNELS.slack)).toBe(false);
  });

  it("declares no provider-credential metadata for WhatsApp", () => {
    const whatsapp = getChannelDef("whatsapp");
    expect(whatsapp?.envKey).toBeUndefined();
    expect(whatsapp?.appTokenEnvKey).toBeUndefined();
    expect(whatsapp?.tokenFormat).toBeUndefined();
    expect(whatsapp?.appTokenFormat).toBeUndefined();
    expect(getChannelTokenKeys(KNOWN_CHANNELS.whatsapp)).toEqual([]);
  });

  it("only slack declares a secondary app-token env var", () => {
    expect(getChannelDef("telegram")?.appTokenEnvKey).toBeUndefined();
    expect(getChannelDef("discord")?.appTokenEnvKey).toBeUndefined();
    expect(getChannelDef("slack")?.appTokenEnvKey).toBe("SLACK_APP_TOKEN");
    expect(getChannelDef("whatsapp")?.appTokenEnvKey).toBeUndefined();
  });

  it("asks for Slack human member IDs as a comma-separated allowlist", () => {
    const slack = getChannelDef("slack");
    expect(slack?.userIdEnvKey).toBe("SLACK_ALLOWED_USERS");
    expect(slack?.userIdLabel).toBe("Slack Member IDs (comma-separated allowlist)");
    expect(slack?.userIdHelp).toContain("comma-separated member IDs");
    expect(slack?.userIdHelp).toContain("not the app or bot user ID");
    expect(slack?.allowIdsMode).toBe("dm");
  });

  it("normalises case and whitespace when resolving a channel name", () => {
    expect(getChannelDef("  Telegram  ")).toBe(KNOWN_CHANNELS.telegram);
    expect(getChannelDef("DISCORD")).toBe(KNOWN_CHANNELS.discord);
    expect(getChannelDef("  WhatsApp  ")).toBe(KNOWN_CHANNELS.whatsapp);
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

  it("returns an empty list for QR-paired channels", () => {
    expect(getChannelTokenKeys(KNOWN_CHANNELS.whatsapp)).toEqual([]);
  });

  it("returns an empty list when the channel has no static envKey", () => {
    const tokenless: ChannelDef = { description: "", help: "", label: "" };
    expect(getChannelTokenKeys(tokenless)).toEqual([]);
  });
});

describe("sandbox-channels token-shape helpers", () => {
  it("channelUsesInSandboxQrPairing flags channels whose loginMethod is in-sandbox-qr", () => {
    const tokenless: ChannelDef = { description: "", help: "", label: "" };
    expect(channelUsesInSandboxQrPairing(tokenless)).toBe(false);
    expect(channelUsesInSandboxQrPairing(KNOWN_CHANNELS.whatsapp)).toBe(true);
    expect(channelUsesInSandboxQrPairing(KNOWN_CHANNELS.wechat)).toBe(false);
    expect(channelUsesInSandboxQrPairing(KNOWN_CHANNELS.telegram)).toBe(false);
    expect(channelUsesInSandboxQrPairing(KNOWN_CHANNELS.slack)).toBe(false);
  });

  it("channelHasStaticToken narrows to ChannelDef with a defined envKey", () => {
    const qr: ChannelDef = { description: "", help: "", label: "" };
    expect(channelHasStaticToken(qr)).toBe(false);
    expect(channelHasStaticToken(KNOWN_CHANNELS.telegram)).toBe(true);
    if (channelHasStaticToken(KNOWN_CHANNELS.telegram)) {
      // Type-narrowed: envKey is `string`, no longer `string | undefined`.
      const envKey: string = KNOWN_CHANNELS.telegram.envKey;
      expect(envKey).toBe("TELEGRAM_BOT_TOKEN");
    }
  });
});

describe("sandbox-channels listChannels", () => {
  it("materialises an array with the name merged into each entry", () => {
    const list = listChannels();
    expect(list.map((c) => c.name)).toEqual(["telegram", "discord", "wechat", "slack", "whatsapp"]);
    const telegram = list.find((c) => c.name === "telegram");
    expect(telegram?.envKey).toBe("TELEGRAM_BOT_TOKEN");
    expect(telegram?.allowIdsMode).toBe("dm");
    const whatsapp = list.find((c) => c.name === "whatsapp");
    expect(whatsapp?.envKey).toBeUndefined();
  });
});
