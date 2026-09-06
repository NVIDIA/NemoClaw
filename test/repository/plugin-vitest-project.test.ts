// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const rootRequire = createRequire(path.join(repositoryRoot, "package.json"));
const rootTypeScript = rootRequire.resolve("typescript/bin/tsc");

type PackageLock = {
  packages?: Record<string, { version?: string }>;
};

function readPackageLock(relativePath: string): PackageLock {
  return JSON.parse(readFileSync(path.join(repositoryRoot, relativePath), "utf8")) as PackageLock;
}

function lockedVersion(lock: PackageLock, dependency: string): string | undefined {
  return lock.packages?.[`node_modules/${dependency}`]?.version;
}

function requiredLockedVersion(version: string | undefined, dependency: string): string {
  expect(version, `${dependency} lockfile version`).toBeTypeOf("string");
  expect(version, `${dependency} lockfile version`).not.toBe("");
  return version as string;
}

function listedTypeScriptFiles(configPath: string): string[] {
  return execFileSync(
    process.execPath,
    [rootTypeScript, "--noEmit", "-p", configPath, "--listFilesOnly"],
    { cwd: repositoryRoot, encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .map((file) => path.normalize(file));
}

describe("plugin Vitest project contract", () => {
  // source-shape-contract: compatibility -- Root-driven plugin test tooling requires lockstep versions without installing plugin development dependencies
  it.each(["typescript", "vite", "vitest"] as const)(
    "keeps standalone plugin %s locked to the root test toolchain",
    (dependency) => {
      const rootLock = readPackageLock("package-lock.json");
      const pluginLock = readPackageLock("nemoclaw/package-lock.json");

      expect(
        requiredLockedVersion(lockedVersion(pluginLock, dependency), `plugin ${dependency}`),
      ).toBe(requiredLockedVersion(lockedVersion(rootLock, dependency), `root ${dependency}`));
    },
  );

  it("typechecks plugin production and test sources without emitting tests", () => {
    const productionFiles = listedTypeScriptFiles("nemoclaw/tsconfig.json");
    const testFiles = listedTypeScriptFiles("nemoclaw/tsconfig.test.json");

    expect(productionFiles.some((file) => file.endsWith(".test.ts"))).toBe(false);
    expect(testFiles).toContain(path.join(repositoryRoot, "nemoclaw", "src", "register.test.ts"));
    expect(testFiles).toContain(path.join(repositoryRoot, "nemoclaw", "vitest.config.ts"));
    expect(testFiles).toContain(path.join(repositoryRoot, "nemoclaw", "vitest.project.ts"));
  });
});
