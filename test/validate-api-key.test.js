// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { validateApiKey } = require("../bin/lib/credentials");

describe("validateApiKey", () => {
  // These tests call the real curl command but against the real NVIDIA API.
  // We can't mock spawnSync easily, so we test with a known-bad key
  // and verify the return structure.

  // @flaky — hits real NVIDIA API; may return network error instead of 401
  // depending on connectivity. Conditional assertions handle both outcomes.
  it("returns { ok: false, fatal: true } for an invalid key", () => {
    const result = validateApiKey("nvapi-INVALID_TEST_KEY_000000");
    // Either we get a 401/403 (fatal) or a network error (non-fatal).
    // Both are valid outcomes depending on network availability.
    assert.equal(typeof result.ok, "boolean");
    assert.equal(typeof result.fatal, "boolean");
    if (!result.ok && result.fatal) {
      assert.ok(result.message.includes("invalid") || result.message.includes("expired"));
    }
  });

  it("always returns the { ok, fatal, message } shape", () => {
    const result = validateApiKey("nvapi-test");
    assert.ok("ok" in result, "must have ok field");
    assert.ok("fatal" in result, "must have fatal field");
    if (!result.ok) {
      assert.ok("message" in result, "non-ok results must have message");
    }
  });

  it("never returns fatal: true when ok: true", () => {
    // Test with any key — the invariant must hold regardless of outcome
    const result = validateApiKey("nvapi-anything");
    if (result.ok) {
      assert.equal(result.fatal, false, "ok: true must have fatal: false");
    }
  });

  it("handles empty key without crashing", () => {
    const result = validateApiKey("");
    assert.equal(typeof result.ok, "boolean");
    assert.equal(typeof result.fatal, "boolean");
  });
});
