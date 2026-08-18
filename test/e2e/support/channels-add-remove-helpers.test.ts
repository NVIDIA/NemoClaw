// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  openClawHasConfiguredTelegram,
  type OpenClawTelegramState,
} from "../live/channels-add-remove-helpers.ts";

const UNCONFIGURED: OpenClawTelegramState = {
  accountEnabled: false,
  channelEnabled: false,
  channelPresent: true,
  pluginEnabled: false,
  pluginPresent: true,
};

describe("channels-add-remove Telegram configuration predicate", () => {
  it("treats bundled disabled channel and plugin entries as unconfigured (#9361)", () => {
    expect(openClawHasConfiguredTelegram(UNCONFIGURED)).toBe(false);
  });

  it.each([
    ["enabled channel", { channelEnabled: true }],
    ["enabled plugin", { pluginEnabled: true }],
  ])("detects an %s as configured (#9361)", (_case, overrides) => {
    expect(openClawHasConfiguredTelegram({ ...UNCONFIGURED, ...overrides })).toBe(true);
  });

  it("treats removed channel and plugin entries as unconfigured (#9361)", () => {
    expect(
      openClawHasConfiguredTelegram({
        ...UNCONFIGURED,
        channelPresent: false,
        pluginPresent: false,
      }),
    ).toBe(false);
  });
});
