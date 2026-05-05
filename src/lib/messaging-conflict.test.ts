// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { SandboxEntry } from "./registry";
import {
  backfillMessagingChannels,
  findAllOverlaps,
  findChannelConflicts,
} from "./messaging-conflict";

type ConflictProbe = Parameters<typeof backfillMessagingChannels>[1];
type ProviderExists = ConflictProbe["providerExists"];

function makeRegistry(sandboxes: SandboxEntry[]) {
  const store = new Map(sandboxes.map((s) => [s.name, { ...s }]));
  return {
    listSandboxes: () => ({
      sandboxes: Array.from(store.values()),
      defaultSandbox: sandboxes[0]?.name ?? null,
    }),
    updateSandbox: vi.fn((name: string, updates: Partial<SandboxEntry>) => {
      const entry = store.get(name);
      if (!entry) return false;
      Object.assign(entry, updates);
      return true;
    }),
  };
}

describe("findChannelConflicts", () => {
  it("returns unknown conflicts when another sandbox has the channel without hashes", () => {
    const registry = makeRegistry([
      { name: "alice", messagingChannels: ["telegram"] },
      { name: "bob", messagingChannels: [] },
    ]);
    expect(findChannelConflicts("bob", ["telegram"], registry)).toEqual([
      { channel: "telegram", sandbox: "alice", reason: "unknown-token" },
    ]);
  });

  it("returns conflicts only when the same channel credential hash matches", () => {
    const registry = makeRegistry([
      {
        name: "alice",
        messagingChannels: ["telegram"],
        providerCredentialHashes: { TELEGRAM_BOT_TOKEN: "hash-a" },
      },
      {
        name: "carol",
        messagingChannels: ["telegram"],
        providerCredentialHashes: { TELEGRAM_BOT_TOKEN: "hash-c" },
      },
    ]);
    expect(
      findChannelConflicts(
        "bob",
        [{ channel: "telegram", credentialHashes: { TELEGRAM_BOT_TOKEN: "hash-a" } }],
        registry,
      ),
    ).toEqual([{ channel: "telegram", sandbox: "alice", reason: "matching-token" }]);
  });

  it("allows multiple telegram sandboxes with distinct token hashes", () => {
    const registry = makeRegistry([
      {
        name: "alice",
        messagingChannels: ["telegram"],
        providerCredentialHashes: { TELEGRAM_BOT_TOKEN: "hash-a" },
      },
    ]);
    expect(
      findChannelConflicts(
        "bob",
        [{ channel: "telegram", credentialHashes: { TELEGRAM_BOT_TOKEN: "hash-b" } }],
        registry,
      ),
    ).toEqual([]);
  });

  it("excludes the current sandbox from its own conflicts", () => {
    const registry = makeRegistry([{ name: "alice", messagingChannels: ["telegram"] }]);
    expect(findChannelConflicts("alice", ["telegram"], registry)).toEqual([]);
  });

  it("skips entries with no messagingChannels field (pre-backfill)", () => {
    const registry = makeRegistry([{ name: "alice" }, { name: "bob", messagingChannels: [] }]);
    expect(findChannelConflicts("bob", ["telegram"], registry)).toEqual([]);
  });

  it("returns empty when no channels are enabled", () => {
    const registry = makeRegistry([{ name: "alice", messagingChannels: ["telegram"] }]);
    expect(findChannelConflicts("bob", [], registry)).toEqual([]);
  });
});

describe("findAllOverlaps", () => {
  it("reports each overlapping pair once", () => {
    const registry = makeRegistry([
      { name: "alice", messagingChannels: ["telegram"] },
      { name: "bob", messagingChannels: ["telegram"] },
      { name: "carol", messagingChannels: ["discord"] },
    ]);
    expect(findAllOverlaps(registry)).toEqual([
      { channel: "telegram", sandboxes: ["alice", "bob"], reason: "unknown-token" },
    ]);
  });

  it("reports all unknown pairs when three sandboxes share a channel without hashes", () => {
    const registry = makeRegistry([
      { name: "a", messagingChannels: ["telegram"] },
      { name: "b", messagingChannels: ["telegram"] },
      { name: "c", messagingChannels: ["telegram"] },
    ]);
    expect(findAllOverlaps(registry)).toEqual([
      { channel: "telegram", sandboxes: ["a", "b"], reason: "unknown-token" },
      { channel: "telegram", sandboxes: ["a", "c"], reason: "unknown-token" },
      { channel: "telegram", sandboxes: ["b", "c"], reason: "unknown-token" },
    ]);
  });

  it("does not report overlaps when same-channel credential hashes differ", () => {
    const registry = makeRegistry([
      {
        name: "alice",
        messagingChannels: ["telegram"],
        providerCredentialHashes: { TELEGRAM_BOT_TOKEN: "hash-a" },
      },
      {
        name: "bob",
        messagingChannels: ["telegram"],
        providerCredentialHashes: { TELEGRAM_BOT_TOKEN: "hash-b" },
      },
    ]);
    expect(findAllOverlaps(registry)).toEqual([]);
  });

  it("reports matching-token overlaps when same-channel credential hashes match", () => {
    const registry = makeRegistry([
      {
        name: "alice",
        messagingChannels: ["telegram"],
        providerCredentialHashes: { TELEGRAM_BOT_TOKEN: "hash-a" },
      },
      {
        name: "bob",
        messagingChannels: ["telegram"],
        providerCredentialHashes: { TELEGRAM_BOT_TOKEN: "hash-a" },
      },
    ]);
    expect(findAllOverlaps(registry)).toEqual([
      { channel: "telegram", sandboxes: ["alice", "bob"], reason: "matching-token" },
    ]);
  });

  it("returns empty when channels do not overlap", () => {
    const registry = makeRegistry([
      { name: "alice", messagingChannels: ["telegram"] },
      { name: "bob", messagingChannels: ["discord"] },
    ]);
    expect(findAllOverlaps(registry)).toEqual([]);
  });
});

