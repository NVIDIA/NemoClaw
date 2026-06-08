// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Legacy-field (messagingChannels / disabledChannels) conflict tests.
// Hash-precise plan-backed tests are split across conflict-detection-entry, conflict-detection-overlap, and conflict-detection-multi-credential tests

import { describe, expect, it, vi } from "vitest";
import { makePlan } from "../../../../test/helpers/messaging-conflict-fixtures";
import type { SandboxEntry } from "../../state/registry";
import {
  backfillMessagingChannels,
  findAllOverlaps,
  findChannelConflicts,
  type MessagingConflictProbe,
} from "./conflict-detection";

type ProviderExists = MessagingConflictProbe["providerExists"];

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

  it("returns unknown-token for any legacy entry sharing the channel (no hash data)", () => {
    const registry = makeRegistry([
      { name: "alice", messagingChannels: ["telegram"] },
      { name: "carol", messagingChannels: ["telegram"] },
    ]);
    expect(
      findChannelConflicts(
        "bob",
        [{ channel: "telegram", credentialHashes: { TELEGRAM_BOT_TOKEN: "hash-a" } }],
        registry,
      ),
    ).toEqual([
      { channel: "telegram", sandbox: "alice", reason: "unknown-token" },
      { channel: "telegram", sandbox: "carol", reason: "unknown-token" },
    ]);
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

  it("ignores a stopped (disabled) channel — its credential is not in use (#3381)", () => {
    const registry = makeRegistry([
      {
        name: "alice",
        messagingChannels: ["telegram"],
        disabledChannels: ["telegram"],
      },
    ]);
    expect(
      findChannelConflicts(
        "bob",
        [{ channel: "telegram", credentialHashes: { TELEGRAM_BOT_TOKEN: "hash-a" } }],
        registry,
      ),
    ).toEqual([]);
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

  it("returns empty when channels do not overlap", () => {
    const registry = makeRegistry([
      { name: "alice", messagingChannels: ["telegram"] },
      { name: "bob", messagingChannels: ["discord"] },
    ]);
    expect(findAllOverlaps(registry)).toEqual([]);
  });

  it("ignores stopped (disabled) channels so nemoclaw status does not report phantom overlaps (#3381)", () => {
    const registry = makeRegistry([
      {
        name: "alice",
        messagingChannels: ["telegram"],
        disabledChannels: ["telegram"],
      },
      { name: "bob", messagingChannels: ["telegram"] },
    ]);
    expect(findAllOverlaps(registry)).toEqual([]);
  });
});

describe("backfillMessagingChannels", () => {
  it("fills in missing messagingChannels by probing OpenShell", () => {
    const registry = makeRegistry([{ name: "alice" }]);
    const probe: MessagingConflictProbe = {
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
    expect(probe.providerExists).toHaveBeenCalledWith("alice-wechat-bridge");
  });

  it("backfills wechat when only the wechat bridge provider is present", () => {
    const registry = makeRegistry([{ name: "alice" }]);
    const probe: MessagingConflictProbe = {
      providerExists: vi.fn<ProviderExists>((name) =>
        name === "alice-wechat-bridge" ? "present" : "absent",
      ),
    };
    backfillMessagingChannels(registry, probe);
    expect(registry.updateSandbox).toHaveBeenCalledWith("alice", {
      messagingChannels: ["wechat"],
    });
  });

  it("surfaces a wechat conflict when two sandboxes share the channel without hashes", () => {
    const registry = makeRegistry([
      { name: "alice", messagingChannels: ["wechat"] },
      { name: "bob", messagingChannels: [] },
    ]);
    expect(findChannelConflicts("bob", ["wechat"], registry)).toEqual([
      { channel: "wechat", sandbox: "alice", reason: "unknown-token" },
    ]);
  });

  it("leaves entries with existing messagingChannels alone", () => {
    const registry = makeRegistry([{ name: "alice", messagingChannels: ["telegram"] }]);
    const probe: MessagingConflictProbe = {
      providerExists: vi.fn<ProviderExists>(() => "present"),
    };
    backfillMessagingChannels(registry, probe);
    expect(registry.updateSandbox).not.toHaveBeenCalled();
    expect(probe.providerExists).not.toHaveBeenCalled();
  });

  it("skips plan-backed entries without legacy messagingChannels", () => {
    const registry = makeRegistry([
      {
        name: "alice",
        messaging: { schemaVersion: 1, plan: makePlan("alice") },
      } as unknown as SandboxEntry,
    ]);
    const probe: MessagingConflictProbe = {
      providerExists: vi.fn<ProviderExists>(() => "present"),
    };
    backfillMessagingChannels(registry, probe);
    expect(registry.updateSandbox).not.toHaveBeenCalled();
    expect(probe.providerExists).not.toHaveBeenCalled();
  });

  it("writes an empty array when all probes return absent", () => {
    const registry = makeRegistry([{ name: "alice" }]);
    const probe: MessagingConflictProbe = {
      providerExists: vi.fn<ProviderExists>(() => "absent"),
    };
    backfillMessagingChannels(registry, probe);
    expect(registry.updateSandbox).toHaveBeenCalledWith("alice", { messagingChannels: [] });
  });

  it("does NOT persist when a probe returns error (retry on next call)", () => {
    const registry = makeRegistry([{ name: "alice" }]);
    const probe: MessagingConflictProbe = {
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
    const probe: MessagingConflictProbe = {
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
    const probe: MessagingConflictProbe = {
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
