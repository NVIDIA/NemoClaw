// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Security PoC — proves command injection is mitigated after the fix.
//
// These tests demonstrate:
//   1. The OLD pattern (bash -c with string interpolation) IS vulnerable
//   2. The NEW pattern (argv arrays) is NOT vulnerable
//   3. assertSafeName() rejects all dangerous inputs

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync, execFileSync } = require("node:child_process");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

// ─── Helper: simulate the OLD vulnerable run() ──────────────────
function oldRun(cmd) {
  return spawnSync("bash", ["-c", cmd], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    cwd: ROOT,
    timeout: 5000,
  });
}

// ─── Helper: simulate the NEW safe runArgv() ────────────────────
function newRunArgv(prog, args) {
  return spawnSync(prog, args, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    cwd: ROOT,
    timeout: 5000,
  });
}

// ─── Import the actual assertSafeName from the fixed code ───────
const { assertSafeName } = require("../bin/lib/runner");

// ═══════════════════════════════════════════════════════════════════
// PoC 1: Command injection via sandbox name
// ═══════════════════════════════════════════════════════════════════
describe("PoC 1: command injection via sandbox name (echo simulation)", () => {
  const maliciousName = 'test; echo INJECTED; echo';

  it("OLD pattern: bash -c IS vulnerable — injected command executes", () => {
    // This simulates what the old code did:
    //   run(`openshell sandbox connect ${sandboxName}`)
    // We use echo to safely demonstrate injection via stdout
    const cmd = `echo "getting sandbox: ${maliciousName}"`;
    const result = oldRun(cmd);

    // The semicolon splits the command — "echo INJECTED" runs separately
    assert.ok(
      result.stdout.includes("INJECTED"),
      `Expected stdout to contain "INJECTED" from injected command, got: "${result.stdout}"`
    );
    console.log("    ✗ OLD: Injected command executed! stdout =", JSON.stringify(result.stdout.trim()));
  });

  it("NEW pattern: argv array is NOT vulnerable — treats entire string as one argument", () => {
    // This simulates what the new code does:
    //   runArgv("echo", ["getting sandbox:", sandboxName])
    const result = newRunArgv("echo", ["getting sandbox:", maliciousName]);

    // The malicious string is treated as a literal argument, not parsed by shell
    assert.ok(
      result.stdout.includes(maliciousName),
      "Malicious name should appear as literal text in output"
    );
    // Verify no separate INJECTED line (it's part of the argument, not a separate command)
    const lines = result.stdout.trim().split("\n");
    assert.strictEqual(lines.length, 1, "Should be a single output line, not multiple commands");
    console.log("    ✓ NEW: Malicious name treated as literal:", JSON.stringify(result.stdout.trim()));
  });
});

// ═══════════════════════════════════════════════════════════════════
// PoC 2: Command injection via $() subshell
// ═══════════════════════════════════════════════════════════════════
describe("PoC 2: subshell injection via $()", () => {
  const payload = '$(echo PWNED)';

  it("OLD pattern: $() subshell is expanded by bash", () => {
    const cmd = `echo "value: ${payload}"`;
    const result = oldRun(cmd);

    // bash expands $(echo PWNED) → "PWNED"
    assert.ok(
      result.stdout.includes("PWNED"),
      `Expected "PWNED" from subshell expansion, got: ${result.stdout}`
    );
    console.log("    ✗ OLD: Subshell expanded! stdout =", JSON.stringify(result.stdout.trim()));
  });

  it("NEW pattern: $() is treated as literal text", () => {
    const result = newRunArgv("echo", ["value:", payload]);

    // No shell → $() is just literal text
    assert.ok(
      result.stdout.includes("$(echo PWNED)"),
      `Expected literal "$(echo PWNED)" in output, got: ${result.stdout}`
    );
    console.log("    ✓ NEW: Literal output:", JSON.stringify(result.stdout.trim()));
  });
});

// ═══════════════════════════════════════════════════════════════════
// PoC 3: Command injection via backtick
// ═══════════════════════════════════════════════════════════════════
describe("PoC 3: backtick injection", () => {
  const payload = '`echo HACKED`';

  it("OLD pattern: backtick command is executed by bash", () => {
    const cmd = `echo "name: ${payload}"`;
    const result = oldRun(cmd);

    assert.ok(
      result.stdout.includes("HACKED"),
      `Expected "HACKED" from backtick expansion, got: ${result.stdout}`
    );
    console.log("    ✗ OLD: Backtick executed! stdout =", JSON.stringify(result.stdout.trim()));
  });

  it("NEW pattern: backtick is literal text", () => {
    const result = newRunArgv("echo", ["name:", payload]);

    assert.ok(
      result.stdout.includes("`echo HACKED`"),
      `Expected literal backtick in output, got: ${result.stdout}`
    );
    console.log("    ✓ NEW: Literal output:", JSON.stringify(result.stdout.trim()));
  });
});

// ═══════════════════════════════════════════════════════════════════
// PoC 4: Pipe injection
// ═══════════════════════════════════════════════════════════════════
describe("PoC 4: pipe injection", () => {
  const payload = 'foo | echo PIPED';

  it("OLD pattern: pipe creates a second command", () => {
    const cmd = `echo ${payload}`;
    const result = oldRun(cmd);

    assert.ok(
      result.stdout.includes("PIPED"),
      `Expected "PIPED" from pipe injection, got: ${result.stdout}`
    );
    console.log("    ✗ OLD: Pipe injected! stdout =", JSON.stringify(result.stdout.trim()));
  });

  it("NEW pattern: pipe is literal text", () => {
    const result = newRunArgv("echo", [payload]);

    assert.ok(
      result.stdout.includes("foo | echo PIPED"),
      `Expected literal pipe in output, got: ${result.stdout}`
    );
    console.log("    ✓ NEW: Literal output:", JSON.stringify(result.stdout.trim()));
  });
});