describe("backfillMessagingChannels", () => {
  it("fills in missing messagingChannels by probing OpenShell", () => {
    const registry = makeRegistry([{ name: "alice" }]);
    const probe: ConflictProbe = {
      providerExists: vi.fn<ProviderExists>((name) =>
        name === "alice-telegram-bridge" ? "present" : "absent",
      ),
    };
    backfillMessagingChannels(registry, probe);
    expect(registry.updateSandbox).toHaveBeenCalledWith("alice", {
      messagingChannels: ["telegram"],
    });
    expect(probe.providerExists).toHaveBeenCalledWith("alice-telegram-bridge");
    expect(probe.providerExists).toHaveBeenCalledWith("alice-discord-bridge");
    expect(probe.providerExists).toHaveBeenCalledWith("alice-slack-bridge");
  });

  it("leaves entries with existing messagingChannels alone", () => {
    const registry = makeRegistry([{ name: "alice", messagingChannels: ["telegram"] }]);
    const probe: ConflictProbe = {
      providerExists: vi.fn<ProviderExists>(() => "present"),
    };
    backfillMessagingChannels(registry, probe);
    expect(registry.updateSandbox).not.toHaveBeenCalled();
    expect(probe.providerExists).not.toHaveBeenCalled();
  });

  it("writes an empty array when all probes return absent", () => {
    const registry = makeRegistry([{ name: "alice" }]);
    const probe: ConflictProbe = {
      providerExists: vi.fn<ProviderExists>(() => "absent"),
    };
    backfillMessagingChannels(registry, probe);
    expect(registry.updateSandbox).toHaveBeenCalledWith("alice", { messagingChannels: [] });
  });

  it("does NOT persist when a probe returns error (retry on next call)", () => {
    // "error" is distinct from "absent": a transient gateway failure must not
    // be collapsed into "provider not attached" and persisted, because that
    // would prevent all future backfill retries and hide real overlaps.
    const registry = makeRegistry([{ name: "alice" }]);
    const probe: ConflictProbe = {
      providerExists: vi.fn<ProviderExists>((name) => {
        if (name.endsWith("-telegram-bridge")) return "error";
        return name.endsWith("-discord-bridge") ? "present" : "absent";
      }),
    };
    backfillMessagingChannels(registry, probe);
    expect(registry.updateSandbox).not.toHaveBeenCalled();
  });

  it("also treats a thrown probe as error (defensive; callers should return 'error' instead)", () => {
    const registry = makeRegistry([{ name: "alice" }]);
    const probe: ConflictProbe = {
      providerExists: vi.fn<ProviderExists>(() => {
        throw new Error("unexpected");
      }),
    };
    backfillMessagingChannels(registry, probe);
    expect(registry.updateSandbox).not.toHaveBeenCalled();
  });

  it("re-attempts backfill on a subsequent call after a prior error", () => {
    const registry = makeRegistry([{ name: "alice" }]);
    let firstPass = true;
    const probe: ConflictProbe = {
      providerExists: vi.fn<ProviderExists>((name) => {
        if (name.endsWith("-telegram-bridge") && firstPass) {
          firstPass = false;
          return "error";
        }
        return name === "alice-telegram-bridge" ? "present" : "absent";
      }),
    };
    backfillMessagingChannels(registry, probe);
    expect(registry.updateSandbox).not.toHaveBeenCalled();
    backfillMessagingChannels(registry, probe);
    expect(registry.updateSandbox).toHaveBeenCalledWith("alice", {
      messagingChannels: ["telegram"],
    });
  });
});
