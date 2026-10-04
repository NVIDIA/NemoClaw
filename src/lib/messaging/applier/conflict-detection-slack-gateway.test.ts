// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  makePlan,
  planEntry,
  slackBindings,
  slackChannel,
  tgChannel,
} from "../../../../test/helpers/messaging-conflict-fixtures";
import type { ConflictRegistryEntry } from "./conflict-detection";
import {
  detectAllSlackSocketModeGatewayOverlaps,
  findSlackSocketModeGatewayConflicts,
  formatSlackSocketModeConflictMessage,
} from "./conflict-detection";

function slackEntry(name: string, gatewayName?: string | null): ConflictRegistryEntry {
  const entry = planEntry(
    name,
    makePlan(name, {
      channels: [slackChannel()],
      credentialBindings: slackBindings("b", "a", name),
    }),
  );
  return gatewayName === undefined ? entry : { ...entry, gatewayName };
}

describe("findSlackSocketModeGatewayConflicts", () => {
  it("flags another sandbox with Slack active on the same gateway", () => {
    const alice = slackEntry("alice", "nemoclaw");
    expect(findSlackSocketModeGatewayConflicts("bob", "nemoclaw", [alice])).toEqual([
      { sandbox: "alice", gatewayName: "nemoclaw" },
    ]);
  });

  it("does not flag a sandbox on a different gateway", () => {
    const alice = slackEntry("alice", "nemoclaw-9090");
    expect(findSlackSocketModeGatewayConflicts("bob", "nemoclaw", [alice])).toEqual([]);
  });

  it("treats a missing gatewayName as the default nemoclaw gateway", () => {
    // Legacy entry created before per-port gateway naming (#4422): no recorded
    // name means it was on the default gateway.
    const legacy = slackEntry("legacy", undefined);
    expect(findSlackSocketModeGatewayConflicts("bob", "nemoclaw", [legacy])).toEqual([
      { sandbox: "legacy", gatewayName: "nemoclaw" },
    ]);
  });

  it("excludes the current sandbox itself", () => {
    const bob = slackEntry("bob", "nemoclaw");
    expect(findSlackSocketModeGatewayConflicts("bob", "nemoclaw", [bob])).toEqual([]);
  });

  it("ignores a sandbox whose Slack channel is disabled", () => {
    const alice = planEntry(
      "alice",
      makePlan("alice", {
        disabledChannels: ["slack"],
        channels: [{ ...slackChannel(), disabled: true }],
        credentialBindings: slackBindings("b", "a", "alice"),
      }),
    );
    expect(
      findSlackSocketModeGatewayConflicts("bob", "nemoclaw", [
        { ...alice, gatewayName: "nemoclaw" },
      ]),
    ).toEqual([]);
  });

  it("ignores a sandbox without Slack active", () => {
    const alice = planEntry("alice", makePlan("alice", { channels: [tgChannel()] }));
    expect(
      findSlackSocketModeGatewayConflicts("bob", "nemoclaw", [
        { ...alice, gatewayName: "nemoclaw" },
      ]),
    ).toEqual([]);
  });
});

describe("detectAllSlackSocketModeGatewayOverlaps", () => {
  it("reports one pair for two Slack sandboxes on the same gateway", () => {
    expect(
      detectAllSlackSocketModeGatewayOverlaps([
        slackEntry("alice", "nemoclaw"),
        slackEntry("bob", "nemoclaw"),
      ]),
    ).toEqual([{ gatewayName: "nemoclaw", sandboxes: ["alice", "bob"] }]);
  });

  it("does not report Slack sandboxes on different gateways", () => {
    expect(
      detectAllSlackSocketModeGatewayOverlaps([
        slackEntry("alice", "nemoclaw"),
        slackEntry("bob", "nemoclaw-9090"),
      ]),
    ).toEqual([]);
  });

  it("reports every pair when three Slack sandboxes share a gateway", () => {
    const overlaps = detectAllSlackSocketModeGatewayOverlaps([
      slackEntry("a", "nemoclaw"),
      slackEntry("b", "nemoclaw"),
      slackEntry("c", "nemoclaw"),
    ]);
    expect(overlaps).toEqual([
      { gatewayName: "nemoclaw", sandboxes: ["a", "b"] },
      { gatewayName: "nemoclaw", sandboxes: ["a", "c"] },
      { gatewayName: "nemoclaw", sandboxes: ["b", "c"] },
    ]);
  });
});

describe("formatSlackSocketModeConflictMessage", () => {
  it("names the other sandbox and states the one-per-gateway constraint", () => {
    expect(formatSlackSocketModeConflictMessage("alice")).toBe(
      "Slack Socket Mode is already enabled for sandbox 'alice' on this gateway; " +
        "only one sandbox can receive Slack Socket Mode events unless the gateway supports multiplexing.",
    );
  });
});
