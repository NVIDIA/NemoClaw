// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  makePlan,
  planEntry,
  slackBindings,
  slackChannel,
} from "../../../../../../test/helpers/messaging-conflict-fixtures";
import type { ConflictRegistryEntry } from "../../../applier/conflict-detection/types";
import {
  MESSAGING_HOOK_CONFLICT_CODE,
  MessagingHookRegistry,
  runMessagingHook,
} from "../../../hooks";
import type { ChannelHookSpec, MessagingSerializableValue } from "../../../manifest";
import {
  createSlackSocketModeGatewayConflictHookRegistration,
  SLACK_SOCKET_MODE_GATEWAY_CONFLICT_HOOK_HANDLER_ID,
} from "./socket-mode-gateway-conflict";

const HOOK = {
  id: "slack-socket-mode-gateway-conflict",
  phase: "pre-enable",
  handler: SLACK_SOCKET_MODE_GATEWAY_CONFLICT_HOOK_HANDLER_ID,
  onFailure: "abort",
} as const satisfies ChannelHookSpec;

function slackEntry(name: string, gatewayName?: string | null): ConflictRegistryEntry {
  const entry = planEntry(
    name,
    makePlan(name, {
      channels: [slackChannel()],
      credentialBindings: slackBindings("bot", "app", name),
    }),
  );
  return gatewayName === undefined ? entry : { ...entry, gatewayName };
}

describe("slack.socketModeGatewayConflict hook", () => {
  it("passes when no active Slack sandbox shares the gateway", async () => {
    const registry = new MessagingHookRegistry([
      createSlackSocketModeGatewayConflictHookRegistration({
        currentSandbox: "bob",
        currentGatewayName: "nemoclaw",
        registryEntries: [slackEntry("alice", "nemoclaw-9090")],
      }),
    ]);

    await expect(runMessagingHook(HOOK, registry, { channelId: "slack" })).resolves.toEqual({
      hookId: "slack-socket-mode-gateway-conflict",
      handlerId: SLACK_SOCKET_MODE_GATEWAY_CONFLICT_HOOK_HANDLER_ID,
      phase: "pre-enable",
      outputs: {},
    });
  });

  it("aborts with the canonical Socket Mode gateway conflict message", async () => {
    const registry = new MessagingHookRegistry([
      createSlackSocketModeGatewayConflictHookRegistration({
        currentSandbox: "bob",
        currentGatewayName: "nemoclaw",
        registryEntries: [slackEntry("alice", "nemoclaw")],
      }),
    ]);

    await expect(runMessagingHook(HOOK, registry, { channelId: "slack" })).rejects.toThrow(
      "Slack Socket Mode is already enabled for sandbox 'alice' on this gateway; " +
        "only one sandbox can receive Slack Socket Mode events unless the gateway supports multiplexing.",
    );
    await expect(runMessagingHook(HOOK, registry, { channelId: "slack" })).rejects.toMatchObject({
      code: MESSAGING_HOOK_CONFLICT_CODE,
    });
  });

  it("accepts serialized applier inputs for registry-scoped checks", async () => {
    const registry = new MessagingHookRegistry([
      createSlackSocketModeGatewayConflictHookRegistration(),
    ]);
    const registryEntries = JSON.parse(
      JSON.stringify([slackEntry("alice", "nemoclaw")]),
    ) as MessagingSerializableValue;

    await expect(
      runMessagingHook(HOOK, registry, {
        channelId: "slack",
        inputs: {
          currentSandbox: "bob",
          currentGatewayName: "nemoclaw",
          registryEntries,
        },
      }),
    ).rejects.toThrow("Slack Socket Mode is already enabled for sandbox 'alice'");
  });

  it("treats an empty serialized registry as valid no-conflict context", async () => {
    const registry = new MessagingHookRegistry([
      createSlackSocketModeGatewayConflictHookRegistration(),
    ]);

    await expect(
      runMessagingHook(HOOK, registry, {
        channelId: "slack",
        inputs: {
          currentSandbox: "bob",
          currentGatewayName: "nemoclaw",
          registryEntries: [],
        },
      }),
    ).resolves.toEqual({
      hookId: "slack-socket-mode-gateway-conflict",
      handlerId: SLACK_SOCKET_MODE_GATEWAY_CONFLICT_HOOK_HANDLER_ID,
      phase: "pre-enable",
      outputs: {},
    });
  });

  it("requires gateway and registry context when no options are injected", async () => {
    const registry = new MessagingHookRegistry([
      createSlackSocketModeGatewayConflictHookRegistration(),
    ]);

    await expect(runMessagingHook(HOOK, registry, { channelId: "slack" })).rejects.toThrow(
      "Slack Socket Mode gateway conflict hook requires currentGatewayName and registryEntries.",
    );
  });
});
