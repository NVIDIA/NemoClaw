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

  it("detects an enabled channel and plugin as configured (#9361)", () => {
    expect(
      openClawHasConfiguredTelegram({
        ...UNCONFIGURED,
        channelEnabled: true,
        pluginEnabled: true,
      }),
    ).toBe(true);
  });

  it.each([
    ["enabled channel without plugin activation", { channelEnabled: true }],
    ["enabled plugin without channel activation", { pluginEnabled: true }],
  ])("treats %s as unconfigured (#9361)", (_case, overrides) => {
    expect(openClawHasConfiguredTelegram({ ...UNCONFIGURED, ...overrides })).toBe(false);
  });

  it("treats a removed channel with a bundled enabled plugin as unconfigured (#9361)", () => {
    expect(
      openClawHasConfiguredTelegram({
        ...UNCONFIGURED,
        channelPresent: false,
        pluginEnabled: true,
      }),
    ).toBe(false);
  });
});
