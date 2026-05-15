// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  getMessagingProviderNamesForChannel,
  getNonInteractiveStoredMessagingChannels,
} from "./messaging-reuse";

const messagingChannels = [
  { name: "discord", envKey: "DISCORD_BOT_TOKEN" },
  { name: "slack", envKey: "SLACK_BOT_TOKEN" },
];

describe("onboard messaging reuse", () => {
  it("requires both Slack providers before reusing a stored Slack channel", () => {
    expect(getMessagingProviderNamesForChannel("assistant", "slack")).toEqual([
      "assistant-slack-bridge",
      "assistant-slack-app",
    ]);

    const reusedChannels = getNonInteractiveStoredMessagingChannels(
      false,
      null,
      "assistant",
      messagingChannels,
      () => false,
      () => ({ messagingChannels: ["slack"] }),
      () => [],
      (provider) => provider === "assistant-slack-bridge",
      true,
    );

    expect(reusedChannels).toBeNull();
  });

  it("reuses stored Slack channels when both Slack providers exist", () => {
    const reusedChannels = getNonInteractiveStoredMessagingChannels(
      false,
      null,
      "assistant",
      messagingChannels,
      () => false,
      () => ({ messagingChannels: ["slack"] }),
      () => [],
      (provider) =>
        provider === "assistant-slack-bridge" || provider === "assistant-slack-app",
      true,
    );

    expect(reusedChannels).toEqual(["slack"]);
  });

  it("normalizes empty resume messaging channels to null", () => {
    const reusedChannels = getNonInteractiveStoredMessagingChannels(
      true,
      ["unknown"],
      "assistant",
      messagingChannels,
      () => false,
      () => ({ messagingChannels: ["discord"] }),
      () => [],
      () => true,
      true,
    );

    expect(reusedChannels).toBeNull();
  });
});
