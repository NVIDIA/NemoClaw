// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Tests for blueprint digest verification — ensures fail-closed behavior
// when digest is missing, empty, or mismatched.

import { describe, it, expect } from "vitest";
import path from "node:path";

const verifyDigestPath = path.join(import.meta.dirname, "..", "bin", "lib", "verify-digest");

describe("blueprint digest verification", () => {
  it("computeBlueprintDigest returns a 64-char hex string", () => {
    const { computeBlueprintDigest } = require(verifyDigestPath);
    const digest = computeBlueprintDigest();
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("computeBlueprintDigest is deterministic", () => {
    const { computeBlueprintDigest } = require(verifyDigestPath);
    const d1 = computeBlueprintDigest();
    const d2 = computeBlueprintDigest();
    expect(d1).toBe(d2);
  });

  it("readExpectedDigest returns the digest field from blueprint.yaml", () => {
    const { readExpectedDigest } = require(verifyDigestPath);
    const digest = readExpectedDigest();
    expect(typeof digest).toBe("string");
  });

  it("verifyBlueprintDigest fails closed on empty digest", () => {
    const { verifyBlueprintDigest, readExpectedDigest } = require(verifyDigestPath);
    const expected = readExpectedDigest();

    // The shipped blueprint.yaml has digest: "" — verification must fail
    if (!expected || expected.trim() === "") {
      const result = verifyBlueprintDigest();
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/missing or empty/);
    }
  });

  it("verifyBlueprintDigest respects --skip-verification opt-out", () => {
    const { verifyBlueprintDigest } = require(verifyDigestPath);
    const result = verifyBlueprintDigest({ skipVerification: true });
    expect(result.valid).toBe(true);
    expect(result.reason).toMatch(/skipped/);
  });

  it("empty string digest must not pass verification", () => {
    // Regression: if (digest && digest !== actual) was the original bug —
    // empty string is falsy in JS, causing silent bypass
    const { verifyBlueprintDigest } = require(verifyDigestPath);
    const result = verifyBlueprintDigest();
    // With digest: "" in blueprint.yaml, this MUST fail
    expect(result.valid).toBe(false);
  });
});
