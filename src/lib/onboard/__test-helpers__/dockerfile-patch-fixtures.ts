// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxMessagingPlan } from "../../messaging/manifest";

type TestMessagingPlan = Partial<SandboxMessagingPlan>;

export function messagingChannel(
  channelId: "discord" | "telegram",
): SandboxMessagingPlan["channels"][number] {
  return {
    channelId,
    displayName: channelId === "discord" ? "Discord" : "Telegram",
    authMode: "token-paste",
    active: true,
    selected: true,
    configured: true,
    disabled: false,
    inputs: [],
    hooks: [],
  };
}

export function buildMessagingPlan(overrides: TestMessagingPlan = {}): SandboxMessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName: "my-assistant",
    agent: "openclaw",
    workflow: "onboard",
    channels: [],
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

export function setMessagingPlanEnv(overrides: TestMessagingPlan = {}): SandboxMessagingPlan {
  const plan = buildMessagingPlan(overrides);
  process.env.NEMOCLAW_MESSAGING_PLAN_B64 = Buffer.from(JSON.stringify(plan), "utf8").toString(
    "base64",
  );
  return plan;
}
