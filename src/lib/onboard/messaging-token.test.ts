// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

const TOKEN_ENV = "DISCORD_BOT_TOKEN";
const SLACK_BOT_ENV = "SLACK_BOT_TOKEN";

describe("getMessagingToken", () => {
  afterEach(() => {
    delete process.env[TOKEN_ENV];
    delete process.env[SLACK_BOT_ENV];
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("honors an explicitly exported token before a stored credential", async () => {
    vi.doMock("../credentials/store", () => ({
      getCredential: vi.fn(() => "stored-token"),
      normalizeCredentialValue: (value: unknown) =>
        typeof value === "string" ? value.replace(/\r/g, "").trim() : "",
    }));
    process.env[TOKEN_ENV] = "  exported-token  ";

    const { getMessagingToken } = await import("./messaging-token");

    expect(getMessagingToken(TOKEN_ENV)).toBe("exported-token");
  });

  it("falls back to the stored credential when the env token is empty", async () => {
    vi.doMock("../credentials/store", () => ({
      getCredential: vi.fn(() => "stored-token"),
      normalizeCredentialValue: (value: unknown) =>
        typeof value === "string" ? value.replace(/\r/g, "").trim() : "",
    }));
    process.env[TOKEN_ENV] = "  ";

    const { getMessagingToken } = await import("./messaging-token");

    expect(getMessagingToken(TOKEN_ENV)).toBe("stored-token");
  });

  it("returns null for invalid formatted channel tokens", async () => {
    vi.doMock("../credentials/store", () => ({
      getCredential: vi.fn(() => null),
      normalizeCredentialValue: (value: unknown) =>
        typeof value === "string" ? value.replace(/\r/g, "").trim() : "",
    }));
    process.env[SLACK_BOT_ENV] = "abcd";

    const { KNOWN_CHANNELS } = await import("../sandbox/channels");
    const { getValidatedMessagingTokenByEnvKey } = await import("./messaging-token");

    expect(getValidatedMessagingTokenByEnvKey([KNOWN_CHANNELS.slack], SLACK_BOT_ENV)).toBeNull();
  });

  it("returns null instead of raw tokens for unknown env keys", async () => {
    vi.doMock("../credentials/store", () => ({
      getCredential: vi.fn(() => "raw-token"),
      normalizeCredentialValue: (value: unknown) =>
        typeof value === "string" ? value.replace(/\r/g, "").trim() : "",
    }));

    const { KNOWN_CHANNELS } = await import("../sandbox/channels");
    const { getValidatedMessagingToken, getValidatedMessagingTokenByEnvKey } = await import(
      "./messaging-token"
    );

    expect(getValidatedMessagingToken(KNOWN_CHANNELS.slack, "UNKNOWN_TOKEN")).toBeNull();
    expect(getValidatedMessagingTokenByEnvKey([KNOWN_CHANNELS.slack], "UNKNOWN_TOKEN")).toBeNull();
  });
});
