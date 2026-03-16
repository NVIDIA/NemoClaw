// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { validateName } = require("../bin/lib/runner");

describe("validateName", () => {
  it("accepts simple alphanumeric names", () => {
    assert.doesNotThrow(() => validateName("my-assistant"));
    assert.doesNotThrow(() => validateName("sandbox1"));
    assert.doesNotThrow(() => validateName("test.sandbox"));
    assert.doesNotThrow(() => validateName("my_sandbox"));
    assert.doesNotThrow(() => validateName("a"));
  });

  it("accepts names up to 63 characters", () => {
    assert.doesNotThrow(() => validateName("a".repeat(63)));
  });

  it("rejects names longer than 63 characters", () => {
    assert.throws(() => validateName("a".repeat(64)), /at most 63/);
  });

  it("rejects empty or missing names", () => {
    assert.throws(() => validateName(""), /required/);
    assert.throws(() => validateName(null), /required/);
    assert.throws(() => validateName(undefined), /required/);
  });

  it("rejects names starting with non-alphanumeric", () => {
    assert.throws(() => validateName("-bad"), /Invalid/);
    assert.throws(() => validateName(".bad"), /Invalid/);
    assert.throws(() => validateName("_bad"), /Invalid/);
  });

  it("rejects shell metacharacters", () => {
    assert.throws(() => validateName("test; echo pwned"), /Invalid/);
    assert.throws(() => validateName("$(whoami)"), /Invalid/);
    assert.throws(() => validateName("test`id`"), /Invalid/);
    assert.throws(() => validateName("test|cat"), /Invalid/);
    assert.throws(() => validateName("test&bg"), /Invalid/);
    assert.throws(() => validateName("test>file"), /Invalid/);
    assert.throws(() => validateName("test name"), /Invalid/);
  });

  it("uses custom label in error messages", () => {
    assert.throws(
      () => validateName("b@d", "Instance name"),
      /Invalid instance name/
    );
  });
});
