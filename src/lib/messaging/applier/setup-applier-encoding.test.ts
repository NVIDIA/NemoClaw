// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { SandboxMessagingPlan } from "../manifest";
import { MessagingSetupApplier } from "./setup-applier";

const PLAN = {
  schemaVersion: 1,
  sandboxName: "cache-identity",
  agent: "hermes",
  workflow: "rebuild",
  channels: [
    {
      channelId: "telegram",
      displayName: "Telegram",
      authMode: "token-paste",
      active: true,
      selected: true,
      configured: true,
      disabled: false,
      inputs: [],
      hooks: [],
    },
    {
      channelId: "slack",
      displayName: "Slack",
      authMode: "token-paste",
      active: true,
      selected: true,
      configured: true,
      disabled: false,
      inputs: [],
      hooks: [],
    },
  ],
  disabledChannels: [],
  credentialBindings: [],
  networkPolicy: {
    presets: ["telegram", "slack"],
    entries: [],
  },
  agentRender: [],
  buildSteps: [],
  runtimeSetup: {
    nodePreloads: [],
    envAliases: [],
    secretScans: [],
  },
  stateUpdates: [],
  healthChecks: [],
} satisfies SandboxMessagingPlan;

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => reverseObjectKeys(item));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .reverse()
      .map(([key, item]) => [key, reverseObjectKeys(item)]),
  );
}

describe("MessagingSetupApplier plan encoding", () => {
  it("uses one image-cache identity across object insertion orders (#7144)", () => {
    const reordered = reverseObjectKeys(PLAN) as SandboxMessagingPlan;
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(PLAN));

    const encoded = MessagingSetupApplier.encodePlan(PLAN);
    expect(MessagingSetupApplier.encodePlan(reordered)).toBe(encoded);
    expect(MessagingSetupApplier.decodePlan(encoded)).toEqual(PLAN);
  });

  it("preserves semantically significant array order", () => {
    const reorderedChannels = {
      ...PLAN,
      channels: [...PLAN.channels].reverse(),
    } satisfies SandboxMessagingPlan;

    expect(MessagingSetupApplier.encodePlan(reorderedChannels)).not.toBe(
      MessagingSetupApplier.encodePlan(PLAN),
    );
  });
});
