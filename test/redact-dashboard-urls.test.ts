// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { redact } from "../dist/lib/redact";

describe("redact dashboard URLs", () => {
  it("redacts URLs with #token=<hex> fragment", () => {
    const url = "http://127.0.0.1:8080/#token=abc123def456";
    const redacted = redact(url);
    expect(redacted).not.toContain("abc123def456");
    expect(redacted).toContain("abc1");
  });

  it("leaves URLs without token unchanged", () => {
    const url = "http://127.0.0.1:8080/";
    const redacted = redact(url);
    expect(redacted).toBe(url);
  });

  it("redacts URLs with long hex tokens", () => {
    const longToken = "a".repeat(64);
    const url = `http://127.0.0.1:8080/#token=${longToken}`;
    const redacted = redact(url);
    expect(redacted).not.toContain(longToken);
    expect(redacted).toContain("aaaa****");
  });
});
