// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  makePlan,
  planEntry,
  tgBinding,
  tgChannel,
  whatsappChannel,
} from "../../../../test/helpers/messaging-conflict-fixtures";
import { detectAllOverlapsInEntries, findConflictsInEntries } from "./conflict-detection";

describe("findConflictsInEntries", () => {
  it("detects matching-token against a plan-only entry", () => {
    const alice = planEntry(
      "alice",
      makePlan("alice", { channels: [tgChannel()], credentialBindings: [tgBinding("hash-a")] }),
    );
    expect(
      findConflictsInEntries(
        "bob",
        [{ channel: "telegram", credentialHashes: { TELEGRAM_BOT_TOKEN: "hash-a" } }],
        [alice],
      ),
    ).toEqual([{ channel: "telegram", sandbox: "alice", reason: "matching-token" }]);
  });

  it("ignores a disabled channel in a plan-backed entry", () => {
    const alice = planEntry(
      "alice",
      makePlan("alice", {
        disabledChannels: ["telegram"],
        channels: [tgChannel(true, true)],
        credentialBindings: [tgBinding("hash-a")],
      }),
    );
    expect(
      findConflictsInEntries(
        "bob",
        [{ channel: "telegram", credentialHashes: { TELEGRAM_BOT_TOKEN: "hash-a" } }],
        [alice],
      ),
    ).toEqual([]);
  });
});

describe("detectAllOverlapsInEntries", () => {
  it("reports matching-token overlap between two plan-backed entries", () => {
    const alice = planEntry(
      "alice",
      makePlan("alice", { channels: [tgChannel()], credentialBindings: [tgBinding("hash-a")] }),
    );
    const bob = planEntry(
      "bob",
      makePlan("bob", { channels: [tgChannel()], credentialBindings: [tgBinding("hash-a")] }),
    );
    expect(detectAllOverlapsInEntries([alice, bob])).toEqual([
      { channel: "telegram", sandboxes: ["alice", "bob"], reason: "matching-token" },
    ]);
  });

  it("does not report overlap when shared channel is disabled in one plan", () => {
    const alice = planEntry(
      "alice",
      makePlan("alice", {
        disabledChannels: ["telegram"],
        channels: [tgChannel(true, true)],
        credentialBindings: [tgBinding("hash-a")],
      }),
    );
    const bob = planEntry(
      "bob",
      makePlan("bob", { channels: [tgChannel()], credentialBindings: [tgBinding("hash-a")] }),
    );
    expect(detectAllOverlapsInEntries([alice, bob])).toEqual([]);
  });

  it("does not report overlap for credential-less channels", () => {
    const alice = planEntry("alice", makePlan("alice", { channels: [whatsappChannel()] }));
    const bob = planEntry("bob", makePlan("bob", { channels: [whatsappChannel()] }));
    expect(detectAllOverlapsInEntries([alice, bob])).toEqual([]);
  });
});
