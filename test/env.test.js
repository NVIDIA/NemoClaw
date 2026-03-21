// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { parseEnvFile, findGitRoot } = require("../bin/lib/env");

describe("parseEnvFile", () => {
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-env-test-"));
  });

  afterEach(() => {
    // Clean up any env vars we set during tests
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("NEMOCLAW_TEST_ENV_")) {
        delete process.env[key];
      }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("parses KEY=VALUE lines into process.env", () => {
    fs.writeFileSync(path.join(tmp, ".env"), "NEMOCLAW_TEST_ENV_A=hello\n");
    parseEnvFile(path.join(tmp, ".env"));
    assert.equal(process.env.NEMOCLAW_TEST_ENV_A, "hello");
  });

  it("strips surrounding double quotes", () => {
    fs.writeFileSync(path.join(tmp, ".env"), 'NEMOCLAW_TEST_ENV_B="quoted"\n');
    parseEnvFile(path.join(tmp, ".env"));
    assert.equal(process.env.NEMOCLAW_TEST_ENV_B, "quoted");
  });

  it("strips surrounding single quotes", () => {
    fs.writeFileSync(path.join(tmp, ".env"), "NEMOCLAW_TEST_ENV_C='single'\n");
    parseEnvFile(path.join(tmp, ".env"));
    assert.equal(process.env.NEMOCLAW_TEST_ENV_C, "single");
  });

  it("strips inline comments after unquoted values", () => {
    fs.writeFileSync(path.join(tmp, ".env"), "NEMOCLAW_TEST_ENV_D=val # comment\n");
    parseEnvFile(path.join(tmp, ".env"));
    assert.equal(process.env.NEMOCLAW_TEST_ENV_D, "val");
  });

  it("skips blank lines and comments", () => {
    fs.writeFileSync(
      path.join(tmp, ".env"),
      "# this is a comment\n\nNEMOCLAW_TEST_ENV_E=yes\n\n# another\n",
    );
    parseEnvFile(path.join(tmp, ".env"));
    assert.equal(process.env.NEMOCLAW_TEST_ENV_E, "yes");
  });

  it("skips lines without an equals sign", () => {
    fs.writeFileSync(path.join(tmp, ".env"), "no-equals-here\nNEMOCLAW_TEST_ENV_F=ok\n");
    parseEnvFile(path.join(tmp, ".env"));
    assert.equal(process.env.NEMOCLAW_TEST_ENV_F, "ok");
  });

  it("never overwrites existing env vars", () => {
    process.env.NEMOCLAW_TEST_ENV_G = "original";
    fs.writeFileSync(path.join(tmp, ".env"), "NEMOCLAW_TEST_ENV_G=overwritten\n");
    parseEnvFile(path.join(tmp, ".env"));
    assert.equal(process.env.NEMOCLAW_TEST_ENV_G, "original");
  });

  it("first file wins when loading multiple files", () => {
    fs.writeFileSync(path.join(tmp, "first"), "NEMOCLAW_TEST_ENV_H=first\n");
    fs.writeFileSync(path.join(tmp, "second"), "NEMOCLAW_TEST_ENV_H=second\n");
    parseEnvFile(path.join(tmp, "first"));
    parseEnvFile(path.join(tmp, "second"));
    assert.equal(process.env.NEMOCLAW_TEST_ENV_H, "first");
  });

  it("silently skips missing files", () => {
    assert.doesNotThrow(() => {
      parseEnvFile(path.join(tmp, "nonexistent"));
    });
  });

  it("handles empty values", () => {
    fs.writeFileSync(path.join(tmp, ".env"), "NEMOCLAW_TEST_ENV_I=\n");
    parseEnvFile(path.join(tmp, ".env"));
    assert.equal(process.env.NEMOCLAW_TEST_ENV_I, "");
  });
});

describe("findGitRoot", () => {
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gitroot-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("finds .git directory in current dir", () => {
    fs.mkdirSync(path.join(tmp, ".git"));
    assert.equal(findGitRoot(tmp), tmp);
  });

  it("walks up to find .git in parent", () => {
    fs.mkdirSync(path.join(tmp, ".git"));
    const nested = path.join(tmp, "a", "b", "c");
    fs.mkdirSync(nested, { recursive: true });
    assert.equal(findGitRoot(nested), tmp);
  });

  it("returns null when no .git found", () => {
    assert.equal(findGitRoot(tmp), null);
  });
});
