// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  discordBinding,
  discordChannel,
  makePlan,
  planEntry,
  slackBindings,
  slackChannel,
  tgBinding,
  tgChannel,
  whatsappChannel,
} from "../../../../test/helpers/messaging-conflict-fixtures";
import {
  conflictReasonForPair,
  conflictReasonForRequest,
  detectAllOverlapsInEntries,
  findConflictsInEntries,
  hasStoredChannelInEntry,
  type ConflictRegistryEntry,
} from "./conflict-detection";

function legacyEntry(
  name: string,
  messagingChannels: readonly string[],
  disabledChannels: readonly string[] = [],
): ConflictRegistryEntry {
  return { name, messagingChannels, disabledChannels };
}

describe("hasStoredChannelInEntry", () => {
  it("returns true for an active channel in a plan-backed entry", () => {
    const entry = planEntry("sb", makePlan("sb", { channels: [tgChannel()] }));
    expect(hasStoredChannelInEntry(entry, "telegram")).toBe(true);
  });

  it("returns false for disabled or inactive plan channels", () => {
    expect(
      hasStoredChannelInEntry(
        planEntry(
          "sb",
          makePlan("sb", { disabledChannels: ["telegram"], channels: [tgChannel(true, true)] }),
        ),
        "telegram",
      ),
    ).toBe(false);
    expect(
      hasStoredChannelInEntry(
        planEntry("sb", makePlan("sb", { channels: [tgChannel(false, false)] })),
        "telegram",
      ),
    ).toBe(false);
  });

  it("returns true for active legacy registry channels", () => {
    expect(hasStoredChannelInEntry(legacyEntry("sb", ["telegram"]), "telegram")).toBe(true);
  });

  it("returns false for disabled legacy registry channels", () => {
    expect(
      hasStoredChannelInEntry(legacyEntry("sb", ["telegram"], ["telegram"]), "telegram"),
    ).toBe(false);
  });
});

describe("conflictReasonForRequest", () => {
  it("detects matching-token when same channel hash matches", () => {
    const entry = planEntry(
      "alice",
      makePlan("alice", { channels: [tgChannel()], credentialBindings: [tgBinding("hash-a")] }),
    );
    expect(
      conflictReasonForRequest(entry, {
        channel: "telegram",
        credentialHashes: { TELEGRAM_BOT_TOKEN: "hash-a" },
      }),
    ).toBe("matching-token");
  });

  it("returns null when same channel hash differs", () => {
    const entry = planEntry(
      "alice",
      makePlan("alice", { channels: [tgChannel()], credentialBindings: [tgBinding("hash-a")] }),
    );
    expect(
      conflictReasonForRequest(entry, {
        channel: "telegram",
        credentialHashes: { TELEGRAM_BOT_TOKEN: "hash-b" },
      }),
    ).toBeNull();
  });

  it("does not produce false positives from unrelated-channel hashes", () => {
    const entry = planEntry(
      "alice",
      makePlan("alice", {
        channels: [tgChannel(), slackChannel()],
        credentialBindings: [tgBinding("hash-tg-a"), ...slackBindings("hash-slack")],
      }),
    );
    expect(
      conflictReasonForRequest(entry, {
        channel: "telegram",
        credentialHashes: { TELEGRAM_BOT_TOKEN: "hash-tg-b" },
      }),
    ).toBeNull();
  });

  it("returns unknown-token when plan has no hashes for the channel", () => {
    const entry = planEntry(
      "alice",
      makePlan("alice", { channels: [tgChannel()], credentialBindings: [tgBinding()] }),
    );
    expect(
      conflictReasonForRequest(entry, {
        channel: "telegram",
        credentialHashes: { TELEGRAM_BOT_TOKEN: "hash-a" },
      }),
    ).toBe("unknown-token");
  });

  it("returns null for credential-less channels with no comparison keys", () => {
    const entry = planEntry("alice", makePlan("alice", { channels: [whatsappChannel()] }));
    expect(
      conflictReasonForRequest(entry, {
        channel: "whatsapp",
        credentialHashes: {},
      }),
    ).toBeNull();
  });

  it("fails closed with unknown-token for active legacy entries", () => {
    expect(
      conflictReasonForRequest(legacyEntry("alice", ["telegram"]), {
        channel: "telegram",
        credentialHashes: { TELEGRAM_BOT_TOKEN: "hash-a" },
      }),
    ).toBe("unknown-token");
  });

  it("ignores disabled legacy entries", () => {
    expect(
      conflictReasonForRequest(legacyEntry("alice", ["telegram"], ["telegram"]), {
        channel: "telegram",
        credentialHashes: { TELEGRAM_BOT_TOKEN: "hash-a" },
      }),
    ).toBeNull();
  });
});

