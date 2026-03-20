// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

// Import the validateSandboxName function from onboard.js
// We need to extract it for testing
const fs = require("fs");
const path = require("path");

// Read and evaluate the onboard.js file to extract the validateSandboxName function
const onboardPath = path.join(__dirname, "..", "bin", "lib", "onboard.js");
const onboardCode = fs.readFileSync(onboardPath, "utf-8");

// Extract just the validateSandboxName function using regex
const validateSandboxNameMatch = onboardCode.match(
  /function validateSandboxName\(name\) \{[\s\S]*?\n\}/
);
assert.ok(validateSandboxNameMatch, "validateSandboxName function not found");

// Create a function from the extracted code
const validateSandboxName = new Function(
  "return " + validateSandboxNameMatch[0]
)();

describe("validateSandboxName", () => {
  it("accepts valid lowercase names", () => {
    const result = validateSandboxName("my-assistant");
    assert.equal(result.valid, true);
    assert.equal(result.normalized, "my-assistant");
  });

  it("normalizes uppercase letters to lowercase", () => {
    const result = validateSandboxName("My-Assistant");
    assert.equal(result.valid, true);
    assert.equal(result.normalized, "my-assistant");
  });

  it("normalizes all uppercase names to lowercase", () => {
    const result = validateSandboxName("MY-ASSISTANT");
    assert.equal(result.valid, true);
    assert.equal(result.normalized, "my-assistant");
  });

  it("accepts names with numbers", () => {
    const result = validateSandboxName("assistant-123");
    assert.equal(result.valid, true);
    assert.equal(result.normalized, "assistant-123");
  });

  it("accepts names starting with numbers", () => {
    const result = validateSandboxName("123-assistant");
    assert.equal(result.valid, true);
    assert.equal(result.normalized, "123-assistant");
  });

  it("rejects names with special characters", () => {
    const result = validateSandboxName("my_assistant");
    assert.equal(result.valid, false);
    assert.ok(result.error.includes("lowercase letters, numbers, and hyphens"));
  });

  it("rejects names with spaces", () => {
    const result = validateSandboxName("my assistant");
    assert.equal(result.valid, false);
  });

  it("rejects empty names", () => {
    const result = validateSandboxName("");
    assert.equal(result.valid, false);
  });

  it("rejects names longer than 64 characters", () => {
    const longName = "a".repeat(65);
    const result = validateSandboxName(longName);
    assert.equal(result.valid, false);
    assert.ok(result.error.includes("64 characters"));
  });

  it("accepts names exactly 64 characters", () => {
    const name64 = "a".repeat(64);
    const result = validateSandboxName(name64);
    assert.equal(result.valid, true);
    assert.equal(result.normalized, name64);
  });

  it("normalizes mixed case with numbers and hyphens", () => {
    const result = validateSandboxName("My-Assistant-123-Test");
    assert.equal(result.valid, true);
    assert.equal(result.normalized, "my-assistant-123-test");
  });
});
