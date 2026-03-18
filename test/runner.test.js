// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Tests for runner.js — safe execution primitives.
// These tests verify:
//   1. runArgv / runCaptureArgv exist and work correctly
//   2. assertSafeName rejects dangerous identifiers
//   3. opts.env does NOT overwrite inherited process.env (the overwrite bug)
//   4. runCaptureArgv never invokes a shell (injection proof)
//   5. run() does not consume installer stdin (upstream regression)
//   6. runInteractive() uses inherited stdio
//
// See: https://github.com/NVIDIA/NemoClaw/issues/325

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const childProcess = require("node:child_process");
const { spawnSync } = childProcess;

const runnerPath = path.join(__dirname, "..", "bin", "lib", "runner");

const {
  run,
  runArgv,
  runCapture,
  runCaptureArgv,
  assertSafeName,
} = require("../bin/lib/runner");

// ── stdin isolation (upstream tests) ─────────────────────────────

describe("runner helpers", () => {
  it("does not let child commands consume installer stdin", () => {
    const script = `
      const { run } = require(${JSON.stringify(runnerPath)});
      process.stdin.setEncoding("utf8");
      run("cat >/dev/null || true");
      process.stdin.once("data", (chunk) => {
        process.stdout.write(chunk);
      });
    `;

    const result = spawnSync("node", ["-e", script], {
      cwd: path.join(__dirname, ".."),
      encoding: "utf-8",
      input: "preserved-answer\n",
    });

    assert.equal(result.status, 0);
    assert.equal(result.stdout, "preserved-answer\n");
  });

  it("uses inherited stdio for interactive commands only", () => {
    const calls = [];
    const originalSpawnSync = childProcess.spawnSync;
    childProcess.spawnSync = (...args) => {
      calls.push(args);
      return { status: 0 };
    };

    try {
      delete require.cache[require.resolve(runnerPath)];
      const { run, runInteractive } = require(runnerPath);
      run("echo noninteractive");
      runInteractive("echo interactive");
    } finally {
      childProcess.spawnSync = originalSpawnSync;
      delete require.cache[require.resolve(runnerPath)];
    }

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0][2].stdio, ["ignore", "inherit", "inherit"]);
    assert.equal(calls[1][2].stdio, "inherit");
  });
});

// ── assertSafeName ────────────────────────────────────────────────

describe("assertSafeName", () => {
  it("accepts valid lowercase alphanumeric names", () => {
    assertSafeName("my-assistant");
    assertSafeName("nemoclaw");
    assertSafeName("test123");
    assertSafeName("sandbox-1");
    assertSafeName("a");
  });

  it("accepts names with underscores and hyphens", () => {
    assertSafeName("my_sandbox");
    assertSafeName("test_sandbox_1");
    assertSafeName("a-b_c");
  });

  it("accepts uppercase names (SAFE_NAME_RE allows [a-zA-Z0-9])", () => {
    assertSafeName("MyAssistant");
    assertSafeName("TestSandbox1");
  });

  it("rejects names with semicolons (command injection)", () => {
    const origExit = process.exit;
    let exitCalled = false;
    process.exit = () => { exitCalled = true; throw new Error("process.exit"); };
    try { assertSafeName("foo;bar"); } catch {}
    process.exit = origExit;
    assert.ok(exitCalled, "assertSafeName should reject names with semicolons");
  });

  it("rejects names with shell command substitution $()", () => {
    const origExit = process.exit;
    let exitCalled = false;
    process.exit = () => { exitCalled = true; throw new Error("process.exit"); };
    try { assertSafeName("$(whoami)"); } catch {}
    process.exit = origExit;
    assert.ok(exitCalled, "assertSafeName should reject $() patterns");
  });

  it("rejects names with backticks", () => {
    const origExit = process.exit;
    let exitCalled = false;
    process.exit = () => { exitCalled = true; throw new Error("process.exit"); };
    try { assertSafeName("`id`"); } catch {}
    process.exit = origExit;
    assert.ok(exitCalled, "assertSafeName should reject backtick patterns");
  });

  it("rejects names with pipe characters", () => {
    const origExit = process.exit;
    let exitCalled = false;
    process.exit = () => { exitCalled = true; throw new Error("process.exit"); };
    try { assertSafeName("foo|bar"); } catch {}
    process.exit = origExit;
    assert.ok(exitCalled, "assertSafeName should reject pipe characters");
  });

  it("rejects names with path traversal ../", () => {
    const origExit = process.exit;
    let exitCalled = false;
    process.exit = () => { exitCalled = true; throw new Error("process.exit"); };
    try { assertSafeName("../etc/passwd"); } catch {}
    process.exit = origExit;
    assert.ok(exitCalled, "assertSafeName should reject path traversal");
  });

  it("rejects empty string", () => {
    const origExit = process.exit;
    let exitCalled = false;
    process.exit = () => { exitCalled = true; throw new Error("process.exit"); };
    try { assertSafeName(""); } catch {}
    process.exit = origExit;
    assert.ok(exitCalled, "assertSafeName should reject empty string");
  });

  it("rejects names starting with a dash (flag injection)", () => {
    const origExit = process.exit;
    let exitCalled = false;
    process.exit = () => { exitCalled = true; throw new Error("process.exit"); };
    try { assertSafeName("-rf"); } catch {}
    process.exit = origExit;
    assert.ok(exitCalled, "assertSafeName should reject flag-like names");
  });

  it("rejects names with spaces", () => {
    const origExit = process.exit;
    let exitCalled = false;
    process.exit = () => { exitCalled = true; throw new Error("process.exit"); };
    try { assertSafeName("my sandbox"); } catch {}
    process.exit = origExit;
    assert.ok(exitCalled, "assertSafeName should reject names with spaces");
  });
});

