// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  makePlan,
  planEntry,
  slackAppBinding,
  slackBotBinding,
  slackChannel,
} from "../../../../test/helpers/messaging-conflict-fixtures";
import { conflictReasonForPair, conflictReasonForRequest } from "./conflict-detection";

describe("multi-credential channel partial hash suppression", () => {
  it("request comparison returns unknown-token when Slack app token is missing", () => {
    const entry = planEntry(
      "alice",
      makePlan("alice", {
        channels: [slackChannel()],
        credentialBindings: [slackBotBinding("hash-bot-a", "alice")],
      }),
    );
    expect(
      conflictReasonForRequest(entry, {
        channel: "slack",
        credentialHashes: { SLACK_BOT_TOKEN: "hash-bot-b", SLACK_APP_TOKEN: "hash-app-x" },
      }),
    ).toBe("unknown-token");
  });

  it("request comparison returns null when both Slack token hashes differ", () => {
    const entry = planEntry(
      "alice",
      makePlan("alice", {
        channels: [slackChannel()],
        credentialBindings: [
          slackBotBinding("hash-bot-a", "alice"),
          slackAppBinding("hash-app-a", "alice"),
        ],
      }),
    );
    expect(
      conflictReasonForRequest(entry, {
        channel: "slack",
        credentialHashes: { SLACK_BOT_TOKEN: "hash-bot-b", SLACK_APP_TOKEN: "hash-app-b" },
      }),
    ).toBeNull();
  });

  it("pair comparison returns unknown-token when Slack app token is absent from both plans", () => {
    const alice = planEntry(
      "alice",
      makePlan("alice", {
        channels: [slackChannel()],
        credentialBindings: [slackBotBinding("hash-bot-a", "alice")],
      }),
    );
    const bob = planEntry(
      "bob",
      makePlan("bob", {
        channels: [slackChannel()],
        credentialBindings: [slackBotBinding("hash-bot-b", "bob")],
      }),
    );
    expect(conflictReasonForPair("slack", alice, bob)).toBe("unknown-token");
  });

  it("pair comparison returns null when both Slack token hashes differ", () => {
    const alice = planEntry(
      "alice",
      makePlan("alice", {
        channels: [slackChannel()],
        credentialBindings: [
          slackBotBinding("hash-bot-a", "alice"),
          slackAppBinding("hash-app-a", "alice"),
        ],
      }),
    );
    const bob = planEntry(
      "bob",
      makePlan("bob", {
        channels: [slackChannel()],
        credentialBindings: [
          slackBotBinding("hash-bot-b", "bob"),
          slackAppBinding("hash-app-b", "bob"),
        ],
      }),
    );
    expect(conflictReasonForPair("slack", alice, bob)).toBeNull();
  });
});
