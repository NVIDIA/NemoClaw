// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getVersion } from "../../dist/lib/version";

describe("lib/version", () => {
  let testDir: string;

  beforeAll(() => {
    testDir = mkdtempSync(join(tmpdir(), "version-test-"));
    writeFileSync(join(testDir, "package.json"), JSON.stringify({ version: "1.2.3" }));
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("falls back to package.json version when no git and no .version", () => {
    expect(getVersion({ rootDir: testDir })).toBe("1.2.3");
  });

  it("prefers .version file over package.json", () => {
    writeFileSync(join(testDir, ".version"), "0.5.0-rc1\n");
    const result = getVersion({ rootDir: testDir });
    expect(result).toBe("0.5.0-rc1");
    rmSync(join(testDir, ".version"));
  });

  it("regression #1239: returns .version even when package.json is stale", () => {
    // npm-published tarballs ship with a stale package.json version (0.1.0)
    // and a .version file stamped from the git tag at publish time. The
    // installed CLI must report the .version contents, not the package.json
    // semver. See issue #1239.
    writeFileSync(join(testDir, "package.json"), JSON.stringify({ version: "0.1.0" }));
    writeFileSync(join(testDir, ".version"), "0.0.2");
    expect(getVersion({ rootDir: testDir })).toBe("0.0.2");
    rmSync(join(testDir, ".version"));
    writeFileSync(join(testDir, "package.json"), JSON.stringify({ version: "1.2.3" }));
  });

  it("returns a string", () => {
    expect(typeof getVersion({ rootDir: testDir })).toBe("string");
  });
});
