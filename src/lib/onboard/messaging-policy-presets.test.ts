// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  allMessagingChannelPolicyPresets,
  hasDisabledMessagingPolicyPreset,
  mergeAppliedPolicyPresetsForDisabledMessagingCleanup,
  mergePolicyMessagingChannels,
  mergeRequiredMessagingChannelPolicyPresets,
  pruneDisabledMessagingPolicyPresets,
  requiredMessagingChannelPolicyPresets,
} from "./messaging-policy-presets";

describe("messaging policy presets", () => {
  it("maps Slack messaging to the Slack network policy preset", () => {
    expect(requiredMessagingChannelPolicyPresets(["slack"])).toEqual(["slack"]);
    expect(requiredMessagingChannelPolicyPresets([" Slack "])).toEqual(["slack"]);
  });

  it("merges required messaging presets into an existing selection", () => {
    expect(mergeRequiredMessagingChannelPolicyPresets(["npm", "pypi"], ["slack"])).toEqual([
      "npm",
      "pypi",
      "slack",
    ]);
  });

  // #5967: a channel that is not flagged requiredAtCreate (Discord, Telegram,
  // WhatsApp, Teams, WeChat) still needs its egress preset merged so policy
  // finalization persists it and policy-list marks it applied.
  it("merges an enabled channel preset that is not required at create time", () => {
    expect(mergeRequiredMessagingChannelPolicyPresets(["npm"], ["discord"])).toEqual([
      "npm",
      "discord",
    ]);
    expect(requiredMessagingChannelPolicyPresets(["discord"])).toEqual([]);
    expect(mergeRequiredMessagingChannelPolicyPresets(["npm"], ["slack", "discord"])).toEqual([
      "npm",
      "slack",
      "discord",
    ]);
  });

  it("does not add a channel preset that is not available to the sandbox", () => {
    expect(
      mergeRequiredMessagingChannelPolicyPresets(["npm"], ["slack"], new Set(["npm"])),
    ).toEqual(["npm"]);
    expect(
      mergeRequiredMessagingChannelPolicyPresets(["npm"], ["discord"], new Set(["npm"])),
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
});
