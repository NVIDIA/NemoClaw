// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  channelPlanStateErrors,
  type ChannelPlanExpectedState,
} from "../live/channels-stop-start-plan-state.ts";
import type { AgentKind } from "../live/phase6-messaging-helpers.ts";

const SANDBOX_NAME = "e2e-channel-cycle";
const CHANNEL_ID = "slack";

function plan(agent: AgentKind, state: ChannelPlanExpectedState): Record<string, unknown> {
  const present = state !== "removed";
  return {
    schemaVersion: 1,
    sandboxName: SANDBOX_NAME,
    agent,
    workflow:
      state === "active"
        ? "start-channel"
        : state === "disabled"
          ? "stop-channel"
          : "remove-channel",
    channels: present
      ? [
          {
            channelId: CHANNEL_ID,
            displayName: "Slack",
            authMode: "token-paste",
            active: state === "active",
            selected: true,
            configured: true,
            disabled: state === "disabled",
            inputs: [],
          },
        ]
      : [],
    disabledChannels: state === "disabled" ? [CHANNEL_ID] : [],
    networkPolicy: {
      presets: present ? [CHANNEL_ID] : [],
      entries: present
        ? [
            {
              channelId: CHANNEL_ID,
              presetName: CHANNEL_ID,
              policyKeys: [CHANNEL_ID],
              source: "manifest",
            },
          ]
        : [],
    },
    credentialBindings: present
      ? [
          {
            channelId: CHANNEL_ID,
            credentialId: "slackBotToken",
            sourceInput: "botToken",
            providerName: `${SANDBOX_NAME}-slack-bridge`,
            providerEnvKey: "SLACK_BOT_TOKEN",
            placeholder: "openshell:resolve:env:SLACK_BOT_TOKEN",
            credentialAvailable: true,
          },
        ]
      : [],
  };
}

function errors(
  value: unknown,
  agent: AgentKind = "openclaw",
  expected: ChannelPlanExpectedState = "active",
): string[] {
  return channelPlanStateErrors(value, {
    agent,
    channelId: CHANNEL_ID,
    credentialBindingRequired: true,
    expected,
    sandboxName: SANDBOX_NAME,
  });
}

describe("channels stop/start persisted messaging plan state", () => {
  it.each(["openclaw", "hermes"] as const)(
    "accepts the complete %s active, disabled, and removed states",
    (agent) => {
      expect(errors(plan(agent, "active"), agent, "active")).toEqual([]);
      expect(errors(plan(agent, "disabled"), agent, "disabled")).toEqual([]);
      expect(errors(plan(agent, "removed"), agent, "removed")).toEqual([]);
    },
  );

  it("rejects disabled state that is missing the disabled-channel index", () => {
    const value = plan("openclaw", "disabled");
    value.disabledChannels = [];

    expect(errors(value, "openclaw", "disabled")).toEqual([
      "messaging.plan must be a valid persisted plan for e2e-channel-cycle using openclaw",
    ]);
  });

  it("rejects a required credential binding that disappeared", () => {
    const value = plan("hermes", "active");
    value.credentialBindings = [];

    expect(errors(value, "hermes", "active")).toContain("slack credential binding must be present");
  });

  it("rejects policy and credential residue after removal", () => {
    const value = plan("openclaw", "removed");
    value.networkPolicy = { presets: [CHANNEL_ID], entries: [{ channelId: CHANNEL_ID }] };
    value.credentialBindings = [{ channelId: CHANNEL_ID }];

    expect(errors(value, "openclaw", "removed")).toEqual([
      "slack policy preset must be removed",
      "slack policy entry must be removed",
      "slack credential binding must be removed",
    ]);
  });

  it("rejects runtime render and hook fields persisted into the plan", () => {
    const value = plan("hermes", "active");
    value.agentRender = [
      {
        channelId: CHANNEL_ID,
        agent: "hermes",
        target: "config.yaml",
        kind: "json-fragment",
        path: "platforms.slack",
        value: { enabled: true },
        templateRefs: [],
      },
    ];
    value.channels = (value.channels as Record<string, unknown>[]).map((channel) => ({
      ...channel,
      hooks: [],
    }));

    expect(errors(value, "hermes", "active")).toEqual([
      "messaging.plan.agentRender must not persist",
      "messaging.plan channel hooks must not persist",
    ]);
  });
});
