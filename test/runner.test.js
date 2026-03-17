// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { runCapture } = require("../bin/lib/runner");

describe("runner", () => {
  describe("runCapture", () => {
    it("captures stdout from a command", () => {
      const result = runCapture("echo hello");
      assert.equal(result, "hello");
    });

    it("trims whitespace from output", () => {
      const result = runCapture("echo '  padded  '");
      assert.equal(result, "padded");
    });

    it("returns empty string on failure with ignoreError", () => {
      const result = runCapture("false", { ignoreError: true });
      assert.equal(result, "");
    });

    it("throws on failure without ignoreError", () => {
      assert.throws(() => {
        runCapture("false", { ignoreError: false });
      });
    });

    it("captures multi-line output", () => {
      const result = runCapture("printf 'line1\\nline2'");
      assert.ok(result.includes("line1"));
      assert.ok(result.includes("line2"));
    });

    it("handles commands with special characters", () => {
      const result = runCapture("echo 'hello world'");
      assert.equal(result, "hello world");
    });
  });
});
