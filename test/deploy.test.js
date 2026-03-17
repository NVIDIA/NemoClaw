// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  validateInstanceName,
  buildSshCommand,
  buildRsyncCommand,
  shellQuote,
} = require("../bin/lib/deploy");

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

  describe("buildSshCommand", () => {
    it("uses StrictHostKeyChecking=accept-new", () => {
      const cmd = buildSshCommand("myhost", "ls");
      assert.ok(cmd.includes("StrictHostKeyChecking=accept-new"));
      assert.ok(!cmd.includes("StrictHostKeyChecking=no"));
    });

    it("quotes host and remote command", () => {
      const cmd = buildSshCommand("myhost", "echo hello");
      assert.ok(cmd.includes("'myhost'"));
      assert.ok(cmd.includes("'echo hello'"));
    });

    it("works without remote command", () => {
      const cmd = buildSshCommand("myhost");
      assert.ok(cmd.includes("'myhost'"));
      assert.ok(cmd.startsWith("ssh "));
    });
  });

  describe("buildRsyncCommand", () => {
    it("quotes source paths and destination", () => {
      const cmd = buildRsyncCommand(["/tmp/a", "/tmp/b"], "host", "/dest/");
      assert.ok(cmd.includes("'/tmp/a'"));
      assert.ok(cmd.includes("'/tmp/b'"));
      assert.ok(cmd.includes("'host:/dest/'"));
    });

    it("uses accept-new in ssh option", () => {
      const cmd = buildRsyncCommand(["/tmp/a"], "host", "/dest/");
      assert.ok(cmd.includes("accept-new"));
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
});
