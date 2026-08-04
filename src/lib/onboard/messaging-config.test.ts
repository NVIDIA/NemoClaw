// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SandboxMessagingPlan } from "../messaging/manifest";
import type { Session } from "../state/onboard-session";
import * as registry from "../state/registry";
import { getStoredMessagingChannelConfig } from "./messaging-config";

describe("getStoredMessagingChannelConfig", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses legacy Telegram and WeChat session fields as read-only fallback", () => {
    expect(
      getStoredMessagingChannelConfig(null, {
        telegramConfig: { requireMention: true },
        wechatConfig: {
          accountId: "wechat-account",
          baseUrl: "https://wechat.example",
          userId: "wechat-user",
        },
      } as Session),
    ).toEqual({
      TELEGRAM_REQUIRE_MENTION: "1",
      WECHAT_ACCOUNT_ID: "wechat-account",
      WECHAT_BASE_URL: "https://wechat.example",
      WECHAT_USER_ID: "wechat-user",
    });
  });

  it("prefers messaging plan config over legacy session fields", () => {
    expect(
      getStoredMessagingChannelConfig(null, {
        telegramConfig: { requireMention: true },
        messagingPlan: makePlan(),
      } as Session),
    ).toEqual({
      TELEGRAM_REQUIRE_MENTION: "0",
    });
  });

  it("does not read messaging config from a pending route reservation", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      name: "demo",
      pendingRouteReservation: true,
    });
    const getHydratedMessagingPlanFromEntry = vi
      .spyOn(registry, "getHydratedMessagingPlanFromEntry")
      .mockReturnValue(makePlan());

    expect(getStoredMessagingChannelConfig("demo", null)).toBeNull();
    expect(getHydratedMessagingPlanFromEntry).not.toHaveBeenCalled();
  });

  it("reads messaging config from a registered sandbox", () => {
    const entry = { name: "demo" };
    vi.spyOn(registry, "getSandbox").mockReturnValue(entry);
    vi.spyOn(registry, "getHydratedMessagingPlanFromEntry").mockReturnValue(makePlan());

    expect(getStoredMessagingChannelConfig("demo", null)).toEqual({
      TELEGRAM_REQUIRE_MENTION: "0",
    });
  });
});

function makePlan(): SandboxMessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName: "demo",
    agent: "openclaw",
    workflow: "onboard",
    channels: [
      {
        channelId: "telegram",
        displayName: "Telegram",
        authMode: "token-paste",
        active: true,
        selected: true,
        configured: true,
        disabled: false,
        inputs: [
          {
            channelId: "telegram",
            inputId: "requireMention",
            kind: "config",
            required: false,
            sourceEnv: "TELEGRAM_REQUIRE_MENTION",
            statePath: "telegramConfig.requireMention",
            value: "0",
          },
        ],
        hooks: [],
      },
    ],
    disabledChannels: [],
    credentialBindings: [],
    networkPolicy: {
      presets: [],
      entries: [],
    },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [
      {
        channelId: "telegram",
        kind: "rebuild-hydration",
        statePath: "telegramConfig.requireMention",
        env: "TELEGRAM_REQUIRE_MENTION",
      },
    ],
    healthChecks: [],
  };
}
