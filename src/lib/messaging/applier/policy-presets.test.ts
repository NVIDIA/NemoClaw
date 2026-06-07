// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  ALL_MESSAGING_POLICY_PRESET_NAMES,
  pruneDisabledMessagingPolicyPresets,
} from "./policy-presets";

describe("pruneDisabledMessagingPolicyPresets", () => {
  it("removes policy presets for disabled messaging channels", () => {
    expect(pruneDisabledMessagingPolicyPresets(["npm", "slack", "pypi"], [" Slack "])).toEqual([
      "npm",
      "pypi",
    ]);
  });

  it("preserves non-required policy presets when a same-named channel is disabled", () => {
    expect(
      pruneDisabledMessagingPolicyPresets(["telegram", "npm", "pypi"], ["telegram"]),
    ).toEqual(["telegram", "npm", "pypi"]);
  });

  it("returns the original list unchanged when no channels are disabled", () => {
    expect(pruneDisabledMessagingPolicyPresets(["npm", "slack"], null)).toEqual(["npm", "slack"]);
  });
});

describe("ALL_MESSAGING_POLICY_PRESET_NAMES", () => {
  it("includes the slack preset", () => {
    expect(ALL_MESSAGING_POLICY_PRESET_NAMES.has("slack")).toBe(true);
  });

  it("does not include non-messaging presets", () => {
    expect(ALL_MESSAGING_POLICY_PRESET_NAMES.has("npm")).toBe(false);
    expect(ALL_MESSAGING_POLICY_PRESET_NAMES.has("pypi")).toBe(false);
    expect(ALL_MESSAGING_POLICY_PRESET_NAMES.has("telegram")).toBe(false);
  });
});
