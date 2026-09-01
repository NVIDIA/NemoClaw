// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  allMessagingChannelPolicyPresets,
  hasDisabledMessagingPolicyPreset,
  mergeAppliedPolicyPresetsForDisabledMessagingCleanup,
  mergeEnabledMessagingChannelPolicyPresets,
  mergePolicyMessagingChannels,
  messagingChannelsForPolicyPresets,
  pruneDisabledMessagingPolicyPresets,
  requiredMessagingChannelPolicyPresets,
} from "./messaging-policy-presets";

describe("messaging policy presets", () => {
  it("maps create-time messaging channels to their network policy presets", () => {
    expect(requiredMessagingChannelPolicyPresets(["slack"])).toEqual(["slack"]);
    expect(requiredMessagingChannelPolicyPresets([" Slack "])).toEqual(["slack"]);
    expect(requiredMessagingChannelPolicyPresets(["discord"])).toEqual(["discord"]);
    expect(requiredMessagingChannelPolicyPresets(["wechat"])).toEqual(["wechat"]);
  });

  it("names the channel behind an applied network policy preset (#9283)", () => {
    expect(messagingChannelsForPolicyPresets(["npm", "pypi", "discord"])).toEqual(["discord"]);
    expect(messagingChannelsForPolicyPresets([" Slack "])).toEqual(["slack"]);
    expect(messagingChannelsForPolicyPresets(["npm", "pypi"])).toEqual([]);
    expect(messagingChannelsForPolicyPresets([])).toEqual([]);
    expect(messagingChannelsForPolicyPresets(null)).toEqual([]);
  });

  it("merges required messaging presets into an existing selection", () => {
    expect(mergeEnabledMessagingChannelPolicyPresets(["npm", "pypi"], ["slack"])).toEqual([
      "npm",
      "pypi",
      "slack",
    ]);
  });

  // #5967: channels not flagged requiredAtCreate (WhatsApp and
  // Google Chat) still need their egress preset merged so policy finalization
  // persists it and policy-list marks it applied. Discord, Slack, Teams, Telegram,
  // and WeChat bind credentials, so they are create-time required instead.
  it("merges an enabled channel preset that is not required at create time", () => {
    expect(mergeEnabledMessagingChannelPolicyPresets(["npm"], ["whatsapp"])).toEqual([
      "npm",
      "whatsapp",
    ]);
    expect(requiredMessagingChannelPolicyPresets(["whatsapp"])).toEqual([]);
    expect(mergeEnabledMessagingChannelPolicyPresets(["npm"], ["slack", "whatsapp"])).toEqual([
      "npm",
      "slack",
      "whatsapp",
    ]);
  });

  it("does not add a channel preset that is not available to the sandbox", () => {
    expect(mergeEnabledMessagingChannelPolicyPresets(["npm"], ["slack"], new Set(["npm"]))).toEqual(
      ["npm"],
    );
    expect(
      mergeEnabledMessagingChannelPolicyPresets(["npm"], ["discord"], new Set(["npm"])),
    ).toEqual(["npm"]);
  });

  it("merges policy channels while excluding disabled channels", () => {
    expect(
      mergePolicyMessagingChannels(
        ["slack", "telegram"],
        [" Slack "],
        ["discord", "slack"],
        ["slack"],
      ),
    ).toEqual(["telegram", "discord"]);
  });

  it("removes policy presets for disabled messaging channels", () => {
    expect(pruneDisabledMessagingPolicyPresets(["npm", "slack", "pypi"], [" Slack "])).toEqual([
      "npm",
      "pypi",
    ]);
  });

  it("maps every channel that has a policy preset to its preset for cleanup", () => {
    expect(allMessagingChannelPolicyPresets(["teams"])).toEqual(["teams"]);
    expect(allMessagingChannelPolicyPresets([" Teams "])).toEqual(["teams"]);
    expect(allMessagingChannelPolicyPresets(["telegram"])).toEqual(["telegram"]);
  });

  it("removes the Teams preset when the Teams channel is disabled", () => {
    expect(pruneDisabledMessagingPolicyPresets(["npm", "teams", "pypi"], ["teams"])).toEqual([
      "npm",
      "pypi",
    ]);
  });

  it("removes optional channel presets when their channel is disabled", () => {
    expect(pruneDisabledMessagingPolicyPresets(["telegram", "npm", "pypi"], ["telegram"])).toEqual([
      "npm",
      "pypi",
    ]);
  });

  it("detects applied policy presets for disabled messaging channels", () => {
    expect(hasDisabledMessagingPolicyPreset(["npm", "slack", "pypi"], ["slack"])).toBe(true);
    expect(hasDisabledMessagingPolicyPreset(["telegram", "npm"], ["telegram"])).toBe(true);
    expect(hasDisabledMessagingPolicyPreset(["npm", "pypi"], ["slack"])).toBe(false);
  });

  it("preserves unrelated applied presets when cleaning disabled messaging presets", () => {
    expect(
      mergeAppliedPolicyPresetsForDisabledMessagingCleanup(
        ["npm"],
        ["npm", "github", "slack"],
        ["slack"],
      ),
    ).toEqual(["npm", "github"]);
    expect(
      mergeAppliedPolicyPresetsForDisabledMessagingCleanup(["npm"], ["npm", "github"], ["slack"]),
    ).toEqual(["npm"]);
  });

  // #5967 is channel-agnostic: every enabled channel must merge its preset, and every disabled
  // channel must prune it. Cover the remaining channels explicitly so a future channel-table
  // regression cannot pass on Slack and Discord alone.
  it("merges Telegram, Teams, WhatsApp, WeChat, and Google Chat presets (#5967)", () => {
    expect(mergeEnabledMessagingChannelPolicyPresets(["npm"], ["telegram"])).toEqual([
      "npm",
      "telegram",
    ]);
    expect(mergeEnabledMessagingChannelPolicyPresets(["npm"], ["teams"])).toEqual(["npm", "teams"]);
    expect(mergeEnabledMessagingChannelPolicyPresets(["npm"], ["whatsapp"])).toEqual([
      "npm",
      "whatsapp",
    ]);
    expect(mergeEnabledMessagingChannelPolicyPresets(["npm"], ["wechat"])).toEqual([
      "npm",
      "wechat",
    ]);
    expect(mergeEnabledMessagingChannelPolicyPresets(["npm"], ["googlechat"])).toEqual([
      "npm",
      "googlechat",
    ]);
  });

  it("prunes WhatsApp, WeChat, and Google Chat presets when disabled (#5967)", () => {
    expect(pruneDisabledMessagingPolicyPresets(["npm", "whatsapp"], ["whatsapp"])).toEqual(["npm"]);
    expect(pruneDisabledMessagingPolicyPresets(["npm", "wechat"], ["wechat"])).toEqual(["npm"]);
    expect(pruneDisabledMessagingPolicyPresets(["npm", "googlechat"], ["googlechat"])).toEqual([
      "npm",
    ]);
  });

  it("leaves the selection untouched when no channels are enabled (#5967)", () => {
    expect(mergeEnabledMessagingChannelPolicyPresets(["npm"], [])).toEqual(["npm"]);
    expect(mergeEnabledMessagingChannelPolicyPresets(["npm"], null)).toEqual(["npm"]);
    expect(mergeEnabledMessagingChannelPolicyPresets(["npm"], undefined)).toEqual(["npm"]);
  });

  it("yields no preset for an unknown channel name (#5967)", () => {
    expect(allMessagingChannelPolicyPresets(["nonexistent"])).toEqual([]);
    expect(mergeEnabledMessagingChannelPolicyPresets(["npm"], ["nonexistent"])).toEqual(["npm"]);
  });
});