// ═══════════════════════════════════════════════════════════════════
// PoC 5: && chain injection (the deploy attack vector)
// ═══════════════════════════════════════════════════════════════════
describe("PoC 5: && chain injection (deploy attack vector)", () => {
  const payload = 'mybox && echo CHAIN_EXECUTED && echo';

  it("OLD pattern: && chains a new command", () => {
    // Simulates: run(`brev create ${name} --gpu "..."`)
    const cmd = `echo brev create ${payload} --gpu "a100"`;
    const result = oldRun(cmd);

    assert.ok(
      result.stdout.includes("CHAIN_EXECUTED"),
      `Expected "CHAIN_EXECUTED" from && injection, got: ${result.stdout}`
    );
    console.log("    ✗ OLD: Chain executed! stdout =", JSON.stringify(result.stdout.trim()));
  });

  it("NEW pattern: && is literal text in the argument", () => {
    const result = newRunArgv("echo", ["brev", "create", payload, "--gpu", "a100"]);

    assert.ok(
      result.stdout.includes("&& echo CHAIN_EXECUTED"),
      `Expected literal && in output, got: ${result.stdout}`
    );
    console.log("    ✓ NEW: Literal output:", JSON.stringify(result.stdout.trim()));
  });
});

// ═══════════════════════════════════════════════════════════════════
// PoC 6: assertSafeName blocks all attack payloads
// ═══════════════════════════════════════════════════════════════════
describe("PoC 6: assertSafeName validation", () => {
  const maliciousNames = [
    { input: 'foo; id', label: "semicolon injection" },
    { input: 'foo && whoami', label: "&& chain" },
    { input: '$(cat /etc/passwd)', label: "subshell" },
    { input: '`id`', label: "backtick" },
    { input: 'foo | cat /etc/shadow', label: "pipe" },
    { input: '../../../etc/passwd', label: "path traversal" },
    { input: 'foo\nid', label: "newline injection" },
    { input: "foo'id", label: "single quote" },
    { input: 'foo"id', label: "double quote" },
    { input: '', label: "empty string" },
    { input: '-flag', label: "starts with dash (argument injection)" },
  ];

  for (const { input, label } of maliciousNames) {
    it(`rejects "${label}": ${JSON.stringify(input)}`, () => {
      // assertSafeName calls process.exit(1) on failure.
      // We test by running it in a subprocess.
      const result = spawnSync("node", [
        "-e",
        `require("./bin/lib/runner").assertSafeName(${JSON.stringify(input)}, "test")`,
      ], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        cwd: ROOT,
        timeout: 5000,
      });

      assert.notStrictEqual(result.status, 0, `Expected exit code != 0 for ${label}`);
      console.log(`    ✓ Rejected: ${label} → exit code ${result.status}`);
    });
  }

  const safeNames = [
    "my-assistant",
    "nemoclaw",
    "test_sandbox_1",
    "NemoClaw-Prod-2026",
    "a",
  ];

  for (const name of safeNames) {
    it(`accepts safe name: "${name}"`, () => {
      const result = spawnSync("node", [
        "-e",
        `require("./bin/lib/runner").assertSafeName(${JSON.stringify(name)}, "test"); console.log("OK")`,
      ], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        cwd: ROOT,
        timeout: 5000,
      });

      assert.strictEqual(result.status, 0, `Expected exit code 0 for "${name}"`);
      console.log(`    ✓ Accepted: "${name}"`);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════
// PoC 7: Realistic attack — nemoclaw CLI rejects malicious names
// ═══════════════════════════════════════════════════════════════════
describe("PoC 7: nemoclaw CLI rejects malicious deploy name", () => {
  it('rejects `nemoclaw deploy "foo;id"` with validation error', () => {
    const result = spawnSync("node", [
      path.join(ROOT, "bin", "nemoclaw.js"),
      "deploy",
      "foo;id",
    ], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      cwd: ROOT,
      timeout: 10000,
    });

    assert.notStrictEqual(result.status, 0, "Expected non-zero exit for malicious name");
    const output = result.stdout + result.stderr;
    assert.ok(
      output.includes("Invalid") || output.includes("invalid"),
      `Expected validation error message, got: ${output}`
    );
    console.log("    ✓ CLI rejected malicious deploy name:", JSON.stringify((result.stderr || result.stdout).trim().split("\n")[0]));
  });

  it('rejects `nemoclaw deploy "$(whoami)"` with validation error', () => {
    const result = spawnSync("node", [
      path.join(ROOT, "bin", "nemoclaw.js"),
      "deploy",
      "$(whoami)",
    ], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      cwd: ROOT,
      timeout: 10000,
    });

    assert.notStrictEqual(result.status, 0, "Expected non-zero exit for subshell payload");
    const output = result.stdout + result.stderr;
    assert.ok(
      output.includes("Invalid") || output.includes("invalid"),
      `Expected validation error, got: ${output}`
    );
    console.log("    ✓ CLI rejected subshell payload:", JSON.stringify((result.stderr || result.stdout).trim().split("\n")[0]));
  });
});
