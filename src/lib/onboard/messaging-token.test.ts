// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

const TOKEN_ENV = "DISCORD_BOT_TOKEN";

describe("getMessagingToken", () => {
  afterEach(() => {
    delete process.env[TOKEN_ENV];
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
});
