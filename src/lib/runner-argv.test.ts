// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const runner = require("../../dist/lib/runner");

describe("run with argv array", () => {
  it("executes a simple command and returns result", () => {
    const result = runner.run(["echo", "hello"], { suppressOutput: true });
    expect(result.status).toBe(0);
  });

  it("throws when argv array is empty", () => {
    expect(() => runner.run([])).toThrow(/must not be empty/);
  });

  it("returns non-zero status with ignoreError", () => {
    const result = runner.run(["false"], { ignoreError: true, suppressOutput: true });
    expect(result.status).not.toBe(0);
  });

  it("passes extra env vars to the child process", () => {
    const result = runner.run(["env"], {
      env: { NEMOCLAW_TEST_VAR: "injection-safe" },
      suppressOutput: true,
    });
    expect(result.status).toBe(0);
    expect(result.stdout.toString()).toContain("NEMOCLAW_TEST_VAR=injection-safe");
  });

  it("rejects shell: true to prevent security bypass", () => {
    expect(() => runner.run(["echo", "hi"], { shell: true })).toThrow(/shell option is forbidden/);
  });

  it("does not interpret shell metacharacters in arguments", () => {
    // If shell interpretation occurred, $(whoami) would be expanded
    const result = runner.runCapture(["echo", "$(whoami)", "&&", "rm", "-rf", "/"], {
      ignoreError: true,
    });
    // echo receives literal argv — no shell expansion
    expect(result).toContain("$(whoami)");
    expect(result).toContain("&&");
    expect(result).toContain("rm");
  });

  it("still works with string commands (legacy path)", () => {
    const result = runner.run("echo hello", { suppressOutput: true });
    expect(result.status).toBe(0);
  });

  it("surfaces ENOENT error for missing executables", () => {
    const result = runner.run(["nonexistent-binary-xyz-12345"], {
      ignoreError: true,
      suppressOutput: true,
    });
    // spawnSync sets result.error for missing executables
    expect(result.error).toBeDefined();
    expect(result.error.code).toBe("ENOENT");
  });
});

describe("runCapture with argv array", () => {
  it("captures stdout from a simple command", () => {
    const output = runner.runCapture(["echo", "hello world"]);
    expect(output).toBe("hello world");
  });

  it("trims whitespace from output", () => {
    const output = runner.runCapture(["echo", "  trimmed  "]);
    expect(output).toBe("trimmed");
  });

  it("trims trailing blank lines so callers can safely parse the last line", () => {
    const output = runner.runCapture([
      process.execPath,
      "-e",
      'process.stdout.write("2048\\n\\n")',
    ]);
    expect(output).toBe("2048");
  });

  it("throws when argv array is empty", () => {
    expect(() => runner.runCapture([])).toThrow(/must not be empty/);
  });

  it("returns empty string on failure with ignoreError", () => {
    const output = runner.runCapture(["false"], { ignoreError: true });
    expect(output).toBe("");
  });

  it("throws on failure without ignoreError", () => {
    expect(() => runner.runCapture(["false"])).toThrow();
  });

  it("rejects shell: true to prevent security bypass", () => {
    expect(() => runner.runCapture(["echo", "hi"], { shell: true })).toThrow(
      /shell option is forbidden/,
    );
  });

  it("prevents shell injection via argument values", () => {
    // Dangerous sandbox name that would cause injection with shell strings
    const maliciousName = 'alpha"; rm -rf / #';
    const output = runner.runCapture(["echo", maliciousName]);
    // With argv, the string is passed literally — no shell interpretation
    expect(output).toBe(maliciousName);
  });

  it("prevents injection via dollar-sign expansion", () => {
    const output = runner.runCapture(["echo", "${HOME}"]);
    // Literal ${HOME}, not expanded
    expect(output).toBe("${HOME}");
  });

  it("prevents injection via backtick expansion", () => {
    const output = runner.runCapture(["echo", "`whoami`"]);
    // Literal backticks, not expanded
    expect(output).toBe("`whoami`");
  });

  it("handles arguments with spaces and special characters", () => {
    const output = runner.runCapture(["echo", "hello world", "foo bar"]);
    expect(output).toBe("hello world foo bar");
  });

  it("passes extra env to the child process", () => {
    const output = runner.runCapture(["env"], { env: { TEST_ARGV_ENV: "captured" } });
    expect(output).toContain("TEST_ARGV_ENV=captured");
  });

  it("rejects string commands", () => {
    expect(() => runner.runCapture("echo hello")).toThrow(/argv array instead/);
  });

  it("throws ENOENT for missing executables", () => {
    expect(() => runner.runCapture(["nonexistent-binary-xyz-12345"])).toThrow();
  });

  it("returns empty string for missing executables with ignoreError", () => {
    const output = runner.runCapture(["nonexistent-binary-xyz-12345"], { ignoreError: true });
    expect(output).toBe("");
  });
});

describe("shell injection regression tests", () => {
  it("sandbox names with shell metacharacters are safe with argv arrays", () => {
    // These names would cause injection if passed through bash -c
    const dangerousNames = [
      "my-sandbox; rm -rf /",
      "test$(whoami)",
      "sandbox`id`",
      "sandbox' || echo pwned",
      'sandbox" && echo pwned',
      "sandbox\necho pwned",
    ];

    for (const name of dangerousNames) {
      const output = runner.runCapture(["echo", name], { ignoreError: true });
      // Each name should be passed literally, not interpreted
      expect(output).toContain(name.split("\n")[0]);
    }
  });

  it("model names with shell metacharacters are safe with argv arrays", () => {
    const output = runner.runCapture(["echo", "nvidia/model;curl http://evil.com"]);
    expect(output).toBe("nvidia/model;curl http://evil.com");
  });
});