// ── runCaptureArgv: no shell interpolation ────────────────────────

describe("runCaptureArgv", () => {
  it("exists and is a function", () => {
    assert.equal(typeof runCaptureArgv, "function");
  });

  it("captures stdout from a simple command", () => {
    const out = runCaptureArgv("echo", ["hello"]);
    assert.equal(out, "hello");
  });

  it("does NOT expand shell metacharacters (injection proof)", () => {
    // Core regression test for issue #325 / command injection.
    // OLD: run(`echo "${value}"`) with value="$(id)" would execute id.
    // NEW: runCaptureArgv never invokes bash, so $(id) is literal.
    const malicious = "$(id)";
    const out = runCaptureArgv("echo", [malicious]);
    assert.ok(out.includes("$(id)"), `Expected literal '$(id)' in output, got: "${out}"`);
    assert.ok(!out.includes("uid="),
      `runCaptureArgv must NOT expand subshell — command injection detected! Output: "${out}"`);
  });

  it("does NOT expand semicolons as command separators", () => {
    const malicious = "safe; echo INJECTED";
    const out = runCaptureArgv("echo", [malicious]);
    assert.ok(out.includes("safe; echo INJECTED"),
      "Semicolon must be treated as literal, not as command separator");
    assert.ok(!out.includes("\nINJECTED"),
      "runCaptureArgv must not split on semicolon");
  });

  it("does NOT expand backtick command substitution", () => {
    const malicious = "`echo PWNED`";
    const out = runCaptureArgv("echo", [malicious]);
    assert.ok(out.includes("`echo PWNED`"), "Backtick must be treated as literal in argv");
    assert.ok(!out.includes("\nPWNED"), "Backtick substitution must not execute");
  });

  it("returns empty string on failure when ignoreError: true", () => {
    const out = runCaptureArgv("false", [], { ignoreError: true });
    assert.equal(out, "");
  });

  it("throws on failure when ignoreError is not set", () => {
    assert.throws(() => { runCaptureArgv("false", []); });
  });
});

// ── runArgv: exists and basic sanity ─────────────────────────────

describe("runArgv", () => {
  it("exists and is a function", () => {
    assert.equal(typeof runArgv, "function");
  });

  it("runs a command without shell expansion", () => {
    const result = runArgv("echo", ["hello"], { stdio: ["ignore", "ignore", "ignore"] });
    assert.equal(result.status, 0);
  });
});

// ── opts.env: inherited environment is preserved ──────────────────

describe("runner opts.env does not drop inherited environment", () => {
  it("runCaptureArgv preserves PATH from process.env even when opts.env is passed", () => {
    // The bug: `{ ...process.env, ...opts.env, ...opts }` — when opts.env is set,
    // the `...opts` spread overwrites env with ONLY opts.env, dropping PATH/HOME.
    // The fix: extract env from opts before spreading.
    const result = runCaptureArgv("printenv", ["PATH"], {
      env: { CUSTOM_TEST_VAR: "sentinel" },
    });
    assert.ok(result.length > 0,
      "PATH must be preserved when opts.env is passed — got empty, PATH was dropped");
    assert.ok(result.includes("/"), `PATH should contain path separators, got: "${result}"`);
  });

  it("runCaptureArgv passes custom env vars alongside inherited env", () => {
    const result = runCaptureArgv("printenv", ["CUSTOM_TEST_VAR"], {
      env: { CUSTOM_TEST_VAR: "sentinel_value" },
    });
    assert.equal(result, "sentinel_value",
      "Custom env var must be available in child process");
  });
});
