// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { AgentDefinition } from "../agent/defs";
import {
  filterEnabledChannelsByAgent,
  getAvailableMessagingChannelsForAgent,
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

describe("resolveQrSelectedChannels", () => {
  const channels = [
    { name: "telegram", envKey: "TELEGRAM_BOT_TOKEN", description: "", help: "", label: "" },
    { name: "whatsapp", description: "", help: "", label: "" },
  ];

  it("returns only QR-paired channels from the enabled list", () => {
    expect(resolveQrSelectedChannels(channels, ["telegram", "whatsapp"], new Set())).toEqual([
      "whatsapp",
    ]);
  });

  it("drops QR channels that are also in the disabled set", () => {
    expect(
      resolveQrSelectedChannels(channels, ["whatsapp"], new Set(["whatsapp"])),
    ).toEqual([]);
  });

  it("returns an empty list when no channels are enabled", () => {
    expect(resolveQrSelectedChannels(channels, null, new Set())).toEqual([]);
  });
});
