// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const childProcess = require("node:child_process");
const { spawnSync } = childProcess;

const runnerPath = path.join(__dirname, "..", "bin", "lib", "runner");

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

  describe("shellQuote", () => {
    it("wraps in single quotes", () => {
      const { shellQuote } = require(runnerPath);
      assert.equal(shellQuote("hello"), "'hello'");
    });

    it("escapes embedded single quotes", () => {
      const { shellQuote } = require(runnerPath);
      assert.equal(shellQuote("it's"), "'it'\\''s'");
    });

    it("neutralizes shell metacharacters", () => {
      const { shellQuote } = require(runnerPath);
      const dangerous = "test; rm -rf /";
      const quoted = shellQuote(dangerous);
      assert.equal(quoted, "'test; rm -rf /'");
      // Verify it's actually safe by running through bash
      const result = spawnSync("bash", ["-c", `echo ${quoted}`], { encoding: "utf-8" });
      assert.equal(result.stdout.trim(), dangerous);
    });

    it("handles backticks and dollar signs", () => {
      const { shellQuote } = require(runnerPath);
      const payload = "test`whoami`$HOME";
      const quoted = shellQuote(payload);
      const result = spawnSync("bash", ["-c", `echo ${quoted}`], { encoding: "utf-8" });
      assert.equal(result.stdout.trim(), payload);
    });
  });

  describe("validateName", () => {
    it("accepts valid RFC 1123 names", () => {
      const { validateName } = require(runnerPath);
      assert.equal(validateName("my-sandbox"), "my-sandbox");
      assert.equal(validateName("test123"), "test123");
      assert.equal(validateName("a"), "a");
    });

    it("rejects names with shell metacharacters", () => {
      const { validateName } = require(runnerPath);
      assert.throws(() => validateName("test; whoami"), /Invalid/);
      assert.throws(() => validateName("test`id`"), /Invalid/);
      assert.throws(() => validateName("test$(cat /etc/passwd)"), /Invalid/);
      assert.throws(() => validateName("../etc/passwd"), /Invalid/);
    });

    it("rejects empty and overlength names", () => {
      const { validateName } = require(runnerPath);
      assert.throws(() => validateName(""), /required/);
      assert.throws(() => validateName(null), /required/);
      assert.throws(() => validateName("a".repeat(64)), /too long/);
    });

    it("rejects uppercase and special characters", () => {
      const { validateName } = require(runnerPath);
      assert.throws(() => validateName("MyBox"), /Invalid/);
      assert.throws(() => validateName("my_box"), /Invalid/);
      assert.throws(() => validateName("-leading"), /Invalid/);
      assert.throws(() => validateName("trailing-"), /Invalid/);
    });
  });
});
