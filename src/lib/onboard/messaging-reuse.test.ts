// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { MessagingChannelId, SandboxMessagingPlan } from "../messaging/manifest";
import type { RegistryMessagingAuthority } from "../messaging/plan-authority";
import {
  getMessagingProviderNamesForChannel,
  getNonInteractiveStoredMessagingChannels,
} from "./messaging-reuse";

const messagingChannels = [
  { name: "discord", envKey: "DISCORD_BOT_TOKEN" },
  { name: "slack", envKey: "SLACK_BOT_TOKEN" },
  { name: "wechat", envKey: "WECHAT_BOT_TOKEN" },
];

function authoritativeRegistry(
  channelIds: readonly MessagingChannelId[],
  disabledChannelIds: readonly MessagingChannelId[] = [],
): RegistryMessagingAuthority {
  const disabled = new Set(disabledChannelIds);
  const plan: SandboxMessagingPlan = {
    schemaVersion: 1,
    sandboxName: "assistant",
    agent: "openclaw",
    workflow: "onboard",
    channels: channelIds.map((channelId) => ({
      channelId,
      displayName: channelId,
      authMode: "token-paste",
      active: !disabled.has(channelId),
      selected: true,
      configured: true,
      disabled: disabled.has(channelId),
      inputs: [],
      hooks: [],
    })),
    disabledChannels: disabledChannelIds,
    credentialBindings: [],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };
  return { authoritative: true, plan };
}

describe("onboard messaging reuse", () => {
  it("maps one bridge provider for single-token messaging channels", () => {
    expect(getMessagingProviderNamesForChannel("assistant", "discord")).toEqual([
      "assistant-discord-bridge",
    ]);
    expect(getMessagingProviderNamesForChannel("assistant", "telegram")).toEqual([
      "assistant-telegram-bridge",
    ]);
    expect(getMessagingProviderNamesForChannel("assistant", "wechat")).toEqual([
      "assistant-wechat-bridge",
    ]);
  });

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
      () => authoritativeRegistry(["slack"]),
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
      () => authoritativeRegistry(["slack"]),
      (provider) => provider === "assistant-slack-bridge" || provider === "assistant-slack-app",
      true,
    );

    expect(reusedChannels).toEqual(["slack"]);
  });

  it("reuses a stored WeChat channel when its bridge provider exists", () => {
    const reusedChannels = getNonInteractiveStoredMessagingChannels(
      false,
      null,
      "assistant",
      messagingChannels,
      () => false,
      () => authoritativeRegistry(["wechat"]),
      (provider) => provider === "assistant-wechat-bridge",
      true,
    );

    expect(reusedChannels).toEqual(["wechat"]);
  });

  it("honors an explicit empty resume messaging channel set", () => {
    const reusedChannels = getNonInteractiveStoredMessagingChannels(
      true,
      ["unknown"],
      "assistant",
      messagingChannels,
      () => false,
      () => authoritativeRegistry(["discord"]),
      () => true,
      true,
    );

    expect(reusedChannels).toEqual([]);
  });

  it("does not rediscover token-backed channels when resume recorded none", () => {
    const reusedChannels = getNonInteractiveStoredMessagingChannels(
      true,
      [],
      "assistant",
      messagingChannels,
      () => true,
      () => authoritativeRegistry(["discord"]),
      () => true,
      true,
    );

    expect(reusedChannels).toEqual([]);
  });

  it("does not reuse messaging channels from a pending route reservation without a host token", () => {
    const getRegistryMessagingAuthority = vi.fn(
      (): RegistryMessagingAuthority => ({ authoritative: false, plan: null }),
    );
    const providerExists = vi.fn(() => true);

    const reusedChannels = getNonInteractiveStoredMessagingChannels(
      false,
      null,
      "assistant",
      messagingChannels,
      () => false,
      getRegistryMessagingAuthority,
      providerExists,
      true,
    );

    expect(reusedChannels).toBeNull();
    expect(getRegistryMessagingAuthority).toHaveBeenCalledWith("assistant");
    expect(providerExists).not.toHaveBeenCalled();
  });
});
