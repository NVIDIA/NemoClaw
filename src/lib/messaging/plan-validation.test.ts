// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { SandboxMessagingPlan } from "./manifest";
import {
  getActiveChannelIdsFromPlan,
  getConfiguredChannelIdsFromPlan,
  getDisabledChannelIdsFromPlan,
  getMessagingChannelConfigFromPlan,
  parseSandboxMessagingPlan,
} from "./plan-validation";

function makePlan(overrides: Partial<SandboxMessagingPlan> = {}): SandboxMessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName: "sb",
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
            inputId: "allowedIds",
            kind: "config",
            required: false,
            sourceEnv: "TELEGRAM_ALLOWED_IDS",
            value: "123",
          },
        ],
        hooks: [],
      },
    ],
    disabledChannels: [],
    credentialBindings: [],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
    ...overrides,
  };
}

describe("parseSandboxMessagingPlan", () => {
  it("returns a cloned plan when the schema and optional selectors match", () => {
    const source = makePlan();
    const parsed = parseSandboxMessagingPlan(source, {
      sandboxName: "sb",
      agent: "openclaw",
      supportedChannelIds: ["telegram"],
    });

    expect(parsed).toEqual(source);
    expect(parsed).not.toBe(source);
  });

  it("rejects mismatched selectors, duplicate channels, and unsupported channels", () => {
    expect(parseSandboxMessagingPlan(makePlan(), { sandboxName: "other" })).toBeNull();
    expect(parseSandboxMessagingPlan(makePlan(), { agent: "hermes" })).toBeNull();
    expect(parseSandboxMessagingPlan(makePlan(), { supportedChannelIds: ["discord"] })).toBeNull();
    expect(
      parseSandboxMessagingPlan(
        makePlan({ channels: [makePlan().channels[0], makePlan().channels[0]] }),
      ),
    ).toBeNull();
  });

  it("rejects malformed channel arrays without throwing", () => {
    const plan = makePlan() as unknown as { channels: unknown[] };
    plan.channels = [null];

    expect(parseSandboxMessagingPlan(plan)).toBeNull();
  });
});

describe("plan channel derivation", () => {
  it("derives configured, active, disabled, and config values from a plan", () => {
    const plan = makePlan({
      disabledChannels: ["telegram"],
      channels: [{ ...makePlan().channels[0], disabled: true, active: false }],
    });

    expect(getConfiguredChannelIdsFromPlan(plan)).toEqual(["telegram"]);
    expect(getActiveChannelIdsFromPlan(plan)).toEqual([]);
    expect(getDisabledChannelIdsFromPlan(plan)).toEqual(["telegram"]);
    expect(getMessagingChannelConfigFromPlan(plan)).toEqual({ TELEGRAM_ALLOWED_IDS: "123" });
  });
});
