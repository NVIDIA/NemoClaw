// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { maskApiKey } from "../nemoclaw/dist/onboard/validate.js";

describe("maskApiKey", () => {
  it("masks short keys entirely", () => {
    expect(maskApiKey("abcd")).toBe("****");
    expect(maskApiKey("12345678")).toBe("****");
  });

  it("preserves last 4 chars of long keys", () => {
    expect(maskApiKey("abcdefghij")).toBe("****ghij");
  });

  it("handles nvapi- prefix", () => {
    expect(maskApiKey("nvapi-abcdefghijklmnop")).toBe("nvapi-****mnop");
  });

  it("handles nvapi- prefix with exact boundary", () => {
    // "nvapi-abc" is 9 chars (> 8), last4 = "-abc"
    expect(maskApiKey("nvapi-abc")).toBe("nvapi-****-abc");
    const result = maskApiKey("nvapi-abcdefghi");
    expect(result.startsWith("nvapi-****")).toBe(true);
    expect(result.endsWith("fghi")).toBe(true);
  });

  it("masks non-nvapi long keys", () => {
    const result = maskApiKey("sk-1234567890abcdef");
    expect(result).toBe("****cdef");
  });

  it("masks empty-ish keys", () => {
    expect(maskApiKey("")).toBe("****");
    expect(maskApiKey("ab")).toBe("****");
  });
});
