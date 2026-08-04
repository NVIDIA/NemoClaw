// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SandboxMessagingPlan } from "../messaging/manifest";
import type { Session } from "../state/onboard-session";
import * as registry from "../state/registry";
import { getStoredMessagingChannelConfig } from "./messaging-config";

describe("getStoredMessagingChannelConfig", () => {
  afterEach(() => {
    delete process.env.NEMOCLAW_MESSAGING_PLAN_B64;
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

  it("uses registry config instead of conflicting session config for a registered sandbox", () => {
    const registryPlan = makePlan("demo", "0");
    const sessionPlan = makePlan("demo", "1");

    expect(
      getStoredMessagingChannelConfig(
        "demo",
        { sandboxName: "demo", messagingPlan: sessionPlan } as Session,
        {
          readMessagingPlanFromEnv: () => null,
          getRegistryMessagingAuthority: () => ({ authoritative: true, plan: registryPlan }),
        },
      ),
    ).toEqual({
      TELEGRAM_REQUIRE_MENTION: "0",
    });
  });

  it("ignores an invalid environment plan when the registry owns the sandbox", () => {
    process.env.NEMOCLAW_MESSAGING_PLAN_B64 = "caller-plan";
    vi.spyOn(registry, "getSandbox").mockReturnValue({ name: "demo" });
    vi.spyOn(registry, "getHydratedMessagingPlanFromEntry").mockReturnValue(makePlan("demo", "0"));

    expect(getStoredMessagingChannelConfig("demo", null)).toEqual({
      TELEGRAM_REQUIRE_MENTION: "0",
    });
  });

  it("uses registry config when implicit lookup encounters an invalid environment plan", () => {
    process.env.NEMOCLAW_MESSAGING_PLAN_B64 = "caller-plan";
    vi.spyOn(registry, "getSandbox").mockReturnValue({ name: "demo" });
    vi.spyOn(registry, "getHydratedMessagingPlanFromEntry").mockReturnValue(makePlan("demo", "0"));

    expect(getStoredMessagingChannelConfig(null, { sandboxName: "demo" } as Session)).toEqual({
      TELEGRAM_REQUIRE_MENTION: "0",
    });
  });

  it("uses a valid staged target during implicit lookup", () => {
    const savedPlan = makePlan("saved", "0");
    const stagedPlan = makePlan("pending", "1");

    expect(
      getStoredMessagingChannelConfig(null, { sandboxName: "saved" } as Session, {
        readMessagingPlanFromEnv: () => stagedPlan,
        getRegistryMessagingAuthority: (name) =>
          name === "saved"
            ? { authoritative: true, plan: savedPlan }
            : { authoritative: false, plan: null },
      }),
    ).toEqual({
      TELEGRAM_REQUIRE_MENTION: "1",
    });
  });

  it("uses staged config instead of conflicting session config for a pending sandbox", () => {
    const stagedPlan = makePlan("demo", "0");
    const sessionPlan = makePlan("demo", "1");

    expect(
      getStoredMessagingChannelConfig(
        "demo",
        { sandboxName: "demo", messagingPlan: sessionPlan } as Session,
        {
          readMessagingPlanFromEnv: () => stagedPlan,
          getRegistryMessagingAuthority: () => ({ authoritative: false, plan: null }),
        },
      ),
    ).toEqual({
      TELEGRAM_REQUIRE_MENTION: "0",
    });
  });

  it("does not use legacy session fields when the registry records no messaging plan", () => {
    expect(
      getStoredMessagingChannelConfig(
        "demo",
        { sandboxName: "demo", telegramConfig: { requireMention: true } } as Session,
        {
          readMessagingPlanFromEnv: () => null,
          getRegistryMessagingAuthority: () => ({ authoritative: true, plan: null }),
        },
      ),
    ).toBeNull();
  });

  it("rejects a registry plan that targets another sandbox", () => {
    expect(() =>
      getStoredMessagingChannelConfig("demo", null, {
        readMessagingPlanFromEnv: () => null,
        getRegistryMessagingAuthority: () => ({
          authoritative: true,
          plan: makePlan("other", "0"),
        }),
      }),
    ).toThrow("Registry messaging plan targets 'other', not 'demo'.");
  });
});

function makePlan(sandboxName = "demo", requireMention = "0"): SandboxMessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName,
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
            value: requireMention,
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