describe("conflictReasonForPair", () => {
  it("detects matching-token between two plan-backed entries", () => {
    const alice = planEntry(
      "alice",
      makePlan("alice", { channels: [tgChannel()], credentialBindings: [tgBinding("hash-a")] }),
    );
    const bob = planEntry(
      "bob",
      makePlan("bob", { channels: [tgChannel()], credentialBindings: [tgBinding("hash-a")] }),
    );
    expect(conflictReasonForPair("telegram", alice, bob)).toBe("matching-token");
  });

  it("returns null when same-channel hashes differ", () => {
    const alice = planEntry(
      "alice",
      makePlan("alice", { channels: [tgChannel()], credentialBindings: [tgBinding("hash-a")] }),
    );
    const bob = planEntry(
      "bob",
      makePlan("bob", { channels: [tgChannel()], credentialBindings: [tgBinding("hash-b")] }),
    );
    expect(conflictReasonForPair("telegram", alice, bob)).toBeNull();
  });

  it("covers Discord matching and distinct plan-backed hashes", () => {
    const matchingAlice = planEntry(
      "alice",
      makePlan("alice", {
        channels: [discordChannel()],
        credentialBindings: [discordBinding("hash-discord")],
      }),
    );
    const matchingBob = planEntry(
      "bob",
      makePlan("bob", {
        channels: [discordChannel()],
        credentialBindings: [discordBinding("hash-discord")],
      }),
    );
    expect(conflictReasonForPair("discord", matchingAlice, matchingBob)).toBe("matching-token");

    const distinctBob = planEntry(
      "bob",
      makePlan("bob", {
        channels: [discordChannel()],
        credentialBindings: [discordBinding("hash-discord-b")],
      }),
    );
    expect(conflictReasonForPair("discord", matchingAlice, distinctBob)).toBeNull();
  });

  it("scopes comparison to the requested channel", () => {
    const alice = planEntry(
      "alice",
      makePlan("alice", {
        channels: [tgChannel(), slackChannel()],
        credentialBindings: [tgBinding("hash-tg-a"), ...slackBindings("hash-slack")],
      }),
    );
    const bob = planEntry(
      "bob",
      makePlan("bob", {
        channels: [tgChannel(), slackChannel()],
        credentialBindings: [tgBinding("hash-tg-b"), ...slackBindings("hash-slack")],
      }),
    );
    expect(conflictReasonForPair("telegram", alice, bob)).toBeNull();
    expect(conflictReasonForPair("slack", alice, bob)).toBe("matching-token");
  });

  it("returns null for credential-less channel pairs with no comparison keys", () => {
    const alice = planEntry("alice", makePlan("alice", { channels: [whatsappChannel()] }));
    const bob = planEntry("bob", makePlan("bob", { channels: [whatsappChannel()] }));
    expect(conflictReasonForPair("whatsapp", alice, bob)).toBeNull();
  });

  it("fails closed for mixed legacy and plan-backed entries", () => {
    const alice = legacyEntry("alice", ["telegram"]);
    const bob = planEntry(
      "bob",
      makePlan("bob", { channels: [tgChannel()], credentialBindings: [tgBinding("hash-b")] }),
    );
    expect(conflictReasonForPair("telegram", alice, bob)).toBe("unknown-token");
  });
});

describe("findConflictsInEntries", () => {
  it("includes active legacy entries as unknown-token conflicts", () => {
    expect(
      findConflictsInEntries(
        "bob",
        [{ channel: "telegram", credentialHashes: { TELEGRAM_BOT_TOKEN: "hash-b" } }],
        [legacyEntry("alice", ["telegram"])],
      ),
    ).toEqual([{ channel: "telegram", sandbox: "alice", reason: "unknown-token" }]);
  });

  it("does not include disabled legacy entries", () => {
    expect(
      findConflictsInEntries(
        "bob",
        [{ channel: "telegram", credentialHashes: { TELEGRAM_BOT_TOKEN: "hash-b" } }],
        [legacyEntry("alice", ["telegram"], ["telegram"])],
      ),
    ).toEqual([]);
  });
});

describe("detectAllOverlapsInEntries", () => {
  it("reports mixed legacy and plan-backed overlaps as unknown-token", () => {
    const bob = planEntry(
      "bob",
      makePlan("bob", { channels: [tgChannel()], credentialBindings: [tgBinding("hash-b")] }),
    );
    expect(detectAllOverlapsInEntries([legacyEntry("alice", ["telegram"]), bob])).toEqual([
      { channel: "telegram", sandboxes: ["alice", "bob"], reason: "unknown-token" },
    ]);
  });
});
