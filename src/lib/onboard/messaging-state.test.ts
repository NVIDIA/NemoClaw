// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { AgentDefinition } from "../agent/defs";
import {
  filterEnabledChannelsByAgent,
  getAvailableMessagingChannelsForAgent,
  resolveMessagingChannelSeed,
  resolveQrSelectedChannels,
} from "./messaging-state";

function agent(messagingPlatforms: string[]): AgentDefinition {
  return { messagingPlatforms } as unknown as AgentDefinition;
}

describe("filterEnabledChannelsByAgent", () => {
  it("drops channels not declared by the agent manifest", () => {
    expect(
      filterEnabledChannelsByAgent(["whatsapp", "telegram"], agent(["telegram"])),
    ).toEqual(["telegram"]);
  });

  it("keeps every channel when the agent declares no supported list", () => {
    expect(filterEnabledChannelsByAgent(["whatsapp", "telegram"], agent([]))).toEqual([
      "whatsapp",
      "telegram",
    ]);
  });

  it("returns null/undefined inputs unchanged", () => {
    expect(filterEnabledChannelsByAgent(null, agent(["telegram"]))).toBeNull();
    expect(filterEnabledChannelsByAgent(undefined, agent(["telegram"]))).toBeUndefined();
  });

  it("preserves the list when the agent is null (no filter)", () => {
    expect(filterEnabledChannelsByAgent(["whatsapp", "telegram"], null)).toEqual([
      "whatsapp",
      "telegram",
    ]);
  });
});

describe("getAvailableMessagingChannelsForAgent", () => {
  const channels = [{ name: "telegram" }, { name: "whatsapp" }];

  it("filters channels not in the agent's messagingPlatforms", () => {
    expect(getAvailableMessagingChannelsForAgent(channels, agent(["telegram"]))).toEqual([
      { name: "telegram" },
    ]);
  });

  it("returns all channels when the agent has no platform list", () => {
    expect(getAvailableMessagingChannelsForAgent(channels, agent([]))).toEqual(channels);
  });
});

const messagingChannels = [
  { name: "telegram", envKey: "TELEGRAM_BOT_TOKEN", description: "", help: "", label: "" },
  {
    name: "wechat",
    envKey: "WECHAT_BOT_TOKEN",
    description: "",
    help: "",
    label: "",
    loginMethod: "host-qr" as const,
  },
  {
    name: "whatsapp",
    description: "",
    help: "",
    label: "",
    loginMethod: "in-sandbox-qr" as const,
  },
];

describe("resolveMessagingChannelSeed", () => {
  it("always seeds channels with host-side tokens", () => {
    expect(
      resolveMessagingChannelSeed(
        messagingChannels,
        null,
        (channel) => channel.name === "telegram",
      ),
    ).toEqual(["telegram"]);
  });

  it("carries forward only in-sandbox QR channels by default", () => {
    expect(
      resolveMessagingChannelSeed(
        messagingChannels,
        ["telegram", "wechat", "whatsapp"],
        () => false,
      ),
    ).toEqual(["whatsapp"]);
  });

  it("can carry forward all existing channels for interactive preselection", () => {
    expect(
      resolveMessagingChannelSeed(
        messagingChannels,
        ["telegram", "wechat", "whatsapp"],
        () => false,
        { includeAllExisting: true },
      ),
    ).toEqual(["telegram", "wechat", "whatsapp"]);
  });
});

describe("resolveQrSelectedChannels", () => {

  it("returns only in-sandbox QR-paired channels from the enabled list", () => {
    expect(
      resolveQrSelectedChannels(messagingChannels, ["telegram", "wechat", "whatsapp"], new Set()),
    ).toEqual(["whatsapp"]);
  });

  it("drops in-sandbox QR channels that are also in the disabled set", () => {
    expect(
      resolveQrSelectedChannels(messagingChannels, ["whatsapp"], new Set(["whatsapp"])),
    ).toEqual([]);
  });

  it("returns an empty list when no channels are enabled", () => {
    expect(resolveQrSelectedChannels(messagingChannels, null, new Set())).toEqual([]);
  });
});
