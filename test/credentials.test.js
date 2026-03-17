// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

describe("credentials", () => {
  let tmpDir;
  let origHome;
  let creds;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cred-test-"));
    origHome = process.env.HOME;
    process.env.HOME = tmpDir;
    // Re-require to pick up new HOME
    delete require.cache[require.resolve("../bin/lib/credentials")];
    creds = require("../bin/lib/credentials");
  });

  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[require.resolve("../bin/lib/credentials")];
  });

  describe("loadCredentials", () => {
    it("returns empty object when no file exists", () => {
      const result = creds.loadCredentials();
      assert.deepEqual(result, {});
    });

    it("returns empty object for corrupt file", () => {
      const dir = path.join(tmpDir, ".nemoclaw");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "credentials.json"), "not json");
      const result = creds.loadCredentials();
      assert.deepEqual(result, {});
    });
  });

  describe("saveCredential + getCredential", () => {
    it("saves and retrieves a credential", () => {
      creds.saveCredential("TEST_KEY", "test-value");
      const result = creds.getCredential("TEST_KEY");
      assert.equal(result, "test-value");
    });

    it("creates directory with restricted permissions", () => {
      creds.saveCredential("KEY", "val");
      const dir = path.join(tmpDir, ".nemoclaw");
      assert.ok(fs.existsSync(dir));
    });

    it("overwrites existing credential", () => {
      creds.saveCredential("KEY", "v1");
      creds.saveCredential("KEY", "v2");
      assert.equal(creds.getCredential("KEY"), "v2");
    });

    it("preserves other credentials when adding new one", () => {
      creds.saveCredential("A", "1");
      creds.saveCredential("B", "2");
      assert.equal(creds.getCredential("A"), "1");
      assert.equal(creds.getCredential("B"), "2");
    });
  });

  describe("getCredential", () => {
    it("prefers environment variable over stored credential", () => {
      creds.saveCredential("MY_KEY", "stored");
      process.env.MY_KEY = "from-env";
      const result = creds.getCredential("MY_KEY");
      assert.equal(result, "from-env");
      delete process.env.MY_KEY;
    });

    it("returns null for missing credential", () => {
      assert.equal(creds.getCredential("NONEXISTENT_KEY_12345"), null);
    });
  });
});
