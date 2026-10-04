// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { prepareSandboxBuildPatchConfig } from "./sandbox-build-patch-config";

describe("prepareSandboxBuildPatchConfig", () => {
  it("validates build-time messaging config without writing legacy session snapshots", () => {
    const readMessagingChannelConfigFromEnv = vi.fn(() => ({
      TELEGRAM_ALLOWED_IDS: "123,456",
      SLACK_ALLOWED_USERS: "U01ABC2DEF3",
      SLACK_ALLOWED_CHANNELS: "C012AB3CD,C987ZY6XW",
      WECHAT_ALLOWED_IDS: "wxid-unused",
    }));
    const env = {
      TELEGRAM_ALLOWED_IDS: "123,456",
      SLACK_ALLOWED_USERS: "U01ABC2DEF3",
      SLACK_ALLOWED_CHANNELS: "C012AB3CD,C987ZY6XW",
      WECHAT_ALLOWED_IDS: "wxid-unused",
    };

    const result = prepareSandboxBuildPatchConfig({
      configuredMessagingChannels: ["telegram", "slack"],
      env,
      deps: {
        readMessagingChannelConfigFromEnv,
      },
    });

    expect(readMessagingChannelConfigFromEnv).toHaveBeenCalledWith(env);
    expect(result).toEqual({
      messagingChannelConfig: {
        TELEGRAM_ALLOWED_IDS: "123,456",
        SLACK_ALLOWED_USERS: "U01ABC2DEF3",
        SLACK_ALLOWED_CHANNELS: "C012AB3CD,C987ZY6XW",
      },
    });
  });

  it("keeps messaging authorization parsing delegated to the central env reader", () => {
    expect(() =>
      prepareSandboxBuildPatchConfig({
        configuredMessagingChannels: ["telegram"],
        env: {
          TELEGRAM_ALLOWED_IDS: "123\n456",
        } as NodeJS.ProcessEnv,
      }),
    ).toThrow("Messaging channel config values must not contain line breaks.");
  });
});
