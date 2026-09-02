// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  openClawHasConfiguredTelegram,
  telegramRuntimeCredentialState,
  type OpenClawTelegramState,
} from "../live/channels-add-remove-helpers.ts";

const UNCONFIGURED: OpenClawTelegramState = {
  accountPresent: false,
  accountEnabled: false,
  channelEnabled: false,
  channelPresent: true,
  credentialPresent: false,
  pluginEnabled: false,
  pluginPresent: true,
};

describe("channels-add-remove Telegram configuration predicate", () => {
  it("treats bundled disabled channel and plugin entries as unconfigured (#9361)", () => {
    expect(openClawHasConfiguredTelegram(UNCONFIGURED)).toBe(false);
  });

  it.each([
    ["enabled channel without plugin activation", { channelEnabled: true }],
    ["enabled plugin without channel activation", { pluginEnabled: true }],
    ["present account without enabled flags", { accountPresent: true }],
    ["enabled account without enabled flags", { accountEnabled: true }],
    ["credential reference without enabled flags", { credentialPresent: true }],
  ])("treats %s as configured residue (#9361)", (_case, overrides) => {
    expect(openClawHasConfiguredTelegram({ ...UNCONFIGURED, ...overrides })).toBe(true);
  });

  it("does not treat physical channel absence as proof when account residue remains (#9361)", () => {
    expect(
      openClawHasConfiguredTelegram({
        ...UNCONFIGURED,
        channelPresent: false,
        accountPresent: true,
      }),
    ).toBe(true);
  });

  it.each([
    ["", "missing"],
    ["openshell:resolve:env:v42_TELEGRAM_BOT_TOKEN", "revision-scoped"],
    ["openshell:resolve:env:TELEGRAM_BOT_TOKEN", "unexpected"],
    ["openshell:resolve:env:vx_TELEGRAM_BOT_TOKEN", "unexpected"],
    ["raw-value-must-not-be-rendered", "unexpected"],
  ] as const)("classifies the redacted Telegram runtime credential state", (value, expected) => {
    expect(telegramRuntimeCredentialState(value)).toBe(expected);
  });
});
