// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { maskApiKey } = require("../nemoclaw/dist/onboard/validate.js");

describe("maskApiKey", () => {
  it("masks short keys entirely", () => {
    assert.equal(maskApiKey("abcd"), "****");
    assert.equal(maskApiKey("12345678"), "****");
  });

  it("preserves last 4 chars of long keys", () => {
    assert.equal(maskApiKey("abcdefghij"), "****ghij");
  });

  it("handles nvapi- prefix", () => {
    assert.equal(maskApiKey("nvapi-abcdefghijklmnop"), "nvapi-****mnop");
  });

  it("handles nvapi- prefix with exact boundary", () => {
    // "nvapi-abc" is 9 chars (> 8), last4 = "-abc"
    assert.equal(maskApiKey("nvapi-abc"), "nvapi-****-abc");
    const result = maskApiKey("nvapi-abcdefghi");
    assert.ok(result.startsWith("nvapi-****"));
    assert.ok(result.endsWith("fghi"));
  });

  it("masks non-nvapi long keys", () => {
    const result = maskApiKey("sk-1234567890abcdef");
    assert.equal(result, "****cdef");
  });

  it("masks empty-ish keys", () => {
    assert.equal(maskApiKey(""), "****");
    assert.equal(maskApiKey("ab"), "****");
  });
});
