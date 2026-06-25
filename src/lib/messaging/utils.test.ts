// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  getMessagingManifestAvailabilityContext,
  isMessagingSupportedAgent,
  MessagingAgentNotSupportedError,
  toMessagingAgentId,
  tryGetMessagingAgentId,
} from "./utils";

describe("tryGetMessagingAgentId", () => {
  it("returns 'openclaw' for the openclaw agent name", () => {
    expect(tryGetMessagingAgentId({ name: "openclaw" })).toBe("openclaw");
  });

  it("returns 'hermes' for the hermes agent name", () => {
    expect(tryGetMessagingAgentId({ name: "hermes" })).toBe("hermes");
  });

  it("returns 'langchain-deepagents-code' for the DeepAgents agent name", () => {
    expect(tryGetMessagingAgentId({ name: "langchain-deepagents-code" })).toBe(
      "langchain-deepagents-code",
    );
  });

  it("returns null for unknown agent names instead of silently defaulting", () => {
    expect(tryGetMessagingAgentId({ name: "custom-agent" })).toBeNull();
  });

  it("returns null for null or undefined input", () => {
    expect(tryGetMessagingAgentId(null)).toBeNull();
    expect(tryGetMessagingAgentId(undefined)).toBeNull();
    expect(tryGetMessagingAgentId({})).toBeNull();
  });
});

describe("toMessagingAgentId", () => {
  it("returns the messaging agent id for known names", () => {
    expect(toMessagingAgentId({ name: "openclaw" })).toBe("openclaw");
    expect(toMessagingAgentId({ name: "hermes" })).toBe("hermes");
    expect(toMessagingAgentId({ name: "langchain-deepagents-code" })).toBe(
      "langchain-deepagents-code",
    );
  });

  it("falls back to openclaw when no agent name is supplied (legacy default convention)", () => {
    expect(toMessagingAgentId(null)).toBe("openclaw");
    expect(toMessagingAgentId(undefined)).toBe("openclaw");
    expect(toMessagingAgentId({})).toBe("openclaw");
    expect(toMessagingAgentId({ name: "" })).toBe("openclaw");
    expect(toMessagingAgentId({ name: "   " })).toBe("openclaw");
  });

  it("throws MessagingAgentNotSupportedError for an explicit unknown agent", () => {
    expect(() => toMessagingAgentId({ name: "custom-agent" })).toThrow(
      MessagingAgentNotSupportedError,
    );
  });

  it("surfaces the offending agent name on the thrown error", () => {
    try {
      toMessagingAgentId({ name: "custom-agent" });
    } catch (err) {
      expect(err).toBeInstanceOf(MessagingAgentNotSupportedError);
      expect((err as MessagingAgentNotSupportedError).agentName).toBe("custom-agent");
      expect((err as Error).message).toMatch(/openclaw, hermes, langchain-deepagents-code/);
      return;
    }
    throw new Error("expected toMessagingAgentId to throw");
  });
});

describe("isMessagingSupportedAgent", () => {
  it("returns true for openclaw, hermes, and DeepAgents regardless of populated messagingPlatforms", () => {
    expect(isMessagingSupportedAgent({ name: "openclaw" })).toBe(true);
    expect(isMessagingSupportedAgent({ name: "hermes", messagingPlatforms: ["telegram"] })).toBe(
      true,
    );
    expect(
      isMessagingSupportedAgent({
        name: "langchain-deepagents-code",
        messagingPlatforms: ["discord"],
      }),
    ).toBe(true);
  });

  it("returns false for known agents whose messagingPlatforms is an explicit empty allowlist", () => {
    expect(isMessagingSupportedAgent({ name: "openclaw", messagingPlatforms: [] })).toBe(false);
    expect(isMessagingSupportedAgent({ name: "hermes", messagingPlatforms: [] })).toBe(false);
    expect(
      isMessagingSupportedAgent({
        name: "langchain-deepagents-code",
        messagingPlatforms: [],
      }),
    ).toBe(false);
  });

  it("returns false for unknown agents", () => {
    expect(isMessagingSupportedAgent({ name: "custom-agent" })).toBe(false);
    expect(isMessagingSupportedAgent(null)).toBe(false);
  });
});

describe("getMessagingManifestAvailabilityContext", () => {
  it("returns a null agent when no agent is provided (default-agent caller path)", () => {
    expect(getMessagingManifestAvailabilityContext(null)).toEqual({
      agent: null,
      supportedChannelIds: null,
    });
    expect(getMessagingManifestAvailabilityContext(undefined)).toEqual({
      agent: null,
      supportedChannelIds: null,
    });
  });

  it("returns the resolved messaging agent id and an explicit allowlist when present", () => {
    expect(
      getMessagingManifestAvailabilityContext({
        name: "openclaw",
        messagingPlatforms: ["telegram", "discord"],
      }),
    ).toEqual({
      agent: "openclaw",
      supportedChannelIds: ["telegram", "discord"],
    });
  });

  it("preserves hermes agent identity alongside platform constraints", () => {
    expect(
      getMessagingManifestAvailabilityContext({
        name: "hermes",
        messagingPlatforms: ["telegram"],
      }),
    ).toEqual({ agent: "hermes", supportedChannelIds: ["telegram"] });
  });

  it("preserves DeepAgents agent identity alongside platform constraints", () => {
    expect(
      getMessagingManifestAvailabilityContext({
        name: "langchain-deepagents-code",
        messagingPlatforms: ["discord"],
      }),
    ).toEqual({ agent: "langchain-deepagents-code", supportedChannelIds: ["discord"] });
  });

  it("distinguishes an empty allowlist from an absent one", () => {
    expect(
      getMessagingManifestAvailabilityContext({
        name: "openclaw",
        messagingPlatforms: [],
      }),
    ).toEqual({
      agent: "openclaw",
      supportedChannelIds: [],
    });
    expect(getMessagingManifestAvailabilityContext({ name: "openclaw" })).toEqual({
      agent: "openclaw",
      supportedChannelIds: null,
    });
  });

  it("returns a null agent for unknown agents and never silently defaults to openclaw", () => {
    expect(
      getMessagingManifestAvailabilityContext({
        name: "custom-agent",
        messagingPlatforms: [],
      }),
    ).toEqual({
      agent: null,
      supportedChannelIds: [],
    });
  });
});
