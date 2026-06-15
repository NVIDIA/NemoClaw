// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  makePlan,
  planEntry,
  slackBindings,
  slackChannel,
} from "../../../../../../test/helpers/messaging-conflict-fixtures";
import { runMessagingHookSync } from "../../../hooks";
import { MessagingHookRegistry } from "../../../hooks/registry";
import type { MessagingSerializableValue } from "../../../manifest";
import {
  createSlackSocketModeGatewayStatusHookRegistration,
  SLACK_SOCKET_MODE_GATEWAY_STATUS_HOOK_HANDLER_ID,
  SLACK_SOCKET_MODE_GATEWAY_STATUS_MESSAGE,
} from "./socket-mode-gateway-status";

const HOOK = {
  id: "slack-socket-mode-gateway-status",
  phase: "status",
  handler: SLACK_SOCKET_MODE_GATEWAY_STATUS_HOOK_HANDLER_ID,
  outputs: [{ id: "gatewayOverlaps", kind: "status" }],
} as const;

describe("slack.socketModeGatewayStatus hook", () => {
  it("reports Slack Socket Mode overlaps on the same gateway", () => {
    const alice = {
      ...planEntry(
        "alice",
        makePlan("alice", {
          channels: [slackChannel()],
          credentialBindings: slackBindings("bot-a", "app-a", "alice"),
        }),
      ),
      gatewayName: "nemoclaw",
    };
    const bob = {
      ...planEntry(
        "bob",
        makePlan("bob", {
          channels: [slackChannel()],
          credentialBindings: slackBindings("bot-b", "app-b", "bob"),
        }),
      ),
      gatewayName: "nemoclaw",
    };
    const registry = new MessagingHookRegistry([
      createSlackSocketModeGatewayStatusHookRegistration(),
    ]);

    const result = runMessagingHookSync(HOOK, registry, {
      channelId: "slack",
      inputs: { registryEntries: serialize([alice, bob]) },
    });

    expect(result.outputs.gatewayOverlaps).toEqual({
      kind: "status",
      value: {
        type: "messaging-overlaps",
        overlaps: [
          {
            channel: "slack",
            gatewayName: "nemoclaw",
            sandboxes: ["alice", "bob"],
            reason: "socket-mode-gateway",
            message: SLACK_SOCKET_MODE_GATEWAY_STATUS_MESSAGE,
          },
        ],
      },
    });
  });

  it("emits no status output when Slack sandboxes use different gateways", () => {
    const registry = new MessagingHookRegistry([
      createSlackSocketModeGatewayStatusHookRegistration({
        registryEntries: [
          {
            ...planEntry(
              "alice",
              makePlan("alice", {
                channels: [slackChannel()],
                credentialBindings: slackBindings("bot-a", "app-a", "alice"),
              }),
            ),
            gatewayName: "nemoclaw",
          },
          {
            ...planEntry(
              "bob",
              makePlan("bob", {
                channels: [slackChannel()],
                credentialBindings: slackBindings("bot-b", "app-b", "bob"),
              }),
            ),
            gatewayName: "nemoclaw-9090",
          },
        ],
      }),
    ]);

    expect(runMessagingHookSync(HOOK, registry, { channelId: "slack" }).outputs).toEqual({});
  });
});

function serialize(value: unknown): MessagingSerializableValue {
  return JSON.parse(JSON.stringify(value)) as MessagingSerializableValue;
}
