// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { validateApiKey } = require("../bin/lib/credentials");

describe("validateApiKey", () => {
  // These tests call the real curl command against the real NVIDIA API.
  // The /v1/models endpoint may return 200 even for invalid keys (public listing),
  // so we test the return shape and invariants, not specific ok/fatal values.

  // @flaky — hits real NVIDIA API; outcome depends on network + endpoint behavior.
  it("returns a well-formed result for any key", () => {
    const result = validateApiKey("nvapi-INVALID_TEST_KEY_000000");
    assert.equal(typeof result.ok, "boolean");
    assert.equal(typeof result.fatal, "boolean");
    assert.ok("message" in result, "must have message field");
  });

  it("always returns the { ok, fatal, message } shape", () => {
    const result = validateApiKey("nvapi-test");
    assert.ok("ok" in result, "must have ok field");
    assert.ok("fatal" in result, "must have fatal field");
    assert.ok("message" in result, "must have message field");
  });

  it("never returns fatal: true when ok: true", () => {
    const result = validateApiKey("nvapi-anything");
    if (result.ok) {
      assert.equal(result.fatal, false, "ok: true must have fatal: false");
    }
  });

  it("handles empty key without crashing", () => {
    const result = validateApiKey("");
    assert.equal(typeof result.ok, "boolean");
    assert.equal(typeof result.fatal, "boolean");
    assert.ok("message" in result, "must have message field");
  });
});
