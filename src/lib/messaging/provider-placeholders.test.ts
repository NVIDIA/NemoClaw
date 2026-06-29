// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { normalizeProviderPlaceholderForEnvKey } from "./provider-placeholders";

describe("provider placeholder normalization", () => {
  it("normalizes canonical and Slack-scoped provider placeholders", () => {
    expect(
      normalizeProviderPlaceholderForEnvKey(
        "openshell:resolve:env:v51_DISCORD_BOT_TOKEN",
        "DISCORD_BOT_TOKEN",
      ),
    ).toBe("openshell:resolve:env:DISCORD_BOT_TOKEN");
    expect(
      normalizeProviderPlaceholderForEnvKey(
        "xoxb-OPENSHELL-RESOLVE-ENV-v51_SLACK_BOT_TOKEN",
        "SLACK_BOT_TOKEN",
      ),
    ).toBe("xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN");
  });

  it("rejects unknown scoped provider placeholder prefixes", () => {
    expect(
      normalizeProviderPlaceholderForEnvKey(
        "fake-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
        "SLACK_BOT_TOKEN",
      ),
    ).toBeNull();
    expect(
      normalizeProviderPlaceholderForEnvKey(
        "xoxb-OPENSHELL-RESOLVE-ENV-FAKE-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
        "SLACK_BOT_TOKEN",
      ),
    ).toBeNull();
  });

  it.each([
    "\u0000",
    "\r",
    "\n",
    "\t",
  ])("rejects provider placeholders containing control character %#", (controlCharacter) => {
    expect(
      normalizeProviderPlaceholderForEnvKey(
        `openshell:resolve:env:SLACK_BOT_TOKEN${controlCharacter}`,
        "SLACK_BOT_TOKEN",
      ),
    ).toBeNull();
    expect(
      normalizeProviderPlaceholderForEnvKey(
        `xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN${controlCharacter}`,
        "SLACK_BOT_TOKEN",
      ),
    ).toBeNull();
  });
});
