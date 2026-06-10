// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
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

  it("does not add a required preset that is not available to the sandbox", () => {
    expect(
      mergeRequiredMessagingChannelPolicyPresets(["npm"], ["slack"], new Set(["npm"])),
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

  it("preserves non-required policy presets when a same-named channel is disabled", () => {
    expect(pruneDisabledMessagingPolicyPresets(["telegram", "npm", "pypi"], ["telegram"])).toEqual([
      "telegram",
      "npm",
      "pypi",
    ]);
  });

  it("detects applied policy presets for disabled messaging channels", () => {
    expect(hasDisabledMessagingPolicyPreset(["npm", "slack", "pypi"], ["slack"])).toBe(true);
    expect(hasDisabledMessagingPolicyPreset(["telegram", "npm"], ["telegram"])).toBe(false);
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
