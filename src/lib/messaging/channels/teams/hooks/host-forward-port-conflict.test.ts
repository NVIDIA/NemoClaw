// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { makePlan, planEntry } from "../../../../../../test/helpers/messaging-conflict-fixtures";
import {
  MESSAGING_HOOK_CONFLICT_CODE,
  MessagingHookRegistry,
  runMessagingHook,
} from "../../../hooks";
import type {
  ChannelHookSpec,
  MessagingSerializableValue,
  SandboxMessagingChannelPlan,
} from "../../../manifest";
import {
  createTeamsHostForwardPortConflictHookRegistration,
  createTeamsHostForwardPortStatusHookRegistration,
  TEAMS_HOST_FORWARD_PORT_CONFLICT_HOOK_HANDLER_ID,
  TEAMS_HOST_FORWARD_PORT_STATUS_HOOK_HANDLER_ID,
  TEAMS_HOST_FORWARD_PORT_STATUS_MESSAGE,
} from "./host-forward-port-conflict";

const HOOK = {
  id: "teams-host-forward-port-conflict",
  phase: "pre-enable",
  handler: TEAMS_HOST_FORWARD_PORT_CONFLICT_HOOK_HANDLER_ID,
  inputs: ["webhookPort"],
  onFailure: "abort",
} as const satisfies ChannelHookSpec;
const STATUS_HOOK = {
  id: "teams-host-forward-port-status",
  phase: "status",
  handler: TEAMS_HOST_FORWARD_PORT_STATUS_HOOK_HANDLER_ID,
  outputs: [{ id: "hostForwardPortOverlaps", kind: "status" }],
} as const satisfies ChannelHookSpec;

function teamsChannel(port: number, active = true, disabled = false): SandboxMessagingChannelPlan {
  return {
    channelId: "teams",
    displayName: "Microsoft Teams",
    authMode: "token-paste",
    active,
    selected: true,
    configured: true,
    disabled,
    inputs: [
      {
        channelId: "teams",
        inputId: "webhookPort",
        kind: "config",
        required: false,
        sourceEnv: "MSTEAMS_PORT",
        statePath: "teamsConfig.webhookPort",
        value: String(port),
      },
    ],
    hostForward: {
      channelId: "teams",
      port,
      label: "Microsoft Teams webhook",
    },
    hooks: [],
  };
}

function teamsEntry(name: string, port: number, active = true, disabled = false) {
  return planEntry(
    name,
    makePlan(name, {
      channels: [teamsChannel(port, active, disabled)],
      disabledChannels: disabled ? ["teams"] : [],
    }),
  );
}

describe("teams.hostForwardPortConflict hook", () => {
  it("passes when no active sandbox uses the requested webhook port", async () => {
    const registry = new MessagingHookRegistry([
      createTeamsHostForwardPortConflictHookRegistration({
        currentSandbox: "bob",
        registryEntries: [teamsEntry("alice", 3977)],
      }),
    ]);

    await expect(
      runMessagingHook(HOOK, registry, {
        channelId: "teams",
        inputs: {
          webhookPort: "3978",
        },
      }),
    ).resolves.toEqual({
      hookId: "teams-host-forward-port-conflict",
      handlerId: TEAMS_HOST_FORWARD_PORT_CONFLICT_HOOK_HANDLER_ID,
      phase: "pre-enable",
      outputs: {},
    });
  });

  it("aborts when another active sandbox already uses the webhook port", async () => {
    const registry = new MessagingHookRegistry([
      createTeamsHostForwardPortConflictHookRegistration({
        currentSandbox: "bob",
        registryEntries: [teamsEntry("alice", 3978)],
      }),
    ]);

    await expect(
      runMessagingHook(HOOK, registry, {
        channelId: "teams",
        inputs: {
          webhookPort: "3978",
        },
      }),
    ).rejects.toThrow(
      "Microsoft Teams webhook port 3978 is already forwarded for sandbox 'alice'; " +
        "choose a different MSTEAMS_PORT or stop/remove the other sandbox before enabling Teams.",
    );
    await expect(
      runMessagingHook(HOOK, registry, {
        channelId: "teams",
        inputs: {
          webhookPort: "3978",
        },
      }),
    ).rejects.toMatchObject({
      code: MESSAGING_HOOK_CONFLICT_CODE,
    });
  });

  it("accepts serialized applier inputs for registry-scoped checks", async () => {
    const registry = new MessagingHookRegistry([
      createTeamsHostForwardPortConflictHookRegistration(),
    ]);
    const registryEntries = JSON.parse(
      JSON.stringify([teamsEntry("alice", 3978)]),
    ) as MessagingSerializableValue;

    await expect(
      runMessagingHook(HOOK, registry, {
        channelId: "teams",
        inputs: {
          currentSandbox: "bob",
          webhookPort: "3978",
          registryEntries,
        },
      }),
    ).rejects.toThrow("Microsoft Teams webhook port 3978 is already forwarded");
  });

  it("ignores stopped or disabled Teams channels", async () => {
    const registry = new MessagingHookRegistry([
      createTeamsHostForwardPortConflictHookRegistration({
        currentSandbox: "bob",
        registryEntries: [teamsEntry("alice", 3978, false, true)],
      }),
    ]);

    await expect(
      runMessagingHook(HOOK, registry, {
        channelId: "teams",
        inputs: {
          webhookPort: "3978",
        },
      }),
    ).resolves.toMatchObject({
      hookId: "teams-host-forward-port-conflict",
      outputs: {},
    });
  });

  it("requires webhook port and registry context when no options are injected", async () => {
    const registry = new MessagingHookRegistry([
      createTeamsHostForwardPortConflictHookRegistration(),
    ]);

    await expect(runMessagingHook(HOOK, registry, { channelId: "teams" })).rejects.toThrow(
      "Microsoft Teams host forward port conflict hook requires webhookPort and registryEntries.",
    );
  });

  it("reports active Teams host forward port overlaps for status", async () => {
    const registry = new MessagingHookRegistry([
      createTeamsHostForwardPortStatusHookRegistration({
        registryEntries: [teamsEntry("alice", 3978), teamsEntry("bob", 3978)],
      }),
    ]);

    await expect(
      runMessagingHook(STATUS_HOOK, registry, {
        channelId: "teams",
      }),
    ).resolves.toMatchObject({
      outputs: {
        hostForwardPortOverlaps: {
          kind: "status",
          value: {
            type: "messaging-overlaps",
            overlaps: [
              {
                channel: "teams",
                port: 3978,
                sandboxes: ["alice", "bob"],
                reason: "host-forward-port",
                message: TEAMS_HOST_FORWARD_PORT_STATUS_MESSAGE,
              },
            ],
          },
        },
      },
    });
  });

  it("emits no status output when active Teams sandboxes use different ports", async () => {
    const registry = new MessagingHookRegistry([
      createTeamsHostForwardPortStatusHookRegistration({
        registryEntries: [teamsEntry("alice", 3978), teamsEntry("bob", 3977)],
      }),
    ]);

    await expect(
      runMessagingHook(STATUS_HOOK, registry, {
        channelId: "teams",
      }),
    ).resolves.toMatchObject({
      outputs: {},
    });
  });
});
