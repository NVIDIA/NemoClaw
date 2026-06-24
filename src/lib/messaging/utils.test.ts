// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { getMessagingManifestAvailabilityContext, toMessagingAgentId } from "./utils";

describe("toMessagingAgentId", () => {
  it("returns 'hermes' for hermes-named agents", () => {
    expect(toMessagingAgentId({ name: "hermes" })).toBe("hermes");
  });

  it("defaults to 'openclaw' for any other name (including non-OpenClaw runtimes)", () => {
    expect(toMessagingAgentId({ name: "openclaw" })).toBe("openclaw");
    expect(toMessagingAgentId({ name: "langchain-deepagents-code" })).toBe("openclaw");
    expect(toMessagingAgentId(null)).toBe("openclaw");
    expect(toMessagingAgentId(undefined)).toBe("openclaw");
  });
});

describe("getMessagingManifestAvailabilityContext", () => {
  it("preserves an explicit empty messagingPlatforms array as a deny-all signal", () => {
    expect(
      getMessagingManifestAvailabilityContext({
        name: "langchain-deepagents-code",
        messagingPlatforms: [],
      }),
    ).toEqual({ agent: "openclaw", supportedChannelIds: [] });
  });

  it("forwards a populated messagingPlatforms array verbatim", () => {
    expect(
      getMessagingManifestAvailabilityContext({
        name: "openclaw",
        messagingPlatforms: ["telegram", "slack"],
      }),
    ).toEqual({ agent: "openclaw", supportedChannelIds: ["telegram", "slack"] });
  });

  it("falls back to null (no constraint) when messagingPlatforms is missing", () => {
    expect(getMessagingManifestAvailabilityContext({ name: "openclaw" })).toEqual({
      agent: "openclaw",
      supportedChannelIds: null,
    });
    expect(getMessagingManifestAvailabilityContext(null)).toEqual({
      agent: "openclaw",
      supportedChannelIds: null,
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
});
