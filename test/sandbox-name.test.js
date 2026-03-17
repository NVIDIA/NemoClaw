// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { validateSandboxName } = require("../bin/lib/onboard");

describe("validateSandboxName", () => {
  it("accepts simple names", () => {
    assert.ok(validateSandboxName("my-assistant"));
    assert.ok(validateSandboxName("sandbox1"));
    assert.ok(validateSandboxName("test_box"));
  });

  it("accepts hyphenated names (WSL regression)", () => {
    assert.ok(validateSandboxName("my-assistant"));
    assert.ok(validateSandboxName("dev-sandbox-01"));
    assert.ok(validateSandboxName("a-b-c-d"));
  });

  it("rejects empty or non-string input", () => {
    assert.equal(validateSandboxName(""), false);
    assert.equal(validateSandboxName(null), false);
    assert.equal(validateSandboxName(undefined), false);
  });

  it("rejects names starting with non-letter", () => {
    assert.equal(validateSandboxName("1sandbox"), false);
    assert.equal(validateSandboxName("-sandbox"), false);
    assert.equal(validateSandboxName("_sandbox"), false);
  });

  it("rejects names with spaces or shell metacharacters", () => {
    assert.equal(validateSandboxName("my sandbox"), false);
    assert.equal(validateSandboxName("sandbox;rm -rf"), false);
    assert.equal(validateSandboxName("test$(whoami)"), false);
    assert.equal(validateSandboxName("name`cmd`"), false);
    assert.equal(validateSandboxName("a b"), false);
  });

  it("rejects names that could cause argument injection", () => {
    assert.equal(validateSandboxName("--policy"), false);
    assert.equal(validateSandboxName("-wait"), false);
  });

  it("rejects excessively long names", () => {
    assert.equal(validateSandboxName("a".repeat(64)), false);
    assert.ok(validateSandboxName("a".repeat(63)));
  });
});
