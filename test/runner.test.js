// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import runnerModule from "../dist/lib/runner.js";

const { runCapture } = runnerModule;

describe("runner", () => {
  describe("runCapture", () => {
    it("captures stdout from a command", () => {
      const result = runCapture("echo hello");
      expect(result).toBe("hello");
    });

    it("trims whitespace from output", () => {
      const result = runCapture("echo '  padded  '");
      expect(result).toBe("padded");
    });

    it("returns empty string on failure with ignoreError", () => {
      const result = runCapture("false", { ignoreError: true });
      expect(result).toBe("");
    });

    it("throws on failure without ignoreError", () => {
      expect(() => {
        runCapture("false", { ignoreError: false });
      }).toThrow();
    });

    it("captures multi-line output", () => {
      const result = runCapture("printf 'line1\\nline2'");
      expect(result).toContain("line1");
      expect(result).toContain("line2");
    });

    it("handles commands with special characters", () => {
      const result = runCapture("echo 'hello world'");
      expect(result).toBe("hello world");
    });
  });
});
