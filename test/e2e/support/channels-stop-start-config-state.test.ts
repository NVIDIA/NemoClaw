// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  type OpenClawChannelConfigState,
  openClawChannelIsActive,
  openClawChannelIsInert,
} from "../live/channels-stop-start-config-state.ts";

const ABSENT: OpenClawChannelConfigState = {
  channelPresent: false,
  channelEnabled: false,
  channelDisabled: false,
  channelHasSettings: false,
  pluginPresent: false,
  pluginEnabled: false,
  pluginDisabled: false,
  pluginHasSettings: false,
};

const MANAGED_IMAGE_DISABLED: OpenClawChannelConfigState = {
  ...ABSENT,
  channelPresent: true,
  channelDisabled: true,
  pluginPresent: true,
  pluginDisabled: true,
};

describe("channels stop/start OpenClaw configuration state", () => {
  it.each([
    ["missing entries", ABSENT],
    ["managed-image disabled entries", MANAGED_IMAGE_DISABLED],
  ])("treats %s as inert (#9820)", (_case, state) => {
    expect(openClawChannelIsInert(state)).toBe(true);
    expect(openClawChannelIsActive(state)).toBe(false);
  });

  it("treats an enabled channel and plugin as active (#9820)", () => {
    const state = {
      ...MANAGED_IMAGE_DISABLED,
      channelEnabled: true,
      channelDisabled: false,
      channelHasSettings: true,
      pluginEnabled: true,
      pluginDisabled: false,
    };

    expect(openClawChannelIsActive(state)).toBe(true);
    expect(openClawChannelIsInert(state)).toBe(false);
  });

  it.each([
    ["channel", { channelEnabled: true, channelDisabled: false }],
    ["plugin", { pluginEnabled: true, pluginDisabled: false }],
  ])("rejects one-sided %s activation as active or inert (#9820)", (_case, overrides) => {
    const state = { ...MANAGED_IMAGE_DISABLED, ...overrides };

    expect(openClawChannelIsActive(state)).toBe(false);
    expect(openClawChannelIsInert(state)).toBe(false);
  });

  it.each([
    ["channel", { channelHasSettings: true }],
    ["plugin", { pluginHasSettings: true }],
  ])("rejects disabled %s settings as inert (#9820)", (_case, overrides) => {
    const state = { ...MANAGED_IMAGE_DISABLED, ...overrides };

    expect(openClawChannelIsActive(state)).toBe(false);
    expect(openClawChannelIsInert(state)).toBe(false);
  });

  it.each([
    ["channel", { channelDisabled: false }],
    ["plugin", { pluginDisabled: false }],
  ])(
    "rejects a present %s entry without an explicit state as inert (#9820)",
    (_case, overrides) => {
      const state = { ...MANAGED_IMAGE_DISABLED, ...overrides };

      expect(openClawChannelIsActive(state)).toBe(false);
      expect(openClawChannelIsInert(state)).toBe(false);
    },
  );
});
