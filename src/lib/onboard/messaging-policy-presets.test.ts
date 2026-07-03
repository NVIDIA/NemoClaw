// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  allMessagingChannelPolicyPresets,
  hasDisabledMessagingPolicyPreset,
  mergeAppliedPolicyPresetsForDisabledMessagingCleanup,
  mergeEnabledMessagingChannelPolicyPresets,
  mergePolicyMessagingChannels,
  mergeRebuildMessagingPolicyPresets,
  pruneDisabledMessagingPolicyPresets,
  requiredMessagingChannelPolicyPresets,
} from "./messaging-policy-presets";

describe("messaging policy presets", () => {
  it("maps Slack messaging to the Slack network policy preset", () => {
    expect(requiredMessagingChannelPolicyPresets(["slack"])).toEqual(["slack"]);
    expect(requiredMessagingChannelPolicyPresets([" Slack "])).toEqual(["slack"]);
  });

  it("merges required messaging presets into an existing selection", () => {
    expect(mergeEnabledMessagingChannelPolicyPresets(["npm", "pypi"], ["slack"])).toEqual([
      "npm",
      "pypi",
      "slack",
    ]);
  });

  // #5967: a channel that is not flagged requiredAtCreate (Discord, Telegram,
  // WhatsApp, Teams, WeChat) still needs its egress preset merged so policy
  // finalization persists it and policy-list marks it applied.
  it("merges an enabled channel preset that is not required at create time", () => {
    expect(mergeEnabledMessagingChannelPolicyPresets(["npm"], ["discord"])).toEqual([
      "npm",
      "discord",
    ]);
    expect(requiredMessagingChannelPolicyPresets(["discord"])).toEqual([]);
    expect(mergeEnabledMessagingChannelPolicyPresets(["npm"], ["slack", "discord"])).toEqual([
      "npm",
      "slack",
      "discord",
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

  it("recovers presets for enabled channels absent from sb.policies after a prior stop+rebuild (#5596)", () => {
    const enabledChannels = ["telegram", "discord", "whatsapp", "wechat", "slack"];
    expect(
      mergeRebuildMessagingPolicyPresets(["npm", "npm", "telegram"], ["pypi"], enabledChannels, [
        "telegram",
        "wechat",
      ]),
    ).toEqual(["npm", "discord", "whatsapp", "slack"]);
    expect(
      mergeRebuildMessagingPolicyPresets(undefined, ["pypi"], enabledChannels, ["wechat"]),
    ).toEqual(["pypi", "telegram", "discord", "whatsapp", "slack"]);
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

  // #5967 is channel-agnostic: every non-`requiredAtCreate` channel (Telegram,
  // Teams, WhatsApp, WeChat) must merge and prune exactly like Discord. Cover the
  // remaining channels explicitly so a future channel-table regression cannot pass
  // on Slack/Discord alone.
  it("merges every enabled non-required channel preset, not just Slack and Discord (#5967)", () => {
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
  });

  it("prunes every disabled non-required channel preset (#5967)", () => {
    expect(pruneDisabledMessagingPolicyPresets(["npm", "whatsapp"], ["whatsapp"])).toEqual(["npm"]);
    expect(pruneDisabledMessagingPolicyPresets(["npm", "wechat"], ["wechat"])).toEqual(["npm"]);
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

  // Drift guard (#5967): the suggestion path's `add(channel)` shortcut was
  // removed in favor of resolving presets through the channel→preset registry,
  // and several call sites assume a channel's egress preset shares its name.
  // Pin that 1:1 mapping for every shipped channel so a future preset rename
  // (which would silently desync suggestions from finalization) fails here.
  it("maps each messaging channel to a same-named egress preset (#5967)", () => {
    for (const channel of ["slack", "discord", "telegram", "teams", "whatsapp", "wechat"]) {
      expect(allMessagingChannelPolicyPresets([channel])).toEqual([channel]);
    }
  });
});
