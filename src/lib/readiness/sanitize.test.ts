// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { sanitizeReadinessText } from "./sanitize.js";

describe("sanitizeReadinessText", () => {
  it.each([
    [
      "username and password",
      "https://service-user:service-password@example.com/path",
      "https://example.com/path",
      "service-password",
      "service-user:",
    ],
    [
      "userinfo only",
      "https://service-token@example.com/path",
      "https://example.com/path",
      "service-token",
      "service-token@",
    ],
    [
      "malformed URL fallback",
      "https://fallback-user:fallback-password@[not-an-ip/path",
      "https://[not-an-ip/path",
      "fallback-password",
      "fallback-user:",
    ],
  ])("redacts URL credentials for %s", (_case, value, expected, credential, userinfo) => {
    const result = sanitizeReadinessText(value, 1024);

    expect(result).toBe(expected);
    expect(result).not.toContain(credential);
    expect(result).not.toContain(userinfo);
  });
});
