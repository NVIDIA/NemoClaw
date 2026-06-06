// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  applyMessagingSelectorKey,
  createMessagingSelectorNormalizerState,
  normalizeMessagingSelectorInput,
  resolveMessagingChannelSelectorEntry,
} from "./messaging-selector";

const channels = [
  { id: "telegram", displayName: "Telegram", description: "Telegram bot messaging" },
  { id: "discord", displayName: "Discord", description: "Discord bot messaging" },
  { id: "wechat", displayName: "WeChat", description: "WeChat bot messaging" },
];

describe("messaging selector key handling", () => {
  it("toggles numeric raw keypresses before Enter confirms", () => {
    const enabled = new Set<string>();

    expect(applyMessagingSelectorKey("1", enabled, channels)).toBe("redraw");
    expect([...enabled]).toEqual(["telegram"]);
    expect(applyMessagingSelectorKey("2", enabled, channels)).toBe("redraw");
    expect([...enabled]).toEqual(["telegram", "discord"]);
    expect(applyMessagingSelectorKey("\r", enabled, channels)).toBe("finish");
  });

  it("normalizes complete terminal keypad and extended numeric sequences", () => {
    expect(normalizeMessagingSelectorInput("\x1bOq")).toBe("1");
    expect(normalizeMessagingSelectorInput("\x1b[49;5u")).toBe("1");
    expect(normalizeMessagingSelectorInput("\x1bOM")).toBe("\r");
    expect(normalizeMessagingSelectorInput("\x1b[13u")).toBe("\r");
  });

  it("buffers split terminal keypad and extended numeric sequences", () => {
    const state = createMessagingSelectorNormalizerState();

    expect(normalizeMessagingSelectorInput("\x1bO", state)).toBe("");
    expect(state.carry).toBe("\x1bO");
    expect(normalizeMessagingSelectorInput("q", state)).toBe("1");
    expect(state.carry).toBe("");

    expect(normalizeMessagingSelectorInput("\x1b[49;", state)).toBe("");
    expect(state.carry).toBe("\x1b[49;");
    expect(normalizeMessagingSelectorInput("5u", state)).toBe("1");
    expect(state.carry).toBe("");
  });

  it("resolves line-mode selections by number or channel id", () => {
    expect(resolveMessagingChannelSelectorEntry("2", channels)?.id).toBe("discord");
    expect(resolveMessagingChannelSelectorEntry("WeChat", channels)?.id).toBe("wechat");
    expect(resolveMessagingChannelSelectorEntry("mattermost", channels)).toBeNull();
  });
});
