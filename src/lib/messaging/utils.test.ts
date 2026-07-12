// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { BUILT_IN_CHANNEL_MANIFESTS } from "./channels";
import {
  formatSupportedMessagingAgentIds,
  getMessagingManifestAvailabilityContext,
  isMessagingChannelSupportedByAgent,
  isMessagingSupportedAgent,
  listSupportedMessagingAgentIds,
  listSupportedMessagingChannelIdsForAgent,
  MessagingAgentNotSupportedError,
  toMessagingAgentId,
  tryGetMessagingAgentId,
} from "./utils";

const manifests = BUILT_IN_CHANNEL_MANIFESTS;

describe("listSupportedMessagingAgentIds", () => {
  it("derives messaging-capable agents from channel manifests", () => {
    expect(listSupportedMessagingAgentIds(manifests)).toEqual(["openclaw", "hermes"]);
  });
});

describe("listSupportedMessagingChannelIdsForAgent", () => {
  it("derives supported channel IDs from channel manifest supportedAgents", () => {
    expect(listSupportedMessagingChannelIdsForAgent(manifests, "openclaw")).toEqual([
      "telegram",
      "discord",
      "wechat",
      "slack",
      "whatsapp",
      "teams",
    ]);
    expect(listSupportedMessagingChannelIdsForAgent(manifests, "hermes")).toEqual([
      "telegram",
      "discord",
      "wechat",
      "slack",
      "whatsapp",
      "teams",
    ]);
  });
});

describe("isMessagingChannelSupportedByAgent", () => {
  it("checks support against one channel manifest", () => {
    const discord = manifests.find((manifest) => manifest.id === "discord");
    expect(discord).toBeDefined();
    expect(isMessagingChannelSupportedByAgent(discord!, { name: "openclaw" })).toBe(true);
    expect(isMessagingChannelSupportedByAgent(discord!, { name: "hermes" })).toBe(true);
    expect(
      isMessagingChannelSupportedByAgent(discord!, {
        name: "langchain-deepagents-code",
      }),
    ).toBe(false);
  });
});

describe("formatSupportedMessagingAgentIds", () => {
  it("formats manifest-derived agent lists for CLI messages", () => {
    expect(formatSupportedMessagingAgentIds(["openclaw", "hermes"])).toBe("openclaw, hermes");
    expect(formatSupportedMessagingAgentIds([])).toBe("(none)");
  });
});

describe("tryGetMessagingAgentId", () => {
  it("returns 'openclaw' for the openclaw agent name", () => {
    expect(tryGetMessagingAgentId({ name: "openclaw" }, manifests)).toBe("openclaw");
  });

  it("returns 'hermes' for the hermes agent name", () => {
    expect(tryGetMessagingAgentId({ name: "hermes" }, manifests)).toBe("hermes");
  });

  it("returns null for DeepAgents because no channel manifest supports it", () => {
    expect(tryGetMessagingAgentId({ name: "langchain-deepagents-code" }, manifests)).toBeNull();
  });

  it("returns null for unknown agent names instead of silently defaulting", () => {
    expect(tryGetMessagingAgentId({ name: "custom-agent" }, manifests)).toBeNull();
  });

  it("returns null for null or undefined input", () => {
    expect(tryGetMessagingAgentId(null, manifests)).toBeNull();
    expect(tryGetMessagingAgentId(undefined, manifests)).toBeNull();
    expect(tryGetMessagingAgentId({}, manifests)).toBeNull();
  });
});

describe("toMessagingAgentId", () => {
  it("returns the messaging agent id for known names", () => {
    expect(toMessagingAgentId({ name: "openclaw" }, manifests)).toBe("openclaw");
    expect(toMessagingAgentId({ name: "hermes" }, manifests)).toBe("hermes");
  });

  it("falls back to openclaw when no agent name is supplied (legacy default convention)", () => {
    expect(toMessagingAgentId(null, manifests)).toBe("openclaw");
    expect(toMessagingAgentId(undefined, manifests)).toBe("openclaw");
    expect(toMessagingAgentId({}, manifests)).toBe("openclaw");
    expect(toMessagingAgentId({ name: "" }, manifests)).toBe("openclaw");
    expect(toMessagingAgentId({ name: "   " }, manifests)).toBe("openclaw");
  });

  it("throws MessagingAgentNotSupportedError for an explicit unknown agent", () => {
    expect(() => toMessagingAgentId({ name: "custom-agent" }, manifests)).toThrow(
      MessagingAgentNotSupportedError,
    );
  });

  it("surfaces the offending agent name on the thrown error", () => {
    try {
      toMessagingAgentId({ name: "custom-agent" }, manifests);
    } catch (err) {
      expect(err).toBeInstanceOf(MessagingAgentNotSupportedError);
      expect((err as MessagingAgentNotSupportedError).agentName).toBe("custom-agent");
      expect((err as Error).message).toMatch(/openclaw, hermes/);
      return;
    }
    throw new Error("expected toMessagingAgentId to throw");
  });
});

describe("isMessagingSupportedAgent", () => {
  it("returns true only for agents supported by at least one channel manifest", () => {
    expect(isMessagingSupportedAgent({ name: "openclaw" }, manifests)).toBe(true);
    expect(isMessagingSupportedAgent({ name: "hermes" }, manifests)).toBe(true);
    expect(isMessagingSupportedAgent({ name: "langchain-deepagents-code" }, manifests)).toBe(false);
  });

  it("returns false for unknown agents", () => {
    expect(isMessagingSupportedAgent({ name: "custom-agent" }, manifests)).toBe(false);
    expect(isMessagingSupportedAgent(null, manifests)).toBe(false);
  });
});

describe("getMessagingManifestAvailabilityContext", () => {
  it("returns a null agent when no agent is provided (default-agent caller path)", () => {
    expect(getMessagingManifestAvailabilityContext(null, manifests)).toEqual({
      agent: null,
      supportedChannelIds: null,
    });
    expect(getMessagingManifestAvailabilityContext(undefined, manifests)).toEqual({
      agent: null,
      supportedChannelIds: null,
    });
  });

  it("returns the resolved messaging agent id with no separate channel constraint", () => {
    expect(getMessagingManifestAvailabilityContext({ name: "openclaw" }, manifests)).toEqual({
      agent: "openclaw",
      supportedChannelIds: null,
    });
  });

  it("preserves hermes agent identity", () => {
    expect(getMessagingManifestAvailabilityContext({ name: "hermes" }, manifests)).toEqual({
      agent: "hermes",
      supportedChannelIds: null,
    });
  });

  it("turns explicit unsupported agents into a deny-all availability context", () => {
    expect(
      getMessagingManifestAvailabilityContext({ name: "langchain-deepagents-code" }, manifests),
    ).toEqual({
      agent: null,
      supportedChannelIds: [],
    });
    expect(getMessagingManifestAvailabilityContext({ name: "custom-agent" }, manifests)).toEqual({
      agent: null,
      supportedChannelIds: [],
    });
  });
});
