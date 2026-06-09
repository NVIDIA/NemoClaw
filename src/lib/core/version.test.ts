// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getVersion } from "../../../dist/lib/core/version";

const repoRoot = join(import.meta.dirname, "..", "..", "..");

function withoutGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_") && value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

function withEnv<T>(overrides: NodeJS.ProcessEnv, fn: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

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

  it("ignores inherited Git hook environment for explicit roots", () => {
    const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: withoutGitEnv(),
    }).trim();

    writeFileSync(join(testDir, ".version"), "2.3.4\n");
    try {
      const result = withEnv(
        {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "core.hooksPath",
          GIT_CONFIG_VALUE_0: "/tmp/hostile-hooks",
          GIT_DIR: gitDir,
          GIT_INDEX_FILE: join(testDir, "hostile-index"),
          GIT_WORK_TREE: repoRoot,
        },
        () => getVersion({ rootDir: testDir }),
      );
      expect(result).toBe("2.3.4");
    } finally {
      rmSync(join(testDir, ".version"));
    }
  });

  it("returns a string", () => {
    expect(typeof getVersion({ rootDir: testDir })).toBe("string");
  });
});
