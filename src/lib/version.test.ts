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

  it("returns a string", () => {
    expect(typeof getVersion({ rootDir: testDir })).toBe("string");
  });
});
