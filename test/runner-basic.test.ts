// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { runCapture } from "../dist/lib/runner.js";

describe("runner", () => {
  describe("runCapture", () => {
    it("captures stdout from a command", () => {
      const result = runCapture(["echo", "hello"]);
      expect(result).toBe("hello");
    });

    it("trims whitespace from output", () => {
      const result = runCapture(["echo", "  padded  "]);
      expect(result).toBe("padded");
    });

    it("returns empty string on failure with ignoreError", () => {
      const result = runCapture(["false"], { ignoreError: true });
      expect(result).toBe("");
    });

    it("throws on failure without ignoreError", () => {
      expect(() => {
        runCapture(["false"], { ignoreError: false });
      }).toThrow();
    });

    it("captures multi-line output", () => {
      const result = runCapture([process.execPath, "-e", 'process.stdout.write("line1\\nline2")']);
      expect(result).toContain("line1");
      expect(result).toContain("line2");
    });

    it("passes special characters as literal argv values", () => {
      const result = runCapture(["echo", "hello world; $(whoami)"]);
      expect(result).toBe("hello world; $(whoami)");
    });

    it("rejects shell strings", () => {
      const shellString: unknown = "echo hello";
      expect(() => {
        runCapture(shellString as readonly string[]);
      }).toThrow(/argv array/);
    });

    it("rejects shell execution for argv commands", () => {
      expect(() => {
        runCapture(["echo", "hello"], { shell: true });
      }).toThrow(/shell option is forbidden/);
    });

    it("can still run explicit shell parsing through sh argv", () => {
      const result = runCapture(["sh", "-c", "echo 'hello world'"]);
      expect(result).toBe("hello world");
    });
  });
});
