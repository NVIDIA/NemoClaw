// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");

const {
  validateInstanceName,
  shellQuote,
  SSH_OPTS,
} = require("../bin/lib/deploy");

const { runCaptureArgv } = require("../bin/lib/runner");

describe("deploy helpers", () => {
  describe("validateInstanceName", () => {
    it("accepts valid names", () => {
      for (const name of ["my-box", "prod.server", "test_01", "a", "A1-b.c_d"]) {
        assert.doesNotThrow(() => validateInstanceName(name));
      }
    });

    it("rejects names starting with hyphen", () => {
      assert.throws(() => validateInstanceName("-bad"), /Invalid instance name/);
    });

    it("rejects shell injection", () => {
      assert.throws(() => validateInstanceName("foo;rm -rf /"), /Invalid instance name/);
    });

    it("rejects command substitution", () => {
      assert.throws(() => validateInstanceName("$(whoami)"), /Invalid instance name/);
    });

    it("rejects empty string", () => {
      assert.throws(() => validateInstanceName(""), /Invalid instance name/);
    });

    it("rejects names with spaces", () => {
      assert.throws(() => validateInstanceName("foo bar"), /Invalid instance name/);
    });

    it("rejects backtick command substitution", () => {
      assert.throws(() => validateInstanceName("`whoami`"), /Invalid instance name/);
    });

    it("rejects pipe", () => {
      assert.throws(() => validateInstanceName("foo|bar"), /Invalid instance name/);
    });

    it("rejects names starting with dot", () => {
      assert.throws(() => validateInstanceName(".hidden"), /Invalid instance name/);
    });
  });

  describe("shellQuote", () => {
    it("wraps in single quotes", () => {
      assert.equal(shellQuote("hello"), "'hello'");
    });

    it("escapes embedded single quotes", () => {
      assert.equal(shellQuote("it's"), "'it'\\''s'");
    });
  });

  describe("SSH_OPTS", () => {
    it("uses StrictHostKeyChecking=accept-new (TOFU)", () => {
      assert.ok(SSH_OPTS.includes("StrictHostKeyChecking=accept-new"));
    });

    it("does not contain StrictHostKeyChecking=no", () => {
      assert.ok(!SSH_OPTS.some((o) => o.includes("StrictHostKeyChecking=no")));
    });
  });

  // ── Injection PoC ──────────────────────────────────────────────
  // Prove that argv arrays (spawnSync without shell) treat shell
  // metacharacters as literal text. These are the 5 injection methods
  // that bash -c would execute but argv arrays do not.

  describe("argv injection proof-of-concept", () => {
    it("$() subshell is literal, not expanded", () => {
      const r = spawnSync("echo", ["$(echo PWNED)"], { encoding: "utf-8", stdio: "pipe" });
      assert.ok(r.stdout.includes("$(echo PWNED)"), "subshell must be literal");
      assert.ok(!r.stdout.includes("PWNED\n"), "subshell must not expand");
    });

    it("backtick substitution is literal, not executed", () => {
      const r = spawnSync("echo", ["`echo HACKED`"], { encoding: "utf-8", stdio: "pipe" });
      assert.ok(r.stdout.includes("`echo HACKED`"), "backtick must be literal");
    });

    it("semicolon chaining is literal, not split", () => {
      const r = spawnSync("echo", ["hello; echo INJECTED"], { encoding: "utf-8", stdio: "pipe" });
      assert.ok(r.stdout.includes("hello; echo INJECTED"), "semicolon must be literal");
    });

    it("pipe is literal, not interpreted", () => {
      const r = spawnSync("echo", ["data | cat /etc/passwd"], { encoding: "utf-8", stdio: "pipe" });
      assert.ok(r.stdout.includes("data | cat /etc/passwd"), "pipe must be literal");
    });

    it("&& chaining is literal, not executed", () => {
      const r = spawnSync("echo", ["ok && echo PWNED"], { encoding: "utf-8", stdio: "pipe" });
      assert.ok(r.stdout.includes("ok && echo PWNED"), "&& must be literal");
    });
  });

  describe("runCaptureArgv", () => {
    it("captures stdout without shell interpretation", () => {
      const out = runCaptureArgv("echo", ["hello", "world"]);
      assert.equal(out, "hello world");
    });

    it("returns empty string on failure with ignoreError", () => {
      const out = runCaptureArgv("false", [], { ignoreError: true });
      assert.equal(out, "");
    });

    it("passes $() literally through argv", () => {
      const out = runCaptureArgv("echo", ["$(whoami)"]);
      assert.equal(out, "$(whoami)");
    });
  });
});
