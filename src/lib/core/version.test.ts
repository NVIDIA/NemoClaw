// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  getBuildIdentity,
  getVersion,
  resolveSourceBuildIdentity,
  validateBuildIdentity,
} from "./version";

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

  afterEach(() => {
    rmSync(join(testDir, ".version"), { force: true });
    rmSync(join(testDir, ".source-revision"), { force: true });
    rmSync(join(testDir, "dist"), { recursive: true, force: true });
    writeFileSync(join(testDir, "package.json"), JSON.stringify({ version: "1.2.3" }));
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

  it("returns .version even when package.json is stale (#1239)", () => {
    // npm-published tarballs ship with a stale package.json version (0.1.0)
    // and a .version file stamped from the git tag at publish time. The
    // installed CLI must report the .version contents, not the package.json
    // semver. See issue #1239.
    writeFileSync(join(testDir, "package.json"), JSON.stringify({ version: "0.1.0" }));
    writeFileSync(join(testDir, ".version"), "0.0.2");
    expect(getVersion({ rootDir: testDir })).toBe("0.0.2");
  });

  it("resolves one stamped version and source revision without Git metadata (#7777)", () => {
    const sourceRevision = `8bfff4526${"a".repeat(31)}`;
    writeFileSync(join(testDir, ".version"), "0.0.96-35-g8bfff4526");
    writeFileSync(join(testDir, ".source-revision"), sourceRevision);

    expect(getBuildIdentity({ rootDir: testDir })).toEqual({
      nemoclawVersion: "0.0.96-35-g8bfff4526",
      sourceRevision,
    });
  });

  it("rejects a stamped version without an immutable source revision (#7777)", () => {
    writeFileSync(join(testDir, ".version"), "0.0.96-35-g8bfff4526");

    expect(() => getBuildIdentity({ rootDir: testDir })).toThrow(
      "Could not resolve the immutable NemoClaw source revision.",
    );
  });

  it("uses the compiled identity as the public version source (#7777)", () => {
    const identity = {
      nemoclawVersion: "0.0.96-35-g8bfff4526",
      sourceRevision: `8bfff4526${"a".repeat(31)}`,
    };
    mkdirSync(join(testDir, "dist"));
    writeFileSync(join(testDir, "dist", "build-identity.json"), JSON.stringify(identity));

    expect(getVersion({ rootDir: testDir })).toBe(identity.nemoclawVersion);
    expect(getBuildIdentity({ rootDir: testDir })).toEqual(identity);
  });

  it("preserves an exact compiled identity when rebuilding the same source revision", () => {
    const identity = {
      nemoclawVersion: "0.0.113-195-ga52f16721",
      sourceRevision: `a52f16721${"5".repeat(31)}`,
    };
    mkdirSync(join(testDir, "dist"));
    writeFileSync(join(testDir, "dist", "build-identity.json"), JSON.stringify(identity));
    writeFileSync(join(testDir, ".source-revision"), identity.sourceRevision);

    expect(resolveSourceBuildIdentity({ rootDir: testDir })).toEqual(identity);
  });

  it("rejects a described version whose revision does not match (#7777)", () => {
    expect(() =>
      validateBuildIdentity({
        nemoclawVersion: "0.0.96-35-g8bfff4526",
        sourceRevision: "9".repeat(40),
      }),
    ).toThrow("NemoClaw build identity version and source revision do not match.");
  });

  it.each([
    `nvapi-${"a".repeat(24)}`,
    "[REDACTED]",
    "1.2",
  ])("rejects the invalid public version %s (#7777)", (nemoclawVersion) => {
    expect(() =>
      validateBuildIdentity({
        nemoclawVersion,
        sourceRevision: "9".repeat(40),
      }),
    ).toThrow("NemoClaw build identity has an invalid version.");
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
      rmSync(join(testDir, ".version"), { force: true });
    }
  });

  it("returns a string", () => {
    expect(typeof getVersion({ rootDir: testDir })).toBe("string");
  });
});
