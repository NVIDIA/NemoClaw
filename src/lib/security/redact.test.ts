// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { redactForLog } from "./redact.js";

describe("redactForLog", () => {
  it("redacts sensitive object keys recursively while preserving safe fields", () => {
    const result = redactForLog({
      provider: "openai",
      apiKey: "sk-" + "a".repeat(24),
      nested: {
        model: "gpt-4o",
        refreshToken: "refresh-token-value",
      },
      items: [
        { name: "safe" },
        { credentialEnv: "NVIDIA_API_KEY" },
      ],
    });

    expect(result).toEqual({
      provider: "openai",
      apiKey: "<REDACTED>",
      nested: {
        model: "gpt-4o",
        refreshToken: "<REDACTED>",
      },
      items: [
        { name: "safe" },
        { credentialEnv: "<REDACTED>" },
      ],
    });
  });

  it("redacts known secret patterns inside otherwise safe strings", () => {
    const result = redactForLog({
      message: "upstream returned Authorization: Bearer abcdefghijklmnop",
      url: "https://example.test/path?access_token=abcdefghijklmnop",
    });

    expect(result).toEqual({
      message: "upstream returned Authorization: Bearer <REDACTED>",
      url: "https://example.test/path?access_token=<REDACTED>",
    });
  });

  it("does not recurse forever on circular objects", () => {
    const input: Record<string, unknown> = { name: "root" };
    input.self = input;

    expect(redactForLog(input)).toEqual({
      name: "root",
      self: "[Circular]",
    });
  });
});
