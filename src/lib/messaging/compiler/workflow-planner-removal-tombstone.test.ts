// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { SandboxMessagingPlan } from "../manifest";
import {
  compactSandboxMessagingPlanForPersistence,
  normalizePersistedSandboxMessagingPlanShape,
} from "../persistence";
import {
  markPlanChannelPendingRemoval,
  retirePendingRemovalMessagingPlanChannels,
} from "./workflow-planner";

function existingPlan(): SandboxMessagingPlan {
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
    credentialBindings: [
      {
        channelId: "telegram",
        credentialId: "telegramBotToken",
        sourceInput: "botToken",
        providerName: "demo-telegram-bridge",
        providerEnvKey: "TELEGRAM_BOT_TOKEN",
        placeholder: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
        credentialAvailable: true,
      },
    ],
    networkPolicy: {
      presets: ["telegram"],
      entries: [
        {
          channelId: "telegram",
          presetName: "telegram",
          policyKeys: ["telegram_bot"],
          source: "manifest",
        },
      ],
    },
    agentRender: [
      {
        agent: "openclaw",
        channelId: "telegram",
        kind: "json-fragment",
        target: "~/.openclaw/openclaw.json",
        path: "channels.telegram",
        value: { enabled: true },
        templateRefs: [],
      },
      {
        agent: "openclaw",
        channelId: "slack",
        kind: "json-fragment",
        target: "~/.openclaw/openclaw.json",
        path: "channels.slack",
        value: { enabled: true },
        templateRefs: [],
      },
    ],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };
}

describe("messaging channel removal tombstone", () => {
  it("retains exact config removal through rebuild and retires only the marked channel", () => {
    const tombstone = markPlanChannelPendingRemoval(existingPlan(), "telegram");

    expect(tombstone.workflow).toBe("remove-channel");
    expect(tombstone.channels.find((channel) => channel.channelId === "telegram")).toMatchObject({
      active: false,
      selected: false,
      configured: false,
      disabled: true,
      pendingRemoval: true,
    });
    expect(tombstone.disabledChannels).toContain("telegram");
    expect(tombstone.agentRender.some((entry) => entry.channelId === "telegram")).toBe(true);
    expect(tombstone.credentialBindings.some((entry) => entry.channelId === "telegram")).toBe(
      false,
    );
    expect(tombstone.networkPolicy.entries.some((entry) => entry.channelId === "telegram")).toBe(
      false,
    );
    const persisted = compactSandboxMessagingPlanForPersistence(tombstone);
    expect(persisted.channels.find((channel) => channel.channelId === "telegram")).toMatchObject({
      pendingRemoval: true,
    });
    expect(
      normalizePersistedSandboxMessagingPlanShape(
        persisted as unknown as Parameters<typeof normalizePersistedSandboxMessagingPlanShape>[0],
      ).channels.find((channel) => channel.channelId === "telegram"),
    ).toMatchObject({ pendingRemoval: true });

    const retired = retirePendingRemovalMessagingPlanChannels({
      ...tombstone,
      channels: [
        ...tombstone.channels,
        {
          channelId: "skipped",
          displayName: "Skipped",
          authMode: "token-paste",
          active: false,
          selected: true,
          configured: false,
          disabled: true,
          inputs: [],
          hooks: [],
        },
      ],
    });
    expect(retired.channels.map((channel) => channel.channelId)).toEqual(["slack", "skipped"]);
    expect(retired.disabledChannels).not.toContain("telegram");
    expect(retired.agentRender.some((entry) => entry.channelId === "telegram")).toBe(false);
  });
});
